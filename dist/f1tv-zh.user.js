// ==UserScript==
// @name         F1 TV 中文字幕
// @namespace    local.f1tv.zh
// @version      0.9.2
// @description  翻译官方解说字幕及独立采集页的 Track FX 声音，中文按节目时间显示。
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
  let sawDiscontinuitySequence = false;
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
      } else if (line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')) {
        if (sawDiscontinuitySequence || segments.length || nextDuration !== null) {
          throw new Error('Invalid HLS discontinuity sequence placement');
        }
        // A retained broadcast sequence does not shift a complete VOD timeline.
        unsignedInteger(line.slice('#EXT-X-DISCONTINUITY-SEQUENCE:'.length), 'HLS discontinuity sequence');
        sawDiscontinuitySequence = true;
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

function vodWallclockOrigin(view) {
  const content = view.currentContentTime, wall = view.currentWallclockTime;
  if (content?.eventType !== 'vod' || wall?.eventType !== 'vod' || !content.isWallclockTimeSourceBased) return NaN;
  // Recent replays can retain Unix-time captions. Match corresponding SDK
  // bounds; wallclock currentPosition can run ahead of the displayed picture.
  const offsets = ['seekLowerBound', 'seekUpperBound', 'bufferLowerBound', 'bufferUpperBound']
    .filter(key => Number.isFinite(content[key]) && Number.isFinite(wall[key]))
    .map(key => wall[key] - content[key]);
  if (offsets.length < 2 || offsets[0] < 1e12 || offsets.some(value => Math.abs(value - offsets[0]) > 20)) return NaN;
  return offsets[0] / 1000;
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
    this.cache = new Map(); this.seen = new Set(); this.epoch = 0; this.validated = false; this.origin = null;
    this.coverageStart = NaN; this.coverageEnd = NaN;
    this.onCues = () => {}; this.stopped = true; this.busy = false; this.url = null;
  }
  start(onCues) { this.onCues = onCues; this.stopped = false; this.poll(); this.timer = setInterval(() => this.poll(), 1000); }
  coversTime(time) {
    return !this.stopped && this.validated && Number.isFinite(time) && time >= this.coverageStart && time < this.coverageEnd;
  }
  reset() {
    this.cache.clear(); this.seen.clear(); this.playlist = null; this.url = null; this.origin = null;
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
      const origin = vodWallclockOrigin(this.view);
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
      if (url !== this.url || (this.origin && (!Number.isFinite(origin) || Math.abs(origin - this.origin) > .02))) {
        this.reset(); this.url = url;
      }
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
          let cues = parseWebVtt(await this.fetchText(segment.url, controller.signal), {epoch:`tiled-${this.epoch}`});
          if (cues.length) {
            const cueOrigin = cues.some(c => c.start >= 1e9) ? origin : 0;
            if (!Number.isFinite(cueOrigin) || (this.origin !== null && Math.abs(cueOrigin - this.origin) > .02)) throw Error('VOD_CLOCK');
            cues = cues.map(c => ({ ...c, start: Math.round((c.start - cueOrigin) * 1000) / 1000,
              end: Math.round((c.end - cueOrigin) * 1000) / 1000 }));
            if (cues.some(c => c.end < segment.start - 120 || c.start > segment.end + 120)) throw Error('VOD_CLOCK');
            this.origin = cueOrigin;
          }
          this.cache.set(segment.sequence, cues);
        }
      }
      if (this.stopped) return;
      if (this.origin && (!Number.isFinite(vodWallclockOrigin(this.view)) || Math.abs(vodWallclockOrigin(this.view) - this.origin) > .02)) throw Error('VOD_CLOCK');
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
      if (!this.stopped) this.onStatus({available:false, message:controller.signal.aborted ? '字幕读取超时，保留官方字幕'
        : error.message === 'VOD_CLOCK' ? '回放字幕时钟尚未匹配，保留官方英文'
        : '字幕读取或校准失败；请确认官网英文已开启、当前为回放且可播放'});
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

// src/track-fx-cues.js
const cleanText = value => String(value || '').replace(/\s+/g, ' ').trim();
const comparableText = value => cleanText(value).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

function hash(value) {
  let result = 2166136261;
  for (let i = 0; i < value.length; i++) result = Math.imul(result ^ value.charCodeAt(i), 16777619);
  return (result >>> 0).toString(36);
}

