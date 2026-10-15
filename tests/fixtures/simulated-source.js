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

