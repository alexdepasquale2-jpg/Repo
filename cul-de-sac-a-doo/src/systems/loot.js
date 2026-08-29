// src/systems/loot.js
// ---------------------------------------------------------------------------
// Loot rolls: what a cleared wave leaves on the lawn.
//
// Owner: Agent B (Progression). Pure and standalone — no imports outside its
// own module tree, no Math.random(), rng injected per call.
//
// Frozen API (docs/CONTRACT.md):
//   export function rollLoot(waveNumber, neighborId, rng) -> Item[]
//
// Item shape (contract):
//   { id, kind: 'weapon'|'relic'|'seed'|'produce'|'junk', neighborId?,
//     rarity: 0..3, name }
//
// `id` is a fresh unique instance id. `name` is player-facing and contains NO
// DIGITS. Rarity is internal; the UI is expected to signal it with colour or
// wording, never with a tier number.
//
// NOTE ON DATA PLACEMENT: Agent B owns only src/data/weapons.js and
// src/data/passives.js, so the loot tables live in the clearly-fenced block
// below rather than in a src/data/loot.js. Everything tunable is in that
// block; nothing below it holds a magic number that matters for balance.
// ---------------------------------------------------------------------------

import { WEAPONS } from '../data/weapons.js';

// ======================= LOOT TABLES (all tuning) ==========================

export const NEIGHBOR_IDS = [
  'sheila', 'colonel', 'frog', 'marge', 'dwayne', 'newlyweds', 'previous'
];

export const LOOT_TUNING = {
  // Expected drop count = base + wave * perWave, capped.
  dropBase: 0.9,
  dropPerWave: 0.16,
  dropCap: 5,

  // Rarity weights at wave one, and how much each shifts per wave.
  rarityBase: [72, 21, 6, 1],
  rarityPerWave: [-2.6, 0.9, 1.2, 0.45],
  rarityFloor: 0.4,

  // Chance the drop is the wave's neighbour relic, before rarity gating.
  relicBase: 0.035,
  relicPerWave: 0.006,
  relicCap: 0.16,
  // The Previous Owner's relic is the rarest object in the game and only
  // starts appearing deep into a night.
  previousRelicChance: 0.012,
  previousRelicMinWave: 8,

  // Chance a drop is a weapon, only at rarity two or better.
  weaponChance: 0.18,

  // Everything else splits between seeds, produce and junk. Weights per rarity.
  // [seed, produce, junk]
  fillerWeights: [
    [22, 10, 68],  // rarity 0 — mostly junk
    [38, 24, 38],
    [46, 36, 18],
    [52, 44, 4]
  ],

  // Luck stat multiplies the rarity weights of tiers one and up.
  luckTiers: [1, 1, 1.15, 1.35]
};

// Seeds — consumed by Agent C's garden system. `plant` is the garden key.
export const SEEDS = [
  { key: 'tomato',     rarity: 0, name: 'Tomato Seed' },
  { key: 'zucchini',   rarity: 0, name: 'Zucchini Seed' },
  { key: 'crabgrass',  rarity: 0, name: 'Crabgrass Runner' },
  { key: 'marigold',   rarity: 1, name: 'Marigold Seed' },
  { key: 'rhubarb',    rarity: 1, name: 'Rhubarb Crown' },
  { key: 'pepper',     rarity: 1, name: 'Ghost Pepper Seed' },
  { key: 'nightshade', rarity: 2, name: 'Nightshade Cutting' },
  { key: 'gourd',      rarity: 2, name: 'Unlucky Gourd Seed' },
  { key: 'hedge',      rarity: 2, name: 'Privacy Hedge Sprig' },
  { key: 'gnomevine',  rarity: 3, name: 'Gnome Vine Bulb' },
  { key: 'moonflower', rarity: 3, name: 'Moonflower Pod' }
];

