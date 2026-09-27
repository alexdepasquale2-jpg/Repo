/* Essence Protocol: shared essence definitions and the merge-key grammar.
   Loaded by the game (browser global ESSENCE) and by tools/bake.js (Node).
   Nothing in here is random. The baker turns these rules into the fixed
   merge table in merges.baked.js. */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.ESSENCE = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Trait axes every essence pushes on. The baker reads the resulting vector
  // to decide what a merge *is*.
  //  pow force · grd guard · mnd mend · spd speed · prc precision
  //  hex status · drn drain · spr spread · per persistence · cha chaos
  const TRAITS = ['pow', 'grd', 'mnd', 'spd', 'prc', 'hex', 'drn', 'spr', 'per', 'cha'];

  const MAINS = ['F', 'W', 'E', 'A'];
  // base: hp, logic (attack), firewall (defense), clock (speed), flux, coherence
  const MAIN = {
    F: { code: 'F', name: 'Fire',  color: '#ff6b3d', deep: '#8f2a12', light: '#ffc27a', traits: { pow: 3, spd: 1, per: 1, cha: 1 }, base: [45, 68, 44, 62, 42, 40] },
    W: { code: 'W', name: 'Water', color: '#3aa6ff', deep: '#123f7a', light: '#aadcff', traits: { mnd: 2, spr: 1, grd: 1, per: 1 }, base: [62, 50, 52, 46, 62, 48] },
    E: { code: 'E', name: 'Earth', color: '#c9913d', deep: '#553814', light: '#efd49c', traits: { grd: 3, pow: 1, hex: 1 }, base: [66, 56, 70, 34, 40, 52] },
    A: { code: 'A', name: 'Air',   color: '#8fe6d4', deep: '#236e66', light: '#e2fff8', traits: { spd: 3, prc: 1, spr: 1 }, base: [46, 56, 40, 72, 50, 56] },
  };

  // Combat cycle: Water quenches Fire, Fire consumes Air, Air erodes Earth,
  // Earth dams Water. Fire/Water and Earth/Air are also opposites, so merging
  // them is volatile.
  const BEATS = { W: 'F', F: 'A', A: 'E', E: 'W' };
  const OPPOSITE = { F: 'W', W: 'F', E: 'A', A: 'E' };
  function chart(att, def) {
    if (BEATS[att] === def) return 1.5;
    if (BEATS[def] === att) return 0.67;
    if (att === def) return 0.8;
    return 1;
  }

  // What two mains become when merged. names[x] is the name when x leads.
  const REACTION = {
    FF: { names: { F: 'Inferno' },   traits: { pow: 2, cha: 1 },          fx: [['burn', 15]],  line: 'A flame folded into itself until it burns white.' },
    WW: { names: { W: 'Deluge' },    traits: { mnd: 1, spr: 1, grd: 1 },  fx: [['soak', 30]],  line: 'Water poured into water: the whole weight of a sea.' },
    EE: { names: { E: 'Tectonic' },  traits: { grd: 2, pow: 1 },          fx: [['guard', 20]], line: 'Plates of stone grind until the ground itself answers.' },
    AA: { names: { A: 'Tempest' },   traits: { spd: 2, spr: 1 },          fx: [['haste', 20]], line: 'Wind chasing wind, faster every lap.' },
    FW: { names: { F: 'Scald', W: 'Steam' }, volatile: true, traits: { cha: 3, pow: 2, hex: 1 }, fx: [['blind', 15], ['burn', 10]], line: 'Opposites forced together. The pressure has to go somewhere.' },
    FE: { names: { F: 'Magma', E: 'Obsidian' },   traits: { pow: 2, per: 2 },         fx: [['burn', 20]],  line: 'Stone remembers the heat long after the flame is gone.' },
    FA: { names: { F: 'Wildfire', A: 'Firestorm' }, traits: { spd: 2, spr: 2 },       fx: [['burn', 15]],  line: 'Air feeds the fire, and the fire runs with it.' },
    WE: { names: { W: 'Mire', E: 'Clay' },        traits: { hex: 2, grd: 1, drn: 1 }, fx: [['chill', 20]], line: 'Earth drinks the water and becomes something that holds.' },
    WA: { names: { W: 'Squall', A: 'Thunderhead' }, traits: { spr: 2, hex: 1, prc: 1 }, fx: [['soak', 20]], line: 'Rain thrown sideways, charged by the climb.' },
    EA: { names: { E: 'Dune', A: 'Sandstorm' }, volatile: true, traits: { cha: 2, hex: 2 }, fx: [['blind', 20]], line: 'The ground is torn loose and thrown at the sky.' },
  };
  function pairId(a, b) { return MAINS.indexOf(a) <= MAINS.indexOf(b) ? a + b : b + a; }

  // Sub-essences. host = the only main they can attach to, or null for
  // universal subs that can attach to either main.
  const SUB_ORDER = ['Em', 'Pl', 'As', 'Ti', 'Fr', 'Mi', 'St', 'Me', 'Ro', 'Sp', 'Ga', 'Ec', 'Li', 'Vo', 'Si', 'Tm'];
  const SUB = {
    Em: { name: 'Ember',  host: 'F', traits: { per: 2, pow: 1 },         fx: 'burn',      adj: ['Smoldering', 'Kindled', 'Emberlit'],  desc: 'Heat that clings and keeps on burning.' },
    Pl: { name: 'Plasma', host: 'F', traits: { pow: 3, cha: 1 },         fx: 'pierce',    adj: ['Plasma', 'Ionized', 'Searing'],      desc: 'Raw, unbound energy that cuts through defenses.' },
    As: { name: 'Ash',    host: 'F', traits: { hex: 2, per: 1 },         fx: 'blind',     adj: ['Ashen', 'Sooted', 'Cindered'],        desc: 'What fire leaves behind. It blinds and chokes.' },
    Ti: { name: 'Tide',   host: 'W', traits: { spr: 2, pow: 1 },         fx: 'wash',      adj: ['Tidal', 'Surging', 'Rolling'],        desc: 'A wave that knocks away whatever the target built up.' },
    Fr: { name: 'Frost',  host: 'W', traits: { hex: 2, grd: 1 },         fx: 'chill',     adj: ['Rime', 'Glacial', 'Frozen'],          desc: 'Cold that slows the target down, and sometimes stops it.' },
    Mi: { name: 'Mist',   host: 'W', traits: { grd: 1, hex: 1, spd: 1 }, fx: 'veil',      adj: ['Misted', 'Veiled', 'Hazy'],           desc: 'A shroud that makes the caster hard to hit.' },
    St: { name: 'Stone',  host: 'E', traits: { grd: 3, pow: 1 },         fx: 'guard',     adj: ['Stone', 'Bastion', 'Granite'],        desc: 'Mass and armor.' },
    Me: { name: 'Metal',  host: 'E', traits: { prc: 2, pow: 1 },         fx: 'crit',      adj: ['Iron', 'Steel', 'Forged'],            desc: 'A keen edge that finds weak points.' },
    Ro: { name: 'Root',   host: 'E', traits: { drn: 2, hex: 1 },         fx: 'root',      adj: ['Rooted', 'Thorned', 'Grasping'],      desc: 'Roots that hold the target in place and feed on it.' },
    Sp: { name: 'Spark',  host: 'A', traits: { spd: 1, hex: 1, pow: 1 }, fx: 'static',    adj: ['Voltaic', 'Sparking', 'Arcing'],      desc: 'Charge that locks up the target\'s circuits.' },
    Ga: { name: 'Gale',   host: 'A', traits: { spd: 3 },                 fx: 'haste',     adj: ['Gale', 'Howling', 'Swift'],           desc: 'Pure speed.' },
    Ec: { name: 'Echo',   host: 'A', traits: { spr: 2, per: 1 },         fx: 'echo',      adj: ['Echoing', 'Resonant', 'Ringing'],     desc: 'The merge rings out again on the next turn.' },
    Li: { name: 'Light',  host: null, traits: { mnd: 2, prc: 1 },        fx: 'cleanse',   adj: ['Luminous', 'Bright', 'Haloed'],       desc: 'Clarity. Its effect changes with the host it is bound to.' },
    Vo: { name: 'Void',   host: null, traits: { drn: 2, cha: 2 },        fx: 'corrupt',   adj: ['Void', 'Hollow', 'Null'],             desc: 'Absence. It corrupts Flux and makes merges unstable.' },
    Si: { name: 'Signal', host: null, traits: { prc: 1, spd: 1, hex: 1 },fx: 'overclock', adj: ['Signal', 'Encoded', 'Pinging'],      desc: 'Pure information, the native tongue of every daemon.' },
    Tm: { name: 'Time',   host: null, traits: { per: 2, spd: 1 },        fx: 'delay',     adj: ['Chrono', 'Latent', 'Lingering'],      desc: 'Moves part of the effect to a later turn.' },
  };

  // Universal subs take on a facet of whichever main they are bound to.
  const FACET = {
    Li: { F: { name: 'Radiant',     traits: { pow: 1 }, fx: 'blind' },     W: { name: 'Prismatic', traits: { mnd: 1 }, fx: 'heal' },
          E: { name: 'Crystal',     traits: { grd: 1 }, fx: 'shield' },    A: { name: 'Auroral',   traits: { prc: 1 }, fx: 'focus' } },
    Vo: { F: { name: 'Blackflame',  traits: { hex: 1 }, fx: 'burn' },      W: { name: 'Abyssal',   traits: { drn: 1 }, fx: 'drain' },
          E: { name: 'Sinking',     traits: { hex: 1 }, fx: 'root' },      A: { name: 'Vacuum',    traits: { hex: 1 }, fx: 'chill' } },
    Si: { F: { name: 'Overclocked', traits: { pow: 1 }, fx: 'overclock' }, W: { name: 'Streaming', traits: { mnd: 1 }, fx: 'regen' },
          E: { name: 'Firmware',    traits: { grd: 1 }, fx: 'guard' },     A: { name: 'Broadcast', traits: { spr: 1 }, fx: 'haste' } },
    Tm: { F: { name: 'Flashpoint',  traits: { pow: 1 }, fx: 'delay' },     W: { name: 'Eroding',   traits: { per: 1 }, fx: 'echo' },
          E: { name: 'Fossil',      traits: { grd: 1 }, fx: 'petrify' },   A: { name: 'Jetstream', traits: { spd: 1 }, fx: 'priority' } },
  };

  // Two subs that meet in the same merge (on any host) resonate.
  const RESONANCE = [
    { id: 'conduction',  name: 'Conduction',     subs: ['Sp', 'Ti'], traits: { spr: 1, hex: 1 }, fx: [['static', 30]] },
    { id: 'rod',         name: 'Lightning Rod',  subs: ['Sp', 'Me'], traits: { prc: 2, pow: 1 }, fx: [['crit', 100]] },
    { id: 'firewhirl',   name: 'Firewhirl',      subs: ['Em', 'Ga'], traits: { spr: 2 },         fx: [['burn', 20]] },
    { id: 'permafrost',  name: 'Permafrost',     subs: ['Fr', 'St'], traits: { grd: 2 },         fx: [['freeze', 15]] },
    { id: 'photosynth',  name: 'Photosynthesis', subs: ['Ro', 'Li'], traits: { mnd: 2 },         fx: [['regen', 100]] },
    { id: 'paradox',     name: 'Paradox',        subs: ['Li', 'Vo'], traits: { cha: 4, pow: 3 }, fx: [] },
    { id: 'feedback',    name: 'Feedback Loop',  subs: ['Si', 'Ec'], traits: { spr: 1, per: 1 }, fx: [['echo', 40]] },
    { id: 'recursion',   name: 'Recursion',      subs: ['Tm', 'Ec'], traits: { per: 2 },         fx: [['echo', 30]] },
    { id: 'forgefire',   name: 'Forgefire',      subs: ['Pl', 'Me'], traits: { pow: 2 },         fx: [['pierce', 100]] },
    { id: 'phantom',     name: 'Phantom',        subs: ['Mi', 'Vo'], traits: { hex: 1 },         fx: [['veil', 50]] },
    { id: 'smokescreen', name: 'Smokescreen',    subs: ['As', 'Ga'], traits: { hex: 2 },         fx: [['blind', 35]] },
    { id: 'mangrove',    name: 'Mangrove',       subs: ['Ti', 'Ro'], traits: { drn: 1, grd: 1 }, fx: [['root', 25]] },
    { id: 'blizzard',    name: 'Blizzard',       subs: ['Fr', 'Ga'], traits: { spr: 1, hex: 1 }, fx: [['freeze', 15], ['chill', 30]] },
    { id: 'virus',       name: 'Virus',          subs: ['Si', 'Vo'], traits: { hex: 2, drn: 1 }, fx: [['corrupt', 40]] },
    { id: 'fossilize',   name: 'Fossilize',      subs: ['Tm', 'St'], traits: { hex: 1, grd: 1 }, fx: [['petrify', 25]] },
    { id: 'brushfire',   name: 'Brushfire',      subs: ['Em', 'Ro'], traits: { per: 2 },         fx: [['burn', 25]] },
    { id: 'arc',         name: 'Arc',            subs: ['Pl', 'Sp'], traits: { pow: 2 },         fx: [['static', 20]] },
    { id: 'beacon',      name: 'Beacon',         subs: ['Li', 'Si'], traits: { prc: 2 },         fx: [['focus', 40]] },
    { id: 'geyser',      name: 'Geyser',         subs: ['Ti', 'Pl'], traits: { pow: 2, cha: 1 }, fx: [['wash', 30]] },
    { id: 'sirocco',     name: 'Sirocco',        subs: ['As', 'Ec'], traits: { hex: 1, spr: 1 }, fx: [['blind', 25]] },
    { id: 'hoarfrost',   name: 'Hoarfrost',      subs: ['Fr', 'Tm'], traits: { hex: 2 },         fx: [['freeze', 20]] },
    { id: 'eclipse',     name: 'Eclipse',        subs: ['As', 'Vo'], traits: { hex: 2, cha: 1 }, fx: [['blind', 30], ['corrupt', 20]] },
  ];

  // Three specific subs together form a Trinity: the rarest named merges.
  const TRINITY = [
    { id: 'phoenix',        name: 'Phoenix Protocol', subs: ['Em', 'Pl', 'As'], traits: { pow: 3, mnd: 2 }, fx: [['burn', 60], ['heal', 20]] },
    { id: 'glacier',        name: 'Glacier Mind',     subs: ['Ti', 'Fr', 'Mi'], traits: { hex: 3, grd: 2 }, fx: [['freeze', 35], ['veil', 60]] },
    { id: 'worldroot',      name: 'Worldroot',        subs: ['St', 'Me', 'Ro'], traits: { grd: 3, drn: 2 }, fx: [['root', 60], ['guard', 60]] },
    { id: 'thunderclap',    name: 'Thunderclap',      subs: ['Sp', 'Ga', 'Ec'], traits: { spd: 3, pow: 2 }, fx: [['static', 45], ['priority', 100]] },
    { id: 'superconductor', name: 'Superconductor',   subs: ['Me', 'Sp', 'Si'], traits: { pow: 3, prc: 2 }, fx: [['static', 50], ['pierce', 100]] },
    { id: 'maelstrom',      name: 'Maelstrom',        subs: ['Ti', 'Ga', 'Vo'], traits: { spr: 3, drn: 2 }, fx: [['wash', 60], ['drain', 100]] },
    { id: 'eruption',       name: 'Eruption',         subs: ['Pl', 'St', 'Tm'], traits: { pow: 4, per: 1 }, fx: [['delay', 80]] },
    { id: 'singularity',    name: 'Singularity',      subs: ['Li', 'Vo', 'Tm'], traits: { pow: 5, cha: 2 }, fx: [['corrupt', 50], ['delay', 60]] },
    { id: 'infiniteloop',   name: 'Infinite Loop',    subs: ['Ec', 'Si', 'Tm'], traits: { per: 3, spr: 2 }, fx: [['echo', 80]] },
    { id: 'oracle',         name: 'Oracle',           subs: ['Li', 'Si', 'Tm'], traits: { prc: 4, mnd: 2 }, fx: [['focus', 80], ['cleanse', 100]] },
  ];

  // Glitches in the merge lattice: a small, fixed set of keys (chosen by hash)
  // bake into something that breaks the usual rules.
  const ANOMALY = {
    mirror:    'Reflects half of the next hit back at the attacker.',
    swap:      'Swaps every stat change with the target.',
    overflow:  'Power grows with the caster\'s remaining Flux.',
    lullaby:   'Sends the target into Dormant mode.',
    fork:      'Forks the process and strikes twice at full power.',
    rewind:    'Restores the caster to its HP from two turns ago.',
    invert:    'Inverts every stat change on the target.',
    nullify:   'Wipes residue and stat changes from the whole field.',
    phase:     'The caster phases out and dodges everything next turn.',
    overwrite: 'Copies the target\'s stat boosts onto the caster.',
  };

  const CLASSES = {
    Strike:  'A single, focused hit.',
    Barrage: 'Several smaller hits.',
    Siphon:  'Damages the target and restores the caster.',
    Hex:     'Mostly status effects, with light damage.',
    Ward:    'Shields and fortifies the caster.',
    Mend:    'Repairs the caster.',
    Field:   'Saturates the arena with its essence for five turns.',
  };

  const EFFECTS = {
    burn: 'Burn', freeze: 'Freeze', static: 'Static', root: 'Root', corrupt: 'Corrupt', petrify: 'Petrify',
    soak: 'Soak', blind: 'Blind', chill: 'Chill', weaken: 'Weaken', expose: 'Expose', wash: 'Wash',
    pierce: 'Pierce', crit: 'Keen', echo: 'Echo', delay: 'Delayed', drain: 'Drain', heal: 'Heal',
    cleanse: 'Cleanse', shield: 'Shield', guard: 'Guard+', overclock: 'Logic+', haste: 'Clock+',
    focus: 'Focus', veil: 'Veil', regen: 'Regen', recoil: 'Recoil', priority: 'Priority',
    mirror: 'Mirror', swap: 'Swap', overflow: 'Overflow', lullaby: 'Lullaby', fork: 'Fork', rewind: 'Rewind',
    invert: 'Invert', nullify: 'Nullify', phase: 'Phase', overwrite: 'Overwrite',
  };
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
    TRAITS, MAINS, MAIN, BEATS, OPPOSITE, chart, REACTION, pairId,
    SUB_ORDER, SUB, FACET, RESONANCE, TRINITY, ANOMALY, CLASSES, EFFECTS, SELF_FX,
    MAX_SUBS, eligible, makeKey, parseKey, validKey, hostMain, slotsFor, composable, enumerateAll, subsPresent,
  };
});
