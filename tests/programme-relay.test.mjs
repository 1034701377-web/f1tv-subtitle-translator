import test from 'node:test';
import assert from 'node:assert/strict';
import { ProgrammeRelay } from '../src/programme-relay.js';

function fixture(t) {
  let clock = 0;
  const channels = [], messages = [], relays = [];
  const channelFactory = name => {
    const channel = {
      name, closed: false, onmessage: null,
      postMessage(message) {
        if (channel.closed) return;
        messages.push(structuredClone(message));
        for (const other of channels) {
          if (other !== channel && !other.closed && other.name === name) other.onmessage?.({ data: structuredClone(message) });
        }
      },
      close() { channel.closed = true; },
    };
    channels.push(channel);
    return channel;
  };
  const create = options => {
    const relay = new ProgrammeRelay({ programmeId: '1000010360:live', now: () => clock, channelFactory, ...options });
    relays.push(relay);
    return relay;
  };
  t.after(() => relays.forEach(relay => relay.close()));
  return { create, messages, time: value => { clock = value; } };
}

function cue(id, overrides = {}) {
  return { id: String(id), start: 1800000000 + Number(id) * 4, end: 1800000003 + Number(id) * 4,
    text: `Original ${id}.`, zh: `中文 ${id}。`, status: 'ready', ...overrides };
}

test('late viewer receives translated history once, with connected status before cues', t => {
  const f = fixture(t), events = [], received = [];
  const collector = f.create({ role: 'collector' });
  collector.setStatus({ state: 'capturing', contentTime: 1800000060, capturedUntil: 1800000055 });
  collector.publish([cue(1), cue(2), cue(3, { status: 'pending' }), cue(4, { zh: 'English only' }), cue(5, { start: NaN })]);
  const viewer = f.create({ onStatus: value => events.push(value), onCues: (cues, meta) => { received.push(...cues); events.push(meta); } });
  assert.deepEqual(received.map(value => value.id), ['1', '2']);
  const connected = events.findIndex(value => value.connected);
  const firstCues = events.findIndex(value => value.collectorId && value.connected === undefined);
  assert.ok(connected >= 0 && connected < firstCues);
  assert.equal(events[connected].contentTime, 1800000060);
  assert.equal(events[firstCues].collectorId, collector.id);
  collector.publish([cue(1), cue(2), cue(6)]);
  collector.receive({ version: 1, type: 'hello', programmeId: collector.programmeId, sender: viewer.id });
  assert.deepEqual(received.map(value => value.id), ['1', '2', '6']);
});

test('viewer connects, rebinds without disabling capture, and explicitly closes its replacement', t => {
  const f = fixture(t), playback = [], received = [];
  const viewer = f.create({ onCues: cues => received.push(...cues) });
  viewer.setViewerState({ contentTime: 1800000010, paused: true, enabled: true });
  const collector = f.create({ role: 'collector', onViewerState: value => playback.push(value) });
  assert.deepEqual(playback.at(-1), { contentTime: 1800000010, paused: true, enabled: true, connected: true, viewerId: viewer.id });
  collector.publish([cue(1)]);
  assert.equal(received.length, 1);
  viewer.close({ disableViewer: false });
  assert.equal(playback.at(-1).enabled, true);
  const replacement = f.create({});
  replacement.setViewerState({ contentTime: 1800000011, paused: false, enabled: true });
  assert.equal(playback.at(-1).viewerId, replacement.id);
  replacement.close();
  assert.equal(playback.at(-1).connected, false);
  assert.equal(playback.at(-1).reason, 'disabled');
});

test('programme channels and the envelope both isolate different broadcasts', t => {
  const f = fixture(t), received = [];
  const viewer = f.create({ onCues: cues => received.push(...cues) });
  const unrelated = f.create({ role: 'collector', programmeId: '1000099999:live' });
  unrelated.publish([cue(1)]);
  const connected = f.create({ role: 'collector' });
  viewer.receive({ version: 1, type: 'cues', programmeId: unrelated.programmeId, sender: connected.id, cues: [cue(2)] });
  viewer.receive({ version: 1, type: 'cues', programmeId: viewer.programmeId, sender: connected.id, target: 'someone_else', cues: [cue(2)] });
  assert.equal(received.length, 0);
  connected.publish([cue(3)]);
  assert.deepEqual(received.map(value => value.id), ['3']);
});

test('one collector keeps its lease; after loss viewer selects the most recently active alternative', t => {
  const f = fixture(t), received = [], states = [];
  const first = f.create({ role: 'collector' });
  const viewer = f.create({ onCues: cues => received.push(...cues), onStatus: value => states.push(value) });
  const second = f.create({ role: 'collector' });
  first.publish([cue(1)]);
  second.publish([cue(2)]);
  assert.deepEqual(received.map(value => value.id), ['1']);
  f.time(5000); second.tick();
  assert.equal(states.at(-1).collectorId, first.id);
  first.channel.close();
  f.time(120100); viewer.tick();
  assert.ok(states.some(value => !value.connected && value.state === 'disconnected' && value.collectorId === first.id));
  assert.equal(states.at(-1).collectorId, second.id);
  assert.deepEqual(received.map(value => value.id), ['1', '2']);
});

