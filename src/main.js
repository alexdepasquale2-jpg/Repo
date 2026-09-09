// Entry point: canvas, loop, input, and the handful of mode transitions that
// belong to the shell rather than to the simulation.
import { createLoop } from './core/loop.js';
import { INTENT, createInput } from './core/input.js';
import { createCamera } from './engine/camera.js';
import { MODE, createWorld } from './game/world.js';
import { drawBandIndicator, drawWorld } from './ui/render.js';
import { drawHud } from './ui/hud.js';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d', { alpha: false });

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx.imageSmoothingEnabled = false;
  camera.resize(canvas.width, canvas.height);
  camera.zoom = camera.targetZoom * dpr;
}

const camera = createCamera(window.innerWidth, window.innerHeight);
const input = createInput(window);
let world = createWorld({ camera });
world.bindInput(input);
resize();
window.addEventListener('resize', resize);

const dpr = () => Math.min(window.devicePixelRatio || 1, 2);

function newRun() {
  world = createWorld({ camera, seed: Date.now() });
  world.bindInput(input);
  world.start();
}

const loop = createLoop({
  update(dt) {
    // Shell-level transitions. Everything else lives in world.update.
    if (input.wasPressed(INTENT.DEBUG)) world.debug = !world.debug;
    if (input.wasPressed(INTENT.PAUSE)) loop.state.paused = !loop.state.paused;

    if (world.mode === MODE.TITLE) {
      if (input.wasPressed(INTENT.CONFIRM)) newRun();
      input.endTick();
      return;
    }
    if (world.mode === MODE.SAFEROOM && input.wasPressed(INTENT.CONFIRM)) {
      world.advanceLevel();
      input.endTick();
      return;
    }
    if (world.mode === MODE.RESULT && input.wasPressed(INTENT.CONFIRM)) {
      newRun();
      input.endTick();
      return;
    }

    world.update(dt);
  },

  render() {
    // Zoom folds in devicePixelRatio here rather than in the sim, so the camera
    // stays in world units everywhere else.
    const base = camera.targetZoom;
    camera.targetZoom = base * dpr();
    drawWorld(ctx, world, camera, 0);
    drawBandIndicator(ctx, world, camera);
    camera.targetZoom = base;

    ctx.save();
    ctx.scale(dpr(), dpr());
    ctx.canvas.width === 0 || drawHudScaled();
    ctx.restore();
  },
});

function drawHudScaled() {
  // The HUD is drawn in CSS pixels, so text stays the same physical size on
  // every display.
  const fake = {
    canvas: { width: window.innerWidth, height: window.innerHeight },
  };
  const proxy = new Proxy(ctx, {
    get(target, prop) {
      if (prop === 'canvas') return fake.canvas;
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
  drawHud(proxy, world, input, loop.state);
}

// Debug: timescale slider, so combat can be inspected at 0.25x (T0-N06).
window.addEventListener('keydown', (e) => {
  if (!world.debug) return;
  if (e.code === 'BracketLeft') loop.state.timescale = Math.max(0.1, loop.state.timescale - 0.15);
  if (e.code === 'BracketRight') loop.state.timescale = Math.min(2, loop.state.timescale + 0.15);
  if (e.code === 'Backslash') loop.state.timescale = 1;
});

loop.start();

// Expose for console poking during tuning sessions. Not used by the game.
window.__game = { get world() { return world; }, loop, camera, input };
