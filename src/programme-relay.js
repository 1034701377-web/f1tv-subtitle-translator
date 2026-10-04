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

export class ProgrammeRelay {
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
