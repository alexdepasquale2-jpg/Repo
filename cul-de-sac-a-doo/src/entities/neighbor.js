// src/entities/neighbor.js
// The seven neighbors as live objects. Pure logic — no DOM, no canvas, no rendering.
//
// `opinion` is PRIVATE. It is a number. It must never reach the screen in any form,
// not as a bar, not as a face, not as a word like "friendly". The player learns what
// a neighbor thinks by what that neighbor says and what they pass along.

import { NEIGHBOR_DEFS, RELAY } from '../data/neighbors.js';
import { pick } from '../data/rumors.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Over-gifting window: gifts inside this many day-ticks all count as "lately".
const GIFT_WINDOW_TICKS = 4;
// Gifts within the window before it reads as buying somebody off.
const GIFT_SUSPICION_THRESHOLD = 3;

export class Neighbor {
  constructor(def, rng = Math.random) {
    this.id = def.id;
    this.name = def.name;
    this.title = def.title;
    this.def = def;
    this.relay = def.relay;
    this.vendorId = def.vendorId;
    this.waveIdentity = def.waveIdentity;

    // --- private state. never rendered. ---
    this.opinion = 0;          // -1 .. 1
    this.suspicion = 0;        //  0 .. 1  — "something is off about them"
    this.heard = [];           // rumor ids, most recent last
    this.giftLog = [];         // { tick, itemId, reaction }
    this.dayTick = 0;

    this._rng = rng;
    this._engine = null;       // optional RumorEngine, set by bindRumorEngine()
  }

  /** Optional: lets a neighbor spawn rumors directly (over-gifting, misfires). */
  bindRumorEngine(engine) {
    this._engine = engine;
    return this;
  }

  setTick(tick) {
    this.dayTick = tick;
  }

  // -------------------------------------------------------------------------
  // Rumors
  // -------------------------------------------------------------------------

  /**
   * Hear a rumor. Returns { accepted, believed, opinionDelta }.
   * Believing something bad about you costs opinion. The Colonel mostly does not believe.
   * The Previous Owner believes everything and tells no one.
   */
  receive(rumor) {
    if (!rumor) return { accepted: false, believed: false, opinionDelta: 0 };
    if (this.heard.includes(rumor.id)) {
      return { accepted: false, believed: false, opinionDelta: 0 };
    }
    this.heard.push(rumor.id);
    if (this.heard.length > 24) this.heard.shift();

    const severity = 0.05 + 0.06 * (rumor.corruptions || 0);
    let credulity;
    switch (this.relay) {
      case RELAY.SKEPTIC: credulity = 0.35; break;
      case RELAY.HUB: credulity = 1.0; break;
      case RELAY.FAST: credulity = 0.9; break;
      case RELAY.MIRROR: credulity = 1.2; break;   // they believe it twice, together
      case RELAY.TERMINAL: credulity = 1.0; break; // believes. says nothing. keeps it.
      case RELAY.ORIGIN: credulity = 0.0; break;   // the Frog already knows
      default: credulity = 0.7;
    }

    const delta = -severity * credulity;
    this.opinion = clamp(this.opinion + delta, -1, 1);
    this.suspicion = clamp(this.suspicion + severity * credulity * 0.8, 0, 1);
    return { accepted: true, believed: credulity > 0, opinionDelta: delta };
  }

  // -------------------------------------------------------------------------
  // Gifting
  // -------------------------------------------------------------------------

