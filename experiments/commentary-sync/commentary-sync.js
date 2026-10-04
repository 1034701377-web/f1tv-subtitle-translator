const commentarySyncVersion = 1;
const commentarySyncIdPattern = /^[A-Za-z0-9_:-]{1,120}$/;
const commentarySyncStates = new Set(['starting', 'syncing', 'synchronized', 'paused', 'disabled', 'waiting-range', 'waiting-buffer', 'connection-slow', 'disconnected', 'blocked', 'error', 'closed']);
const commentarySyncMaxPosition = 10000000000;

function commentarySyncNumber(value, lower, upper) {
  return Number.isFinite(value) && value >= lower && value <= upper;
}

function commentarySyncState(value) {
  if (!value || typeof value !== 'object' || typeof value.ready !== 'boolean'
    || typeof value.paused !== 'boolean' || !commentarySyncNumber(value.rate, 0.25, 4)) return null;
  if (!value.ready) return { ready: false, position: null, paused: value.paused, rate: value.rate, lower: null, upper: null };
  if (!commentarySyncNumber(value.position, 0, commentarySyncMaxPosition)
    || !commentarySyncNumber(value.lower, 0, commentarySyncMaxPosition)
    || !commentarySyncNumber(value.upper, value.lower, commentarySyncMaxPosition)) return null;
  return { ready: true, position: value.position, paused: value.paused, rate: value.rate, lower: value.lower, upper: value.upper };
}

function commentarySyncSettings(value) {
  if (!value || typeof value.enabled !== 'boolean' || !commentarySyncNumber(value.volume, 0, 1)
    || !commentarySyncNumber(value.offset, -10, 10)) return null;
  return { enabled: value.enabled, volume: value.volume, offset: value.offset };
}

