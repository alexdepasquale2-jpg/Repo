// src/systems/leveling.js
// ---------------------------------------------------------------------------
// XP, level-ups and the three-card vice offer.
//
// Owner: Agent B (Progression). Pure and standalone.
//
// Frozen API (docs/CONTRACT.md):
//   new Leveling({ rng })
//   addXp(n)               -> null | { choices: PassiveDef[] }
//   choose(passiveId)      -> boolean (accepted)
//   statMultiplier(name)   -> Number, applied by Agent A
//
// XP thresholds are INTERNAL. Nothing here returns a number intended for the
// screen; `progress()` returns a zero-to-one fraction for a bar with no label.
//
// addXp returns an offer the moment a level is crossed. The offer is held
// pending until choose() resolves it — further addXp calls bank XP but return
// the same pending offer rather than stacking new ones, so Agent A can pause
// the night, show three cards, and resume. Multiple banked levels drain one
// at a time: choose() re-offers immediately if another level is owed.
// ---------------------------------------------------------------------------

import { PassiveState, weightedSample } from './passives.js';
import {
  XP_CURVE, RARITY_WEIGHTS, RARITY_LEVEL_DRIFT, CHOICES_PER_LEVEL
} from '../data/passives.js';

/** XP cost of the Nth level-up (N starting at one). Internal only. */
export function xpForLevel(n) {
  let cost = XP_CURVE.base * Math.pow(n, XP_CURVE.exponent);
  if (n > XP_CURVE.softCapLevel) {
    cost += (n - XP_CURVE.softCapLevel) * XP_CURVE.softCapStep;
  }
  return Math.round(cost);
}

/** How many level-ups a given total XP income buys. Balance helper. */
export function levelsForXp(totalXp) {
  let levels = 0;
  let spent = 0;
  for (;;) {
    const cost = xpForLevel(levels + 1);
    if (spent + cost > totalXp) return levels;
    spent += cost;
    levels++;
    if (levels > 500) return levels;
  }
}

export class Leveling {
  /**
   * @param {{ rng?: ()=>number, passives?: PassiveState }} [opts]
   *   rng — injected uniform [0,1) source. REQUIRED for deterministic runs;
   *   omitting it is only acceptable in throwaway tooling.
   */
  constructor(opts = {}) {
    this.rng = opts.rng || (() => 0.5);
    this.passives = opts.passives || new PassiveState();
    this.level = 1;
    this.xp = 0;                 // XP banked toward the next level
    this.totalXp = 0;
    this.pendingLevels = 0;      // levels crossed but not yet spent
    this.pendingOffer = null;    // { choices: PassiveDef[] } | null
    this.history = [];           // ordered passiveIds chosen
  }

  /** Zero-to-one fill toward the next level. Render as a bar, never as text. */
  progress() {
    const need = xpForLevel(this.level);
    return need <= 0 ? 0 : Math.min(1, this.xp / need);
  }

  /**
   * Bank XP. Returns an offer if one is now open, else null.
   * @param {number} n
   * @returns {null | { choices: object[] }}
   */
  addXp(n) {
    if (!(n > 0)) return this.pendingOffer;
    const gained = n * this.statMultiplier('xpGain');
    this.xp += gained;
    this.totalXp += gained;

    while (this.xp >= xpForLevel(this.level)) {
      this.xp -= xpForLevel(this.level);
      this.level++;
      this.pendingLevels++;
    }

    if (this.pendingLevels > 0 && !this.pendingOffer) {
      this.pendingOffer = this._makeOffer();
    }
    return this.pendingOffer;
  }

  /** The open offer, if any, without advancing anything. */
  currentOffer() {
    return this.pendingOffer;
  }

  /**
   * Spend the open offer on a vice.
   * @param {string} passiveId
   * @returns {boolean} true if accepted (id was on the open offer and took a rank)
   */
  choose(passiveId) {
    if (!this.pendingOffer) return false;
    const onOffer = this.pendingOffer.choices.some((c) => c.id === passiveId);
    if (!onOffer) return false;
    if (!this.passives.take(passiveId)) return false;

    this.history.push(passiveId);
    this.pendingLevels = Math.max(0, this.pendingLevels - 1);
    this.pendingOffer = this.pendingLevels > 0 ? this._makeOffer() : null;
    return true;
  }

  /** Discard the open offer without taking anything (a reroll-less skip). */
  skip() {
    if (!this.pendingOffer) return false;
    this.pendingLevels = Math.max(0, this.pendingLevels - 1);
    this.pendingOffer = this.pendingLevels > 0 ? this._makeOffer() : null;
    return true;
  }

  /** @returns {number} aggregate multiplier; one when nothing modifies it. */
  statMultiplier(statName) {
    return this.passives.statMultiplier(statName);
  }

  hasFlag(flag) { return this.passives.hasFlag(flag); }
  flagRank(flag) { return this.passives.flagRank(flag); }
  ownedPassives() { return this.passives.owned(); }

  /** Build three distinct, non-maxed, rarity-weighted picks. */
  _makeOffer() {
    const pool = this.passives.available();
    if (pool.length === 0) return null;
    const lvl = this.level;
    const weightOf = (p) => {
      const base = RARITY_WEIGHTS[p.rarity] || 1;
      const drift = (RARITY_LEVEL_DRIFT[p.rarity] || 0) * (lvl - 1);
      // A partially-taken vice is slightly likelier to come back around.
      const momentum = this.passives.rank(p.id) > 0 ? 1.25 : 1;
      return Math.max(0.5, (base + drift) * momentum);
    };
    const n = Math.min(CHOICES_PER_LEVEL, pool.length);
    const choices = weightedSample(pool, weightOf, n, this.rng);
    return choices.length ? { choices } : null;
  }

  serialize() {
    return {
      level: this.level, xp: this.xp, totalXp: this.totalXp,
      pendingLevels: this.pendingLevels, passives: this.passives.serialize()
    };
  }
}

// SELF-TEST:
//   1. Curve: levelsForXp(3500) should land between twenty and thirty — that is
//      the XP a twelve-to-fifteen minute night is budgeted to yield.
//      node -e "import('./src/systems/leveling.js').then(m=>console.log(
//        m.levelsForXp(3000), m.levelsForXp(3500), m.levelsForXp(5600)))"
//   2. Offers: with a seeded rng, addXp(9999) opens an offer of three vices
//      with distinct ids, all non-maxed. choose() on an id NOT in the offer
//      returns false and changes nothing.
//   3. Draining: one addXp big enough for several levels then repeated
//      choose() calls must yield exactly that many accepted choices before
//      currentOffer() goes null.
//   4. Maxing: take a vice to its maxRank and it must never appear again.
