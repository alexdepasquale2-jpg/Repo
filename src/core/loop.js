// T0-N01 · Fixed-timestep game loop.
// Logic runs at a fixed 60Hz; render is decoupled and interpolates with the
// leftover accumulator so behavior is identical at 30fps and 144fps.
export const TICK_HZ = 60;
export const TICK_DT = 1 / TICK_HZ;

const MAX_FRAME = 0.25;   // never simulate more than 250ms of catch-up in one frame
const MAX_STEPS = 5;      // spiral-of-death guard

export function createLoop({ update, render }) {
  let accumulator = 0;
  let last = 0;
  let raf = 0;
  let running = false;

  const state = {
    fps: 0,
    tickMs: 0,
    renderMs: 0,
    timescale: 1,        // debug slider (T0-N06) — inspect combat at 0.25x
    ticks: 0,
    paused: false,
  };

  let fpsAccum = 0, fpsFrames = 0;

  function frame(now) {
    if (!running) return;
    raf = requestAnimationFrame(frame);

    const nowSec = now / 1000;
    let frameTime = Math.min(nowSec - last, MAX_FRAME);
    if (!Number.isFinite(frameTime) || frameTime < 0) frameTime = 0;
    last = nowSec;

    fpsAccum += frameTime;
    fpsFrames++;
    if (fpsAccum >= 0.5) {
      state.fps = Math.round(fpsFrames / fpsAccum);
      fpsAccum = 0;
      fpsFrames = 0;
    }

    if (!state.paused) accumulator += frameTime * state.timescale;

    let steps = 0;
    const t0 = performance.now();
    while (accumulator >= TICK_DT && steps < MAX_STEPS) {
      update(TICK_DT);
      accumulator -= TICK_DT;
      steps++;
      state.ticks++;
    }
    // Dropped time rather than spiralling; keeps the sim honest under load.
    if (steps === MAX_STEPS) accumulator = 0;
    state.tickMs = performance.now() - t0;

    const t1 = performance.now();
    render(accumulator / TICK_DT, frameTime);
    state.renderMs = performance.now() - t1;
  }

  return {
    state,
    start() {
      if (running) return;
      running = true;
      last = performance.now() / 1000;
      accumulator = 0;
      raf = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      cancelAnimationFrame(raf);
    },
    // Single-step while paused, for inspecting a swing frame by frame.
    step() {
      update(TICK_DT);
      state.ticks++;
    },
  };
}
