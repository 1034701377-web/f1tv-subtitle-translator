import { cleanText, hash, mergeTrackFxCues, settleTrackFxWindowCues } from './track-fx-cues.js';
export { mergeTrackFxCues, settleTrackFxWindowCues } from './track-fx-cues.js';
import { parseHlsVodPlaylist, parseHlsLivePlaylist } from './hls-vtt.js';
import { tiledContentSeconds } from './tiledmedia-source.js';
import { tiledLiveOriginSeconds } from './tiledmedia-live-source.js';

const SAMPLE_RATE = 16000;
const fail = (code, details) => { throw Object.assign(Error(code), { code, details }); };
const abortError = () => Object.assign(Error('FX_ABORTED'), { name: 'AbortError' });
function officialUrl(value, base) {
  let url;
  try { url = new URL(value, base); } catch { fail('FX_RESOURCE'); }
  if (url.protocol !== 'https:' || url.username || url.password || !/(^|\.)formula1\.com$/i.test(url.hostname)) fail('FX_RESOURCE');
  return url.href;
}

/** Only continuous, unencrypted fMP4 media is supported. Never rebase a live head to zero. */
export function parseTrackFxPlaylist(text, baseUrl, { eventType = 'vod', origin, contentDuration } = {}) {
  officialUrl(baseUrl);
  if (typeof text !== 'string' || text.length > 8_000_000) fail('FX_PLAYLIST');
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  let mapUrl;
  const filtered = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-MAP:')) {
      // Byte ranges and changing initialization segments need a different decoder.
      const match = /^#EXT-X-MAP:URI="([^"]+)"$/.exec(line);
      if (!match) fail('FX_FORMAT');
      const next = officialUrl(match[1], baseUrl);
      if (mapUrl && next !== mapUrl) fail('FX_DISCONTINUITY');
      mapUrl = next;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const method = /(?:^|,)METHOD=([^,]+)/.exec(line.slice(11))?.[1];
      const keyFormat = /(?:^|,)KEYFORMAT="([^"]+)"/.exec(line.slice(11))?.[1] || 'identity';
      const drm = /^(?:urn:uuid:(?:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed|9a04f079-9840-4286-ab92-e65be0885f95)|com\.apple\.streamingkeydelivery|com\.microsoft\.playready|com\.widevine\.alpha)$/i.test(keyFormat);
      if (method !== 'NONE') fail(drm ? 'FX_DRM' : 'FX_ENCRYPTED');
    } else if (line.startsWith('#EXT-X-DISCONTINUITY') && !line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')) {
      fail('FX_DISCONTINUITY');
    } else if (eventType === 'vod' && line === '#EXT-X-DISCONTINUITY-SEQUENCE:0') {
      // Complete zero-origin VOD may explicitly declare its initial sequence.
    } else filtered.push(raw);
  }
  if (!mapUrl) fail('FX_FORMAT');
  let parsed;
  try {
    if (eventType === 'vod') {
      parsed = parseHlsVodPlaylist(filtered.join('\n'), baseUrl);
      // MEDIA-SEQUENCE labels segments; it is not an offset on the programme
      // clock. The observed complete VOD starts at sequence 1 and time zero.
      if (!Number.isFinite(contentDuration) || contentDuration <= 0) fail('FX_SDK_DURATION');
      if (Math.abs(parsed.duration - contentDuration) > 2) fail('FX_VOD_DURATION', {
        expectedSeconds: contentDuration, actualSeconds: parsed.duration, differenceSeconds: Math.abs(parsed.duration - contentDuration)
      });
      parsed.ended = true;
    } else if (eventType === 'live') {
      if (!Number.isFinite(origin) || origin < 1e9) fail('FX_LIVE_ORIGIN');
      parsed = parseHlsLivePlaylist(filtered.join('\n'), baseUrl);
      parsed.segments = parsed.segments.map(segment => ({ ...segment, start: segment.start - origin, end: segment.end - origin }));
    } else fail('FX_EVENT_TYPE');
  } catch (error) {
    if (error.message?.startsWith('FX_')) throw error;
    if (eventType === 'live' && /program date time/i.test(error.message || '')) fail('FX_LIVE_PDT');
    fail('FX_PLAYLIST');
  }
  for (const segment of parsed.segments) officialUrl(segment.url);
  return { ...parsed, mapUrl, eventType };
}

