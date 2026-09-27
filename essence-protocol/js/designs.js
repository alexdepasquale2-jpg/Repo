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
 * existing saves stay the same. Loaded by the game (global DESIGNS) and by tools/bake.js. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./essences.js'));
  else root.DESIGNS = factory(root.ESSENCE);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;

  // ---- seeds and the %RARITY% modulator ----
  const RARITY_NAMES = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
  const RARITY_CUTS = [40, 15, 5, 1]; // a roll at or below 40% is uncommon, 15% rare, 5% epic, 1% legendary
  function hash32(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
  const seedOf = str => hash32('ep|' + str).toString(16).padStart(8, '0');
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
  const ITEM_TYPES = {
    patch: ['Patch', 'a consumable that restores a daemon\'s HP'],
    ward: ['Module', 'a battle item that raises a shield'],
    lattice: ['Lattice', 'a lattice for binding wild daemons'],
    catalyst: ['Catalyst', 'a battle item that floods the arena with an essence field'],
    script: ['Script', 'a script that attunes a daemon to a new sub-essence'],
    cell: ['Flux Cell', 'a battle item that refills Flux'],
  };
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
  // code: [category, name nouns, magnitude by rarity tier]
  const TRAITS = {
    forage: ['utility', ['Gleaner', 'Scavenger', 'Magpie'], [10, 15, 22, 30, 40]],
    tutor: ['utility', ['Mentor', 'Sage', 'Tutor'], [5, 8, 12, 16, 22]],
    binder: ['utility', ['Tether', 'Snare', 'Binder'], [5, 8, 12, 16, 22]],
    smith: ['utility', ['Anvil', 'Forgehand', 'Temper'], [8, 12, 18, 25, 35]],
    nurture: ['utility', ['Cradle', 'Hearth', 'Brood'], [10, 15, 22, 30, 40]],
    mender: ['utility', ['Medic', 'Salve', 'Mender'], [2, 3, 4, 6, 8]], // % HP every 25 steps
    fortune: ['utility', ['Omen', 'Charm', 'Fortune'], [20, 35, 50, 75, 100]],
    archive: ['utility', ['Archivist', 'Ledger', 'Scholar'], [10, 15, 22, 30, 40]],
    lure: ['utility', ['Beacon', 'Siren', 'Lure'], [10, 15, 20, 25, 30]],
    shroud: ['utility', ['Shroud', 'Hush', 'Shade'], [10, 15, 20, 25, 30]],
    logic: ['passive', ['Fury', 'Might', 'Edge'], [4, 6, 8, 11, 15]],
    firewall: ['passive', ['Bulwark', 'Aegis', 'Rampart'], [4, 6, 8, 11, 15]],
    clock: ['passive', ['Sprint', 'Quickstep', 'Dash'], [4, 6, 8, 11, 15]],
    vitality: ['passive', ['Vigor', 'Heart', 'Lifeline'], [4, 6, 8, 11, 15]],
    capacity: ['passive', ['Reservoir', 'Battery', 'Wellspring'], [4, 6, 8, 11, 15]],
    coherence: ['passive', ['Focus', 'Clarity', 'Resolve'], [4, 6, 8, 11, 15]],
    pulse: ['active', ['Pulse', 'Rally', 'Heartbeat'], [20, 30, 40, 55, 75]], // % party HP
    warp: ['active', ['Homing', 'Recall', 'Waypoint'], [400, 320, 250, 180, 120]], // its own cooldown in steps
    repel: ['active', ['Deterrent', 'Ward', 'Hiss'], [30, 45, 60, 80, 110]], // steps without wild encounters
    hasten: ['active', ['Quickening', 'Spur', 'Catalyst'], [10, 15, 22, 30, 45]], // kernel steps
    transmute: ['active', ['Alchemy', 'Crucible', 'Refinery'], [5, 4, 4, 3, 2]], // motes in per mote out
  };
  const EPITHET = { forage: 'Plenty', tutor: 'Lessons', binder: 'Tethers', smith: 'the Anvil', nurture: 'the Hearth', mender: 'Mending', fortune: 'Omens', archive: 'Records', lure: 'the Call', shroud: 'Silence',
    logic: 'Force', firewall: 'the Wall', clock: 'Haste', vitality: 'Vigor', capacity: 'Reserves', coherence: 'Focus', pulse: 'the Pulse', warp: 'Return', repel: 'Warding', hasten: 'Quickening', transmute: 'Change' };
  const DOES = { forage: 'turns up extra motes after every fight', tutor: 'teaches the whole party as it fights', binder: 'steadies the lattice when you bind', smith: 'has a knack for the forge',
    nurture: 'keeps kernels warm while they compile', mender: 'patches the party up on the road', fortune: 'draws prismatic daemons out of the static', archive: 'files away a mote from every new merge',
    lure: 'calls wild daemons out of the static', shroud: 'keeps the party hidden in the static', logic: 'hits harder than its form suggests', firewall: 'shrugs off hits other forms would feel',
    clock: 'runs a few cycles faster than its kin', vitality: 'carries more HP than its kin', capacity: 'holds more Flux than its kin', coherence: 'keeps unstable merges together',
    pulse: 'can pulse restoring light over the party', warp: 'can pull the party back to the last terminal', repel: 'can drive wild daemons away for a while', hasten: 'can hurry kernels along', transmute: 'can refine motes into its own essence' };
  const TRAIT_SCOPE = [1, 1, 2, 2, 3]; // trait effects by rarity tier
  const ACTIVE_CD = { pulse: 150, repel: 200, hasten: 180, transmute: 60 }; // steps (warp's magnitude is its cooldown)
  const PASSIVE_STAT = { logic: 'atk', firewall: 'def', clock: 'spd', vitality: 'hp', capacity: 'flux', coherence: 'coh' };
  // How each trait axis of a merge leans toward trait codes (used by the baker for `aff`).
  const AXIS_AFF = {
    pow: { logic: 1, hasten: 0.3 }, grd: { firewall: 1, shroud: 0.5, vitality: 0.3 }, mnd: { mender: 1, pulse: 0.7, vitality: 0.5 },
    spd: { clock: 1, warp: 0.5, lure: 0.3 }, prc: { coherence: 0.8, binder: 0.6, archive: 0.5 }, hex: { binder: 0.8, repel: 0.6, shroud: 0.4 },
    drn: { forage: 0.8, transmute: 0.6, capacity: 0.3 }, spr: { lure: 0.6, forage: 0.5, capacity: 0.5 }, per: { nurture: 0.8, tutor: 0.6, vitality: 0.4 },
    cha: { fortune: 0.8, transmute: 0.5, warp: 0.4 },
  };
  const ESS_AFF = {
    F: { smith: 2 }, W: { mender: 1.5 }, E: { nurture: 1.5 }, A: { warp: 1.5 },
    Em: { smith: 0.5 }, Pl: { logic: 1 }, As: { repel: 1 }, Ti: { forage: 1 }, Fr: { repel: 0.5, firewall: 0.5 }, Mi: { shroud: 1 },
    St: { firewall: 1 }, Me: { smith: 1 }, Ro: { nurture: 1 }, Sp: { capacity: 1 }, Ga: { clock: 1 }, Ec: { lure: 1 },
    Li: { fortune: 1, pulse: 1 }, Vo: { transmute: 1.5 }, Si: { archive: 1.5, tutor: 1 }, Tm: { hasten: 1.5 },
  };
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
  const MAIN_ADJ = { F: ['Blazing', 'Kindled', 'Searing'], W: ['Tidal', 'Deep', 'Flowing'], E: ['Stone', 'Rooted', 'Iron'], A: ['Gale', 'Soaring', 'Cirrus'] };
  function genomeAdj(key, seed) {
    const p = E.parseKey(key), lead = p.subs.find(t => t.h === 1) || p.subs[0];
    const list = lead ? E.SUB[lead.s].adj : MAIN_ADJ[p.a];
    return list[hash32(seed + '|adj') % list.length];
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
    let name = `${adj} ${nouns[hash32(seed + '|noun') % nouns.length]}`;
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
  const PASSIVE_NAME = { logic: 'Logic', firewall: 'Firewall', clock: 'Clock', vitality: 'HP', capacity: 'Flux', coherence: 'Coherence' };
  function describeTrait(f) {
    const m = f.mag;
    switch (f.code) {
      case 'forage': return `Each mote from a battle has a ${m}% chance to double`;
      case 'tutor': return `+${m}% XP for the whole party`;
      case 'binder': return `+${m}% bind chance`;
      case 'smith': return `${m}% chance a forge costs no motes`;
      case 'nurture': return `Kernels compile ${m}% faster`;
      case 'mender': return `Heals the party ${m}% HP every 25 steps`;
      case 'fortune': return `Prismatic daemons are ${m}% more likely`;
      case 'archive': return `${m}% chance a new merge also gives a mote of its lead essence`;
      case 'lure': return `${m}% more wild encounters`;
      case 'shroud': return `${m}% fewer wild encounters`;
      case 'pulse': return `Heal the party ${m}% HP (every ${ACTIVE_CD.pulse} steps)`;
      case 'warp': return `Return to the last terminal (every ${m} steps)`;
      case 'repel': return `No wild encounters for ${m} steps (every ${ACTIVE_CD.repel} steps)`;
      case 'hasten': return `Compiling kernels advance ${m} steps (every ${ACTIVE_CD.hasten} steps)`;
      case 'transmute': return `Turn ${m} motes of your most plentiful essence into 1 of its lead essence (every ${ACTIVE_CD.transmute} steps)`;
      default: return PASSIVE_NAME[f.code] ? `+${m}% ${PASSIVE_NAME[f.code]} in battle` : '';
    }
  }

  // ---- splicing ----
  const PEDIGREE = [4, 6, 8, 11, 15]; // total % stat bonus by lineage rarity
  const INHERIT = [1, 1, 2, 2, 3]; // sub-essences inherited as attunements by lineage rarity
  const LINE_NOUN = ['Line', 'Strain', 'House', 'Dynasty', 'Legacy'];
  const STAT_KEYS = ['hp', 'atk', 'def', 'spd', 'flux', 'coh'];
  const STAT_WORD = { hp: 'endurance', atk: 'raw Logic', def: 'firewalls', spd: 'speed', flux: 'deep Flux', coh: 'coherence' };
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
    hash32, seedOf, unit, modulate, modFor, RARITY_NAMES, ITEM_TYPES, itemType, itemKind,
    TRAITS, TRAIT_SCOPE, ACTIVE_CD, affinity, traitEffects, traitKey, trait, describeTrait,
    PEDIGREE, INHERIT, breedKey, spliceOptions, lineage,
  };
});
