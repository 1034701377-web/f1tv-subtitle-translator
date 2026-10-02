// ==UserScript==
// @name         F1 TV 字幕翻译
// @namespace    https://github.com/1034701377-web/f1tv-subtitle-translator
// @version      0.8.0
// @description  将 F1 TV 官方英文解说字幕提前翻译为简体中文，按观看时间显示。
// @homepageURL  https://github.com/1034701377-web/f1tv-subtitle-translator
// @downloadURL  https://raw.githubusercontent.com/1034701377-web/f1tv-subtitle-translator/main/dist/f1tv-zh.user.js
// @updateURL    https://raw.githubusercontent.com/1034701377-web/f1tv-subtitle-translator/main/dist/f1tv-zh.user.js
// @match        https://f1tv.formula1.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      127.0.0.1
// @noframes
// ==/UserScript==

(() => {
'use strict';
// src/core.js
// Cue times and rendering use the same chosen programme clock, never API return time.
class CueStore {
  constructor({ maxCues = 12000 } = {}) {
    this.maxCues = maxCues;
    this.cues = new Map();
    this.version = 0;
  }
  add(raw) {
    if (!raw || !Number.isFinite(raw.start) || !Number.isFinite(raw.end) || raw.start < 0 || raw.end <= raw.start || typeof raw.text !== 'string' || !raw.text.trim()) return null;
    const id = String(raw.id ?? `${raw.start}:${raw.end}:${raw.text}`);
    const existing = this.cues.get(id);
    // Sources must create a new epoch/id for a timeline discontinuity. Same id edits
    // are ignored to keep both the translation and an already-reading viewer stable.
    if (existing) return null;
    const zh = typeof raw.zh === 'string' && raw.zh.length <= 4000 && /\p{Script=Han}/u.test(raw.zh) ? raw.zh.trim() : null;
    const cue = { id, start: raw.start, end: raw.end, text: raw.text.trim().slice(0, 4000), status: zh ? 'ready' : 'queued', zh };
    if (Number.isInteger(raw.speaker) && raw.speaker >= 0 && raw.speaker <= 1000000) cue.speaker = raw.speaker;
    this.cues.set(id, cue);
    while (this.cues.size > this.maxCues) {
      const oldest = [...this.cues.values()].reduce((a, b) => a.start < b.start ? a : b);
      this.cues.delete(oldest.id);
    }
    this.version++;
    return cue;
  }
  sorted() {
    if (this.sortedVersion !== this.version) {
      this.ordered = [...this.cues.values()].sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
      this.sortedVersion = this.version;
    }
    return this.ordered;
  }
  at(time) { return this.sorted().filter(c => c.start <= time && time < c.end); }
  context(cue) {
    const all = this.sorted();
    const i = all.findIndex(c => c.id === cue.id);
    if (i < 0) return [];
    const context = [];
    // Stop at a long silence/jump instead of treating unrelated cached speech as a continuation.
    for (const direction of [-1, 1]) {
      let previous = cue;
      for (let distance = 1; distance <= 2; distance++) {
        const other = all[i + direction * distance];
        if (!other || Math.abs(other.start - cue.start) > 20) break;
        const gap = direction < 0 ? previous.start - other.end : other.start - previous.end;
        if (gap > 4) break;
        const entry = { text: other.text, start: other.start, end: other.end, position: direction < 0 ? 'before' : 'after' };
        if (direction < 0) context.unshift(entry); else context.push(entry);
        previous = other;
      }
    }
    return context;
  }
  clear() { this.cues.clear(); this.version++; }
}

// A conservative punctuation hint, not a grammar parser. Abbreviations/ellipsis
// are not proof of completion; the bounded wait always wins if no ending arrives.
function hasSentenceEnd(text) {
  const tail = text.trim().replace(/["'”’\])]+$/u, '');
  return /[!?。！？]$/u.test(tail) || (/\.$/u.test(tail) && !/(?:\.{2,}|\b(?:Mr|Mrs|Ms|Dr|St|vs|e\.g|i\.e)|\b[A-Z])\.$/iu.test(tail));
}

class TranslationQueue {
  constructor(store, translate, { concurrency = 3, timeoutMs = 12000, maxPending = 600,
    contextWaitMs = 3000, getTime = () => NaN, now = () => performance.now(), onReady = () => {} } = {}) {
    this.store = store; this.translate = translate;
    this.concurrency = concurrency; this.timeoutMs = timeoutMs; this.maxPending = maxPending;
    this.pending = []; this.active = new Map(); this.generation = 0; this.stopped = false;
    this.contextWaitMs = contextWaitMs; this.getTime = getTime; this.now = now;
    this.onReady = onReady;
    this.arrived = new WeakMap(); this.contextTimer = null;
  }
  ingest(raw) { return this.ingestMany([raw])[0] ?? null; }
  ingestMany(raws) {
    const added = raws.map(raw => this.store.add(raw)).filter(Boolean);
    for (const cue of added) {
      if (cue.status === 'ready') { this.notifyReady(cue); continue; }
      if (this.pending.length >= this.maxPending) { cue.status = 'failed'; cue.error = 'queue_full'; }
      else { this.arrived.set(cue, this.now()); this.pending.push(cue); }
    }
    this.pump(); return added;
  }
  notifyReady(cue) { try { this.onReady(cue); } catch {} }
  contextWait(cue) {
    const time = this.getTime();
    // No known clock, an imminent/rewound cue, or a complete sentence: translate now.
    if (!Number.isFinite(time) || hasSentenceEnd(cue.text)) return 0;
    const after = this.store.context(cue).filter(c => c.position === 'after');
    if (after.length >= 2 || after.some(c => hasSentenceEnd(c.text))) return 0;
    return Math.max(0, Math.min(this.contextWaitMs - (this.now() - this.arrived.get(cue)), (cue.start - time - 10) * 1000));
  }
  pump() {
    clearTimeout(this.contextTimer); this.contextTimer = null;
    while (!this.stopped && this.active.size < this.concurrency && this.pending.length) {
      this.pending = this.pending.filter(c => this.store.cues.get(c.id) === c);
      let next = -1, wait = Infinity;
      // A fragment waiting for its ending must not block an unrelated ready sentence.
      for (let i = 0; i < this.pending.length; i++) {
        const remaining = this.contextWait(this.pending[i]);
        if (remaining <= 0) { next = i; break; }
        wait = Math.min(wait, remaining);
      }
      if (next < 0) {
        if (Number.isFinite(wait)) this.contextTimer = setTimeout(() => this.pump(), Math.max(1, Math.ceil(wait)));
        break;
      }
      const [cue] = this.pending.splice(next, 1);
      const generation = this.generation;
      const controller = new AbortController();
      const job = { controller };
      this.active.set(cue, job); cue.status = 'pending';
      let timer;
      const timed = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, this.timeoutMs);
      });
      Promise.race([
        Promise.resolve().then(() => this.translate(cue, this.store.context(cue), controller.signal)), timed
      ]).then(result => {
        if (generation !== this.generation || this.store.cues.get(cue.id) !== cue) return;
        const text = typeof result === 'string' ? result : result?.text;
        if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw new Error('invalid_translation');
        cue.zh = text.trim(); cue.status = 'ready';
        this.notifyReady(cue);
      }).catch(() => {
        if (generation === this.generation && this.store.cues.get(cue.id) === cue) { cue.status = 'failed'; cue.error = 'translation_unavailable'; }
      }).finally(() => { clearTimeout(timer); this.active.delete(cue); this.pump(); });
    }
  }
  reset() {
    this.generation++;
    clearTimeout(this.contextTimer); this.contextTimer = null;
    for (const {controller} of this.active.values()) controller.abort();
    this.active.clear(); this.pending.length = 0; this.store.clear();
  }
  dispose() { this.stopped = true; this.reset(); }
}

// Freeze each cue on entry. A late result is cached, but cannot replace a sentence
// mid-read. Seek starts a new visit, so cached Chinese becomes usable on replay.
class SubtitleTimeline {
  constructor(store, { exclusive = false, suppress = () => false } = {}) {
    this.store = store; this.visits = new Map(); this.enabled = false;
    this.exclusive = Boolean(exclusive); this.suppress = suppress;
  }
  setEnabled(value) { this.enabled = Boolean(value); this.seek(); }
  seek() { this.visits.clear(); }
  render(time) {
    if (!this.enabled || !Number.isFinite(time)) return { lines: [], text: '', hasEnglish: false };
    const active = this.store.at(time);
    const ids = new Set(active.map(c => c.id));
    for (const id of this.visits.keys()) if (!ids.has(id)) this.visits.delete(id);
    // Select before suppression: hiding a duplicate answer must not reveal an
    // older overlapping question underneath it.
    const selected = this.exclusive ? active.slice(-1) : active;
    const lines = selected.flatMap(cue => {
      if (!this.visits.has(cue.id)) this.visits.set(cue.id, {
        suppressed: Boolean(this.suppress(cue)),
        line: { id: cue.id, text: cue.zh || cue.text, language: cue.zh ? 'zh' : 'en' },
      });
      const visit = this.visits.get(cue.id);
      return visit.suppressed ? [] : [visit.line];
    });
    return { lines, text: lines.map(l => l.text).join('\n'), hasEnglish: lines.some(l => l.language === 'en') };
  }
}

// Compare source speech, never translations or arrival time. Ordered word
// overlap tolerates small recognition differences without suppressing an entire
// second channel merely because both channels are speaking at the same time.
function sameSpeech(a, b) {
  if (![a?.start, a?.end, b?.start, b?.end].every(Number.isFinite) ||
      Math.max(a.start, b.start) >= Math.min(a.end, b.end) ||
      typeof a.text !== 'string' || typeof b.text !== 'string') return false;
  const words = text => text.toLowerCase().replace(/’/g, "'").match(/[a-z]+(?:'[a-z]+)*/g) ?? [];
  let short = words(a.text), long = words(b.text);
  if (short.length > long.length) [short, long] = [long, short];
  if (short.length < 4 || long.length > 1000) return false;
  // Longest common subsequence: repeated words cannot be counted twice, and
  // reversed word order is not accepted as an equivalent utterance.
  const previous = new Uint16Array(short.length + 1);
  for (const word of long) {
    let diagonal = 0;
    for (let i = 1; i <= short.length; i++) {
      const old = previous[i];
      previous[i] = word === short[i - 1] ? diagonal + 1 : Math.max(previous[i], previous[i - 1]);
      diagonal = old;
    }
  }
  return previous[short.length] / short.length >= .75;
}

// src/sources.js
class SimulatedSource {
  constructor(cues, { leadSeconds = 30, now = () => performance.now() / 1000 } = {}) {
    this.cues = cues; this.leadSeconds = leadSeconds; this.now = now;
    this.sent = new Set(); this.startedAt = this.now(); this.onCues = () => {};
  }
  get head() { return this.leadSeconds + this.now() - this.startedAt; }
  poll() {
    const available = this.cues.filter(c => c.end <= this.head && !this.sent.has(c.id));
    available.forEach(c => this.sent.add(c.id));
    if (available.length) this.onCues(available);
  }
  start(onCues) { this.onCues = onCues; this.poll(); this.timer = setInterval(() => this.poll(), 200); }
  stop() { clearInterval(this.timer); }
}

// Safest initial F1 adapter: inspect ALL loaded cues, not only activeCues.
// A player may stop downloading captions when paused. Polling cannot fix that.
// A future manifest/segment adapter can implement the same start/stop contract.
function nativeCueHash(text) {
  let a = 2166136261, b = 5381;
  for (const char of text) { a = Math.imul(a ^ char.charCodeAt(0), 16777619); b = Math.imul(b, 33) ^ char.charCodeAt(0); }
  return `${a >>> 0}-${b >>> 0}`;
}
class TextTrackSource {
  constructor(video, { horizonSeconds = 180, epoch = 'native', onStatus = () => {}, onReset = () => {} } = {}) {
    this.video = video; this.horizonSeconds = horizonSeconds; this.epoch = epoch;
    this.onStatus = onStatus; this.onReset = onReset; this.track = null; this.onCues = () => {};
    this.seen = new Set(); this.trackIds = new WeakMap(); this.nextTrackId = 1; this.cueIds = new WeakMap();
    this.originalMode = null;
  }
  chooseTrack() {
    return Array.from(this.video.textTracks || []).find(t =>
      ['subtitles', 'captions'].includes(t.kind) &&
      (/^en(?:-|$)/i.test(t.language) || /english/i.test(t.label))
    ) || null;
  }
  releaseTrack() {
    if (this.track && this.originalMode !== null) this.track.mode = this.originalMode;
    this.originalMode = null; this.track = null;
  }
  poll() {
    const selected = this.chooseTrack();
    if (selected !== this.track) {
      this.onReset(); this.seen.clear();
      this.releaseTrack(); this.track = selected;
      if (selected) { this.originalMode = selected.mode; selected.mode = 'hidden'; }
    }
    const list = Array.from(this.track?.cues || []);
    const time = this.video.currentTime;
    if (this.track && !this.trackIds.has(this.track)) this.trackIds.set(this.track, this.nextTrackId++);
    const batch = [];
    for (const c of list) {
      if (c.startTime > time + this.horizonSeconds) continue;
      const text = c.text?.replace(/<[^>]*>/g, '').trim();
      if (!this.cueIds.has(c)) this.cueIds.set(c, `${this.epoch}:${this.trackIds.get(this.track)}:${c.startTime}:${c.endTime}:${nativeCueHash(text || '')}`);
      const id = this.cueIds.get(c);
      if (!text || this.seen.has(id)) continue;
      this.seen.add(id); batch.push({ id, start: c.startTime, end: c.endTime, text });
    }
    if (batch.length) this.onCues(batch);
    this.onStatus({ available: Boolean(this.track), cueCount: list.length,
      ahead: list.length ? list.reduce((end, c) => Math.max(end, c.endTime), 0) - time : null,
      nativeHidden: this.track?.mode === 'hidden' });
  }
  start(onCues) { this.onCues = onCues; this.poll(); this.timer = setInterval(() => this.poll(), 250); }
  stop() { clearInterval(this.timer); this.releaseTrack(); this.seen.clear(); }
}

// Contract for a later HLS/DASH adapter. It must independently fetch caption
// segments AND map their timestamps into this video's currentTime domain.
// Refuse unmapped times instead of guessing a 30s offset.
class MappedCueSource {
  constructor(mapTime) { this.mapTime = mapTime; this.onCues = null; }
  start(onCues) { this.onCues = onCues; }
  push(cues, metadata) {
    const mapped = cues.map(c => ({ ...c,
      id: `${metadata.epoch}:${c.id}`,
      start: this.mapTime(c.start, metadata), end: this.mapTime(c.end, metadata) }));
    if (mapped.some(c => !Number.isFinite(c.start) || !Number.isFinite(c.end) || c.start < 0 || c.end <= c.start)) throw new Error('Unverified subtitle time mapping');
    this.onCues?.(mapped);
  }
  stop() { this.onCues = null; }
}

// src/hls-vtt.js
const MAX_PLAYLIST_CHARS = 8_000_000;
const MAX_SEGMENTS = 20_000;
const MAX_VTT_CHARS = 2_000_000;
const MAX_CUES = 20_000;
const MAX_CUE_CHARS = 20_000;

function boundedText(value, maximum, label) {
  if (typeof value !== 'string' || value.length > maximum) {
    throw new Error(`${label} must be text within ${maximum} characters`);
  }
  return value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

function httpUrl(value, base) {
  let url;
  try {
    url = new URL(value, base);
  } catch {
    throw new Error('Invalid HLS URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('HLS URLs must use HTTP(S) without embedded credentials');
  }
  return url.href;
}

function unsignedInteger(value, label) {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`Invalid ${label}`);
  }
  return Number(value);
}

/** Parse a complete, unencrypted HLS subtitle media playlist. Times are seconds. */
function parseHlsVodPlaylist(text, baseUrl) {
  const lines = boundedText(text, MAX_PLAYLIST_CHARS, 'HLS playlist').split('\n');
  const base = httpUrl(baseUrl);
  if (lines.shift()?.trim() !== '#EXTM3U') throw new Error('Missing HLS EXTM3U header');

  const segments = [];
  let duration = 0;
  let nextDuration = null;
  let firstSequence = 0;
  let sawSequence = false;
  let sawType = false;
  let ended = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      // Ordinary comments have no playlist semantics.
      if (!line.startsWith('#EXT')) continue;
      if (ended) throw new Error('HLS tags after ENDLIST are unsupported');
      if (line === '#EXT-X-ENDLIST') {
        if (nextDuration !== null) throw new Error('HLS segment URI missing');
        ended = true;
      } else if (line.startsWith('#EXTINF:')) {
        if (nextDuration !== null) throw new Error('HLS segment URI missing');
        const match = /^#EXTINF:(\d+(?:\.\d+)?),.*$/.exec(line);
        const value = match && Number(match[1]);
        if (!Number.isFinite(value) || value <= 0) throw new Error('Invalid HLS segment duration');
        nextDuration = value;
      } else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
        if (sawType || line !== '#EXT-X-PLAYLIST-TYPE:VOD') {
          throw new Error('Only complete HLS VOD playlists are supported');
        }
        sawType = true;
      } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        if (sawSequence || segments.length || nextDuration !== null) {
          throw new Error('Invalid HLS media sequence placement');
        }
        firstSequence = unsignedInteger(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length), 'HLS media sequence');
        sawSequence = true;
      } else if (line.startsWith('#EXT-X-VERSION:')) {
        if (unsignedInteger(line.slice('#EXT-X-VERSION:'.length), 'HLS version') < 1) {
          throw new Error('Invalid HLS version');
        }
      } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
        if (unsignedInteger(line.slice('#EXT-X-TARGETDURATION:'.length), 'HLS target duration') < 1) {
          throw new Error('Invalid HLS target duration');
        }
      } else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
        if (!Number.isFinite(Date.parse(line.slice('#EXT-X-PROGRAM-DATE-TIME:'.length)))) {
          throw new Error('Invalid HLS program date time');
        }
        // This wall-clock metadata is not a cue-time offset.
      } else if (/^#EXT-X-ALLOW-CACHE:(?:YES|NO)$/.test(line)
          || line === '#EXT-X-INDEPENDENT-SEGMENTS') {
        // Neither tag changes subtitle segment addressing or timestamps.
      } else {
        const tag = line.split(':', 1)[0];
        throw new Error(`Unsupported HLS tag: ${tag}`);
      }
      continue;
    }

    if (ended) throw new Error('HLS segment after ENDLIST');
    if (nextDuration === null) throw new Error('HLS segment requires EXTINF');
    if (segments.length >= MAX_SEGMENTS || line.length > 32_768) {
      throw new Error('HLS segment limit exceeded');
    }
    const end = duration + nextDuration;
    const sequence = firstSequence + segments.length;
    if (!Number.isFinite(end) || end <= duration || !Number.isSafeInteger(sequence)) {
      throw new Error('Invalid HLS timeline');
    }
    segments.push({ url: httpUrl(line, base), start: duration, end, sequence });
    duration = end;
    nextDuration = null;
  }
  if (!ended) throw new Error('Only complete HLS VOD playlists with ENDLIST are supported');
  if (!segments.length) throw new Error('HLS playlist contains no segments');
  return { segments, duration };
}

