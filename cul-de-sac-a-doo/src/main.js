// Cul-de-Sac-a-Doo: Survival Night — entry point. Owner: Agent A.
// Owns: canvas + render context, the fixed-step game loop, and the scene
// manager that switches between the day hub and the night run.

import { GameState, CONFIG, PALETTE } from './game/game.js';
import { InputManager } from './systems/input.js';

// ---------------------------------------------------------------------------
// 1.1 Canvas & rendering pipeline
// ---------------------------------------------------------------------------

/**
 * Creates a devicePixelRatio-aware canvas locked to the canonical logical
 * viewport (375x812) and letterboxed to fit the window while preserving aspect.
 * All draw calls use logical units; the transform handles DPR and scale.
 */
export class Renderer {
  constructor(container) {
    this.width = CONFIG.view.width;
    this.height = CONFIG.view.height;

    this.canvas = document.createElement('canvas');
    this.canvas.id = 'game-canvas';
    this.canvas.style.display = 'block';
    this.canvas.style.position = 'absolute';
    this.canvas.style.imageRendering = 'pixelated';
    this.canvas.style.touchAction = 'none';
    container.appendChild(this.canvas);

    this.ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.dpr = 1;
    this.scale = 1;
    this.offsetLeft = 0;
    this.offsetTop = 0;

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    window.addEventListener('orientationchange', this._onResize);
    this.resize();
  }

  resize() {
    const vw = window.innerWidth || this.width;
    const vh = window.innerHeight || this.height;
    // Letterbox: the largest integer-friendly scale that fits both axes.
    this.scale = Math.min(vw / this.width, vh / this.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, CONFIG.view.maxDpr);

    const cssW = this.width * this.scale;
    const cssH = this.height * this.scale;
    this.offsetLeft = Math.round((vw - cssW) / 2);
    this.offsetTop = Math.round((vh - cssH) / 2);

    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.style.left = `${this.offsetLeft}px`;
    this.canvas.style.top = `${this.offsetTop}px`;

    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);

    // One transform for everything: logical px -> device px.
    const k = this.scale * this.dpr;
    this.ctx.setTransform(k, 0, 0, k, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
  }

  /** Map a DOM client point into logical game coordinates. */
  toLogical(clientX, clientY) {
    return {
      x: (clientX - this.offsetLeft) / this.scale,
      y: (clientY - this.offsetTop) / this.scale,
    };
  }

  clear() {
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.fillStyle = PALETTE.outOfBounds;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// 1.3 Scene manager
// ---------------------------------------------------------------------------

/**
 * Owns phase transitions and the render order:
 *   background -> entities -> particles -> UI overlay
 * The per-layer drawing lives in GameState.render; the manager decides which
 * scene is live and notifies the (optional) UIManager on each switch.
 */
export class SceneManager {
  constructor(state) {
    this.state = state;
    this.current = 'day';
    this.transition = 0;      // 0..1 fade, purely cosmetic
  }

  go(scene) {
    if (scene === this.current) return;
    this.current = scene;
    this.transition = 1;
    if (scene === 'night') this.state.startNight();
    else if (this.state.phase === 'night') this.state.endNight();
    else this.state.phase = 'day';
    if (scene === 'day') this.state.ui.renderDay(this.state);
    else this.state.ui.renderNight(this.state);
  }

  /** Keep the manager in sync when GameState ends a night on its own. */
  sync() {
    if (this.state.phase !== this.current) {
      this.current = this.state.phase;
      if (this.current === 'day') this.state.ui.renderDay(this.state);
    }
  }

  update(dt) {
    if (this.transition > 0) this.transition = Math.max(0, this.transition - dt * 1.6);
    this.sync();
  }

  render(renderer, alpha) {
    const ctx = renderer.ctx;
    renderer.clear();
    this.state.render(ctx, alpha);
    if (this.transition > 0) {
      ctx.globalAlpha = this.transition;
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, CONFIG.view.width, CONFIG.view.height);
      ctx.globalAlpha = 1;
    }
  }
}

// ---------------------------------------------------------------------------
// 1.2 Game loop — accumulator, fixed 60Hz update, interpolated render
// ---------------------------------------------------------------------------

export class Game {
  constructor(container) {
    this.container = container;
    this.renderer = new Renderer(container);
    this.input = new InputManager();
    this.state = new GameState(CONFIG.run.seed);
    this.scenes = new SceneManager(this.state);

    this.fixedDt = 1 / CONFIG.loop.fixedHz;
    this.accumulator = 0;
    this.lastTime = 0;
    this.running = false;
    this.frameCount = 0;
    this.fps = 0;
    this._fpsWindow = 0;
    this._fpsFrames = 0;

    this._pointer = { active: false, x: 0, y: 0, startX: 0, startY: 0 };
    this._bindPointer();
    this._bindVisibility();

    this._tick = this._tick.bind(this);
  }

