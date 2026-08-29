// src/systems/garden.js
// The back plot. Plant, wait day-ticks, harvest Items.
//
// Gardening is the one honest way to earn Trust. It is also the fastest way to be
// seen doing something at an hour when nothing is done. Some seeds are diegetically
// indefensible — you cannot grow them without the street forming a view about you —
// and those ones spawn their own rumors the moment they go in the ground.
//
// Pure logic. No rendering, no DOM.

import { pick } from '../data/rumors.js';

let _seq = 1;

export const SEED_TYPES = {
  border_lily: {
    name: 'Border Lily',
    growTicks: 3,
    yield: { kind: 'produce', name: 'Border Lily, Cut', rarity: 1, tags: ['floral', 'homemade'] },
    trust: 2,
    suspicious: false,
  },
  hoa_hedge: {
    name: 'Approved Hedge Cutting',
    growTicks: 4,
    yield: { kind: 'produce', name: 'Compliant Hedge Length', rarity: 1, tags: ['tidy', 'floral'] },
    trust: 3,
    suspicious: false,
  },
  tomato: {
    name: 'Tomato Start',
    growTicks: 3,
    yield: { kind: 'produce', name: 'Tomatoes, Too Many', rarity: 0, tags: ['homemade'] },
    trust: 1,
    suspicious: false,
  },
  nightshade: {
    name: 'Something From The Verge',
    growTicks: 4,
    yield: { kind: 'produce', name: 'Berries Nobody Should Eat', rarity: 2, tags: ['dug-up'] },
    trust: 0,
    suspicious: true,
    rumorSeed: 'there is something growing behind that house that nobody has a name for',
    witness: 'marge',
  },
  culvert_bulb: {
    name: 'Bulb From The Stall',
    growTicks: 5,
    yield: { kind: 'relic', name: 'Bulb That Came Up Warm', rarity: 3, tags: ['wet', 'dug-up'] },
    trust: 0,
    suspicious: true,
    rumorSeed: 'the new one planted something at an hour when nothing gets planted',
    witness: 'dwayne',
  },
  memorial_rose: {
    name: 'Rose From The Old Bed',
    growTicks: 6,
    yield: { kind: 'relic', name: 'Rose The Previous Owner Planted', rarity: 3, neighborId: 'previous', tags: ['floral', 'old', 'dug-up'] },
    trust: 1,
    suspicious: true,
    rumorSeed: 'the soil back there has been turned over more than once this week',
    witness: 'sheila',
  },
};

const PLOT_LINES = {
  empty: ['Turned over. Waiting.', 'Bare. Someone could see straight into it.'],
  growing: ['Something is up. Not up enough to identify.', 'It has leaves now. It has more leaves than it had.'],
  ready: ['That is as far as it is going to go.', 'It is done. It stopped a while ago, actually.'],
  spoiled: ['It went over. It went over quickly.', 'That is not what it was.'],
};

export class Garden {
  /**
   * @param {number} plotCount
   * @param {RumorEngine} rumorEngine  optional; suspicious plantings spawn rumors
   * @param {Economy} economy          optional; harvests credit Trust
   * @param {() => number} rng
   */
  constructor(plotCount = 4, rumorEngine = null, economy = null, rng = Math.random) {
    this.rng = rng;
    this.rumors = rumorEngine;
    this.economy = economy;
    this.dayTick = 0;
    this.plots = Array.from({ length: plotCount }, (_, i) => ({
      index: i, seedId: null, ticks: 0, state: 'empty', plantedAt: null,
    }));
  }

  freePlot() {
    return this.plots.find((p) => p.state === 'empty') || null;
  }

