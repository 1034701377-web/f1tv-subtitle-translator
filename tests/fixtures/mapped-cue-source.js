// Test fixture: an adapter must map segment timestamps before emitting cues.
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
