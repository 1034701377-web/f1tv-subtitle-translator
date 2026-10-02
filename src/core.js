// Cue times and rendering use the same chosen programme clock, never API return time.
export class CueStore {
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

export class TranslationQueue {
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
export class SubtitleTimeline {
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
export function sameSpeech(a, b) {
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