export const PRODUCE = [
  { rarity: 0, name: 'Bruised Tomato' },
  { rarity: 0, name: 'Split Zucchini' },
  { rarity: 1, name: 'Jar of Something' },
  { rarity: 1, name: 'Bundle of Rhubarb' },
  { rarity: 2, name: 'Prizewinning Gourd' },
  { rarity: 2, name: 'Pepper Nobody Asked For' },
  { rarity: 3, name: 'Moonflower, Cut and Still Open' }
];

export const JUNK = [
  { rarity: 0, name: 'Bent Fork' },
  { rarity: 0, name: 'Damp Flyer' },
  { rarity: 0, name: 'Loose Screws' },
  { rarity: 0, name: 'Cracked Hose Clamp' },
  { rarity: 0, name: 'Somebody Else’s Mail' },
  { rarity: 1, name: 'Half a Wind Chime' },
  { rarity: 1, name: 'Spare House Key' },
  { rarity: 1, name: 'Extension Cord, Knotted' },
  { rarity: 2, name: 'Security Camera, Unplugged' },
  { rarity: 2, name: 'Deed Photocopy' },
  { rarity: 3, name: 'Envelope Addressed to No One' }
];

// Relic per neighbour. The Previous Owner's is deliberately the least
// explicable object on the table.
export const RELICS = {
  sheila:    { rarity: 2, name: 'Sheila’s Clipboard' },
  colonel:   { rarity: 2, name: 'The Colonel’s Leg Band' },
  frog:      { rarity: 3, name: 'Debt Frog’s Receipt Spike' },
  marge:     { rarity: 1, name: 'Marge’s Sprinkler Head' },
  dwayne:    { rarity: 1, name: 'Dwayne’s Ear Protection' },
  newlyweds: { rarity: 2, name: 'The Prices’ Registry Card' },
  previous:  { rarity: 3, name: 'A Key That Fits Your Door' }
};

// =========================== end loot tables ===============================

let _seq = 0;
function uid(prefix) {
  _seq = (_seq + 1) % 1e9;
  return prefix + '_' + _seq.toString(36) + '_' + Date.now().toString(36);
}

function clampWave(w) {
  const n = Number(w);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Weighted index pick. `rng` is injected. */
function pickIndex(weights, rng) {
  let total = 0;
  for (const w of weights) total += Math.max(0, w);
  if (total <= 0) return 0;
  let roll = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    roll -= Math.max(0, weights[i]);
    if (roll <= 0) return i;
  }
  return weights.length - 1;
}

/** Rarity weights for a wave, optionally biased by a luck multiplier. */
export function rarityWeights(waveNumber, luck = 1) {
  const w = clampWave(waveNumber);
  const t = LOOT_TUNING;
  return t.rarityBase.map((base, i) => {
    const v = base + t.rarityPerWave[i] * (w - 1);
    // Luck lifts the upper tiers only; tier zero is never boosted by it.
    const luckMul = Math.max(0.2, 1 + (t.luckTiers[i] - 1) * (luck - 1));
    return Math.max(t.rarityFloor, v * luckMul);
  });
}

/** Pick from a table entry list, preferring entries at or below `rarity`. */
function pickFromTable(table, rarity, rng) {
  const exact = table.filter((e) => e.rarity === rarity);
  const pool = exact.length ? exact : table.filter((e) => e.rarity <= rarity);
  const use = pool.length ? pool : table;
  return use[Math.floor(rng() * use.length) % use.length];
}

function makeSeed(rarity, rng) {
  const s = pickFromTable(SEEDS, rarity, rng);
  return {
    id: uid('seed'), kind: 'seed', rarity: s.rarity, name: s.name,
    plant: s.key
  };
}

function makeProduce(rarity, rng) {
  const p = pickFromTable(PRODUCE, rarity, rng);
  return { id: uid('prod'), kind: 'produce', rarity: p.rarity, name: p.name };
}

function makeJunk(rarity, rng) {
  const j = pickFromTable(JUNK, rarity, rng);
  return { id: uid('junk'), kind: 'junk', rarity: j.rarity, name: j.name };
}

