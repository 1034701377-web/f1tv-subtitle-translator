import test from 'node:test';
import assert from 'node:assert/strict';
import { CommentarySync } from '../experiments/commentary-sync/commentary-sync.js';

function fixture(t, { paused = false, seekMoves = true, playRejects = false, seekPauses = false, onSeek } = {}) {
  let clock = 1800000000000;
  const channels = [], messages = [], calls = [], leaderStatuses = [], followerStatuses = [], members = [];
  const master = { ready: true, position: 1800000050, lower: 1800000000, upper: 1800000150, paused: false, rate: 1 };
  const local = { ...master, position: 1800000080, paused };
  const output = { muted: false, volume: 1, rate: 1 };
  const channelFactory = name => {
    const channel = {
      name, closed: false, onmessage: null,
      postMessage(message) {
        messages.push(structuredClone(message));
        for (const other of channels) if (other !== channel && !other.closed && other.name === name) other.onmessage?.({ data: structuredClone(message) });
      },
      close() { this.closed = true; },
    };
    channels.push(channel);
    return channel;
  };
  const create = options => {
    const sync = new CommentarySync({ programmeId: 'race:live', pairId: 'chosen-pair', now: () => clock, channelFactory, autoTick: false, ...options });
    members.push(sync);
    return sync;
  };
  const leader = create({ role: 'leader', getState: () => master, controls: new Proxy({}, { get() { throw Error('Leader must never access controls'); } }), onStatus: status => leaderStatuses.push(status) });
  const follower = create({ role: 'follower', getState: () => local, onStatus: status => followerStatuses.push(status), controls: {
    async seek(value) {
      calls.push(['seek', value]);
      if (seekMoves) local.position = value;
      if (seekPauses) local.paused = true;
      if (onSeek) await onSeek(value);
    },
    async play() { calls.push(['play']); if (playRejects) throw Error('NotAllowedError'); local.paused = false; },
    async pause() { calls.push(['pause']); local.paused = true; },
    async setMuted(value) { calls.push(['muted', value]); output.muted = value; },
    async setVolume(value) { calls.push(['volume', value]); output.volume = value; },
    async setRate(value) { calls.push(['rate', value]); output.rate = value; },
  } });
  t.after(() => members.forEach(member => member.close()));
  return { master, local, output, leader, follower, calls, messages, leaderStatuses, followerStatuses, create,
    time: ms => { clock += ms; },
    async advance(ms, publish = true) {
      clock += ms;
      if (!master.paused) master.position += ms / 1000 * master.rate;
      if (!local.paused) local.position += ms / 1000 * output.rate;
      if (publish) await leader.tick();
      await follower.tick();
    },
    async enable() { leader.setSettings({ enabled: true, volume: 0.6 }); await leader.tick(); await follower.tick(); },
  };
}

test('initial alignment mutes before seeking, follows the absolute clock, and reports back to an immutable leader', async t => {
  const f = fixture(t, { paused: true });
  await f.enable();
  assert.ok(f.calls.findIndex(call => call[0] === 'muted' && call[1]) < f.calls.findIndex(call => call[0] === 'seek'));
  assert.equal(f.local.position, f.master.position);
  assert.equal(f.local.paused, false);
  assert.equal(f.output.muted, true);
  await f.advance(500);
  assert.equal(f.output.muted, false);
  assert.equal(f.output.volume, 0.6);
  assert.equal(f.leaderStatuses.at(-1).state, 'synchronized');
  assert.equal(f.calls.filter(call => call[0] === 'seek').length, 1);
});

test('short packet delay advances the master clock instead of seeking to its old position', async t => {
  const f = fixture(t);
  f.leader.setSettings({ enabled: true });
  await f.leader.tick();
  f.time(800);
  await f.follower.tick();
  assert.ok(Math.abs(f.local.position - (f.master.position + 0.8)) < 0.00001);
});

test('small drift changes rate by at most three percent and returns to normal inside tolerance', async t => {
  const f = fixture(t);
  await f.enable();
  await f.advance(3500);
  f.local.position = f.master.position - 1;
  await f.follower.tick();
  assert.equal(f.output.rate, 1.03);
  f.local.position = f.master.position + 1;
  await f.follower.tick();
  assert.equal(f.output.rate, 0.97);
  f.local.position = f.master.position + 0.1;
  await f.follower.tick();
  assert.equal(f.output.rate, 1);
  assert.equal(f.calls.filter(call => call[0] === 'seek').length, 1);
});

test('an explicit master pause and restart are followed; manual follower pause is not stolen', async t => {
  const f = fixture(t);
  await f.enable();
  await f.advance(500);
  f.master.paused = true;
  await f.leader.tick(); await f.follower.tick();
  assert.equal(f.local.paused, true);
  f.master.paused = false;
  await f.leader.tick(); await f.follower.tick();
  assert.equal(f.local.paused, false);
  const playCount = f.calls.filter(call => call[0] === 'play').length;
  f.local.paused = true;
  await f.advance(1000); await f.advance(1000);
  assert.equal(f.calls.filter(call => call[0] === 'play').length, playCount);
  assert.match(f.followerStatuses.at(-1).message, /点击恢复同步/);
  await f.advance(1500);
  await f.follower.resume();
  assert.equal(f.local.paused, false);
});

