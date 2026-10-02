import { parseHlsLivePlaylist, parseWebVtt } from './hls-vtt.js';
import { tiledContentSeconds } from './tiledmedia-source.js';

const liveCaptionText = text => String(text || '').replace(/\s+/g, ' ').trim();

function liveCaptionResource(url) {
  const parsed = new URL(url);
  // Both hosts were supplied by the official SDK and their VTT clocks verified.
  const officialHost = /(^|\.)formula1\.com$/i.test(parsed.hostname)
    || parsed.hostname === 'f1prodlive.akamaized.net';
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !officialHost) throw Error('LIVE_RESOURCE');
  return parsed;
}

// The observed live VTT uses Unix seconds. The SDK's wallclock currentPosition
// ran ahead of the picture, so use corresponding seek/buffer bounds only to
// derive the origin; rendering still uses the SDK's content currentPosition.
export function tiledLiveOriginSeconds(view) {
  const content = view?.currentContentTime, wall = view?.currentWallclockTime;
  if (content?.eventType !== 'live' || wall?.eventType !== 'live' || !content.isWallclockTimeSourceBased) return NaN;
  const offsets = ['seekLowerBound', 'seekUpperBound', 'bufferLowerBound', 'bufferUpperBound']
    .filter(key => Number.isFinite(content[key]) && Number.isFinite(wall[key]))
    .map(key => wall[key] - content[key]);
  if (offsets.length < 2 || offsets[0] < 1e12 || offsets.some(value => Math.abs(value - offsets[0]) > 20)) return NaN;
  return offsets[0] / 1000;
}

