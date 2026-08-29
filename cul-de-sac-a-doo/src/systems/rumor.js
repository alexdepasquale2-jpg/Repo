// src/systems/rumor.js
// The rumor engine. The only mechanism of consequence in this game.
//
// There is no meter. There is no relationship screen. There is a street, and on it
// a story about you is walking from house to house, getting worse, and it will
// arrive somewhere useful several days after you have forgotten what you did.
//
// Pure logic. No DOM. rng is injected.

import { RELAY, NEIGHBOR_DEFS } from '../data/neighbors.js';
import {
  escalate, drift, pick,
  REFRAMES, APPENDS, HEDGES, MIRROR_WRAPS,
  FRAGMENT_LEADINS, FRAGMENT_TRAILS, AMBIENT_FRAGMENTS,
} from '../data/rumors.js';

// ---------------------------------------------------------------------------
// THE SOCIAL GRAPH
// Directed. Who tells whom. Deliberately funnels through Sheila and dead-ends
// at the Previous Owner's empty house.
// ---------------------------------------------------------------------------

export const SOCIAL_GRAPH = {
  // The Frog speaks. The Frog does not repeat. Anything it starts enters the
  // street through the two people who cannot keep anything down.
  frog: ['marge', 'dwayne'],

  // The fast relays feed each other and, inevitably, the Hub.
  marge: ['dwayne', 'sheila', 'newlyweds'],
  dwayne: ['marge', 'sheila'],

  // The Hub. Everything that leaves here has been improved.
  sheila: ['colonel', 'newlyweds', 'marge', 'dwayne', 'previous'],

  // The Skeptic sits on things, then hands the sanded-down version to one person.
  colonel: ['sheila', 'previous'],

  // The Mirror sends it straight back where it came from, plus onward, in unison.
  newlyweds: ['sheila', 'marge', 'previous'],

  // Terminal. Absorbs. Never forwards. The story goes into that house and stops,
  // the way the last owner did.
  previous: [],
};

// Per-relay forwarding behaviour.
const RELAY_RULES = {
  [RELAY.HUB]:      { delay: 1, chance: 0.95, fanout: 3, corrupts: true },
  [RELAY.FAST]:     { delay: 1, chance: 0.90, fanout: 2, corrupts: false },
  [RELAY.SKEPTIC]:  { delay: 3, chance: 0.45, fanout: 1, corrupts: false, hedges: true },
  [RELAY.MIRROR]:   { delay: 1, chance: 0.80, fanout: 2, corrupts: false, mirrors: true },
  [RELAY.ORIGIN]:   { delay: 0, chance: 0.00, fanout: 0, corrupts: false },
  [RELAY.TERMINAL]: { delay: 0, chance: 0.00, fanout: 0, corrupts: false },
};

const RELAY_BY_ID = Object.fromEntries(NEIGHBOR_DEFS.map((d) => [d.id, d.relay]));

const BASE_LIFESPAN = 6;        // day-ticks a plain rumor survives
const CORRUPTION_LIFE_BONUS = 4; // each mutation makes it more repeatable, so it lives longer

// A story can only get so much worse before it stops being repeatable and starts
// being a police matter. Past this, Sheila just passes it on verbatim, appalled.
const MAX_CORRUPTIONS = 4;
// The street can only hold so many conversations at once.
const MAX_LIVE_RUMORS = 14;
// At most this many trailing clauses. Beyond that it reads as a shopping list.
const MAX_APPENDS = 2;

let _nextId = 1;

export class RumorEngine {
  /**
   * @param {() => number} rng   injected 0..1 generator
   * @param {Neighbor[]} neighbors  optional; if given, receive() is called on delivery
   */
  constructor(rng = Math.random, neighbors = null) {
    this.rng = rng;
    this.neighbors = neighbors;
    this.rumors = [];        // live rumors
    this.archive = [];       // decayed rumors, kept for the ending
    this.dayTick = 0;
    this.log = [];           // { tick, kind, rumorId, from, to, text }
  }

