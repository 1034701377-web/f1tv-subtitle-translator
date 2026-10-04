import test from 'node:test';
import assert from 'node:assert/strict';
import { VideoOverlay } from '../src/overlay.js';
import { CueStore, SubtitleTimeline } from '../src/core.js';

class Element {
  constructor(tagName = 'div') {
    Object.assign(this, { tagName, style: {}, dataset: {}, textContent: '', children: [], listeners: new Map(),
      parentElement: null, hidden: false, rectReads: 0, rect: { left: 0, top: 0, width: 300, height: 80 } });
    this.classList = new Set();
    this.classList.remove = value => this.classList.delete(value);
  }
  append(node) { node.remove(); this.children.push(node); node.parentElement = this; }
  insertBefore(node, before) {
    node.remove(); this.children.splice(this.children.indexOf(before), 0, node); node.parentElement = this;
  }
  remove() {
    if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
    this.parentElement = null;
  }
  attachShadow() {
    const stack = new Element();
    return { set innerHTML(value) {}, querySelector: () => stack };
  }
  addEventListener(name, listener, { signal } = {}) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(listener);
    signal?.addEventListener('abort', () => this.listeners.get(name).delete(listener), { once: true });
  }
  emit(name) { for (const listener of [...(this.listeners.get(name) || [])]) listener(); }
  count(name) { return this.listeners.get(name)?.size || 0; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  getBoundingClientRect() { this.rectReads++; return this.rect; }
}

function setup(t) {
  const document = new Element('document'), window = new Element('window'), video = new Element('video');
  document.body = new Element('body'); document.createElement = tag => new Element(tag);
  document.fullscreenElement = null;
  Object.assign(video, { currentTime: 10, videoWidth: 1920, videoHeight: 1080,
    rect: { left: 20, top: 30, width: 960, height: 540 } });
  document.body.append(video);
  for (const [key, value] of Object.entries({ document, window })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, key, original) : delete globalThis[key]);
  }
  const intervals = new Map(); let nextId = 0, wall = 0;
  t.mock.method(globalThis, 'setInterval', (fn, ms) => { intervals.set(++nextId, { fn, ms }); return nextId; });
  t.mock.method(globalThis, 'clearInterval', id => intervals.delete(id));
  t.mock.method(performance, 'now', () => wall);
  return { document, window, video, intervals, tick() {
    wall += 80;
    for (const { fn } of [...intervals.values()]) fn();
  } };
}

function recordingTimeline(prefix) {
  return { times: [], seeks: 0, seek() { this.seeks++; }, render(time) {
    this.times.push(time);
    return { text: `${prefix} ${time}`, lines: [], hasEnglish: false };
  } };
}

test('two subtitle clocks share one 80 ms tick, one layout and one set of media listeners', t => {
  const env = setup(t), normal = recordingTimeline('normal'), radio = recordingTimeline('radio');
  let radioTime = 1010;
  const rendered = [];
  const root = new VideoOverlay(env.video, normal);
  const child = new VideoOverlay(env.video, radio, { above: root, getTime: () => radioTime });
  root.onRender = state => rendered.push([state.text, root.label.textContent, child.label.textContent, env.video.rectReads]);
  child.onRender = root.onRender;
  assert.equal(env.intervals.size, 1);
  assert.equal([...env.intervals.values()][0].ms, 80);
  assert.equal(env.video.count('seeking'), 1);
  assert.equal(env.video.count('timeupdate'), 1);
  assert.equal(env.document.count('fullscreenchange'), 1);
  const before = [env.video.rectReads, root.stack.rectReads];
  env.video.currentTime = 10.08; radioTime = 1010.08; env.tick();
  assert.equal(normal.times.at(-1), 10.08);
  assert.equal(radio.times.at(-1), 1010.08);
  assert.deepEqual([env.video.rectReads - before[0], root.stack.rectReads - before[1]], [1, 1]);
  assert.deepEqual(rendered, [
    ['normal 10.08', 'normal 10.08', 'radio 1010.08', before[0] + 1],
    ['radio 1010.08', 'normal 10.08', 'radio 1010.08', before[0] + 1]
  ]);
  radioTime = 1010.12; child.draw();
  assert.equal(child.label.textContent, 'radio 1010.12');
  root.dispose();
});