/** Parse a continuous, unencrypted live/EVENT playlist into Unix-second times. */
function parseHlsLivePlaylist(text, baseUrl) {
  const lines = boundedText(text, MAX_PLAYLIST_CHARS, 'HLS playlist').split('\n');
  const base = httpUrl(baseUrl);
  if (lines.shift()?.trim() !== '#EXTM3U') throw new Error('Missing HLS EXTM3U header');

  const segments = [];
  const anchors = [];
  let durationMs = 0;
  let nextDuration = null;
  let nextDate = null;
  let firstSequence = 0;
  let sawSequence = false;
  let sawType = false;
  let sawDiscontinuitySequence = false;
  let targetDuration = null;
  let discontinuitySequence = 0;
  let ended = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      if (!line.startsWith('#EXT')) continue;
      if (ended) throw new Error('HLS tags after ENDLIST are unsupported');
      if (line === '#EXT-X-ENDLIST') {
        if (nextDuration !== null || nextDate !== null) throw new Error('HLS segment URI missing');
        ended = true;
      } else if (line.startsWith('#EXTINF:')) {
        if (nextDuration !== null) throw new Error('HLS segment URI missing');
        const match = /^#EXTINF:(\d+(?:\.\d+)?),.*$/.exec(line);
        const value = match && Number(match[1]);
        if (!Number.isFinite(value) || value <= 0) throw new Error('Invalid HLS segment duration');
        nextDuration = value * 1000;
      } else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
        if (sawType || line !== '#EXT-X-PLAYLIST-TYPE:EVENT') {
          throw new Error('Only live or EVENT HLS playlists are supported');
        }
        sawType = true;
      } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        if (sawSequence || segments.length || nextDuration !== null) {
          throw new Error('Invalid HLS media sequence placement');
        }
        firstSequence = unsignedInteger(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length), 'HLS media sequence');
        sawSequence = true;
      } else if (line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')) {
        if (sawDiscontinuitySequence || segments.length || nextDuration !== null) {
          throw new Error('Invalid HLS discontinuity sequence placement');
        }
        discontinuitySequence = unsignedInteger(line.slice('#EXT-X-DISCONTINUITY-SEQUENCE:'.length), 'HLS discontinuity sequence');
        sawDiscontinuitySequence = true;
      } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
        if (targetDuration !== null) throw new Error('Duplicate HLS target duration');
        targetDuration = unsignedInteger(line.slice('#EXT-X-TARGETDURATION:'.length), 'HLS target duration');
        if (targetDuration < 1) throw new Error('Invalid HLS target duration');
      } else if (line.startsWith('#EXT-X-VERSION:')) {
        if (unsignedInteger(line.slice('#EXT-X-VERSION:'.length), 'HLS version') < 1) {
          throw new Error('Invalid HLS version');
        }
      } else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
        const value = Date.parse(line.slice('#EXT-X-PROGRAM-DATE-TIME:'.length));
        if (nextDate !== null || !Number.isFinite(value)) throw new Error('Invalid HLS program date time');
        nextDate = value;
      } else if (line !== '#EXT-X-INDEPENDENT-SEGMENTS') {
        throw new Error(`Unsupported HLS tag: ${line.split(':', 1)[0]}`);
      }
      continue;
    }

    if (ended) throw new Error('HLS segment after ENDLIST');
    if (nextDuration === null) throw new Error('HLS segment requires EXTINF');
    if (segments.length >= MAX_SEGMENTS || line.length > 32_768) throw new Error('HLS segment limit exceeded');
    const end = durationMs + nextDuration;
    const sequence = firstSequence + segments.length;
    if (!Number.isFinite(end) || end <= durationMs || !Number.isSafeInteger(sequence)) {
      throw new Error('Invalid HLS timeline');
    }
    if (nextDate !== null) anchors.push({ date: nextDate, offset: durationMs });
    segments.push({ url: httpUrl(line, base), start: durationMs, end, sequence });
    durationMs = end;
    nextDuration = null;
    nextDate = null;
  }

  if (nextDuration !== null || nextDate !== null) throw new Error('HLS segment URI missing');
  if (!segments.length) throw new Error('HLS playlist contains no segments');
  if (targetDuration === null) throw new Error('Missing HLS target duration');
  if (!anchors.length) throw new Error('Missing HLS program date time anchor');
  const first = anchors[0];
  for (const anchor of anchors) {
    // Compare relative milliseconds; allow only floating-point accumulation noise.
    if (Math.abs((anchor.date - first.date) - (anchor.offset - first.offset)) > 0.001) {
      throw new Error('Discontinuous HLS program date time');
    }
  }
  const origin = first.date - first.offset;
  for (const segment of segments) {
    segment.start = (origin + segment.start) / 1000;
    segment.end = (origin + segment.end) / 1000;
    if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.end <= segment.start) {
      throw new Error('Invalid HLS absolute timeline');
    }
  }
  return { segments, duration: durationMs / 1000, targetDuration, discontinuitySequence, ended };
}

