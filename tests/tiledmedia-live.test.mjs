import test from 'node:test';
import assert from 'node:assert/strict';
import { TiledMediaLiveSource, tiledLiveOriginSeconds } from '../src/tiledmedia-live-source.js';

const origin = Date.parse('2026-10-01T08:30:02.880Z') / 1000;
const liveTimestamp = value => {
  const ms = Math.round(value * 1000);
  return `${Math.floor(ms / 3600000)}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
};
const vttCue = (start, end, text) => `${liveTimestamp(origin + start)} --> ${liveTimestamp(origin + end)}\n${text}\n\n`;
function setup(options = {}) {
  let segmentCount = 2;
  const content = { eventType: 'live', isWallclockTimeSourceBased: true, currentPosition: 2500,
    seekLowerBound: 0, seekUpperBound: 60000, bufferLowerBound: 0, bufferUpperBound: 60000 };
  const wall = { ...content, currentPosition: origin * 1000 + 6900 };
  for (const key of ['seekLowerBound', 'seekUpperBound', 'bufferLowerBound', 'bufferUpperBound']) wall[key] += origin * 1000;
  const view = { currentContentTime: content, currentWallclockTime: wall,
    associatedPlayer: { currentSubtitleTrack: { parentSubtitleTrack: Promise.resolve({ language: 'eng' }), url: Promise.resolve('https://subtitles.formula1.com/live.m3u8') } } };
  const received = [], status = [];
  const source = new TiledMediaLiveSource(view, {
    fetchText: async url => url.endsWith('.m3u8')
      ? `#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:100\n#EXT-X-PROGRAM-DATE-TIME:2026-10-01T08:30:02.880Z\n${Array.from({ length: segmentCount }, (_, i) => `#EXTINF:6.000,\n${i}.vtt\n`).join('')}`
      : 'WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:0\n\n' +
        vttCue(1, 4, 'First sentence') + vttCue(8, 10, 'Second sentence') + (segmentCount > 2 ? vttCue(14, 16, 'New head sentence') : ''),
    getOfficialText: () => content.currentPosition < 4000 ? 'First sentence' : 'Second sentence',
    onStatus: value => status.push(value),
    ...options
  });
  source.stopped = false; source.onCues = cues => received.push(...cues);
  return { source, view, content, wall, received, status, advanceHead: () => { segmentCount = 3; source.manifestAt = 0; } };
}

test('live origin uses matching SDK bounds, never its misleading wallclock currentPosition', () => {
  const s = setup();
  assert.equal(tiledLiveOriginSeconds(s.view), origin);
  s.wall.seekUpperBound += 1000;
  assert.ok(Number.isNaN(tiledLiveOriginSeconds(s.view)));
  s.source.stop();
});

test('official Akamai live subtitle CDN is accepted, unrelated and lookalike hosts remain blocked', async () => {
  for (const [url, allowed] of [
    ['https://f1prodlive.akamaized.net/live.m3u8', true],
    ['https://unrelated.akamaized.net/live.m3u8', false],
    ['https://f1prodlive.akamaized.net.example.com/live.m3u8', false],
    ['http://f1prodlive.akamaized.net/live.m3u8', false],
  ]) {
    const s = setup();
    s.view.associatedPlayer.currentSubtitleTrack.url = Promise.resolve(url);
    await s.source.poll(); s.content.currentPosition = 9000; await s.source.poll();
    assert.equal(s.source.validated, allowed, url);
    if (!allowed) assert.match(s.status.at(-1).message, /官方域名/);
    s.source.stop();
  }
});

test('two real cue matches gate translation; live acquisition advances while picture is paused', async () => {
  const s = setup();
  await s.source.poll();
  assert.equal(s.received.length, 0); assert.equal(s.source.validated, false);
  s.content.currentPosition = 9000;
  await s.source.poll();
  assert.equal(s.source.validated, true); assert.equal(s.received.length, 2);
  assert.equal(s.received[1].start, 8); assert.equal(s.received[1].end, 10);
  assert.equal(s.source.coversTime(5), true); // Known silent interval.
  const previousAhead = s.status.at(-1).ahead;
  s.advanceHead(); await s.source.poll();
  assert.equal(s.content.currentPosition, 9000);
  assert.equal(s.received.length, 3); assert.equal(s.received[2].text, 'New head sentence');
  assert.ok(s.status.at(-1).ahead > previousAhead);
  assert.equal(s.source.coversTime(19), false);
  s.wall.seekUpperBound += 1000; await s.source.poll();
  assert.equal(s.source.coversTime(9), false); assert.equal(s.status.at(-1).available, false);
  s.source.stop();
});

test('a late live manifest response after stop cannot deliver cues or claim coverage', async () => {
  const s = setup(); let complete;
  s.source.fetchText = () => new Promise(resolve => { complete = resolve; });
  const pending = s.source.poll(); await new Promise(resolve => setImmediate(resolve));
  s.source.stop(); complete('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-PROGRAM-DATE-TIME:2026-10-01T08:30:02.880Z\n#EXTINF:6,\n0.vtt\n');
  await pending;
  assert.equal(s.received.length, 0); assert.equal(s.source.coversTime(2), false);
});

test('paused preparation can stay near the picture and resume following a distant live head', async () => {
  let follow = false; const fetched = [];
  const s = setup({ followLiveHead: () => follow });
  s.source.fetchText = async url => {
    if (url.endsWith('.m3u8')) return `#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:100\n#EXT-X-PROGRAM-DATE-TIME:2026-10-01T08:30:02.880Z\n${Array.from({ length: 20 }, (_, i) => `#EXTINF:6.000,\n${i}.vtt\n`).join('')}`;
    const index = Number(new URL(url).pathname.match(/\/(\d+)\.vtt$/)[1]);
    fetched.push(index);
    return 'WEBVTT\n\n' + (index === 0 ? vttCue(1, 4, 'First sentence')
      : index === 1 ? vttCue(8, 10, 'Second sentence')
        : index >= 18 ? vttCue(index * 6 + 1, index * 6 + 4, 'Distant live speech') : '');
  };
  await s.source.poll();
  s.content.currentPosition = 9000; await s.source.poll();
  assert.equal(s.source.validated, true);
  assert.ok(fetched.every(index => index <= 9));
  assert.equal(s.source.coversTime(110), false);
  assert.equal(s.received.length, 2);
  follow = true; await s.source.poll();
  assert.ok(fetched.includes(18) && fetched.includes(19));
  assert.equal(s.source.coversTime(110), true);
  assert.equal(s.received.length, 4);
  assert.equal(s.content.currentPosition, 9000);
  s.source.stop();
});