test('disposing a child keeps the main clock alive; disposing the root releases every layer and listener', t => {
  const env = setup(t), normal = recordingTimeline('normal'), radio = recordingTimeline('radio');
  const root = new VideoOverlay(env.video, normal);
  const child = new VideoOverlay(env.video, radio, { above: root });
  child.dispose();
  const childRenders = radio.times.length;
  assert.equal(root.layers.size, 1);
  assert.equal(child.line.parentElement, null);
  assert.equal(env.intervals.size, 1);
  env.video.currentTime = 10.08; env.tick();
  assert.equal(root.label.textContent, 'normal 10.08');
  assert.equal(radio.times.length, childRenders);
  const cleared = [];
  const nextChild = new VideoOverlay(env.video, radio, { above: root, onRender: state => cleared.push(state.text) });
  root.dispose();
  assert.equal(nextChild.disposed, true);
  assert.equal(cleared.at(-1), '');
  assert.equal(root.host.parentElement, null);
  assert.equal(env.intervals.size, 0);
  assert.equal(env.video.count('timeupdate') + env.video.count('seeking') + env.document.count('fullscreenchange') + env.window.count('resize'), 0);
  assert.equal([...root.stack.listeners.values()].reduce((n, listeners) => n + listeners.size, 0), 0);
  const counts = [normal.times.length, radio.times.length];
  env.video.emit('timeupdate'); env.video.emit('seeking'); env.document.emit('fullscreenchange');
  nextChild.draw(); nextChild.dispose(); root.draw(); root.dispose();
  assert.deepEqual([normal.times.length, radio.times.length], counts);
});

test('shared drawing preserves frozen sentences and detects independent programme-clock jumps', t => {
  const env = setup(t), normalStore = new CueStore(), radioStore = new CueStore();
  const normalCue = normalStore.add({ start: 10, end: 15, text: 'Original commentary' });
  const radioCue = radioStore.add({ start: 1010, end: 1015, text: 'Original radio' });
  const normal = new SubtitleTimeline(normalStore), radio = new SubtitleTimeline(radioStore);
  normal.setEnabled(true); radio.setEnabled(true);
  let radioTime = 1010;
  const root = new VideoOverlay(env.video, normal);
  const child = new VideoOverlay(env.video, radio, { above: root, getTime: () => radioTime });
  normalCue.zh = '解说中文'; radioCue.zh = '车队通话';
  env.video.currentTime = 10.08; radioTime = 1010.08; env.tick();
  assert.equal(root.label.textContent, 'Original commentary');
  assert.equal(child.label.textContent, 'Original radio');
  env.video.currentTime = 10.16; radioTime = 1012; env.tick();
  assert.equal(root.label.textContent, 'Original commentary');
  assert.equal(child.label.textContent, '车队通话');
  const reads = env.video.rectReads;
  env.video.emit('seeking');
  assert.equal(root.label.textContent, '解说中文');
  assert.equal(env.video.rectReads - reads, 1);
  root.dispose();
});

test('fullscreen changes reposition the shared host and report native-video fullscreen as hidden', t => {
  const env = setup(t), states = [];
  const root = new VideoOverlay(env.video, recordingTimeline('normal'), { onRender: state => states.push(state.text) });
  const child = new VideoOverlay(env.video, recordingTimeline('radio'), { above: root, onRender: state => states.push(state.text) });
  const player = new Element(); player.append(env.video); env.document.body.append(player);
  env.document.fullscreenElement = player;
  const reads = env.video.rectReads;
  env.document.emit('fullscreenchange');
  assert.equal(root.host.parentElement, player);
  assert.equal(env.video.rectReads - reads, 1);
  assert.equal(root.host.style.display, 'block');
  env.document.fullscreenElement = env.video;
  env.document.emit('fullscreenchange');
  assert.equal(root.host.style.display, 'none');
  assert.deepEqual(states.slice(-2), ['', '']);
  assert.equal(child.root, root);
  root.dispose();
});