function timestampMs(value) {
  const match = /^(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})$/.exec(value);
  if (!match || Number(match[2]) >= 60 || Number(match[3]) >= 60) {
    throw new Error('Invalid WebVTT timestamp');
  }
  const result = (Number(match[1] || 0) * 3600 + Number(match[2]) * 60
    + Number(match[3])) * 1000 + Number(match[4]);
  if (!Number.isSafeInteger(result)) throw new Error('Invalid WebVTT timestamp');
  return result;
}

function verifyTimestampMap(line) {
  const match = /^X-TIMESTAMP-MAP\s*=\s*(.+)$/.exec(line);
  try {
    if (!match) throw new Error('Missing mapping');
    const values = new Map();
    for (const field of match[1].split(',')) {
      const part = /^(LOCAL|MPEGTS):(.+)$/.exec(field.trim());
      if (!part || values.has(part[1])) throw new Error('Invalid mapping');
      values.set(part[1], part[2]);
    }
    if (values.size !== 2 || timestampMs(values.get('LOCAL')) !== 0
        || !/^0+$/.test(values.get('MPEGTS') || '')) {
      throw new Error('Nonzero mapping');
    }
  } catch {
    throw new Error('Unverified timestamp mapping');
  }
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '\u200E', rlm: '\u200F',
};

function cueText(value) {
  return value.replace(/<[^>]*>/g, '').replace(
    /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|lrm|rlm);/gi,
    (original, name) => {
      if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? original;
      const point = /^#x/i.test(name) ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isInteger(point) && point > 0 && point <= 0x10FFFF
        && !(point >= 0xD800 && point <= 0xDFFF) ? String.fromCodePoint(point) : '\uFFFD';
    },
  ).split('\n').map((line) => line.replace(/[\t ]+/g, ' ').trim()).join('\n').trim();
}

