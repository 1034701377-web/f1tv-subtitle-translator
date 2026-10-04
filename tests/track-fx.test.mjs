import test from 'node:test';
import assert from 'node:assert/strict';
import { TrackFxSource, parseTrackFxPlaylist, planTrackFxWindows, mergeTrackFxCues, settleTrackFxWindowCues, isTrackFxSeek } from '../src/track-fx-source.js';

const URL = 'https://f1tv.formula1.com/audio/fx.m3u8?signature=private';
const manifest = (count = 20) => '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-MAP:URI="init.mp4"\n'
  + Array.from({ length: count }, (_, i) => `#EXTINF:5.760,\n${i}.m4s\n`).join('') + '#EXT-X-ENDLIST\n';
const protectedManifest = () => manifest().replace('#EXT-X-MAP',
  '#EXT-X-KEY:METHOD=SAMPLE-AES,KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed",URI="https://license.example/never-read"\n#EXT-X-MAP');

test('fMP4 VOD maps complete media to programme seconds and checks its SDK duration', () => {
  const parsed = parseTrackFxPlaylist(manifest(), URL, { contentDuration: 115.2 });
  assert.equal(parsed.mapUrl, 'https://f1tv.formula1.com/audio/init.mp4');
  assert.equal(parsed.segments[0].start, 0);
  assert.ok(Math.abs(parsed.segments[3].start - 17.28) < 1e-9);
  assert.throws(() => parseTrackFxPlaylist(manifest(), URL, { contentDuration: 150 }), error =>
    error.code === 'FX_VOD_DURATION' && Math.abs(error.details.differenceSeconds - 34.8) < 1e-9);
  assert.throws(() => parseTrackFxPlaylist(manifest(), URL), /FX_SDK_DURATION/);
  assert.throws(() => parseTrackFxPlaylist(manifest().replace('#EXT-X-MAP', '#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXT-X-MAP'), URL, { contentDuration: 115.2 }), /FX_ENCRYPTED/);
  assert.throws(() => parseTrackFxPlaylist(manifest().replace('#EXT-X-ENDLIST', '#EXT-X-DISCONTINUITY\n#EXT-X-ENDLIST'), URL, { contentDuration: 115.2 }), /FX_DISCONTINUITY/);
});

test('observed 822-segment VOD sequence 1 still begins at programme zero', () => {
  const observed = manifest(822).replace('SEQUENCE:0', 'SEQUENCE:1')
    .replace('#EXT-X-MAP:', '#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-PROGRAM-DATE-TIME:2026-09-05T13:55:00.480Z\n#EXT-X-MAP:');
  const parsed = parseTrackFxPlaylist(observed, URL, { contentDuration: 4734.720 });
  assert.equal(parsed.segments[0].sequence, 1); assert.equal(parsed.segments[0].start, 0);
  assert.ok(Math.abs(parsed.duration - 4734.720) < 1e-8);
  const current = parsed.segments.find(segment => segment.start <= 2077.792 && segment.end > 2077.792);
  assert.equal(current.sequence, 361); assert.ok(Math.abs(current.start - 2073.6) < 1e-8);
});

