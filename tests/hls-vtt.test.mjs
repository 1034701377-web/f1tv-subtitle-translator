import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHlsVodPlaylist, parseHlsLivePlaylist, parseWebVtt } from '../src/hls-vtt.js';

const BASE = 'https://captions.example.invalid/subtitles/en/index.m3u8?token=example';
const playlist = (body, extra = '') => `#EXTM3U\n#EXT-X-VERSION:4\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:1\n${extra}${body}\n#EXT-X-ENDLIST\n`;
const vtt = (body, mapping = 'X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:0') =>
  `WEBVTT\t#Elemental MediaPackage\n${mapping}\n\n${body}\n`;
const actualCue = '42\n00:04:08.198 --> 00:04:10.118\nCar 16 is 2.5 seconds ahead.';

test('parses the observed 1596-segment VOD shape without applying program-date offsets', () => {
  const body = Array.from({ length: 1596 }, (_, index) =>
    `#EXTINF:5.760,\nsegment-${index + 1}.vtt`).join('\n');
  const result = parseHlsVodPlaylist(playlist(body, '#EXT-X-PROGRAM-DATE-TIME:2026-09-27T12:00:00Z\n'), BASE);
  assert.equal(result.segments.length, 1596);
  assert.ok(Math.abs(result.duration - 9192.96) < 1e-7);
  assert.deepEqual(result.segments[0], {
    url: 'https://captions.example.invalid/subtitles/en/segment-1.vtt',
    start: 0, end: 5.76, sequence: 1,
  });
  assert.equal(result.segments.at(-1).sequence, 1596);
  assert.equal(result.segments.at(-1).end, result.duration);
});

test('resolves relative, root-relative and absolute HTTP(S) segment URLs', () => {
  const result = parseHlsVodPlaylist(playlist('#EXTINF:1,\n../a.vtt\n#EXTINF:2.5,\n/b.vtt?x=1\n#EXTINF:3,\nhttp://other.example.invalid/c.vtt'), BASE);
  assert.deepEqual(result.segments.map(({ url, start, end }) => ({ url, start, end })), [
    { url: 'https://captions.example.invalid/subtitles/a.vtt', start: 0, end: 1 },
    { url: 'https://captions.example.invalid/b.vtt?x=1', start: 1, end: 3.5 },
    { url: 'http://other.example.invalid/c.vtt', start: 3.5, end: 6.5 },
  ]);
});

test('ENDLIST identifies a complete VOD when optional PLAYLIST-TYPE is absent', () => {
  const source = '\uFEFF#EXTM3U\r\n#EXTINF:1,\r\na.vtt\r\n#EXT-X-ENDLIST\r\n';
  assert.equal(parseHlsVodPlaylist(source, BASE).segments[0].sequence, 0);
});

test('rejects live and EVENT playlists, including VOD tags without ENDLIST', () => {
  const source = playlist('#EXTINF:5.760,\na.vtt');
  assert.throws(() => parseHlsVodPlaylist(source.replace('#EXT-X-ENDLIST', ''), BASE), /ENDLIST/);
  assert.throws(() => parseHlsVodPlaylist(source.replace('TYPE:VOD', 'TYPE:EVENT'), BASE), /VOD/);
});

test('rejects discontinuities, master playlists, encryption and other unsupported addressing', () => {
  for (const tag of [
    '#EXT-X-DISCONTINUITY', '#EXT-X-DISCONTINUITY-SEQUENCE:0',
    '#EXT-X-STREAM-INF:BANDWIDTH=2000', '#EXT-X-MEDIA:TYPE=SUBTITLES',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"', '#EXT-X-MAP:URI="init.mp4"',
    '#EXT-X-BYTERANGE:10@0', '#EXT-X-GAP', '#EXT-X-PART:DURATION=1,URI="a.vtt"',
  ]) {
    assert.throws(() => parseHlsVodPlaylist(playlist(`#EXTINF:1,\na.vtt`, `${tag}\n`), BASE), /Unsupported HLS tag/);
  }
});

