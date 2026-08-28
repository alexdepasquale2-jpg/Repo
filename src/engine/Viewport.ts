/**
 * Keeps a canvas backing store matched to its CSS size.
 *
 * Device pixel ratio is capped: phones routinely report 3–4, and rendering a
 * full-rate loop at 4x costs far more than it shows on a ~400px-wide canvas.
 */
const MAX_DPR = 2;

export class Viewport {
  readonly ctx: CanvasRenderingContext2D;

  /** CSS-pixel dimensions — draw in these; the transform handles the rest. */
  width = 0;
  height = 0;
  dpr = 1;

  #canvas: HTMLCanvasElement;
  #observer: ResizeObserver;

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D canvas context unavailable');

    this.#canvas = canvas;
    this.ctx = ctx;

    this.#observer = new ResizeObserver(() => this.resize());
    this.#observer.observe(canvas);
    this.resize();
  }

  resize(): void {
    const rect = this.#canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);

    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (w === this.width && h === this.height && dpr === this.dpr) return;

    this.width = w;
    this.height = h;
    this.dpr = dpr;
    this.#canvas.width = Math.round(w * dpr);
    this.#canvas.height = Math.round(h * dpr);

    // Draw calls stay in CSS pixels regardless of the backing-store scale.
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  dispose(): void {
    this.#observer.disconnect();
  }
}