  /**
   * Give this neighbor an Item. Returns:
   *   { reaction: 'delighted'|'polite'|'misfire'|'refused'|'suspicious',
   *     line, opinionDelta, suspicious, spawnedRumor }
   *
   * There is NO feedback anywhere that says "you are gifting too much". The neighbor
   * smiles, takes it, and starts a rumor about you.
   */
  reactToGift(item) {
    if (!item) return this._giftResult('refused', '', 0, false, null);

    const def = this.def;
    const tags = itemTags(item);
    const rarity = item.rarity ?? 0;

    // The Frog and the Previous Owner do not take gifts at all.
    if (def.giftSensitivity <= 0.05) {
      return this._giftResult('refused', pick(def.voice.giftBad, this._rng), 0, false, null);
    }

    const likesKind = def.likes.kinds.includes(item.kind);
    const hatesKind = def.hates.kinds.includes(item.kind);
    const likedTag = tags.some((t) => def.likes.tags.includes(t));
    const hatedTag = tags.some((t) => def.hates.tags.includes(t));
    const rarityOk = rarity >= (def.likes.rarityFloor ?? 0);

    // Their own stolen relic handed back to them is the worst gift in the game.
    const boomerang = item.neighborId && item.neighborId === this.id && item.kind === 'relic';

    let score = 0;
    if (likesKind) score += 0.10;
    if (likedTag) score += 0.08;
    if (rarityOk) score += 0.06;
    if (hatesKind) score -= 0.14;
    if (hatedTag) score -= 0.10;
    if (boomerang) score -= 0.30;

    score *= def.giftSensitivity;

    // --- over-gifting: the tell ---
    this.giftLog.push({ tick: this.dayTick, itemId: item.id });
    const recent = this.giftLog.filter((g) => this.dayTick - g.tick <= GIFT_WINDOW_TICKS);
    const overGifting = recent.length >= GIFT_SUSPICION_THRESHOLD;

    let reaction;
    let line;
    if (boomerang || score <= -0.05) {
      reaction = 'misfire';
      line = pick(def.voice.giftBad, this._rng);
    } else if (score >= 0.12) {
      reaction = 'delighted';
      line = pick(def.voice.giftGood, this._rng);
    } else {
      reaction = 'polite';
      line = pick(def.voice.giftGood, this._rng);
    }

    let spawnedRumor = null;
    if (overGifting) {
      // Opinion still ticks up. It always ticks up. That is the trap.
      this.suspicion = clamp(
        this.suspicion + 0.12 * (def.suspicionSensitivity || 1),
        0, 1,
      );
      // The line they say is warmer, not colder.
      line = pick(def.voice.giftSuspicious, this._rng) || line;
      reaction = 'suspicious';
      spawnedRumor = {
        seedText: 'the new one has been handing out presents to absolutely everybody',
        originNeighborId: this.id,
      };
      if (this._engine) {
        this._engine.spawn(spawnedRumor.seedText, this.id, { cause: 'over-gifting' });
      }
    }

    // Misfires travel too.
    if (reaction === 'misfire' && this._engine && this.relay !== RELAY.TERMINAL) {
      this._engine.spawn(
        boomerang
          ? 'the new one gave me back something of mine that I did not know was gone'
          : 'the new one brought me something and would not say where it came from',
        this.id,
        { cause: 'gift-misfire' },
      );
    }

    this.opinion = clamp(this.opinion + score, -1, 1);
    return this._giftResult(reaction, line, score, overGifting, spawnedRumor);
  }

  _giftResult(reaction, line, opinionDelta, suspicious, spawnedRumor) {
    return { reaction, line, opinionDelta, suspicious, spawnedRumor };
  }

  // -------------------------------------------------------------------------
  // Voice
  // -------------------------------------------------------------------------

  greet() {
    return pick(this.def.voice.greet, this._rng);
  }

  shopLine() {
    return pick(this.def.voice.shop, this._rng);
  }

  /** Private read for other systems (economy, vendors). Never for the UI. */
  standing() {
    return this.opinion - this.suspicion * 0.5;
  }
}

let _cache = null;

/** The seven, in contract order. Cached so every system shares the same objects. */
export function allNeighbors(rng = Math.random) {
  if (!_cache) _cache = NEIGHBOR_DEFS.map((d) => new Neighbor(d, rng));
  return _cache;
}

export function resetNeighbors(rng = Math.random) {
  _cache = NEIGHBOR_DEFS.map((d) => new Neighbor(d, rng));
  return _cache;
}

export function neighborById(id, rng = Math.random) {
  return allNeighbors(rng).find((n) => n.id === id) || null;
}

function itemTags(item) {
  if (Array.isArray(item.tags)) return item.tags;
  // Fall back to inferring from the name so B's loot works without coordination.
  const n = (item.name || '').toLowerCase();
  const out = [];
  if (/rose|petunia|bloom|flower|hydrangea/.test(n)) out.push('floral');
  if (/rusted|iron|pipe|wrench|rebar|shear/.test(n)) out.push('metal');
  if (/dug|unearthed|grave|buried|soil/.test(n)) out.push('buried', 'dug-up');
  if (/damp|wet|soaked|sprinkler/.test(n)) out.push('wet');
  if (/label|receipt|form|notice|minutes/.test(n)) out.push('documented', 'tidy');
  if (/heirloom|antique|old|widow/.test(n)) out.push('old');
  return out;
}

// SELF-TEST:
//   const ns = resetNeighbors(() => 0.5); ns.length === 7
//   const sheila = ns[0];
//   sheila.reactToGift({id:'a', kind:'produce', rarity:2, name:'Prize Hydrangea'})
//     -> reaction 'delighted' or 'polite', opinionDelta > 0
//   Gift her three items inside four day-ticks -> reaction 'suspicious',
//     spawnedRumor is non-null, AND opinionDelta is still positive (no warning to player).
//   colonel.receive(rumorWithCorruptions3) moves opinion far less than sheila.receive() does.
//   previous.reactToGift(anything) -> 'refused', opinionDelta 0.
