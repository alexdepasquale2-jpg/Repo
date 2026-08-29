// src/systems/aftermath.js
// The bridge from combat to consequence.
//
// Agent A hands us a RunSummary at endNight(). We convert last night into Trust,
// Debt, and — the only part that matters — the rumors it earned. Nobody is told
// which rumor came from which thing they did. Days later somebody will decline to
// sell them a shovel and they will not know why.
//
// RunSummary: { kills, damageTaken, noise, itemsLooted: Item[], wavesCleared,
//               bossDefeated, durationSec }

import { SEEDS, pick } from '../data/rumors.js';

// Who notices what. Rumors originate with whoever is plausibly awake.
const WITNESSES = {
  quiet: ['marge', 'newlyweds'],
  loud: ['marge', 'dwayne', 'colonel'],
  bloody: ['dwayne', 'sheila', 'colonel'],
  looting: ['colonel', 'sheila', 'dwayne'],
  debt: ['frog'],
  boss: ['frog', 'marge'],
};

export function loudnessOf(rs) {
  if (!rs) return 0;
  const n = (rs.noise ?? 0) / 100;
  const k = (rs.kills ?? 0) / 250;
  const w = (rs.wavesCleared ?? 0) / 12;
  return Math.max(0, Math.min(1, n * 0.55 + k * 0.30 + w * 0.15));
}

export function messinessOf(rs) {
  if (!rs) return 0;
  const d = (rs.damageTaken ?? 0) / 300;
  const long = Math.max(0, ((rs.durationSec ?? 0) - 900) / 900);
  return Math.max(0, Math.min(1, d * 0.75 + long * 0.25));
}

export class Aftermath {
  /**
   * @param {RumorEngine} rumorEngine
   * @param {Economy} economy
   * @param {() => number} rng
   */
  constructor(rumorEngine, economy, rng = Math.random) {
    this.rumors = rumorEngine;
    this.economy = economy;
    this.rng = rng;
    this.history = [];
  }

  /**
   * Consume a RunSummary. Returns { loudness, messiness, spawned: Rumor[] }.
   * Nothing here is shown to the player. The player finds out sideways or not at all.
   */
  process(runSummary) {
    const rs = runSummary || {};
    const loud = loudnessOf(rs);
    const messy = messinessOf(rs);
    const looted = (rs.itemsLooted || []).length;

    // --- currency ---------------------------------------------------------
    if (loud < 0.25 && messy < 0.25) {
      this.economy.credit('cleanRun');
      this.economy.credit('quietRun');
    } else {
      if (loud >= 0.5) this.economy.owe('loudRun');
      if (messy >= 0.5) this.economy.owe('messyRun');
    }
    if (rs.bossDefeated) this.economy.credit('bossCleared');
    else if ((rs.wavesCleared ?? 0) > 0) this.economy.owe('bossFled', 2);

    // --- how many stories last night is worth -----------------------------
    // A quiet night is worth about one. A loud, bloody, thieving night is worth a week.
    let budget = Math.round(0.6 + loud * 3.2 + messy * 1.6);
    if (looted > 4) budget += 1;
    budget = Math.max(1, Math.min(6, budget));

    const spawned = [];
    const usedSeeds = new Set();

    for (let i = 0; i < budget; i++) {
      const bucket = this._pickBucket(loud, messy, looted, rs, i);
      const seedList = SEEDS[bucket] || SEEDS.quiet;
      const seed = firstUnused(seedList, usedSeeds, this.rng);
      if (!seed) continue;
      usedSeeds.add(seed);
      const origin = pick(WITNESSES[bucket] || WITNESSES.quiet, this.rng);
      spawned.push(this.rumors.spawn(seed, origin, { cause: `run:${bucket}` }));
    }

    this.history.push({ loud, messy, budget, ids: spawned.map((r) => r.id) });
    return { loudness: loud, messiness: messy, spawned };
  }

  _pickBucket(loud, messy, looted, rs, index) {
    // First story of the night is about the loudest true thing. The rest drift.
    const weights = [
      ['loud', loud * 3],
      ['bloody', messy * 2.5],
      ['looting', Math.min(1.5, looted * 0.35)],
      ['boss', rs.bossDefeated ? 1.4 : 0],
      ['debt', this.economy && this.economy.debt > 20 ? 1.2 : 0.2],
      ['quiet', Math.max(0.4, 1.6 - loud * 2)],
    ];
    if (index > 0) weights.push(['garden', 0.5]);

    const total = weights.reduce((s, [, w]) => s + w, 0);
    let roll = this.rng() * total;
    for (const [name, w] of weights) {
      roll -= w;
      if (roll <= 0) return name;
    }
    return 'quiet';
  }

  /**
   * Rumors the player left alone for too long turn into Debt. Call once per day-tick
   * after rumorEngine.tick(). Not addressing something is itself a choice the street
   * charges you for.
   */
  settleIgnored(threshold = 4) {
    let charged = 0;
    for (const r of this.rumors.rumors) {
      if (r.ageTicks === threshold && r.corruptions >= 1) {
        this.economy.owe('ignoredRumor');
        charged++;
      }
    }
    return charged;
  }
}

function firstUnused(list, used, rng) {
  const free = list.filter((s) => !used.has(s));
  if (free.length === 0) return null;
  return free[Math.floor(rng() * free.length) % free.length];
}

// SELF-TEST:
//   const a = new Aftermath(engine, eco, rng);
//   a.process({kills:2, damageTaken:0, noise:3, itemsLooted:[], wavesCleared:1,
//              bossDefeated:false, durationSec:400})
//     -> spawned.length === 1, and eco.trust went up.
//   a.process({kills:240, damageTaken:280, noise:95, itemsLooted:[i,i,i,i,i],
//              wavesCleared:11, bossDefeated:true, durationSec:1500})
//     -> spawned.length >= 4, seeds drawn from the loud/bloody/looting buckets,
//        eco.debt went up.
//   No string produced here contains a digit.
