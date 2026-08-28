/**
 * requestAnimationFrame loop with a clamped delta.
 *
 * Backgrounding the app (a very normal thing on a phone) pauses rAF, so the
 * first frame back can carry a delta of many seconds. Clamping keeps any
 * time-based animation from snapping to its end state on resume.
 */
const MAX_DELTA = 1 / 20;

export class Loop {
  #frame = 0;
  #last = 0;
  #running = false;
  #tick: (dt: number, elapsed: number) => void;
  #elapsed = 0;

  constructor(tick: (dt: number, elapsed: number) => void) {
    this.#tick = tick;
    document.addEventListener('visibilitychange', this.#onVisibility);
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#last = performance.now();
    this.#frame = requestAnimationFrame(this.#step);
  }

  stop(): void {
    this.#running = false;
    cancelAnimationFrame(this.#frame);
  }

  dispose(): void {
    this.stop();
    document.removeEventListener('visibilitychange', this.#onVisibility);
  }

  #step = (now: number): void => {
    if (!this.#running) return;
    const dt = Math.min((now - this.#last) / 1000, MAX_DELTA);
    this.#last = now;
    this.#elapsed += dt;
    this.#tick(dt, this.#elapsed);
    this.#frame = requestAnimationFrame(this.#step);
  };

  // Stop burning battery while the app is not on screen.
  #onVisibility = (): void => {
    if (document.hidden) this.stop();
    else this.start();
  };
}