test('autoplay rejection is surfaced once and only retried on explicit resume', async t => {
  const f = fixture(t, { paused: true, playRejects: true });
  await f.enable();
  await f.advance(4000); await f.advance(4000);
  assert.equal(f.calls.filter(call => call[0] === 'play').length, 1);
  assert.equal(f.followerStatuses.at(-1).state, 'blocked');
  assert.equal(f.output.muted, true);
  await f.follower.resume();
  assert.equal(f.calls.filter(call => call[0] === 'play').length, 2);
});

test('a short lost heartbeat never pauses; a long loss only mutes and valid messages recover', async t => {
  const f = fixture(t);
  await f.enable(); await f.advance(500);
  await f.advance(6000, false);
  assert.equal(f.followerStatuses.at(-1).state, 'connection-slow');
  assert.equal(f.output.muted, false);
  await f.advance(25000, false);
  assert.equal(f.output.muted, true);
  assert.equal(f.local.paused, false);
  assert.equal(f.calls.filter(call => call[0] === 'pause').length, 0);
  await f.leader.tick(); await f.follower.tick(); await f.advance(500);
  assert.equal(f.output.muted, false);
  assert.equal(f.followerStatuses.at(-1).state, 'synchronized');
});

test('an unavailable target stays muted and is never clamped to the live edge', async t => {
  const f = fixture(t);
  f.local.lower = f.master.position + 5;
  await f.enable();
  assert.equal(f.followerStatuses.at(-1).state, 'waiting-range');
  assert.equal(f.output.muted, true);
  assert.equal(f.calls.filter(call => call[0] === 'seek').length, 0);
  f.local.lower = f.master.lower;
  await f.advance(500); await f.advance(500);
  assert.equal(f.followerStatuses.at(-1).state, 'synchronized');
});

test('a slow seek is given settling time; buffering prevents repeated seeks', async t => {
  const f = fixture(t, { seekMoves: false });
  await f.enable();
  await f.advance(500); await f.advance(500); await f.advance(500);
  assert.equal(f.calls.filter(call => call[0] === 'seek').length, 1);
  f.local.ready = false;
  await f.advance(5000);
  assert.equal(f.calls.filter(call => call[0] === 'seek').length, 1);
  assert.equal(f.followerStatuses.at(-1).state, 'waiting-buffer');
  assert.equal(f.output.muted, true);
});

test('disable pauses only the follower; re-enable and volume/offset changes use the same synchronization clock', async t => {
  const f = fixture(t);
  await f.enable(); await f.advance(3500);
  f.leader.setSettings({ enabled: false }); await f.leader.tick(); await f.follower.tick();
  assert.equal(f.local.paused, true);
  assert.equal(f.master.paused, false);
  assert.equal(f.output.muted, true);
  f.leader.setSettings({ enabled: true, volume: 0.25, offset: -2 });
  await f.leader.tick(); await f.follower.tick(); await f.advance(500);
  assert.ok(Math.abs(f.local.position - (f.master.position - 2)) < 0.001);
  assert.equal(f.output.volume, 0.25);
  assert.equal(f.local.paused, false);
  assert.equal(f.output.muted, false);
});

test('old sequence, wrong programme/pair, non-finite clocks, and stale packets cannot move the player', async t => {
  const f = fixture(t);
  await f.enable(); await f.advance(500);
  const valid = f.messages.filter(message => message.type === 'state').at(-1);
  const oldPacket = f.follower.packet;
  for (const patch of [
    { seq: valid.seq }, { programmeId: 'other' }, { pairId: 'other' },
    { state: { ...valid.state, position: Infinity } }, { sentAt: valid.sentAt - 40000 },
    { settings: { enabled: true, volume: 9, offset: 0 } },
  ]) {
    f.follower.receive({ ...structuredClone(valid), seq: valid.seq + 100, state: { ...valid.state, position: valid.state.position + 30 }, ...patch });
    assert.equal(f.follower.packet, oldPacket);
  }
  await f.follower.tick();
  assert.equal(f.calls.filter(call => call[0] === 'seek').length, 1);
  assert.throws(() => f.leader.setSettings({ offset: NaN }), TypeError);
});

test('different pairs and broadcasts never share control messages', async t => {
  const f = fixture(t);
  for (const options of [{ pairId: 'other-pair' }, { programmeId: 'other-race' }]) {
    const other = f.create({ role: 'leader', getState: () => f.master, ...options });
    other.setSettings({ enabled: true }); await other.tick();
  }
  await f.follower.tick();
  assert.equal(f.follower.packet, null);
  assert.equal(f.calls.filter(call => call[0] === 'seek' || call[0] === 'pause' || call[0] === 'play').length, 0);
});