/** Same-programme playback control only. No capture, recognition, or master-player mutations. */
export class CommentarySync {
  constructor({ role, programmeId, pairId, getState, controls = {}, onStatus = () => {}, channelFactory,
    now = () => Date.now(), autoTick = true, intervalMs = 500 } = {}) {
    if (!['leader', 'follower'].includes(role) || !commentarySyncIdPattern.test(programmeId || '')
      || !commentarySyncIdPattern.test(pairId || '') || typeof getState !== 'function') throw new TypeError('Invalid commentary synchronization configuration');
    this.role = role;
    this.programmeId = programmeId;
    this.pairId = pairId;
    this.getState = getState;
    this.controls = controls;
    this.onStatus = onStatus;
    this.now = now;
    this.id = `c${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
    this.settings = { enabled: false, volume: 0.5, offset: 0 };
    this.sequence = 0;
    this.peer = null;
    this.peerSequence = -1;
    this.lastPeerAt = null;
    this.packet = null;
    this.closed = false;
    this.runningTick = null;
    this.playAllowed = true;
    this.playBlocked = false;
    this.aligned = false;
    this.lastSeekAt = -Infinity;
    this.settleUntil = -Infinity;
    this.commanded = { muted: null, volume: null, rate: null };
    this.statusKey = '';
    this.lastStatus = null;
    this.channel = (channelFactory || (name => new BroadcastChannel(name)))(`f1zh-commentary-v1-${programmeId}-${pairId}`);
    this.channel.onmessage = event => this.receive(event.data);
    if (autoTick) {
      this.timer = setInterval(() => { void this.tick(); }, Math.max(250, Math.min(1000, intervalMs)));
      this.timer.unref?.();
    }
  }

  readState() {
    try { return commentarySyncState(this.getState()); } catch { return null; }
  }

  send(type, payload) {
    if (this.closed) return;
    try {
      this.channel.postMessage({ version: commentarySyncVersion, type, programmeId: this.programmeId, pairId: this.pairId,
        sender: this.id, seq: ++this.sequence, sentAt: this.now(), ...payload });
    } catch { /* A closed page must not affect either player's controls. */ }
  }

  receive(value) {
    if (this.closed || !value || typeof value !== 'object' || value.version !== commentarySyncVersion
      || value.programmeId !== this.programmeId || value.pairId !== this.pairId || value.sender === this.id
      || typeof value.sender !== 'string' || !commentarySyncIdPattern.test(value.sender)
      || !Number.isSafeInteger(value.seq) || value.seq < 1 || !commentarySyncNumber(value.sentAt, 0, 1000000000000000)
      || value.sentAt > this.now() + 1000 || this.now() - value.sentAt > 30000) return;
    if (this.peer && value.sender !== this.peer && this.now() - this.lastPeerAt < 30000) return;
    if (value.sender === this.peer && value.seq <= this.peerSequence) return;
    if (this.role === 'follower') {
      if (value.type !== 'state') return;
      const state = commentarySyncState(value.state), settings = commentarySyncSettings(value.settings);
      if (!state || !settings) return;
      const previous = this.packet;
      if (settings.enabled && (!previous || !previous.settings.enabled
        || (previous.state.ready && state.ready && previous.state.paused && !state.paused))) {
        this.playAllowed = true;
        this.playBlocked = false;
      }
      this.packet = { state, settings, sentAt: value.sentAt };
      // An explicit switch-off (including the leader closing) should not wait
      // for the background interval. Queue after an in-flight seek if needed.
      if (!settings.enabled) {
        const pendingTick = this.runningTick;
        if (pendingTick) void pendingTick.then(() => this.tick());
        else void this.tick();
      }
    } else {
      if (value.type !== 'status' || !value.status || !commentarySyncStates.has(value.status.state)
        || typeof value.status.message !== 'string' || value.status.message.length > 240
        || (value.status.drift !== undefined && !commentarySyncNumber(value.status.drift, -commentarySyncMaxPosition, commentarySyncMaxPosition))) return;
      this.report(value.status.state, value.status.message, value.status.drift, false);
    }
    this.peer = value.sender;
    this.peerSequence = value.seq;
    this.lastPeerAt = this.now();
  }

  setSettings(patch = {}) {
    if (this.role !== 'leader' || this.closed) return;
    const next = commentarySyncSettings({ ...this.settings, ...patch });
    if (!next) throw new TypeError('Invalid commentary settings');
    this.settings = next;
    void this.tick();
  }

  report(state, message, drift, broadcast = true) {
    const status = { state, message };
    if (Number.isFinite(drift)) status.drift = drift;
    this.lastStatus = status;
    const key = `${state}|${message}|${Number.isFinite(drift) ? Math.round(drift * 10) : ''}`;
    if (key !== this.statusKey) {
      this.statusKey = key;
      this.onStatus(status);
    }
    if (broadcast && this.role === 'follower') this.send('status', { status });
  }

  async command(name, value) {
    if (this.closed || this.role !== 'follower') return;
    if (typeof this.controls[name] !== 'function') throw new Error(`Missing commentary control: ${name}`);
    return this.controls[name](value);
  }

  async output(muted, volume) {
    if (this.commanded.muted !== muted) {
      await this.command('setMuted', muted);
      this.commanded.muted = muted;
    }
    if (Number.isFinite(volume) && this.commanded.volume !== volume) {
      await this.command('setVolume', volume);
      this.commanded.volume = volume;
    }
  }

  async rate(value) {
    if (this.commanded.rate === null || Math.abs(this.commanded.rate - value) >= 0.001) {
      await this.command('setRate', value);
      this.commanded.rate = value;
    }
  }

  async tryPlay() {
    if (!this.playAllowed || this.closed) return false;
    this.playAllowed = false;
    try {
      await this.command('play');
      this.playBlocked = false;
      return true;
    } catch {
      this.playBlocked = true;
      await this.output(true);
      this.report('blocked', '请在解说页点击“恢复同步”以允许播放');
      return false;
    }
  }

  latestPlaybackRequested() {
    const packet = this.packet;
    return !this.closed && packet?.settings.enabled && packet.state.ready && !packet.state.paused
      && this.now() - packet.sentAt <= 5000;
  }

  tick() {
    if (this.closed) return Promise.resolve();
    if (this.runningTick) return this.runningTick;
    // Set the guard before execution: an in-memory channel may deliver status synchronously.
    this.runningTick = Promise.resolve().then(() => this.runTick()).catch(async () => {
      if (!this.closed) {
        try { await this.output(true); } catch { /* Surface the original control failure. */ }
        this.report('error', '解说页暂时无法同步，请检查播放器后恢复同步');
      }
    }).finally(() => { this.runningTick = null; });
    return this.runningTick;
  }

  async runTick() {
    if (this.closed) return;
    const now = this.now();
    if (this.role === 'leader') {
      const state = this.readState() || { ready: false, position: null, paused: true, rate: 1, lower: null, upper: null };
      this.send('state', { state, settings: this.settings });
      if (!this.settings.enabled) this.report('disabled', '同步解说已关闭');
      else if (this.lastPeerAt === null || now - this.lastPeerAt > 30000) this.report('disconnected', '等待解说页连接');
      return;
    }
    const packet = this.packet;
    if (!packet) {
      await this.output(true);
      this.report('starting', '等待 Track FX 主页面');
      return;
    }
    const age = Math.max(0, now - packet.sentAt);
    if (age > 5000) {
      await this.rate(packet.state.rate);
      if (age >= 30000) {
        await this.output(true);
        this.aligned = false;
        this.report('disconnected', '暂时无法联系主页面，解说已静音');
      } else this.report('connection-slow', '主页面消息暂时延迟，等待恢复');
      return;
    }
    const master = packet.state, settings = packet.settings, local = this.readState();
    if (!settings.enabled) {
      await this.output(true, settings.volume);
      await this.rate(master.rate);
      if (local && !local.paused) await this.command('pause');
      this.playAllowed = false;
      this.aligned = false;
      this.report('disabled', '同步解说已关闭');
      return;
    }
    if (!master.ready || !local?.ready) {
      await this.output(true);
      this.report('waiting-buffer', '等待播放器提供可同步的节目时间');
      return;
    }
    const target = master.position + (master.paused ? 0 : age / 1000 * master.rate) + settings.offset;
    const drift = target - local.position;
    if (target < local.lower || target > local.upper) {
      await this.output(true);
      await this.rate(master.rate);
      this.aligned = false;
      this.report('waiting-range', '等待解说页提供当前画面的时间位置', drift);
      return;
    }
    if (master.paused) {
      if (!local.paused) await this.command('pause');
      await this.rate(master.rate);
      if ((!this.aligned || Math.abs(drift) > 1.5) && now - this.lastSeekAt >= 3000) {
        await this.output(true);
        this.lastSeekAt = now;
        this.settleUntil = now + 3000;
        await this.command('seek', target);
        this.aligned = true;
      }
      this.report('paused', '主页面已暂停，解说同步等待', drift);
      return;
    }
    if (local.paused && !this.playAllowed) {
      await this.output(true);
      await this.rate(master.rate);
      this.report(this.playBlocked ? 'blocked' : 'paused', this.playBlocked
        ? '请在解说页点击“恢复同步”以允许播放' : '解说页已暂停，点击恢复同步', drift);
      return;
    }
    if (!local.paused) this.playAllowed = false;
    if (!this.aligned || Math.abs(drift) > 1.5) {
      await this.output(true);
      await this.rate(master.rate);
      if (now - this.lastSeekAt >= 3000 && now >= this.settleUntil) {
        this.lastSeekAt = now;
        this.settleUntil = now + 3000;
        await this.command('seek', target);
        this.aligned = true;
        // The official SDK may pause even a previously playing video during
        // seek. Restore once for this command, using the latest master intent.
        if (!this.latestPlaybackRequested()) return;
        this.playAllowed = true;
        if (!await this.tryPlay()) return;
      }
      this.report('syncing', '正在对齐解说与画面', drift);
      return;
    }
    if (local.paused && !await this.tryPlay()) return;
    if (!local.paused) this.playAllowed = false;
    if (now < this.settleUntil && Math.abs(drift) > 0.5) {
      await this.output(true);
      this.report('syncing', '等待解说播放器完成定位', drift);
      return;
    }
    const correction = Math.abs(drift) > 0.15 ? Math.max(-0.03, Math.min(0.03, drift * 0.04)) : 0;
    await this.rate(master.rate * (1 + correction));
    await this.output(false, settings.volume);
    this.report('synchronized', `解说同步 · ${Math.abs(drift) < 0.005 ? '相差' : drift > 0 ? '慢' : '快'} ${Math.abs(drift).toFixed(2)} 秒`, drift);
  }

  resume() {
    if (this.role !== 'follower' || this.closed) return Promise.resolve();
    const applyResume = () => {
      if (this.closed) return;
      this.playAllowed = true;
      this.playBlocked = false;
      // Existing drift checks decide whether another seek is necessary.
      return this.tick();
    };
    return this.runningTick ? this.runningTick.then(applyResume) : applyResume();
  }

  resetOutput() {
    if (this.role !== 'follower' || this.closed) return;
    this.commanded = { muted: null, volume: null, rate: null };
    this.aligned = false;
    this.playAllowed = true;
    this.playBlocked = false;
    this.lastSeekAt = -Infinity;
    this.settleUntil = -Infinity;
  }

  close() {
    if (this.closed) return;
    clearInterval(this.timer);
    if (this.role === 'leader') {
      const state = this.readState() || { ready: false, position: null, paused: true, rate: 1, lower: null, upper: null };
      this.send('state', { state, settings: { ...this.settings, enabled: false } });
    }
    // Only this optional commentary output is silenced; the leader has no control path here.
    if (this.role === 'follower') {
      try { Promise.resolve(this.controls.setMuted?.(true)).catch(() => {}); } catch { /* Closing is best effort. */ }
      try { Promise.resolve(this.controls.setRate?.(1)).catch(() => {}); } catch { /* Closing is best effort. */ }
    }
    this.closed = true;
    this.channel.onmessage = null;
    this.channel.close();
  }
}
