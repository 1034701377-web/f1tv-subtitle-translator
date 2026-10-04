import { mergeTrackFxCues, settleTrackFxWindowCues } from './track-fx-cues.js';

const tabAudioSampleRate = 16000;
const tabAudioMessages = {
  TAB_AUDIO_TRACK: '请先在采集页的官网音轨菜单选择 Track FX，再开始采集',
  TAB_AUDIO_CONTEXT: '浏览器未能启动声音采集，请重新点击开始采集',
  TAB_AUDIO_CLOCK: '未取得官方节目时间，声音采集已停止',
  TAB_AUDIO_CLOCK_DRIFT: '采集声音与官方节目时间持续不符，已停止；请保持采集页正常播放后重新开始',
  TAB_AUDIO_RATE: '采集页需要以 1 倍速播放，请恢复后重新开始采集',
  TAB_AUDIO_RESPONSE: '语音识别返回了无效的字幕时间，本轮结果已丢弃',
  ASR_NOT_CONFIGURED: '本地服务尚未配置语音识别',
  UNAUTHORIZED: '本地语音识别授权失效，请重新配对',
  ASR_AUTH_FAILED: '语音识别认证失败，请检查本机配置',
  ASR_BALANCE: '语音识别额度或余额不足',
  ASR_TIMEOUT: '本轮语音识别超时',
  LOCAL_SERVICE_UNAVAILABLE: '本地语音识别服务不可用'
};
const tabAudioError = code => Object.assign(Error(code), { code });

/** A fixed-size ring: 30 seconds per window, advancing 20 seconds each time. */
export class TabAudioPcmBuffer {
  constructor({ sampleRate = tabAudioSampleRate, windowSeconds = 30, strideSeconds = 20 } = {}) {
    if (!Number.isInteger(sampleRate) || sampleRate < 1 || !(windowSeconds > strideSeconds && strideSeconds > 0)) throw Error('Invalid audio window');
    this.sampleRate = sampleRate;
    this.capacity = Math.round(sampleRate * windowSeconds);
    this.stride = Math.round(sampleRate * strideSeconds);
    if (!(this.capacity > this.stride && this.stride > 0)) throw Error('Invalid audio window');
    this.samples = new Float32Array(this.capacity);
    this.clear();
  }
  clear() { this.offset = 0; this.length = 0; this.start = null; }
  push(samples, start) {
    if (!(samples instanceof Float32Array) || samples.length > this.sampleRate * 2) throw Error('Invalid audio chunk');
    if (this.start === null) {
      if (!Number.isFinite(start) || start < 0) return [];
      this.start = start;
    }
    const windows = [];
    for (let consumed = 0; consumed < samples.length;) {
      const position = (this.offset + this.length) % this.capacity;
      const count = Math.min(samples.length - consumed, this.capacity - this.length, this.capacity - position);
      this.samples.set(samples.subarray(consumed, consumed + count), position);
      consumed += count; this.length += count;
      if (this.length === this.capacity) {
        const pcm = new Float32Array(this.capacity);
        const tail = this.capacity - this.offset;
        pcm.set(this.samples.subarray(this.offset));
        if (this.offset) pcm.set(this.samples.subarray(0, this.offset), tail);
        windows.push({ start: this.start, end: this.start + this.capacity / this.sampleRate, pcm });
        this.offset = (this.offset + this.stride) % this.capacity;
        this.length -= this.stride;
        this.start += this.stride / this.sampleRate;
      }
    }
    return windows;
  }
  get end() { return this.start === null ? null : this.start + this.length / this.sampleRate; }
}

// AudioContext normally supplies 16 kHz. Keep fractional sample weights if the
// browser chooses another rate, so successive chunks do not accumulate drift.
function tabAudioResample(samples, inputRate, state) {
  if (inputRate === tabAudioSampleRate) return samples;
  const ratio = inputRate / tabAudioSampleRate, output = [];
  for (const sample of samples) {
    let remaining = 1;
    while (remaining > 1e-8) {
      const weight = Math.min(remaining, ratio - state.weight);
      state.sum += sample * weight; state.weight += weight; remaining -= weight;
      if (state.weight >= ratio - 1e-8) {
        output.push(state.sum / ratio); state.sum = 0; state.weight = 0;
      }
    }
  }
  return Float32Array.from(output);
}