/** Fixed programme-clock windows retain full audio, with overlap for boundary speech. */
export function planTrackFxWindows(playlist, time, { aheadSeconds = 60, windowSeconds = 30, overlapSeconds = 10 } = {}) {
  const stride = windowSeconds - overlapSeconds;
  if (!(stride > 0) || !Number.isFinite(time) || !playlist?.segments?.length) return [];
  const lower = Math.max(0, playlist.segments[0].start), upper = playlist.segments.at(-1).end;
  const windows = [];
  const first = Math.floor(Math.max(lower, time - overlapSeconds) / stride) * stride;
  const horizon = Math.min(upper, time + aheadSeconds);
  for (let position = first; position < horizon; position += stride) {
    const start = position, end = Math.min(upper, position + windowSeconds);
    const vodTail = playlist.eventType === 'vod' && playlist.ended && end >= upper - .001;
    if (start < lower - .001 || end <= start || end > horizon + .001
        || (!vodTail && end - start < windowSeconds - .001)) continue;
    windows.push({ start, end, key: `${Math.round(start * 1000)}:${Math.round(end * 1000)}` });
  }
  return windows;
}

export function isTrackFxSeek(previous, current, playbackRate = 1) {
  if (!previous || !Number.isFinite(previous.time) || !Number.isFinite(current.time)) return false;
  const elapsed = Math.max(0, (current.at - previous.at) / 1000);
  const jump = current.time - previous.time;
  return jump < -1 || jump > Math.max(3, elapsed * Math.max(1, playbackRate) + 2);
}

async function fetchResource(url, signal, binary) {
  officialUrl(url);
  const response = await fetch(url, { signal, credentials: 'include', redirect: 'error', cache: 'no-store' });
  if (!response.ok) fail('FX_FETCH');
  const body = binary ? await response.arrayBuffer() : await response.text();
  if ((binary ? body.byteLength : body.length) > 8_000_000) fail('FX_FETCH');
  return body;
}

async function findTrackFxUrls(view) {
  const player = await view.associatedPlayer;
  const current = await player?.currentAudioTrack;
  let content = await current?.parentContentItem;
  if (!content) content = await (await current?.parentAudioTrack)?.parentContentItem;
  const feeds = await content?.feeds;
  if (!Array.isArray(feeds)) fail('FX_TRACK');
  const urls = new Set();
  let invalidResource = false;
  for (const feedValue of feeds.slice(0, 50)) {
    const feed = await feedValue, tracks = await feed?.audioTracks;
    if (!Array.isArray(tracks)) continue;
    for (const trackValue of tracks.slice(0, 50)) {
      const track = await trackValue;
      const name = await track?.name, language = await track?.language;
      if (!/^track\s*fx$/i.test(name || '') && !/^fx$/i.test(language || '')) continue;
      const streams = await track.streams;
      if (!Array.isArray(streams)) continue;
      for (const streamValue of streams.slice(0, 50)) {
        const stream = await streamValue, url = await stream?.url;
        if (!url) continue;
        try { urls.add(officialUrl(url)); }
        catch { invalidResource = true; }
        if (urls.size >= 50) return [...urls];
      }
    }
  }
  if (urls.size) return [...urls];
  fail(invalidResource ? 'FX_RESOURCE' : 'FX_TRACK');
}