test('rolling live media requires PDT and verified wallclock origin, never starts at zero', () => {
  const origin = Date.parse('2026-10-01T00:00:00Z') / 1000;
  const live = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:100\n#EXT-X-PROGRAM-DATE-TIME:2026-10-01T00:10:00Z\n#EXTINF:5.760,\n100.m4s\n#EXTINF:5.760,\n101.m4s\n';
  const parsed = parseTrackFxPlaylist(live, URL, { eventType: 'live', origin });
  assert.equal(parsed.segments[0].start, 600);
  assert.ok(Math.abs(parsed.segments[1].end - 611.52) < 1e-6);
  assert.throws(() => parseTrackFxPlaylist(live, URL, { eventType: 'live' }), /FX_LIVE_ORIGIN/);
  assert.throws(() => parseTrackFxPlaylist(live.replace(/#EXT-X-PROGRAM-DATE-TIME:[^\n]+\n/, ''), URL, { eventType: 'live', origin }), /FX_LIVE_PDT/);
});

test('DRM is distinct from unsupported ordinary encryption; METHOD=NONE remains readable', () => {
  assert.throws(() => parseTrackFxPlaylist(protectedManifest(), URL, { contentDuration: 115.2 }), { code: 'FX_DRM' });
  const aes = manifest().replace('#EXT-X-MAP', '#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXT-X-MAP');
  assert.throws(() => parseTrackFxPlaylist(aes, URL, { contentDuration: 115.2 }), { code: 'FX_ENCRYPTED' });
  const clear = manifest().replace('#EXT-X-MAP', '#EXT-X-KEY:METHOD=NONE\n#EXT-X-MAP');
  assert.equal(parseTrackFxPlaylist(clear, URL, { contentDuration: 115.2 }).segments.length, 20);
});

test('20-second windows overlap continuously and a paused VOD has a finite horizon', () => {
  const parsed = parseTrackFxPlaylist(manifest(100), URL, { contentDuration: 576 });
  const options = { aheadSeconds: 55, windowSeconds: 20, overlapSeconds: 5 };
  const windows = planTrackFxWindows(parsed, 205, options);
  assert.deepEqual(windows.map(window => [window.start, window.end]), [[195, 215], [210, 230], [225, 245], [240, 260]]);
  for (let i = 1; i < windows.length; i++) assert.equal(windows[i - 1].end - windows[i].start, 5);
  assert.deepEqual(planTrackFxWindows(parsed, 205, options), windows);
});

test('default windows are complete 30-second requests with 10-second overlap within 60 seconds ahead', () => {
  const parsed = parseTrackFxPlaylist(manifest(100), URL, { contentDuration: 576 });
  const windows = planTrackFxWindows(parsed, 205);
  assert.deepEqual(windows.map(window => [window.start, window.end]), [[180, 210], [200, 230], [220, 250]]);
  assert.ok(windows.every(window => window.end - window.start === 30 && window.end <= 265));
  const tail = planTrackFxWindows(parsed, 570).at(-1);
  assert.ok(Math.abs(tail.end - 576) < 1e-8); assert.ok(tail.end - tail.start < 30);
  const live = { ...parsed, eventType: 'live', ended: false, segments: [{ start: 195, end: 225 }] };
  assert.deepEqual(planTrackFxWindows(live, 205), []);
});

test('overlapping recognition deduplicates punctuation/partial text without rewriting the first cue', () => {
  const first = mergeTrackFxCues([], [{ text: 'Box, box. We need to retire the car.', start: 2074.16, end: 2079.28 }], 'race');
  const second = mergeTrackFxCues(first.cues, [
    { text: 'Box box we need to retire the car', start: 2074.4, end: 2079.4 },
    { text: 'We need to retire the car.', start: 2075, end: 2079.3 },
    { text: 'Box, box. We need to retire the car.', start: 2090, end: 2095 }
  ], 'race');
  assert.equal(second.cues.length, 2); assert.equal(second.added.length, 1);
  assert.equal(second.cues[0], first.cues[0]); assert.equal(second.cues[0].end, 2079.28);
  assert.equal(Object.isFrozen(second.cues[0]), true);
  assert.equal(mergeTrackFxCues([], [{ text: first.cues[0].text, start: 2074.16, end: 2079.28 }], 'race').cues[0].id, first.cues[0].id);
});

test('a cue at a window boundary waits for the overlap and prefers the next complete sentence', () => {
  const first = { start: 30, end: 50, rawCues: [{ text: 'We need to retire the car', start: 47, end: 50 }] };
  const second = { start: 45, end: 65, rawCues: [{ text: 'We need to retire the car. Box this lap.', start: 47, end: 53 }] };
  assert.deepEqual(settleTrackFxWindowCues(first, [first]), []);
  assert.deepEqual(settleTrackFxWindowCues(first, [first, second]), second.rawCues);
  assert.deepEqual(settleTrackFxWindowCues({ ...first, terminal: true }, [first]), first.rawCues);
});

function setup({ transcribe, streams, fetchText, fetchBytes } = {}) {
  const clock = { eventType: 'vod', currentPosition: 35000, contentDuration: 115200 };
  const fx = { name: Promise.resolve('Track FX'), language: Promise.resolve('fx'), streams: streams || Promise.resolve([
    Promise.resolve({ url: Promise.resolve(URL) })
  ]) };
  // Every SDK property that is Promise-valued in the real adapter is Promise-valued here too.
  const content = { feeds: Promise.resolve([Promise.resolve({ audioTracks: Promise.resolve([Promise.resolve(fx)]) })]) };
  const view = { currentContentTime: clock, associatedPlayer: { currentAudioTrack: Promise.resolve({ parentContentItem: Promise.resolve(content) }) } };
  const calls = [], received = [], statuses = []; let resets = 0;
  const source = new TrackFxSource(view, {
    aheadSeconds: 30, windowSeconds: 20, overlapSeconds: 5,
    fetchText: fetchText || (async () => manifest()), fetchBytes: fetchBytes || (async () => new ArrayBuffer(4)),
    encodeAudio: async input => { assert.equal(input.end - input.start, 20); return 'AAAA'; },
    transcribe: transcribe || (async (audio, signal) => {
      calls.push({ ...audio, signal });
      return { cues: [{ text: `Radio message at ${audio.start + 7}`, start: audio.start + 7, end: audio.start + 9 }] };
    }),
    onReset: () => { resets++; }, onStatus: status => statuses.push(status)
  });
  source.stopped = false; source.onCues = cues => received.push(...cues);
  return { source, clock, fx, calls, received, statuses, resets: () => resets };
}

test('a readable official alternative is selected after DRM without reading protected audio or foreign URLs', async () => {
  const protectedUrl = 'https://f1tv.formula1.com/protected/audio.m3u8';
  const clearUrl = 'https://f1tv.formula1.com/clear/audio.m3u8';
  const manifests = [], binaries = [];
  const s = setup({ streams: [{ url: 'https://untrusted.example/audio.m3u8' }, { url: protectedUrl }, { url: clearUrl }],
    fetchText: async url => { manifests.push(url); return url === protectedUrl ? protectedManifest() : manifest(); },
    fetchBytes: async url => { binaries.push(url); return new ArrayBuffer(4); }
  });
  try {
    await s.source.poll(); await s.source.poll();
    assert.deepEqual(manifests, [protectedUrl, clearUrl]);
    assert.equal(s.calls.length, 2); assert.equal(s.source.url, clearUrl);
    assert.ok(binaries.length > 0 && binaries.every(url => url.startsWith('https://f1tv.formula1.com/clear/')));
  } finally { s.source.stop(); }
});

test('all-DRM sources are checked infrequently and a new candidate recovers immediately without old captions', async () => {
  const manifests = [], binaries = [];
  const s = setup({ fetchText: async url => { manifests.push(url); return url === URL ? protectedManifest() : manifest(); },
    fetchBytes: async url => { binaries.push(url); return new ArrayBuffer(4); }
  });
  try {
    await s.source.poll(); await s.source.poll();
    assert.equal(manifests.length, 1); assert.equal(binaries.length, 0); assert.equal(s.calls.length, 0);
    assert.equal(s.statuses.at(-1).errorCode, 'FX_DRM');
    assert.match(s.statuses.at(-1).message, /5 分钟检查/);
    assert.doesNotMatch(s.statuses.at(-1).message, /重试/);
    assert.ok(s.source.retryAt - Date.now() > 295000);
    s.fx.streams = [{ url: 'https://f1tv.formula1.com/next-race/audio.m3u8' }];
    await s.source.poll();
    assert.equal(s.calls.length, 2); assert.equal(s.source.failureCount, 0);
    const previousIds = s.received.map(cue => cue.id);
    s.fx.streams = [{ url: 'https://f1tv.formula1.com/another-race/audio.m3u8' }];
    await s.source.poll();
    assert.equal(s.calls.length, 4); assert.equal(s.source.completed.size, 2);
    assert.ok(s.source.cues.every(cue => !previousIds.includes(cue.id)));
  } finally { s.source.stop(); }
});

test('network failures remain distinct from DRM and never read audio before a valid manifest', async () => {
  const s = setup({ fetchText: async () => { throw Error('private-network-detail'); },
    fetchBytes: async () => assert.fail('must not fetch audio') });
  try {
    await s.source.poll();
    assert.equal(s.statuses.at(-1).errorCode, 'FX_FETCH');
    assert.match(s.statuses.at(-1).message, /30 秒后重试/);
    assert.doesNotMatch(s.statuses.at(-1).message, /private-network-detail/);
    assert.equal(s.calls.length, 0);
  } finally { s.source.stop(); }
});

test('Promise-valued SDK traversal works without enabling captions; pause repeats use recognition cache', async () => {
  const s = setup();
  await s.source.poll();
  assert.equal(s.calls.length, 2); assert.equal(s.received.length, 2);
  assert.equal(s.calls[0].sampleRate, 16000); assert.equal(s.calls[0].start, 30);
  assert.equal(s.statuses.at(-1).completedWindows, 2);
  await s.source.poll(); assert.equal(s.calls.length, 2); assert.equal(s.received.length, 2);
  s.source.stop();
});

test('seeking aborts an in-flight epoch; a late result cannot publish and cached replay is redelivered', async () => {
  const s = setup(); await s.source.poll();
  const oldIds = s.received.map(cue => cue.id), completedCalls = s.calls.length;
  let resolveLate, oldSignal;
  s.source.transcribe = (audio, signal) => { oldSignal = signal; return new Promise(resolve => { resolveLate = resolve; }); };
  s.clock.currentPosition = 80000;
  const oldPoll = s.source.poll();
  while (!resolveLate) await new Promise(resolve => setImmediate(resolve));
  const beforeReplay = s.received.length;
  s.clock.currentPosition = 35000; await s.source.poll();
  assert.equal(oldSignal.aborted, true);
  assert.deepEqual(s.received.slice(beforeReplay).map(cue => cue.id), oldIds);
  const afterReplay = s.received.length;
  resolveLate({ cues: [{ text: 'Obsolete future result', start: 82, end: 84 }] }); await oldPoll;
  assert.equal(s.received.length, afterReplay);
  assert.equal(s.source.completed.size, completedCalls);
  assert.ok(s.resets() >= 3);
  s.source.stop();
});

test('stop aborts a request and prevents late cues or status updates', async () => {
  let finish, signal;
  const s = setup({ transcribe: (audio, nextSignal) => { signal = nextSignal; return new Promise(resolve => { finish = resolve; }); } });
  const pending = s.source.poll();
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  const statuses = s.statuses.length;
  s.source.stop(); assert.equal(signal.aborted, true);
  finish({ cues: [{ text: 'Late cue', start: 37, end: 39 }] }); await pending;
  assert.equal(s.received.length, 0); assert.equal(s.statuses.length, statuses);
  assert.equal(s.source.coversTime(37), false);
});

test('ASR configuration/auth errors do not repeatedly upload audio on every poll', async () => {
  let requests = 0;
  const s = setup({ transcribe: async () => { requests++; throw Object.assign(Error('not configured'), { code: 'ASR_NOT_CONFIGURED' }); } });
  await s.source.poll(); await s.source.poll(); await s.source.poll();
  assert.equal(requests, 1); assert.equal(s.source.retryAt, Infinity);
  s.clock.currentPosition = 80000; await s.source.poll(); assert.equal(requests, 1);
  assert.match(s.statuses.at(-1).message, /重新开启 TR/);
  s.source.stop();
});

test('a seek between poll ticks also rejects the old ASR response at commit time', async () => {
  let finish;
  const s = setup({ transcribe: () => new Promise(resolve => { finish = resolve; }) });
  const pending = s.source.poll();
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  s.clock.currentPosition = 80000;
  finish({ cues: [{ text: 'Old position', start: 37, end: 39 }] }); await pending;
  assert.equal(s.received.length, 0); assert.equal(s.source.completed.size, 0);
  s.source.stop();
});

test('final streaming sentences deliver before the response ends; window tails wait for the next overlap', async () => {
  let emit, finish, requests = 0;
  const interior = { text: 'Stay out for now.', start: 37, end: 39 };
  const boundary = { text: 'We need to retire the car', start: 47, end: 50 };
  const complete = { text: 'We need to retire the car. Box this lap.', start: 47, end: 53 };
  const s = setup({ transcribe: (audio, signal, onCue) => {
    if (++requests === 1) { emit = onCue; return new Promise(resolve => { finish = resolve; }); }
    onCue(complete); return Promise.resolve({ cues: [complete] });
  } });
  const pending = s.source.poll();
  while (!emit) await new Promise(resolve => setImmediate(resolve));
  emit({ ...interior, final: false }); assert.equal(s.received.length, 0);
  emit(interior); emit(boundary);
  assert.equal(s.source.completed.size, 0); assert.equal(s.received.length, 1);
  assert.equal(s.received[0].text, interior.text);
  finish({ cues: [interior, boundary] }); await pending;
  assert.deepEqual(s.received.map(cue => cue.text), [interior.text, complete.text]);
  assert.equal(s.source.completed.size, 2);
  s.source.stop();
});

test('a streaming callback after an unpolled seek cannot deliver an old sentence', async () => {
  let emit, finish, signal;
  const s = setup({ transcribe: (audio, nextSignal, onCue) => {
    signal = nextSignal; emit = onCue; return new Promise(resolve => { finish = resolve; });
  } });
  const pending = s.source.poll();
  while (!emit) await new Promise(resolve => setImmediate(resolve));
  s.clock.currentPosition = 80000; emit({ text: 'Old position', start: 37, end: 39 });
  assert.equal(signal.aborted, true); assert.equal(s.received.length, 0);
  finish({ cues: [] }); await pending;
  assert.equal(s.source.completed.size, 0);
  s.source.stop();
});

test('duration mismatch status provides safe numerical diagnostics without resource URLs', async () => {
  const s = setup(); s.clock.contentDuration = 150000;
  await s.source.poll();
  assert.equal(s.statuses.at(-1).errorCode, 'FX_VOD_DURATION');
  assert.deepEqual(s.statuses.at(-1).diagnostics, { expectedSeconds: 150, actualSeconds: 115.2, differenceSeconds: 34.8 });
  assert.match(s.statuses.at(-1).message, /相差 34.8 秒/);
  assert.ok(!JSON.stringify(s.statuses).includes('signature'));
  s.source.stop();
});

test('seek detector permits ordinary play/pause and catches jumps during an in-flight request', () => {
  const previous = { time: 100, at: 1000 };
  assert.equal(isTrackFxSeek(previous, { time: 101, at: 2000 }), false);
  assert.equal(isTrackFxSeek(previous, { time: 100, at: 2000 }), false);
  assert.equal(isTrackFxSeek(previous, { time: 104, at: 2000 }, 4), false);
  assert.equal(isTrackFxSeek(previous, { time: 140, at: 2000 }), true);
  assert.equal(isTrackFxSeek(previous, { time: 50, at: 2000 }), true);
});