test('rejects invalid durations, missing URIs, empty playlists and unsafe sequence numbers', () => {
  for (const duration of ['0', '-1', 'NaN', 'Infinity', '1e309', '1.2.3']) {
    assert.throws(() => parseHlsVodPlaylist(playlist(`#EXTINF:${duration},\na.vtt`), BASE), /duration/);
  }
  assert.throws(() => parseHlsVodPlaylist(playlist('#EXTINF:1,'), BASE), /URI missing/);
  assert.throws(() => parseHlsVodPlaylist(playlist('a.vtt'), BASE), /EXTINF/);
  assert.throws(() => parseHlsVodPlaylist(playlist(''), BASE), /no segments/);
  assert.throws(() => parseHlsVodPlaylist(playlist('#EXTINF:1,\na.vtt').replace('SEQUENCE:1', 'SEQUENCE:9007199254740992'), BASE), /sequence/);
});

test('requires HTTP(S) URLs without embedded credentials', () => {
  for (const url of ['file:///tmp/a.vtt', 'data:text/vtt,hello', 'javascript:alert(1)', 'https://user:pass@example.invalid/a.vtt']) {
    assert.throws(() => parseHlsVodPlaylist(playlist(`#EXTINF:1,\n${url}`), BASE), /HTTP\(S\)/);
  }
  assert.throws(() => parseHlsVodPlaylist(playlist('#EXTINF:1,\na.vtt'), 'file:///tmp/index.m3u8'), /HTTP\(S\)/);
});

const livePlaylist = (body, { sequence = 310910314, date = '2026-10-01T08:30:02.880Z', type = 'EVENT', extra = '' } = {}) =>
  `#EXTM3U\n#EXT-X-VERSION:6\n${type ? `#EXT-X-PLAYLIST-TYPE:${type}\n` : ''}#EXT-X-TARGETDURATION:12\n#EXT-X-MEDIA-SEQUENCE:${sequence}\n#EXT-X-DISCONTINUITY-SEQUENCE:0\n#EXT-X-INDEPENDENT-SEGMENTS\n${date ? `#EXT-X-PROGRAM-DATE-TIME:${date}\n` : ''}${extra}${body}\n`;
const liveSegments = count => Array.from({ length: count }, (_, index) => `#EXTINF:5.760,\nsegment-${index}.vtt`).join('\n');
const liveStart = Date.parse('2026-10-01T08:30:02.880Z') / 1000;

test('EVENT growth preserves absolute segment times and existing sequence identities', () => {
  const first = parseHlsLivePlaylist(livePlaylist(liveSegments(115)), BASE);
  const grown = parseHlsLivePlaylist(livePlaylist(liveSegments(123)), BASE);
  assert.equal(first.ended, false);
  assert.equal(first.targetDuration, 12);
  assert.equal(first.discontinuitySequence, 0);
  assert.equal(first.duration, 115 * 5.76);
  assert.equal(grown.segments.length, 123);
  assert.deepEqual(grown.segments.slice(0, 115), first.segments);
  assert.deepEqual(first.segments[0], {
    url: 'https://captions.example.invalid/subtitles/en/segment-0.vtt',
    start: liveStart, end: liveStart + 5.76, sequence: 310910314,
  });
  assert.equal(grown.segments.at(-1).end, Date.parse('2026-10-01T08:41:51.360Z') / 1000);
});

test('untyped rolling playlists use their own sequence and PDT instead of restarting time at zero', () => {
  const first = parseHlsLivePlaylist(livePlaylist(liveSegments(3), { type: '' }), BASE);
  const rolled = parseHlsLivePlaylist(livePlaylist('#EXTINF:5.760,\nsegment-1.vtt\n#EXTINF:5.760,\nsegment-2.vtt', {
    type: '', sequence: 310910315, date: '2026-10-01T08:30:08.640Z',
  }), BASE);
  assert.deepEqual(rolled.segments, first.segments.slice(1));
});

