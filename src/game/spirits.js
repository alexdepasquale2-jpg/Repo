// TIER G · Gear & bound spirits (v4 rename: "AI" is enchantment, not code).
//
// G-N01 capacity  — how many voices you can hold without losing yourself
// G-N04 possession — how much of your body you have lent out
// G-N05 total possession — past thresholds the gear acts without you
//
// Every modifier is a small amount of agency traded for a small amount of
// capability. That is the throne's bargain, sold in pieces, from level one.
// The parallel to overgrowth is never stated anywhere in the UI on purpose.

export const SPIRITS = {
  keen_edge: {
    name: 'Keen Edge', capacity: 2, possession: 1,
    desc: '+12% swing rate.',
    apply: (p) => { p.swingRateScale *= 1.12; },
  },
  steady_hand: {
    name: 'Steady Hand', capacity: 2, possession: 1,
    desc: '+10% damage.',
    apply: (p) => { p.damageScale *= 1.10; },
  },
  threat_sense: {
    // G-N08 · the template for "helpful without taking over".
    name: 'Threat-Sense', capacity: 2, possession: 1,
    desc: 'Marks the most dangerous enemy nearby. Advises; never acts.',
    apply: (p) => { p.threatSense = true; },
  },
  scavenger: {
    // G-N11 · every system needs one modifier that is just nice, or possession
    // reads as a punishment mechanic instead of a bargain.
    name: 'Scavenger Routine', capacity: 1, possession: 1,
    desc: 'Collects salvage in a wide radius. No cost worth naming.',
    apply: (p) => { p.salvageRadius = 190; },
  },
  predictive_aim: {
    // G-N07
    name: 'Predictive Aim', capacity: 2, possession: 3,
    desc: 'Your shots lead moving targets. You stop aiming.',
    apply: (p) => { p.predictiveAim = true; },
  },
  auto_retarget: {
    // G-N06 · immediately obviously good, and the first decision it takes.
    name: 'Auto-Retarget', capacity: 2, possession: 5,
    desc: 'Your lock moves to the weakest thing in range. You did not choose it.',
    apply: (p) => { p.autoRetarget = true; },
  },
  reactive_block: {
    // G-N09 · survivability rises; players stop reading telegraphs. Intended.
    name: 'Reactive Block', capacity: 3, possession: 6,
    desc: 'Something blocks for you, on its own timing.',
    apply: (p) => { p.reactiveBlock = 3.5; },
  },
  swarm_choir: {
    // G-N10 · the group is coordinated by something other than the group.
    name: 'Swarm Choir', capacity: 3, possession: 7,
    desc: 'Your abilities sequence themselves with nearby allies.',
    apply: (p) => { p.swarmChoir = true; },
  },
  last_resort: {
    // G-N12 · acts at the single moment you would most want to decide yourself.
    name: 'Last Resort', capacity: 3, possession: 9,
    desc: 'On lethal damage it takes the wheel and keeps you walking.',
    apply: (p) => { p.lastResort = true; },
  },
  throne_shard: {
    // G-N16 · recoverable only from a defeated boss. It is the fungus's own spirit.
    name: 'Throne-Shard', capacity: 1, possession: 12,
    desc: 'A piece of the network, still warm. You arrive already partly claimed.',
    apply: (p) => { p.damageScale *= 1.25; p.swingRateScale *= 1.15; p.throneShard = true; },
    unique: true,
  },
};

// G-N05 · thresholds. Crossing one is never announced; the player finds it.
export const POSSESSION_TIERS = [
  { at: 0,  label: 'Your own',      drift: 0,    autoFire: false },
  { at: 8,  label: 'Crowded',       drift: 0.12, autoFire: false },
  { at: 14, label: 'Outvoted',      drift: 0.3,  autoFire: true },
  { at: 20, label: 'Passenger',     drift: 0.55, autoFire: true },
];

export function possessionTier(total) {
  let t = POSSESSION_TIERS[0];
  for (const tier of POSSESSION_TIERS) if (total >= tier.at) t = tier;
  return t;
}

export function createLoadout() {
  return { equipped: [], capacity: 6 };
}

export function totalCapacityUsed(loadout) {
  return loadout.equipped.reduce((n, id) => n + SPIRITS[id].capacity, 0);
}

export function totalPossession(loadout) {
  return loadout.equipped.reduce((n, id) => n + SPIRITS[id].possession, 0);
}

export function canEquip(loadout, id) {
  const def = SPIRITS[id];
  if (!def) return { ok: false, reason: 'unknown' };
  if (loadout.equipped.includes(id)) return { ok: false, reason: 'already bound' };
  if (totalCapacityUsed(loadout) + def.capacity > loadout.capacity) {
    return { ok: false, reason: 'no capacity — something has to go' };
  }
  return { ok: true };
}

export function equip(loadout, id) {
  const check = canEquip(loadout, id);
  if (!check.ok) return check;
  loadout.equipped.push(id);
  return { ok: true };
}

export function unequip(loadout, id) {
  const i = loadout.equipped.indexOf(id);
  if (i >= 0) loadout.equipped.splice(i, 1);
}

// Recomputed from scratch every time the loadout changes — never incrementally,
// or unequipping leaks a bonus and the build becomes a lie.
export function applyLoadout(actor, loadout) {
  actor.swingRateScale = 1;
  actor.damageScale = 1;
  actor.salvageRadius = 44;
  actor.predictiveAim = false;
  actor.autoRetarget = false;
  actor.reactiveBlock = 0;
  actor.swarmChoir = false;
  actor.lastResort = false;
  actor.threatSense = false;
  actor.throneShard = false;

  for (const id of loadout.equipped) SPIRITS[id].apply(actor);

  actor.possession = totalPossession(loadout);
  actor.possessionTier = possessionTier(actor.possession);

  // G-N13 · conflicts are discoverable, not documented. Auto-retarget and
  // threat-sense disagree, and the disagreement is visible as a flickering lock.
  actor.spiritConflict = actor.autoRetarget && actor.threatSense;
  return actor;
}
