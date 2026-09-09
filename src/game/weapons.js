// T1-N03 · Auto-swing melee, T1-N04 · tech-weapon framework, F-N03 · range bands.
//
// v4 resolution: auto-swing only fires when the target is inside the weapon's
// BAND. Each weapon wants a different distance, and holding that band while
// knockback, fungal ground and allies push you out IS the skill ceiling.
// Adding a weapon is one data entry plus (optionally) one behavior function.
import { angleTo, dist, normalize } from '../core/math.js';
import { makeDamage } from './combat.js';
import { applyStatus } from './status.js';

export const WEAPONS = {
  scavenged_blade: {
    name: 'Scavenged Blade',
    kind: 'melee',
    damage: 11,
    cadence: 0.62,          // seconds between swing starts
    windup: 0.14, active: 0.08, recovery: 0.16,
    band: [0, 62],          // wants to be inside; forgiving, the starter weapon
    arc: 1.15,
    knockback: 90,
    mass: 1,
    desc: 'Close band, forgiving. Whoever owned it did not get far.',
  },
  reach_glaive: {
    name: 'Reach Glaive',
    kind: 'melee',
    damage: 17,
    cadence: 0.86,
    windup: 0.24, active: 0.1, recovery: 0.26,
    band: [58, 104],        // punishing: too close and it stops swinging
    arc: 0.9,
    knockback: 150,
    mass: 1.35,
    desc: 'Hold the outer edge. Step in and it stops swinging entirely.',
  },
  cleaver: {
    name: 'Warden Cleaver',
    kind: 'melee',
    damage: 13,
    cadence: 0.95,
    windup: 0.3, active: 0.14, recovery: 0.3,
    band: [0, 78],
    arc: 2.3,               // wide: hits crowds
    knockback: 190,
    mass: 1.7,
    cleave: true,
    desc: 'Wide arc. Fighting six things is the point.',
  },
  bound_repeater: {
    name: 'Bound Repeater',
    kind: 'ranged',
    damage: 7,
    cadence: 0.3,
    windup: 0.06, active: 0.02, recovery: 0.1,
    band: [120, 420],       // must keep distance to keep firing
    projectileSpeed: 640,
    knockback: 20,
    mass: 0.8,
    desc: 'The spirit inside aims. You only have to stay far away.',
  },
  rot_lance: {
    name: 'Rot Lance',
    kind: 'ranged',
    damage: 5,
    cadence: 0.55,
    windup: 0.16, active: 0.04, recovery: 0.18,
    band: [90, 340],
    projectileSpeed: 520,
    knockback: 10,
    mass: 1.1,
    onHit: (ctx, victim) => applyStatus(victim, 'rot', { duration: 3, magnitude: 4, source: ctx.owner }),
    desc: 'Low impact, lasting. Rot does the work after you have moved on.',
  },
};

export function makeWeapon(id) {
  const def = WEAPONS[id];
  if (!def) throw new Error(`unknown weapon: ${id}`);
  return {
    id, def,
    tier: 1,
    phase: 'idle',          // idle | windup | active | recovery
    timer: 0,
    cooldown: 0,
    swingsLanded: 0,
    // F-N03 telemetry: uptime is the number both skilled and unskilled players see.
    inBandTicks: 0,
    totalTicks: 0,
  };
}

export const bandOf = (w) => {
  const [lo, hi] = w.def.band;
  // Tier upgrades widen behavior, never inflate damage (G-N14).
  const grow = (w.tier - 1) * 0.12;
  return [lo * (1 - grow * 0.5), hi * (1 + grow)];
};

export function inBand(w, d) {
  const [lo, hi] = bandOf(w);
  return d >= lo && d <= hi;
}

export function weaponDamage(w) {
  return w.def.damage * (1 + (w.tier - 1) * 0.15);
}

// One update for every weapon holder — player, ally, husk, enemy.
// `ctx` supplies the shared services so weapons stay data + one hook.
export function updateWeapon(owner, w, dt, ctx) {
  w.totalTicks++;
  if (w.cooldown > 0) w.cooldown -= dt;

  const target = owner.target;
  const d = target && !target.dead ? dist(owner.x, owner.y, target.x, target.y) : Infinity;
  const ready = target && !target.dead && inBand(w, d);
  if (ready) w.inBandTicks++;

  const rateScale = owner.swingRateScale ?? 1;

  switch (w.phase) {
    case 'idle':
      if (ready && w.cooldown <= 0 && !owner.actionLocked) {
        w.phase = 'windup';
        w.timer = w.def.windup / rateScale;
        owner.facing = angleTo(owner.x, owner.y, target.x, target.y);
        ctx.events?.emit('swing-start', { owner, weapon: w });
      }
      break;

    case 'windup':
      w.timer -= dt;
      // Turning to track during windup, but the commit already happened.
      if (target && !target.dead) owner.facing = angleTo(owner.x, owner.y, target.x, target.y);
      if (w.timer <= 0) {
        w.phase = 'active';
        w.timer = w.def.active / rateScale;
        fire(owner, w, ctx);
      }
      break;

    case 'active':
      w.timer -= dt;
      if (w.timer <= 0) { w.phase = 'recovery'; w.timer = w.def.recovery / rateScale; }
      break;

    case 'recovery':
      w.timer -= dt;
      if (w.timer <= 0) {
        w.phase = 'idle';
        w.cooldown = Math.max(0, (w.def.cadence - w.def.windup - w.def.active - w.def.recovery) / rateScale);
      }
      break;
  }
}

function fire(owner, w, ctx) {
  const target = owner.target;
  if (!target || target.dead) return;
  const dmg = weaponDamage(w) * (owner.damageScale ?? 1);

  if (w.def.kind === 'ranged') {
    const n = normalize(target.x - owner.x, target.y - owner.y);
    ctx.spawnProjectile({
      x: owner.x + n.x * (owner.radius + 6),
      y: owner.y + n.y * (owner.radius + 6),
      vx: n.x * w.def.projectileSpeed,
      vy: n.y * w.def.projectileSpeed,
      damage: dmg,
      owner,
      knockback: w.def.knockback,
      homing: owner.predictiveAim ? target : null,   // G-N07
      onHit: w.def.onHit ? (victim) => w.def.onHit({ owner, ctx }, victim) : null,
      color: w.id === 'rot_lance' ? '#8fbf5a' : '#d8cfa8',
    });
    w.swingsLanded++;
    return;
  }

  // Melee: everything hostile inside the arc, capped to one victim unless cleaving.
  const victims = ctx.meleeSweep(owner, bandOf(w)[1] + 8, w.def.arc);
  const hits = w.def.cleave ? victims : victims.slice(0, 1);
  for (const v of hits) {
    ctx.applyDamage(v, makeDamage(dmg, {
      source: owner, knockback: w.def.knockback, type: 'physical',
    }));
    w.def.onHit?.({ owner, ctx }, v);
  }
  if (hits.length) w.swingsLanded++;
  ctx.events?.emit('swing-hit', { owner, weapon: w, hits });
}

// The number the F-N03 exit gate asks both players to be able to see.
export const swingUptime = (w) => (w.totalTicks < 30 ? 0 : w.inBandTicks / w.totalTicks);
