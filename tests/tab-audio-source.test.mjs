import test from 'node:test';
import assert from 'node:assert/strict';
import { TabAudioPcmBuffer, TabAudioSource } from '../src/tab-audio-source.js';

// These existing engine cases use the refactored PCM input. Browser permission,
// muting and clock-bridge behavior require a separately authorized live session.
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture({ transcribe = async () => ({ cues: [] }), paused = false, sampleRate = 16000 } = {}) {
  const statuses = [], published = [], video = { paused };
  let clock = 1000000, position = 100, resets = 0;
  const source = new TabAudioSource({ transcribe, now: () => clock, timeoutMs: 20000,
    onCues: cues => published.push(...cues), onStatus: status => statuses.push(status), onReset: () => resets++ });
  return { source, video, statuses, published, get resets() { return resets; },
    async start() {},
    async feed(seconds, { amplitude = .25 } = {}) {
      for (let index = 0; index < seconds && !source.stopped; index++) {
        clock += 1000;
        if (!video.paused) {
          source.pushPcm(new Float32Array(sampleRate).fill(amplitude), position, sampleRate);
          position++;
        }
        source.drain(); await flush();
      }
    }
  };
}
test('PCM ring keeps exact 30-second windows with 10-second overlap and bounded storage', () => {
  const buffer = new TabAudioPcmBuffer({ sampleRate: 10 });
  const windows = [];
  for (let second = 0; second < 70; second++) windows.push(...buffer.push(new Float32Array(10).fill(second), 100 + second));
  assert.deepEqual(windows.map(({ start, end }) => [start, end]), [[100, 130], [120, 150], [140, 170]]);
  assert.deepEqual(windows[0].pcm.slice(200), windows[1].pcm.slice(0, 100));
  assert.equal(buffer.samples.length, 300);
  assert.equal(buffer.length, 100);
  assert.equal(buffer.end, 170);
  buffer.clear();
  assert.equal(buffer.end, null);
});


test('finalized sentences use the programme clock and settle window-boundary speech once', async t => {
  const requests = [];
  const f = fixture({ transcribe: async (payload, signal, onCue) => {
    requests.push(payload);
    if (requests.length === 1) {
      onCue({ text: 'unfinished draft', start: 101, end: 103, final: false });
      onCue({ text: 'Great race.', start: 100, end: 104 });
      onCue({ text: 'The car was very good', start: 126, end: 130 });
      return { cues: [{ text: 'Great race.', start: 100, end: 104 }, { text: 'The car was very good', start: 126, end: 130 }] };
    }
    return { cues: [{ text: 'The car was very good today.', start: 126, end: 134 }] };
  } });
  t.after(() => f.source.stop());
  await f.start(); await f.feed(30);
  assert.deepEqual(f.published.map(cue => cue.text), ['Great race.']);
  assert.equal(requests[0].start, 100);
  assert.equal(requests[0].sampleRate, 16000);
  assert.equal(Buffer.from(requests[0].audioBase64, 'base64').byteLength, 30 * 16000 * 2);
  await f.feed(20);
  assert.deepEqual(requests.map(request => request.start), [100, 120]);
  assert.deepEqual(f.published.map(cue => cue.text), ['Great race.', 'The car was very good today.']);
  assert.equal(f.published[1].end, 134);
  assert.equal(f.source.capturedUntil, 150);
});


test('an interval without new PCM does not resubmit the incomplete window', async t => {
  const requests = [];
  const f = fixture({ paused: true, transcribe: async payload => { requests.push(payload); return { cues: [] }; } });
  t.after(() => f.source.stop()); await f.start(); await f.feed(35);
  assert.equal(requests.length, 0);
  f.video.paused = false; await f.feed(20);
  f.video.paused = true; await f.feed(10);
  assert.equal(requests.length, 0);
  assert.equal(f.source.buffer.length, 20 * 16000);
  f.video.paused = false; await f.feed(30);
  assert.deepEqual(requests.map(request => request.start), [100, 120]);
});


test('slow ASR has one active task and only the newest pending window', async t => {
  const jobs = [];
  const f = fixture({ transcribe: (payload, signal) => new Promise(resolve => jobs.push({ payload, signal, resolve })) });
  t.after(() => f.source.stop()); await f.start(); await f.feed(90);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].payload.start, 100);
  assert.equal(f.source.pending.start, 160);
  assert.equal(f.source.buffer.samples.length, 30 * 16000);
  assert.ok(f.statuses.some(status => status.message?.includes('保留最新窗口')));
  jobs[0].resolve({ cues: [] }); await flush();
  assert.equal(jobs.length, 2);
  assert.equal(jobs[1].payload.start, 160);
  f.source.stop();
  assert.equal(jobs[1].signal.aborted, true);
  assert.equal(f.source.pending, null);
  assert.equal(f.source.stopped, true);
});


test('seeking aborts stale recognition before even a late streamed result can publish', async t => {
  let active;
  const f = fixture({ transcribe: (payload, signal, onCue) => new Promise(resolve => { active = { payload, signal, onCue, resolve }; }) });
  t.after(() => f.source.stop()); await f.start(); await f.feed(30);
  f.source.resetTimeline('seek');
  active.onCue({ text: 'Old position.', start: 105, end: 110 });
  assert.equal(active.signal.aborted, true);
  assert.equal(f.published.length, 0);
  assert.equal(f.source.buffer.length, 0);
  assert.ok(f.resets >= 1);
  active.resolve({ cues: [{ text: 'Old position.', start: 105, end: 110 }] }); await flush();
  assert.equal(f.published.length, 0);
});


test('ASR failures back off while capture remains bounded', async t => {
  const requests = [];
  const f = fixture({ transcribe: async payload => { requests.push(payload); throw Object.assign(Error('busy'), { code: 'ASR_BUSY' }); } });
  t.after(() => f.source.stop()); await f.start(); await f.feed(30);
  assert.equal(requests.length, 1);
  assert.equal(f.statuses.at(-1).errorCode, 'ASR_BUSY');
  await f.feed(14); assert.equal(requests.length, 1);
  await f.feed(1); assert.equal(requests.length, 2);
  assert.equal(f.source.stopped, false);
  assert.ok(f.source.buffer.length <= 30 * 16000);
});


test('a browser-selected 48 kHz context is converted to 16 kHz mono PCM without duration drift', async t => {
  let payload;
  const f = fixture({ sampleRate: 48000, transcribe: async request => { payload = request; return { cues: [] }; } });
  t.after(() => f.source.stop()); await f.start(); await f.feed(30);
  assert.equal(payload.sampleRate, 16000);
  const bytes = Buffer.from(payload.audioBase64, 'base64');
  assert.equal(bytes.length, 30 * 16000 * 2);
  assert.equal(bytes.readInt16LE(0), Math.round(.25 * 32767));
  assert.equal(f.source.capturedUntil, 130);
});