test('a later PDT anchor maps preceding segments and accepts continuous repeated anchors', () => {
  const result = parseHlsLivePlaylist(livePlaylist(
    '#EXTINF:5.760,\na.vtt\n#EXT-X-PROGRAM-DATE-TIME:2026-10-01T08:30:08.640Z\n#EXTINF:5.760,\nb.vtt\n#EXT-X-PROGRAM-DATE-TIME:2026-10-01T08:30:14.400Z\n#EXTINF:5.760,\nc.vtt\n#EXT-X-ENDLIST',
    { date: null },
  ).replace('DISCONTINUITY-SEQUENCE:0', 'DISCONTINUITY-SEQUENCE:4'), BASE);
  assert.equal(result.segments[0].start, liveStart);
  assert.equal(result.segments[2].start, liveStart + 11.52);
  assert.equal(result.ended, true);
  assert.equal(result.discontinuitySequence, 4);
});

test('live playlists require a finite PDT anchor and reject conflicting clock evidence', () => {
  assert.throws(() => parseHlsLivePlaylist(livePlaylist(liveSegments(1), { date: null }), BASE), /anchor/);
  for (const date of ['invalid', 'Infinity']) {
    assert.throws(() => parseHlsLivePlaylist(livePlaylist(liveSegments(1), { date }), BASE), /program date time/);
  }
  assert.throws(() => parseHlsLivePlaylist(livePlaylist(
    '#EXTINF:5.760,\na.vtt\n#EXT-X-PROGRAM-DATE-TIME:2026-10-01T08:30:08.641Z\n#EXTINF:5.760,\nb.vtt',
  ), BASE), /Discontinuous/);
  for (const tag of ['#EXT-X-DISCONTINUITY', '#EXT-X-KEY:METHOD=NONE', '#EXT-X-GAP', '#EXT-X-MAP:URI="init.mp4"']) {
    assert.throws(() => parseHlsLivePlaylist(livePlaylist(liveSegments(1), { extra: `${tag}\n` }), BASE), /Unsupported HLS tag/);
  }
  assert.throws(() => parseHlsLivePlaylist(livePlaylist(liveSegments(1), { type: 'VOD' }), BASE), /live or EVENT/);
});

test('live playlists reject invalid durations, unsafe sequences, incomplete segments and unsafe URLs', () => {
  for (const duration of ['0', 'NaN', 'Infinity', '9'.repeat(310)]) {
    assert.throws(() => parseHlsLivePlaylist(livePlaylist(`#EXTINF:${duration},\na.vtt`), BASE), /duration/);
  }
  assert.throws(() => parseHlsLivePlaylist(livePlaylist('#EXTINF:5.760,'), BASE), /URI missing/);
  assert.throws(() => parseHlsLivePlaylist(livePlaylist(liveSegments(1), { sequence: '9007199254740992' }), BASE), /sequence/);
  assert.throws(() => parseHlsLivePlaylist(livePlaylist('#EXTINF:5.760,\nfile:///a.vtt'), BASE), /HTTP\(S\)/);
  assert.throws(() => parseHlsLivePlaylist(livePlaylist(liveSegments(1)).replace('#EXT-X-TARGETDURATION:12\n', ''), BASE), /target duration/);
});

test('existing VTT parser accepts empty live segments and observed Unix-epoch cue hours', () => {
  assert.deepEqual(parseWebVtt(vtt(''), { epoch: 'live' }), []);
  const [cue] = parseWebVtt(vtt('497456:41:25.093 --> 497456:41:27.693\nOutside sources seem to be'), { epoch: 'live' });
  assert.equal(cue.start, Date.parse('2026-10-01T08:41:25.093Z') / 1000);
  assert.equal(cue.end, Date.parse('2026-10-01T08:41:27.693Z') / 1000);
  assert.equal(cue.text, 'Outside sources seem to be');
});

test('parses real-shaped Elemental headers, numeric identifiers and absolute cue times', () => {
  const [cue] = parseWebVtt(vtt(actualCue));
  assert.equal(cue.start, 248.198);
  assert.equal(cue.end, 250.118);
  assert.equal(cue.text, 'Car 16 is 2.5 seconds ahead.');
  assert.match(cue.id, /^vod:248198:250118:[a-f0-9]{16}$/);
});

