/* Essence Protocol: designs. Everything that used to be live-baked by an AI model
 * (FriedrichBridge, now retired) comes from here instead, with no network and no model.
 *
 *   per merge      technique, form, forged item, lineage word, trait affinity:
 *                  pre-baked by tools/bake.js into the merge database (db/), one merge at a time
 *   per splice     lineage(pair, rec): a pure function of the two parent genomes' records
 *   per daemon     trait(genome, seed, info, rec): a pure function of the genome's record and its seed
 *
 * Splices (17 million genome pairs) and individual daemons (a 32-bit seed each) can't be
 * enumerated, so their designs are computed from the pre-baked records they are made of.
 * Seeds and the %RARITY% modulator keep the exact formulas of the bridge era, so rolls in
 * existing saves stay the same. Loaded by the game (global DESIGNS) and by tools/bake.js.
 * The words and numbers (traits, item types, lineage names) come from data/ through E.data;
 * DESIGNS.make(E) builds a copy for other data. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./essences.js'));
  else root.DESIGNS = factory(root.ESSENCE);
})(typeof self !== 'undefined' ? self : this, function make(E) {
  'use strict';
  const data = E.data;

  const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;

  // ---- seeds and the %RARITY% modulator ----
  const RARITY_NAMES = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
  const RARITY_CUTS = [40, 15, 5, 1]; // a roll at or below 40% is uncommon, 15% rare, 5% epic, 1% legendary
  function hash32(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
  const seedOf = str => hash32('ep|' + str).toString(16).padStart(8, '0');
  // Stable word picks (rendezvous hashing): every word in a list gets a score from the seed, and
  // the highest score wins. Adding a word only moves the picks where the new word scores highest,
  // removing one only moves the picks that had it, and the order of a list doesn't matter.
  function mix32(h) { h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return h >>> 0; }
  const wordScore = (seed, w) => mix32(hash32(seed + '|' + w));
  function stableRank(list, seed) {
    return list.map(w => [w, wordScore(seed, w)]).sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)).map(x => x[0]);
  }
  function stablePick(list, seed) {
    let best = list[0], top = -1;
    for (const w of list) { const sc = wordScore(seed, w); if (sc > top || (sc === top && w < best)) { top = sc; best = w; } }
    return best;
  }
  const unit = (seed, salt) => (hash32(seed + '|' + salt) + 0.5) / 4294967296;
  // `boost` (0 to 0.9) is how strongly the makeup favors rare outcomes; `pct` is the share of
  // designs at least this rare, so lower is rarer (2.7% is about 1 in 37).
  function modulate(seed, boost) {
    const b = clampN(boost || 0, 0, 0.9);
    const pct = Math.max(0.01, Math.round(unit(seed, 'rarity') * 10000 * (1 - 0.75 * b)) / 100);
    let tier = 0;
    while (tier < 4 && pct <= RARITY_CUTS[tier]) tier++;
    return { seed, boost: Math.round(b * 100) / 100, pct, tier, rarity: RARITY_NAMES[tier], odds: Math.max(1, Math.round(100 / pct)) };
  }
  // kind: [name, what it is]
  const ITEM_TYPES = {};
  for (const k of data.items.kinds) ITEM_TYPES[k.kind] = [k.name, k.desc];
  const itemType = kind => (typeof kind === 'string' && kind.startsWith('item.') && ITEM_TYPES[kind.slice(5)] ? kind.slice(5) : null);
  // info: items use the baked rarity (0-4); traits use generation, parents' trait tier and prism.
  function modFor(kind, key, info) {
    info = info || {};
    if (kind === 'breed') {
      const [x, y] = key.split('~');
      return modulate(seedOf('breed:' + key), 0.06 * (E.parseKey(x).subs.length + E.parseKey(y).subs.length));
    }
    if (kind === 'trait') {
      const [k, seed] = key.split('@');
      return modulate(seed, 0.08 * E.parseKey(k).subs.length + 0.1 * Math.min(3, info.gen || 0) + 0.06 * (info.parentTier || 0) + (info.prism ? 0.2 : 0));
    }
    const p = E.parseKey(key), n = p.subs.length;
    let boost = 0.12 * n;
    if (itemType(kind)) boost = 0.08 * n + 0.06 * (info.rarity || 0);
    return modulate(seedOf(kind + ':' + key), boost);
  }
  // The item a merge forges into, decided by its class.
  function itemKind(cls, nSubs) {
    return { Mend: 'patch', Ward: 'ward', Hex: 'lattice', Field: 'catalyst' }[cls] || (nSubs ? 'script' : 'cell');
  }

  // ---- traits ----
  // code: [category, name nouns, magnitude by rarity tier]. Utility magnitudes are percents
  // (mender: % HP every 25 steps); pulse is % party HP, warp its own cooldown in steps, repel
  // steps without wild encounters, hasten kernel steps, transmute motes in per mote out.
  const TRAITS = {}, EPITHET = {}, DOES = {}, EFFECT_TEXT = {}, ACTIVE_CD = {}, PASSIVE_STAT = {};
  for (const t of data.traits.traits) {
    TRAITS[t.code] = [t.category, t.nouns, t.magnitude];
    EPITHET[t.code] = t.epithet; DOES[t.code] = t.does; EFFECT_TEXT[t.code] = t.effect;
    if (t.cooldown != null) ACTIVE_CD[t.code] = t.cooldown; // steps (warp's magnitude is its cooldown)
    if (t.stat) PASSIVE_STAT[t.code] = t.stat;
  }
  const TRAIT_SCOPE = [1, 1, 2, 2, 3]; // trait effects by rarity tier
  // How each trait axis of a merge, and each essence in it, leans toward trait codes (used by the
  // baker for `aff`).
  const AXIS_AFF = data.traits.axisLean;
  const ESS_AFF = {}, MAIN_ADJ = {};
  for (const m of data.essences.mains) { ESS_AFF[m.code] = m.traitLean || {}; MAIN_ADJ[m.code] = m.traitNameAdjectives; }
  for (const x of data.essences.subs) ESS_AFF[x.code] = x.traitLean || {};
  // Baker: the four trait codes a genome leans toward, as [code, weight 1-99], strongest first.
  function affinity(T, key) {
    const p = E.parseKey(key), w = {};
    const add = (o, m) => { for (const c in o) w[c] = (w[c] || 0) + o[c] * m; };
    for (const ax in AXIS_AFF) add(AXIS_AFF[ax], Math.max(0, T[ax] || 0));
    add(ESS_AFF[p.a], 1.5); if (p.b !== p.a) add(ESS_AFF[p.b], 0.8);
    for (const t of p.subs) add(ESS_AFF[t.s], t.h === 1 ? 1.2 : 0.8);
    const list = Object.keys(w).sort((x, y) => w[y] - w[x] || (x < y ? -1 : 1)).slice(0, 4);
    const top = w[list[0]] || 1;
    return list.map(c => [c, clampN(Math.round(w[c] / top * 99), 1, 99)]);
  }
  // Trait effects from ranked codes, with the magnitude rules of the bridge era.
  function traitEffects(codes, weight, tier) {
    const W = codes.reduce((s, c) => s + weight[c], 0);
    const fx = codes.map(c => {
      const t = TRAITS[c];
      const f = codes.length === 1 ? 1 : clampN(0.25 + weight[c] / W * codes.length * 0.5, 0.4, 1);
      let mag = t[2][tier];
      if (c === 'warp') mag = Math.round(mag / f / 10) * 10; // sharing the trait makes the cooldown longer
      else if (c === 'transmute') mag = Math.max(2, Math.round(mag / f));
      else mag = Math.max(1, Math.round(mag * f));
      return { code: c, cat: t[0], mag };
    });
    const stats = {};
    for (const f of fx) if (f.cat === 'passive') stats[PASSIVE_STAT[f.code]] = f.mag;
    return { fx, stats };
  }
  function genomeAdj(key, seed) {
    const p = E.parseKey(key), lead = p.subs.find(t => t.h === 1) || p.subs[0];
    const list = lead ? E.SUB[lead.s].adj : MAIN_ADJ[p.a];
    return stablePick(list, seed + '|adj');
  }
  const traitKey = (genome, seed) => genome + '@' + seed;
  // One individual daemon's trait. info: { gen, parentTier, prism, ancestry: [{ name, codes }] }.
  // Ancestors' codes carry on when they fit; the rest comes from the genome's pre-baked affinity.
  function trait(genome, seed, info, rec) {
    info = info || {};
    const tkey = traitKey(genome, seed), mod = modFor('trait', tkey, info), tier = mod.tier, n = TRAIT_SCOPE[tier];
    const r = rec(genome), weight = {};
    for (const [c, v] of r.aff) weight[c] = v * (0.55 + unit(seed, c)); // the seed shuffles the genome's leanings
    (info.ancestry || []).slice(0, 3).forEach((a, i) => (a.codes || []).forEach((c, j) => { if (TRAITS[c]) weight[c] = (weight[c] || 0) + Math.max(10, 45 - i * 12 - j * 8); }));
    let codes = Object.keys(weight).sort((x, y) => weight[y] - weight[x] || (x < y ? -1 : 1)).slice(0, n);
    if (!codes.length) { const all = Object.keys(TRAITS); codes = [all[hash32(seed + '|trait') % all.length]]; weight[codes[0]] = 1; }
    const { fx, stats } = traitEffects(codes, weight, tier);
    const nouns = TRAITS[codes[0]][1], adj = genomeAdj(genome, seed);
    let name = `${adj} ${stablePick(nouns, seed + '|noun')}`;
    if (codes.length === 2) name += ` of ${EPITHET[codes[1]]}`;
    else if (codes.length === 3) name += ` of ${EPITHET[codes[1]]} and ${EPITHET[codes[2]]}`;
    const who = r.dName || 'This daemon';
    let desc = `${who} ${DOES[codes[0]]}`;
    if (codes[1]) desc += `, and ${DOES[codes[1]].replace(/^can /, 'it can ')}`;
    if (codes[2]) desc += `; it also ${DOES[codes[2]].replace(/^can /, 'can ')}`;
    desc += '.';
    const anc = (info.ancestry || [])[0];
    if (anc && anc.codes && anc.codes.some(c => codes.includes(c))) desc += ` It carries on ${anc.name}.`;
    return { key: tkey, name: name.slice(0, 48), desc: desc.slice(0, 400), tier, rarity: RARITY_NAMES[tier], pct: mod.pct, odds: mod.odds, fx, stats };
  }
  // What a trait effect does, from its text in data/traits.json ({m} magnitude, {cd} cooldown).
  function describeTrait(f) {
    const t = EFFECT_TEXT[f.code];
    return t ? t.replace(/\{m\}/g, f.mag).replace(/\{cd\}/g, ACTIVE_CD[f.code]) : '';
  }

  // ---- splicing ----
  const PEDIGREE = [4, 6, 8, 11, 15]; // total % stat bonus by lineage rarity
  const INHERIT = [1, 1, 2, 2, 3]; // sub-essences inherited as attunements by lineage rarity
  const LINE_NOUN = data.traits.lineage.nouns;
  const STAT_KEYS = ['hp', 'atk', 'def', 'spd', 'flux', 'coh'];
  const STAT_WORD = data.traits.lineage.statWords;
  const breedKey = (x, y) => [x, y].sort().join('~');
  // What a pair of parents can pass on, in the lattice's order of preference.
  function spliceOptions(pair) {
    const [x, y] = pair.split('~');
    const ps = hash32('lead|' + pair) & 1 ? [E.parseKey(y), E.parseKey(x)] : [E.parseKey(x), E.parseKey(y)];
    const mains = [...new Set([ps[0].a, ps[1].a, ps[0].b, ps[1].b])];
    const subs = [];
    for (let i = 0; i < 3; i++) for (const q of ps) if (q.subs[i] && !subs.includes(q.subs[i].s)) subs.push(q.subs[i].s);
    return { mains, subs };
  }
  // The lineage two genomes splice into: the dominant main essence leads the offspring's Seed
  // genome, sub-essences carry on as attunements, and the parents' strongest stats become a
  // pedigree. Symmetric in the parents and deterministic.
  function lineage(pair, rec) {
    const [x, y] = pair.split('~'), mod = modFor('breed', pair), tier = mod.tier, seed = mod.seed;
    const o = spliceOptions(pair), weight = {};
    for (const k of [x, y]) { const p = E.parseKey(k); weight[p.a] = (weight[p.a] || 0) + (p.a === p.b ? 1 : 0.65); if (p.b !== p.a) weight[p.b] = (weight[p.b] || 0) + 0.35; }
    const mains = o.mains.slice().sort((a, b) => weight[b] - weight[a] || unit(seed, b) - unit(seed, a));
    const lead = mains[0], follow = mains[1] || lead;
    const fits = s => E.eligible(s, lead) || E.eligible(s, follow);
    const attune = o.subs.filter(fits).slice(0, INHERIT[tier]);
    const rx = rec(x), ry = rec(y), sum = STAT_KEYS.map((_, i) => rx.dStats[i] + ry.dStats[i]);
    const mean = sum.reduce((s, v) => s + v, 0) / sum.length;
    const w = sum.map(v => Math.pow(Math.max(0, v - mean), 1.5));
    const order = STAT_KEYS.map((k, i) => i).sort((a, b) => w[b] - w[a] || a - b).slice(0, 3).filter(i => w[i] > 0);
    const W = order.reduce((s, i) => s + w[i], 0), total = PEDIGREE[tier], pedigree = {};
    for (const i of order) { const v = Math.min(15, Math.round(total * w[i] / W)); if (v > 0) pedigree[STAT_KEYS[i]] = v; }
    if (!Object.keys(pedigree).length) Object.assign(pedigree, { hp: Math.ceil(total / 2), coh: Math.floor(total / 2) });
    const a = rx.line, b = ry.line, noun = LINE_NOUN[tier];
    const f = hash32(seed + '|fmt') % 3;
    const name = a === b ? `${a} ${noun}` : f === 0 ? `${a}${b.toLowerCase()} ${noun}` : f === 1 ? `${a}-${b} ${noun}` : `${noun} of ${a} and ${b}`;
    const best = Object.keys(pedigree).sort((p, q) => pedigree[q] - pedigree[p]).map(k => STAT_WORD[k]);
    const desc = `Offspring boot ${E.MAIN[lead].name}-led${follow !== lead ? ` with ${E.MAIN[follow].name} behind` : ''}` +
      `${attune.length ? `, carrying ${attune.map(s => E.SUB[s].name).join(' and ')} forward` : ''}. The line is known for ${best.join(' and ')}.`;
    return { key: E.makeKey(lead, follow, []), lead, follow, attune, pedigree, tier, rarity: RARITY_NAMES[tier], pct: mod.pct, odds: mod.odds, name: name.slice(0, 48), desc };
  }

  return {
    make, hash32, seedOf, stableRank, stablePick, unit, modulate, modFor, RARITY_NAMES, ITEM_TYPES, itemType, itemKind,
    TRAITS, TRAIT_SCOPE, ACTIVE_CD, affinity, traitEffects, traitKey, trait, describeTrait,
    PEDIGREE, INHERIT, breedKey, spliceOptions, lineage,
  };
});
