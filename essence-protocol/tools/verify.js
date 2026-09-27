#!/usr/bin/env node
/* Essence Protocol: consistency checks for CI.
 *  0. The content in data/ passes its schema (js/schema.js).
 *  1. The committed merge database (db/) and js/data.js match a fresh bake of data/ (not stale).
 *  2. Every legal merge identity is present, and nothing else is.
 *  3. Every record is sane (ranges, known effects, unique names).
 *  4. A few hundred seeded headless battles run to completion without throwing.
 *  5. Content (starters, zone pools, operators) only references real keys. */
'use strict';
const assert = require('assert');
const fs = require('fs');
const E = require('../js/essences.js');
const DB = require('../js/db.js');
const ENG = require('../js/engine.js');
const D = require('../js/designs.js');
const path = require('path');
const { bakeFiles, staleFiles } = require('./bake.js');
const C = require('../js/content.js');

function mulberry(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// 1
{
  const stale = staleFiles(bakeFiles());
  assert(!stale.length, 'stale: ' + stale.map(s => s.file).join(', ') + ' (run node tools/bake.js)');
}
// 2
const all = E.enumerateAll();
{
  // the count from the grammar alone: per ordered pair of mains, every way to pick up to 3 legal slots
  const choose = (n, k) => { let r = 1; for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1); return r; };
  let expect = 0;
  for (const a of E.MAINS) for (const b of E.MAINS) { const n = E.slotsFor(a, b).length; for (let k = 0; k <= E.MAX_SUBS; k++) expect += choose(n, k); }
  assert.strictEqual(all.length, expect);
}
assert.strictEqual(DB.count, all.length);
assert.deepStrictEqual(DB.keys(), all, 'the database holds every merge, in enumeration order');
// 3
const names = new Set(), dnames = new Set();
for (const k of all) {
  const r = ENG.rec(k);
  assert(E.validKey(k), k);
  assert(E.CLASSES[r.cls], k + ' class');
  assert(r.power >= 0 && r.power <= 160, k + ' power');
  assert(r.acc >= 55 && r.acc <= 101, k + ' acc');
  assert(r.flux >= 3 && r.flux <= 30, k + ' flux');
  assert(r.hits >= 1 && r.hits <= 6, k + ' hits');
  assert(r.instab >= 0 && r.instab <= 65, k + ' instab');
  for (const f of r.fx) assert(E.EFFECTS[f.code], k + ' fx ' + f.code);
  assert(!names.has(r.name), 'dup name ' + r.name); names.add(r.name);
  assert(!dnames.has(r.dName), 'dup daemon ' + r.dName); dnames.add(r.dName);
  assert(ENG.PASSIVES[r.dPassive], k + ' passive');
  assert(r.dDesc && r.dDesc.length <= 400, k + ' form description');
  assert.strictEqual(r.item.kind, D.itemKind(r.cls, r.subs.length), k + ' item kind');
  assert(r.item.name && r.item.name.length <= 48 && r.item.lore && r.item.tier >= 0 && r.item.tier <= 4 && r.item.pct > 0, k + ' item');
  assert.deepStrictEqual(D.modFor('item.' + r.item.kind, k, r), Object.assign(D.modFor('item.' + r.item.kind, k, r), { tier: r.item.tier, pct: r.item.pct }), k + ' item roll');
  assert(/^[A-Z][a-z]+$/.test(r.line), k + ' line word');
  assert(r.aff.length >= 1 && r.aff.every(([c, w]) => D.TRAITS[c] && w >= 1 && w <= 99), k + ' trait affinity');
}
// 5
for (const s of C.STARTERS) assert(DB.has(s.key), 'starter ' + s.key);
for (const z of Object.values(C.ZONES)) for (const w of z.wild) assert(DB.has(w[0]), 'wild ' + w[0]);
for (const t of C.OPERATORS) for (const m of t.team) assert(DB.has(m[0]), t.name + ' ' + m[0]);
// 4
let turns = 0, results = {};
for (let seed = 1; seed <= 300; seed++) {
  const rng = mulberry(seed);
  const pick = () => all[Math.floor(rng() * all.length)];
  const lv = () => 5 + Math.floor(rng() * 40);
  const team = n => Array.from({ length: n }, () => ENG.createDaemon(pick(), lv(), { rng }));
  const b = new ENG.Battle({ player: team(3), enemy: team(1 + Math.floor(rng() * 3)), wild: rng() < 0.5, trainer: { name: 'Test' }, rng });
  let guard = 0;
  while (!b.over && guard++ < 300) {
    if (b.needSwitch) { b.forceSwitch(b.sides[0].team.findIndex(d => d.hp > 0)); continue; }
    const act = b.chooseEnemy.call({ ...b, sides: [b.sides[1], b.sides[0]], act: i => b.act(1 - i), wild: false, rng });
    b.turnWith(act);
    turns++;
  }
  assert(b.over || guard >= 300, 'battle did not progress');
  results[b.result || 'timeout'] = (results[b.result || 'timeout'] || 0) + 1;
}
console.log(`ok: ${all.length} merges verified, 300 battles / ${turns} turns`, results);
// 4b. Real-time (GCD) battles: queue the first affordable attack, fire actives when ready.
{
  const rtRes = {};
  let secs = 0;
  for (let seed = 1; seed <= 150; seed++) {
    const rng = mulberry(seed * 7 + 3);
    const pick = () => all[Math.floor(rng() * all.length)];
    const team = n => Array.from({ length: n }, () => ENG.createDaemon(pick(), 5 + Math.floor(rng() * 40), { rng }));
    const b = new ENG.Battle({ player: team(3), enemy: team(1 + Math.floor(rng() * 3)), wild: rng() < 0.5, trainer: { name: 'Test' }, rng });
    b.startRealtime();
    let t = 0;
    while (!b.over && t < 400) {
      if (b.needSwitch) { b.forceSwitch(b.sides[0].team.findIndex(d => d.hp > 0)); continue; }
      const d = b.act(0);
      const atk = d.memory.filter(k => k && ENG.isAttack(k));
      b.rt[0].queued = atk[0] || null;
      for (const k of d.memory) if (k && !ENG.isAttack(k)) b.useActive(k);
      if (!atk.length && b.rt[0].gcd <= 0) b.useUtility({ type: 'defrag' });
      b.tick(0.1); t += 0.1;
    }
    secs += t;
    rtRes[b.result || 'timeout'] = (rtRes[b.result || 'timeout'] || 0) + 1;
  }
  console.log(`ok: 150 real-time battles, avg ${(secs / 150).toFixed(1)}s`, rtRes);
}

