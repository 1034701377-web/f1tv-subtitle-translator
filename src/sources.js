export class SimulatedSource {
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
export class TextTrackSource {
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
export class MappedCueSource {
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