function textHash(value) {
  // A deterministic 64-bit FNV-1a fingerprint; no browser or Node APIs required.
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

/** Parse absolute VOD cue times, refusing unverified MPEG timestamp mappings. */
function parseWebVtt(text, { epoch = 'vod' } = {}) {
  if (typeof epoch !== 'string' || !epoch || epoch.length > 128) {
    throw new Error('Invalid WebVTT epoch');
  }
  const lines = boundedText(text, MAX_VTT_CHARS, 'WebVTT').split('\n');
  const header = lines.shift();
  if (!/^WEBVTT(?:[\t ].*)?$/.test(header || '') || header.includes('-->')) {
    throw new Error('Missing WebVTT header');
  }

  let sawMap = false;
  let cursor = 0;
  for (; cursor < lines.length && lines[cursor].trim(); cursor += 1) {
    const line = lines[cursor].trim();
    if (line.startsWith('X-TIMESTAMP-MAP')) {
      if (sawMap) throw new Error('Unverified timestamp mapping');
      verifyTimestampMap(line);
      sawMap = true;
    } else if (line.includes('-->')) {
      throw new Error('WebVTT header must end with a blank line');
    }
  }

  const cues = [];
  const seen = new Set();
  let parsedCues = 0;
  while (cursor < lines.length) {
    while (cursor < lines.length && !lines[cursor].trim()) cursor += 1;
    if (cursor === lines.length) break;
    const block = [];
    while (cursor < lines.length && lines[cursor].trim()) block.push(lines[cursor++]);
    if (/^NOTE(?:[\t ]|$)/.test(block[0])) continue;
    if (block[0] === 'STYLE' || block[0] === 'REGION') {
      if (parsedCues) throw new Error('WebVTT STYLE/REGION must precede cues');
      continue;
    }
    parsedCues += 1;
    if (parsedCues > MAX_CUES) throw new Error('WebVTT cue limit exceeded');

    const timeIndex = block[0].includes('-->') ? 0 : 1;
    const timing = /^(\S+)\s+-->\s+(\S+)(?:[\t ].*)?$/.exec(block[timeIndex]?.trim() || '');
    if (!timing) throw new Error('Invalid WebVTT cue timing');
    const startMs = timestampMs(timing[1]);
    const endMs = timestampMs(timing[2]);
    if (endMs <= startMs) throw new Error('Invalid WebVTT cue time range');
    const rawText = block.slice(timeIndex + 1).join('\n');
    if (rawText.length > MAX_CUE_CHARS) throw new Error('WebVTT cue text limit exceeded');
    if (rawText.includes('-->')) throw new Error('WebVTT cues must be separated by a blank line');
    const cleanText = cueText(rawText);
    if (!cleanText) continue;
    const id = `${epoch}:${startMs}:${endMs}:${textHash(cleanText)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    cues.push({ id, start: startMs / 1000, end: endMs / 1000, text: cleanText });
  }
  return cues;
}

// src/tiledmedia-source.js

const normalizedCaption = value => String(value || '').replace(/\s+/g, ' ').trim();

// The SDK's content position (ms) is the programme clock. The child <video>
// uses a rebased MSE clock and MUST NOT be substituted for it.
function tiledContentSeconds(view) {
  const time = view?.currentContentTime;
  return time && Number.isFinite(time.currentPosition) ? time.currentPosition / 1000 : NaN;
}

class TiledMediaVodSource {
  constructor(view, { aheadSeconds = 45, fetchText, onStatus = () => {}, onReset = () => {}, getOfficialText = () => '' } = {}) {
    this.view = view; this.aheadSeconds = aheadSeconds; this.onStatus = onStatus; this.onReset = onReset;
    this.getOfficialText = getOfficialText;
    this.fetchText = fetchText || (async (url, signal) => {
      const response = await fetch(url, { signal, credentials: 'omit', redirect: 'error' });
      if (!response.ok) throw Error('字幕文件请求失败');
      const text = await response.text();
      if (text.length > 2000000) throw Error('字幕文件超出大小限制');
      return text;
    });
    this.cache = new Map(); this.seen = new Set(); this.epoch = 0; this.validated = false;
    this.coverageStart = NaN; this.coverageEnd = NaN;
    this.onCues = () => {}; this.stopped = true; this.busy = false; this.url = null;
  }
  start(onCues) { this.onCues = onCues; this.stopped = false; this.poll(); this.timer = setInterval(() => this.poll(), 1000); }
  coversTime(time) {
    return !this.stopped && this.validated && Number.isFinite(time) && time >= this.coverageStart && time < this.coverageEnd;
  }
  reset() {
    this.cache.clear(); this.seen.clear(); this.playlist = null; this.url = null;
    this.coverageStart = NaN; this.coverageEnd = NaN;
    this.validated = false; this.epoch++; this.onReset();
  }
  async poll() {
    if (this.stopped || this.busy) return;
    this.busy = true;
    const controller = new AbortController(); this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const clock = this.view.currentContentTime;
      if (clock?.eventType !== 'vod') throw Error('当前只验证了回放字幕，直播时间映射尚待验证');
      const player = this.view.associatedPlayer;
      const stream = player?.currentSubtitleTrack;
      if (!stream || player.desiredSubtitleTrackSelection?.disable) throw Error('请先在官网字幕菜单选择英文');
      const track = await stream.parentSubtitleTrack;
      const language = await track.language;
      if (!/^en(?:g)?(?:-|$)/i.test(language || '')) throw Error('请先在官网字幕菜单选择英文');
      const url = await stream.url;
      const parsedUrl = new URL(url);
      // Signed URLs remain in this browser session only. Never send them to the
      // translation server, console, persisted config, or error messages.
      if (parsedUrl.protocol !== 'https:' || !/(^|\.)formula1\.com$/i.test(parsedUrl.hostname)) throw Error('字幕资源不属于已验证的官方域名');
      if (this.stopped) return;
      if (url !== this.url) { this.reset(); this.url = url; }
      if (!this.playlist) {
        this.playlist = parseHlsVodPlaylist(await this.fetchText(url, controller.signal), url);
        if (!Number.isFinite(clock.contentDuration) || Math.abs(this.playlist.duration - clock.contentDuration / 1000) > 1) {
          this.playlist = null; throw Error('字幕清单时长与节目时钟不匹配');
        }
      }
      const time = tiledContentSeconds(this.view);
      const wanted = this.playlist.segments.filter(s => s.end >= Math.max(0, time - 6) && s.start <= time + this.aheadSeconds);
      // Fetch a small playback neighbourhood, never translate an entire race on
      // enable. Acquisition is independent of video playback events.
      for (const segment of wanted) {
        if (this.stopped) return;
        if (!this.cache.has(segment.sequence)) {
          this.cache.set(segment.sequence, parseWebVtt(await this.fetchText(segment.url, controller.signal), {epoch:`tiled-${this.epoch}`}));
        }
      }
      if (this.stopped) return;
      const available = [...new Map(wanted.flatMap(s => this.cache.get(s.sequence) || []).map(c => [c.id,c])).values()];
      const now = tiledContentSeconds(this.view);
      if (!this.validated) {
        const official = normalizedCaption(this.getOfficialText());
        const current = available.filter(c => c.start <= now && now < c.end).map(c=>normalizedCaption(c.text));
        this.validated = Boolean(official && current.some(text => text === official || current.join(' ') === official));
      }
      if (!this.validated) {
        this.onStatus({available:false, message:'已读到字幕分段，等待当前官方英文与节目时间吻合以校准'}); return;
      }
      const batch = available.filter(c => c.end >= now - 6 && !this.seen.has(c.id));
      batch.forEach(c => this.seen.add(c.id));
      if (batch.length) this.onCues(batch);
      // Commit coverage only after delivering cues; real gaps in these fully
      // read segments are also covered, even if the official layer lingers.
      this.coverageStart = wanted.length ? Math.max(wanted[0].start, now - 6) : NaN;
      this.coverageEnd = wanted.at(-1)?.end ?? NaN;
      const end = available.reduce((max,c)=>Math.max(max,c.end),now);
      this.onStatus({available:true, cueCount:this.seen.size, ahead:end-now, contentTime:now, kind:'tiled-vod'});
      // Bound raw segment memory; translated cue cache is maintained separately.
      if (this.cache.size > 160) {
        const keep = new Set(wanted.map(s=>s.sequence));
        for (const key of this.cache.keys()) { if (!keep.has(key)) this.cache.delete(key); if(this.cache.size <= 100) break; }
      }
    } catch (error) {
      this.validated = false;
      if (!this.stopped) this.onStatus({available:false, message:controller.signal.aborted ? '字幕读取超时，保留官方字幕' : '字幕读取或校准失败；请确认官网英文已开启、当前为回放且可播放'});
    } finally { clearTimeout(timeout); this.busy = false; }
  }
  stop() { this.stopped = true; clearInterval(this.timer); this.controller?.abort(); this.cache.clear(); this.seen.clear(); }
}

// The caller decides when its subtitle coverage should hide the official layer,
// including known gaps between cues. Restoring preserves the original styles.
class OfficialCaptionVisibility {
  constructor(findElements) { this.findElements = findElements; this.original = new Map(); }
  setHidden(hidden) {
    if (!hidden) { this.restore(); return; }
    for (const element of this.findElements()) {
      if (!this.original.has(element)) this.original.set(element, [element.style.getPropertyValue('visibility'),element.style.getPropertyPriority('visibility')]);
      element.style.setProperty('visibility','hidden','important');
    }
  }
  restore() {
    for (const [element,[value,priority]] of this.original) {
      if (value) element.style.setProperty('visibility',value,priority); else element.style.removeProperty('visibility');
    }
    this.original.clear();
  }
}

// src/tiledmedia-live-source.js

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
function tiledLiveOriginSeconds(view) {
  const content = view?.currentContentTime, wall = view?.currentWallclockTime;
  if (content?.eventType !== 'live' || wall?.eventType !== 'live' || !content.isWallclockTimeSourceBased) return NaN;
  const offsets = ['seekLowerBound', 'seekUpperBound', 'bufferLowerBound', 'bufferUpperBound']
    .filter(key => Number.isFinite(content[key]) && Number.isFinite(wall[key]))
    .map(key => wall[key] - content[key]);
  if (offsets.length < 2 || offsets[0] < 1e12 || offsets.some(value => Math.abs(value - offsets[0]) > 20)) return NaN;
  return offsets[0] / 1000;
}

class TiledMediaLiveSource {
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

// src/overlay.js
const SUBTITLE_FONTS = {
  yahei: '"Microsoft YaHei", "微软雅黑", sans-serif',
  heiti: 'SimHei, "黑体", sans-serif',
  songti: 'SimSun, "宋体", serif',
  system: 'system-ui, sans-serif'
};

function normalizeSubtitleStyle(value = {}) {
  return { font: Object.hasOwn(SUBTITLE_FONTS, value?.font) ? value.font : 'yahei',
    size: Number.isFinite(value?.size) ? Math.max(16, Math.min(48, value.size)) : 28,
    bold: value?.bold === true };
}

// Both timelines share one physical stack; moving either moves them together.
class VideoOverlay {
  constructor(video, timeline, { getTime = () => video.currentTime, onRender = () => {}, opacity = 1,
    above = null, prefix = '', style = {}, position = null, onPositionSave = () => {} } = {}) {
    Object.assign(this, { video, timeline, getTime, onRender, above, prefix });
    this.root = above?.root || this;
    this.line = document.createElement('div'); this.line.className = 'line';
    this.label = document.createElement('span'); this.line.append(this.label);
    if (above) {
      this.host = this.root.host; this.stack = this.root.stack;
      this.line.dataset.track = 'radio'; this.line.style.color = '#a9d9ff';
      this.stack.insertBefore(this.line, above.line); this.root.layers.add(this);
    } else {
      this.layers = new Set([this]); this.onPositionSave = onPositionSave;
      this.position = { x: Number.isFinite(position?.x) ? position.x : .5,
        bottom: Number.isFinite(position?.bottom) ? position.bottom : .08 };
      this.host = document.createElement('div'); this.host.dataset.f1zh = 'overlay';
      this.host.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;display:none;';
      const shadow = this.host.attachShadow({ mode: 'open' });
      shadow.innerHTML = `<style>:host{all:initial}[hidden]{display:none!important}.stack{position:absolute;display:flex;flex-direction:column;align-items:center;gap:.3em;width:max-content;max-width:90%;transform:translateX(-50%);pointer-events:none;color:#fff;line-height:1.5;text-shadow:0 2px 3px #000;touch-action:none;user-select:none}.line{max-width:100%;text-align:center;white-space:pre-line;overflow-wrap:anywhere;min-height:1.5em}.line span{pointer-events:auto;cursor:grab;background:rgba(0,0,0,.78);box-decoration-break:clone;-webkit-box-decoration-break:clone;padding:.14em .4em;border-radius:4px}.stack.dragging span{cursor:grabbing}</style><div class="stack" title="拖动字幕可同时移动普通字幕与 TR"></div>`;
      this.stack = shadow.querySelector('.stack'); this.stack.append(this.line);
      this.events = new AbortController();
      const listen = (target, name, fn) => target.addEventListener(name, fn, { signal: this.events.signal });
      listen(this.stack, 'pointerdown', event => this.beginDrag(event));
      listen(this.stack, 'pointermove', event => this.moveDrag(event));
      for (const name of ['pointerup','pointercancel','lostpointercapture']) listen(this.stack, name, event => this.endDrag(event));
      listen(this.stack, 'click', event => event.stopPropagation());
      listen(window, 'resize', () => { this.endDrag(); this.layout(); });
      document.body.append(this.host);
      this.setStyle(style); this.setOpacity(opacity);
    }
    this.onSeek = () => { timeline.seek(); this.draw(); };
    this.onDraw = () => this.draw();
    video.addEventListener('seeking', this.onSeek);
    video.addEventListener('timeupdate', this.onDraw);
    document.addEventListener('fullscreenchange', this.onDraw);
    this.timer = setInterval(this.onDraw, 80);
    this.draw();
  }
  setStyle(value) {
    const style = normalizeSubtitleStyle(value);
    Object.assign(this.root.stack.style, { fontFamily: SUBTITLE_FONTS[style.font],
      fontSize: `${style.size}px`, fontWeight: style.bold ? '700' : '400' });
    this.root.layout();
  }
  setOpacity(value) {
    this.root.stack.style.opacity = String(Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1);
  }
  layout() {
    if (this !== this.root) return this.root.layout();
    const fs = document.fullscreenElement;
    const parent = fs && fs !== this.video && fs.contains(this.video) ? fs : document.body;
    if (this.host.parentElement !== parent) parent.append(this.host);
    const r = this.video.getBoundingClientRect();
    let width = r.width, height = r.height, left = r.left, top = r.top;
    if (this.video.videoWidth && this.video.videoHeight) {
      const scale = Math.min(width / this.video.videoWidth, height / this.video.videoHeight);
      const w = this.video.videoWidth * scale, h = this.video.videoHeight * scale;
      left += (width - w) / 2; top += (height - h) / 2; width = w; height = h;
    }
    const visible = [...this.layers].some(layer => layer.label.textContent);
    Object.assign(this.host.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`,
      display: visible && width && height && fs !== this.video ? 'block' : 'none' });
    const box = this.stack.getBoundingClientRect();
    const x = Math.max(box.width / 2 + 8, Math.min(width - box.width / 2 - 8, this.position.x * width));
    const bottom = Math.max(8, Math.min(height - box.height - 8, this.position.bottom * height));
    Object.assign(this.stack.style, { left: `${x}px`, bottom: `${bottom}px` });
    this.bounds = { width, height, x, bottom };
  }
  beginDrag(event) {
    if (event.button !== 0 || event.isPrimary === false || this.drag || !event.target.closest('span')) return;
    this.layout();
    this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, bounds: { ...this.bounds }, moved: false };
    this.stack.setPointerCapture(event.pointerId);
    event.preventDefault(); event.stopPropagation();
  }
  moveDrag(event) {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true; this.stack.classList.add('dragging');
    const { width, height, x, bottom } = drag.bounds;
    if (!width || !height) return;
    this.position = { x: (x + dx) / width, bottom: (bottom - dy) / height };
    this.layout(); event.preventDefault(); event.stopPropagation();
  }
  endDrag(event) {
    const drag = this.drag;
    if (!drag || (event && event.pointerId !== drag.id)) return;
    this.drag = null; this.stack.classList.remove('dragging');
    if (this.stack.hasPointerCapture(drag.id)) this.stack.releasePointerCapture(drag.id);
    if (drag.moved && this.bounds.width && this.bounds.height) {
      this.position = { x: this.bounds.x / this.bounds.width, bottom: this.bounds.bottom / this.bounds.height };
      this.onPositionSave({ ...this.position });
    }
  }
  draw() {
    const time = this.getTime(), wall = performance.now()/1000;
    if (Number.isFinite(this.lastTime) && Math.abs((time-this.lastTime)-(wall-this.lastWall)) > 1) this.timeline.seek();
    this.lastTime = time; this.lastWall = wall;
    const state = this.timeline.render(time);
    const text = state.text ? this.prefix + state.text : '';
    if (this.label.textContent !== text) this.label.textContent = text;
    if (this.above) this.line.hidden = !text;
    else this.line.style.visibility = text ? 'visible' : 'hidden';
    this.line.dataset.language = state.hasEnglish ? 'en' : 'zh';
    this.root.layout();
    this.onRender(this.host.style.display === 'block' && text ? state : {lines:[],text:'',hasEnglish:false});
  }
  dispose() {
    clearInterval(this.timer); this.video.removeEventListener('seeking', this.onSeek);
    this.video.removeEventListener('timeupdate', this.onDraw);
    document.removeEventListener('fullscreenchange', this.onDraw);
    if (this === this.root) { this.endDrag(); this.events.abort(); this.host.remove(); }
    else { this.root.layers.delete(this); this.line.remove(); this.root.layout(); }
    this.onRender({lines:[],text:'',hasEnglish:false});
  }
}

// src/floating-controls.js
// Positioning and interaction only; minimizing never toggles translation.
class FloatingControls {
  constructor(host, { panel, handle, minimize, ball, saved, onSave = () => {} }) {
    this.host = host; this.panel = panel; this.handle = handle; this.ball = ball; this.onSave = onSave;
    this.collapsed = saved?.collapsed === true;
    this.side = saved?.side === 'left' ? 'left' : 'right';
    this.centerX = Number.isFinite(saved?.centerX) ? saved.centerX : null;
    this.centerY = Number.isFinite(saved?.centerY) ? saved.centerY : null;
    this.events = new AbortController();
    const listen = (target, name, callback) => target.addEventListener(name, callback, { signal: this.events.signal });
    for (const grip of [handle, ball]) {
      listen(grip, 'pointerdown', event => this.beginDrag(event, grip));
      listen(grip, 'pointermove', event => this.moveDrag(event));
      listen(grip, 'pointerup', event => this.endDrag(event));
      listen(grip, 'pointercancel', event => this.endDrag(event));
      listen(grip, 'lostpointercapture', event => this.endDrag(event));
    }
    listen(minimize, 'click', () => this.setCollapsed(true));
    listen(ball, 'click', event => {
      // Consume only the click produced by a drag. A fresh pointerdown clears
      // this flag; keyboard activation (detail=0) always remains available.
      if (this.suppressBallClick && event.detail !== 0) {
        this.suppressBallClick = false; event.preventDefault(); return;
      }
      this.suppressBallClick = false; this.setCollapsed(false);
    });
    listen(host, 'click', event => event.stopPropagation());
    listen(window, 'resize', () => { this.endDrag(); this.refresh(); });
    listen(document, 'fullscreenchange', () => { this.endDrag(); this.refresh(); });
    this.observer = new ResizeObserver(() => this.refresh());
    this.observer.observe(panel); this.observer.observe(ball);
    this.refresh();
  }
  refresh() {
    // Do not measure zero-sized hidden controls or change their saved position.
    this.host.style.display = document.fullscreenElement ? 'none' : 'block';
    if (document.fullscreenElement) return;
    this.panel.hidden = this.collapsed; this.ball.hidden = !this.collapsed;
    const rect = (this.collapsed ? this.ball : this.panel).getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const margin = 8, width = window.innerWidth, height = window.innerHeight;
    if (this.centerX === null) this.centerX = width - 18 - rect.width / 2;
    if (this.centerY === null) this.centerY = 18 + rect.height / 2;
    const maxLeft = Math.max(margin, width - margin - rect.width);
    const maxTop = Math.max(margin, height - margin - rect.height);
    let left = Math.max(margin, Math.min(maxLeft, this.centerX - rect.width / 2));
    const top = Math.max(margin, Math.min(maxTop, this.centerY - rect.height / 2));
    if (this.collapsed && !this.drag) left = this.side === 'left' ? margin : maxLeft;
    this.centerX = left + rect.width / 2; this.centerY = top + rect.height / 2;
    Object.assign(this.host.style, { right: 'auto', left: `${left}px`, top: `${top}px` });
  }
  beginDrag(event, grip) {
    if (event.button !== 0 || event.isPrimary === false || this.drag) return;
    if (grip === this.handle && event.target.closest('button, input, a, select, textarea')) return;
    this.suppressBallClick = false;
    this.drag = { pointerId: event.pointerId, grip, x: event.clientX, y: event.clientY,
      centerX: this.centerX, centerY: this.centerY, moved: false };
    grip.setPointerCapture(event.pointerId);
    event.stopPropagation();
  }
  moveDrag(event) {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    drag.moved = true;
    this.host.dataset.dragging = 'true';
    this.centerX = drag.centerX + dx; this.centerY = drag.centerY + dy;
    this.refresh(); event.preventDefault(); event.stopPropagation();
  }
  endDrag(event) {
    const drag = this.drag;
    if (!drag || (event && event.pointerId !== drag.pointerId)) return;
    this.drag = null; delete this.host.dataset.dragging;
    if (drag.grip.hasPointerCapture(drag.pointerId)) drag.grip.releasePointerCapture(drag.pointerId);
    if (drag.moved) {
      this.side = this.centerX < window.innerWidth / 2 ? 'left' : 'right';
      this.suppressBallClick = drag.grip === this.ball;
      this.refresh(); this.save();
    }
  }
  setCollapsed(value) {
    if (value) this.side = this.centerX < window.innerWidth / 2 ? 'left' : 'right';
    this.collapsed = value;
    this.refresh(); this.save();
    (value ? this.ball : this.handle.querySelector('button')).focus({ preventScroll: true });
  }
  save() {
    this.onSave({ centerX: this.centerX, centerY: this.centerY, side: this.side, collapsed: this.collapsed });
  }
  dispose() {
    this.endDrag(); this.events.abort(); this.observer.disconnect();
  }
}

// src/preparation-state.js
const prepTimeEpsilon = 1e-6;

// Coverage means the official caption source has been read, including silence.
// A translated cue farther ahead cannot establish coverage across an unread gap.
function commentaryPreparation({ enabled, time, coverage = [], cues = [], targetSeconds = 45 } = {}) {
  const prepTimeValid = Number.isFinite(time) && time >= 0;
  const prepInitial = { state: enabled ? 'preparing' : 'waiting', ahead: 0, readyUntil: prepTimeValid ? time : null };
  if (!enabled || !prepTimeValid) return prepInitial;

  const prepRanges = Array.isArray(coverage) ? coverage.filter(range => Array.isArray(range)
    && Number.isFinite(range[0]) && Number.isFinite(range[1]) && range[0] >= 0 && range[1] > range[0])
    .map(range => [range[0], range[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]) : [];
  let prepUntil = time;
  for (const prepRange of prepRanges) {
    if (prepRange[1] <= prepUntil) continue;
    if (prepRange[0] > prepUntil + prepTimeEpsilon) break;
    prepUntil = prepRange[1];
  }

  for (const prepCue of Array.isArray(cues) ? cues : []) {
    if (!prepCue || !Number.isFinite(prepCue.start) || !Number.isFinite(prepCue.end)
      || prepCue.end <= prepCue.start || prepCue.end <= time || prepCue.start >= prepUntil) continue;
    const prepCueReady = prepCue.status === 'ready' && typeof prepCue.zh === 'string' && !!prepCue.zh.trim();
    if (!prepCueReady) prepUntil = Math.max(time, Math.min(prepUntil, prepCue.start));
  }

  const prepAhead = Math.max(0, prepUntil - time);
  const prepTarget = Number.isFinite(targetSeconds) && targetSeconds > 0 ? targetSeconds : 45;
  return { state: prepAhead + prepTimeEpsilon >= prepTarget ? 'ready' : 'preparing', ahead: prepAhead, readyUntil: prepUntil };
}

// src/userscript-entry.js

const SERVICE = 'http://127.0.0.1:3847';
const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
const PREPARATION_SECONDS = 45, PREPARATION_LOOKAHEAD = 60, LIVE_VIEW_DELAY_SECONDS = 50;
let token = GM_getValue('localServiceToken', '');
const savedTransparency = Number(GM_getValue('subtitleTransparency', 0));
let subtitleTransparency = Number.isFinite(savedTransparency) ? Math.max(0, Math.min(100, savedTransparency)) : 0;
let subtitleStyle = normalizeSubtitleStyle(GM_getValue('subtitleStyle', {}));
let subtitlePosition = GM_getValue('subtitlePosition', null);
let session = null, enabled = false, currentPage = location.href;

const panel = document.createElement('div');
panel.dataset.f1zh = 'controls';
panel.style.cssText = 'position:fixed;right:18px;top:18px;z-index:2147483647;';
const shadow = panel.attachShadow({mode:'open'});
shadow.innerHTML = `<style>
:host{all:initial}[hidden]{display:none!important}
section{box-sizing:border-box;color:#e6eff8;background:#14202ff2;border:1px solid #456079;border-radius:12px;padding:12px;font:12px/1.5 system-ui,"Microsoft YaHei",sans-serif;width:min(310px,calc(100vw - 16px));max-height:calc(100vh - 16px);overflow:auto;box-shadow:0 8px 28px #0004}
button{cursor:pointer;background:#243c4e;border:1px solid #587c92;border-radius:6px;color:#edf5ff;padding:8px 9px;font:inherit;transition:background .18s,border-color .18s,color .18s}
button:hover:enabled{background:#304e63;border-color:#81aec7}button:focus-visible{outline:2px solid #91d7f4;outline-offset:2px}
.switches{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px}.switches button{white-space:nowrap}button:disabled{cursor:default;color:#889eaf;background:#1c2b3b;border-color:#394f61}
#toggle[aria-pressed=true]{border-color:#83bcd5;background:#294b60}
#preparation{display:block;width:100%;letter-spacing:.12em;font-weight:600;background:#1b2b3b;color:#9dafbe;border-color:#3e5366;padding:9px;cursor:default}
#preparation[data-state=preparing]{color:#a9d9ee;border-color:#608da5;background:#203a4b}
#preparation[data-state=ready]{color:#14202f;background:#83dfc7;border-color:#83dfc7;box-shadow:0 0 18px #83dfc718}
#preparation-detail,#playback-status{color:#a1b4c5;font-size:11px;margin:6px 0 11px;font-variant-numeric:tabular-nums}
p{margin:4px 0;overflow-wrap:anywhere}#status{color:#b9cbd9;font-size:11px}small{color:#90a5b7}a{color:#9edbf4}
.opacity,.style-option{display:flex;align-items:center;gap:8px;margin:8px 0}input[type=range]{flex:1;min-width:0;accent-color:#82c7ed}output{min-width:4ch;text-align:right;font-variant-numeric:tabular-nums}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:-2px 0 12px;cursor:grab;touch-action:none;user-select:none}header span{color:#d8e6f1;font-weight:600}header small{font-weight:400;margin-left:7px}
#minimize{margin:0;padding:0;width:28px;height:26px;font-size:18px;line-height:1}
#ball{display:grid;place-items:center;box-sizing:border-box;width:40px;height:40px;margin:0;padding:0;border-radius:50%;background:#14202feb;border:1px solid #648ba5;box-shadow:0 2px 8px #0005;font:600 15px system-ui,"Microsoft YaHei",sans-serif;cursor:grab;touch-action:none;user-select:none}
:host([data-dragging]) header,:host([data-dragging]) #ball{cursor:grabbing}
details{margin:4px 0 8px;border-top:1px solid #456079;padding-top:6px}summary{cursor:pointer;user-select:none}.style-option select{flex:1;min-width:0;background:#243c4e;color:#fff;border:1px solid #587c92;border-radius:4px;font:inherit;padding:3px}
#prepare-playback{width:100%;margin-top:8px}#issue{color:#ffd38a}
</style><section id="console">
<header id="drag-handle" title="拖动标题栏移动控制台"><span>字幕翻译<small>拖动移动</small></span><button id="minimize" aria-label="最小化控制台" title="最小化为悬浮球">−</button></header>
<div class="switches"><button id="toggle" aria-pressed="false">开启翻译</button><button id="pair">配对本机服务</button></div>
<button id="preparation" data-state="waiting" disabled aria-live="polite">等待中</button>
<p id="preparation-detail">开启后，先准备至少 45 秒解说中文</p>
<details><summary>字幕样式</summary>
<label class="style-option" for="subtitle-font">字体<select id="subtitle-font"><option value="yahei">微软雅黑</option><option value="heiti">黑体</option><option value="songti">宋体</option><option value="system">系统默认</option></select></label>
<label class="style-option" for="subtitle-size">字号<input id="subtitle-size" type="range" min="16" max="48" step="1"><output id="subtitle-size-value"></output></label>
<label class="style-option"><input id="subtitle-bold" type="checkbox">加粗</label>
<label class="opacity" for="transparency">透明度<input id="transparency" type="range" min="0" max="100" step="5"><output id="transparency-value"></output></label>
<small>拖动字幕可移动；样式自动保存。</small></details>
<p id="status">翻译已关闭</p><p id="issue" hidden role="status"></p>
<button id="prepare-playback" hidden title="调整到直播后方 50 秒；保留当前暂停或播放状态">预留 50 秒翻译时间</button>
<p id="playback-status"></p><small><a href="${SERVICE}/" target="_blank" rel="noopener noreferrer">本机配置页</a></small>
</section><button id="ball" hidden aria-label="展开字幕控制台" title="点击展开；拖动后吸附左右边缘">中</button>`;
document.body.append(panel);
panel.addEventListener('keydown', event => event.stopPropagation());
panel.addEventListener('keyup', event => event.stopPropagation());
const button = shadow.getElementById('toggle'), status = shadow.getElementById('status');
const preparationButton = shadow.getElementById('preparation'), preparationDetail = shadow.getElementById('preparation-detail');
const playbackButton = shadow.getElementById('prepare-playback'), playbackStatus = shadow.getElementById('playback-status');
const translationIssue = shadow.getElementById('issue');
const translationMessages = {
  NOT_CONFIGURED:'请在本机配置页保存自己的 API 密钥，然后重新开启翻译。',
  UNAUTHORIZED:'配对已失效，请从本机配置页复制新的配对码。',
  LOCAL_SERVICE_UNAVAILABLE:'无法连接本机服务，请先运行 start-service.cmd。',
  LOCAL_SERVICE_TIMEOUT:'本机请求超时，当前句保留英文。',
  BUSY:'翻译队列繁忙，当前句保留英文。',
  UPSTREAM_AUTH_FAILED:'API 认证失败，请检查本机配置页中的密钥。',
  UPSTREAM_BALANCE:'API 余额不足。',
  UPSTREAM_RATE_LIMITED:'API 限流，当前句保留英文；稍后关闭再开启翻译重试。',
  UPSTREAM_UNAVAILABLE:'无法连接翻译 API，请检查网络与配置。',
  UPSTREAM_REJECTED:'API 拒绝请求，请检查接口和模型名称。',
  TRANSLATION_TIMEOUT:'API 响应超时，当前句保留英文。',
  INVALID_UPSTREAM_RESPONSE:'API 未返回有效译文，当前句保留英文。'
};
function showTranslationIssue(code) {
  translationIssue.textContent = code ? translationMessages[code] || '翻译请求失败，当前句保留英文。' : '';
  translationIssue.hidden = !code;
}
const fontControl = shadow.getElementById('subtitle-font'), sizeControl = shadow.getElementById('subtitle-size');
const boldControl = shadow.getElementById('subtitle-bold'), sizeValue = shadow.getElementById('subtitle-size-value');
fontControl.value = subtitleStyle.font; sizeControl.value = String(subtitleStyle.size); boldControl.checked = subtitleStyle.bold;
sizeValue.value = `${subtitleStyle.size}px`;
for (const control of [fontControl, sizeControl, boldControl]) {
  control.addEventListener('input', () => {
    subtitleStyle = normalizeSubtitleStyle({font:fontControl.value, size:Number(sizeControl.value), bold:boldControl.checked});
    sizeValue.value = `${subtitleStyle.size}px`; session?.overlay.setStyle(subtitleStyle);
  });
  control.addEventListener('change', () => GM_setValue('subtitleStyle', subtitleStyle));
}
const transparency = shadow.getElementById('transparency'), transparencyValue = shadow.getElementById('transparency-value');
transparency.value = String(subtitleTransparency); transparencyValue.value = `${subtitleTransparency}%`;
transparency.addEventListener('input', () => {
  subtitleTransparency = Number(transparency.value); transparencyValue.value = `${subtitleTransparency}%`;
  session?.overlay.setOpacity(1 - subtitleTransparency / 100);
});
transparency.addEventListener('change', () => GM_setValue('subtitleTransparency', subtitleTransparency));
const floatingControls = new FloatingControls(panel, {
  panel:shadow.getElementById('console'), handle:shadow.getElementById('drag-handle'),
  minimize:shadow.getElementById('minimize'), ball:shadow.getElementById('ball'),
  saved:GM_getValue('floatingConsole', null), onSave:value => GM_setValue('floatingConsole', value)
});

function preparationFor(current = session) {
  const time = current?.view ? tiledContentSeconds(current.view) : current?.video.currentTime;
  const source = current?.source, cues = current ? current.store.sorted() : [];
  const coverage = current?.sourceKind === 'native' ? cues.map(c => [c.start, c.end])
    : !source?.validated ? [] : source.coverage || [[source.coverageStart, source.coverageEnd]];
  return commentaryPreparation({enabled, time, coverage, cues, targetSeconds:PREPARATION_SECONDS});
}
function behindLiveSeconds(view) {
  const clock = view?.currentContentTime;
  return clock?.eventType === 'live' && Number.isFinite(clock.seekUpperBound) && Number.isFinite(clock.currentPosition)
    ? Math.max(0, (clock.seekUpperBound - clock.currentPosition) / 1000) : NaN;
}
function refreshControls() {
  button.textContent = enabled ? '关闭翻译' : '开启翻译'; button.setAttribute('aria-pressed', String(enabled));
  shadow.getElementById('pair').textContent = token ? '重新配对' : '配对本机服务';
  const prep = preparationFor();
  preparationButton.dataset.state = prep.state;
  preparationButton.textContent = {waiting:'等待中', preparing:'准备中', ready:'准备就绪'}[prep.state];
  preparationDetail.textContent = !enabled ? '开启后，先准备至少 45 秒解说中文'
    : !session ? '等待播放器，解说中文目标 45 秒'
    : prep.state === 'ready' ? `解说中文已连续准备 ${Math.floor(prep.ahead)} 秒${session.video.paused ? ' · 可以开始播放' : ''}`
    : `解说中文连续就绪 ${Math.floor(prep.ahead)} / 45 秒${session.video.paused ? '' : ' · 播放中继续准备'}`;
  const view = pageWindow.document.querySelector('tiledmedia-view'), lag = behindLiveSeconds(view);
  playbackButton.hidden = !Number.isFinite(lag);
  if (!playbackButton.disabled) playbackStatus.textContent = Number.isFinite(lag) ? `当前落后官方直播前沿约 ${Math.round(lag)} 秒` : '';
}
function waitWhenPrepared(source, current) {
  const poll = source.poll.bind(source);
  source.poll = () => {
    if (session !== current || !enabled) return;
    if (current.video.paused && preparationFor(current).state === 'ready') return;
    return poll();
  };
}
function requestTranslation(cue, context, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(Error('cancelled'));
    let finished = false, request;
    const done = (error, value) => {
      if (finished) return;
      finished = true; signal.removeEventListener('abort', abort);
      if (error !== 'CANCELLED') showTranslationIssue(error);
      error ? reject(Error('translation_unavailable')) : resolve(value);
    };
    const abort = () => {request?.abort(); done('CANCELLED');};
    signal.addEventListener('abort', abort, {once:true});
    try {request = GM_xmlhttpRequest({method:'POST', url:`${SERVICE}/api/translate`, anonymous:true,
      headers:{'Content-Type':'application/json', Authorization:`Bearer ${token}`},
      data:JSON.stringify({cue,context}), timeout:11500,
      onload:response => {
        let body;
        try {body = JSON.parse(response.responseText);} catch {return done('INVALID_UPSTREAM_RESPONSE');}
        if (response.status !== 200) return done(response.status === 401 ? 'UNAUTHORIZED' : body?.error?.code || 'REQUEST_FAILED');
        if (typeof body?.text !== 'string' || !body.text.trim()) return done('INVALID_UPSTREAM_RESPONSE');
        done(null, body);
      }, onerror:()=>done('LOCAL_SERVICE_UNAVAILABLE'), ontimeout:()=>done('LOCAL_SERVICE_TIMEOUT'), onabort:()=>done('CANCELLED')
    });} catch {done('LOCAL_SERVICE_UNAVAILABLE');}
  });
}
function findVideo() {
  return Array.from(document.querySelectorAll('video')).filter(v => v.getBoundingClientRect().width > 150)
    .sort((a,b) => b.clientWidth*b.clientHeight - a.clientWidth*a.clientHeight)[0] || null;
}
function detach() {
  if (!session) return;
  session.source.stop(); session.queue.dispose(); session.overlay.dispose(); session.captions.restore();
  session.video.removeEventListener('emptied', session.reset);
  session.video.removeEventListener('enterpictureinpicture', session.unsupported);
  document.removeEventListener('fullscreenchange', session.unsupported); session = null;
}
function setEnabled(value) {
  enabled = value; detach(); showTranslationIssue(null);
  if (!value) status.textContent = '已关闭，恢复官方字幕'; else attach();
  refreshControls();
}
function attach() {
  if (!enabled || session) return;
  const video = findVideo();
  if (!video) {status.textContent = '等待播放器…'; return;}
  const view = pageWindow.document.querySelector('tiledmedia-view');
  const useTiled = Boolean(view?.associatedPlayer && view.contains(video));
  const sourceKind = useTiled ? view.currentContentTime?.eventType : 'native';
  if (useTiled && !['live','vod'].includes(sourceKind)) {status.textContent = '等待播放器时间轴…'; return;}
  const getTime = () => useTiled ? tiledContentSeconds(view) : video.currentTime;
  const store = new CueStore(), timeline = new SubtitleTimeline(store);
  timeline.setEnabled(true);
  const queue = new TranslationQueue(store, requestTranslation, {getTime});
  const captions = new OfficialCaptionVisibility(() => Array.from(document.querySelectorAll('.tm-ui-subtitle-overlay')));
  let source;
  const overlay = new VideoOverlay(video, timeline, {
    opacity:1 - subtitleTransparency / 100, style:subtitleStyle, position:subtitlePosition, getTime,
    onPositionSave:value => {subtitlePosition = value; GM_setValue('subtitlePosition', value);},
    onRender:state => {if (useTiled) captions.setHidden(Boolean(timeline.enabled && source?.validated && (state.text || source.coversTime(getTime()))));}
  });
  const sourceOptions = {epoch:`${Date.now()}`, onReset:() => {queue.reset(); timeline.seek(); captions.restore();}, onStatus:s => {
    if (timeline.enabled !== s.available) timeline.setEnabled(s.available);
    const all = [...store.cues.values()], failed = all.filter(c => c.status === 'failed').length;
    const ready = all.filter(c => c.status === 'ready').length;
    status.textContent = !s.available ? s.message || '请先在官网选择 English 字幕'
      : `${s.kind === 'tiled-live' ? '直播' : '回放'}解说字幕已接入 · 中文 ${ready}/${all.length}${failed ? ` · ${failed} 句保留英文` : ''}`;
    if (!s.available) captions.restore(); refreshControls();
  }};
  const TiledSource = sourceKind === 'live' ? TiledMediaLiveSource : TiledMediaVodSource;
  source = useTiled ? new TiledSource(view, {...sourceOptions, aheadSeconds:PREPARATION_LOOKAHEAD,
    followLiveHead:() => !video.paused, getOfficialText:() => document.querySelector('.tm-ui-subtitle-overlay')?.textContent || ''})
    : new TextTrackSource(video, {...sourceOptions, horizonSeconds:PREPARATION_LOOKAHEAD});
  const reset = () => detach();
  const unsupported = () => {
    if (document.fullscreenElement === video || document.pictureInPictureElement === video) {
      setEnabled(false); status.textContent = '请使用网页播放器的全屏按钮；单独视频全屏和画中画已恢复官方字幕。';
    }
  };
  session = {video,view:useTiled ? view : null,store,timeline,queue,overlay,source,captions,reset,unsupported,sourceKind};
  waitWhenPrepared(source, session);
  video.addEventListener('emptied', reset); video.addEventListener('enterpictureinpicture', unsupported);
  document.addEventListener('fullscreenchange', unsupported);
  source.start(cues => queue.ingestMany(cues)); unsupported();
}
function pairService() {
  const value = prompt('从 http://127.0.0.1:3847 点击“复制配对码”，粘贴到这里。这里不需要 API 密钥。', '');
  if (value === null) return;
  if (!/^[a-f0-9]{64}$/.test(value.trim())) {status.textContent = '配对码格式不正确，请重新复制。'; return;}
  token = value.trim(); GM_setValue('localServiceToken', token); showTranslationIssue(null);
  if (enabled) setEnabled(true); else status.textContent = '已配对，点击开启翻译';
  refreshControls();
}
GM_registerMenuCommand('配对本机翻译服务', pairService);
shadow.getElementById('pair').addEventListener('click', pairService);
button.addEventListener('click', () => {if (!enabled && !token) {pairService(); return;} setEnabled(!enabled);});
playbackButton.addEventListener('click', async () => {
  if (playbackButton.disabled) return;
  playbackButton.disabled = true; playbackStatus.textContent = '正在预留翻译时间…';
  try {
    const view = pageWindow.document.querySelector('tiledmedia-view'), video = view?.querySelector('video');
    const clock = view?.currentContentTime, player = view?.associatedPlayer;
    if (!video || !player || clock?.eventType !== 'live' || !Number.isFinite(clock.seekUpperBound)
        || !Number.isFinite(clock.seekLowerBound) || !pageWindow.Tiledmedia?.TimingConfig) throw Error('请先打开官网直播，等待时间轴就绪');
    const target = clock.seekUpperBound - LIVE_VIEW_DELAY_SECONDS * 1000, resume = !video.paused;
    if (target < clock.seekLowerBound) throw Error('直播可回看范围暂时不足，请稍后再试');
    const config = new pageWindow.Tiledmedia.TimingConfig();
    config.timingType = 1; config.targetPositionStrategy = 1; config.target = target;
    await player.seek(config);
    if (view.isConnected && view.associatedPlayer === player) {if (resume) await player.unpause(); else await player.pause();}
  } catch (error) {status.textContent = error.message || '请在官网播放器手动调到直播后方约 50 秒。';}
  finally {playbackButton.disabled = false; refreshControls();}
});
refreshControls();
const watcher = setInterval(() => {
  if (location.href !== currentPage) {currentPage = location.href; detach();}
  if (session && (!session.video.isConnected || session.video !== findVideo())) detach();
  const view = pageWindow.document.querySelector('tiledmedia-view'), kind = view?.currentContentTime?.eventType;
  if (session && view?.associatedPlayer && view.contains(session.video) && ['live','vod'].includes(kind) && session.sourceKind !== kind) detach();
  attach(); refreshControls();
}, 1000);
window.addEventListener('pagehide', event => {
  if (event.persisted) return;
  clearInterval(watcher); detach(); floatingControls.dispose(); panel.remove();
});
window.addEventListener('pageshow', event => {
  if (event.persisted) {floatingControls.refresh(); session?.source.poll(); session?.overlay.draw(); refreshControls();}
});

})();