export class TiledMediaLiveSource {
  constructor(view, { aheadSeconds = 45, fetchText, onStatus = () => {}, onReset = () => {}, getOfficialText = () => '', followLiveHead = () => true } = {}) {
    this.view = view; this.aheadSeconds = aheadSeconds; this.onStatus = onStatus; this.onReset = onReset;
    this.getOfficialText = getOfficialText; this.followLiveHead = followLiveHead;
    this.fetchText = fetchText || (async (url, signal) => {
      // Restrict every resource, including relative URLs resolved by the parser.
      liveCaptionResource(url);
      const response = await fetch(url, { signal, credentials: 'omit', redirect: 'error', cache: 'no-store' });
      if (!response.ok) throw Error('LIVE_FETCH');
      const text = await response.text();
      if (text.length > 2_000_000) throw Error('LIVE_FETCH');
      return text;
    });
    this.cache = new Map(); this.seen = new Set(); this.coverage = []; this.matches = new Set();
    this.stopped = true; this.busy = false; this.validated = false; this.epoch = 0; this.onCues = () => {};
  }
  start(onCues) {
    this.onCues = onCues; this.stopped = false; this.poll();
    this.timer = setInterval(() => this.poll(), 2000);
  }
  reset() {
    this.cache.clear(); this.seen.clear(); this.coverage = []; this.matches.clear();
    this.validated = false; this.playlist = null; this.manifestAt = 0;
    this.lastHead = null; this.discontinuity = null; this.epoch++; this.onReset();
  }
  coversTime(time) {
    return !this.stopped && this.validated && Number.isFinite(time) && this.coverage.some(([start, end]) => start <= time && time < end);
  }
  async poll() {
    if (this.stopped || this.busy) return;
    this.busy = true;
    const controller = new AbortController(); this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const origin = tiledLiveOriginSeconds(this.view);
      if (!Number.isFinite(origin)) throw Error('LIVE_CLOCK');
      const player = this.view.associatedPlayer, stream = player?.currentSubtitleTrack;
      if (!stream || player.desiredSubtitleTrackSelection?.disable) throw Error('LIVE_ENGLISH');
      const track = await stream.parentSubtitleTrack;
      if (!/^en(?:g)?(?:-|$)/i.test(await track.language || '')) throw Error('LIVE_ENGLISH');
      const url = await stream.url;
      liveCaptionResource(url);
      if (this.stopped) return;
      if (url !== this.url || !Number.isFinite(this.origin) || Math.abs(origin - this.origin) > .02) {
        this.reset(); this.url = url; this.origin = origin;
      }
      let refreshed = false;
      // Reload an unfinished manifest independently of playback, no faster than
      // half its target duration. Raw segment URLs never leave this page.
      const interval = this.playlist ? Math.max(1000, this.playlist.targetDuration * 500) : 0;
      if (!this.playlist || (!this.playlist.ended && Date.now() - this.manifestAt >= interval)) {
        const playlist = parseHlsLivePlaylist(await this.fetchText(url, controller.signal), url);
        if (this.stopped) return;
        if (this.discontinuity !== null && this.discontinuity !== playlist.discontinuitySequence) {
          this.reset(); throw Error('LIVE_DISCONTINUITY');
        }
        this.discontinuity = playlist.discontinuitySequence;
        this.playlist = playlist; this.manifestAt = Date.now(); refreshed = true;
      }
      const time = tiledContentSeconds(this.view), absolute = time + this.origin;
      if (!Number.isFinite(absolute)) throw Error('LIVE_CLOCK');
      const segments = this.playlist.segments;
      const recent = this.lastHead === null ? segments.slice(-2) : segments.filter(s => s.sequence > this.lastHead).slice(-20);
      // Follow the live head unless the controller limits preparation to the
      // viewer's neighbourhood while paused.
      const head = new Set(this.followLiveHead() ? [...recent, ...segments.slice(-2)].map(s => s.sequence) : []);
      const wanted = segments.filter(s => head.has(s.sequence) || (s.end >= absolute - 12 && s.start <= absolute + this.aheadSeconds));
      for (const segment of wanted) {
        if (this.stopped) return;
        if (!this.cache.has(segment.sequence) || (refreshed && head.has(segment.sequence))) {
          const cues = parseWebVtt(await this.fetchText(segment.url, controller.signal), { epoch: `live-${this.epoch}` });
          if (this.stopped) return;
          // Reject cue clocks unrelated to this live segment. Observed VTT
          // overlaps adjacent segments by several seconds, hence the tolerance.
          if (cues.some(c => c.end < segment.start - 120 || c.start > segment.end + 120)) throw Error('LIVE_CLOCK');
          this.cache.set(segment.sequence, cues);
        }
      }
      if (this.stopped) return;
      if (Math.abs(tiledLiveOriginSeconds(this.view) - this.origin) > .02 || !Number.isFinite(tiledLiveOriginSeconds(this.view))) throw Error('LIVE_CLOCK');
      // A repeated live cue may be present in several files. Prefer the latest
      // fetched version before first delivery; freeze it once delivered.
      const raw = [...new Map(wanted.flatMap(s => this.cache.get(s.sequence) || []).map(c => [Math.round(c.start * 1000), c])).values()];
      const cues = raw.map(c => ({ id: `live-${this.epoch}:${Math.round(c.start * 1000)}`,
        start: c.start - this.origin, end: c.end - this.origin, text: c.text }));
      const now = tiledContentSeconds(this.view);
      if (!this.validated) {
        const official = liveCaptionText(this.getOfficialText());
        const active = cues.filter(c => c.start <= now && now < c.end);
        if (official && (active.some(c => liveCaptionText(c.text) === official) || liveCaptionText(active.map(c => c.text).join(' ')) === official)) {
          this.matches.add(active.map(c => c.id).join('|'));
        }
        this.validated = this.matches.size >= 2;
      }
      if (!this.validated) {
        this.onStatus({ available: false, kind: 'tiled-live', message: `已读到直播字幕，核对官方英文与画面时间（${this.matches.size}/2）` }); return;
      }
      const batch = cues.filter(c => c.start >= 0 && c.end >= now - 12 && !this.seen.has(c.id));
      if (batch.length) this.onCues(batch);
      batch.forEach(c => this.seen.add(c.id));
      this.coverage = wanted.map(s => [Math.max(s.start - this.origin, now - 12), s.end - this.origin]);
      this.lastHead = segments.at(-1).sequence;
      const end = cues.reduce((max, c) => Math.max(max, c.end), now);
      this.onStatus({ available: true, kind: 'tiled-live', cueCount: this.seen.size, ahead: end - now, contentTime: now });
      const keep = new Set(wanted.map(s => s.sequence));
      if (this.cache.size > 160) for (const key of this.cache.keys()) { if (!keep.has(key)) this.cache.delete(key); if (this.cache.size <= 100) break; }
      while (this.seen.size > 16000) this.seen.delete(this.seen.values().next().value);
    } catch (error) {
      this.validated = false; this.matches.clear(); this.coverage = [];
      const messages = {
        LIVE_CLOCK: '直播字幕时钟尚未匹配，保留官方英文',
        LIVE_ENGLISH: '请先在官网字幕菜单选择英文',
        LIVE_RESOURCE: '直播字幕资源未通过官方域名检查',
        LIVE_DISCONTINUITY: '直播时间轴发生切换，正在重新校准'
      };
      if (!this.stopped) this.onStatus({ available: false, kind: 'tiled-live', message: controller.signal.aborted ? '直播字幕读取超时，保留官方英文' : messages[error.message] || '直播字幕读取或格式验证失败，保留官方英文' });
    } finally { clearTimeout(timeout); this.busy = false; }
  }
  stop() { this.stopped = true; clearInterval(this.timer); this.controller?.abort(); this.cache.clear(); this.coverage = []; this.seen.clear(); }
}