  /**
   * Plant. Returns { ok, plot, line, spawnedRumor }.
   * Nothing warns you that this particular seed is going to be discussed.
   */
  plant(seedId, plotIndex = null) {
    const def = SEED_TYPES[seedId];
    if (!def) return { ok: false, plot: null, line: 'That will not go in the ground.', spawnedRumor: null };

    const plot = plotIndex === null
      ? this.freePlot()
      : this.plots[plotIndex];
    if (!plot || plot.state !== 'empty') {
      return { ok: false, plot: null, line: 'There is no room back there.', spawnedRumor: null };
    }

    plot.seedId = seedId;
    plot.ticks = 0;
    plot.state = 'growing';
    plot.plantedAt = this.dayTick;

    let spawnedRumor = null;
    if (def.suspicious && this.rumors) {
      spawnedRumor = this.rumors.spawn(def.rumorSeed, def.witness, { cause: `garden:${seedId}` });
    }
    return { ok: true, plot, line: pick(PLOT_LINES.growing, this.rng), spawnedRumor };
  }

  /** One day-tick of growth. Call alongside RumorEngine.tick(). */
  tick() {
    this.dayTick += 1;
    for (const plot of this.plots) {
      if (plot.state === 'growing') {
        plot.ticks += 1;
        const def = SEED_TYPES[plot.seedId];
        if (plot.ticks >= def.growTicks) plot.state = 'ready';
      } else if (plot.state === 'ready') {
        plot.ticks += 1;
        // Left too long, it turns into something you have to explain.
        const def = SEED_TYPES[plot.seedId];
        if (plot.ticks >= def.growTicks + 4) {
          plot.state = 'spoiled';
          if (this.economy) this.economy.owe('ignoredRumor', 1);
        }
      }
    }
    if (this.economy && this.plots.some((p) => p.state === 'growing')) {
      this.economy.credit('gardenTended');
    }
    return this.dayTick;
  }

  /** Harvest one plot. Returns { ok, item, line, spawnedRumor }. */
  harvest(plotIndex) {
    const plot = this.plots[plotIndex];
    if (!plot) return { ok: false, item: null, line: '', spawnedRumor: null };

    if (plot.state === 'spoiled') {
      const line = pick(PLOT_LINES.spoiled, this.rng);
      this._clear(plot);
      return { ok: false, item: null, line, spawnedRumor: null };
    }
    if (plot.state !== 'ready') {
      return { ok: false, item: null, line: pick(PLOT_LINES.growing, this.rng), spawnedRumor: null };
    }

    const def = SEED_TYPES[plot.seedId];
    const item = {
      id: `g${_seq++}`,
      kind: def.yield.kind,
      name: def.yield.name,
      rarity: def.yield.rarity,
      neighborId: def.yield.neighborId || null,
      tags: def.yield.tags || [],
    };

    if (this.economy) {
      if (def.trust > 0) this.economy.credit('gardenHarvest', def.trust);
      if (def.suspicious) this.economy.owe('suspiciousHarvest');
    }

    // Bringing a suspicious crop out of the ground in daylight is its own event.
    let spawnedRumor = null;
    if (def.suspicious && this.rumors && this.rng() < 0.6) {
      spawnedRumor = this.rumors.spawn(
        'somebody was carrying something out of the back garden under a cloth',
        def.witness,
        { cause: `harvest:${plot.seedId}` },
      );
    }

    this._clear(plot);
    return { ok: true, item, line: pick(PLOT_LINES.ready, this.rng), spawnedRumor };
  }

  _clear(plot) {
    plot.seedId = null;
    plot.ticks = 0;
    plot.state = 'empty';
    plot.plantedAt = null;
  }

  /** For the UI: state words only, never a countdown, never a number. */
  describe() {
    return this.plots.map((p) => ({
      index: p.index,
      state: p.state,
      seedName: p.seedId ? SEED_TYPES[p.seedId].name : null,
      line: pick(PLOT_LINES[p.state], this.rng),
    }));
  }
}

// SELF-TEST:
//   const g = new Garden(3, engine, eco, rng);
//   g.plant('tomato') -> ok, spawnedRumor === null
//   g.plant('culvert_bulb') -> ok, spawnedRumor !== null  (Dwayne saw you)
//   tick() three times -> tomato plot state 'ready'; harvest() yields a produce Item
//     and eco.trust rose.
//   Leave a ready plot for four more ticks -> state 'spoiled', harvest returns ok:false.
//   describe() output contains no digits and no time remaining.