  attachNeighbors(neighbors) {
    this.neighbors = neighbors;
    return this;
  }

  _neighbor(id) {
    return this.neighbors ? this.neighbors.find((n) => n.id === id) : null;
  }

  // -------------------------------------------------------------------------
  // spawn
  // -------------------------------------------------------------------------

  /**
   * Start a rumor at a neighbor. It does not move on the tick it is born —
   * consequence is always at least a day behind the cause.
   */
  spawn(seedText, originNeighborId, meta = {}) {
    const r = {
      id: `r${_nextId++}`,
      seedText,
      text: seedText,
      originNeighborId,
      holders: new Set([originNeighborId]),
      ageTicks: 0,
      corruptions: 0,
      cause: meta.cause || 'unknown',
      bornTick: this.dayTick,
      _pending: new Map([[originNeighborId, this.dayTick]]), // holder -> tick acquired
      _parentId: meta.parentId || null,
      alive: true,
    };
    this.rumors.push(r);
    this.log.push({
      tick: this.dayTick, kind: 'spawn', rumorId: r.id,
      from: null, to: originNeighborId, text: r.text,
    });
    const n = this._neighbor(originNeighborId);
    if (n) n.receive(r);
    return r;
  }

  // -------------------------------------------------------------------------
  // tick — one day of the street talking
  // -------------------------------------------------------------------------

  tick() {
    this.dayTick += 1;
    const born = [];

    for (const r of this.rumors) {
      if (!r.alive) continue;
      r.ageTicks += 1;

      const currentHolders = [...r.holders];
      for (const holderId of currentHolders) {
        const relay = RELAY_BY_ID[holderId];
        const rule = RELAY_RULES[relay];
        if (!rule || rule.fanout === 0) continue;         // origin + terminal stop here

        const acquired = r._pending.get(holderId);
        if (acquired === undefined) continue;
        if (this.dayTick - acquired < rule.delay) continue; // not ready to talk yet
        if (this.rng() > rule.chance) continue;             // did not come up today

        const targets = (SOCIAL_GRAPH[holderId] || [])
          .filter((t) => !r.holders.has(t));

        // The Mirror also throws it back at whoever told them, even if they know.
        if (rule.mirrors) {
          const source = r._toldBy && r._toldBy[holderId];
          if (source && this.rng() < 0.5) targets.push(source);
        }

        if (targets.length === 0) continue;
        const chosen = shuffle(targets, this.rng).slice(0, rule.fanout);

        for (const targetId of chosen) {
          if (rule.corrupts && r.corruptions < MAX_CORRUPTIONS) {
            // SHEILA. The story that leaves her is not the story that arrived.
            // She tells the SAME improved version to everyone she tells today —
            // one fork per day, not one per listener, or the street would be
            // nothing but variants by Wednesday.
            if (!r._forkedOn || r._forkedOn !== this.dayTick) {
              const mutated = this._corrupt(r);
              r._todaysFork = this._fork(r, mutated, holderId, targetId);
              r._forkedOn = this.dayTick;
              born.push(r._todaysFork);
            } else {
              this._deliver(r._todaysFork, holderId, targetId);
            }
            // The improved version replaces the original in her mouth.
            r.holders.delete(holderId);
            r._pending.delete(holderId);
            break;
          } else {
            // Non-corrupting relays do not change the story, only how they say it.
            // The phrasing is recorded per-listener so it never accumulates.
            r._voice = r._voice || {};
            if (rule.hedges) r._voice[targetId] = pick(HEDGES, this.rng);
            else if (rule.mirrors && this.rng() < 0.5) r._voice[targetId] = pick(MIRROR_WRAPS, this.rng);
            this._deliver(r, holderId, targetId);
          }
        }
      }
    }

    for (const b of born) this.rumors.push(b);

    // Decay. Corrupted rumors are more fun to repeat, so they last longer,
    // and routinely outlive the boring true thing they came from.
    for (const r of this.rumors) {
      if (!r.alive) continue;
      const lifespan = BASE_LIFESPAN + r.corruptions * CORRUPTION_LIFE_BONUS;
      if (r.ageTicks > lifespan) {
        r.alive = false;
        this.log.push({
          tick: this.dayTick, kind: 'decay', rumorId: r.id,
          from: null, to: null, text: r.text,
        });
      }
    }
    // Crowding: only so much can be current at once. The dullest, tamest stories
    // are the ones that stop getting brought up.
    if (this.rumors.filter((r) => r.alive).length > MAX_LIVE_RUMORS) {
      const ranked = this.rumors
        .filter((r) => r.alive)
        .sort((a, b) => (b.corruptions - a.corruptions) || (b.bornTick - a.bornTick));
      for (const r of ranked.slice(MAX_LIVE_RUMORS)) r.alive = false;
    }

    const dead = this.rumors.filter((r) => !r.alive);
    this.archive.push(...dead);
    this.rumors = this.rumors.filter((r) => r.alive);

    return this.dayTick;
  }

