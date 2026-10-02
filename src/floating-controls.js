// Positioning and interaction only; minimizing never toggles translation.
export class FloatingControls {
  constructor(host, { panel, handle, minimize, ball, saved, onSave = () => {} }) {
    this.host = host; this.panel = panel; this.handle = handle; this.ball = ball; this.onSave = onSave;
    this.collapsed = saved?.collapsed === true;
    this.side = saved?.side === 'left' ? 'left' : 'right';
    this.centerX = Number.isFinite(saved?.centerX) ? saved.centerX : null;
    this.centerY = Number.isFinite(saved?.centerY) ? saved.centerY : null;
    this.events = new AbortController();
    const listen = (target, name, callback) => target.addEventListener(name, callback, { signal: this.events.signal });
    for (const grip of [handle, ball]) {
      listen(grip, 'pointerdown', event => this.beginDrag(event, grip));
      listen(grip, 'pointermove', event => this.moveDrag(event));
      listen(grip, 'pointerup', event => this.endDrag(event));
      listen(grip, 'pointercancel', event => this.endDrag(event));
      listen(grip, 'lostpointercapture', event => this.endDrag(event));
    }
    listen(minimize, 'click', () => this.setCollapsed(true));
    listen(ball, 'click', event => {
      // Consume only the click produced by a drag. A fresh pointerdown clears
      // this flag; keyboard activation (detail=0) always remains available.
      if (this.suppressBallClick && event.detail !== 0) {
        this.suppressBallClick = false; event.preventDefault(); return;
      }
      this.suppressBallClick = false; this.setCollapsed(false);
    });
    listen(host, 'click', event => event.stopPropagation());
    listen(window, 'resize', () => { this.endDrag(); this.refresh(); });
    listen(document, 'fullscreenchange', () => { this.endDrag(); this.refresh(); });
    this.observer = new ResizeObserver(() => this.refresh());
    this.observer.observe(panel); this.observer.observe(ball);
    this.refresh();
  }
  refresh() {
    // Do not measure zero-sized hidden controls or change their saved position.
    this.host.style.display = document.fullscreenElement ? 'none' : 'block';
    if (document.fullscreenElement) return;
    this.panel.hidden = this.collapsed; this.ball.hidden = !this.collapsed;
    const rect = (this.collapsed ? this.ball : this.panel).getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const margin = 8, width = window.innerWidth, height = window.innerHeight;
    if (this.centerX === null) this.centerX = width - 18 - rect.width / 2;
    if (this.centerY === null) this.centerY = 18 + rect.height / 2;
    const maxLeft = Math.max(margin, width - margin - rect.width);
    const maxTop = Math.max(margin, height - margin - rect.height);
    let left = Math.max(margin, Math.min(maxLeft, this.centerX - rect.width / 2));
    const top = Math.max(margin, Math.min(maxTop, this.centerY - rect.height / 2));
    if (this.collapsed && !this.drag) left = this.side === 'left' ? margin : maxLeft;
    this.centerX = left + rect.width / 2; this.centerY = top + rect.height / 2;
    Object.assign(this.host.style, { right: 'auto', left: `${left}px`, top: `${top}px` });
  }
  beginDrag(event, grip) {
    if (event.button !== 0 || event.isPrimary === false || this.drag) return;
    if (grip === this.handle && event.target.closest('button, input, a, select, textarea')) return;
    this.suppressBallClick = false;
    this.drag = { pointerId: event.pointerId, grip, x: event.clientX, y: event.clientY,
      centerX: this.centerX, centerY: this.centerY, moved: false };
    grip.setPointerCapture(event.pointerId);
    event.stopPropagation();
  }
  moveDrag(event) {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    drag.moved = true;
    this.host.dataset.dragging = 'true';
    this.centerX = drag.centerX + dx; this.centerY = drag.centerY + dy;
    this.refresh(); event.preventDefault(); event.stopPropagation();
  }
  endDrag(event) {
    const drag = this.drag;
    if (!drag || (event && event.pointerId !== drag.pointerId)) return;
    this.drag = null; delete this.host.dataset.dragging;
    if (drag.grip.hasPointerCapture(drag.pointerId)) drag.grip.releasePointerCapture(drag.pointerId);
    if (drag.moved) {
      this.side = this.centerX < window.innerWidth / 2 ? 'left' : 'right';
      this.suppressBallClick = drag.grip === this.ball;
      this.refresh(); this.save();
    }
  }
  setCollapsed(value) {
    if (value) this.side = this.centerX < window.innerWidth / 2 ? 'left' : 'right';
    this.collapsed = value;
    this.refresh(); this.save();
    (value ? this.ball : this.handle.querySelector('button')).focus({ preventScroll: true });
  }
  save() {
    this.onSave({ centerX: this.centerX, centerY: this.centerY, side: this.side, collapsed: this.collapsed });
  }
  dispose() {
    this.endDrag(); this.events.abort(); this.observer.disconnect();
  }
}
