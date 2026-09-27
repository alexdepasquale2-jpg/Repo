#!/usr/bin/env node
/* Essence Protocol: merge baker.
 *
 * Enumerates every legal merge identity (Main + second Main + up to three
 * sub-essences bound to either main) and runs each one through the rule system
 * below. The result is written to js/merges.baked.js. The game never computes
 * a merge at runtime; it only looks outcomes up in that table.
 *
 * The rules are layered so outcomes feel emergent rather than tabulated:
 *   mains -> pair reaction -> sub traits (weighted by host) -> universal-sub
 *   facets (depend on the host main) -> pair resonances -> trinities ->
 *   hash-seeded anomalies. The trait vector then decides class, power,
 *   accuracy, cost, priority, instability and effects, and the same genome
 *   also bakes a daemon form (name, base stats, passive).
 *
 * Deterministic: the same essences.js always produces the same bytes.
 *   node tools/bake.js          write js/merges.baked.js
 *   node tools/bake.js --check  exit 1 if the committed file is stale
 */
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('../js/essences.js');

const OUT = path.join(__dirname, '..', 'js', 'merges.baked.js');
const BAKE_VERSION = 1;

// Record layout. The game reads these by index, see FIELDS in the output.
const FIELDS = ['name', 'cls', 'power', 'acc', 'flux', 'prio', 'hits', 'instab', 'fx', 'rarity', 'tags', 'text', 'dName', 'dStats', 'dPassive', 'anomaly'];

function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
const pick = (arr, key, salt) => arr[fnv(key + '#' + salt) % arr.length];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const NOUNS = {
  Strike:  ['Lance', 'Fang', 'Brand', 'Spike', 'Edge', 'Strike', 'Hammer', 'Bolt', 'Talon', 'Pike', 'Blade', 'Ram'],
  Barrage: ['Volley', 'Barrage', 'Swarm', 'Cascade', 'Hail', 'Flurry', 'Salvo', 'Spray', 'Scatter', 'Torrent', 'Burst', 'Shower'],
  Siphon:  ['Drain', 'Leech', 'Siphon', 'Tap', 'Draw', 'Feast', 'Wick', 'Pull', 'Harvest', 'Sap', 'Bleed', 'Tithe'],
  Hex:     ['Curse', 'Snare', 'Hex', 'Haze', 'Shackle', 'Blight', 'Bane', 'Lock', 'Glyph', 'Mark', 'Knot', 'Sigil'],
  Ward:    ['Aegis', 'Bulwark', 'Shell', 'Ward', 'Barrier', 'Carapace', 'Rampart', 'Mantle', 'Bastion', 'Screen', 'Plate', 'Dome'],
  Mend:    ['Renewal', 'Mend', 'Balm', 'Patch', 'Restore', 'Salve', 'Tonic', 'Rebuild', 'Reboot', 'Suture', 'Bloom', 'Remedy'],
  Field:   ['Field', 'Domain', 'Front', 'Expanse', 'Canopy', 'Circuit', 'Realm', 'Grid', 'Veil', 'Zone', 'Weather', 'Mesh'],
};