function similarText(a, b) {
  const left = comparableText(a), right = comparableText(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (Math.min(left.length, right.length) < 6) return false;
  if ((left.includes(right) || right.includes(left)) && Math.min(left.length, right.length) / Math.max(left.length, right.length) >= .55) return true;
  const pairs = value => new Set(Array.from({ length: value.length - 1 }, (_, i) => value.slice(i, i + 2)));
  const aPairs = pairs(left), bPairs = pairs(right);
  const common = [...aPairs].filter(pair => bPairs.has(pair)).length;
  return (2 * common) / (aPairs.size + bPairs.size) >= .78;
}

/** First delivery wins: neighbouring windows cannot rewrite a visible sentence. */
function mergeTrackFxCues(existing, incoming, scope = 'track-fx') {
  const cues = [...existing], added = [];
  for (const candidate of incoming) {
    const text = cleanText(candidate.text);
    if (!text || !Number.isFinite(candidate.start) || !Number.isFinite(candidate.end) || candidate.end <= candidate.start) continue;
    const duplicate = cues.some(cue => {
      const overlap = Math.min(cue.end, candidate.end) - Math.max(cue.start, candidate.start);
      const near = overlap >= Math.min(cue.end - cue.start, candidate.end - candidate.start) * .25
        || Math.abs(cue.start - candidate.start) <= 1.2;
      return near && similarText(cue.text, text);
    });
    if (duplicate) continue;
    const cue = Object.freeze({ ...candidate, text, source: 'track-fx',
      id: `fx:${scope}:${Math.round(candidate.start * 1000)}:${hash(comparableText(text))}` });
    cues.push(cue); added.push(cue);
  }
  return { cues, added };
}

/** Hold possible cut-off speech until the next overlapping window has returned. */
function settleTrackFxWindowCues(window, windows) {
  const next = windows.find(item => item.start > window.start && item.start < window.end && item.end > window.end);
  return window.rawCues.flatMap(cue => {
    if (window.terminal || cue.end < window.end - .4) return [cue];
    if (!next) return [];
    const fuller = next.rawCues.find(candidate => candidate.end < next.end - .4
      && Math.min(candidate.end, cue.end) > Math.max(candidate.start, cue.start)
      && similarText(candidate.text, cue.text) && cleanText(candidate.text).length >= cleanText(cue.text).length);
    // A sentence longer than the overlap can still be cut in both windows.
    // After waiting one full window, retain the original instead of fabricating
    // missing words or extending its time range without recognition evidence.
    return [fuller || cue];
  });
}


// src/track-fx-source.js

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
function parseTrackFxPlaylist(text, baseUrl, { eventType = 'vod', origin, contentDuration } = {}) {
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
function planTrackFxWindows(playlist, time, { aheadSeconds = 60, windowSeconds = 30, overlapSeconds = 10 } = {}) {
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

function isTrackFxSeek(previous, current, playbackRate = 1) {
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

class TrackFxSource {
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
class TrackFxContinuousSource extends TrackFxSource {
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

// src/capture-mode.js
// Explicit replay mode keeps VOD test captions separate from live captions.
function capturePageInfo(href) {
  try {
    const url = new URL(href), id = /^\/detail\/(\d+)(?:\/|$)/.exec(url.pathname)?.[1];
    if (url.origin !== 'https://f1tv.formula1.com' || !id) return null;
    const replay = url.searchParams.get('f1zh-replay') === '1';
    return { programmeId: `${id}:${replay ? 'vod-test' : 'live'}`, mode: replay ? 'vod-test' : 'live', replay,
      collector: ['f1zh-capture', 'f1zh-audio'].some(key => url.searchParams.get(key) === '1') };
  } catch { return null; }
}
function validCaptureClock(value, capture) {
  return value?.collector === true && value.programmeId === capture.programmeId
    && ['time', 'origin', 'at', 'rate', 'epoch'].every(key => Number.isFinite(value[key]))
    && value.time >= 0 && value.at >= 0 && typeof value.paused === 'boolean' && typeof value.muted === 'boolean'
    && (capture.mode === 'vod-test' ? value.eventType === 'vod' && value.origin === 0
      : capture.mode === 'live' && value.eventType === 'live' && value.origin > 1e9);
}
function captureStartProblem(page, snapshot) {
  if (!snapshot) return '扩展未收到脚本响应，请更新脚本并刷新此页。';
  if (snapshot.eventType === 'vod' && !page?.replay) return '这是回放，请先在观看页控制台展开“用录播测试 TR”，再点击“开始录播测试”。';
  if (!snapshot.collector || !page?.collector) return '这是观看页；请在脚本控制台点击“打开声音采集页”，并在新页准备 Track FX。';
  if (!validCaptureClock(snapshot, page)) return '扩展未取得匹配的官方节目时间，请确认两页已更新脚本并选择同一节目。';
  if (!snapshot.trackFx) return '当前音轨不是 Track FX，请先点“准备 Track FX”或在官网选择 Track FX。';
  if (snapshot.paused || snapshot.muted || Math.abs(snapshot.rate - 1) > .01) return '请保持采集页正常音量、1 倍速并播放 Track FX。';
  if (!page.replay && (!Number.isFinite(snapshot.behindLive) || snapshot.behindLive > 15)) return '采集页尚未接近直播前沿，请先点“准备 Track FX”。';
  return null;
}

// src/programme-relay.js
const programmeRelayVersion = 1;
const programmeRelayHeartbeatMs = 2000;
// Background tabs may deliver timers only once a minute. A missed heartbeat is
// a connection warning, never an instruction to pause either player.
const programmeRelayLeaseMs = 120000;
const programmeRelayHistoryMs = 10 * 60 * 1000;
const programmeRelayMaxCache = 600;
const programmeRelayBatchSize = 32;
const programmeRelayMaxMessageChars = 200000;
const programmeRelayStates = new Set(['idle', 'starting', 'capturing', 'paused', 'preparing', 'ready', 'stopped', 'error']);
const programmeRelayIdPattern = /^[A-Za-z0-9_-]{1,100}$/;
const programmeRelayProgrammePattern = /^[A-Za-z0-9_:-]{1,120}$/;
const programmeRelayMaxTime = 10000000000;

function programmeRelayObject(value, keys) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => keys.includes(key));
}

function programmeRelayCue(value, strict = false) {
  if (!value || typeof value !== 'object' || (strict && !programmeRelayObject(value, ['id', 'start', 'end', 'text', 'zh', 'status']))) return null;
  if (typeof value.id !== 'string' || !value.id.trim() || value.id.length > 160
    || !Number.isFinite(value.start) || !Number.isFinite(value.end) || value.start < 0 || value.end <= value.start
    || value.end > programmeRelayMaxTime || value.end - value.start > 600
    || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 2048
    || value.status !== 'ready' || typeof value.zh !== 'string' || value.zh.length > 4096
    || !/[\u3400-\u9fff\uf900-\ufaff]/u.test(value.zh)) return null;
  return { id: value.id, start: value.start, end: value.end, text: value.text, zh: value.zh, status: 'ready' };
}

function programmeRelayStatus(value) {
  if (!programmeRelayObject(value, ['state', 'message', 'contentTime', 'capturedUntil'])
    || !programmeRelayStates.has(value.state) || typeof value.message !== 'string' || value.message.length > 240) return null;
  for (const key of ['contentTime', 'capturedUntil']) {
    if (value[key] !== null && (!Number.isFinite(value[key]) || value[key] < 0 || value[key] > programmeRelayMaxTime)) return null;
  }
  return { state: value.state, message: value.message, contentTime: value.contentTime, capturedUntil: value.capturedUntil };
}

function programmeRelayActive(status) {
  return status && !['idle', 'stopped', 'error'].includes(status.state);
}

function programmeRelayViewerState(value) {
  if (!programmeRelayObject(value, ['contentTime', 'paused', 'enabled']) || typeof value.paused !== 'boolean' || typeof value.enabled !== 'boolean'
    || (value.contentTime !== null && (!Number.isFinite(value.contentTime) || value.contentTime < 0 || value.contentTime > programmeRelayMaxTime))
    || (value.enabled && value.contentTime === null)) return null;
  return { contentTime: value.contentTime, paused: value.paused, enabled: value.enabled };
}

class ProgrammeRelay {
  constructor({ programmeId, role = 'viewer', onCues = () => {}, onStatus = () => {}, onViewerState = () => {}, channelFactory, now = () => Date.now() } = {}) {
    if (typeof programmeId !== 'string' || !programmeRelayProgrammePattern.test(programmeId)) throw new TypeError('Invalid programme ID');
    if (!['viewer', 'collector'].includes(role)) throw new TypeError('Invalid relay role');
    this.programmeId = programmeId;
    this.role = role;
    this.onCues = onCues;
    this.onStatus = onStatus;
    this.onViewerState = onViewerState;
    this.now = now;
    this.id = `p${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
    this.cache = new Map();
    this.seen = new Map();
    this.collectors = new Map();
    this.viewers = new Map();
    this.selected = null;
    this.selectedViewer = null;
    this.viewerDisconnected = false;
    this.closed = false;
    this.status = { state: 'starting', message: '', contentTime: null, capturedUntil: null };
    this.viewerState = { contentTime: null, paused: true, enabled: false };
    this.lastTick = now();
    this.channel = (channelFactory || (name => new BroadcastChannel(name)))(`f1zh-programme-v1-${programmeId}`);
    this.channel.onmessage = event => this.receive(event.data);
    if (role === 'collector') {
      this.onViewerState({ ...this.viewerState, connected: false, viewerId: null });
      this.send('status', { status: this.status });
    }
    else {
      this.reportDisconnected('disconnected', '等待采集页连接');
      this.send('hello');
    }
    this.timer = setInterval(() => this.tick(), programmeRelayHeartbeatMs);
    this.timer.unref?.();
  }

  send(type, payload = {}, target) {
    if (this.closed) return;
    const message = { version: programmeRelayVersion, type, programmeId: this.programmeId, sender: this.id, ...payload };
    if (target) message.target = target;
    this.channel.postMessage(message);
  }

  prune() {
    const earliest = this.now() - programmeRelayHistoryMs;
    for (const [id, entry] of this.cache) if (entry.at < earliest) this.cache.delete(id);
    while (this.cache.size > programmeRelayMaxCache) this.cache.delete(this.cache.keys().next().value);
    for (const [id, at] of this.seen) if (at < earliest) this.seen.delete(id);
    while (this.seen.size > programmeRelayMaxCache * 2) this.seen.delete(this.seen.keys().next().value);
  }

  sendCues(cues, target) {
    let batch = [], size = 512;
    for (const cue of cues) {
      const length = JSON.stringify(cue).length + 1;
      if (batch.length && (batch.length >= programmeRelayBatchSize || size + length > programmeRelayMaxMessageChars)) {
        this.send('cues', { cues: batch }, target);
        batch = [];
        size = 512;
      }
      batch.push(cue);
      size += length;
    }
    if (batch.length) this.send('cues', { cues: batch }, target);
  }

  publish(cues) {
    if (this.closed || this.role !== 'collector' || !Array.isArray(cues) || !programmeRelayActive(this.status)) return;
    this.prune();
    const fresh = [];
    for (const input of cues.slice(-programmeRelayMaxCache)) {
      const cue = programmeRelayCue(input);
      if (!cue || this.cache.has(cue.id)) continue;
      this.cache.set(cue.id, { cue, at: this.now() });
      fresh.push(cue);
    }
    this.prune();
    this.sendCues(fresh);
  }

  setStatus(value = {}) {
    if (this.closed || this.role !== 'collector' || !programmeRelayObject(value, ['state', 'message', 'contentTime', 'capturedUntil'])) return;
    const status = programmeRelayStatus({ ...this.status, ...value });
    if (!status) return;
    this.status = status;
    this.send('status', { status });
  }

  setViewerState(value) {
    if (this.closed || this.role !== 'viewer') return;
    const state = programmeRelayViewerState(value);
    if (!state) return;
    const reenabled = state.enabled && !this.viewerState.enabled;
    this.viewerState = state;
    if (reenabled) this.seen.clear();
    // An explicit OFF also reaches a previous collector whose heartbeat was
    // delayed when the viewer selected a replacement.
    this.send('viewer-status', { viewerState: state }, state.enabled ? this.selected : undefined);
    // The viewer may have ignored cues while its TR switch was off.
    if (reenabled) this.send('hello', {}, this.selected);
  }

  selectViewer(sender) {
    const entry = this.viewers.get(sender);
    if (!entry?.state.enabled) return;
    this.selectedViewer = sender;
    this.viewerDisconnected = false;
    this.onViewerState({ ...entry.state, connected: true, viewerId: sender });
  }

  selectAvailableViewer() {
    const current = this.now();
    const latest = [...this.viewers.entries()].filter(([, value]) => current - value.at < programmeRelayLeaseMs && value.state.enabled)
      .sort((a, b) => b[1].at - a[1].at)[0];
    if (latest) this.selectViewer(latest[0]);
  }

  disconnectViewer() {
    this.onViewerState({ connected: false, viewerId: this.selectedViewer, contentTime: null, paused: true, enabled: false, reason: 'disabled' });
    this.selectedViewer = null;
    this.viewerDisconnected = false;
    this.selectAvailableViewer();
  }

  expireViewer() {
    const entry = this.viewers.get(this.selectedViewer);
    if (!entry) return;
    if (!this.viewerDisconnected) {
      this.viewerDisconnected = true;
      // Preserve the last explicit enabled command and sender identity. That
      // viewer can still turn capture off when its background tab wakes up.
      this.onViewerState({ ...entry.state, connected: false, viewerId: this.selectedViewer, reason: 'timeout' });
    }
    this.selectAvailableViewer();
  }

  reportDisconnected(state, message, collectorId = this.selected) {
    this.onStatus({ connected: false, collectorId, state, message, contentTime: null, capturedUntil: null });
  }

  select(sender, requestHistory = true) {
    const entry = this.collectors.get(sender);
    if (!entry || !programmeRelayActive(entry.status)) return;
    if (this.selected !== sender) this.seen.clear();
    this.selected = sender;
    this.onStatus({ ...entry.status, connected: true, collectorId: sender });
    this.send('viewer-status', { viewerState: this.viewerState }, sender);
    if (requestHistory) this.send('hello', {}, sender);
  }

  selectAvailable() {
    const current = this.now();
    const latest = [...this.collectors.entries()].filter(([, value]) => current - value.at < programmeRelayLeaseMs && programmeRelayActive(value.status))
      .sort((a, b) => b[1].at - a[1].at)[0];
    if (latest) this.select(latest[0]);
  }

  receive(message) {
    if (this.closed || !programmeRelayObject(message, ['version', 'type', 'programmeId', 'sender', 'target', 'status', 'cues', 'viewerState'])
      || message.version !== programmeRelayVersion || message.programmeId !== this.programmeId
      || typeof message.sender !== 'string' || !programmeRelayIdPattern.test(message.sender) || message.sender === this.id
      || (message.target !== undefined && (typeof message.target !== 'string' || !programmeRelayIdPattern.test(message.target) || message.target !== this.id))) return;
    if (message.type === 'hello') {
      if ('status' in message || 'cues' in message || 'viewerState' in message || this.role !== 'collector') return;
      this.prune();
      this.send('status', { status: this.status }, message.sender);
      if (programmeRelayActive(this.status)) this.sendCues([...this.cache.values()].map(value => value.cue), message.sender);
      return;
    }
    if (message.type === 'viewer-release') {
      if (this.role !== 'collector' || 'status' in message || 'cues' in message || 'viewerState' in message) return;
      this.viewers.delete(message.sender);
      if (this.selectedViewer === message.sender) {
        this.selectedViewer = null;
        this.viewerDisconnected = false;
        this.selectAvailableViewer();
      }
      return;
    }
    if (message.type === 'viewer-status') {
      if (this.role !== 'collector' || 'status' in message || 'cues' in message) return;
      const state = programmeRelayViewerState(message.viewerState);
      if (!state) return;
      this.viewers.delete(message.sender);
      this.viewers.set(message.sender, { state, at: this.now() });
      if (this.viewers.size > 16) this.viewers.delete([...this.viewers.keys()].find(id => id !== this.selectedViewer));
      if (this.selectedViewer === message.sender) {
        if (state.enabled) this.selectViewer(message.sender);
        else this.disconnectViewer();
      } else if ((!this.selectedViewer || this.viewerDisconnected) && state.enabled) this.selectViewer(message.sender);
      return;
    }
    if (this.role !== 'viewer') return;
    if (message.type === 'status') {
      if ('cues' in message || 'viewerState' in message) return;
      const status = programmeRelayStatus(message.status);
      if (!status) return;
      this.collectors.delete(message.sender);
      this.collectors.set(message.sender, { status, at: this.now() });
      if (this.collectors.size > 16) {
        const expendable = [...this.collectors.keys()].find(id => id !== this.selected);
        this.collectors.delete(expendable);
      }
      if (this.selected === message.sender) {
        if (programmeRelayActive(status)) this.onStatus({ ...status, connected: true, collectorId: message.sender });
        else {
          this.reportDisconnected(status.state, status.message, message.sender);
          this.selected = null;
          this.selectAvailable();
        }
      } else if (!this.selected && programmeRelayActive(status)) this.select(message.sender, !message.target);
      return;
    }
    if (message.type !== 'cues' || 'status' in message || 'viewerState' in message || message.sender !== this.selected
      || !Array.isArray(message.cues) || message.cues.length > programmeRelayBatchSize) return;
    if (this.now() - this.collectors.get(this.selected).at >= programmeRelayLeaseMs) return;
    const cues = message.cues.map(value => programmeRelayCue(value, true));
    if (cues.some(value => !value) || JSON.stringify(message).length > programmeRelayMaxMessageChars) return;
    const fresh = [];
    for (const cue of cues) {
      if (this.seen.has(cue.id)) continue;
      this.seen.set(cue.id, this.now());
      fresh.push(cue);
    }
    this.prune();
    if (fresh.length) this.onCues(fresh, { collectorId: message.sender });
  }

  tick() {
    if (this.closed) return;
    this.prune();
    const current = this.now();
    if (this.role === 'viewer' && this.selected && current - this.collectors.get(this.selected).at >= programmeRelayLeaseMs) {
      this.reportDisconnected('disconnected', '采集页已失去连接');
      this.selected = null;
      this.selectAvailable();
    }
    if (this.role === 'collector' && this.selectedViewer && current - this.viewers.get(this.selectedViewer).at >= programmeRelayLeaseMs) this.expireViewer();
    if (current - this.lastTick < programmeRelayHeartbeatMs) return;
    this.lastTick = current;
    if (this.role === 'collector') this.send('status', { status: this.status });
    else {
      this.send('viewer-status', { viewerState: this.viewerState }, this.selected);
      if (!this.selected) this.send('hello');
    }
  }

  close({ disableViewer = true } = {}) {
    if (this.closed) return;
    if (this.role === 'collector') this.setStatus({ state: 'stopped', message: '采集页已停止' });
    else if (disableViewer) this.setViewerState({ ...this.viewerState, enabled: false });
    // Rebinding the viewer's player must hand off ownership without cancelling
    // the live collector or waiting for the old viewer's heartbeat to expire.
    else this.send('viewer-release');
    this.closed = true;
    clearInterval(this.timer);
    this.channel.onmessage = null;
    this.channel.close();
    this.cache.clear();
    this.seen.clear();
    this.collectors.clear();
    this.viewers.clear();
  }
}

// src/extension-bridge.js
const extensionPageOrigin = 'https://f1tv.formula1.com';
// Tampermonkey's granted window is a sandbox wrapper. MessageEvent.source is
// the page WindowProxy, so comparing it only with that wrapper drops valid
// extension messages (including both the handshake and snapshot requests).
const extensionPageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
function postExtensionMessage(message) {
  extensionPageWindow.postMessage({ f1zhPage: 1, ...message }, extensionPageOrigin);
}
function listenExtensionMessages(receive) {
  const listener = event => {
    if ((event.source === extensionPageWindow || event.source === window)
        && event.origin === extensionPageOrigin && event.data?.f1zhExtension === 1) receive(event.data);
  };
  extensionPageWindow.addEventListener('message', listener);
  return () => extensionPageWindow.removeEventListener('message', listener);
}
function extensionSnapshotFailure(collector) {
  // The script did respond: do not let an SDK read failure masquerade as an
  // absent/outdated script. Never expose SDK exceptions or media URLs.
  return { protocol: 1, collector, pageLabel: collector ? '采集页' : '观看页', problem: null,
    startProblem: '脚本已连接，但未能读取官网播放器状态。请等待播放器加载完成后重试。' };
}
function createExtensionRelayChannel(programmeId) {
  const channel = { onmessage: null, postMessage(packet) { postExtensionMessage({ type: 'relay', packet }); }, close: null };
  channel.close = listenExtensionMessages(message => {
    if (message.type === 'relay' && message.packet?.programmeId === programmeId) channel.onmessage?.({ data: message.packet });
  });
  return channel;
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
      const draw = () => this.draw();
      listen(video, 'seeking', () => {
        for (const layer of this.layers) layer.timeline.seek();
        this.draw();
      });
      listen(video, 'timeupdate', draw);
      listen(document, 'fullscreenchange', draw);
      this.timer = setInterval(draw, 80);
      document.body.append(this.host);
      this.setStyle(style); this.setOpacity(opacity);
    }
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
  renderLayer(wall) {
    const time = this.getTime();
    if (Number.isFinite(this.lastTime) && Math.abs((time-this.lastTime)-(wall-this.lastWall)) > 1) this.timeline.seek();
    this.lastTime = time; this.lastWall = wall;
    const state = this.timeline.render(time);
    const text = state.text ? this.prefix + state.text : '';
    if (this.label.textContent !== text) this.label.textContent = text;
    if (this.above) this.line.hidden = !text;
    else this.line.style.visibility = text ? 'visible' : 'hidden';
    this.line.dataset.language = state.hasEnglish ? 'en' : 'zh';
    return state;
  }
  draw() {
    if (this.disposed || this.root.disposed) return;
    if (this !== this.root) return this.root.draw();
    const wall = performance.now()/1000;
    const rendered = [...this.layers].map(layer => [layer, layer.renderLayer(wall)]);
    this.layout();
    const visible = this.host.style.display === 'block';
    for (const [layer, state] of rendered) {
      if (!layer.disposed) layer.onRender(visible && state.text ? state : {lines:[],text:'',hasEnglish:false});
    }
  }
  dispose() {
    if (this.disposed) return;
    const layers = this === this.root ? [...this.layers] : [this];
    for (const layer of layers) layer.disposed = true;
    if (this === this.root) {
      clearInterval(this.timer); this.endDrag(); this.events.abort();
      this.layers.clear(); this.host.remove();
    } else { this.root.layers.delete(this); this.line.remove(); this.root.layout(); }
    for (const layer of layers) layer.onRender({lines:[],text:'',hasEnglish:false});
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

// src/asr-client.js
// Read finalized sentences as they arrive. Never expose partial ASR hypotheses.
// The injected transport is GM_xmlhttpRequest; API credentials stay on localhost.
function createAsrRequester(request, { service, getToken, timeoutMs = 30000, path = '/api/asr' }) {
  return (payload, signal, onCue = () => {}) => new Promise((resolve, reject) => {
    let handle, reader, finished = false, reading = false, seenChars = 0;
    let pending = '', receivedChars = 0, result = null, httpStatus = 200;
    let diagnostics;
    const errorFor = code => Object.assign(Error(code), { code, diagnostics });
    const keepDiagnostics = value => {
      if (!value || !['connecting', 'starting', 'sending', 'recognizing'].includes(value.stage)) return;
      diagnostics = { stage: value.stage };
      for (const key of ['elapsedMs','audioMs','sentAudioMs','resultEvents','finalSentences','lastResultMs',
        'connectedMs','taskStartedMs','finishSentMs','firstResultMs']) {
        if (Number.isFinite(value[key]) && value[key] >= 0) diagnostics[key] = value[key];
      }
    };
    const safeCode = code => typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'ASR_INVALID_RESPONSE';
    const done = (code, value) => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (code) {
        try { handle?.abort(); } catch { /* Some older GM fetch transports cannot abort. */ }
        void reader?.cancel().catch(() => {});
        reject(errorFor(safeCode(code)));
      } else resolve(value);
    };
    const abort = () => done('CANCELLED');
    // Own timeout also covers GM implementations whose fetch mode ignores timeout.
    const timer = setTimeout(() => done('ASR_CLIENT_TIMEOUT'), timeoutMs);
    if (signal.aborted) return done('CANCELLED');
    signal.addEventListener('abort', abort, { once: true });
    const event = line => {
      if (!line.trim()) return;
      const item = JSON.parse(line);
      keepDiagnostics(item?.diagnostics || item?.error?.diagnostics);
      if (httpStatus !== 200) throw errorFor(httpStatus === 401 ? 'UNAUTHORIZED' : safeCode(item?.error?.code));
      if (item?.type === 'error' || item?.error) throw errorFor(safeCode(item.code || item.error.code));
      if (result) throw errorFor('ASR_INVALID_RESPONSE');
      if (item?.type === 'progress') {
        if (!diagnostics) throw errorFor('ASR_INVALID_RESPONSE');
      } else if (item?.type === 'cue') {
        const cue = item.cue;
        if (typeof cue?.text !== 'string' || !cue.text.trim() || cue.text.length > 3000 ||
            !Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0 || cue.end <= cue.start) {
          throw errorFor('ASR_INVALID_RESPONSE');
        }
        onCue(cue);
      } else if ((item?.type === 'done' || !item?.type) && Array.isArray(item?.cues) && item.cues.length <= 1000) {
        result = { cues: item.cues, usage: item.usage };
        for (const key of ['sessionId', 'cursor', 'ended', 'diagnostics']) if (item[key] !== undefined) result[key] = item[key];
        // The application-level done event is authoritative, including silence.
        // Do not depend on the GM bridge also signaling EOF to finish the task.
        done(null, result);
        void reader?.cancel().catch(() => {});
      } else throw errorFor('ASR_INVALID_RESPONSE');
    };
    const consume = text => {
      if (finished || !text) return;
      receivedChars += text.length;
      if (receivedChars > 2_000_000) throw errorFor('ASR_INVALID_RESPONSE');
      pending += text;
      let newline;
      while (!finished && (newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        event(line);
      }
    };
    const complete = () => {
      if (finished) return;
      if (pending.trim()) event(pending);
      pending = '';
      if (!result) throw errorFor('ASR_INVALID_RESPONSE');
      done(null, result);
    };
    const fail = error => done(error?.name === 'AbortError' ? 'CANCELLED' : error?.code || 'ASR_INVALID_RESPONSE');
    const readStream = async response => {
      reading = true; httpStatus = response.status || 200;
      try {
        reader = response.response.getReader();
        const decoder = new TextDecoder();
        while (!finished) {
          const chunk = await reader.read();
          if (finished) break;
          if (chunk.done) { consume(decoder.decode()); complete(); break; }
          consume(typeof chunk.value === 'string' ? chunk.value : decoder.decode(chunk.value, { stream: true }));
        }
      } catch (error) { fail(error); }
      finally { try { reader?.releaseLock(); } catch { /* A canceled read may still be pending. */ } }
    };
    const progress = response => {
      if (finished || reading || typeof response.responseText !== 'string') return;
      httpStatus = response.status || httpStatus;
      const text = response.responseText;
      if (text.length < seenChars) throw errorFor('ASR_INVALID_RESPONSE');
      const tail = text.slice(seenChars); seenChars = text.length; consume(tail);
    };
    try {
      handle = request({ method: 'POST', url: `${service}${path}`, anonymous: true,
        responseType: 'stream', timeout: timeoutMs,
        headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson', Authorization: `Bearer ${getToken()}`,
          'X-F1ZH-ASR-Diagnostics': '1' },
        data: JSON.stringify(payload),
        onloadstart: response => { if (!finished && response.response?.getReader) void readStream(response); },
        onprogress: response => { try { progress(response); } catch (error) { fail(error); } },
        onload: response => {
          if (finished || reading) return;
          if (response.response?.getReader) { void readStream(response); return; }
          try { progress(response); complete(); } catch (error) { fail(error); }
        },
        onerror: () => done('LOCAL_SERVICE_UNAVAILABLE'), ontimeout: () => done('ASR_CLIENT_TIMEOUT'), onabort: abort
      });
      if (finished) { try { handle?.abort(); } catch { /* Synchronous transport failure. */ } }
    } catch { done('LOCAL_SERVICE_UNAVAILABLE'); }
  });
}

// src/radio-client.js

function createRadioClient(request, options) {
  const rpc = createAsrRequester(request, { ...options, path: '/api/radio' });
  let cancellation = Promise.resolve();
  return {
    async open({ start, signal, onCue }) {
      await cancellation;
      const controller = new AbortController();
      let sessionId, cursor = 0, stopped = false, resolveDone, rejectDone, failure;
      const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
      done.catch(() => {});
      const cancel = () => {
        if (stopped) return; stopped = true; controller.abort();
        signal?.removeEventListener('abort', cancel);
        rejectDone(Object.assign(Error('CANCELLED'), { code: 'CANCELLED' }));
        if (sessionId) cancellation = rpc({ action: 'cancel', sessionId }, new AbortController().signal).catch(() => {});
      };
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      try {
        const opened = await rpc({ action: 'open', start }, controller.signal);
        if (typeof opened.sessionId !== 'string') throw Error('ASR_INVALID_RESPONSE');
        sessionId = opened.sessionId;
        void (async () => {
          try {
            while (!stopped) {
              const result = await rpc({ action: 'poll', sessionId, cursor }, controller.signal, cue => { if (!stopped) onCue(cue); });
              if (!Number.isSafeInteger(result.cursor) || result.cursor < cursor) throw Error('ASR_INVALID_RESPONSE');
              cursor = result.cursor;
              if (result.ended) {
                stopped = true; signal?.removeEventListener('abort', cancel); resolveDone(result); return;
              }
            }
          } catch (error) { if (!stopped) { failure = error; rejectDone(error); cancel(); } }
        })();
        return { done, cancel,
          async append(payload) { try { return await rpc({ ...payload, action: 'append', sessionId }, controller.signal); } catch (error) { throw failure || error; } },
          async finish() { try { await rpc({ action: 'finish', sessionId }, controller.signal); return await done; } catch (error) { throw failure || error; } },
        };
      } catch (error) { cancel(); throw error; }
    }
  };
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
let token = GM_getValue('localServiceToken', '');
const PREPARATION_SECONDS = 45;
const PREPARATION_LOOKAHEAD = 60;
// Historical 30 s samples needed up to 12.26 s AFTER capture to recognize and
// translate. This is a starting allowance, not a measured live latency bound.
const LIVE_VIEW_DELAY_SECONDS = 50;
const savedTransparency = Number(GM_getValue('subtitleTransparency', 0));
let subtitleTransparency = Number.isFinite(savedTransparency) ? Math.max(0, Math.min(100, savedTransparency)) : 0;
let subtitleStyle = normalizeSubtitleStyle(GM_getValue('subtitleStyle', {}));
let subtitlePosition = GM_getValue('subtitlePosition', null);
let session = null;
let collectorSession = null;
let extensionBridgeIssue = null;
let collectorWindow = null;
let collectorWindowProgrammeId = null;
const collectorMode = ['f1zh-capture', 'f1zh-audio'].some(key => new URL(location.href).searchParams.get(key) === '1');
const replaySimulation = new URL(location.href).searchParams.get('f1zh-replay') === '1';
let enabled = false;
let radioEnabled = false;
let currentPage = location.href;
const panel = document.createElement('div'); panel.dataset.f1zh = 'controls';
panel.style.cssText = 'position:fixed;right:18px;top:18px;z-index:2147483647;';
const shadow = panel.attachShadow({mode:'open'});
shadow.innerHTML = `<style>
:host{all:initial;color-scheme:dark}[hidden]{display:none!important}*{box-sizing:border-box}
section{color:#E5EDF4;background:#162331fa;border:1px solid #33495E;border-radius:12px;padding:18px;font:400 13px/1.6 "Microsoft YaHei",system-ui,sans-serif;width:min(340px,calc(100vw - 16px));max-height:calc(100vh - 16px);overflow:auto;box-shadow:0 12px 36px #0003;font-synthesis:none}
button,input,select{font:inherit}button{cursor:pointer;background:#1D2C3C;border:1px solid #33495E;border-radius:8px;color:#E5EDF4;padding:9px 12px;transition:background .15s,border-color .15s}
button:hover:enabled{background:#263A4B;border-color:#577387}button:disabled{cursor:default;opacity:.5}button:focus-visible,summary:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid #83DCC5;outline-offset:3px}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;cursor:grab;touch-action:none;user-select:none}h1{margin:0;font-size:20px;line-height:1.4;font-weight:400}.eyebrow{color:#A9BACB;font-size:11px;margin:0 0 3px}
p{margin:0;overflow-wrap:anywhere}small,.muted{color:#A9BACB}.role-description{color:#A9BACB;font-size:12px;margin:0 0 16px}
#minimize{flex:none;margin:0;padding:0;width:30px;height:30px;font-size:20px;line-height:1}
.switches{border:1px solid #33495E;border-radius:10px;background:#1D2C3C;padding:0 12px;margin-bottom:14px}.switch-control{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;padding:13px 0;border:0;border-radius:0;background:transparent;text-align:left}.switch-control+button{border-top:1px solid #33495E}.switch-control:hover:enabled{background:transparent}.switch-control:focus-visible{outline-offset:1px;border-radius:6px}
.switch-track{display:block;flex:none;width:42px;height:24px;padding:3px;border-radius:20px;background:#405365;transition:background .15s}.switch-track i{display:block;width:18px;height:18px;border-radius:50%;background:#C4D0DC;transition:transform .15s}.switch-control[aria-checked=true] .switch-track{background:#83DCC5}.switch-control[aria-checked=true] .switch-track i{background:#162331;transform:translateX(18px)}
#preparation{display:flex;align-items:center;gap:8px;width:100%;font-weight:400;background:#1D2C3C;color:#A9BACB;border:1px solid #33495E;border-radius:8px;padding:10px 12px}#preparation:before{content:"";flex:none;width:7px;height:7px;border-radius:50%;background:currentColor}
#preparation[data-state=preparing]{color:#C8D7E4}#preparation[data-state=ready]{color:#83DCC5;background:#83DCC50c;border-color:#83DCC540}
#preparation-detail{color:#A9BACB;font-size:12px;margin:9px 0 0;font-variant-numeric:tabular-nums}#status,#radio-status{color:#A9BACB;font-size:12px;line-height:1.7;margin-top:9px}#status:empty,#radio-status:empty{display:none}#radio-status{border-top:1px solid #33495E;padding-top:9px}.translation-issue{margin-top:10px;padding:9px 11px;border:1px solid #D8BB8540;border-radius:8px;color:#E4C791;background:#D8BB850a;font-size:12px}
details{margin:14px 0 0;border:1px solid #33495E;border-radius:10px;padding:10px 12px;background:#1D2C3C}summary{cursor:pointer;user-select:none}.style-option,.opacity{display:flex;align-items:center;gap:10px;margin:12px 0;font-size:12px}.style-option select{flex:1;min-width:0;background:#162331;color:#E5EDF4;border:1px solid #33495E;border-radius:6px;padding:5px 7px}.style-option input[type=range],.opacity input{flex:1;min-width:0;accent-color:#83DCC5}.style-option input[type=checkbox]{accent-color:#83DCC5}.style-option output,.opacity output{min-width:4ch;text-align:right;font-variant-numeric:tabular-nums}details small{display:block;font-size:11px;line-height:1.7}
.panel-action{width:100%;margin-top:10px}.panel-action.primary{border-color:#83DCC570;color:#83DCC5;background:#83DCC50a}.panel-action.primary:hover:enabled{border-color:#83DCC5;background:#83DCC516}.playback-status{color:#A9BACB;font-size:11px;margin-top:6px}.secondary-details{padding:8px 0;background:transparent;border:0;color:#A9BACB;font-size:12px}.secondary-details .panel-action{font-size:12px}.secondary-details p{margin-top:8px}
.capture-hint{color:#A9BACB;font-size:11px;line-height:1.7;margin-top:14px;padding-top:12px;border-top:1px solid #33495E}.panel-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:12px;font-size:11px;color:#A9BACB}.text-button{border:0;padding:2px 0;background:transparent;color:#A9BACB;font-size:12px}.text-button:hover:enabled{background:transparent;color:#83DCC5}.panel-footer span{font-variant-numeric:tabular-nums}
#ball{display:grid;place-items:center;width:40px;height:40px;margin:0;padding:0;border-radius:50%;background:#162331f5;border:1px solid #33495E;color:#83DCC5;box-shadow:0 3px 12px #0003;font:400 15px "Microsoft YaHei",sans-serif;cursor:grab;touch-action:none;user-select:none}:host([data-dragging]) header,:host([data-dragging]) #ball{cursor:grabbing}
@media(prefers-reduced-motion:reduce){button,.switch-track,.switch-track i{transition:none}}
</style><section id="console" aria-label="F1 TV 字幕控制台"><header id="drag-handle" title="拖动标题栏移动控制台"><div><p class="eyebrow">F1 TV 中文</p><h1 id="console-title">中文字幕</h1></div><button id="minimize" type="button" aria-label="最小化控制台" title="最小化为悬浮球">−</button></header><div class="switches"><button id="toggle" class="switch-control" type="button" role="switch" aria-label="中文字幕" aria-checked="false"><span>中文字幕</span><span class="switch-track" aria-hidden="true"><i></i></span></button><button id="radio-toggle" class="switch-control" type="button" role="switch" aria-label="TR 与采访字幕" aria-checked="false" disabled><span>TR / 采访</span><span class="switch-track" aria-hidden="true"><i></i></span></button></div><div id="preparation" data-state="waiting" role="status" aria-live="polite">字幕已关闭</div><p id="preparation-detail">开启后准备解说中文，目标 45 秒</p><label class="opacity" for="transparency" title="文字和底色一起变透明；0% 最清晰，100% 完全透明">透明度<input id="transparency" type="range" min="0" max="100" step="5"><output id="transparency-value" for="transparency"></output></label><p id="status">翻译已关闭</p><div id="panel-footer" class="panel-footer"><button id="pair" class="text-button" type="button">配对本机服务</button><span>v0.9.1</span></div></section><button id="ball" hidden aria-label="展开字幕控制台" title="点击展开；拖动后吸附左右边缘">中</button>`;
document.body.append(panel);
// Slider/button keyboard input belongs to this console, not the site's video shortcuts.
panel.addEventListener('keydown', event => event.stopPropagation());
panel.addEventListener('keyup', event => event.stopPropagation());
const button = shadow.getElementById('toggle'), status = shadow.getElementById('status');
const pairButton = shadow.getElementById('pair');
const radioButton = shadow.getElementById('radio-toggle');
const preparationButton = shadow.getElementById('preparation');
const preparationDetail = shadow.getElementById('preparation-detail');
const radioStatus = document.createElement('p');
radioStatus.id = 'radio-status';
radioStatus.textContent = 'TR / 采访随中文字幕开启，可单独开关';
status.after(radioStatus);
const collectorButton = document.createElement('button');
collectorButton.id = 'live-audio'; collectorButton.hidden = true;
collectorButton.textContent = '打开声音采集页';
collectorButton.className = 'panel-action primary';
collectorButton.title = '另开同一节目准备 Track FX；本页继续英语解说。声音采集由扩展面板开关控制';
radioStatus.after(collectorButton);
const playbackButton = document.createElement('button');
playbackButton.id = 'prepare-playback'; playbackButton.className = `panel-action${collectorMode ? ' primary' : ''}`;
playbackButton.textContent = collectorMode ? '准备 Track FX 并播放' : '预留 50 秒翻译时间';
playbackButton.title = collectorMode ? '选择 Track FX 并播放；随后在扩展面板中打开采集开关'
  : '调整观看位置到直播后方 50 秒；保留暂停或播放状态，不改变字幕时间戳';
collectorButton.after(playbackButton);
const replayOptions = document.createElement('details');
replayOptions.className = 'secondary-details'; replayOptions.hidden = true;
replayOptions.innerHTML = '<summary>用录播测试 TR</summary><p>没有直播时，可用同一段录播检查声音采集与字幕。此功能可选；切换模式会刷新当前页。</p>';
const replayButton = document.createElement('button');
replayButton.textContent = replaySimulation ? '退出录播测试' : '开始录播测试'; replayButton.hidden = true;
replayButton.className = 'panel-action'; replayOptions.append(replayButton);
playbackButton.after(replayOptions);
replayButton.addEventListener('click', () => {
  // A visible opt-in, before enabling translation, prevents VOD prefetch from
  // being mistaken for evidence that the extension captured the tab's audio.
  const url = new URL(location.href);
  if (replaySimulation) url.searchParams.delete('f1zh-replay');
  else url.searchParams.set('f1zh-replay', '1');
  url.searchParams.delete('f1zh-commentary');
  url.searchParams.delete('f1zh-capture'); url.searchParams.delete('f1zh-audio');
  setEnabled(false); location.href = url.href;
});
const playbackStatus = document.createElement('p');
playbackStatus.className = 'playback-status';
playbackButton.after(playbackStatus);
const roleDescription = document.createElement('p');
roleDescription.className = 'role-description';
roleDescription.textContent = collectorMode ? '采集页 · 只负责准备音轨，采集开关在扩展面板'
  : `${replaySimulation ? '回放模拟 · ' : ''}观看页 · English F1 Live + 英文字幕`;
shadow.querySelector('header').after(roleDescription);
const captureHint = document.createElement('p');
captureHint.className = 'capture-hint';
captureHint.textContent = '关闭字幕不会停止声音采集；请在扩展面板关闭采集开关。';
shadow.getElementById('panel-footer').before(captureHint);
const translationIssue = document.createElement('p');
translationIssue.hidden = true; translationIssue.className = 'translation-issue'; translationIssue.setAttribute('role', 'status');
status.after(translationIssue);
const translationMessages = {
  UNAUTHORIZED: '本机配对已失效，请点击下方“重新配对本机服务”。',
  LOCAL_SERVICE_UNAVAILABLE: '本机翻译服务连接失败，请打开 127.0.0.1:3847 检查服务是否运行。',
  LOCAL_SERVICE_TIMEOUT: '本机翻译请求超时，当前句保留英文。',
  BUSY: '本机翻译队列繁忙，当前句保留英文。',
  UPSTREAM_AUTH_FAILED: '翻译 API 认证失败，请检查本机密钥配置。',
  UPSTREAM_BALANCE: '翻译 API 返回余额不足（402）。',
  UPSTREAM_RATE_LIMITED: '翻译 API 返回限流（429），当前句保留英文；稍后关闭再开启翻译重试。',
  UPSTREAM_UNAVAILABLE: '本机服务无法连接翻译 API，或 API 暂时不可用。',
  UPSTREAM_REJECTED: '翻译 API 拒绝请求，请检查接口和模型配置。',
  TRANSLATION_TIMEOUT: '翻译 API 响应超时，当前句保留英文。',
  INVALID_UPSTREAM_RESPONSE: '翻译 API 未返回有效译文，当前句保留英文。'
};
function showTranslationIssue(code) {
  translationIssue.textContent = code ? translationMessages[code] || '翻译请求失败，当前句保留英文。' : '';
  translationIssue.hidden = !code;
}
const transparency = shadow.getElementById('transparency');
const transparencyValue = shadow.getElementById('transparency-value');
const stylePanel = document.createElement('details');
stylePanel.id = 'subtitle-style';
stylePanel.innerHTML = `<summary>字幕样式</summary><label class="style-option" for="subtitle-font">字体<select id="subtitle-font"><option value="yahei">微软雅黑</option><option value="heiti">黑体</option><option value="songti">宋体</option><option value="system">系统默认</option></select></label><label class="style-option" for="subtitle-size">字号<input id="subtitle-size" type="range" min="16" max="48" step="1"><output id="subtitle-size-value"></output></label><label class="style-option"><input id="subtitle-bold" type="checkbox">加粗</label><small>拖动任一字幕可一起移动；设置自动保存。</small>`;
const opacityRow = transparency.closest('label');
collectorButton.before(stylePanel); stylePanel.insertBefore(opacityRow, stylePanel.lastElementChild);
if (collectorMode) {
  shadow.getElementById('console-title').textContent = '声音采集';
  shadow.querySelector('.switches').hidden = true;
  radioButton.hidden = true; stylePanel.hidden = true;
  status.textContent = replaySimulation ? '先定位回放起点，再准备 Track FX。'
    : '先在官网选择 WATCH LIVE，再准备 Track FX。';
  radioStatus.textContent = '扩展面板显示声音输入、识别进度和中文缓存。';
  captureHint.textContent = '准备音轨会出声；扩展开启采集后本页静音，关闭采集后恢复声音。';
}
const fontControl = shadow.getElementById('subtitle-font'), sizeControl = shadow.getElementById('subtitle-size');
const boldControl = shadow.getElementById('subtitle-bold'), sizeValue = shadow.getElementById('subtitle-size-value');
fontControl.value = subtitleStyle.font; sizeControl.value = String(subtitleStyle.size); boldControl.checked = subtitleStyle.bold;
sizeValue.value = `${subtitleStyle.size}px`;
for (const control of [fontControl, sizeControl, boldControl]) {
  control.addEventListener('input', () => {
    subtitleStyle = normalizeSubtitleStyle({ font: fontControl.value, size: Number(sizeControl.value), bold: boldControl.checked });
    sizeValue.value = `${subtitleStyle.size}px`; session?.overlay.setStyle(subtitleStyle);
  });
  control.addEventListener('change', () => GM_setValue('subtitleStyle', subtitleStyle));
}
transparency.value = String(subtitleTransparency);
transparencyValue.value = `${subtitleTransparency}%`;
transparency.addEventListener('input', () => {
  subtitleTransparency = Number(transparency.value);
  transparencyValue.value = `${subtitleTransparency}%`;
  session?.overlay.setOpacity(1 - subtitleTransparency / 100);
});
transparency.addEventListener('change', () => GM_setValue('subtitleTransparency', subtitleTransparency));
const floatingControls = new FloatingControls(panel, {
  panel: shadow.getElementById('console'), handle: shadow.getElementById('drag-handle'),
  minimize: shadow.getElementById('minimize'), ball: shadow.getElementById('ball'),
  saved: GM_getValue(collectorMode ? 'collectorConsole' : 'floatingConsole', null),
  onSave: value => GM_setValue(collectorMode ? 'collectorConsole' : 'floatingConsole', value)
});

function preparationFor(current = session) {
  const time = current?.view ? tiledContentSeconds(current.view) : current?.video.currentTime;
  const source = current?.source;
  const cues = current ? current.store.sorted() : [];
  // Only confirmed source coverage can count silence as prepared time.
  const coverage = current?.sourceKind === 'native' ? cues.map(c => [c.start, c.end])
    : !source?.validated ? [] : source.coverage || [[source.coverageStart, source.coverageEnd]];
  return commentaryPreparation({enabled, time, coverage, cues, targetSeconds:PREPARATION_SECONDS});
}
function refreshControls() {
  refreshPlaybackStatus();
  pairButton.textContent = token ? '重新配对本机服务' : '配对本机服务';
  if (collectorMode) { refreshCollectorControls(); return; }
  button.setAttribute('aria-checked', String(enabled));
  button.title = enabled ? '关闭全部中文字幕；声音采集不受影响' : '开启中文字幕';
  radioButton.setAttribute('aria-checked', String(radioEnabled));
  radioButton.disabled = !enabled; radioButton.hidden = false;
  radioButton.title = enabled ? '只控制 TR / 采访中文字幕；不改变扩展采集开关' : '开启中文字幕后，可单独控制 TR / 采访';
  const prep = preparationFor();
  preparationButton.dataset.state = prep.state;
  const preparationLabel = !enabled ? '字幕已关闭' : {waiting:'等待解说字幕', preparing:'正在准备解说中文', ready:'解说中文已就绪'}[prep.state];
  if (preparationButton.textContent !== preparationLabel) preparationButton.textContent = preparationLabel;
  preparationDetail.textContent = !enabled ? '开启后准备解说中文，目标 45 秒'
    : !session ? '等待播放器，解说中文目标 45 秒'
    : prep.state === 'ready' ? `解说中文已连续准备 ${Math.floor(prep.ahead)} 秒${session.video.paused ? ' · 等待播放' : ''}`
    : `解说中文连续就绪 ${Math.floor(prep.ahead)} / 45 秒${session.video.paused ? '' : ' · 播放中继续准备'}`;
  preparationButton.title = '仅统计观看位置前方已翻译好的连续解说字幕；TR及采访不影响准备状态';
  const collectorAvailable = session?.sourceKind === 'live' || (replaySimulation && session?.sourceKind === 'vod');
  collectorButton.hidden = !session;
  collectorButton.disabled = !collectorAvailable;
  collectorButton.title = collectorAvailable ? '另开本场采集页；准备 Track FX 后，由扩展开关开始采集'
    : session?.sourceKind === 'vod' ? '如需测试 TR，请先展开下方“用录播测试 TR”，再打开采集页' : '等待官网播放器提供可采集的节目';
  captureHint.hidden = !replaySimulation && pageWindow.document.querySelector('tiledmedia-view')?.currentContentTime?.eventType !== 'live';
  if (session?.radio?.usingRelay) refreshRelayStatus(session);
}
function waitWhenPrepared(source, current) {
  const poll = source.poll.bind(source);
  source.poll = () => {
    if (session !== current || !enabled) return;
    if (current.video.paused && preparationFor(current).state === 'ready') return;
    return poll();
  };
}
refreshControls();

function requestTranslation(cue, context, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(Error('cancelled'));
    let finished = false;
    const done = (error, value) => {
      if (finished) return;
      finished = true; signal.removeEventListener('abort', abort);
      if (error !== 'CANCELLED') showTranslationIssue(error);
      error ? reject(Error('translation_unavailable')) : resolve(value);
    };
    let request;
    const abort = () => { request?.abort(); done('CANCELLED'); };
    signal.addEventListener('abort', abort, {once:true});
    try { request = GM_xmlhttpRequest({ method:'POST', url:`${SERVICE}/api/translate`, anonymous:true,
      headers:{'Content-Type':'application/json', Authorization:`Bearer ${token}`},
      data:JSON.stringify({cue,context}), timeout:11500,
      onload: response => {
        let body;
        try { body = JSON.parse(response.responseText); } catch { return done('INVALID_UPSTREAM_RESPONSE'); }
        if (response.status !== 200) return done(response.status === 401 ? 'UNAUTHORIZED' : body?.error?.code || 'REQUEST_FAILED');
        if (typeof body?.text !== 'string' || !body.text.trim()) return done('INVALID_UPSTREAM_RESPONSE');
        done(null, body);
      }, onerror:()=>done('LOCAL_SERVICE_UNAVAILABLE'), ontimeout:()=>done('LOCAL_SERVICE_TIMEOUT'), onabort:()=>done('CANCELLED')
    }); } catch { done('LOCAL_SERVICE_UNAVAILABLE'); }
  });
}
const radioClient = createRadioClient(GM_xmlhttpRequest, { service:SERVICE, getToken:()=>token });
const requestAsr = createAsrRequester(GM_xmlhttpRequest, { service:SERVICE, getToken:()=>token });
function programmeRelayId(view) {
  const page = capturePageInfo(location.href), kind = view?.currentContentTime?.eventType;
  return page && kind === (page.replay ? 'vod' : 'live') ? page.programmeId : null;
}
function relayClockOrigin(view) {
  return replaySimulation && view?.currentContentTime?.eventType === 'vod' ? 0 : tiledLiveOriginSeconds(view);
}
function behindLiveSeconds(view) {
  const clock = view?.currentContentTime;
  return clock?.eventType === 'live' && Number.isFinite(clock.seekUpperBound) && Number.isFinite(clock.currentPosition)
    ? Math.max(0, (clock.seekUpperBound - clock.currentPosition) / 1000) : NaN;
}
function refreshPlaybackStatus() {
  const view = pageWindow.document.querySelector('tiledmedia-view');
  replayButton.hidden = collectorMode || view?.currentContentTime?.eventType !== 'vod';
  replayOptions.hidden = replayButton.hidden;
  if (replaySimulation && view?.currentContentTime?.eventType === 'vod') {
    playbackButton.hidden = !collectorMode || enabled;
    playbackButton.title = '保持当前节目位置，切到 Track FX 并以 1 倍速播放';
    playbackStatus.textContent = collectorMode ? '回放模拟：按本页正在播放的声音采集，不下载未来音轨'
      : '回放模拟：TR 只接收扩展结果；观看页先暂停，让采集页领先约 50 秒';
    return;
  }
  const lag = behindLiveSeconds(view);
  playbackButton.hidden = collectorMode ? enabled || !view?.associatedPlayer : !Number.isFinite(lag);
  if (playbackButton.disabled) return;
  playbackStatus.textContent = !Number.isFinite(lag) ? (collectorMode ? '等待官网直播播放器' : '')
    : collectorMode ? `距官方直播前沿约 ${Math.round(lag)} 秒 · 无人说话时也继续采集`
    : `观看位置落后官方直播前沿约 ${Math.round(lag)} 秒 · 暂建议 ${LIVE_VIEW_DELAY_SECONDS} 秒`;
}
async function seekLivePosition(view, delay, resume, stillActive = () => true) {
  const clock = view?.currentContentTime, player = view?.associatedPlayer;
  if (clock?.eventType !== 'live' || !Number.isFinite(clock.seekUpperBound) || !Number.isFinite(clock.seekLowerBound)
      || !player || !pageWindow.Tiledmedia?.TimingConfig) throw Error('等待官方直播时间就绪');
  const target = clock.seekUpperBound - delay * 1000;
  if (target < clock.seekLowerBound) throw Error('当前直播可回看范围不足，请稍后再试');
  const config = new pageWindow.Tiledmedia.TimingConfig();
  config.timingType = 1; config.targetPositionStrategy = 1; config.target = target;
  await player.seek(config);
  // SDK seek may pause on its own. Restore only the explicitly requested state.
  if (stillActive() && view.isConnected && view.associatedPlayer === player) {
    if (resume) await player.unpause();
    else await player.pause();
  }
}
async function prepareCollectorPlayback() {
  const view = pageWindow.document.querySelector('tiledmedia-view'), player = view?.associatedPlayer;
  const replay = replaySimulation && view?.currentContentTime?.eventType === 'vod';
  if (!player || (!replay && view.currentContentTime?.eventType !== 'live')) throw Error('请先选择直播，或开启回放模拟模式');
  if (collectorSession) throw Error('请先在扩展面板关闭采集，再调整音轨。');
  const stream = await player.currentAudioTrack, track = await stream?.parentAudioTrack;
  const content = await stream?.parentContentItem || await track?.parentContentItem;
  let selected = /^track\s*fx$/i.test(await track?.name || '') ? track : null;
  for (const feedValue of selected ? [] : await content?.feeds || []) {
    const feed = await feedValue;
    for (const candidateValue of await feed.audioTracks || []) {
      const candidate = await candidateValue;
      if (/^track\s*fx$/i.test(await candidate.name || '') || /^fx$/i.test(await candidate.language || '')) { selected = candidate; break; }
    }
    if (selected) break;
  }
  if (!selected) throw Error('本节目尚未找到 Track FX，请在官网音轨菜单确认');
  player.desiredAudioTrackSelection = new pageWindow.Tiledmedia.AudioTrackSelection(false, selected);
  await player.applyDesiredState(pageWindow.Tiledmedia.DesiredStateConfig.maintainPosition());
  await player.changePlaybackRate(1);
  await player.setAudioGain(1); await player.setAudioIsMuted(false);
  const video = view.querySelector('video');
  if (video) { video.muted = false; video.volume = 1; }
  if (replay) await player.unpause();
  else await seekLivePosition(view, 3, true);
  status.textContent = 'Track FX 已开始播放；打开扩展面板，将“采集声音”开关打开。';
}
function refreshCollectorControls() {
  if (extensionBridgeIssue) {
    preparationButton.dataset.state = 'preparing'; preparationButton.textContent = '扩展连接需恢复';
    preparationDetail.textContent = extensionBridgeIssue;
    return;
  }
  const current = collectorSession, paused = current?.lastStatus?.state === 'paused';
  const starting = current?.lastStatus?.state === 'starting';
  preparationButton.dataset.state = !enabled ? 'waiting' : paused || starting ? 'preparing' : 'ready';
  preparationButton.textContent = !enabled ? '采集开关已关闭' : starting ? '正在接入声音' : paused ? '等待播放' : '正在采集';
  preparationButton.title = '扩展独立处理音频；播放器须保持真实播放';
  preparationDetail.textContent = enabled ? '开关已开 · 关闭扩展面板仍会继续采集'
    : '先准备音轨，再在扩展面板打开采集开关';
}
function stopCollector(message = '采集页已变化，正在停止采集并恢复标签页声音。') {
  postExtensionMessage({ type: 'stop' });
  collectorSession = null; enabled = false;
  status.textContent = message; refreshControls();
}
let collectorClockEpoch = 0, collectorClockRefs = null;
const collectorObservedVideos = new WeakSet();
async function collectorSnapshot() {
  const view = pageWindow.document.querySelector('tiledmedia-view'), video = view?.querySelector('video');
  const page = capturePageInfo(location.href);
  const meta = { protocol: 1, pageLabel: `${replaySimulation ? '回放模拟' : view?.currentContentTime?.eventType === 'live' ? '直播' : '回放'} · ${collectorMode ? '采集页' : '观看页'}`, problem: null };
  if (!collectorMode) return { ...meta, startProblem: '这是观看页；请在脚本控制台打开声音采集页，并在新页准备 Track FX。' };
  const player = await view?.associatedPlayer;
  const audio = await player?.currentAudioTrack, track = await audio?.parentAudioTrack;
  const name = await track?.name, language = await track?.language;
  if (!video || !view.isConnected || view.associatedPlayer !== player) return { ...meta, startProblem: '等待官网播放器加载，请先打开本场节目。' };
  const refs = [view, video, player, audio];
  if (!collectorClockRefs || refs.some((item, index) => item !== collectorClockRefs[index])) {
    collectorClockEpoch++; collectorClockRefs = refs;
  }
  if (!collectorObservedVideos.has(video)) {
    collectorObservedVideos.add(video);
    for (const type of ['pause', 'play', 'seeking', 'seeked', 'waiting', 'playing', 'ratechange', 'volumechange', 'emptied']) {
      video.addEventListener(type, () => {
        // Preserve evidence of a pause/stall even if its message arrives after
        // playback has resumed. Internal video seeking is checked by SDK time.
        if (['pause', 'waiting', 'emptied'].includes(type)) collectorClockEpoch++;
        postExtensionMessage({ type: 'clock-changed' });
      });
    }
  }
  const snapshot = { ...meta, collector: true, audioLabel: name || language || '未选音轨', programmeId: programmeRelayId(view), epoch: collectorClockEpoch, eventType: view.currentContentTime?.eventType,
    time: tiledContentSeconds(view), origin: relayClockOrigin(view), at: performance.timeOrigin + performance.now(),
    trackFx: /^track\s*fx$/i.test(name || '') || /^fx$/i.test(language || ''),
    paused: video.paused, muted: video.muted || video.volume === 0, rate: Number(view.playbackRate) || 1,
    behindLive: behindLiveSeconds(view) };
  snapshot.startProblem = captureStartProblem(page, snapshot);
  snapshot.problem = !snapshot.trackFx ? '音轨已改变，请在脚本中准备 Track FX 后重新采集。'
    : snapshot.muted ? '官网播放器已静音，请恢复正常音量后重新采集。'
    : Math.abs(snapshot.rate - 1) > .01 ? '请将采集页恢复为 1 倍速后重新采集。' : null;
  return snapshot;
}
listenExtensionMessages(message => {
  if (message.type === 'bridge-unavailable') {
    extensionBridgeIssue = message.reason === 'context-invalidated'
      ? '扩展已重新加载，请刷新本页以恢复连接。' : '扩展通信暂时失败，请重新打开面板检查连接。';
    if (collectorMode) { status.textContent = extensionBridgeIssue; refreshControls(); }
    else if (session?.radio?.usingRelay) refreshRelayStatus(session);
    return;
  }
  if (message.type === 'installed') extensionBridgeIssue = null;
  if (message.type === 'snapshot-request') {
    void collectorSnapshot().then(snapshot => postExtensionMessage({ type: 'snapshot', requestId: message.requestId, snapshot }),
      () => postExtensionMessage({ type: 'snapshot', requestId: message.requestId, snapshot: extensionSnapshotFailure(collectorMode) }));
  }
  if (!collectorMode) {
    if (message.type === 'status' && message.state === 'error') radioStatus.textContent = message.message;
    return;
  }
  if (message.type === 'installed' && !enabled) {
    status.textContent = '扩展已连接；准备 Track FX 后，在扩展面板打开采集开关。';
  }
  if (message.type !== 'status') return;
  enabled = message.active === true;
  const view = pageWindow.document.querySelector('tiledmedia-view'), video = view?.querySelector('video');
  if (enabled && view && video) {
    collectorSession ||= { view, video, programmeId: programmeRelayId(view), lastLiveSeek: Date.now() };
    collectorSession.lastStatus = message;
  } else collectorSession = null;
  status.textContent = message.message || '等待扩展采集';
  radioStatus.textContent = enabled ? '音频、识别和中文缓存进度请看扩展面板。' : '采集关闭，标签页正常出声。';
  refreshControls();
});
postExtensionMessage({ type: 'hello' });
function tickCollector() {
  const current = collectorSession;
  if (!current) return;
  if (!current.video.isConnected || programmeRelayId(current.view) !== current.programmeId) {
    stopCollector('采集播放器已切换，请准备本场 Track FX，再在扩展面板打开采集开关。'); return;
  }
  // Only the collector's own distance from live can trigger a live seek. A
  // viewer pause, empty TR result or a missing heartbeat never does.
  if (!replaySimulation && !current.video.paused && behindLiveSeconds(current.view) > 20 && !current.seekingLive
      && Date.now() - current.lastLiveSeek > 30000) {
    current.lastLiveSeek = Date.now(); current.seekingLive = true;
    void seekLivePosition(current.view, 3, true, () => collectorSession === current)
      .catch(() => { if (collectorSession === current) status.textContent = '未能返回直播前沿；请关闭扩展采集，再点击“准备 Track FX 并播放”。'; })
      .finally(() => { current.seekingLive = false; });
  }
}
function refreshRelayStatus(current) {
  const radio=current?.radio, s=radio?.relayStatus;
  if (!radio?.usingRelay) return;
  if (extensionBridgeIssue) { radioStatus.textContent = `TR · ${extensionBridgeIssue}`; return; }
  const origin=relayClockOrigin(current.view), time=tiledContentSeconds(current.view);
  const gap=Number.isFinite(s?.contentTime)&&Number.isFinite(origin)?s.contentTime-origin-time:NaN;
  radioStatus.textContent=s?.state==='error'?`TR · ${s.message||'请检查采集页'}`
    : !s?.connected?'TR · 采集页已停止或断开，已收到的译文仍保留'
    : s.state==='paused'?`TR · ${s.message} · 已收到译文仍按时间显示`
    : `TR · ${replaySimulation ? '回放模拟' : '直播'}采集已连接 · 已缓存 ${radio.store.cues.size} 句${Number.isFinite(gap)?` · 领先 ${Math.round(gap)} 秒`:''}${Number.isFinite(gap)&&gap<45?' · 建议观看落后约50秒':''}`;
}
function connectProgrammeRelay(current) {
  const radio=current.radio, programmeId=programmeRelayId(current.view);
  if (!programmeId || !Number.isFinite(relayClockOrigin(current.view))) return;
  radio.relay=new ProgrammeRelay({programmeId,role:'viewer',channelFactory:()=>createExtensionRelayChannel(programmeId),
    onStatus:s=>{
      if(session!==current||current.radio!==radio)return;
      radio.relayStatus=s;
      // Completed translations remain useful across collector reconnection.
      if(s.connected && s.collectorId) radio.collectorId=s.collectorId;
      refreshRelayStatus(current);refreshControls();
    },
    onCues:cues=>{
      if(session!==current||current.radio!==radio||!radioEnabled)return;
      radio.queue.ingestMany(cues);
    }
  });
  radio.relay.setViewerState({contentTime:tiledContentSeconds(current.view)+relayClockOrigin(current.view),paused:current.video.paused,enabled:true});
}
function radioCapabilities() {
  return new Promise((resolve,reject)=>GM_xmlhttpRequest({method:'GET',url:`${SERVICE}/api/health`,anonymous:true,timeout:5000,
    onload:response=>{try {const value=JSON.parse(response.responseText);if(response.status!==200||value.service!=='f1tv-zh')throw Error();resolve(value);}catch{reject(Error('LOCAL_SERVICE_UNAVAILABLE'));}},
    onerror:()=>reject(Error('LOCAL_SERVICE_UNAVAILABLE')),ontimeout:()=>reject(Error('LOCAL_SERVICE_UNAVAILABLE'))
  }));
}
function stopRadio(current, notifyCollector = false) {
  if (!current?.radio) return;
  current.radio.relay?.close({disableViewer:notifyCollector});
  current.radio.source?.stop(); current.radio.queue.dispose(); current.radio.overlay.dispose();
  current.radio = null;
}
async function startRadio(current) {
  if (!radioEnabled || !current?.view || current.radio || current.radioStarting) return;
  if (current.sourceKind === 'live' || (replaySimulation && current.sourceKind === 'vod')) {
    const store = new CueStore({maxCues:1200}), timeline = new SubtitleTimeline(store, {exclusive:true});
    const getTime = () => tiledContentSeconds(current.view) + relayClockOrigin(current.view);
    timeline.setEnabled(true);
    // Ready Chinese arrives with absolute programme timestamps. Keep those
    // timestamps intact if the SDK later rebases its relative content clock.
    const queue = new TranslationQueue(store, requestTranslation, {getTime,contextWaitMs:0});
    const overlay = new VideoOverlay(current.video, timeline, {
      getTime, opacity:1-subtitleTransparency/100, above:current.overlay
    });
    current.radio = {store,timeline,queue,overlay,source:null,usingRelay:true};
    radioStatus.textContent='TR · 请打开声音采集页；本模式仅接收扩展结果';
    connectProgrammeRelay(current);
    refreshControls();
    return;
  }
  current.radioStarting = true;
  let direct;
  try { direct = (await radioCapabilities()).radio === true; }
  catch { if (session === current) radioStatus.textContent = 'TR · 本机语音服务连接失败'; return; }
  finally { current.radioStarting = false; }
  if (session !== current || !radioEnabled) return;
  const store = new CueStore(), timeline = new SubtitleTimeline(store, {exclusive:true});
  timeline.setEnabled(true);
  const queue = new TranslationQueue(store, requestTranslation, {
    concurrency:2, contextWaitMs:0, getTime:()=>tiledContentSeconds(current.view)
  });
  const overlay = new VideoOverlay(current.video, timeline, {
    getTime:()=>tiledContentSeconds(current.view), opacity:1-subtitleTransparency/100,
    above:current.overlay
  });
  const RadioSource = direct ? TrackFxContinuousSource : TrackFxSource;
  const source = new RadioSource(current.view, {
    client:radioClient, transcribe:requestAsr, isPaused:()=>current.video.paused, aheadSeconds:PREPARATION_LOOKAHEAD,
    onReset:()=>{queue.reset(); timeline.seek();},
    onStatus: s => {
      if (session !== current) return;
      if (current.radio?.usingRelay) return;
      if (current.radio) current.radio.needsCollector=current.sourceKind==='live'&&['FX_DRM','FX_ENCRYPTED','FX_FORMAT','FX_DECODE'].includes(s.errorCode);
      const all = [...store.cues.values()], ready = all.filter(c=>c.status==='ready').length;
      radioStatus.textContent = s.errorCode ? `TR · ${s.message}`
        : direct ? `TR · 中文 ${ready} 句 · 音频已送至前方 ${Number.isFinite(s.sentAhead) ? s.sentAhead.toFixed(0) : '—'} 秒`
        : `TR · 中文 ${ready}/${all.length} · 提前 ${Number.isFinite(s.ahead) ? s.ahead.toFixed(0) : '—'} 秒`;
      refreshControls();
    }
  });
  current.radio = {store,timeline,queue,overlay,source};
  waitWhenPrepared(source, current);
  radioStatus.textContent = 'TR · 正在读取 Track FX…';
  source.start(cues=>queue.ingestMany(cues));
}
function findVideo() {
  return Array.from(document.querySelectorAll('video')).filter(v => v.getBoundingClientRect().width > 150)
    .sort((a,b) => b.clientWidth*b.clientHeight-a.clientWidth*a.clientHeight)[0] || null;
}
function detach(notifyCollector = false) {
  if (!session) return;
  stopRadio(session, notifyCollector);
  session.source.stop(); session.queue.dispose(); session.overlay.dispose();
  session.video.removeEventListener('emptied', session.reset);
  session.video.removeEventListener('enterpictureinpicture', session.unsupported);
  document.removeEventListener('fullscreenchange', session.unsupported);
  session = null;
}
function setEnabled(value) {
  if (collectorMode) { if (!value) stopCollector(); return; }
  enabled = value; radioEnabled = value; detach(!value);
  showTranslationIssue(null);
  if (!value) status.textContent = '已关闭，恢复开启前的官方字幕状态';
  else attach();
  if (!value) radioStatus.textContent = 'TR及采访翻译已关闭';
  refreshControls();
}
function attach() {
  if (collectorMode || !enabled || session) return;
  const video = findVideo();
  if (!video) { status.textContent = '等待播放器…'; return; }
  const store = new CueStore(), timeline = new SubtitleTimeline(store, { suppress: cue =>
    session?.store === store && Boolean(session.radio && [...session.radio.store.cues.values()]
      .some(other => {
        const origin = session.radio.usingRelay ? relayClockOrigin(session.view) : 0;
        return other.status === 'ready' && Number.isFinite(origin)
          && sameSpeech(cue, {...other,start:other.start-origin,end:other.end-origin});
      }))
  });
  timeline.setEnabled(true);
  const view = pageWindow.document.querySelector('tiledmedia-view');
  const useTiled = Boolean(view?.associatedPlayer && view.contains(video));
  const sourceKind = useTiled ? view.currentContentTime?.eventType : 'native';
  if (useTiled && !['live', 'vod'].includes(sourceKind)) { status.textContent = '等待播放器确认直播或回放时间轴…'; return; }
  const queue = new TranslationQueue(store, requestTranslation, { getTime: () => useTiled ? tiledContentSeconds(view) : video.currentTime });
  const captions = new OfficialCaptionVisibility(() => Array.from(document.querySelectorAll('.tm-ui-subtitle-overlay')));
  let source;
  const overlay = new VideoOverlay(video, timeline, {
    opacity: 1 - subtitleTransparency / 100,
    style: subtitleStyle, position: subtitlePosition,
    onPositionSave: value => { subtitlePosition = value; GM_setValue('subtitlePosition', value); },
    getTime: () => useTiled ? tiledContentSeconds(view) : video.currentTime,
    // A verified empty interval is silence too. Revealing the site's layer in
    // tiny inter-cue gaps can briefly expose its previous/next English caption.
    onRender: state => { if (useTiled) captions.setHidden(Boolean(timeline.enabled && source?.validated &&
      (state.text || source.coversTime(tiledContentSeconds(view))))); }
  });
  const sourceOptions = {epoch:`${Date.now()}`, onReset: () => { queue.reset(); timeline.seek(); captions.restore(); }, onStatus: s => {
    if (timeline.enabled !== s.available) timeline.setEnabled(s.available);
    const failed = [...store.cues.values()].filter(c => c.status === 'failed').length;
    const ready = [...store.cues.values()].filter(c => c.status === 'ready').length;
    status.textContent = !s.available ? s.message || '未找到可读英文轨；请先在官网选择英文字幕'
      : `${s.kind === 'tiled-live' ? '直播分段已接入' : useTiled ? '回放分段已接入' : '原生轨道'} · 领先 ${s.ahead?.toFixed(1) ?? '—'} 秒 · 中文 ${ready}/${s.cueCount}${failed ? ` · ${failed} 条英文回退` : ''}`;
    if (!s.available) captions.restore();
    refreshControls();
  }};
  const TiledSource = view?.currentContentTime?.eventType === 'live' ? TiledMediaLiveSource : TiledMediaVodSource;
  source = useTiled ? new TiledSource(view, {...sourceOptions, aheadSeconds:PREPARATION_LOOKAHEAD,
    followLiveHead: () => !video.paused,
    getOfficialText: () => document.querySelector('.tm-ui-subtitle-overlay')?.textContent || '' }) : new TextTrackSource(video, {...sourceOptions,horizonSeconds:PREPARATION_LOOKAHEAD});
  const reset = () => { detach(); };
  const unsupported = () => {
    if (document.fullscreenElement === video || document.pictureInPictureElement === video) {
      setEnabled(false); status.textContent = '视频单独全屏/画中画：已恢复官方字幕。请使用网页播放器容器全屏。';
    }
  };
  session = {video,store,timeline,queue,overlay,source,reset,unsupported,sourceKind,view:useTiled?view:null,radio:null};
  waitWhenPrepared(source, session);
  video.addEventListener('emptied', reset); video.addEventListener('enterpictureinpicture', unsupported);
  document.addEventListener('fullscreenchange', unsupported);
  source.start(cues => queue.ingestMany(cues));
  startRadio(session);
  if (!useTiled) radioStatus.textContent = 'TR 需要 F1 TV 的 Track FX 音轨';
  if (!radioEnabled) radioStatus.textContent = 'TR及采访翻译已关闭';
  unsupported();
}
radioButton.addEventListener('click', () => {
  if (!enabled) return;
  radioEnabled = !radioEnabled;
  if (radioEnabled && session) startRadio(session);
  else stopRadio(session, true);
  if (!radioEnabled) radioStatus.textContent = 'TR / 采访字幕已关闭 · 解说翻译继续';
  refreshControls();
});
collectorButton.addEventListener('click', () => {
  if (collectorButton.disabled || !session?.view) return;
  const programmeId=programmeRelayId(session.view);
  if (!programmeId) {radioStatus.textContent='请先打开本场直播或开启回放模拟模式。';return;}
  if (collectorWindow && !collectorWindow.closed && collectorWindowProgrammeId===programmeId) {collectorWindow.focus();return;}
  const url=new URL(location.href);url.searchParams.delete('f1zh-commentary');url.searchParams.delete('f1zh-audio');url.searchParams.set('f1zh-capture','1');url.searchParams.set('action','play');
  collectorWindow=window.open(url.href,`f1zh-audio-${programmeId}`);
  collectorWindowProgrammeId=programmeId;
  if(!collectorWindow)radioStatus.textContent='请允许打开本场的采集标签页，再点击一次。';
});
playbackButton.addEventListener('click', async () => {
  if (playbackButton.disabled) return;
  playbackButton.disabled=true;
  playbackStatus.textContent=collectorMode?'正在准备 Track FX…':'正在调整观看位置…';
  try {
    if (collectorMode) await prepareCollectorPlayback();
    else {
      const view=pageWindow.document.querySelector('tiledmedia-view'), video=view?.querySelector('video');
      if (!video) throw Error('请先打开本场官方播放器');
      await seekLivePosition(view,LIVE_VIEW_DELAY_SECONDS,!video.paused);
    }
  } catch (error) { status.textContent=error.message || '操作未完成，请在官网播放器手动调整。'; }
  finally {playbackButton.disabled=false;refreshControls();}
});
button.addEventListener('click', () => {
  if (!enabled && !token) { status.textContent = '先点击下方“配对本机服务”，再开启中文字幕。'; return; }
  setEnabled(!enabled);
});
function pairService() {
  const value = prompt('从 http://127.0.0.1:3847 本机配置页复制配对码，粘贴到这里。不要填写 API 密钥。', '');
  if (value === null) return;
  if (!/^[a-f0-9]{64}$/.test(value.trim())) { status.textContent = '配对码格式不正确，请从本机配置页重新复制。'; return; }
  token = value.trim(); GM_setValue('localServiceToken', token); showTranslationIssue(null);
  // Failed cues are intentionally not retried automatically. Re-pairing is an
  // explicit recovery action, so rebuild the current subtitle queue here.
  if (collectorMode) status.textContent = '脚本配对已保存；采集扩展需在“配对设置”中单独配对。';
  else if (enabled) setEnabled(true);
  else status.textContent = '配对已保存，可以开启中文字幕。';
  refreshControls();
}
GM_registerMenuCommand('配对本机翻译服务', pairService);
pairButton.addEventListener('click', pairService);
const watcher = setInterval(() => {
  if (location.href !== currentPage) {
    currentPage = location.href; detach(true);
    if (collectorSession) stopCollector('页面已切换，请在新节目重新开始声音采集。');
  }
  if (collectorMode) {tickCollector();refreshControls();return;}
  if (session && (!session.video.isConnected || session.video !== findVideo())) detach();
  const view = pageWindow.document.querySelector('tiledmedia-view');
  const kind = view?.currentContentTime?.eventType;
  if (session && view?.associatedPlayer && view.contains(session.video) && ['live', 'vod'].includes(kind) && session.sourceKind !== kind) detach();
  attach();
  const origin=session?.view&&relayClockOrigin(session.view);
  if (session?.radio?.usingRelay && !session.radio.relay) connectProgrammeRelay(session);
  if(session?.radio?.relay&&Number.isFinite(origin))session.radio.relay.setViewerState({
    contentTime:tiledContentSeconds(session.view)+origin,paused:session.video.paused,enabled:enabled&&radioEnabled});
  refreshControls();
}, 1000);
window.addEventListener('pagehide', event => {
  if(collectorMode&&collectorSession)stopCollector('采集页已离开，请重新开始声音采集。');
  // BFCache preserves this document and JS state; its timers resume on return.
  if (event.persisted) return;
  clearInterval(watcher); detach(true); floatingControls.dispose(); panel.remove();
});
window.addEventListener('pageshow', event => {
  if (event.persisted) { floatingControls.refresh(); session?.source.poll(); session?.overlay.draw(); session?.radio?.source?.poll(); session?.radio?.overlay.draw(); refreshControls(); }
});

})();
