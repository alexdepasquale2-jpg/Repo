// src/entities/vendor.js
// Three places to spend things you cannot see the amount of.
//
//   sheila  — the HOA shop. Trust-priced. Judges you at the counter.
//   colonel — a crate. No currency of any kind. Loot for relics, and he decides.
//   frog    — the stall under the culvert. Takes what you like. Adds Debt SILENTLY.
//             No prompt, no confirmation, no total, ever. Not once.
//
// Stock restocks off the RunSummary: the louder last night was, the stranger the shelf.
// Pure logic. No DOM.

import { pick } from '../data/rumors.js';
import { neighborDef } from '../data/neighbors.js';

let _itemSeq = 1;
const mkItem = (kind, name, rarity, neighborId = null, tags = []) => ({
  id: `v${_itemSeq++}`, kind, name, rarity, neighborId, tags,
});

// --- catalogs -------------------------------------------------------------
// tier 0 = the sanctioned stuff. tier 3 = things with somebody's name still on them.

const SHEILA_STOCK = [
  [0, () => mkItem('produce', 'Approved Bedding Plant', 0, 'sheila', ['floral', 'tidy'])],
  [0, () => mkItem('junk', 'Laminated Bylaw Excerpt', 0, 'sheila', ['documented', 'tidy'])],
  [1, () => mkItem('seed', 'Uniform Border Seed', 1, 'sheila', ['floral', 'tidy'])],
  [1, () => mkItem('relic', 'Committee Gavel', 1, 'sheila', ['documented'])],
  [2, () => mkItem('weapon', 'Edging Shear', 2, 'sheila', ['metal', 'tidy'])],
  [2, () => mkItem('relic', 'Minutes Of A Meeting That Did Not Happen', 2, 'sheila', ['documented', 'old'])],
];

const COLONEL_STOCK = [
  [0, () => mkItem('junk', 'Feed Scoop', 0, 'colonel', ['metal'])],
  [1, () => mkItem('relic', 'Service Ribbon, Unearned', 1, 'colonel', ['old', 'metal'])],
  [1, () => mkItem('seed', 'Seed From The Bottom Of The Sack', 1, 'colonel', ['old'])],
  [2, () => mkItem('weapon', 'Rebar, Sharpened Patiently', 2, 'colonel', ['metal', 'buried'])],
  [2, () => mkItem('relic', 'Something He Dug Up And Did Not Report', 2, 'colonel', ['buried', 'dug-up', 'old'])],
  [3, () => mkItem('relic', 'The Coop Key Nobody Asked About', 3, 'colonel', ['old', 'metal'])],
];

const FROG_STOCK = [
  [0, () => mkItem('junk', 'Damp Envelope', 0, 'frog', ['wet', 'unlabelled'])],
  [1, () => mkItem('weapon', 'Sprinkler Head, Still Turning', 1, 'frog', ['wet', 'metal'])],
  [2, () => mkItem('seed', 'Seed That Was Not Grown', 2, 'frog', ['wet', 'unlabelled'])],
  [2, () => mkItem('weapon', 'Hose Coil That Prefers The Dark', 2, 'frog', ['wet'])],
  [3, () => mkItem('relic', 'A Front Door Key For This House', 3, 'previous', ['old', 'unlabelled'])],
  [3, () => mkItem('relic', 'The Previous Owners Reading Glasses', 3, 'previous', ['old', 'dug-up'])],
  [3, () => mkItem('weapon', 'Something From The Culvert, Wrapped', 3, 'frog', ['wet', 'unlabelled', 'dug-up'])],
];

const CATALOGS = { sheila: SHEILA_STOCK, colonel: COLONEL_STOCK, frog: FROG_STOCK };

export class Vendor {
  /**
   * @param {'sheila'|'colonel'|'frog'} id
   * @param {Economy} economy
   * @param {() => number} rng
   */
  constructor(id, economy, rng = Math.random) {
    this.id = id;
    this.economy = economy;
    this.rng = rng;
    this.def = neighborDef(id);
    this.stock = [];
    this.mode = id === 'colonel' ? 'barter' : id === 'frog' ? 'debt' : 'trust';
    this.lastLoudness = 0;
    this.restock(null);
  }

