// T2-N01 · Throne entity, T2-N02 · possession/controller swap, T2-N34 · the final
// allocation, and D4 · mercy.
//
// v4: the throne is a throne, not a control seat. The mycelium is a curse with a
// will of its own. Sitting is claiming something you have no right to, and being
// claimed in return.
import { clamp, dist } from '../core/math.js';
import { createEntity, FACTION } from '../engine/entity.js';

export const SIT_HOLD = 1.5;   // deliberate hold, never a tap — sitting must feel chosen

export function createThrone(x, y) {
  return createEntity({
    kind: 'throne',
    name: 'The Throne',
    x, y,
    radius: 34,
    faction: FACTION.NEUTRAL,
    solid: true,
    immovable: true,
    targetable: false,
    hp: 900, maxHp: 900,
    occupant: null,
    sitProgress: 0,
    persistent: true,
  });
}

// T2-N02 · The most technically dangerous operation in the project.
// Full teardown then full rebuild — never a partial mutation, or state leaks
// between roles and the bug is invisible until the second succession.
export function tearDownAttacker(a) {
  const snapshot = {
    weapon: a.weapon,
    offhand: a.offhand,
    abilities: a.abilities,
    loadout: a.loadout,
    salvage: a.salvage,
    bankedSalvage: a.bankedSalvage,
    level: a.level, xp: a.xp, xpToNext: a.xpToNext,
    maxHp: a.maxHp,
    faction: a.faction,
    radius: a.radius,
    mass: a.mass,
    isPlayerControlled: a.isPlayerControlled,
  };

  a.target = null;
  a.moveIntent = { x: 0, y: 0 };
  a.vx = a.vy = a.knockVx = a.knockVy = 0;
  a.stepTimer = 0; a.stepCooldown = 0;
  a.statuses.length = 0;
  a.abilities = [];
  a.weapon = null;
  a.offhand = null;
  a.brain = null;
  a.hiddenFrom = new Set();
  a.lastKnown = null;
  a.focusMarkedBy = null;

  return snapshot;
}

export function becomeBoss(a, throne, snapshot) {
  a.faction = FACTION.THRONE;
  a.kind = 'boss';
  a.x = throne.x;
  a.y = throne.y + 6;
  a.radius = 30;
  a.immovable = true;
  a.solid = true;
  a.targetable = true;
  a.mass = 999;
  a.maxHp = 320 + snapshot.level * 22;   // successions carry level (T2-N28 revised)
  a.hp = a.maxHp;
  a.armor = 0.97;
  a.wasAttacker = snapshot;              // everything needed to give them back
  a.satAt = performance.now();
  a.hasSat = true;
  return a;
}

// D4 · Defeating the boss does not kill them. It breaks the fungus and leaves
// the sitter DOWNED — human again, dying next to the chair.
export function downSitter(bossEntity) {
  bossEntity.dead = false;
  bossEntity.downed = true;
  bossEntity.hp = 1;
  bossEntity.armor = 0;
  bossEntity.targetable = true;
  bossEntity.solid = true;
  bossEntity.immovable = true;
  bossEntity.faction = FACTION.NEUTRAL;
  bossEntity.bleedOut = 25;   // long enough to argue about
  return bossEntity;
}

// ── T2-N34 · The final allocation ★★ ─────────────────────────────────────
// The loot is on the boss, and the throne sitter distributes it. Nobody sits
// from curiosity: you sit because whoever holds the throne decides who gets paid.
export function createAllocation({ pot, claimants, allocator, timeLimit = 30 }) {
  return {
    pot: Math.round(pot),
    claimants,               // entities eligible for a share
    allocator,               // the spared sitter, or the winning boss
    shares: new Map(claimants.map((c) => [c.id, 0])),
    remaining: Math.round(pot),
    timeLimit,
    timer: timeLimit,
    resolved: false,
    cursor: 0,
  };
}

export function allocate(alloc, claimantId, amount) {
  if (alloc.resolved) return false;
  const cur = alloc.shares.get(claimantId) ?? 0;
  const delta = clamp(amount, -cur, alloc.remaining);
  if (delta === 0) return false;
  alloc.shares.set(claimantId, cur + delta);
  alloc.remaining -= delta;
  return true;
}

// Open question 2 in the doc: whether the boss can allocate to nobody at all.
// Answered here as yes — withholding is a statement, and the pot simply burns.
export function resolveAllocation(alloc) {
  alloc.resolved = true;
  const payouts = [];
  for (const c of alloc.claimants) {
    const amount = alloc.shares.get(c.id) ?? 0;
    if (amount > 0) {
      c.bankedSalvage = (c.bankedSalvage ?? 0) + amount;
      payouts.push({ who: c, amount });
    }
  }
  return { payouts, burned: alloc.remaining };
}

// The pot is what the boss was carrying plus what the room owes. If the boss
// WINS instead, no allocation happens and attackers keep only what they
// salvaged mid-fight — which is what makes husk salvage insurance (T2-N17).
export function computePot(bossEntity, attackers) {
  const carried = bossEntity.wasAttacker?.salvage ?? 0;
  const roomOwes = attackers.reduce((n, a) => n + Math.round((a.salvage ?? 0) * 0.5), 0);
  return carried + roomOwes + 120;
}

// T2-N15 · Throne temptation. Nobody sits in an obviously cursed chair, so the
// chair has to offer something wanted right now: the exit is sealed until
// someone sits, and whoever sits decides who gets paid.
export function throneOffer(state) {
  return {
    sealed: true,
    line: state.successions === 0
      ? 'The door will not open. The chair is the only thing in the room that is not locked.'
      : 'The chair is empty again. Everyone has now seen what it is worth.',
  };
}

export function canReachThrone(entity, throne) {
  return dist(entity.x, entity.y, throne.x, throne.y) < throne.radius + entity.radius + 26;
}
