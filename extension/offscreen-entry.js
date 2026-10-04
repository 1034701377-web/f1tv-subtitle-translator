import { CueStore, TranslationQueue } from '../src/core.js';
import { TabAudioSource } from '../src/tab-audio-source.js';
import { createAsrRequester } from '../src/asr-client.js';
import { ProgrammeRelay } from '../src/programme-relay.js';
import { validCaptureSnapshot } from '../src/capture-protocol.js';

const service = 'http://127.0.0.1:3847';
const now = () => performance.timeOrigin + performance.now();
let run = null;
const background = (current, message) => chrome.runtime.sendMessage({ to: 'background', id: current.capture.id, ...message });
function startupFailure(stage, error) {
  // Keep diagnostics useful without echoing browser messages that may contain
  // a capture stream ID, URL or service credential.
  const names = new Set(['TypeError', 'NotAllowedError', 'NotFoundError', 'NotReadableError',
    'OverconstrainedError', 'SecurityError', 'NotSupportedError', 'InvalidStateError', 'AbortError']);
  const kind = names.has(error?.name) ? error.name : 'Error';
  return `采集启动失败：${stage}（${kind}）。请在采集页重试；若仍失败，请提供这条具体提示。`;
}
// Reuse the NDJSON parser/timeouts with a fetch transport inside the extension.
function asrFetch(options) {
  const controller = new AbortController();
  void fetch(options.url, { method: 'POST', headers: options.headers, body: options.data,
    signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store' })
    .then(response => options.onloadstart({ status: response.status, response: response.body }))
    .catch(error => error.name === 'AbortError' ? options.onabort() : options.onerror());
  return { abort: () => controller.abort() };
}
function report(current, message) {
  if (run !== current || current.stopping) return;
  const clock = current.clock;
  const status = { state: clock?.paused ? 'paused' : 'capturing', message: message || current.message,
    contentTime: clock ? clock.time + clock.origin : null,
    capturedUntil: Number.isFinite(current.source?.capturedUntil) ? current.source.capturedUntil + current.origin : null };
  current.relay?.setStatus(status);
  void background(current, { type: 'status', status: { ...status, cueCount: current.relay?.cache.size || 0,
    recognitionElapsedSeconds: current.recognitionElapsedSeconds ?? null,
    receivedSeconds: current.receivedSamples / (current.context?.sampleRate || 16000),
    audioDb: current.audioPeak > 0 ? Math.round(20 * Math.log10(current.audioPeak)) : null,
    asrWindows: current.asrWindows } }).catch(() => {});
}
function fail(current, message) {
  if (run !== current || current.stopping) return;
  current.stopping = true;
  current.source?.stop(); current.queue?.dispose(); current.pcm.length = 0;
  void background(current, { type: 'failed', message }).catch(() => dispose(current));
}
function applyClock(current, next, sentAt, receivedAt) {
  if (!validCaptureSnapshot(next, current.capture.programmeId)) return fail(current, '节目或官方时钟已改变，请重新准备采集页。');
  if (next.problem) return fail(current, next.problem);
  // The page and this long-lived document can expose different clock epochs.
  // Calibrate their transport timestamps with one bounded, fresh round trip;
  // programme time/origin remain untouched. A slow reply cannot establish the
  // offset: a <=500 ms round trip bounds initial alignment error to 250 ms.
  const roundTrip = receivedAt - sentAt;
  if (!Number.isFinite(roundTrip) || roundTrip < 0 || roundTrip > 3000) return;
  if (!Number.isFinite(current.clockOffset)) {
    if (roundTrip > 500) return;
    current.clockOffset = (sentAt + receivedAt) / 2 - next.at;
  }
  next = { ...next, at: next.at + current.clockOffset };
  // Late replies cannot move the clock backwards or label today's PCM with an
  // old observation. A short delay retains PCM and waits for the next bracket.
  if (next.at < sentAt - 250 || next.at > receivedAt + 250
      || now() - next.at > 3000 || next.at > now() + 250 || (current.clock && next.at <= current.clock.at)) return;
  const previous = current.clock;
  current.clock = next; current.lastClockAt = now();
  if (!previous) { current.clocks.push(next); return; }
  const elapsed = (next.at - previous.at) / 1000;
  const advance = next.time + next.origin - previous.time - previous.origin;
  const continuous = next.epoch === previous.epoch && !previous.paused && !next.paused
    && Math.abs(advance - elapsed) < .8;
  if (!continuous) {
    if (!current.inGap) current.source.resetTimeline('programme-discontinuity');
    current.inGap = true;
    current.clocks = [next];
  } else current.inGap = false;
  if (continuous) current.clocks.push(next);
  while (current.clocks.length > 160) current.clocks.shift();
  drainPcm(current);
  report(current, next.paused ? '采集页已暂停，请在官网恢复播放；观看页暂停不会影响本页。' : undefined);
}
function drainPcm(current) {
  // Process only audio bounded by two real official-clock observations. Never
  // stamp PCM by translation completion, wallclock.currentPosition or -50 s.
  // Keep the clock brackets until the corresponding worklet block arrives:
  // a clock reply can arrive before a partially filled 4096-sample block.
  while (current.pcm.length && current.clocks.length >= 2) {
    const chunk = current.pcm[0], rate = current.context.sampleRate;
    if (chunk.startAt + chunk.samples.length / rate * 1000 > current.clocks.at(-1).at) break;
    while (current.clocks.length > 2 && current.clocks[1].at <= chunk.startAt) current.clocks.shift();
    const previous = current.clocks[0];
    const first = Math.max(0, Math.ceil((previous.at - chunk.startAt) * rate / 1000));
    if (chunk.samples.length > first) {
      const startAt = chunk.startAt + first / rate * 1000;
      const start = previous.time + previous.origin - current.origin + (startAt - previous.at) / 1000;
      if (start >= 0) current.source.pushPcm(chunk.samples.subarray(first), start, rate);
    }
    current.pcm.shift();
  }
}
async function refreshClock(current) {
  if (run !== current || current.stopping || current.clockBusy) return;
  current.clockBusy = true;
  const sentAt = now();
  let timeout;
  try {
    const snapshot = await Promise.race([
      background(current, { type: 'clock' }),
      new Promise(resolve => { timeout = setTimeout(() => resolve(null), 3000); })
    ]);
    if (run !== current || current.stopping) return;
    if (snapshot) applyClock(current, snapshot, sentAt, now());
  } catch { /* A missed message is not a stop command. */ }
  finally { clearTimeout(timeout); current.clockBusy = false; }
}
async function start(message) {
  if (run) return { ok: false, message: '扩展已有采集会话，请先停止。' };
  const current = { capture: message.capture, token: message.token, origin: message.snapshot.origin,
    pcm: [], clocks: [], clock: null, receivedSamples: 0, audioPeak: 0, asrWindows: 0,
    lastClockAt: now(), message: '已接入本页音频，首个识别窗口需要 30 秒。' };
  run = current;
  let stage = '接入标签页声音';
  try {
    // Chrome's tab-capture ID uses legacy constraints. Mixing mandatory with
    // standard echo/noise/gain constraints throws before a stream is opened.
    // This is the same browser capture request for both live and replay tabs.
    const stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: {
      mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: message.streamId }
    } });
    if (run !== current) { stream.getTracks().forEach(track => track.stop()); return { ok: false }; }
    current.stream = stream;
    stage = '检查声音轨道';
    const audio = stream.getAudioTracks()[0];
    if (!audio || audio.readyState !== 'live') throw Error('no-audio');
    audio.addEventListener('ended', () => fail(current, '标签页音频已结束，请重新打开面板中的采集开关。'), { once: true });
    stage = '创建音频环境';
    current.context = new AudioContext({ sampleRate: 16000 });
    stage = '加载音频模块';
    await current.context.audioWorklet.addModule('pcm-worklet.js');
    stage = '启动音频环境';
    await current.context.resume();
    if (run !== current) return { ok: false };
    if (current.context.state !== 'running') throw Error('audio-context');
    current.context.onstatechange = () => {
      if (run === current && current.context.state === 'suspended') fail(current, '扩展音频处理被暂停，请重新开始采集。');
    };
    stage = '建立字幕处理队列';
    current.channel = { onmessage: null, close() {}, postMessage(packet) {
      void background(current, { type: 'relay', packet }).catch(() => {});
    } };
    // Subtitle visibility never controls the audio switch. Only an explicit
    // stop or a capture failure releases this session.
    current.relay = new ProgrammeRelay({ programmeId: current.capture.programmeId, role: 'collector',
      channelFactory: () => current.channel });
    const store = new CueStore({ maxCues: 600 });
    current.queue = new TranslationQueue(store, async (cue, context, signal) => {
      const response = await fetch(`${service}/api/translate`, { method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
        signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${current.token}` }, body: JSON.stringify({ cue, context }) });
      const value = await response.json();
      if (!response.ok) {
        current.message = response.status === 401 ? '本机配对失效，请在扩展设置重新配对。' : '本轮中文翻译失败，采集继续。';
        report(current); throw Error('translation-unavailable');
      }
      return value;
    }, { concurrency: 2, maxPending: 120, contextWaitMs: 0,
      onReady: cue => {
        if (run !== current || current.stopping) return;
        current.relay.publish([{ ...cue, start: cue.start + current.origin, end: cue.end + current.origin }]);
      } });
    const transcribe = createAsrRequester(asrFetch, { service, getToken: () => current.token });
    current.source = new TabAudioSource({
      transcribe: (...args) => { current.asrWindows++; report(current); return transcribe(...args); },
      onCues: cues => current.queue.ingestMany(cues),
      onReset: () => current.queue.reset(),
      onStatus: status => {
        if (status.message) current.message = status.message;
        if (Number.isFinite(status.recognitionElapsedSeconds)) current.recognitionElapsedSeconds = status.recognitionElapsedSeconds;
        report(current);
      }
    });
    stage = '连接声音输入';
    current.input = current.context.createMediaStreamSource(stream);
    stage = '创建声音处理节点';
    current.processor = new AudioWorkletNode(current.context, 'track-pcm', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    current.processor.onprocessorerror = () => fail(current, '扩展音频处理已中断，请重新开始。');
    current.processor.port.onmessage = event => {
      current.processor.port.postMessage('ack');
      if (run !== current || current.stopping) return;
      const { samples, endFrame, sequence } = event.data;
      if (current.sequence && sequence !== current.sequence + 1) {
        current.pcm.length = 0; current.source.resetTimeline('audio-overrun');
      }
      current.sequence = sequence;
      current.receivedSamples += samples.length;
      current.audioPeak = samples.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0);
      if (current.clock?.paused) return;
      const rate = current.context.sampleRate;
      // Audio frames can stop advancing while the context still reports
      // running. A one-time anchor would then date all resumed sound in the
      // past. Compare clocks, not message arrival against endFrame: a delayed
      // worklet message must keep the timestamp of its original samples.
      const audioOriginAt = now() - current.context.currentTime * 1000;
      if (Number.isFinite(current.audioOriginAt) && Math.abs(audioOriginAt - current.audioOriginAt) > 750) {
        current.audioOriginAt = audioOriginAt;
        current.pcm.length = 0;
        current.source.resetTimeline('audio-clock-discontinuity');
        current.message = '音频时钟已重新对齐，正在准备下一段字幕。';
        report(current);
        // This block may straddle the interruption. Resume with the next
        // block, still bounded by fresh official programme-clock observations.
        return;
      }
      current.audioOriginAt ??= audioOriginAt;
      const endAt = current.audioOriginAt + endFrame / rate * 1000;
      current.pcm.push({ samples, startAt: endAt - samples.length / rate * 1000 });
      drainPcm(current);
      // Keep at most 40 s of PCM awaiting clock confirmation, never a growing
      // queue of unverified audio. Normal late messages do not clear the ring.
      while (current.pcm.length > Math.ceil(rate * 40 / 4096) + 1) {
        current.pcm.shift(); current.source.resetTimeline('clock-buffer-overrun');
      }
    };
    stage = '连接音频处理';
    current.input.connect(current.processor);
    // The worklet fills every output with zero; captured samples never reach
    // this destination. The connection only keeps the audio graph running.
    current.processor.connect(current.context.destination);
    stage = '校验节目时钟';
    // Startup may take seconds. Use a fresh request with a measured round trip
    // instead of treating the popup's older snapshot as an audio observation.
    await refreshClock(current);
    if (run !== current) return { ok: false };
    if (current.stopping) return { ok: false, message: '扩展启动期间节目状态改变，请重新准备。' };
    current.timer = setInterval(() => {
      const age = now() - current.lastClockAt;
      if (age > 120000) return fail(current, '官方节目时钟长时间未响应，已停止采集；请刷新采集页后重试。');
      if (age > 5000) report(current, '等待官方节目时钟恢复，音频暂存在有界内存中。');
      void refreshClock(current);
    }, 500);
    report(current); return { ok: true };
  } catch (error) {
    await dispose(current);
    return { ok: false, message: startupFailure(stage, error) };
  }
}
async function dispose(current) {
  if (!current) return;
  current.stopping = true;
  if (run === current) run = null;
  clearInterval(current.timer); current.source?.stop(); current.queue?.dispose(); current.relay?.close();
  current.pcm.length = 0; current.clocks.length = 0; current.token = '';
  if (current.processor) current.processor.port.onmessage = null;
  try { current.input?.disconnect(); current.processor?.disconnect(); } catch {}
  current.stream?.getTracks().forEach(track => track.stop());
  await current.context?.close().catch(() => {});
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.to !== 'offscreen' || sender.id !== chrome.runtime.id || sender.tab) return;
  const handle = async () => {
    if (message.type === 'start') return start(message);
    if (!run || message.id !== run.capture.id) return null;
    if (message.type === 'stop') { await dispose(run); return { ok: true }; }
    if (message.type === 'relay') run.channel?.onmessage?.({ data: message.packet });
    if (message.type === 'clock-changed') void refreshClock(run);
    return null;
  };
  void handle().then(respond, () => respond({ ok: false })); return true;
});
