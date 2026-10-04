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