function tabAudioEncode(pcm) {
  const bytes = new Uint8Array(pcm.length * 2), data = new DataView(bytes.buffer);
  for (let index = 0; index < pcm.length; index++) {
    const value = Math.max(-1, Math.min(1, Number.isFinite(pcm[index]) ? pcm[index] : 0));
    data.setInt16(index * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  let binary = '';
  for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(binary);
}

function tabAudioValidateCue(cue, window) {
  if (cue?.final === false || cue?.isFinal === false) return null;
  if (typeof cue?.text !== 'string' || cue.text.length > 6000 || !Number.isFinite(cue.start) || !Number.isFinite(cue.end)
      || cue.start < window.start - .75 || cue.end > window.end + .75 || cue.end <= cue.start) throw tabAudioError('TAB_AUDIO_RESPONSE');
  const text = cue.text.replace(/\s+/g, ' ').trim();
  const start = Math.max(window.start, cue.start), end = Math.min(window.end, cue.end);
  return text && end > start ? { ...cue, text, start, end } : null;
}

/** Bounded PCM -> existing ASR/settling pipeline. Capture/clock ownership is offscreen. */
export class TabAudioSource {
  constructor({ transcribe, onCues = () => {}, onStatus = () => {}, onReset = () => {}, now = () => Date.now(), timeoutMs = 45000 } = {}) {
    if (typeof transcribe !== 'function') throw TypeError('A transcription transport is required');
    Object.assign(this, { transcribe, onCues, onStatus, onReset, now, timeoutMs });
    this.buffer = new TabAudioPcmBuffer(); this.generation = 0; this.stopped = false;
    this.cues = []; this.completed = []; this.pending = null; this.job = null;
    this.retryAt = 0; this.failureCount = 0; this.capturedUntil = null;
    this.resampler = { sum: 0, weight: 0 };
    this.timer = setInterval(() => this.drain(), 1000);
  }
  status(extra = {}) {
    this.onStatus({ processing: Boolean(this.job), capturedUntil: this.capturedUntil, ...extra });
  }
  resetTimeline(reason = 'timeline-reset') {
    this.generation++; this.job?.controller.abort(); clearTimeout(this.job?.timer); this.job = null;
    this.pending = null; this.buffer.clear(); this.cues = []; this.completed = [];
    this.resampler = { sum: 0, weight: 0 }; this.capturedUntil = null;
    this.onReset({ reason });
  }
  pushPcm(input, start, inputRate) {
    if (this.stopped) return;
    if (this.buffer.end !== null && Math.abs(start - this.buffer.end) > .8) this.resetTimeline('audio-gap');
    const samples = tabAudioResample(input, inputRate, this.resampler);
    for (const window of this.buffer.push(samples, start)) {
      if (this.pending) this.status({ message: '识别暂时落后，保留最新窗口以限制积压。' });
      this.pending = window;
    }
    this.capturedUntil = this.buffer.end;
    this.drain();
  }
  active(job) { return !this.stopped && this.job === job && job.generation === this.generation && !job.controller.signal.aborted; }
  publish(candidates) {
    const merged = mergeTrackFxCues(this.cues, candidates, `extension-${this.generation}`);
    this.cues = merged.cues.filter(cue => cue.end >= this.capturedUntil - 180).slice(-1000);
    if (merged.added.length) this.onCues(merged.added);
  }
  drain() {
    if (this.stopped || this.job || !this.pending || this.now() < this.retryAt) return;
    const window = this.pending; this.pending = null;
    const job = { controller: new AbortController(), generation: this.generation, startedAt: this.now(), window };
    this.job = job; void this.recognize(job);
  }
  async recognize(job) {
    const { window } = job, streamed = [];
    let accepting = true;
    const abort = new Promise((_, reject) => job.controller.signal.addEventListener('abort', () => reject(tabAudioError(job.timedOut ? 'ASR_TIMEOUT' : 'CANCELLED')), { once: true }));
    job.timer = setTimeout(() => { job.timedOut = true; job.controller.abort(); }, this.timeoutMs);
    try {
      this.status({ message: '正在识别采集到的 Track FX' });
      const result = await Promise.race([this.transcribe({ audioBase64: tabAudioEncode(window.pcm), sampleRate: tabAudioSampleRate, start: window.start }, job.controller.signal, raw => {
        if (!accepting || !this.active(job)) return;
        try {
          const cue = tabAudioValidateCue(raw, window);
          if (!cue) return;
          if (streamed.length >= 200) throw tabAudioError('TAB_AUDIO_RESPONSE');
          streamed.push(cue);
          if (cue.end < window.end - .4) this.publish([cue]);
        } catch (error) { job.streamError = error; job.controller.abort(); }
      }), abort]);
      accepting = false;
      if (job.streamError) throw job.streamError;
      if (!this.active(job)) return;
      if (!Array.isArray(result?.cues) || result.cues.length > 200) throw tabAudioError('TAB_AUDIO_RESPONSE');
      const rawCues = [...result.cues, ...streamed].map(cue => tabAudioValidateCue(cue, window)).filter(Boolean);
      this.completed.push({ start: window.start, end: window.end, rawCues, terminal: false });
      this.completed = this.completed.slice(-3);
      this.publish(this.completed.filter(item => item.end > window.start && item.start < window.end)
        .flatMap(item => settleTrackFxWindowCues(item, this.completed)));
      this.failureCount = 0; this.retryAt = 0;
      this.status({ processing: false, recognitionElapsedSeconds: Math.max(0, (this.now() - job.startedAt) / 1000),
        message: result.cues.length ? '声音已识别，继续准备下一段' : '本窗口无定稿语音，采集继续' });
    } catch (error) {
      if (this.stopped || this.job !== job || job.generation !== this.generation) return;
      const code = job.streamError?.code || (job.timedOut ? 'ASR_TIMEOUT' : error?.code) || 'ASR_UPSTREAM_FAILED';
      this.failureCount++;
      const delay = Math.min(120000, 15000 * 2 ** Math.min(3, this.failureCount - 1));
      this.retryAt = this.now() + delay; this.pending ||= window;
      this.status({ processing: false, errorCode: code,
        message: `${tabAudioMessages[code] || '本轮语音识别暂时失败'} · ${delay / 1000} 秒后重试` });
    } finally {
      accepting = false; clearTimeout(job.timer);
      if (this.job === job) { this.job = null; this.drain(); }
    }
  }
  stop() {
    this.stopped = true; clearInterval(this.timer); this.resetTimeline('stopped');
  }
}
