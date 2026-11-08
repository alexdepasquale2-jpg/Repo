/* Essence Protocol: shared essence definitions and the merge-key grammar.
   The content (essences, reactions, resonances, trinities, anomalies, classes, effect names)
   lives in data/*.json; this module builds the tables the game and the baker use from it.
   Browser: global ESSENCE built from self.EP_DATA (js/data.js). Node: built from data/.
   ESSENCE.make(data) builds a fresh copy from other data (the content editor previews edits
   this way). Nothing in here is random. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../data').data);
  else root.ESSENCE = factory(root.EP_DATA);
})(typeof self !== 'undefined' ? self : this, function make(data) {
  'use strict';
  if (!data || !data.essences) throw new Error('essence data is missing: load js/data.js (browser) or data/ (Node) first');

  // Trait axes every essence pushes on. The baker reads the resulting vector
  // to decide what a merge *is*.
  //  pow force · grd guard · mnd mend · spd speed · prc precision
  //  hex status · drn drain · spr spread · per persistence · cha chaos
  const TRAITS = ['pow', 'grd', 'mnd', 'spd', 'prc', 'hex', 'drn', 'spr', 'per', 'cha'];
  // base stats, in record order: hp, logic (attack), firewall (defense), clock (speed), flux, coherence
  const STAT_KEYS = ['hp', 'atk', 'def', 'spd', 'flux', 'coh'];
  const fxPairs = list => (list || []).map(f => [f.effect, f.chance]);

  const MAINS = data.essences.mains.map(m => m.code);
  const MAIN = {}, BEATS = {};
  for (const m of data.essences.mains) {
    MAIN[m.code] = { code: m.code, name: m.name, color: m.color, deep: m.deep, light: m.light, traits: m.traits, base: STAT_KEYS.map(k => m.base[k]) };
    BEATS[m.code] = m.beats;
  }

  // Combat cycle: each main beats one other (Water quenches Fire, Fire consumes Air, Air erodes
  // Earth, Earth dams Water). Opposites (Fire/Water, Earth/Air) are volatile when merged.
  function chart(att, def) {
    if (BEATS[att] === def) return 1.5;
    if (BEATS[def] === att) return 0.67;
    if (att === def) return 0.8;
    return 1;
  }

  // What two mains become when merged. names[x] is the name when x leads.
  const REACTION = {};
  for (const [pid, r] of Object.entries(data.essences.reactions)) {
    const o = { names: r.names };
    if (r.volatile) o.volatile = true;
    Object.assign(o, { traits: r.traits, fx: fxPairs(r.effects), line: r.line });
    REACTION[pid] = o;
  }
  function pairId(a, b) { return MAINS.indexOf(a) <= MAINS.indexOf(b) ? a + b : b + a; }
  // A main's opposite: the one it forms a volatile reaction with (Fire/Water, Earth/Air).
  const OPPOSITE = {};
  for (const a of MAINS) { const o = MAINS.find(b => b !== a && REACTION[pairId(a, b)] && REACTION[pairId(a, b)].volatile); if (o) OPPOSITE[a] = o; }

  // Sub-essences. host = the only main they can attach to, or null for universal subs that can
  // attach to either main. Universal subs take on a facet of whichever main they are bound to.
  const SUB_ORDER = data.essences.subs.map(s => s.code);
  const SUB = {}, FACET = {};
  for (const s of data.essences.subs) {
    SUB[s.code] = { name: s.name, host: s.host, traits: s.traits, fx: s.effect, adj: s.adjectives, desc: s.desc };
    if (!s.host) { FACET[s.code] = {}; for (const m of MAINS) { const f = s.facets[m]; FACET[s.code][m] = { name: f.name, traits: f.traits, fx: f.effect }; } }
  }

  // Two subs that meet in the same merge (on any host) resonate; three specific subs together
  // form a Trinity, the rarest named merges.
  const combo = r => ({ id: r.id, name: r.name, subs: r.subs, traits: r.traits, fx: fxPairs(r.effects) });
  const RESONANCE = data.combos.resonances.map(combo);
  const TRINITY = data.combos.trinities.map(combo);

  // Glitches in the merge lattice: a small, fixed set of keys (chosen by hash) bake into
  // something that breaks the usual rules. Each kind is a battle effect in engine.js.
  const ANOMALY = {};
  for (const a of data.combos.anomalies) ANOMALY[a.id] = a.desc;

  const CLASSES = {};
  for (const c of data.battle.classes) CLASSES[c.id] = c.desc;

  const EFFECTS = {};
  for (const f of data.battle.effects) EFFECTS[f.code] = f.name;
  // Effects that act on the caster (a rule of the battle engine, not content).
  const SELF_FX = new Set(['heal', 'cleanse', 'shield', 'guard', 'overclock', 'haste', 'focus', 'veil', 'regen', 'mirror', 'rewind', 'phase', 'overwrite']);

  // ---- Merge-key grammar -------------------------------------------------
  // "FW"            Fire leads, Water follows, no subs
  // "FW-Em1Li2"     + Ember on Fire, Light on Water
  // "FF-Pl1"        pure Fire merge (host is always 1)
  const MAX_SUBS = 3;

  function eligible(sub, main) { const h = SUB[sub].host; return !h || h === main; }
  function tokCmp(x, y) { return (SUB_ORDER.indexOf(x.s) - SUB_ORDER.indexOf(y.s)) || (x.h - y.h); }

  function makeKey(a, b, subs) {
    const seen = new Set();
    const list = [];
    for (const t of subs || []) {
      const h = a === b ? 1 : t.h;
      const id = t.s + h;
      if (!seen.has(id)) { seen.add(id); list.push({ s: t.s, h }); }
    }
    list.sort(tokCmp);
    return a + b + (list.length ? '-' + list.map(t => t.s + t.h).join('') : '');
  }

  function parseKey(key) {
    const a = key[0], b = key[1];
    const subs = [];
    const rest = key.indexOf('-') > 0 ? key.slice(3) : '';
    for (let i = 0; i < rest.length; i += 3) subs.push({ s: rest.slice(i, i + 2), h: +rest[i + 2] });
    return { a, b, subs };
  }

  function hostMain(p, h) { return h === 1 ? p.a : p.b; }

  function validKey(key) {
    if (typeof key !== 'string' || key.length < 2) return false;
    const p = parseKey(key);
    if (!MAIN[p.a] || !MAIN[p.b] || p.subs.length > MAX_SUBS) return false;
    for (const t of p.subs) {
      if (!SUB[t.s] || (t.h !== 1 && t.h !== 2)) return false;
      if (p.a === p.b && t.h !== 1) return false;
      if (!eligible(t.s, hostMain(p, t.h))) return false;
    }
    return makeKey(p.a, p.b, p.subs) === key;
  }

  // Every (sub, host) slot legal for a pair of mains.
  function slotsFor(a, b) {
    const slots = [];
    for (const s of SUB_ORDER) {
      if (eligible(s, a)) slots.push({ s, h: 1 });
      if (a !== b && eligible(s, b)) slots.push({ s, h: 2 });
    }
    return slots;
  }

  function combos(arr, k, start, cur, out) {
    if (cur.length === k) { out.push(cur.slice()); return; }
    for (let i = start; i < arr.length; i++) { cur.push(arr[i]); combos(arr, k, i + 1, cur, out); cur.pop(); }
  }

  // Keys composable from a set of mains and attuned subs, up to `width` subs.
  function composable(mains, attuned, width) {
    const out = [];
    const ms = Array.from(new Set(mains));
    const att = new Set(attuned);
    for (const a of ms) for (const b of ms) {
      const slots = slotsFor(a, b).filter(t => att.has(t.s));
      for (let k = 0; k <= Math.min(width, MAX_SUBS); k++) {
        const cs = []; combos(slots, k, 0, [], cs);
        for (const c of cs) out.push(makeKey(a, b, c));
      }
    }
    return out;
  }

  function enumerateAll() { return composable(MAINS, SUB_ORDER, MAX_SUBS); }

  function subsPresent(p) { return new Set(p.subs.map(t => t.s)); }

  return {
    data, make, STAT_KEYS,
    TRAITS, MAINS, MAIN, BEATS, OPPOSITE, chart, REACTION, pairId,
    SUB_ORDER, SUB, FACET, RESONANCE, TRINITY, ANOMALY, CLASSES, EFFECTS, SELF_FX,
    MAX_SUBS, eligible, makeKey, parseKey, validKey, hostMain, slotsFor, composable, enumerateAll, subsPresent,
  };
});
