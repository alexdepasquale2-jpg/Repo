// src/systems/particles.js — Agent D
//
// Pooled particle system + screen shake. Portrait screens clutter fast, so
// everything here is deliberately restrained: short lives, low counts, small
// radii, and colours pulled from the same pastel palette as the street so a
// burst reads as part of the place rather than as an effect layer.
//
// ZERO ALLOCATION IN THE HOT PATH. The pool is built once at construction;
// update() and render() allocate nothing — no arrays, no objects, no closures,
// no string concatenation (colours are pre-baked rgba strings picked by index).

const MAX = 320;

// Pre-baked colour tables. Indexing into these avoids building rgba() strings
// per particle per frame.
const KIND_COLORS = {
  hit: ['#f6dfe4', '#efc9cf', '#d9a7ad', '#fdf1d9'],
  death: ['#c9b6a4', '#b39c88', '#d7d3dc', '#a89fb0'],
  pickup: ['#fdf1d9', '#d0e6c9', '#edf5fb', '#f7dee4'],
  levelup: ['#fdf8ee', '#e7e2f4', '#d9ecea', '#f6d3de'],
  dust: ['#d7d3dc', '#c6c0cf', '#e0d6c5', '#efe7ec'],
  debt: ['#8fb0a6', '#5a4a5d', '#3a4265', '#2b2f45'],
};

const KIND_SPEC = {
  //        count spd  spread life  size  grav  drag  fade
  hit: { n: 7, spd: 78, life: 0.30, size: 2.0, grav: 40, drag: 3.4 },
  death: { n: 16, spd: 96, life: 0.62, size: 2.6, grav: 130, drag: 2.4 },
  pickup: { n: 9, spd: 44, life: 0.72, size: 1.7, grav: -46, drag: 1.6 },
  levelup: { n: 24, spd: 120, life: 0.95, size: 2.4, grav: -22, drag: 1.9 },
  dust: { n: 5, spd: 26, life: 0.5, size: 1.5, grav: -8, drag: 2.6 },
  debt: { n: 11, spd: 34, life: 1.5, size: 2.2, grav: -14, drag: 1.2 },
};

export class Particles {
  constructor(max = MAX) {
    this.max = max;
    this.live = 0;
    // Struct-of-arrays. Fixed length, never resized.
    this.x = new Float32Array(max);
    this.y = new Float32Array(max);
    this.vx = new Float32Array(max);
    this.vy = new Float32Array(max);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.size = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.color = new Array(max).fill('#ffffff'); // references only, no new strings
    this.active = new Uint8Array(max);
    this.cursor = 0;

    // screen shake
    this.shakeAmp = 0;
    this.shakeDecay = 0;
    this.shakeT = 0;
    this.shakeX = 0;
    this.shakeY = 0;

    this._rand = 0x9e3779b9;
  }

  /** Cheap xorshift so bursts do not lean on Math.random in the hot path. */
  _r() {
    let x = this._rand;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this._rand = x >>> 0;
    return (this._rand & 0xffff) / 0x10000;
  }

  /** @returns {number} index of a free slot, recycling the oldest if full. */
  _alloc() {
    for (let i = 0; i < this.max; i++) {
      const idx = (this.cursor + i) % this.max;
      if (!this.active[idx]) { this.cursor = (idx + 1) % this.max; return idx; }
    }
    const idx = this.cursor;
    this.cursor = (idx + 1) % this.max;
    return idx; // steal the oldest. Never grows the pool.
  }

