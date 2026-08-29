// src/systems/evolution.js
// ---------------------------------------------------------------------------
// Weapon evolutions: a base weapon plus the right neighbour's relic becomes
// something mechanically different — not a bigger number, a different verb.
//
// Owner: Agent B (Progression). Pure and standalone.
//
// The seven neighbourIds are fixed by docs/CONTRACT.md:
//   sheila | colonel | frog | marge | dwayne | newlyweds | previous
//
// Six of them each key exactly one base weapon. The seventh, `previous`, is
// the game's thematic secret: The Previous Owner's relic pairs with ANY
// weapon, and always produces the same haunted form — a weapon that borrows a
// different firing pattern every volley and fires from where you were standing
// a moment ago instead of from where you are. It is gated behind the
// 'hauntStack' passive flag (the "Previous Tenancy" vice), so a player who has
// never attuned to the house cannot stumble into it.
//
// Evolved defs are full WeaponDefs in the shape documented in
// src/data/weapons.js, registered into a WeaponSystem via `register()`.
// ---------------------------------------------------------------------------

import { WEAPONS_BY_ID } from '../data/weapons.js';

export const NEIGHBOR_IDS = [
  'sheila', 'colonel', 'frog', 'marge', 'dwayne', 'newlyweds', 'previous'
];

/** The wildcard relic. Pairs with every weapon. */
export const WILDCARD_NEIGHBOR = 'previous';

/** Passive flag that must be present before the wildcard pairing resolves. */
export const WILDCARD_FLAG = 'hauntStack';

// --- the pairing matrix ----------------------------------------------------
// weaponId -> neighborId whose relic evolves it.
export const PAIRINGS = {
  bottle: 'sheila',      // her recycling bin, her rules
  hose: 'marge',         // the Sprinkler Wraith's own line
  lawndart: 'colonel',   // the flock scatters, the dart follows
  leafblower: 'dwayne',  // he has opinions about the correct setting
  mailbox: 'newlyweds',  // the registry, the gauntlet, the arch
  romancandle: 'frog'    // the debt, come due, in the air
};

/** Reverse lookup: neighborId -> weaponId it evolves (wildcard excluded). */
export const PAIRINGS_BY_NEIGHBOR = Object.fromEntries(
  Object.entries(PAIRINGS).map(([w, n]) => [n, w])
);

