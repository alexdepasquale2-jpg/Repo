// T0-N03 · Movement controller and TIER P · the player.
// Acceleration, deceleration, friction, max speed, and a slight stop overshoot
// so the character has weight. Faked, never simulated (F-N01) — a physics engine
// is the wrong tool and every later system inherits whatever this feels like.
import { INTENT } from '../core/input.js';
import { clamp, damp, dist, normalize } from '../core/math.js';
import { createEntity, FACTION } from '../engine/entity.js';
import { makeWeapon } from './weapons.js';
import { makeAbilitySlot } from './abilities.js';
import { applyLoadout, createLoadout } from './spirits.js';
import { speedFactor } from './status.js';

export const MOVE = {
  maxSpeed: 218,
  accel: 1750,
  decel: 1250,
  turnAssist: 2.1,     // changing direction is faster than accelerating from rest
  stopDrift: 0.86,     // the overshoot that reads as weight
};

// F-N07 · a step, not a dodge. This is a positioning game, not a reflex game,
// so the movement ability solves positioning problems and grants no i-frames.
export const STEP = { distance: 148, duration: 0.17, cooldown: 2.6 };

export function createPlayer(x, y, { name = 'You', isLocal = true } = {}) {
  const p = createEntity({
    kind: 'attacker',
    name,
    x, y,
    radius: 13,
    faction: FACTION.PLAYER,
    hp: 120, maxHp: 120,
    mass: 1,
    isPlayerControlled: isLocal,
  });

  p.weapon = makeWeapon('scavenged_blade');
  p.offhand = null;                          // P-N09 · two weapons, no more
  p.abilities = [makeAbilitySlot('mark')];
  p.loadout = createLoadout();
  p.salvage = 0;                             // P-N08
  p.bankedSalvage = 0;                       // survives death (P-N06)
  p.level = 1;
  p.xp = 0;
  p.xpToNext = 60;
  p.stepCooldown = 0;
  p.stepTimer = 0;
  p.moveIntent = { x: 0, y: 0 };
  p.brain = null;
  p.trust = 0.7;                             // used by ally social logic
  p.pledged = false;                         // T2-N27 · a public commitment not to sit
  p.hasSat = false;
  p.spectating = false;

  applyLoadout(p, p.loadout);
  return p;
}

// Read intents → moveIntent. Gameplay code never sees a key.
export function readPlayerIntent(p, input) {
  const axis = input.moveAxis();
  p.moveIntent = axis;
}

// The single movement integrator, shared by player, allies, enemies and husks,
// so everything in the room obeys the same weight rules.
export function integrateMovement(e, dt, maxSpeedOverride = null) {
  const speedCap = (maxSpeedOverride ?? e.maxSpeed ?? MOVE.maxSpeed) * speedFactor(e);
  const intent = e.moveIntent ?? { x: 0, y: 0 };
  const wants = Math.hypot(intent.x, intent.y) > 0.01;

  if (e.stepTimer > 0) {
    // A step ignores input for its duration — committing is the cost.
    e.stepTimer -= dt;
    e.x += e.stepVx * dt;
    e.y += e.stepVy * dt;
    if (e.stepTimer <= 0) {
      // Bleed out of the step into normal velocity rather than stopping dead.
      e.vx = e.stepVx * 0.35;
      e.vy = e.stepVy * 0.35;
    }
  } else if (wants) {
    const n = normalize(intent.x, intent.y);
    const goalX = n.x * speedCap;
    const goalY = n.y * speedCap;
    // Turn assist: pushing against your own velocity accelerates harder, which
    // is what stops direction changes feeling like ice.
    const dot = (e.vx * n.x + e.vy * n.y) / (speedCap || 1);
    const accel = MOVE.accel * (dot < 0 ? MOVE.turnAssist : 1);
    e.vx = approach(e.vx, goalX, accel * dt);
    e.vy = approach(e.vy, goalY, accel * dt);
  } else {
    e.vx = approach(e.vx, 0, MOVE.decel * dt);
    e.vy = approach(e.vy, 0, MOVE.decel * dt);
    // Slight drift after release. Small enough to be deniable, large enough to feel.
    e.vx *= Math.pow(MOVE.stopDrift, dt * 8);
    e.vy *= Math.pow(MOVE.stopDrift, dt * 8);
  }

  // Knockback is a separate channel that decays fast, so being hit moves you
  // without fighting the controller for ownership of your velocity.
  e.x += (e.vx + e.knockVx) * dt;
  e.y += (e.vy + e.knockVy) * dt;
  e.knockVx = damp(e.knockVx, 0, 0.07, dt);
  e.knockVy = damp(e.knockVy, 0, 0.07, dt);
  if (Math.abs(e.knockVx) < 1) e.knockVx = 0;
  if (Math.abs(e.knockVy) < 1) e.knockVy = 0;

  // Facing follows movement only when not locked onto something.
  if (!e.target && wants) e.facing = Math.atan2(e.vy, e.vx);
}

function approach(v, goal, maxDelta) {
  const d = goal - v;
  return Math.abs(d) <= maxDelta ? goal : v + Math.sign(d) * maxDelta;
}

export function tryStep(e) {
  if (e.stepCooldown > 0 || e.stepTimer > 0 || e.dead) return false;
  const intent = e.moveIntent;
  let dx = intent.x, dy = intent.y;
  if (Math.hypot(dx, dy) < 0.01) { dx = Math.cos(e.facing); dy = Math.sin(e.facing); }
  const n = normalize(dx, dy);
  e.stepTimer = STEP.duration;
  e.stepCooldown = STEP.cooldown;
  e.stepVx = n.x * (STEP.distance / STEP.duration);
  e.stepVy = n.y * (STEP.distance / STEP.duration);
  return true;
}

export function updatePlayerTimers(p, dt) {
  if (p.stepCooldown > 0) p.stepCooldown -= dt;
  if (p.iframes > 0) p.iframes -= dt;
  if (p.hitFlash > 0) p.hitFlash -= dt;
  if (p.spiritTookTarget > 0) p.spiritTookTarget -= dt;
  if (p.targetAcquiredAt !== undefined) p.targetAcquiredAt += dt;
  if (p.reactiveBlockCd > 0) p.reactiveBlockCd -= dt;
}

// T3-N03 · XP and leveling. P-N05 · five stats, every one of which is felt.
export function grantXp(p, amount, events) {
  p.xp += amount;
  while (p.xp >= p.xpToNext) {
    p.xp -= p.xpToNext;
    p.level++;
    p.xpToNext = Math.round(p.xpToNext * 1.35);
    p.maxHp += 14;
    p.hp = Math.min(p.maxHp, p.hp + 14);
    // G-N01 · capacity grows slowly, so you still cannot run everything you own.
    p.loadout.capacity += (p.level % 2 === 0) ? 1 : 0;
    events?.emit('level-up', { player: p });
  }
}

// P-N08 · salvage. Radius comes from the loadout, which is why the Scavenger
// spirit is the one modifier with no downside worth naming.
export function collectSalvage(p, drops, events) {
  for (let i = drops.length - 1; i >= 0; i--) {
    const d = drops[i];
    if (d.taken) continue;
    // Salvage only. Weapons and spirits are deliberate pickups (P-N09: every
    // pickup is a replacement decision), so they must never be hoovered up.
    if (d.kind !== 'salvage') continue;
    if (dist(p.x, p.y, d.x, d.y) <= (p.salvageRadius ?? 44)) {
      d.taken = true;
      p.salvage += d.amount;
      events?.emit('salvage', { player: p, amount: d.amount });
      drops.splice(i, 1);
    }
  }
}