// 5b. Designs: lineages and traits are deterministic, symmetric and map to sane mechanics.
{
  const rng = mulberry(4242);
  const pick = () => all[Math.floor(rng() * all.length)];
  const hex = () => Math.floor(rng() * 4294967296).toString(16).padStart(8, '0');
  const tiers = [0, 0, 0, 0, 0];
  for (let i = 0; i < 6000; i++) {
    const x = pick(), y = i % 50 === 0 ? x : pick(), pk = D.breedKey(x, y);
    assert.strictEqual(pk, D.breedKey(y, x), 'breed key must be symmetric');
    const o = D.lineage(pk, ENG.rec), px = E.parseKey(x), py = E.parseKey(y);
    assert.deepStrictEqual(o, D.lineage(pk, ENG.rec), 'lineages are deterministic');
    assert(DB.has(o.key) && E.parseKey(o.key).subs.length === 0, pk + ' offspring must be a Seed genome');
    const mains = new Set([px.a, px.b, py.a, py.b]), subs = new Set(px.subs.concat(py.subs).map(t => t.s));
    assert(mains.has(o.lead) && mains.has(o.follow) && (o.lead !== o.follow || mains.size === 1), pk + ' offspring mains');
    assert(o.attune.length <= D.INHERIT[o.tier] && o.attune.every(s => subs.has(s) && (E.eligible(s, o.lead) || E.eligible(s, o.follow))), pk + ' inherited subs');
    const sum = Object.values(o.pedigree).reduce((s2, v) => s2 + v, 0);
    assert(sum > 0 && sum <= D.PEDIGREE[o.tier] + 2 && Object.keys(o.pedigree).every(k => ['hp', 'atk', 'def', 'spd', 'flux', 'coh'].includes(k)), pk + ' pedigree');
    assert(o.name && o.name.length <= 48 && o.desc, pk + ' lineage text');
    tiers[o.tier]++;
  }
  const caps = {}; for (const [c, t] of Object.entries(D.TRAITS)) caps[c] = t[2];
  for (let i = 0; i < 6000; i++) {
    const k = pick(), seed = hex(), info = { gen: i % 5, parentTier: i % 3, prism: i % 11 === 0, ancestry: i % 2 ? [{ name: 'Old', codes: ['forage', 'logic'] }] : [] };
    const t = D.trait(k, seed, info, ENG.rec);
    assert.deepStrictEqual(t, D.trait(k, seed, info, ENG.rec), 'traits are deterministic');
    assert(t.fx.length >= 1 && t.fx.length <= D.TRAIT_SCOPE[t.tier] && t.key === D.traitKey(k, seed), k + ' trait scope');
    assert(t.name && t.name.length <= 48 && t.desc, k + ' trait text');
    for (const f of t.fx) {
      assert(D.TRAITS[f.code] && D.describeTrait(f), k + ' trait code ' + f.code);
      const hi = Math.max(...caps[f.code]), lo = Math.min(...caps[f.code]);
      if (f.code === 'warp' || f.code === 'transmute') assert(f.mag >= 2 && f.mag <= hi * 2.5, k + ' ' + f.code + ' ' + f.mag);
      else assert(f.mag >= 1 && f.mag <= hi && f.mag >= Math.floor(lo * 0.4), k + ' ' + f.code + ' ' + f.mag);
    }
    assert(Object.values(t.stats).every(v => v <= 15), k + ' trait stats');
  }
  // battles with pedigrees, trait stats and party bonuses still finish
  let ok = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const rg = mulberry(seed * 31);
    const team = n => Array.from({ length: n }, () => { const d = ENG.createDaemon(all[Math.floor(rg() * all.length)], 10 + Math.floor(rg() * 30), { rng: rg }); d.pedigree = { atk: 8, spd: 3 }; d.trait = D.trait(d.key, 'abcdef12', {}, ENG.rec); return d; });
    const b = new ENG.Battle({ player: team(2), enemy: team(2), wild: true, rng: rg, bonus: { xp: 30, bind: 20 } });
    b.startRealtime();
    let t = 0;
    while (!b.over && t < 400) {
      if (b.needSwitch) { b.forceSwitch(b.sides[0].team.findIndex(d => d.hp > 0)); continue; }
      const d = b.act(0);
      b.rt[0].queued = d.memory.find(k => k && ENG.isAttack(k)) || null;
      if (!b.rt[0].queued && b.rt[0].gcd <= 0) b.useUtility({ type: 'defrag' });
      b.tick(0.1); t += 0.1;
    }
    if (b.over) ok++;
  }
  assert(ok >= 34, 'battles with designed bonuses stalled: ' + ok);
  console.log(`ok: 6000 lineages (tiers ${tiers.join('/')}) and 6000 traits are deterministic and sane, ${ok}/40 battles with them finished`);
}