test('stop, error, close and heartbeat timeout explicitly disconnect the viewer', t => {
  const f = fixture(t), states = [];
  const collector = f.create({ role: 'collector' });
  const viewer = f.create({ onStatus: value => states.push(value) });
  collector.setStatus({ state: 'error', message: '共享已停止' });
  assert.equal(states.at(-1).state, 'error');
  assert.equal(states.at(-1).connected, false);
  collector.setStatus({ state: 'capturing' });
  assert.equal(states.at(-1).connected, true);
  collector.setStatus({ state: 'stopped' });
  assert.equal(states.at(-1).state, 'stopped');
  collector.setStatus({ state: 'capturing' });
  collector.channel.close();
  f.time(119999); viewer.tick();
  assert.equal(states.at(-1).connected, true);
  f.time(120000); viewer.tick();
  assert.equal(states.at(-1).state, 'disconnected');
  assert.equal(states.at(-1).connected, false);
  const replacement = f.create({ role: 'collector' });
  replacement.close();
  assert.equal(states.at(-1).state, 'stopped');
});

test('viewer state is validated, renewed and expires independently, with one viewer lease', t => {
  const f = fixture(t), states = [];
  const collector = f.create({ role: 'collector', onViewerState: value => states.push(value) });
  const first = f.create({});
  first.setViewerState({ contentTime: 1800000001, paused: false, enabled: true });
  const second = f.create({});
  second.setViewerState({ contentTime: 1800000050, paused: true, enabled: true });
  assert.equal(states.at(-1).viewerId, first.id);
  const count = states.length;
  first.setViewerState({ contentTime: Infinity, paused: false, enabled: true });
  first.setViewerState({ contentTime: 1, paused: false, enabled: true, secret: 'must not send' });
  assert.equal(states.length, count);
  f.time(5000); second.tick();
  first.channel.close();
  f.time(120000); collector.tick();
  assert.equal(states.at(-1).viewerId, second.id);
  assert.ok(states.some(value => !value.connected && value.viewerId === first.id && value.enabled && value.reason === 'timeout'));
  second.setViewerState({ contentTime: 1800000051, paused: true, enabled: false });
  assert.equal(states.at(-1).connected, false);
  assert.equal(states.at(-1).reason, 'disabled');
});

test('illegal or oversized messages are ignored and outbound cues contain only allowlisted fields', t => {
  const f = fixture(t), received = [];
  const collector = f.create({ role: 'collector' });
  const viewer = f.create({ onCues: cues => received.push(...cues) });
  const envelope = { version: 1, type: 'cues', programmeId: viewer.programmeId, sender: collector.id };
  for (const addition of [
    { cues: [cue(1)], unknown: true }, { cues: Array.from({ length: 33 }, (_, i) => cue(i)) },
    { cues: [cue(1, { text: 'a'.repeat(2049) })] }, { cues: [cue(1, { zh: '英'.repeat(4097) })] },
    { cues: [cue(1, { secret: 'unknown cue property' })] }, { cues: [cue(1, { end: Infinity })] },
    { cues: [cue(1, { end: 1800009000 })] },
  ]) viewer.receive({ ...envelope, ...addition });
  assert.equal(received.length, 0);
  collector.publish([cue(2, { secret: 'private', url: 'must not pass', audio: new Uint8Array(10) })]);
  assert.equal(received.length, 1);
  assert.deepEqual(Object.keys(received[0]).sort(), ['end', 'id', 'start', 'status', 'text', 'zh']);
  const sent = f.messages.filter(value => value.type === 'cues');
  assert.ok(sent.every(value => !JSON.stringify(value).includes('private')));
  const inflated = Array.from({ length: 32 }, (_, i) => cue(20 + i, { text: '\u0001'.repeat(2048), zh: `中${'\u0001'.repeat(4095)}` }));
  viewer.receive({ ...envelope, cues: inflated });
  assert.equal(received.length, 1);
  collector.publish(inflated);
  assert.equal(received.length, 33);
  assert.ok(f.messages.filter(value => value.type === 'cues').every(value => JSON.stringify(value).length <= 200000));
});

test('history remains at most 600 cues and expires after ten minutes', t => {
  const f = fixture(t), received = [], expired = [];
  const collector = f.create({ role: 'collector' });
  collector.publish(Array.from({ length: 650 }, (_, i) => cue(i)));
  assert.equal(collector.cache.size, 600);
  const viewer = f.create({ onCues: cues => received.push(...cues) });
  assert.equal(received.length, 600);
  assert.equal(received[0].id, '50');
  viewer.close();
  f.time(600001);
  f.create({ onCues: cues => expired.push(...cues) });
  assert.equal(expired.length, 0);
  assert.equal(collector.cache.size, 0);
});