function makeWeapon(rarity, rng) {
  const w = WEAPONS[Math.floor(rng() * WEAPONS.length) % WEAPONS.length];
  return {
    id: uid('wpn'), kind: 'weapon', rarity, name: w.name, weaponId: w.id
  };
}

function makeRelic(neighborId) {
  const r = RELICS[neighborId];
  if (!r) return null;
  return {
    id: uid('relic'), kind: 'relic', neighborId, rarity: r.rarity, name: r.name
  };
}

/**
 * Roll the drops for one cleared wave.
 *
 * @param {number} waveNumber   one-based wave index; drives quantity and rarity
 * @param {string} neighborId   whose wave it was; gates the relic drop
 * @param {()=>number} rng      injected uniform [0,1)
 * @param {{ luck?: number }} [opts]  luck multiplier from Leveling
 * @returns {Array<object>} Item[]
 */
export function rollLoot(waveNumber, neighborId, rng, opts = {}) {
  const random = typeof rng === 'function' ? rng : () => 0.5;
  const w = clampWave(waveNumber);
  const t = LOOT_TUNING;
  const luck = opts.luck === undefined ? 1 : Math.max(0.1, opts.luck);

  // How many things fall.
  const expected = Math.min(t.dropCap, t.dropBase + t.dropPerWave * (w - 1));
  let count = Math.floor(expected);
  if (random() < expected - count) count++;
  count = Math.max(1, count);

  const weights = rarityWeights(w, luck);
  const out = [];

  // The neighbour's relic — at most one per wave.
  const relicChance = Math.min(t.relicCap, t.relicBase + t.relicPerWave * (w - 1)) * luck;
  if (neighborId && RELICS[neighborId] && neighborId !== 'previous'
      && random() < relicChance) {
    const r = makeRelic(neighborId);
    if (r) out.push(r);
  }

  // The Previous Owner leaves things behind regardless of whose wave it was.
  if (w >= t.previousRelicMinWave && random() < t.previousRelicChance * luck) {
    const r = makeRelic('previous');
    if (r) out.push(r);
  }

  for (let i = 0; i < count; i++) {
    const rarity = pickIndex(weights, random);
    if (rarity >= 2 && random() < t.weaponChance) {
      out.push(makeWeapon(rarity, random));
      continue;
    }
    const fill = t.fillerWeights[rarity] || t.fillerWeights[0];
    const which = pickIndex(fill, random);
    if (which === 0) out.push(makeSeed(rarity, random));
    else if (which === 1) out.push(makeProduce(rarity, random));
    else out.push(makeJunk(rarity, random));
  }

  return out;
}

/** Diagnostic: rarity histogram over many rolls. Not used in the game loop. */
export function sampleDistribution(waveNumber, neighborId, rng, rolls = 1000) {
  const hist = [0, 0, 0, 0];
  const kinds = Object.create(null);
  let items = 0;
  for (let i = 0; i < rolls; i++) {
    for (const it of rollLoot(waveNumber, neighborId, rng)) {
      hist[it.rarity]++;
      kinds[it.kind] = (kinds[it.kind] || 0) + 1;
      items++;
    }
  }
  return { hist, kinds, items, rolls };
}

// SELF-TEST:
//   1. Shape: every item from rollLoot has a string id, a kind in the contract
//      set, an integer rarity in zero..three and a digit-free name.
//   2. Scaling: sampleDistribution(1, 'marge', rng, 2000) must be dominated by
//      rarity zero; the same at wave twenty must show a clearly heavier tail
//      at rarity two and three.
//   3. Relics: rollLoot with neighborId 'marge' can only ever yield a 'marge'
//      relic or a 'previous' relic, never another neighbour's.
//   4. Determinism: two runs from the same seeded rng produce the same
//      sequence of kinds, names and rarities (ids differ by design).
//   5. Seeds: every 'seed' item carries a `plant` key that Agent C's garden
//      can look up in SEEDS.