/** Decode only this audio window; no second player, AudioContext capture, or VAD. */
async function encodePcmWindow({ buffers, segmentStart, segmentEnd, start, end }, signal) {
  const Context = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Context) fail('FX_DECODE');
  const size = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
  if (size > 24_000_000) fail('FX_FORMAT');
  const combined = new Uint8Array(size);
  let offset = 0;
  for (const buffer of buffers) { combined.set(new Uint8Array(buffer), offset); offset += buffer.byteLength; }
  if (signal.aborted) throw abortError();
  let decoded;
  try { decoded = await new Context(1, 1, SAMPLE_RATE).decodeAudioData(combined.buffer); }
  catch { fail('FX_DECODE'); }
  if (signal.aborted) throw abortError();
  if (Math.abs(decoded.duration - (segmentEnd - segmentStart)) > .35) fail('FX_DECODE_DURATION', {
    expectedSeconds: segmentEnd - segmentStart, actualSeconds: decoded.duration,
    differenceSeconds: Math.abs(decoded.duration - (segmentEnd - segmentStart))
  });
  const frameCount = Math.round((end - start) * SAMPLE_RATE);
  const offline = new Context(1, frameCount, SAMPLE_RATE);
  const source = offline.createBufferSource(); source.buffer = decoded;
  source.connect(offline.destination); source.start(0, Math.max(0, start - segmentStart), end - start);
  const mono = (await offline.startRendering()).getChannelData(0);
  if (signal.aborted) throw abortError();
  const bytes = new Uint8Array(mono.length * 2), data = new DataView(bytes.buffer);
  for (let i = 0; i < mono.length; i++) {
    const sample = Math.max(-1, Math.min(1, mono[i]));
    data.setInt16(i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

const STATUS_MESSAGES = {
  FX_TRACK: '当前节目未找到独立 Track FX 音轨', FX_RESOURCE: 'Track FX 资源未通过官方域名检查',
  FX_DRM: '当前 Track FX 受 DRM 保护，无法直接读取',
  FX_ENCRYPTED: '当前 Track FX 使用尚不支持的音频加密格式', FX_DISCONTINUITY: 'Track FX 时间轴不连续，已停止本轮识别',
  FX_SDK_CLOCK: '播放器未提供有效节目时间，暂不显示 Track FX 识别结果',
  FX_SDK_DURATION: '播放器未提供有效节目总时长，暂不能核对 Track FX 回放时间',
  FX_EVENT_TYPE: '播放器未提供受支持的回放或直播类型',
  FX_EVENT_CHANGED: '播放器节目类型已切换，正在重新读取 Track FX 时间',
  FX_LIVE_ORIGIN: '直播 SDK 的节目时间与墙上时钟边界未匹配，暂不显示 Track FX 识别结果',
  FX_LIVE_PDT: '直播音频缺少有效且连续的 PDT 时间锚点',
  FX_LIVE_ORIGIN_CHANGED: '识别期间直播时间锚点发生变化，已丢弃本轮结果',
  FX_VOD_DURATION: 'Track FX 回放总时长与播放器不一致', FX_DECODE_DURATION: 'Track FX 解码时长与音频分段不一致',
  FX_PLAYLIST: 'Track FX 音轨清单格式尚不支持',
  FX_FORMAT: 'Track FX 音频格式尚不支持', FX_DECODE: '浏览器无法解码此 Track FX 音频',
  FX_FETCH: 'Track FX 音频读取失败，稍后重试', FX_RESPONSE: 'Track FX 识别结果时间格式无效',
  ASR_NOT_CONFIGURED: '本地服务尚未配置语音识别；配置后请重新开启 TR',
  UNAUTHORIZED: '语音识别授权失败；处理后请重新开启 TR',
  ASR_AUTH_FAILED: '百炼 API 认证失败，请检查本机语音密钥配置',
  ASR_BALANCE: '百炼 API 返回额度或余额不足，请检查账户',
  ASR_UPSTREAM_FAILED: '百炼语音接口连接或请求失败，稍后重试',
  ASR_INVALID_RESPONSE: '百炼未返回有效的完整识别结果，稍后重试',
  ASR_BUSY: '语音识别服务繁忙，30 秒后重试', ASR_RATE_LIMITED: '语音识别服务限流，稍后重试',
  ASR_TIMEOUT: '语音识别服务超时', LOCAL_SERVICE_UNAVAILABLE: '本地语音识别服务不可用',
  ASR_CONNECT_TIMEOUT: '本机连接百炼超时', ASR_START_TIMEOUT: '百炼任务启动超时',
  ASR_SEND_TIMEOUT: '向百炼发送音频超时', ASR_FINISH_TIMEOUT: '音频已发送，等待百炼任务完成超时',
  ASR_CLIENT_TIMEOUT: '浏览器等待本机语音响应超时'
};

function clockDetails(error) {
  if (!['FX_VOD_DURATION', 'FX_DECODE_DURATION'].includes(error.code || error.message)) return undefined;
  const fields = ['expectedSeconds', 'actualSeconds', 'differenceSeconds'];
  if (!fields.every(key => Number.isFinite(error.details?.[key]))) return undefined;
  return Object.fromEntries(fields.map(key => [key, Number(error.details[key].toFixed(3))]));
}

function statusMessage(error) {
  const code = error.code || error.message;
  const message = STATUS_MESSAGES[code] || 'Track FX 识别暂时失败，30 秒后重试';
  const details = clockDetails(error);
  if (details) return `${message}：预期 ${details.expectedSeconds} 秒，实际 ${details.actualSeconds} 秒，相差 ${details.differenceSeconds} 秒`;
  const d = error.diagnostics;
  return d && Number.isFinite(d.elapsedMs) && Number.isFinite(d.sentAudioMs)
    ? `${message}（已发送 ${(d.sentAudioMs/1000).toFixed(1)} 秒音频；任务耗时 ${(d.elapsedMs/1000).toFixed(1)} 秒）` : message;
}

function validateWindowCue(cue, window) {
  if (cue?.final === false || cue?.isFinal === false) return null;
  if (typeof cue?.text !== 'string' || cue.text.length > 6000 || !Number.isFinite(cue.start) || !Number.isFinite(cue.end)
      || cue.start < window.start - .75 || cue.end > window.end + .75 || cue.end <= cue.start) fail('FX_RESPONSE');
  const text = cleanText(cue.text), start = Math.max(window.start, cue.start), end = Math.min(window.end, cue.end);
  return text && end > start ? { ...cue, text, start, end } : null;
}

export class TrackFxSource {
  constructor(view, { transcribe, onStatus = () => {}, onReset = () => {}, aheadSeconds = 60,
    windowSeconds = 30, overlapSeconds = 10, pollMs = 1000, timeoutMs = 90000,
    fetchText = (url, signal) => fetchResource(url, signal, false),
    fetchBytes = (url, signal) => fetchResource(url, signal, true), encodeAudio = encodePcmWindow } = {}) {
    if (typeof transcribe !== 'function') throw Error('TrackFxSource requires transcribe');
    if (!(windowSeconds > overlapSeconds && overlapSeconds >= 0 && windowSeconds <= 30 && aheadSeconds > 0 && aheadSeconds <= 120)) throw Error('Invalid Track FX windows');
    Object.assign(this, { view, transcribe, onStatus, onReset, aheadSeconds, windowSeconds, overlapSeconds, pollMs, timeoutMs, fetchText, fetchBytes, encodeAudio });
    this.completed = new Map(); this.binaryCache = new Map(); this.cues = []; this.seen = new Set();
    this.stopped = true; this.onCues = () => {}; this.failureCount = 0; this.retryAt = 0;
  }
  start(onCues) {
    if (!this.stopped) this.stop();
    this.onCues = onCues; this.stopped = false; this.observed = null;
    this.poll(); this.timer = setInterval(() => this.poll(), this.pollMs);
  }
  reset({ keepCache = false } = {}) {
    this.job?.controller.abort(); this.job = null; this.seen.clear();
    if (!keepCache) {
      this.retryAt = 0; this.failureCount = 0;
      this.completed.clear(); this.binaryCache.clear(); this.cues = []; this.playlist = null;
      this.url = null; this.identity = null; this.observed = null; this.discoveryKey = null;
    }
    this.onReset();
  }
  stop() {
    this.stopped = true; clearInterval(this.timer); this.reset();
  }
  active(job) { return !this.stopped && this.job === job && !job.controller.signal.aborted; }
  check(job) {
    if (!this.active(job)) throw abortError();
    const current = { time: tiledContentSeconds(this.view), at: Date.now() };
    if (!Number.isFinite(current.time)) fail('FX_SDK_CLOCK');
    if (isTrackFxSeek(this.observed, current, Number(this.view.playbackRate) || 1)) {
      this.reset({ keepCache: true }); this.observed = current; throw abortError();
    }
  }
  coversTime(time) { return !this.stopped && [...this.completed.values()].some(window => window.start <= time && time < window.end); }
  status(extra = {}) {
    const time = tiledContentSeconds(this.view);
    let end = time;
    for (const window of [...this.completed.values()].sort((a, b) => a.start - b.start)) {
      if (window.start <= end + .01 && window.end > end) end = window.end;
    }
    this.onStatus({ kind: 'track-fx', available: this.coversTime(time), contentTime: time,
      ahead: Math.max(0, end - time), completedWindows: this.completed.size, cueCount: this.cues.length, ...extra });
  }
  deliver(time) {
    const batch = this.cues.filter(cue => cue.end >= time - this.overlapSeconds
      && cue.start <= time + this.aheadSeconds + this.windowSeconds && !this.seen.has(cue.id));
    if (batch.length) this.onCues(batch);
    for (const cue of batch) this.seen.add(cue.id);
  }
  async bytes(url, job) {
    if (!this.binaryCache.has(url)) {
      const value = await this.fetchBytes(url, job.controller.signal); this.check(job);
      this.binaryCache.set(url, value);
      while (this.binaryCache.size > 40) this.binaryCache.delete(this.binaryCache.keys().next().value);
    }
    return this.binaryCache.get(url);
  }
  changeSource(identity) {
    this.completed.clear(); this.binaryCache.clear(); this.cues = []; this.seen.clear(); this.playlist = null;
    this.url = null; this.identity = identity; this.scope = identity ? hash(identity) : null;
    this.onReset();
  }
  // Both recognition paths use only streams offered by the current official SDK.
  // Discover on each poll so a changed programme/URL can leave an old backoff;
  // unchanged, unsupported manifests are only checked at the slower retry time.
  async loadPlaylist(job, clock, origin, checkMapped) {
    let urls, discoveryError;
    try { urls = await findTrackFxUrls(this.view); }
    catch (error) { discoveryError = error; urls = []; }
    checkMapped();
    const discoveryKey = `${clock.eventType}:${origin}:${[...urls].sort().join('\n')}:${discoveryError?.code || ''}`;
    if (this.discoveryKey !== discoveryKey) {
      this.discoveryKey = discoveryKey; this.playlist = null;
      if (Number.isFinite(this.retryAt)) { this.retryAt = 0; this.failureCount = 0; }
    }
    if (Date.now() < this.retryAt) return false;
    if (discoveryError) {
      if (this.identity || this.cues.length) this.changeSource(null);
      throw discoveryError;
    }
    const candidates = this.url && urls.includes(this.url) ? [this.url, ...urls.filter(url => url !== this.url)] : urls;
    const errors = [];
    for (const url of candidates) {
      const parsed = new URL(url), identity = `${clock.eventType}:${origin}:${parsed.origin}${parsed.pathname}`;
      const sameSource = this.identity === identity && this.url === url;
      const refreshMs = this.playlist ? Math.max(1000, this.playlist.targetDuration * 500) : 0;
      if (sameSource && this.playlist && (this.playlist.ended || Date.now() - this.manifestAt < refreshMs)) return true;
      let text;
      try { text = await this.fetchText(url, job.controller.signal); }
      catch (error) {
        checkMapped();
        errors.push(Object.assign(Error('FX_FETCH'), { code: 'FX_FETCH' }));
        continue;
      }
      checkMapped();
      let playlist;
      try {
        playlist = parseTrackFxPlaylist(text, url, { eventType: clock.eventType, origin, contentDuration: clock.contentDuration / 1000 });
        if (sameSource && this.playlist && playlist.discontinuitySequence !== this.playlist.discontinuitySequence) fail('FX_DISCONTINUITY');
      } catch (error) {
        if (!['FX_DRM', 'FX_ENCRYPTED', 'FX_FORMAT', 'FX_PLAYLIST', 'FX_DISCONTINUITY', 'FX_RESOURCE', 'FX_VOD_DURATION', 'FX_LIVE_PDT'].includes(error.code || error.message)) throw error;
        errors.push(error); continue;
      }
      if (this.identity !== identity) this.changeSource(identity);
      this.url = url; this.playlist = playlist; this.manifestAt = Date.now();
      return true;
    }
    if (this.identity || this.cues.length) this.changeSource(null);
    // A network failure may hide a usable alternative, so report that first.
    throw errors.find(error => error.code === 'FX_FETCH') || errors.find(error => error.code === 'FX_DRM') || errors[0];
  }
  scheduleRetry(code) {
    const unsupported = ['FX_DRM', 'FX_ENCRYPTED'].includes(code);
    this.retryAt = ['ASR_NOT_CONFIGURED', 'UNAUTHORIZED'].includes(code) ? Infinity
      : Date.now() + (unsupported ? 300000 : Math.min(120000, 30000 * 2 ** Math.min(2, this.failureCount - 1)));
    return unsupported ? ' · 每 5 分钟检查可用音源，换节目自动重新检查'
      : Number.isFinite(this.retryAt) ? ` · ${Math.ceil((this.retryAt - Date.now()) / 1000)} 秒后重试` : '';
  }
  async poll() {
    if (this.stopped) return;
    const now = { time: tiledContentSeconds(this.view), at: Date.now() };
    if (isTrackFxSeek(this.observed, now, Number(this.view.playbackRate) || 1)) this.reset({ keepCache: true });
    this.observed = now;
    if (this.job) return;
    const job = { controller: new AbortController() }; this.job = job;
    let timer;
    const armTimeout = () => { clearTimeout(timer); timer = setTimeout(() => { job.timedOut = true; job.controller.abort(); }, this.timeoutMs); };
    armTimeout();
    try {
      const clock = this.view.currentContentTime;
      const origin = clock?.eventType === 'live' ? tiledLiveOriginSeconds(this.view) : 0;
      if (!Number.isFinite(now.time)) fail('FX_SDK_CLOCK');
      if (!['vod', 'live'].includes(clock?.eventType)) fail('FX_EVENT_TYPE');
      if (!Number.isFinite(origin)) fail('FX_LIVE_ORIGIN');
      const eventType = clock.eventType;
      const checkMappedJob = () => {
        this.check(job);
        if (this.view.currentContentTime?.eventType !== eventType) fail('FX_EVENT_CHANGED');
        if (eventType === 'live') {
          const currentOrigin = tiledLiveOriginSeconds(this.view);
          if (!Number.isFinite(currentOrigin) || Math.abs(currentOrigin - origin) > .02) fail('FX_LIVE_ORIGIN_CHANGED');
        }
      };
      if (!await this.loadPlaylist(job, clock, origin, checkMappedJob)) return;
      const windows = planTrackFxWindows(this.playlist, now.time, this);
      this.deliver(now.time);
      for (const window of windows) {
        this.check(job);
        if (this.completed.has(window.key)) continue;
        job.window = window;
        // Recompute the neighbourhood after each request. A paused VOD never
        // drains the programme, and seeking cannot commit an old request.
        const current = tiledContentSeconds(this.view);
        if (window.end < current - this.overlapSeconds || window.start > current + this.aheadSeconds) continue;
        armTimeout();
        this.status({ processing: true, message: '正在连续识别 Track FX 音轨' });
        const selected = this.playlist.segments.filter(segment => segment.end > window.start + .0001 && segment.start < window.end - .0001);
        if (!selected.length) continue;
        const buffers = [await this.bytes(this.playlist.mapUrl, job)];
        for (const segment of selected) buffers.push(await this.bytes(segment.url, job));
        this.check(job);
        const audioBase64 = await this.encodeAudio({ buffers, segmentStart: selected[0].start,
          segmentEnd: selected.at(-1).end, start: window.start, end: window.end }, job.controller.signal);
        checkMappedJob();
        const streamed = [];
        let acceptingCues = true;
        const onCue = cue => {
          if (!acceptingCues || !this.active(job)) return;
          try {
            checkMappedJob();
            const finalCue = validateWindowCue(cue, window);
            if (!finalCue) return;
            if (streamed.length >= 200) fail('FX_RESPONSE');
            streamed.push(finalCue);
            // Only finalized sentences away from the right boundary are safe
            // to freeze before the whole request ends. Boundary candidates
            // remain in this window's cache for the established overlap rule.
            if (finalCue.end >= window.end - .4) return;
            this.cues = mergeTrackFxCues(this.cues, [finalCue], this.scope).cues;
            this.deliver(tiledContentSeconds(this.view));
            this.status({ processing: true, message: 'Track FX 已返回定稿句，正在继续识别' });
          } catch (error) {
            job.streamError = error; job.controller.abort();
          }
        };
        let result;
        try { result = await this.transcribe({ audioBase64, sampleRate: SAMPLE_RATE, start: window.start }, job.controller.signal, onCue); }
        finally { acceptingCues = false; }
        if (job.streamError) throw job.streamError;
        checkMappedJob();
        if (!Array.isArray(result?.cues) || result.cues.length > 200) fail('FX_RESPONSE');
        const incoming = [...result.cues, ...streamed].map(cue => validateWindowCue(cue, window)).filter(Boolean);
        this.completed.set(window.key, { ...window, rawCues: incoming,
          terminal: this.playlist.ended && window.end >= this.playlist.segments.at(-1).end - .001 });
        const ordered = [...this.completed.values()].sort((a, b) => a.start - b.start);
        const ready = ordered.filter(item => item.end > window.start && item.start < window.end)
          .flatMap(item => settleTrackFxWindowCues(item, ordered));
        this.cues = mergeTrackFxCues(this.cues, ready, this.scope).cues;
        this.failureCount = 0; this.retryAt = 0;
        while (this.completed.size > 600) this.completed.delete(this.completed.keys().next().value);
        if (this.cues.length > 6000) this.cues = this.cues.slice(-5000);
        if (this.seen.size > 8000) this.seen = new Set(this.cues.filter(cue => this.seen.has(cue.id)).map(cue => cue.id));
        this.deliver(tiledContentSeconds(this.view));
        this.status({ processing: false, usage: result.usage, message: 'Track FX 连续识别已接入' });
      }
      this.check(job);
      this.status({ processing: false, message: clock.eventType === 'live'
        ? 'Track FX 直播时间映射通过，等待可用音频窗口（实际直播效果待验证）' : 'Track FX 连续识别已接入' });
    } catch (error) {
      // Canceled/obsolete jobs cannot publish cues, errors, or reset newer jobs.
      if (this.stopped || this.job !== job) return;
      error = job.streamError || error;
      this.failureCount++;
      const errorCode = error.code || error.message;
      if (['FX_SDK_CLOCK', 'FX_SDK_DURATION', 'FX_VOD_DURATION', 'FX_DECODE_DURATION', 'FX_EVENT_TYPE',
        'FX_EVENT_CHANGED', 'FX_LIVE_ORIGIN', 'FX_LIVE_PDT', 'FX_LIVE_ORIGIN_CHANGED', 'FX_DISCONTINUITY'].includes(errorCode)) {
        this.completed.clear(); this.cues = []; this.seen.clear(); this.playlist = null; this.onReset();
      }
      const retryMessage = this.scheduleRetry(errorCode);
      this.status({ available: false, processing: false, errorCode: STATUS_MESSAGES[errorCode] ? errorCode : 'FX_FAILED',
        diagnostics: clockDetails(error) || error.diagnostics,
        message: (job.timedOut ? 'Track FX 音频读取、解码或识别总耗时超限' : statusMessage(error)).replace(/，(?:30 秒后|稍后)重试/g, '')
          + (job.window ? ` · 音频 ${Math.floor(job.window.start/60)}:${String(Math.floor(job.window.start%60)).padStart(2,'0')}` : '')
          + retryMessage });
    } finally {
      clearTimeout(timer); if (this.job === job) this.job = null;
    }
  }
}

// PCM transport chunks are contiguous. They are not subtitle boundaries: one
// upstream session retains speaker/utterance context across all of them.
export class TrackFxContinuousSource extends TrackFxSource {
  constructor(view, { client, isPaused = () => view.paused === true, ...options } = {}) {
    super(view, { ...options, transcribe: () => {}, overlapSeconds: 3 });
    if (!client?.open) throw Error('Continuous Track FX requires a radio client');
    this.client = client; this.isPaused = isPaused; this.generation = 0; this.cursor = null;
  }
  reset(options = {}) {
    this.generation++; this.connection?.session?.cancel(); this.connection?.controller.abort();
    this.connection = null; this.cursor = null;
    super.reset(options);
  }
  changeSource(identity) {
    this.generation++; this.connection?.session?.cancel(); this.connection?.controller.abort();
    this.connection = null; this.cursor = null;
    super.changeSource(identity);
  }
  status(extra = {}) {
    const time = tiledContentSeconds(this.view);
    super.status({ ...extra, direct: true, sentAhead: Math.max(0, (this.cursor ?? time) - time) });
  }
  async finishConnection(connection) {
    connection.finishing = true;
    await connection.session.finish();
    if (this.connection !== connection || this.stopped) throw abortError();
    this.completed.set(`${connection.start}:${connection.end}`, { start: connection.start, end: connection.end });
    while (this.completed.size > 600) this.completed.delete(this.completed.keys().next().value);
    this.connection = null;
  }
  async poll() {
    if (this.stopped) return;
    const now = { time: tiledContentSeconds(this.view), at: Date.now() };
    if (isTrackFxSeek(this.observed, now, Number(this.view.playbackRate) || 1)) this.reset({ keepCache: true });
    this.observed = now;
    if (this.job) return;
    const job = { controller: new AbortController() }; this.job = job;
    const timer = setTimeout(() => { job.timedOut = true; job.controller.abort(); }, this.timeoutMs);
    try {
      const clock = this.view.currentContentTime, eventType = clock?.eventType;
      const origin = eventType === 'live' ? tiledLiveOriginSeconds(this.view) : 0;
      if (!Number.isFinite(now.time)) fail('FX_SDK_CLOCK');
      if (!['vod', 'live'].includes(eventType)) fail('FX_EVENT_TYPE');
      if (!Number.isFinite(origin)) fail('FX_LIVE_ORIGIN');
      const checkMapped = () => {
        this.check(job);
        if (this.view.currentContentTime?.eventType !== eventType) fail('FX_EVENT_CHANGED');
        if (eventType === 'live') {
          const currentOrigin = tiledLiveOriginSeconds(this.view);
          if (!Number.isFinite(currentOrigin) || Math.abs(currentOrigin - origin) > .02) fail('FX_LIVE_ORIGIN_CHANGED');
        }
      };
      if (!await this.loadPlaylist(job, clock, origin, checkMapped)) return;
      this.deliver(now.time);
      const lower = Math.max(0, this.playlist.segments[0].start), upper = this.playlist.segments.at(-1).end;
      if (this.cursor === null) {
        this.cursor = Math.max(lower, now.time - 3);
        // Rewatch uses completed audio coverage and the original frozen cues.
        for (const span of [...this.completed.values()].sort((a,b)=>a.start-b.start)) {
          if (span.start <= Math.max(this.cursor, now.time) + .01 && span.end > this.cursor) this.cursor = span.end;
        }
      }
      if (this.cursor < lower - .01) fail('FX_DISCONTINUITY');
      if (this.connection?.error) throw this.connection.error;
      const horizon = Math.min(upper, now.time + this.aheadSeconds);
      const end = Math.min(this.cursor + 6, horizon, this.connection ? this.connection.start + 180 : Infinity);
      const terminal = this.playlist.ended && end >= upper - .001;
      if (end - this.cursor < .001 || (end - this.cursor < 6 - .001 && !terminal)) {
        if (this.connection && (this.isPaused() || terminal)) await this.finishConnection(this.connection);
        this.status({ processing: false, message: '连续中文同传已接入' }); return;
      }
      const start = this.cursor;
      const selected = this.playlist.segments.filter(s=>s.end > start + .0001 && s.start < end - .0001);
      const buffers = [await this.bytes(this.playlist.mapUrl, job)];
      for (const segment of selected) buffers.push(await this.bytes(segment.url, job));
      const audioBase64 = await this.encodeAudio({ buffers, segmentStart: selected[0].start,
        segmentEnd: selected.at(-1).end, start, end }, job.controller.signal);
      checkMapped();
      if (!this.connection) {
        const connection = { start, end: start, controller: new AbortController(), generation: this.generation };
        this.connection = connection;
        connection.session = await this.client.open({ start, signal: connection.controller.signal, onCue: raw => {
          if (this.stopped || this.connection !== connection || connection.generation !== this.generation) return;
          const current = { time: tiledContentSeconds(this.view), at: Date.now() };
          if (isTrackFxSeek(this.observed, current, Number(this.view.playbackRate) || 1)) { this.reset({ keepCache: true }); return; }
          try {
            const cue = validateWindowCue(raw, {start:connection.start,end:connection.end});
            if (!cue || typeof cue.zh !== 'string' || !cue.zh.trim() || cue.zh.length > 6000) fail('FX_RESPONSE');
            this.cues = mergeTrackFxCues(this.cues, [cue], this.scope).cues;
            if (this.cues.length > 6000) this.cues = this.cues.slice(-5000);
            if (this.seen.size > 8000) this.seen = new Set(this.cues.filter(c=>this.seen.has(c.id)).map(c=>c.id));
            this.deliver(current.time); this.status({ processing: true, message: '中文定稿已就绪' });
          } catch (error) { connection.error = error; connection.session?.cancel(); }
        } });
        connection.session.done.catch(error => {
          if (this.connection === connection && !this.stopped) connection.error ||= error;
        });
        checkMapped();
      }
      const connection = this.connection;
      connection.end = end;
      this.status({ processing: true, message: '正在连续识别并翻译 Track FX' });
      await connection.session.append({ audioBase64, sampleRate: SAMPLE_RATE, start });
      checkMapped();
      if (connection.error) throw connection.error;
      this.cursor = end; this.failureCount = 0; this.retryAt = 0;
      if (end - connection.start >= 180 - .001 || terminal) await this.finishConnection(connection);
      this.status({ processing: false, message: '连续中文同传已接入' });
    } catch (error) {
      if (this.stopped || this.job !== job) return;
      this.connection?.session?.cancel(); this.connection?.controller.abort(); this.connection = null; this.cursor = null;
      const code = error.code || error.message;
      if (['FX_SDK_CLOCK','FX_SDK_DURATION','FX_VOD_DURATION','FX_DECODE_DURATION','FX_EVENT_TYPE','FX_EVENT_CHANGED',
        'FX_LIVE_ORIGIN','FX_LIVE_PDT','FX_LIVE_ORIGIN_CHANGED','FX_DISCONTINUITY'].includes(code)) {
        this.completed.clear(); this.cues=[]; this.seen.clear(); this.playlist=null; this.onReset();
      }
      this.failureCount++;
      const retryMessage = this.scheduleRetry(code);
      this.status({ available:false, processing:false, errorCode:code,
        message: (job.timedOut ? '本轮音频处理超时' : statusMessage(error)).replace(/，(?:30 秒后|稍后)重试/g, '') + retryMessage });
    } finally { clearTimeout(timer); if (this.job === job) this.job = null; }
  }
}