// ---- daemon naming ----
const ROOT = {
  F: ['Pyr', 'Cind', 'Ign', 'Scor', 'Blaz', 'Char', 'Flam', 'Kiln'],
  W: ['Aqu', 'Hydr', 'Mar', 'Ner', 'Tid', 'Brin', 'Rill', 'Nav'],
  E: ['Terr', 'Gran', 'Lith', 'Mag', 'Or', 'Bould', 'Grav', 'Petr'],
  A: ['Aer', 'Zeph', 'Cirr', 'Gust', 'Vent', 'Strat', 'Hal', 'Syl'],
};
const MIDB = { F: ['ra', 'ex', 'ash', 'or'], W: ['ul', 'ae', 'il', 'ris'], E: ['ak', 'on', 'um', 'dor'], A: ['is', 'ai', 'yl', 'ew'] };
const SUBMID = {
  Em: ['emb', 'em'], Pl: ['plax', 'pla'], As: ['sin', 'as'], Ti: ['tid', 'ti'], Fr: ['rim', 'ri'], Mi: ['mis', 'mi'],
  St: ['stan', 'sta'], Me: ['fer', 'fe'], Ro: ['rad', 'ro'], Sp: ['volt', 'vo'], Ga: ['gal', 'ga'], Ec: ['eko', 'ek'],
  Li: ['lux', 'lu'], Vo: ['nul', 'nu'], Si: ['sig', 'si'], Tm: ['kron', 'kro'],
};
const SUFFIX = [
  ['bit', 'let', 'o', 'ling', 'ix', 'kin'],
  ['on', 'ex', 'ar', 'us', 'ite', 'ode'],
  ['ion', 'ara', 'ius', 'ant', 'orn', 'yx'],
  ['arch', 'prime', 'os', 'eon', 'ax', 'ault'],
];
const VOW = /[aeiouy]/;
function glue(a, b) {
  if (!a) return b;
  const x = a[a.length - 1], y = b[0];
  if (!VOW.test(x) && !VOW.test(y) && !VOW.test(a[a.length - 2] || 'a')) return a + 'a' + b;
  if (x === y) return a + b.slice(1);
  return a + b;
}
const cap = s => s[0].toUpperCase() + s.slice(1);

// ---- the rule system ----
function traitVec() { const t = {}; for (const k of E.TRAITS) t[k] = 0; return t; }
function addT(t, src, w) { for (const k in src) t[k] += src[k] * w; }

