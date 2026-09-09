// Entry point: canvas, loop, input, and the handful of mode transitions that
// belong to the shell rather than to the simulation.
import { createLoop } from './core/loop.js';
import { INTENT, createInput } from './core/input.js';
import { clamp } from './core/math.js';
import { createCamera } from './engine/camera.js';
import { MODE, createWorld } from './game/world.js';
import { drawBandIndicator, drawWorld } from './ui/render.js';
import { drawHud } from './ui/hud.js';
import { createTouchControls } from './ui/touch.js';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d', { alpha: false });

// Small screens see proportionally less of the room, so pull the world back a
// little on a phone — not all the way, or the entities stop being readable.
function viewScale() {
  const min = Math.min(window.innerWidth, window.innerHeight);
  return clamp(min / 700, 0.78, 1.15);
}

// The HUD is laid out in CSS pixels; below this it needs the compact layout
// rather than the same panels shrunk.
function isCompact() {
  return Math.min(window.innerWidth, window.innerHeight) < 560;
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx.imageSmoothingEnabled = false;
  camera.resize(canvas.width, canvas.height);
  camera.setPixelScale(dpr * viewScale());
  touch.setScale(isCompact() ? 1.06 : 1);
  touch.setSafeBottom(safeAreaBottom());
}

// Respect the home indicator / gesture bar so buttons are not sat on top of it.
function safeAreaBottom() {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;bottom:0;height:env(safe-area-inset-bottom,0px);width:0;';
  document.body.appendChild(probe);
  const h = probe.getBoundingClientRect().height || 0;
  probe.remove();
  return h;
}

const camera = createCamera(window.innerWidth, window.innerHeight);
const input = createInput(window);
let world = createWorld({ camera });
world.bindInput(input);

const touch = createTouchControls({ canvas, input, getWorld: () => world });

resize();
window.addEventListener('resize', resize);
// Rotating a phone fires resize before the new dimensions settle on some
// browsers, so re-run it once the layout has caught up.
window.addEventListener('orientationchange', () => setTimeout(resize, 120));

const dpr = () => Math.min(window.devicePixelRatio || 1, 3);

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
    // The camera already carries devicePixelRatio in pixelScale, so the world
    // draws at device resolution with no scaling games here.
    drawWorld(ctx, world, camera, 0);
    drawBandIndicator(ctx, world, camera);

    ctx.save();
    ctx.scale(dpr(), dpr());
    drawHudScaled();
    ctx.restore();
  },
});

function drawHudScaled() {
  // The HUD is drawn in CSS pixels, so text stays the same physical size on
  // every display.
  world.ui = {
    touch: touch.active,
    compact: isCompact(),
    safeBottom: touch.state.safeBottom,
  };
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
  touch.draw(proxy, world, window.innerWidth, window.innerHeight);
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
window.__game = { get world() { return world; }, loop, camera, input, touch };
