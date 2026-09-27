/* Essence Protocol: the merge baker. Pure (no files, no network), the same in Node and the browser.
 *
 * Enumerates every legal merge identity (Main + second Main + up to three sub-essences bound to
 * either main) and bakes it, one merge at a time, into one self-contained record: its technique,
 * its daemon form, the item it forges into, its lineage word and its trait affinity.
 * tools/bake.js writes the records to db/ and the content bundle to js/data.js; the content
 * editor runs this same code on edited data to show what an edit changes.
 *
 * The rules are layered so outcomes feel emergent rather than tabulated:
 *   mains -> pair reaction -> sub traits (weighted by host) -> universal-sub facets (depend on
 *   the host main) -> pair resonances -> trinities -> hash-seeded anomalies. The trait vector
 *   then decides class, power, accuracy, cost, priority, instability and effects, and the same
 *   genome also bakes a daemon form (name, base stats, passive). Every word comes from data/
 *   (class nouns, name syllables, form phrases, item lore, text templates), and
 *   data/overrides.json replaces fields of single merges after the rules have run.
 *
 * Deterministic: the same data always produces the same bytes.
 * Browser: global BAKER; BAKER.make(E, D, SC) builds a baker for other data. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./essences.js'), require('./designs.js'), require('./schema.js'));
  else root.BAKER = factory(root.ESSENCE, root.DESIGNS, root.CONTENT_SCHEMA);
})(typeof self !== 'undefined' ? self : this, function make(E, D, SC) {
  'use strict';
  const data = E.data;
  const SCHEMA = 'essence-protocol.merges/2';
  const BAKE_VERSION = 2;

  // Record layout. The game reads these by index, see `fields` in db/index.json.
  //   item: [kind, name, lore, tier, pct] (odds = round(100 / pct))   aff: [[trait code, weight], ...]
  const FIELDS = ['name', 'cls', 'power', 'acc', 'flux', 'prio', 'hits', 'instab', 'fx', 'rarity', 'tags', 'text', 'dName', 'dStats', 'dPassive', 'anomaly', 'dDesc', 'item', 'line', 'aff'];

  function fnv(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
  }
  const pick = (arr, key, salt) => arr[fnv(key + '#' + salt) % arr.length];
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  // Fills {name} placeholders. Text that goes in is never scanned again.
  const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));

  // ---- words, all from data/
  const NOUNS = {};
  for (const c of data.battle.classes) NOUNS[c.id] = c.nouns;
  const ROOT = {}, MIDB = {}, BODY = {}, BELLY = {}, LINE_WORD = {}, SUBMID = {}, ORGAN = {};
  for (const m of data.essences.mains) { ROOT[m.code] = m.nameRoots; MIDB[m.code] = m.nameMids; BODY[m.code] = m.bodies; BELLY[m.code] = m.belly; LINE_WORD[m.code] = m.lineWords; }
  for (const x of data.essences.subs) { SUBMID[x.code] = x.nameSyllables; ORGAN[x.code] = x.organ; LINE_WORD[x.code] = x.lineWords; }
  const SUFFIX = data.words.daemonSuffixes; // by number of subs
  const TEMPER = data.words.temperaments;   // by the strongest trait axis
  const TPL = data.words.templates;
  const ITEM_PREFIX = data.items.qualityPrefixes.map(p => (p ? p + ' ' : '')); // by quality tier
  const LORE = {};
  for (const k of data.items.kinds) LORE[k.kind] = k.lore;
  const ANOMALY_MAG = {};
  for (const a of data.combos.anomalies) ANOMALY_MAG[a.id] = a.magnitude || 0;

  // ---- daemon naming
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
      const mag = ANOMALY_MAG[anomaly] || 0;
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
      bits.push(fill(part.facet ? TPL.facet : TPL.rides, { sub, host: hostName, role, facet: part.facet && part.facet.name }));
    }
    for (const r of res) bits.push(fill(TPL.resonance, { subs: r.subs.map(s => E.SUB[s].name).join(' and '), name: r.name }));
    if (tri) bits.push(fill(TPL.trinity, { name: tri.name }));
    if (ev.anomaly) bits.push(fill(TPL.anomaly, { desc: E.ANOMALY[ev.anomaly] }));
    if (ev.instab >= 35) bits.push(TPL.unstable);
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
  // ---- daemon form description (matches the sprite: body plan from the lead, organs from the subs)
  function formDesc(ev) {
    const { p, parts, key } = ev;
    let s = pick(BODY[p.a], key, 'body');
    const bits = [];
    if (p.b !== p.a) bits.push(BELLY[p.b]);
    for (const part of parts) if (!bits.includes(ORGAN[part.s])) bits.push(ORGAN[part.s]);
    if (bits.length) s += ' with ' + (bits.length > 1 ? bits.slice(0, -1).join(', ') + ' and ' + bits[bits.length - 1] : bits[0]);
    s += '. ';
    const axes = Object.keys(ev.T).sort((x, y) => ev.T[y] - ev.T[x] || (x < y ? -1 : 1));
    s += TEMPER[axes[0]];
    if (ev.anomaly) s += ' ' + TPL.formAnomaly;
    return s;
  }
  // ---- the item a merge forges into
  function itemCore(ev) {
    const { rx, p, parts, res, tri } = ev;
    const rxName = rx.names[p.a];
    if (tri) return `${tri.name}`;
    if (res.length) return `${res[0].name} ${rxName}`;
    if (parts.length) { const lead = parts.find(x => x.h === 1) || parts[0]; return `${lead.adj} ${rxName}`; }
    return rxName;
  }
  function itemDesign(ev) {
    const kind = D.itemKind(ev.cls, ev.n);
    const mod = D.modFor('item.' + kind, ev.key, { rarity: ev.rarity });
    const A = E.MAIN[ev.p.a].name, B = E.MAIN[ev.p.b].name;
    const from = ev.pure ? `${A} motes` : `${A} and ${B} motes`;
    const subs = [...new Set(ev.parts.map(x => E.SUB[x.s].name))];
    const lore = fill(LORE[kind], { from, lead: A, second: B, subs: subs.join(' or ') });
    const name = `${ITEM_PREFIX[mod.tier]}${itemCore(ev)} ${D.ITEM_TYPES[kind][0]}`;
    return [kind, name.slice(0, 48), lore, mod.tier, mod.pct];
  }
  // ---- the word a genome lends to the lineages it splices into
  function lineWord(ev) {
    const lead = ev.parts.find(x => x.h === 1) || ev.parts[0];
    return pick(LINE_WORD[lead ? lead.s : ev.p.a], ev.key, 'line');
  }

  // ---- overrides: data/overrides.json replaces fields of single merges after the rules have run
  // Text fields, then numbers within the ranges the game accepts (power only on merges that
  // already deal damage, so an override never turns a shield into an attack).
  const OVERRIDE_TEXT = { name: 0, text: 11, dName: 12, dDesc: 16, line: 18 };
  const OVERRIDE_NUM = { power: [2, 1, 160], acc: [3, 55, 101], flux: [4, 3, 30], prio: [5, -1, 1], hits: [6, 1, 6], instab: [7, 0, 65] };
  const STAT_KEYS = ['hp', 'atk', 'def', 'spd', 'flux', 'coh'];
  function applyOverride(row, ov) {
    for (const [f, i] of Object.entries(OVERRIDE_TEXT)) if (typeof ov[f] === 'string' && ov[f]) row[i] = ov[f];
    for (const [f, [i, lo, hi]] of Object.entries(OVERRIDE_NUM)) {
      if (typeof ov[f] !== 'number' || !isFinite(ov[f])) continue;
      if ((f === 'power' || f === 'hits') && !(row[2] > 0)) continue;
      row[i] = clamp(Math.round(ov[f]), lo, hi);
    }
    if (ov.dStats) row[13] = row[13].map((v, i) => (typeof ov.dStats[STAT_KEYS[i]] === 'number' ? clamp(Math.round(ov.dStats[STAT_KEYS[i]]), 20, 200) : v));
    if (typeof ov.itemName === 'string' && ov.itemName) row[17] = [row[17][0], ov.itemName.slice(0, 48), row[17][2], row[17][3], row[17][4]];
    if (typeof ov.itemLore === 'string' && ov.itemLore) row[17] = [row[17][0], row[17][1], ov.itemLore, row[17][3], row[17][4]];
    return row;
  }

  // Bakes one merge identity into its database record. `names` holds the names taken so far.
  function bakeOne(key, names, ov) {
    const ev = evaluate(key);
    let name, i = 0;
    if (ov && ov.name) name = ov.name;
    else {
      do { name = techName(ev, i++); } while (names.tech.has(name) && i < 40);
      if (names.tech.has(name)) { const R = ['II', 'III', 'IV', 'V', 'VI']; let k = 0; while (names.tech.has(`${name} ${R[k]}`)) k++; name = `${name} ${R[k]}`; }
      names.tech.add(name);
    }
    let dn, j = 0;
    if (ov && ov.dName) dn = ov.dName;
    else {
      do { dn = daemonName(ev, j++); } while (names.form.has(dn));
      names.form.add(dn);
    }
    const row = [
      name, ev.cls, ev.power, ev.acc, ev.flux, ev.prio, ev.hits, ev.instab, ev.fx, ev.rarity, ev.tags,
      techText(ev), dn, ev.dStats, ev.dPassive, ev.anomaly,
      formDesc(ev), itemDesign(ev), lineWord(ev), D.affinity(ev.T, key),
    ];
    return ov ? applyOverride(row, ov) : row;
  }

  // The whole database, baked one merge at a time in enumeration order (names are unique across
  // it: names given in overrides are reserved first, and generated names route around them).
  // onProgress(done, total) is called every 500 merges.
  function bakeAll(onProgress) {
    const ov = data.overrides || {};
    const names = { tech: new Set(), form: new Set() };
    for (const k of Object.keys(ov)) { if (ov[k].name) names.tech.add(ov[k].name); if (ov[k].dName) names.form.add(ov[k].dName); }
    const shards = {};
    const keys = E.enumerateAll();
    keys.forEach((key, n) => {
      const pair = key.slice(0, 2);
      (shards[pair] || (shards[pair] = {}))[key] = bakeOne(key, names, ov[key]);
      if (onProgress && n % 500 === 499) onProgress(n + 1, keys.length);
    });
    return shards;
  }

  // ---- files
  // One merge per line, so a rule change shows up in git as exactly the merges it touched.
  function renderShard(pair, rows) {
    return '{"schema":' + JSON.stringify(SCHEMA) + ',"pair":"' + pair + '","rows":{\n' +
      Object.keys(rows).map(k => JSON.stringify(k) + ':' + JSON.stringify(rows[k])).join(',\n') + '\n}}\n';
  }
  function utf8Length(s) {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x80) n += 1; else if (c < 0x800) n += 2; else if (c >= 0xd800 && c < 0xdc00) { n += 4; i++; } else n += 3;
    }
    return n;
  }
  // Every generated file but the hashes: { files: { 'db/FW.json': text, ... }, index } where
  // index needs sha(text) of each shard filled in by the caller (sync in Node, async in browsers).
  function renderAll(shards) {
    const files = {}, list = [], rarity = [0, 0, 0, 0, 0];
    let count = 0;
    for (const pair of Object.keys(shards)) {
      const text = renderShard(pair, shards[pair]), n = Object.keys(shards[pair]).length;
      files['db/' + pair + '.json'] = text; count += n;
      for (const row of Object.values(shards[pair])) rarity[row[9]]++;
      list.push({ pair, file: pair + '.json', count: n, bytes: utf8Length(text), sha: null });
    }
    files['js/data.js'] = renderDataJs(data);
    return { files, index: { schema: SCHEMA, version: BAKE_VERSION, count, fields: FIELDS, rarity, shards: list } };
  }
  // sha(text) -> first 16 hex digits of the SHA-256 of the text's UTF-8 bytes
  function renderIndex(index, shaOf) {
    const out = Object.assign({}, index, { shards: index.shards.map(s => Object.assign({}, s, { sha: shaOf(s.pair) })) });
    return JSON.stringify(out, null, 1) + '\n';
  }
  // The browser bundle of data/*.json: one file per line.
  function renderDataJs(d) {
    return '/* Generated by tools/bake.js from data/*.json. Edit data/ (or use the content editor), then run node tools/bake.js. */\n' +
      'self.EP_DATA = {\n' + SC.FILES.map(f => JSON.stringify(f) + ': ' + JSON.stringify(d[f])).join(',\n') + '\n};\n';
  }

  return { make, SCHEMA, BAKE_VERSION, FIELDS, evaluate, bakeOne, bakeAll, renderShard, renderAll, renderIndex, renderDataJs, utf8Length, fnv, OVERRIDE_TEXT, OVERRIDE_NUM };
});