function evaluate(key) {
  const p = E.parseKey(key);
  const { a, b, subs } = p;
  const pure = a === b;
  const n = subs.length;
  const pid = E.pairId(a, b);
  const rx = E.REACTION[pid];
  const T = traitVec();

  addT(T, E.MAIN[a].traits, pure ? 1.6 : 1);
  if (!pure) addT(T, E.MAIN[b].traits, 0.6);
  else T.prc += 1; // a pure merge is focused
  addT(T, rx.traits, 1);

  const present = E.subsPresent(p);
  const parts = []; // {s, h, w, adj}
  for (const t of subs) {
    const host = E.hostMain(p, t.h);
    const w = t.h === 1 ? 1 : 0.7;
    addT(T, E.SUB[t.s].traits, w);
    let adj = pick(E.SUB[t.s].adj, key, t.s);
    let facet = null;
    if (!E.SUB[t.s].host) { facet = E.FACET[t.s][host]; addT(T, facet.traits, w); adj = facet.name; }
    parts.push({ s: t.s, h: t.h, host, w, adj, facet });
  }

  const res = E.RESONANCE.filter(r => r.subs.every(s => present.has(s)));
  const tri = E.TRINITY.find(r => r.subs.every(s => present.has(s)) && n === 3) || null;
  for (const r of res) addT(T, r.traits, 1);
  if (tri) addT(T, tri.traits, 1);

  let anomaly = 0;
  if (n >= 1 && !tri && fnv(key + '|anomaly') % 1000 < 18) {
    const ids = Object.keys(E.ANOMALY);
    anomaly = ids[fnv(key + '|anomalyKind') % ids.length];
    T.cha += 2;
  }

  // --- class ---
  const score = {
    Strike:  T.pow + T.prc * 0.5 + 1.2,
    Barrage: T.spr * 1.25 + T.pow * 0.3,
    Siphon:  T.drn * 1.4 + T.pow * 0.2,
    Hex:     T.hex * 1.15 + T.cha * 0.2 - 0.6,
    Ward:    T.grd * 0.95 - T.pow * 0.25,
    Mend:    T.mnd * 1.3 - T.pow * 0.3,
    Field:   T.per * 0.95 + T.spr * 0.3 + T.cha * 0.2 - 0.6,
  };
  let cls = 'Strike', best = -1e9;
  for (const c of Object.keys(score)) {
    const s = score[c] + (fnv(key + c) % 100) / 400; // tiny, fixed tiebreak jitter
    if (s > best) { best = s; cls = c; }
  }
  const damaging = cls === 'Strike' || cls === 'Barrage' || cls === 'Siphon' || cls === 'Field' || cls === 'Hex';

  // --- effects ---
  const fx = new Map();
  const addFx = (code, chance, mag) => {
    const cur = fx.get(code);
    if (!cur) fx.set(code, { c: clamp(chance, 1, 100), m: mag || 0 });
    else { cur.c = clamp(Math.max(cur.c, chance) + Math.min(cur.c, chance) * 0.35, 1, 100); cur.m = Math.max(cur.m, mag || 0); }
  };
  const statusMul = cls === 'Hex' ? 1.9 : cls === 'Field' ? 1.3 : 1;
  const MAG = { drain: 40, heal: 25, shield: 20, regen: 6, delay: 60, echo: 50, recoil: 20, overflow: 0 };
  const put = (code, chance) => {
    if (E.SELF_FX.has(code)) addFx(code, chance, MAG[code]);
    else if (code === 'pierce' || code === 'crit' || code === 'priority') addFx(code, 100, 1);
    else if (code === 'drain' || code === 'delay' || code === 'echo') addFx(code, chance, MAG[code]);
    else addFx(code, chance * statusMul + T.hex * 2, 0);
  };
  for (const [code, ch] of rx.fx) put(code, ch * (n === 0 ? 1 : 0.8));
  for (const part of parts) {
    const base = E.SUB[part.s].fx;
    put(base, (28 + T.per * 2) * part.w);
    if (part.facet) put(part.facet.fx, 22 * part.w);
  }
  for (const r of res) for (const [code, ch] of r.fx) put(code, ch);
  if (tri) for (const [code, ch] of tri.fx) put(code, ch);

  if (cls === 'Siphon') addFx('drain', 100, clamp(Math.round(35 + T.drn * 5), 35, 80));
  if (cls === 'Mend') { addFx('heal', 100, clamp(Math.round(22 + T.mnd * 5), 25, 70)); if (present.has('Li')) addFx('cleanse', 100, 0); }
  if (cls === 'Ward') { addFx('shield', 100, clamp(Math.round(14 + T.grd * 3.5), 18, 50)); if (T.grd >= 6) addFx('guard', 70, 1); }
  if (cls === 'Hex' && ![...fx.keys()].some(k => !E.SELF_FX.has(k) && !['pierce', 'crit', 'priority', 'drain', 'delay', 'echo'].includes(k))) {
    put(rx.fx[0][0], 60);
  }
  if (!damaging) { fx.delete('pierce'); fx.delete('crit'); fx.delete('drain'); fx.delete('delay'); fx.delete('echo'); }
  if (rx.volatile && T.cha >= 7 && damaging) addFx('recoil', 100, clamp(Math.round(T.cha * 2.5), 10, 35));
  if (anomaly) {
    const mag = { overflow: 60, rewind: 0, mirror: 50 }[anomaly] || 0;
    fx.set(anomaly, { c: 100, m: mag });
  }

  // --- numbers ---
  const raw = 32 + T.pow * 7.5 + T.cha * 3.5 + T.prc * 1.5 + n * 6;
  let hits = 1;
  let power = 0;
  if (cls === 'Strike') power = raw;
  else if (cls === 'Barrage') { hits = clamp(2 + Math.floor((T.spr - 2) / 2), 2, 5); power = raw * 1.12 / hits; }
  else if (cls === 'Siphon') power = raw * 0.8;
  else if (cls === 'Field') power = raw * 0.45;
  else if (cls === 'Hex') power = T.pow >= 3 ? raw * 0.35 : 0;
  if (anomaly === 'fork' && damaging) hits = Math.max(2, hits);
  power = damaging ? clamp(Math.round(power / 5) * 5, power > 0 ? 15 : 0, 160) : 0;

  let acc = 88 + T.prc * 3 - T.cha * 2.5 - Math.max(0, power * hits - 90) / 6;
  acc = clamp(Math.round(acc / 5) * 5, 55, 100);
  if (T.prc >= 7 || cls === 'Mend' || cls === 'Ward') acc = 101; // never misses

  let prio = 0;
  if (fx.has('priority') || (present.has('Ga') && T.spd >= 6)) prio = 1;
  else if (T.pow >= 9 && T.spd <= 1.5) prio = -1;
  fx.delete('priority');

  let instab = 1 + T.cha * 3.2 + (rx.volatile ? 8 : 0) + n * 2.5 - T.prc * 1.2 - (pure ? 3 : 0);
  if (res.some(r => r.id === 'paradox')) instab += 15;
  if (tri && tri.id === 'singularity') instab += 10;
  if (anomaly) instab += 6;
  instab = clamp(Math.round(instab), 0, 65);

  let rarity = n === 0 ? 0 : 1;
  if (res.length) rarity = 2;
  if (tri) rarity = 3;
  if (anomaly) rarity = 4;

  let flux = 3 + n * 3 + Math.round(power * hits / 28) + (rarity >= 2 ? 2 : 0) + (cls === 'Mend' || cls === 'Ward' || cls === 'Field' ? 3 : 0);
  flux = clamp(flux, 3, 30);

  const fxList = [...fx.entries()]
    .map(([code, v]) => [code, Math.round(v.c), v.m])
    .sort((x, y) => (y[1] - x[1]) || (x[0] < y[0] ? -1 : 1));

  const tags = res.map(r => r.name);
  if (tri) tags.unshift(tri.name);

  // --- daemon form ---
  const wA = pure ? 1 : 0.65, wB = pure ? 0 : 0.35;
  const st = [0, 1, 2, 3, 4, 5].map(i => E.MAIN[a].base[i] * wA + E.MAIN[b].base[i] * wB);
  if (pure) { st[0] += 4; st[1] += 4; }
  st[0] += T.mnd * 2 + T.grd;
  st[1] += T.pow * 2 + T.cha;
  st[2] += T.grd * 2;
  st[3] += T.spd * 2;
  st[4] += T.per * 2 + T.mnd;
  st[5] += T.prc * 2 - T.cha * 1.5;
  const tierMul = 1 + 0.1 * n;
  const dStats = st.map(v => clamp(Math.round(v * tierMul), 20, 200));

  let dPassive = a;
  if (parts.length) dPassive = (parts.find(x => x.h === 1) || parts[0]).s;

  return { key, p, pure, n, rx, T, parts, res, tri, anomaly, cls, power, acc, flux, prio, hits, instab, fx: fxList, rarity, tags, dStats, dPassive };
}

