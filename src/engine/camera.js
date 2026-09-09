// T0-N05 · Camera + F-N05 · Camera dynamics.
// Soft deadzone follow, clamped to bounds, with hooks for the throne push-in.
import { clamp, damp, lerp } from '../core/math.js';

export function createCamera(viewW, viewH) {
  return {
    x: 0, y: 0,
    viewW, viewH,
    zoom: 1,
    targetZoom: 1,
    deadzone: 48,
    shake: 0,
    shakeX: 0, shakeY: 0,
    bounds: null,          // {x,y,w,h}
    lookAhead: { x: 0, y: 0 },
    _seeded: false,

    setBounds(b) { this.bounds = b; },

    resize(w, h) { this.viewW = w; this.viewH = h; },

    // Nudge the camera toward what the player is locked onto, so it "looks at"
    // the fight without the player noticing it happened.
    follow(fx, fy, dt, { lookAtX = null, lookAtY = null, lookStrength = 0.22 } = {}) {
      let tx = fx, ty = fy;
      if (lookAtX !== null) {
        tx = lerp(fx, lookAtX, lookStrength);
        ty = lerp(fy, lookAtY, lookStrength);
      }
      if (!this._seeded) { this.x = tx; this.y = ty; this._seeded = true; }

      const dx = tx - this.x, dy = ty - this.y;
      const d = Math.hypot(dx, dy);
      if (d > this.deadzone) {
        const overshoot = d - this.deadzone;
        const nx = dx / d, ny = dy / d;
        const gx = this.x + nx * overshoot;
        const gy = this.y + ny * overshoot;
        this.x = damp(this.x, gx, 0.09, dt);
        this.y = damp(this.y, gy, 0.09, dt);
      }

      this.zoom = damp(this.zoom, this.targetZoom, 0.25, dt);
      this.clampToBounds();

      if (this.shake > 0) {
        this.shake = Math.max(0, this.shake - dt * 3.2);
        const m = this.shake * this.shake * 14;
        this.shakeX = (Math.random() * 2 - 1) * m;
        this.shakeY = (Math.random() * 2 - 1) * m;
      } else {
        this.shakeX = this.shakeY = 0;
      }
    },

    clampToBounds() {
      const b = this.bounds;
      if (!b) return;
      const halfW = this.viewW / (2 * this.zoom);
      const halfH = this.viewH / (2 * this.zoom);
      // A room narrower than the view centers instead of jittering at both edges.
      this.x = b.w <= halfW * 2 ? b.x + b.w / 2 : clamp(this.x, b.x + halfW, b.x + b.w - halfW);
      this.y = b.h <= halfH * 2 ? b.y + b.h / 2 : clamp(this.y, b.y + halfH, b.y + b.h - halfH);
    },

    addShake(amount) { this.shake = Math.min(1.4, this.shake + amount); },
    snapTo(x, y) { this.x = x; this.y = y; this._seeded = true; this.clampToBounds(); },

    apply(ctx) {
      ctx.translate(this.viewW / 2, this.viewH / 2);
      ctx.scale(this.zoom, this.zoom);
      ctx.translate(-this.x + this.shakeX, -this.y + this.shakeY);
    },

    screenToWorld(sx, sy) {
      return {
        x: (sx - this.viewW / 2) / this.zoom + this.x,
        y: (sy - this.viewH / 2) / this.zoom + this.y,
      };
    },
    worldToScreen(wx, wy) {
      return {
        x: (wx - this.x + this.shakeX) * this.zoom + this.viewW / 2,
        y: (wy - this.y + this.shakeY) * this.zoom + this.viewH / 2,
      };
    },
  };
}