  // -------------------------------------------------------------------------
  // corruption
  // -------------------------------------------------------------------------

  /** Sheila's pass. Escalate a rung, drift a noun, then contextualise. */
  _corrupt(r) {
    let text = stripLead(r.text);

    const climbed = escalate(text);
    if (climbed) text = climbed;

    if (this.rng() < 0.7) {
      const drifted = drift(text, this.rng);
      if (drifted) text = drifted;
    }

    // If nothing structural changed, she at least reframes it, which is worse.
    // One reframe only — she is insinuating, not filibustering.
    if (text === stripLead(r.text) || this.rng() < 0.6) {
      text = pick(REFRAMES, this.rng) + lowerFirst(text);
    }

    // Trailing clauses, capped and never repeated. Two is a rumor; five is a rant.
    const existing = APPENDS.filter((a) => text.includes(a));
    if (existing.length < MAX_APPENDS && this.rng() < 0.75) {
      const fresh = APPENDS.filter((a) => !text.includes(a));
      const add = pick(fresh, this.rng);
      if (add) text = text.replace(/[.]*$/, '') + add;
    }
    return text;
  }

  /** A corruption forks a new rumor. The original keeps walking, wrongly, elsewhere. */
  _fork(parent, text, fromId, toId) {
    const f = {
      id: `r${_nextId++}`,
      seedText: parent.seedText,
      text,
      originNeighborId: parent.originNeighborId,
      holders: new Set([fromId, toId]),
      ageTicks: 0,
      corruptions: parent.corruptions + 1,
      cause: parent.cause,
      bornTick: this.dayTick,
      _pending: new Map([[fromId, this.dayTick - 1], [toId, this.dayTick]]),
      _toldBy: { [toId]: fromId },
      _parentId: parent.id,
      alive: true,
    };
    this.log.push({
      tick: this.dayTick, kind: 'corrupt', rumorId: f.id,
      from: fromId, to: toId, text,
    });
    const n = this._neighbor(toId);
    if (n) n.receive(f);
    return f;
  }

  _deliver(r, fromId, toId) {
    r.holders.add(toId);
    r._pending.set(toId, this.dayTick);
    r._toldBy = r._toldBy || {};
    r._toldBy[toId] = fromId;
    this.log.push({
      tick: this.dayTick, kind: 'relay', rumorId: r.id,
      from: fromId, to: toId, text: r.text,
    });
    const n = this._neighbor(toId);
    if (n) n.receive(r);
  }

  // -------------------------------------------------------------------------
  // what the player actually hears
  // -------------------------------------------------------------------------