function nounFor(ev, i) {
  const list = NOUNS[ev.cls];
  const start = fnv(ev.key + '|noun') % list.length;
  return list[(start + i) % list.length];
}

function techName(ev, attempt) {
  const { rx, p, parts, res, tri } = ev;
  const rxName = rx.names[p.a];
  const noun = nounFor(ev, attempt % NOUNS[ev.cls].length);
  let name;
  if (tri) {
    name = `${tri.name} ${rxName}` + (attempt ? ` ${noun}` : '');
  } else if (res.length) {
    const inRes = new Set(res.flatMap(r => r.subs));
    const extra = parts.find(x => !inRes.has(x.s));
    name = `${res[0].name} ${rxName} ${noun}`;
    if (extra && name.length + extra.adj.length < 32) name = `${extra.adj} ${name}`;
  } else if (parts.length) {
    const lead = parts.find(x => x.h === 1) || parts[0];
    const second = parts.find(x => x !== lead);
    name = `${lead.adj} ${rxName} ${noun}`;
    if (second && second.adj !== lead.adj && name.length + second.adj.length < 30) name = `${lead.adj} ${second.adj} ${rxName} ${noun}`;
  } else {
    name = `${rxName} ${noun}`;
  }
  if (ev.anomaly) name += ` ∆${cap(ev.anomaly)}`;
  return name;
}

