// T1-N06 · Status effect system. Timed modifiers with stacking rules fixed now,
// because the fungal network is entirely status effects.
export const STACK = {
  REFRESH: 'refresh',    // reapplying resets duration, one instance only
  STACK: 'stack',        // independent instances, magnitudes sum
  STRONGEST: 'strongest',// keep whichever instance is worse for the victim
};

export const STATUS_DEFS = {
  slow:        { stack: STACK.STRONGEST, color: '#6ec1e4', label: 'Slowed' },
  rot:         { stack: STACK.STACK,     color: '#8fbf5a', label: 'Rot', dps: true },
  stun:        { stack: STACK.REFRESH,   color: '#f2c14e', label: 'Stunned' },
  vulnerable:  { stack: STACK.STRONGEST, color: '#e2685f', label: 'Vulnerable' },
  taint:       { stack: STACK.REFRESH,   color: '#a074c9', label: 'Spore taint' },  // T2-N27
  tether:      { stack: STACK.REFRESH,   color: '#c96a9c', label: 'Tethered' },     // T2-N10
  immune:      { stack: STACK.REFRESH,   color: '#f4f1e8', label: 'Warded' },       // spore filter
  burning:     { stack: STACK.REFRESH,   color: '#ee8b3d', label: 'Cauterized' },
  hastened:    { stack: STACK.STRONGEST, color: '#f7e08a', label: 'Loose' },        // overclock
};

export function applyStatus(entity, type, { duration = 3, magnitude = 1, source = null } = {}) {
  const def = STATUS_DEFS[type];
  if (!def) throw new Error(`unknown status: ${type}`);
  // Warded blocks everything harmful; it is the answer to the idle AOE (T2-N11).
  if (type !== 'immune' && hasStatus(entity, 'immune') && type !== 'hastened') return null;

  const existing = entity.statuses.filter((s) => s.type === type);
  if (def.stack === STACK.REFRESH && existing.length) {
    const s = existing[0];
    s.duration = Math.max(s.duration, duration);
    s.magnitude = Math.max(s.magnitude, magnitude);
    return s;
  }
  if (def.stack === STACK.STRONGEST && existing.length) {
    const s = existing[0];
    if (magnitude >= s.magnitude) { s.magnitude = magnitude; s.duration = Math.max(s.duration, duration); }
    return s;
  }
  const s = { type, duration, maxDuration: duration, magnitude, source, tickAccum: 0 };
  entity.statuses.push(s);
  return s;
}

export const hasStatus = (e, type) => e.statuses.some((s) => s.type === type);

export function statusMagnitude(e, type) {
  const def = STATUS_DEFS[type];
  let total = 0, best = 0;
  for (const s of e.statuses) {
    if (s.type !== type) continue;
    total += s.magnitude;
    best = Math.max(best, s.magnitude);
  }
  return def && def.stack === STACK.STACK ? total : best;
}

export function clearStatuses(e, { onlyHarmful = true } = {}) {
  const harmless = new Set(['immune', 'hastened']);
  const removed = e.statuses.filter((s) => !onlyHarmful || !harmless.has(s.type));
  e.statuses = e.statuses.filter((s) => onlyHarmful && harmless.has(s.type));
  return removed.length;
}

// Called once per fixed tick per entity. `onDamage` is injected so this module
// stays free of any dependency on the damage pipeline.
export function updateStatuses(e, dt, onDamage) {
  if (!e.statuses.length) return;
  for (let i = e.statuses.length - 1; i >= 0; i--) {
    const s = e.statuses[i];
    s.duration -= dt;
    if (s.type === 'rot') {
      s.tickAccum += dt;
      while (s.tickAccum >= 0.5) {
        s.tickAccum -= 0.5;
        onDamage?.(e, s.magnitude * 0.5, { type: 'rot', source: s.source, silent: false });
      }
    }
    if (s.duration <= 0) e.statuses.splice(i, 1);
  }
}

// Multiplicative speed factor from all movement-affecting statuses.
export function speedFactor(e) {
  if (hasStatus(e, 'stun')) return 0;
  let f = 1;
  const slow = statusMagnitude(e, 'slow');
  if (slow > 0) f *= Math.max(0.25, 1 - slow);
  if (hasStatus(e, 'hastened')) f *= 1.18;
  return f;
}

export function damageTakenFactor(e) {
  const v = statusMagnitude(e, 'vulnerable');
  return 1 + v;
}