  /**
   * Overheard fragments while standing near a neighbour. Half a sentence, out of
   * context, cut off when they notice you. Never the whole rumor. Never attributed.
   */
  fragmentsNear(neighborId) {
    const audible = this.rumors.filter(
      (r) => r.holders.has(neighborId)
        || (SOCIAL_GRAPH[neighborId] || []).some((t) => r.holders.has(t)),
    );

    const out = [];
    for (const r of audible) {
      if (this.rng() < 0.35) continue; // you did not catch that one
      out.push(this._fragmentOf(r));
    }

    // The street is never actually quiet.
    if (out.length === 0 || this.rng() < 0.4) {
      out.push(pick(AMBIENT_FRAGMENTS, this.rng));
    }
    return out.slice(0, 3);
  }

  _fragmentOf(r) {
    const words = stripLead(r.text).split(' ');
    // Take a slice from the middle. Beginnings explain and endings resolve;
    // a fragment must do neither.
    const start = Math.min(
      words.length - 2,
      Math.floor(this.rng() * Math.max(1, words.length - 6)),
    );
    const len = 4 + Math.floor(this.rng() * 7);
    const slice = words.slice(Math.max(0, start), Math.max(2, start + len)).join(' ');
    return `${pick(FRAGMENT_LEADINS, this.rng)}${slice}${pick(FRAGMENT_TRAILS, this.rng)}`;
  }

  // -------------------------------------------------------------------------
  // introspection for other systems (never for the UI as numbers)
  // -------------------------------------------------------------------------

  /** How a particular neighbor phrases a rumor they are holding. */
  textFor(rumor, neighborId) {
    const lead = rumor._voice && rumor._voice[neighborId];
    return lead ? lead + lowerFirst(stripLead(rumor.text)) : rumor.text;
  }

  /** Live rumors a neighbor is currently holding. */
  heldBy(neighborId) {
    return this.rumors.filter((r) => r.holders.has(neighborId));
  }

  /** How badly the street currently thinks of you. Economy reads this. Never rendered. */
  pressure() {
    return this.rumors.reduce((sum, r) => sum + 1 + r.corruptions * 1.5, 0);
  }

  /** Everything the empty house has swallowed. The ending reads this. */
  absorbed() {
    return [...this.rumors, ...this.archive].filter((r) => r.holders.has('previous'));
  }

  /** Trace a corrupted rumor back through its forks to the thing you actually did. */
  lineage(rumorId) {
    const all = [...this.rumors, ...this.archive];
    const chain = [];
    let cur = all.find((r) => r.id === rumorId);
    while (cur) {
      chain.unshift(cur);
      cur = cur._parentId ? all.find((r) => r.id === cur._parentId) : null;
    }
    return chain;
  }
}

// --- helpers -------------------------------------------------------------

function shuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1)) % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function lowerFirst(s) {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** Remove a previously-applied reframe/hedge so they do not stack into mush. */
function stripLead(s) {
  const leads = [...REFRAMES, ...HEDGES, ...MIRROR_WRAPS];
  let out = s;
  let changed = true;
  while (changed) {
    changed = false;
    for (const lead of leads) {
      if (out.startsWith(lead)) { out = out.slice(lead.length); changed = true; break; }
      const lower = lead.charAt(0).toLowerCase() + lead.slice(1);
      if (out.startsWith(lower)) { out = out.slice(lower.length); changed = true; break; }
    }
  }
  return out;
}

// SELF-TEST:
//   const e = new RumorEngine(seededRng, allNeighbors());
//   e.spawn('there was screaming from the yard and then there was not', 'frog');
//   e.tick(); e.tick(); e.tick(); e.tick();
//   e.heldBy('sheila').length > 0        // it reached the Hub after several ticks, not one
//   e.heldBy('previous').forEach(r => SOCIAL_GRAPH.previous.length === 0)  // absorbed, never forwarded
//   Compare a forked rumor's .text to its .seedText: the text must have climbed a
//     ladder rung AND picked up a reframe or append.
//   e.fragmentsNear('marge') -> strings that start mid-clause and end in an ellipsis
//     or an interruption. None of them contain a digit.