  /** Expose the same attach() surface at the top level for the orchestrator. */
  attach(collaborators) {
    this.state.attach(collaborators);
    return this;
  }

  _bindPointer() {
    const c = this.renderer.canvas;
    const down = (e) => {
      const t = e.touches ? e.touches[0] : e;
      const p = this.renderer.toLogical(t.clientX, t.clientY);
      this._pointer.active = true;
      this._pointer.startX = p.x; this._pointer.startY = p.y;
      this._pointer.x = p.x; this._pointer.y = p.y;
      e.preventDefault();
    };
    const move = (e) => {
      if (!this._pointer.active) return;
      const t = e.touches ? e.touches[0] : e;
      const p = this.renderer.toLogical(t.clientX, t.clientY);
      this._pointer.x = p.x; this._pointer.y = p.y;
      e.preventDefault();
    };
    const up = (e) => { this._pointer.active = false; if (e.cancelable) e.preventDefault(); };

    c.addEventListener('pointerdown', down);
    c.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  _bindVisibility() {
    document.addEventListener('visibilitychange', () => {
      // Drop accumulated time so a restored tab does not fast-forward.
      if (!document.hidden) { this.lastTime = performance.now(); this.accumulator = 0; }
    });
  }

  /** Combine keyboard + virtual-joystick drag into one move intent vector. */
  _readIntent() {
    const i = this.input;
    let x = 0, y = 0;
    if (i.isPressed('a') || i.isPressed('arrowleft')) x -= 1;
    if (i.isPressed('d') || i.isPressed('arrowright')) x += 1;
    if (i.isPressed('w') || i.isPressed('arrowup')) y -= 1;
    if (i.isPressed('s') || i.isPressed('arrowdown')) y += 1;

    if (this._pointer.active) {
      const dx = this._pointer.x - this._pointer.startX;
      const dy = this._pointer.y - this._pointer.startY;
      const l = Math.hypot(dx, dy);
      const dead = 6, max = 46;
      if (l > dead) {
        const m = Math.min(1, (l - dead) / (max - dead));
        x += (dx / l) * m;
        y += (dy / l) * m;
      }
    }
    const intent = this.state.moveIntent;
    intent.x = x;
    intent.y = y;
    return intent;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.scenes.go('night');       // straight into a run for now; C/D own the hub
    requestAnimationFrame(this._tick);
  }

  stop() { this.running = false; }

  _tick(now) {
    if (!this.running) return;
    requestAnimationFrame(this._tick);

    let frameSeconds = (now - this.lastTime) / 1000;
    this.lastTime = now;
    if (!(frameSeconds >= 0)) frameSeconds = 0;
    // Clamp: a backgrounded tab must not queue minutes of simulation.
    if (frameSeconds > CONFIG.loop.maxFrameSeconds) frameSeconds = CONFIG.loop.maxFrameSeconds;

    this._fpsWindow += frameSeconds;
    this._fpsFrames++;
    if (this._fpsWindow >= 0.5) {
      this.fps = this._fpsFrames / this._fpsWindow;
      this._fpsWindow = 0; this._fpsFrames = 0;
    }

    this.accumulator += frameSeconds;
    this._readIntent();

    let steps = 0;
    while (this.accumulator >= this.fixedDt && steps < CONFIG.loop.maxStepsPerFrame) {
      this.state.update(this.fixedDt);
      this.scenes.update(this.fixedDt);
      this.accumulator -= this.fixedDt;
      steps++;
      this.frameCount++;
    }
    if (steps === CONFIG.loop.maxStepsPerFrame) this.accumulator = 0;  // give up on the debt

    const alpha = this.accumulator / this.fixedDt;
    this.scenes.render(this.renderer, alpha);
  }

  destroy() {
    this.stop();
    window.removeEventListener('resize', this.renderer._onResize);
    this.renderer.canvas.remove();
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function boot() {
  let container = document.getElementById('game-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'game-container';
    document.body.appendChild(container);
  }
  const game = new Game(container);
  window.game = game;
  // Convenience aliases the other agents' consoles and the orchestrator use.
  window.gameState = game.state;
  game.start();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

// SELF-TEST: serve the folder and open index.html.
//  1. Console clean; a portrait canvas is centred and letterboxed. Resize the
//     window: the canvas keeps its 375:812 aspect and stays centred, and art
//     stays crisp on a HiDPI display (window.game.renderer.dpr > 1).
//  2. window.game.fps hovers near 60 with 300 enemies alive.
//  3. Switch to another tab for 30s and come back: the game does NOT fast-
//     forward (accumulator is cleared) and no frame drops below the clamp.
//  4. window.game.scenes.go('day') shows the quiet-street placeholder;
//     .go('night') restarts a run.
//  5. Keyboard WASD/arrows and a touch/mouse drag on the canvas both move the
//     player; releasing either returns the intent vector to (0, 0).