test('cue IDs remain stable across segment and numeric ID changes, with duplicate cues removed', () => {
  const first = parseWebVtt(vtt(`${actualCue}\n\n${actualCue.replace(/^42/, '43')}`));
  const nextSegment = parseWebVtt(vtt(actualCue.replace(/^42/, '99')));
  assert.equal(first.length, 1);
  assert.equal(first[0].id, nextSegment[0].id);
  assert.notEqual(first[0].id, parseWebVtt(vtt(actualCue), { epoch: 'another-session' })[0].id);
  assert.notEqual(first[0].id, parseWebVtt(vtt(actualCue.replace('Car 16', 'Car 55')))[0].id);
});

test('strips VTT tags and decodes entities while preserving numbers and line breaks', () => {
  const [cue] = parseWebVtt(vtt('00:01.000 --> 00:02.500 align:start position:10%\n<v Commentator><c.red>16 &amp; 55</c></v>\n<b>Lap&nbsp;42</b> &#x31;&#48; &lt; 11 &quot;yes&quot; <00:01.500>'));
  assert.equal(cue.text, '16 & 55\nLap 42 10 < 11 "yes"');
  assert.equal(cue.start, 1);
  assert.equal(cue.end, 2.5);
});

test('accepts default zero mapping, reversed zero map fields, BOM and CRLF', () => {
  assert.equal(parseWebVtt(vtt(actualCue, ''))[0].start, 248.198);
  const source = `\uFEFF${vtt(actualCue, 'X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000')}`.replace(/\n/g, '\r\n');
  assert.equal(parseWebVtt(source)[0].end, 250.118);
});

test('refuses nonzero or malformed mappings instead of guessing an offset', () => {
  for (const mapping of [
    'LOCAL:00:00:00.000,MPEGTS:900000', 'LOCAL:00:01:00.000,MPEGTS:0',
    'LOCAL:00:00:00.000,MPEGTS:-1', 'LOCAL:00:00:00.000',
    'LOCAL:00:00:00.000,MPEGTS:0,MPEGTS:0', 'LOCAL:invalid,MPEGTS:0',
  ]) {
    assert.throws(() => parseWebVtt(vtt(actualCue, `X-TIMESTAMP-MAP=${mapping}`)), /Unverified timestamp mapping/);
  }
});

test('rejects invalid timestamps and reversed or zero-length cue ranges', () => {
  for (const times of [
    '00:02.000 --> 00:01.000', '00:02.000 --> 00:02.000',
    '00:61.000 --> 01:02.000', '-00:01.000 --> 00:02.000',
    '00:00:01.12 --> 00:00:02.000', '00:99:01.000 --> 01:00:02.000',
  ]) assert.throws(() => parseWebVtt(vtt(`${times}\ntext`)), /Invalid WebVTT/);
});

test('skips NOTE, STYLE and REGION blocks and rejects malformed cue blocks', () => {
  const source = vtt(`NOTE a comment\nignored\n\nSTYLE\n::cue { color: white; }\n\nREGION\nid:caption\n\n${actualCue}`);
  assert.equal(parseWebVtt(source).length, 1);
  assert.throws(() => parseWebVtt('not a vtt'), /header/);
  assert.throws(() => parseWebVtt('WEBVTT\n00:01.000 --> 00:02.000\ntext'), /blank line/);
  assert.throws(() => parseWebVtt(vtt('42\nmissing timing\ntext')), /timing/);
});

test('bounds input size, cue text and segment count', () => {
  assert.throws(() => parseWebVtt('x'.repeat(2_000_001)), /within/);
  assert.throws(() => parseHlsVodPlaylist('x'.repeat(8_000_001), BASE), /within/);
  assert.throws(() => parseWebVtt(vtt(`00:01.000 --> 00:02.000\n${'x'.repeat(20_001)}`)), /text limit/);
  assert.throws(() => parseHlsVodPlaylist(playlist('#EXTINF:1,\na.vtt\n'.repeat(20_001)), BASE), /segment limit/);
});