// --- evolved weapon definitions -------------------------------------------
// Each is mechanically distinct from its base: it changes the firing routine
// or what the projectile DOES, not just its damage.
export const EVOLUTIONS = {
  bottle: {
    id: 'bottle_evo',
    base: 'bottle',
    neighborId: 'sheila',
    name: 'Recycling Violation',
    blurb: 'Sheila sorted it. You unsorted it. Now the lawn is unsortable.',
    // Base lobbed a bottle that popped into fast shards. This one leaves the
    // shards standing still and burning for a long while: area denial, not burst.
    pattern: 'lob',
    cooldown: 1.0, count: 2, spread: 0.5,
    damage: 12, speed: 220, radius: 8, pierce: 0, lifetime: 0.55,
    kind: 'bottle_evo',
    extra: {
      drift: 170,
      shardCount: 10,
      shardDamage: 7,
      shardSpeed: 24,        // near-stationary: a puddle, not a spray
      shardLifetime: 3.2,    // lingers
      shardRadius: 11
    }
  },

  hose: {
    id: 'hose_evo',
    base: 'hose',
    neighborId: 'marge',
    name: 'Perpetual Sprinkler',
    blurb: 'Marge never turned hers off either. That is what happened to her.',
    // Base swept back and forth across a cone. This never reverses — the aim
    // walks all the way around, forever, independent of where you face.
    pattern: 'sweep',
    cooldown: 0.11, count: 1, spread: Math.PI * 2,
    damage: 6, speed: 400, radius: 7, pierce: 4, lifetime: 0.42,
    kind: 'water_evo',
    extra: { step: 0.55, wrap: true }
  },

  lawndart: {
    id: 'lawndart_evo',
    base: 'lawndart',
    neighborId: 'colonel',
    name: 'Homing Rooster',
    blurb: 'The Colonel insists it is not a bird. It insists otherwise.',
    // Base was a one-way spear. This one turns around and rakes the same line
    // a second time on the way home — pierce damage twice per throw.
    pattern: 'boomerang',
    cooldown: 1.35, count: 1, spread: 0,
    damage: 40, speed: 330, radius: 11, pierce: 8, lifetime: 2.0,
    kind: 'dart_evo',
    extra: { turnAt: 0.5, returnSpeed: 460, stagger: 0 }
  },

  leafblower: {
    id: 'leafblower_evo',
    base: 'leafblower',
    neighborId: 'dwayne',
    name: 'Reverse Setting',
    blurb: 'Dwayne swore it had one. Dwayne was right, and should not have been.',
    // Base shoved enemies away. This one PULLS: negative knockback, slow
    // long-lived puffs, so the crowd stacks in front of you instead of scattering.
    pattern: 'cone',
    cooldown: 0.09, count: 4, spread: 1.35,
    damage: 3.2, speed: 150, radius: 10, pierce: 5, lifetime: 0.55,
    kind: 'gust_evo',
    extra: {
      jitter: 0.18,
      speedJitter: 40,
      knockback: -260,   // negative: a vacuum
      noise: 3.0
    }
  },

  mailbox: {
    id: 'mailbox_evo',
    base: 'mailbox',
    neighborId: 'newlyweds',
    name: 'Registry Gauntlet',
    blurb: 'The Prices registered for a set. This is most of the set.',
    // Base was one ring. This is two counter-rotating rings at different radii,
    // so there is no safe approach angle and no gap that stays open.
    pattern: 'orbit',
    cooldown: 2.0, count: 6, spread: 0,
    damage: 19, speed: 0, radius: 14, pierce: 99, lifetime: 2.0,
    kind: 'bat_evo',
    extra: {
      orbitRadius: 78,
      orbitSpeed: 4.6,
      hitInterval: 0.28,
      counterRotate: true,
      innerScale: 0.5
    }
  },

  romancandle: {
    id: 'romancandle_evo',
    base: 'romancandle',
    neighborId: 'frog',
    name: 'Debt Mortar',
    blurb: 'It goes up. Everything that goes up is eventually owed to someone.',
    // Base was a returning volley. This abandons the return entirely and
    // becomes indirect fire: arcing shells that burst into a ring of embers.
    pattern: 'lob',
    cooldown: 1.25, count: 3, spread: 1.1,
    damage: 15, speed: 260, radius: 9, pierce: 0, lifetime: 0.8,
    kind: 'ember_evo',
    extra: {
      drift: 240,
      shardCount: 8,
      shardDamage: 9,
      shardSpeed: 210,
      shardLifetime: 0.45,
      shardRadius: 6
    }
  }
};

/**
 * Build the Previous Owner's haunted form of a base weapon.
 * Same shell for every weapon; only the name and the borrowed tuning differ.
 */
export function makeRevenant(baseWeaponId) {
  const base = WEAPONS_BY_ID[baseWeaponId];
  if (!base) return null;
  return {
    id: baseWeaponId + '_revenant',
    base: baseWeaponId,
    neighborId: WILDCARD_NEIGHBOR,
    name: 'Hand-Me-Down ' + base.name,
    blurb: 'It was already in the garage. It was already like this.',
    pattern: 'revenant',
    cooldown: 0.5,
    count: 1,
    spread: 0.6,
    damage: base.damage * 0.7,
    speed: 300,
    radius: base.radius,
    pierce: Math.max(1, base.pierce),
    lifetime: 1.0,
    kind: 'revenant',
    extra: {
      lookBack: true,        // fires the way you came from, not the way you face
      cycle: ['lob', 'sweep', 'spear', 'cone', 'orbit', 'boomerang'],
      // pattern-specific tuning borrowed on the volleys that need it
      perPattern: {
        lob: { drift: 150, shardCount: 3, shardDamage: 5, shardSpeed: 170,
               shardLifetime: 0.3, shardRadius: 5 },
        sweep: { step: 0.9, wrap: true },
        spear: { falloff: 0.9 },
        cone: { jitter: 0.3, speedJitter: 70, knockback: 60 },
        orbit: { orbitRadius: 58, orbitSpeed: 5.5, hitInterval: 0.3 },
        boomerang: { turnAt: 0.4, returnSpeed: 380, stagger: 0 }
      }
    }
  };
}

