const SUBTITLE_FONTS = {
  yahei: '"Microsoft YaHei", "微软雅黑", sans-serif',
  heiti: 'SimHei, "黑体", sans-serif',
  songti: 'SimSun, "宋体", serif',
  system: 'system-ui, sans-serif'
};

export function normalizeSubtitleStyle(value = {}) {
  return { font: Object.hasOwn(SUBTITLE_FONTS, value?.font) ? value.font : 'yahei',
    size: Number.isFinite(value?.size) ? Math.max(16, Math.min(48, value.size)) : 28,
    bold: value?.bold === true };
}

// Both timelines share one physical stack; moving either moves them together.
export class VideoOverlay {
  constructor(video, timeline, { getTime = () => video.currentTime, onRender = () => {}, opacity = 1,
    above = null, prefix = '', style = {}, position = null, onPositionSave = () => {} } = {}) {
    Object.assign(this, { video, timeline, getTime, onRender, above, prefix });
    this.root = above?.root || this;
    this.line = document.createElement('div'); this.line.className = 'line';
    this.label = document.createElement('span'); this.line.append(this.label);
    if (above) {
      this.host = this.root.host; this.stack = this.root.stack;
      this.line.dataset.track = 'radio'; this.line.style.color = '#a9d9ff';
      this.stack.insertBefore(this.line, above.line); this.root.layers.add(this);
    } else {
      this.layers = new Set([this]); this.onPositionSave = onPositionSave;
      this.position = { x: Number.isFinite(position?.x) ? position.x : .5,
        bottom: Number.isFinite(position?.bottom) ? position.bottom : .08 };
      this.host = document.createElement('div'); this.host.dataset.f1zh = 'overlay';
      this.host.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;display:none;';
      const shadow = this.host.attachShadow({ mode: 'open' });
      shadow.innerHTML = `<style>:host{all:initial}[hidden]{display:none!important}.stack{position:absolute;display:flex;flex-direction:column;align-items:center;gap:.3em;width:max-content;max-width:90%;transform:translateX(-50%);pointer-events:none;color:#fff;line-height:1.5;text-shadow:0 2px 3px #000;touch-action:none;user-select:none}.line{max-width:100%;text-align:center;white-space:pre-line;overflow-wrap:anywhere;min-height:1.5em}.line span{pointer-events:auto;cursor:grab;background:rgba(0,0,0,.78);box-decoration-break:clone;-webkit-box-decoration-break:clone;padding:.14em .4em;border-radius:4px}.stack.dragging span{cursor:grabbing}</style><div class="stack" title="拖动字幕可同时移动普通字幕与 TR"></div>`;
      this.stack = shadow.querySelector('.stack'); this.stack.append(this.line);
      this.events = new AbortController();
      const listen = (target, name, fn) => target.addEventListener(name, fn, { signal: this.events.signal });
      listen(this.stack, 'pointerdown', event => this.beginDrag(event));
      listen(this.stack, 'pointermove', event => this.moveDrag(event));
      for (const name of ['pointerup','pointercancel','lostpointercapture']) listen(this.stack, name, event => this.endDrag(event));
      listen(this.stack, 'click', event => event.stopPropagation());
      listen(window, 'resize', () => { this.endDrag(); this.layout(); });
      document.body.append(this.host);
      this.setStyle(style); this.setOpacity(opacity);
    }
    this.onSeek = () => { timeline.seek(); this.draw(); };
    this.onDraw = () => this.draw();
    video.addEventListener('seeking', this.onSeek);
    video.addEventListener('timeupdate', this.onDraw);
    document.addEventListener('fullscreenchange', this.onDraw);
    this.timer = setInterval(this.onDraw, 80);
    this.draw();
  }
  setStyle(value) {
    const style = normalizeSubtitleStyle(value);
    Object.assign(this.root.stack.style, { fontFamily: SUBTITLE_FONTS[style.font],
      fontSize: `${style.size}px`, fontWeight: style.bold ? '700' : '400' });
    this.root.layout();
  }
  setOpacity(value) {
    this.root.stack.style.opacity = String(Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1);
  }
  layout() {
    if (this !== this.root) return this.root.layout();
    const fs = document.fullscreenElement;
    const parent = fs && fs !== this.video && fs.contains(this.video) ? fs : document.body;
    if (this.host.parentElement !== parent) parent.append(this.host);
    const r = this.video.getBoundingClientRect();
    let width = r.width, height = r.height, left = r.left, top = r.top;
    if (this.video.videoWidth && this.video.videoHeight) {
      const scale = Math.min(width / this.video.videoWidth, height / this.video.videoHeight);
      const w = this.video.videoWidth * scale, h = this.video.videoHeight * scale;
      left += (width - w) / 2; top += (height - h) / 2; width = w; height = h;
    }
    const visible = [...this.layers].some(layer => layer.label.textContent);
    Object.assign(this.host.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`,
      display: visible && width && height && fs !== this.video ? 'block' : 'none' });
    const box = this.stack.getBoundingClientRect();
    const x = Math.max(box.width / 2 + 8, Math.min(width - box.width / 2 - 8, this.position.x * width));
    const bottom = Math.max(8, Math.min(height - box.height - 8, this.position.bottom * height));
    Object.assign(this.stack.style, { left: `${x}px`, bottom: `${bottom}px` });
    this.bounds = { width, height, x, bottom };
  }
  beginDrag(event) {
    if (event.button !== 0 || event.isPrimary === false || this.drag || !event.target.closest('span')) return;
    this.layout();
    this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, bounds: { ...this.bounds }, moved: false };
    this.stack.setPointerCapture(event.pointerId);
    event.preventDefault(); event.stopPropagation();
  }
  moveDrag(event) {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true; this.stack.classList.add('dragging');
    const { width, height, x, bottom } = drag.bounds;
    if (!width || !height) return;
    this.position = { x: (x + dx) / width, bottom: (bottom - dy) / height };
    this.layout(); event.preventDefault(); event.stopPropagation();
  }
  endDrag(event) {
    const drag = this.drag;
    if (!drag || (event && event.pointerId !== drag.id)) return;
    this.drag = null; this.stack.classList.remove('dragging');
    if (this.stack.hasPointerCapture(drag.id)) this.stack.releasePointerCapture(drag.id);
    if (drag.moved && this.bounds.width && this.bounds.height) {
      this.position = { x: this.bounds.x / this.bounds.width, bottom: this.bounds.bottom / this.bounds.height };
      this.onPositionSave({ ...this.position });
    }
  }
  draw() {
    const time = this.getTime(), wall = performance.now()/1000;
    if (Number.isFinite(this.lastTime) && Math.abs((time-this.lastTime)-(wall-this.lastWall)) > 1) this.timeline.seek();
    this.lastTime = time; this.lastWall = wall;
    const state = this.timeline.render(time);
    const text = state.text ? this.prefix + state.text : '';
    if (this.label.textContent !== text) this.label.textContent = text;
    if (this.above) this.line.hidden = !text;
    else this.line.style.visibility = text ? 'visible' : 'hidden';
    this.line.dataset.language = state.hasEnglish ? 'en' : 'zh';
    this.root.layout();
    this.onRender(this.host.style.display === 'block' && text ? state : {lines:[],text:'',hasEnglish:false});
  }
  dispose() {
    clearInterval(this.timer); this.video.removeEventListener('seeking', this.onSeek);
    this.video.removeEventListener('timeupdate', this.onDraw);
    document.removeEventListener('fullscreenchange', this.onDraw);
    if (this === this.root) { this.endDrag(); this.events.abort(); this.host.remove(); }
    else { this.root.layers.delete(this); this.line.remove(); this.root.layout(); }
    this.onRender({lines:[],text:'',hasEnglish:false});
  }
}