test('closing silences only the optional output and rejects future work', async t => {
  const f = fixture(t);
  await f.enable(); await f.advance(500);
  f.follower.close(); f.leader.close();
  const count = f.calls.length;
  await f.follower.tick(); await f.follower.resume(); await f.leader.tick();
  assert.equal(f.calls.length, count);
  assert.equal(f.output.muted, true);
  assert.equal(f.master.paused, false);
});

test('resetOutput reapplies controls and aligns a replacement SDK player without inheriting old cached values', async t => {
  const f = fixture(t);
  await f.enable(); await f.advance(500);
  const before = f.calls.length;
  f.output.muted = false; f.output.volume = 1; f.output.rate = 2;
  f.local.paused = true; f.local.position = f.master.position + 20;
  f.follower.resetOutput();
  await f.follower.tick(); await f.advance(500);
  const replacementCalls = f.calls.slice(before);
  assert.deepEqual(replacementCalls[0], ['muted', true]);
  assert.ok(replacementCalls.some(call => call[0] === 'rate' && call[1] === 1));
  assert.ok(replacementCalls.some(call => call[0] === 'volume' && call[1] === 0.6));
  assert.equal(replacementCalls.filter(call => call[0] === 'play').length, 1);
  assert.equal(replacementCalls.filter(call => call[0] === 'seek').length, 1);
  assert.equal(f.local.position, f.master.position);
  assert.equal(f.output.muted, false);
  assert.equal(f.output.volume, 0.6);
});

test('leader close sends an immediate valid disable and silences the follower without a lost-heartbeat wait', async t => {
  const f = fixture(t);
  await f.enable(); await f.advance(500);
  assert.equal(f.output.muted, false);
  f.leader.close();
  const closingPacket = f.messages.filter(message => message.type === 'state').at(-1);
  assert.equal(closingPacket.settings.enabled, false);
  assert.equal(f.follower.packet.settings.enabled, false);
  // receive() schedules this work itself even with automatic timers disabled.
  assert.ok(f.follower.runningTick);
  await f.follower.runningTick;
  assert.equal(f.output.muted, true);
  assert.equal(f.local.paused, true);
  assert.equal(f.master.paused, false);
  assert.equal(f.followerStatuses.at(-1).state, 'disabled');
});

test('an SDK seek that pauses a playing follower is restored exactly once, while later manual pause remains respected', async t => {
  const f = fixture(t, { seekPauses: true });
  await f.enable(); await f.advance(500);
  assert.equal(f.local.paused, false);
  assert.equal(f.calls.filter(call => call[0] === 'play').length, 1);
  f.local.paused = true;
  await f.advance(1000); await f.advance(1000);
  assert.equal(f.local.paused, true);
  assert.equal(f.calls.filter(call => call[0] === 'play').length, 1);
});

test('a completed seek never resumes after the latest master pauses, disables, or the follower closes', async t => {
  for (const action of ['pause', 'disable', 'close']) {
    let finishSeek, notifySeek;
    const began = new Promise(resolve => { notifySeek = resolve; });
    const gate = new Promise(resolve => { finishSeek = resolve; });
    const f = fixture(t, { seekPauses: true, onSeek: async () => { notifySeek(); await gate; } });
    const enabling = f.enable();
    await began;
    if (action === 'pause') { f.master.paused = true; await f.leader.tick(); }
    if (action === 'disable') { f.leader.setSettings({ enabled: false }); await f.leader.tick(); }
    if (action === 'close') f.follower.close();
    finishSeek();
    await enabling;
    await f.follower.tick();
    assert.equal(f.calls.filter(call => call[0] === 'play').length, 0, action);
    assert.equal(f.local.paused, true, action);
    assert.equal(f.output.muted, true, action);
  }
});

test('resume during an in-flight seek is applied afterwards and does not force another seek', async t => {
  let finishSeek, notifySeek;
  const began = new Promise(resolve => { notifySeek = resolve; });
  const gate = new Promise(resolve => { finishSeek = resolve; });
  const f = fixture(t, { seekPauses: true, playRejects: true, onSeek: async () => { notifySeek(); await gate; } });
  const enabling = f.enable();
  await began;
  const resumed = f.follower.resume();
  finishSeek();
  await enabling; await resumed;
  // The seek's autoplay attempt fails, then the explicit queued user request
  // gets its own attempt instead of being consumed by that old command.
  assert.equal(f.calls.filter(call => call[0] === 'seek').length, 1);
  assert.equal(f.calls.filter(call => call[0] === 'play').length, 2);
  assert.equal(f.followerStatuses.at(-1).state, 'blocked');
  await f.advance(500);
  assert.equal(f.calls.filter(call => call[0] === 'play').length, 2);
});
