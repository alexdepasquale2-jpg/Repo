// T0-N02 · Input layer. Gameplay code never reads a raw key — it reads intents.
// Exit gate: rebinding touches this file only.

export const INTENT = {
  MOVE_UP: 'moveUp',
  MOVE_DOWN: 'moveDown',
  MOVE_LEFT: 'moveLeft',
  MOVE_RIGHT: 'moveRight',
  TARGET_NEXT: 'targetNext',
  TARGET_PREV: 'targetPrev',
  INTERACT: 'interact',
  STEP: 'step',
  ABILITY_1: 'ability1',
  ABILITY_2: 'ability2',
  ABILITY_3: 'ability3',
  ABILITY_4: 'ability4',
  PING: 'ping',
  CONFIRM: 'confirm',
  CANCEL: 'cancel',
  DEBUG: 'debug',
  PAUSE: 'pause',
};

export const DEFAULT_BINDINGS = {
  KeyW: INTENT.MOVE_UP,
  ArrowUp: INTENT.MOVE_UP,
  KeyS: INTENT.MOVE_DOWN,
  ArrowDown: INTENT.MOVE_DOWN,
  KeyA: INTENT.MOVE_LEFT,
  ArrowLeft: INTENT.MOVE_LEFT,
  KeyD: INTENT.MOVE_RIGHT,
  ArrowRight: INTENT.MOVE_RIGHT,
  Tab: INTENT.TARGET_NEXT,
  KeyQ: INTENT.TARGET_PREV,
  KeyE: INTENT.INTERACT,
  Space: INTENT.STEP,
  Digit1: INTENT.ABILITY_1,
  Digit2: INTENT.ABILITY_2,
  Digit3: INTENT.ABILITY_3,
  Digit4: INTENT.ABILITY_4,
  KeyF: INTENT.PING,
  Enter: INTENT.CONFIRM,
  Escape: INTENT.CANCEL,
  Backquote: INTENT.DEBUG,
  KeyP: INTENT.PAUSE,
};

export function createInput(target = window) {
  let bindings = { ...DEFAULT_BINDINGS };
  const held = new Set();
  const pressedThisTick = new Set();
  const releasedThisTick = new Set();
  let enabled = true;
  // A touch stick reports a direction and a magnitude, which a key cannot. It
  // feeds the same intent layer rather than a parallel path, so gameplay code
  // still never learns where a movement came from (T0-N02).
  const analog = { x: 0, y: 0 };

  const press = (intent) => {
    if (!held.has(intent)) pressedThisTick.add(intent);
    held.add(intent);
  };
  const release = (intent) => {
    if (held.delete(intent)) releasedThisTick.add(intent);
  };

  const onKeyDown = (e) => {
    const intent = bindings[e.code];
    if (!intent) return;
    // Tab must not move focus out of the canvas mid-fight.
    if (e.code === 'Tab' || e.code === 'Space') e.preventDefault();
    if (e.repeat) return;
    if (!enabled) return;
    press(intent);
  };
  const onKeyUp = (e) => {
    const intent = bindings[e.code];
    if (!intent) return;
    release(intent);
  };
  // Losing focus mid-key would otherwise leave the player walking into a wall forever.
  const onBlur = () => {
    for (const intent of [...held]) release(intent);
  };

  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);
  target.addEventListener('blur', onBlur);

  const api = {
    isHeld: (intent) => enabled && held.has(intent),
    wasPressed: (intent) => enabled && pressedThisTick.has(intent),
    wasReleased: (intent) => releasedThisTick.has(intent),

    // Normalized move vector. Diagonals do not outrun cardinals.
    // A live stick wins over the keys — you cannot be holding both, and reading
    // the stick first keeps its magnitude (a half-push is a half-speed walk).
    moveAxis() {
      const mag = Math.hypot(analog.x, analog.y);
      if (mag > 0.08) {
        return mag > 1 ? { x: analog.x / mag, y: analog.y / mag } : { x: analog.x, y: analog.y };
      }
      let x = 0, y = 0;
      if (api.isHeld(INTENT.MOVE_LEFT)) x -= 1;
      if (api.isHeld(INTENT.MOVE_RIGHT)) x += 1;
      if (api.isHeld(INTENT.MOVE_UP)) y -= 1;
      if (api.isHeld(INTENT.MOVE_DOWN)) y += 1;
      const l = Math.hypot(x, y);
      return l > 1 ? { x: x / l, y: y / l } : { x, y };
    },

    // Called once at the end of every fixed tick, not every render frame,
    // so an edge is never consumed twice or missed by a slow frame.
    endTick() {
      pressedThisTick.clear();
      releasedThisTick.clear();
    },

    // Driven by the on-screen stick. Magnitude is preserved up to 1.
    setAnalog(x, y) { analog.x = x; analog.y = y; },
    clearAnalog() { analog.x = 0; analog.y = 0; },

    // Driven by on-screen buttons. Same edge semantics as a key, so wasPressed
    // and isHeld behave identically whichever the player is using.
    pressIntent(intent) { if (enabled) press(intent); },
    releaseIntent(intent) { release(intent); },
    releaseAllIntents() { for (const i of [...held]) release(i); },

    setEnabled(v) {
      enabled = v;
      if (!v) onBlur();
    },

    rebind(code, intent) { bindings[code] = intent; },
    resetBindings() { bindings = { ...DEFAULT_BINDINGS }; },
    keyFor(intent) {
      const code = Object.keys(bindings).find((k) => bindings[k] === intent);
      return code ? code.replace(/^(Key|Digit)/, '') : '?';
    },

    destroy() {
      target.removeEventListener('keydown', onKeyDown);
      target.removeEventListener('keyup', onKeyUp);
      target.removeEventListener('blur', onBlur);
    },
  };
  return api;
}