  /** Loudness of the prior run, 0..1. Silence restocks nothing interesting. */
  static loudnessOf(runSummary) {
    if (!runSummary) return 0.2;
    const noise = runSummary.noise ?? 0;
    const kills = runSummary.kills ?? 0;
    const dmg = runSummary.damageTaken ?? 0;
    const raw = noise / 100 + kills / 300 + dmg / 400 + (runSummary.bossDefeated ? 0.15 : 0);
    return Math.max(0, Math.min(1, raw));
  }

  /**
   * Restock. Loud runs and Debt push the shelf toward the wrong end of the catalog;
   * quiet runs and Trust keep it municipal.
   */
  restock(runSummary) {
    const loud = Vendor.loudnessOf(runSummary);
    this.lastLoudness = loud;

    const depth = this.economy ? this.economy.stockDepth(this.id) : 3;
    const weird = this.economy ? this.economy.weirdness(this.id) : 0;
    const ceiling = this.economy ? this.economy.rarityCeiling(this.id) : 2;

    // The shelf's centre of gravity.
    const pull = Math.min(3, weird * 4 + loud * 2.2);

    const catalog = CATALOGS[this.id] || SHEILA_STOCK;
    const eligible = catalog.filter(([tier]) => tier <= Math.max(0, Math.min(3, ceiling)));

    const picked = [];
    for (let i = 0; i < depth && eligible.length; i++) {
      // Weighted toward `pull`: high Debt/loud nights surface the tier-three stuff.
      const scored = eligible.map(([tier, make]) => ({
        make, w: 1 / (1 + Math.abs(tier - pull)) + this.rng() * 0.35,
      }));
      scored.sort((a, b) => b.w - a.w);
      picked.push(scored[0].make());
    }
    this.stock = picked;
    return this.stock;
  }

  /** Coarse bucket only. Never a figure. */
  priceOf(item) {
    return this.economy.priceFor(item, this.id);
  }

  /** What the Colonel wants for a given item. Barter only — no currency exists here. */
  barterAsk(item) {
    if (this.mode !== 'barter') return null;
    const want = (item.rarity ?? 0) >= 2 ? 'relic' : 'junk';
    return {
      wantKind: want,
      minRarity: Math.max(0, (item.rarity ?? 0) - 1),
      line: 'Bring me something with history on it and we will not discuss it again.',
    };
  }

  /**
   * Buy. Returns { ok, item, line, silent }.
   * At the stall `silent` is true: the transaction completes with no confirmation
   * step and no acknowledgement that anything was owed. It just goes quiet.
   */
  buy(item, offering = null) {
    const idx = this.stock.indexOf(item);
    if (idx === -1) return { ok: false, item: null, line: 'That is not out.', silent: false };

    if (this.mode === 'trust') {
      const ok = this.economy.spendTrust(item, this.id);
      if (!ok) {
        return {
          ok: false, item: null, silent: false,
          line: 'I would rather wait until things have settled down for you.',
        };
      }
      this.stock.splice(idx, 1);
      return { ok: true, item, silent: false, line: pick(this.def.voice.shop, this.rng) };
    }

    if (this.mode === 'barter') {
      const ask = this.barterAsk(item);
      const good = offering
        && offering.kind === ask.wantKind
        && (offering.rarity ?? 0) >= ask.minRarity;
      if (!good) {
        return { ok: false, item: null, silent: false, line: ask.line };
      }
      this.stock.splice(idx, 1);
      return { ok: true, item, silent: false, given: offering, line: 'Fine. Fine.' };
    }

    // frog. No prompt. No total. No question.
    this.economy.takeOnDebt(item, this.id);
    this.stock.splice(idx, 1);
    return { ok: true, item, silent: true, line: pick(this.def.voice.shop, this.rng) };
  }

  greet() {
    return pick(this.def.voice.greet, this.rng);
  }
}

export function allVendors(economy, rng = Math.random) {
  return ['sheila', 'colonel', 'frog'].map((id) => new Vendor(id, economy, rng));
}

// SELF-TEST:
//   const eco = new Economy(); const [s, c, f] = allVendors(eco, rng);
//   f.buy(f.stock[0]) -> { ok:true, silent:true }, and eco.debt has risen with
//     NO confirmation step anywhere in the call path.
//   c.buy(c.stock[0]) with no offering -> ok:false and a barter line, never a price.
//   s.buy(...) with eco.trust === 0 -> ok:false, refusal line, no number in it.
//   After eco.owe('frogPurchase', 60), f.restock(loudSummary) surfaces tier-3 stock
//     (a key to your own front door, the previous owner's glasses).
//   restock(quietSummary) with high Trust yields bedding plants and bylaws.