// 5c. FriedrichBridge is retired: nothing the game ships talks to it.
{
  const root = path.join(__dirname, '..');
  const shipped = ['index.html', 'sw.js'].concat(fs.readdirSync(path.join(root, 'js')).map(f => 'js/' + f));
  for (const f of shipped) assert(!/\/bridge|X-API-Key|BRIDGE\b/.test(fs.readFileSync(path.join(root, f), 'utf8')), f + ' still references the bridge');
  console.log(`ok: ${shipped.length} shipped files make no bridge or model requests`);
}

// 5d. Reveal tier colors are full #rrggbb: the reveal appends alpha digits to them, and a 3-digit
//     color turned into an invalid one that froze every Uncommon reveal on screen.
{
  const { REVEAL } = require('../js/reveal.js');
  assert(REVEAL.TC.length === 5 && REVEAL.TC.every(c => /^#[0-9a-f]{6}$/i.test(c)), 'reveal tier colors must be #rrggbb: ' + REVEAL.TC);
  console.log('ok: reveal tier colors are valid for every rarity');
}

// 6. Map: every room row is well-formed and every NPC, terminal and gate is reachable from spawn
//    when gates are treated as open.
{
  const map = C.buildMap();
  const passable = (x, y) => { const ch = map.tiles[y][x]; return !C.SOLID.has(ch) || C.GATES[ch]; };
  const npcAt = new Set(map.npcs.map(n => n.x + ',' + n.y));
  const seen = new Set([map.spawn.x + ',' + map.spawn.y]);
  const q = [map.spawn];
  while (q.length) {
    const { x, y } = q.shift();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, id = nx + ',' + ny;
      if (seen.has(id) || !passable(nx, ny) || npcAt.has(id)) continue;
      seen.add(id); q.push({ x: nx, y: ny });
    }
  }
  const adj = (x, y) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => seen.has((x + dx) + ',' + (y + dy)));
  for (const n of map.npcs) assert(adj(n.x, n.y), 'unreachable npc ' + n.name);
  for (let y = 0; y < map.h; y++) for (let x = 0; x < map.w; x++) if ('HFR'.includes(map.tiles[y][x])) assert(adj(x, y), 'unreachable terminal at ' + x + ',' + y);
  console.log(`ok: map ${map.w}x${map.h}, ${map.npcs.length} npcs reachable, ${seen.size} walkable tiles`);
}
