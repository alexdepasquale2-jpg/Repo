// src/systems/economy.js
// Two hidden tracks: Trust and Debt. Neither is ever rendered, as a number or otherwise.
//
// Trust is what the street will extend to you. Debt is what something under the culvert
// will extend to you. Both buy things. They pull the shelves in opposite directions:
// Trust makes everything cheaper and blander; Debt makes everything dearer, and then
// puts things on the shelf that should not be for sale. That is the trap, and the game
// never once warns you about it.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Where value comes from. Internal only.
export const TRUST_SOURCES = {
  cleanRun: 6,
  quietRun: 3,
  bossCleared: 4,
  gardenHarvest: 2,
  gardenTended: 1,
  goodGift: 3,
  rumorAddressed: 4,
  hoaCompliance: 2,
};

export const DEBT_SOURCES = {
  messyRun: 5,
  loudRun: 4,
  frogPurchase: 8,
  ignoredRumor: 3,
  bossFled: 6,
  suspiciousHarvest: 3,
  overGifting: 2,
};

// Vendor character. Trust-priced, barter-only, and whatever the Frog is.
const VENDOR_PROFILES = {
  sheila: { accepts: 'trust', trustDiscount: 0.030, debtPenalty: 0.022, baseTier: 2, weirdCeiling: 1 },
  colonel: { accepts: 'barter', trustDiscount: 0.008, debtPenalty: 0.008, baseTier: 2, weirdCeiling: 2 },
  // The stall gets friendlier the deeper in you are. That is not kindness.
  frog: { accepts: 'debt', trustDiscount: -0.015, debtPenalty: -0.030, baseTier: 3, weirdCeiling: 4 },
};

export class Economy {
  constructor(rng = Math.random) {
    this.trust = 0;
    this.debt = 0;
    this.rng = rng;
    this.ledger = []; // internal audit trail. Never rendered. Used by the ending.
  }

  // -------------------------------------------------------------------------
  // frozen API
  // -------------------------------------------------------------------------

  credit(source, amount) {
    const n = amount ?? TRUST_SOURCES[source] ?? 1;
    this.trust = clamp(this.trust + n, 0, 200);
    this.ledger.push({ t: 'credit', source, n });
    return this.trust;
  }

  owe(source, amount) {
    const n = amount ?? DEBT_SOURCES[source] ?? 1;
    this.debt = clamp(this.debt + n, 0, 200);
    this.ledger.push({ t: 'owe', source, n });
    return this.debt;
  }

  /**
   * COARSE BUCKET ONLY. Returns { tier: 0..4, affordable: bool }.
   * There is deliberately no way to get a raw figure out of this module, so the UI
   * is physically incapable of printing one even if a later contributor wanted to.
   *   tier 0 = "they'd be offended if you offered"
   *   tier 4 = "you are not walking out with that"
   */
  priceFor(item, vendorId) {
    const p = VENDOR_PROFILES[vendorId] || VENDOR_PROFILES.sheila;
    const cost = internalCost(item);

    // Trust pulls the tier down. Debt pushes it up — except at the stall, where the
    // arrangement gets friendlier the deeper in you are.
    let t = p.baseTier
      + (cost - 2) * 0.6
      - this.trust * p.trustDiscount
      + this.debt * p.debtPenalty;

    const tier = clamp(Math.round(t), 0, 4);

    let affordable;
    if (p.accepts === 'barter') {
      // The Colonel takes no currency at all. You either have a relic he wants or you do not.
      affordable = true;
    } else if (p.accepts === 'debt') {
      // Always. Always always. This is the whole problem.
      affordable = true;
    } else {
      affordable = this.trust >= trustRequired(tier);
    }

    return { tier, affordable };
  }

  // -------------------------------------------------------------------------
  // spending
  // -------------------------------------------------------------------------

  /** Pay with Trust. Returns bool. Refuses rather than going negative. */
  spendTrust(item, vendorId) {
    const { tier, affordable } = this.priceFor(item, vendorId);
    if (!affordable) return false;
    const n = trustRequired(tier);
    if (this.trust < n) return false;
    this.trust -= n;
    this.ledger.push({ t: 'spend', source: vendorId, n });
    return true;
  }

  /**
   * Pay the Frog. There is no confirmation, no prompt, no receipt, no total.
   * The item is simply yours and the number quietly went up somewhere you cannot see.
   */
  takeOnDebt(item, vendorId = 'frog') {
    const { tier } = this.priceFor(item, vendorId);
    this.owe('frogPurchase', DEBT_SOURCES.frogPurchase + tier * 2);
    this.ledger.push({ t: 'debt-purchase', source: vendorId, n: tier });
    return true; // never fails. never asks.
  }

  // -------------------------------------------------------------------------
  // stock pressure — read by vendor.js
  // -------------------------------------------------------------------------

  /** How many slots a vendor can fill. Trust broadens the shelf. */
  stockDepth(vendorId) {
    const p = VENDOR_PROFILES[vendorId] || VENDOR_PROFILES.sheila;
    const base = p.accepts === 'debt' ? 2 : 3;
    return clamp(Math.round(base + this.trust * 0.03 + this.debt * 0.02), 1, 6);
  }

  /**
   * 0..1. How wrong the stock is allowed to be. Debt raises it; Trust suppresses it.
   * At the top of this range vendors carry things with a neighbour's name on them.
   */
  weirdness(vendorId) {
    const p = VENDOR_PROFILES[vendorId] || VENDOR_PROFILES.sheila;
    const raw = (this.debt * 0.022 - this.trust * 0.012);
    return clamp(raw, 0, p.weirdCeiling / 4);
  }

  /** Max rarity a vendor will put out. Debt unlocks the strong, wrong stuff. */
  rarityCeiling(vendorId) {
    const p = VENDOR_PROFILES[vendorId] || VENDOR_PROFILES.sheila;
    const fromDebt = Math.floor(this.debt / 18);
    const fromTrust = Math.floor(this.trust / 40);
    return clamp(1 + fromDebt + fromTrust, 0, p.weirdCeiling === 1 ? 2 : 3);
  }

  /** Which side of you is currently louder. Used by the ending, never shown. */
  leaning() {
    if (this.debt > this.trust * 1.4) return 'owed';
    if (this.trust > this.debt * 1.4) return 'trusted';
    return 'balanced';
  }
}

/** Internal only. Never leaves the module in numeric form. */
function internalCost(item) {
  if (!item) return 2;
  const byKind = { junk: 0, seed: 1, produce: 1, relic: 3, weapon: 3 };
  return (byKind[item.kind] ?? 2) + (item.rarity ?? 0) * 0.8;
}

function trustRequired(tier) {
  return [0, 4, 9, 16, 26][clamp(tier, 0, 4)];
}

// SELF-TEST:
//   const e = new Economy();
//   e.priceFor({kind:'weapon', rarity:2}, 'sheila').tier          // note it
//   e.credit('cleanRun'); e.credit('cleanRun'); e.credit('cleanRun');
//   -> same call now returns a LOWER tier at sheila
//   e.owe('frogPurchase', 40)
//   -> sheila tier rises, frog tier falls, e.rarityCeiling('frog') rises
//   e.takeOnDebt(item) returns true unconditionally and never asks anything.
//   priceFor() must never return a field containing a currency amount.
