// Touch controls. The whole point of the intent layer (T0-N02) is that gameplay
// code never learns where an input came from — so this module drives the exact
// same intents the keyboard does, and nothing downstream knows the difference.
//
// The controls are contextual because the game puts you in three different
// roles: walking the grounds, seated at the throne, and standing in a menu
// deciding whether someone lives. Each gets the buttons it actually needs.
import { clamp } from '../core/math.js';
import { INTENT } from '../core/input.js';
import { MODE } from '../game/world.js';
import { BOSS_ABILITIES } from '../game/boss.js';

const STICK_RADIUS = 46;     // travel from origin to full push — a thumb arc, not an arm's
const STICK_DEAD = 0.14;

// What the growth button is currently set to spend on.
const GROW_LABEL = { spore: 'Spore', lash: 'Lash', pulse: 'Pulse' };

export function createTouchControls({ canvas, input, getWorld }) {
  const state = {
    active: matchMedia?.('(pointer: coarse)').matches ?? false,
    stick: { id: null, ox: 0, oy: 0, x: 0, y: 0 },
    buttons: [],
    pointers: new Map(),   // pointerId -> button id
    safeBottom: 0,
    scale: 1,
  };

  // ── layout ────────────────────────────────────────────────────────────────
  function btn(id, intent, label, opts = {}) {
    return { id, intent, label, sub: opts.sub ?? '', kind: opts.kind ?? 'round',
             cooldown: opts.cooldown ?? 0, disabled: opts.disabled ?? false,
             primary: opts.primary ?? false, x: 0, y: 0, r: 0, w: 0, h: 0 };
  }

  // Pack right-to-left, wrapping upward. Works in landscape and portrait
  // without two separate layouts to keep in sync.
  function packRows(list, W, H, s) {
    const r = 27 * s;
    const gap = 11 * s;
    const maxRow = Math.min(W * 0.66, 400 * s);
    const right = W - (18 * s) - r;
    const bottom = H - (20 * s) - r - state.safeBottom;

    let row = 0, used = 0, x = right;
    for (const b of list) {
      const rr = b.primary ? r * 1.22 : r;
      const need = rr * 2 + gap;
      if (used + need > maxRow && used > 0) { row++; used = 0; x = right; }
      b.r = rr;
      b.x = x - (rr - r);
      b.y = bottom - row * (r * 2 + gap);
      x -= need;
      used += need;
    }
    return list;
  }

  // Menu choices are the opposite shape: few, wide, unmissable, centred.
  function packMenu(list, W, H, s) {
    const h = 46 * s;
    const gap = 10 * s;
    const total = Math.min(W - 40 * s, 460 * s);
    const w = (total - gap * (list.length - 1)) / list.length;
    let x = (W - total) / 2;
    for (const b of list) {
      b.kind = 'pill';
      b.w = w; b.h = h;
      b.x = x; b.y = H - h - 22 * s - state.safeBottom;
      x += w + gap;
    }
    return list;
  }

  function layout(world, W, H) {
    const s = state.scale;
    const p = world.player;
    const mode = world.mode;

    if (mode === MODE.TITLE) return packMenu([btn('begin', INTENT.CONFIRM, 'Begin')], W, H, s);
    if (mode === MODE.RESULT) return packMenu([btn('again', INTENT.CONFIRM, 'Again')], W, H, s);
    if (mode === MODE.SAFEROOM) return packMenu([btn('on', INTENT.CONFIRM, 'Go on')], W, H, s);

    if (mode === MODE.MERCY) {
      if (!world.mercy?.playerDecides) return [];
      return packMenu([
        btn('spare', INTENT.CONFIRM, 'Spare them'),
        btn('kill', INTENT.CANCEL, 'Finish it'),
      ], W, H, s);
    }

    if (mode === MODE.ALLOCATION) {
      if (world.allocation?.allocator !== p) return [];
      return packMenu([
        btn('who', INTENT.TARGET_NEXT, 'Next'),
        btn('ten', INTENT.ABILITY_1, '+10%'),
        btn('quarter', INTENT.ABILITY_2, '+25%'),
        btn('back', INTENT.ABILITY_3, 'Take'),
        btn('done', INTENT.CONFIRM, 'Done'),
      ], W, H, s);
    }

    if (mode === MODE.TRANSFORMATION) return [];

    // Seated: no movement, so no stick — the whole hand goes to the network.
    const boss = world.boss;
    if (boss?.isPlayerControlled && mode === MODE.FIGHT) {
      const cd = (id) => clamp(boss.cooldowns[id] / BOSS_ABILITIES[id].cooldown, 0, 1);
      const broke = (id) => boss.biomass < boss.costOf(id);
      return packRows([
        btn('gaze', INTENT.TARGET_NEXT, 'Gaze', { primary: true }),
        btn('line', INTENT.ABILITY_1, 'Lash', { sub: String(boss.costOf('line')), cooldown: cd('line'), disabled: broke('line') }),
        btn('bloom', INTENT.ABILITY_2, 'Bloom', { sub: String(boss.costOf('bloom')), cooldown: cd('bloom'), disabled: broke('bloom') }),
        btn('tether', INTENT.ABILITY_3, 'Teth', { sub: String(boss.costOf('tether')), cooldown: cd('tether'), disabled: broke('tether') }),
        btn('grow', INTENT.ABILITY_4, 'Grow', { cooldown: clamp(boss.cooldowns.grow / 2, 0, 1) }),
        btn('feint', INTENT.STEP, boss.casting ? 'Pull' : 'Burst'),
        btn('husk', INTENT.INTERACT, 'Husk', { cooldown: clamp(boss.cooldowns.husk / 10, 0, 1) }),
        btn('mark', INTENT.PING, 'Mark'),
        btn('seed', INTENT.CANCEL, GROW_LABEL[boss.growType] ?? 'Seed'),
      ], W, H, s);
    }

    if (!p || p.spectating) return [];

    // On foot. Target is the primary because it is pressed more than anything
    // else in the game.
    const list = [btn('target', INTENT.TARGET_NEXT, 'Target', { primary: true })];
    list.push(btn('step', INTENT.STEP, 'Step', { cooldown: clamp(p.stepCooldown / 2.6, 0, 1) }));
    list.push(btn('use', INTENT.INTERACT, mode === MODE.THRONE_STANDOFF ? 'Sit' : 'Use'));
    (p.abilities ?? []).slice(0, 4).forEach((slot, i) => {
      list.push(btn('a' + i, [INTENT.ABILITY_1, INTENT.ABILITY_2, INTENT.ABILITY_3, INTENT.ABILITY_4][i],
        slot.def.name.split(' ')[0].slice(0, 5),
        { cooldown: clamp(slot.cooldown / slot.def.cooldown, 0, 1) }));
    });
    return packRows(list, W, H, s);
  }

  function hit(b, x, y) {
    if (b.kind === 'pill') {
      const pad = 6 * state.scale;   // a little forgiveness on every edge
      return x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad;
    }
    const grow = 8 * state.scale;
    return Math.hypot(x - b.x, y - b.y) <= b.r + grow;
  }

  // ── pointer handling ──────────────────────────────────────────────────────
  function toCss(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function onDown(e) {
    const world = getWorld();
    if (!world) return;
    if (e.pointerType === 'touch') state.active = true;
    if (!state.active) return;

    const { x, y } = toCss(e);
    // Relayout before testing: a button that moved this frame should still be
    // where the player just saw it.
    state.buttons = layout(world, window.innerWidth, window.innerHeight);

    for (const b of state.buttons) {
      if (b.disabled || !hit(b, x, y)) continue;
      state.pointers.set(e.pointerId, b.id);
      input.pressIntent(b.intent);
      capture(e.pointerId);
      e.preventDefault();
      return;
    }

    // Anywhere on the left, clear of the buttons, is the stick. It appears
    // under your thumb rather than living in a fixed corner you have to find.
    const stickZone = x < window.innerWidth * 0.55;
    const canMove = world.mode !== MODE.TITLE && world.mode !== MODE.RESULT
      && !(world.boss?.isPlayerControlled && world.mode === MODE.FIGHT);
    if (stickZone && canMove && state.stick.id === null) {
      state.stick.id = e.pointerId;
      state.stick.ox = state.stick.x = x;
      state.stick.oy = state.stick.y = y;
      capture(e.pointerId);
      e.preventDefault();
    }
  }

  // Capture keeps a thumb that slides off a button still owned by the canvas.
  // It throws if the pointer has already gone, which is not worth a crash.
  function capture(id) {
    try { canvas.setPointerCapture?.(id); } catch { /* pointer already released */ }
  }

  function onMove(e) {
    if (state.stick.id !== e.pointerId) return;
    const { x, y } = toCss(e);
    state.stick.x = x;
    state.stick.y = y;
    const dx = (x - state.stick.ox) / (STICK_RADIUS * state.scale);
    const dy = (y - state.stick.oy) / (STICK_RADIUS * state.scale);
    const mag = Math.hypot(dx, dy);
    if (mag < STICK_DEAD) { input.setAnalog(0, 0); return; }
    const k = mag > 1 ? 1 / mag : 1;
    input.setAnalog(dx * k, dy * k);
    e.preventDefault();
  }

  function onUp(e) {
    if (state.stick.id === e.pointerId) {
      state.stick.id = null;
      input.clearAnalog();
    }
    const id = state.pointers.get(e.pointerId);
    if (id !== undefined) {
      const b = state.buttons.find((x) => x.id === id);
      if (b) input.releaseIntent(b.intent);
      state.pointers.delete(e.pointerId);
    }
  }

  canvas.addEventListener('pointerdown', onDown, { passive: false });
  canvas.addEventListener('pointermove', onMove, { passive: false });
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  // A pointer lost to a system gesture must not leave an intent stuck down.
  window.addEventListener('blur', () => {
    state.stick.id = null;
    input.clearAnalog();
    for (const [, id] of state.pointers) {
      const b = state.buttons.find((x) => x.id === id);
      if (b) input.releaseIntent(b.intent);
    }
    state.pointers.clear();
  });

  // ── drawing ───────────────────────────────────────────────────────────────
  const MONO = '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

  function draw(ctx, world, W, H) {
    if (!state.active || !world) return;
    state.buttons = layout(world, W, H);

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const b of state.buttons) {
      const down = [...state.pointers.values()].includes(b.id);
      drawButton(ctx, b, down);
    }

    if (state.stick.id !== null) drawStick(ctx);
    ctx.restore();
  }

  function drawButton(ctx, b, down) {
    const s = state.scale;
    const alpha = b.disabled ? 0.32 : down ? 1 : 0.82;
    ctx.globalAlpha = alpha;

    ctx.fillStyle = down ? 'rgba(201,162,74,0.28)' : 'rgba(11,10,7,0.74)';
    ctx.strokeStyle = b.primary ? 'rgba(201,162,74,0.85)' : 'rgba(232,226,208,0.4)';
    ctx.lineWidth = 1.5 * s;

    if (b.kind === 'pill') {
      roundRect(ctx, b.x, b.y, b.w, b.h, 4 * s);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#e8e2d0';
      ctx.font = `600 ${13 * s}px ${MONO}`;
      ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2);
    } else {
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();

      // Cooldown is a sweep from the top, matching the HUD's own vocabulary.
      if (b.cooldown > 0) {
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.beginPath();
        ctx.moveTo(b.x, b.y);
        ctx.arc(b.x, b.y, b.r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * b.cooldown);
        ctx.closePath();
        ctx.fill();
      }

      ctx.fillStyle = '#e8e2d0';
      ctx.font = `600 ${(b.primary ? 12 : 10.5) * s}px ${MONO}`;
      ctx.fillText(b.label, b.x, b.y - (b.sub ? 5 * s : 0));
      if (b.sub) {
        ctx.fillStyle = b.disabled ? '#c25b4e' : '#c9a24a';
        ctx.font = `${9 * s}px ${MONO}`;
        ctx.fillText(b.sub, b.x, b.y + 9 * s);
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawStick(ctx) {
    const s = state.scale;
    const { ox, oy, x, y } = state.stick;
    const r = STICK_RADIUS * s;
    const dx = x - ox, dy = y - oy;
    const mag = Math.hypot(dx, dy);
    const k = mag > r ? r / mag : 1;

    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = 'rgba(232,226,208,0.55)';
    ctx.lineWidth = 1.5 * s;
    ctx.beginPath(); ctx.arc(ox, oy, r, 0, Math.PI * 2); ctx.stroke();

    ctx.globalAlpha = 0.85;
    ctx.fillStyle = 'rgba(201,162,74,0.32)';
    ctx.strokeStyle = 'rgba(201,162,74,0.9)';
    ctx.beginPath();
    ctx.arc(ox + dx * k, oy + dy * k, 19 * s, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  return {
    state,
    draw,
    get active() { return state.active; },
    setScale(v) { state.scale = v; },
    setSafeBottom(v) { state.safeBottom = v; },
  };
}