/** Every non-wildcard evolved def, in a stable order. */
export function allEvolutions() {
  return Object.keys(EVOLUTIONS).map((k) => EVOLUTIONS[k]);
}

/**
 * Resolve a (weapon, relic) pair to an evolved def, or null.
 * @param {string} weaponId
 * @param {string} neighborId one of NEIGHBOR_IDS
 * @param {{ hasFlag?: (f:string)=>boolean }} [leveling] required for `previous`
 */
export function evolutionFor(weaponId, neighborId, leveling) {
  if (!WEAPONS_BY_ID[weaponId]) return null;
  if (neighborId === WILDCARD_NEIGHBOR) {
    const attuned = !leveling || typeof leveling.hasFlag !== 'function'
      ? false
      : leveling.hasFlag(WILDCARD_FLAG);
    return attuned ? makeRevenant(weaponId) : null;
  }
  if (PAIRINGS[weaponId] !== neighborId) return null;
  return EVOLUTIONS[weaponId] || null;
}

/** True if this exact pairing is a real one (ignoring the attunement gate). */
export function isPairing(weaponId, neighborId) {
  if (neighborId === WILDCARD_NEIGHBOR) return !!WEAPONS_BY_ID[weaponId];
  return PAIRINGS[weaponId] === neighborId;
}

/**
 * Which relic does this weapon want? Returns the neighborId, or null.
 * The UI must describe this in words, never as a recipe with numbers.
 */
export function relicFor(weaponId) {
  return PAIRINGS[weaponId] || null;
}

/**
 * Scan an inventory for a resolvable evolution of the equipped weapon.
 *
 * @param {string} weaponId       currently equipped base weapon
 * @param {Array}  inventory      Item[] per the contract; relics are
 *                                { kind: 'relic', neighborId, ... }
 * @param {object} [leveling]     a Leveling instance, for the wildcard gate
 * @returns {null | { def, relic, neighborId, wildcard: boolean }}
 */
export function checkUnlock(weaponId, inventory, leveling) {
  if (!Array.isArray(inventory)) return null;
  const relics = inventory.filter((i) => i && i.kind === 'relic' && i.neighborId);
  // The ordinary pairing takes precedence; the haunting is the fallback, so a
  // player carrying both still gets the sane weapon unless they hold only the
  // Previous Owner's relic.
  for (const r of relics) {
    if (r.neighborId === WILDCARD_NEIGHBOR) continue;
    const def = evolutionFor(weaponId, r.neighborId, leveling);
    if (def) return { def, relic: r, neighborId: r.neighborId, wildcard: false };
  }
  for (const r of relics) {
    if (r.neighborId !== WILDCARD_NEIGHBOR) continue;
    const def = evolutionFor(weaponId, WILDCARD_NEIGHBOR, leveling);
    if (def) return { def, relic: r, neighborId: WILDCARD_NEIGHBOR, wildcard: true };
  }
  return null;
}

/**
 * Perform the evolution: register the evolved def on the WeaponSystem and
 * equip it. Returns the def, or null if nothing resolved.
 *
 * @param {import('./weapons.js').WeaponSystem} weaponSystem
 * @param {Array} inventory
 * @param {object} [leveling]
 */
export function tryEvolve(weaponSystem, inventory, leveling) {
  const cur = weaponSystem && weaponSystem.current();
  if (!cur) return null;
  const baseId = cur.base || cur.id;   // already-evolved weapons do not re-evolve
  if (cur.base) return null;
  const hit = checkUnlock(baseId, inventory, leveling);
  if (!hit) return null;
  weaponSystem.register(hit.def);
  weaponSystem.equip(hit.def.id);
  return hit.def;
}

// SELF-TEST:
//   1. Coverage: every base weapon id appears exactly once in PAIRINGS, and
//      every neighbourId used is one of the contract's seven.
//   2. Resolution: for each weapon, evolutionFor(w, PAIRINGS[w]) returns a def
//      whose `pattern` DIFFERS from the base weapon's pattern in four of six
//      cases and whose `extra` differs in all six.
//   3. Wrong pairings: evolutionFor('bottle', 'colonel') -> null.
//   4. Wildcard gate: evolutionFor('hose', 'previous', {hasFlag:()=>false})
//      -> null; the same call with hasFlag:()=>true returns a 'revenant' def.
//   5. Strings: no `name` or `blurb` here contains a digit.