function techText(ev) {
  const { p, parts, res, tri, rx } = ev;
  const bits = [];
  for (const part of parts) {
    const role = ev.pure ? 'core' : part.h === 1 ? 'lead' : 'follow';
    const sub = E.SUB[part.s].name;
    const hostName = E.MAIN[part.host].name;
    bits.push(part.facet ? `${sub} on the ${hostName} ${role} turns ${part.facet.name}.` : `${sub} rides the ${hostName} ${role}.`);
  }
  for (const r of res) bits.push(`${r.subs.map(s => E.SUB[s].name).join(' and ')} resonate: ${r.name}.`);
  if (tri) bits.push(`All three align into ${tri.name}.`);
  if (ev.anomaly) bits.push(`Something in the lattice is wrong here. ${E.ANOMALY[ev.anomaly]}`);
  if (ev.instab >= 35) bits.push('It barely holds together.');
  return bits.join(' ');
}

function daemonName(ev, attempt) {
  const { p, n, parts } = ev;
  const roots = ROOT[p.a];
  const root = roots[(fnv(p.a + p.b + '|root') + Math.floor(attempt / 6)) % roots.length].toLowerCase();
  const suf = SUFFIX[n][(fnv(ev.key + '|suf') + attempt) % SUFFIX[n].length];
  let body = root;
  if (n === 0) body = glue(body, MIDB[p.b][fnv(p.a + p.b + '|mid') % MIDB[p.b].length]);
  else if (n === 1) body = glue(body, SUBMID[parts[0].s][0]);
  else {
    const lead = parts.find(x => x.h === 1) || parts[0];
    const others = parts.filter(x => x !== lead);
    body = glue(body, SUBMID[lead.s][1]);
    body = glue(body, SUBMID[others[fnv(ev.key + '|o') % others.length].s][1]);
  }
  return cap(glue(body, suf)) + (attempt >= 36 ? '-' + (attempt - 35) : '');
}

function bakeAll() {
  const keys = E.enumerateAll();
  const table = {};
  const techNames = new Set();
  const dNames = new Set();
  for (const key of keys) {
    const ev = evaluate(key);
    let name, i = 0;
    do { name = techName(ev, i++); } while (techNames.has(name) && i < 40);
    if (techNames.has(name)) { const R = ['II', 'III', 'IV', 'V', 'VI']; let k = 0; while (techNames.has(`${name} ${R[k]}`)) k++; name = `${name} ${R[k]}`; }
    techNames.add(name);
    let dn, j = 0;
    do { dn = daemonName(ev, j++); } while (dNames.has(dn));
    dNames.add(dn);
    table[key] = [
      name, ev.cls, ev.power, ev.acc, ev.flux, ev.prio, ev.hits, ev.instab, ev.fx, ev.rarity, ev.tags,
      techText(ev), dn, ev.dStats, ev.dPassive, ev.anomaly,
    ];
  }
  return { version: BAKE_VERSION, count: keys.length, fields: FIELDS, table };
}

function render(data) {
  const lines = Object.keys(data.table).map(k => JSON.stringify(k) + ':' + JSON.stringify(data.table[k]));
  return [
    '/* GENERATED by tools/bake.js from js/essences.js. Do not edit by hand.',
    ` * ${data.count} merge identities, every one pre-resolved. */`,
    '(function (root) {',
    `var M = { version: ${data.version}, count: ${data.count}, fields: ${JSON.stringify(data.fields)}, table: {`,
    lines.join(',\n'),
    '} };',
    "if (typeof module === 'object' && module.exports) module.exports = M; else root.MERGES = M;",
    "})(typeof self !== 'undefined' ? self : this);",
    '',
  ].join('\n');
}

module.exports = { bakeAll, render, evaluate, OUT };

if (require.main === module) {
  const text = render(bakeAll());
  if (process.argv.includes('--check')) {
    // line endings don't count (a Windows checkout with core.autocrlf has CRLF)
    const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') : '';
    if (cur !== text) { console.error('merges.baked.js is stale: run `node tools/bake.js`'); process.exit(1); }
    console.log('merges.baked.js is up to date');
  } else {
    fs.writeFileSync(OUT, text);
    console.log(`baked ${Object.keys(bakeAll().table).length} merges -> ${path.relative(process.cwd(), OUT)} (${(text.length / 1024).toFixed(0)} KB)`);
  }
}
