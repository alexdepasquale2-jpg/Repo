// src/systems/passives.js
// ---------------------------------------------------------------------------
// Owned passive "vices": rank tracking, stat aggregation, flag resolution.
//
// Owner: Agent B (Progression). Pure and standalone — imports only its own
// data file. Never touches Math.random(); any randomness is injected.
//
// Used by src/systems/leveling.js (which owns the offer/choose flow) and read
// directly by Agent A when it needs a multiplier or a behaviour flag.
//
// Stat semantics: every stat is a MULTIPLIER whose neutral value is one.
// Ranks compound — a rank-three vice with { damage: 1.08 } yields 1.08 ** 3.
// For `armor`, `noise`, `spread` and `cooldown`, LOWER is better; the sign
// convention lives in the data, not here.
// ---------------------------------------------------------------------------

import { PASSIVES, PASSIVES_BY_ID } from '../data/passives.js';

export class PassiveState {
  constructor() {
    /** @type {Map<string, number>} passiveId -> current rank (>= 1) */
    this.ranks = new Map();
    this._cache = null;
  }

  /** All defined vices, in data order. */
  static all() {
    return PASSIVES.slice();
  }

  static def(id) {
    return PASSIVES_BY_ID[id] || null;
  }

  rank(id) {
    return this.ranks.get(id) || 0;
  }

  isMaxed(id) {
    const def = PASSIVES_BY_ID[id];
    if (!def) return true;
    return this.rank(id) >= def.maxRank;
  }

  /** Every vice not yet at max rank. The pool Leveling draws offers from. */
  available() {
    return PASSIVES.filter((p) => !this.isMaxed(p.id));
  }

  /** Take one rank of a vice. Returns the new rank, or 0 if it was refused. */
  take(id) {
    const def = PASSIVES_BY_ID[id];
    if (!def) return 0;
    if (this.isMaxed(id)) return 0;
    const next = this.rank(id) + 1;
    this.ranks.set(id, next);
    this._cache = null;
    return next;
  }

  /** Recompute the aggregate multiplier table and flag counts. */
  _rebuild() {
    const stats = Object.create(null);
    const flags = Object.create(null);
    for (const [id, rank] of this.ranks) {
      const def = PASSIVES_BY_ID[id];
      if (!def || rank <= 0) continue;
      for (const stat of Object.keys(def.mods)) {
        const per = def.mods[stat];
        const prev = stats[stat] === undefined ? 1 : stats[stat];
        stats[stat] = prev * Math.pow(per, rank);
      }
      for (const f of def.flags) {
        flags[f] = (flags[f] || 0) + rank;
      }
    }
    this._cache = { stats, flags };
    return this._cache;
  }

  _view() {
    return this._cache || this._rebuild();
  }

  /** Aggregate multiplier for one stat. Unknown/untouched stats return one. */
  statMultiplier(statName) {
    const v = this._view().stats[statName];
    return v === undefined ? 1 : v;
  }

  /** Whole multiplier table (a copy). Handy for Agent A's per-frame recompute. */
  allStats() {
    return Object.assign(Object.create(null), this._view().stats);
  }

  /** True if any owned vice carries this behaviour flag. */
  hasFlag(flag) {
    return (this._view().flags[flag] || 0) > 0;
  }

  /** Summed rank across every vice carrying this flag — flag intensity. */
  flagRank(flag) {
    return this._view().flags[flag] || 0;
  }

  /** Total ranks taken across all vices. Equals the number of level-ups spent. */
  totalRanks() {
    let n = 0;
    for (const r of this.ranks.values()) n += r;
    return n;
  }

  /** Owned vices as display rows. Rank is NOT rendered as a number by the UI. */
  owned() {
    const out = [];
    for (const [id, rank] of this.ranks) {
      const def = PASSIVES_BY_ID[id];
      if (def) out.push({ id, name: def.name, desc: def.desc, rank, def });
    }
    return out;
  }

  serialize() {
    return Object.fromEntries(this.ranks);
  }

  static deserialize(obj) {
    const s = new PassiveState();
    for (const id of Object.keys(obj || {})) {
      if (PASSIVES_BY_ID[id]) s.ranks.set(id, obj[id]);
    }
    return s;
  }
}

/**
 * Weighted pick without replacement.
 * @param {Array} pool        candidate objects
 * @param {(x:any)=>number} weightOf
 * @param {number} n          how many to draw
 * @param {()=>number} rng    injected, returns [0,1)
 */
export function weightedSample(pool, weightOf, n, rng) {
  const items = pool.slice();
  const out = [];
  for (let k = 0; k < n && items.length > 0; k++) {
    let total = 0;
    const w = items.map((it) => {
      const x = Math.max(0, weightOf(it));
      total += x;
      return x;
    });
    if (total <= 0) {
      out.push(items.splice(Math.floor(rng() * items.length), 1)[0]);
      continue;
    }
    let roll = rng() * total;
    let idx = items.length - 1;
    for (let i = 0; i < items.length; i++) {
      roll -= w[i];
      if (roll <= 0) { idx = i; break; }
    }
    out.push(items.splice(idx, 1)[0]);
  }
  return out;
}

// SELF-TEST:
//   const s = new PassiveState();
//   s.take('spite'); s.take('spite');            // rank two
//   s.statMultiplier('damage')  -> 1.08 ** 2 === 1.1664
//   s.statMultiplier('moveSpeed') -> 1 (untouched stat)
//   s.take('playing_dead'); s.hasFlag('playDead') -> true
//   Take 'unopened_mail' twice, then a third time -> take() returns 0 and the
//   vice disappears from available(). weightedSample(pool, ()=>1, 3, rng)
//   returns three DISTINCT pool members for any rng.