  /**
   * Frozen API.
   * @param {number} x @param {number} y
   * @param {'hit'|'death'|'pickup'|'levelup'|'dust'|'debt'} kind
   * @param {{ count?: number, dirX?: number, dirY?: number, scale?: number }} [opts]
   */
  burst(x, y, kind, opts) {
    const spec = KIND_SPEC[kind] || KIND_SPEC.hit;
    const cols = KIND_COLORS[kind] || KIND_COLORS.hit;
    const scale = opts && opts.scale ? opts.scale : 1;
    let n = opts && opts.count ? opts.count : spec.n;
    if (n > 40) n = 40; // hard ceiling. Subtle is the brief.
    const dx = opts && opts.dirX ? opts.dirX : 0;
    const dy = opts && opts.dirY ? opts.dirY : 0;
    for (let k = 0; k < n; k++) {
      const i = this._alloc();
      const ang = this._r() * Math.PI * 2;
      const sp = spec.spd * (0.45 + this._r() * 0.75) * scale;
      this.x[i] = x + (this._r() - 0.5) * 3;
      this.y[i] = y + (this._r() - 0.5) * 3;
      this.vx[i] = Math.cos(ang) * sp + dx * 34;
      this.vy[i] = Math.sin(ang) * sp + dy * 34;
      const lf = spec.life * (0.7 + this._r() * 0.6);
      this.life[i] = lf;
      this.maxLife[i] = lf;
      this.size[i] = spec.size * (0.7 + this._r() * 0.7) * scale;
      this.grav[i] = spec.grav;
      this.drag[i] = spec.drag;
      this.color[i] = cols[(this._r() * cols.length) | 0];
      this.active[i] = 1;
    }
    if (kind === 'death') this.shake(2.2, 0.22);
    else if (kind === 'levelup') this.shake(1.2, 0.3);
  }

  /** Screen shake helper. Additive amplitude, exponential decay. */
  shake(amp, seconds = 0.25) {
    if (amp > this.shakeAmp) this.shakeAmp = amp;
    this.shakeDecay = Math.max(this.shakeDecay, seconds);
    this.shakeT = Math.max(this.shakeT, seconds);
  }

  /** @param {number} dt seconds */
  update(dt) {
    if (dt > 0.05) dt = 0.05; // a tab that was backgrounded must not teleport
    let live = 0;
    for (let i = 0; i < this.max; i++) {
      if (!this.active[i]) continue;
      const l = this.life[i] - dt;
      if (l <= 0) { this.active[i] = 0; continue; }
      this.life[i] = l;
      const d = 1 - this.drag[i] * dt;
      const dd = d < 0 ? 0 : d;
      this.vx[i] *= dd;
      this.vy[i] = this.vy[i] * dd + this.grav[i] * dt;
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
      live++;
    }
    this.live = live;

    if (this.shakeT > 0) {
      this.shakeT -= dt;
      if (this.shakeT <= 0) {
        this.shakeT = 0; this.shakeAmp = 0; this.shakeX = 0; this.shakeY = 0;
      } else {
        const f = this.shakeDecay > 0 ? this.shakeT / this.shakeDecay : 0;
        const a = this.shakeAmp * f * f;
        this.shakeX = (this._r() - 0.5) * 2 * a;
        this.shakeY = (this._r() - 0.5) * 2 * a;
      }
    }
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * Applies its own shake translate and restores it. Call inside your frame.
   */
  render(ctx) {
    if (!ctx) return;
    ctx.save();
    if (this.shakeX || this.shakeY) ctx.translate(this.shakeX, this.shakeY);
    for (let i = 0; i < this.max; i++) {
      if (!this.active[i]) continue;
      const t = this.life[i] / this.maxLife[i];
      ctx.globalAlpha = t < 0.25 ? t * 4 * 0.85 : 0.85;
      ctx.fillStyle = this.color[i];
      const s = this.size[i] * (0.4 + t * 0.6);
      ctx.beginPath();
      ctx.arc(this.x[i], this.y[i], s, 0, 6.283185307179586);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  /** For a caller that wants to shake the whole scene rather than the layer. */
  shakeOffset() { return this; } // .shakeX / .shakeY, no object allocated

  clear() {
    this.active.fill(0);
    this.live = 0;
    this.shakeAmp = 0; this.shakeT = 0; this.shakeX = 0; this.shakeY = 0;
  }
}

// SELF-TEST:
//   import { Particles } from './src/systems/particles.js';
//   const p = new Particles();
//   1. p.burst(180, 400, 'hit'); p.live is small (single digits) after one
//      update. p.burst(180,400,'levelup') blooms upward and pale.
//   2. Allocation check: call p.burst(...) a thousand times in a loop, then
//      profile p.update(0.016) — heap delta must be flat. All state lives in
//      the typed arrays built in the constructor.
//   3. Overflow: p.burst() far past the pool size recycles the oldest slots
//      and p.live never exceeds p.max. No exception, no resize.
//   4. p.burst(x,y,'death') also kicks screen shake; p.shakeX/p.shakeY decay to
//      exactly zero within the shake window and render() restores the ctx
//      transform either way.
//   5. p.update(5) is clamped and does not fling particles off-world.
//   6. Renders no text of any kind, so the no-numerals rule is trivially held.
