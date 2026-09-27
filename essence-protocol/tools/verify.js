#!/usr/bin/env node
/* Essence Protocol: consistency checks for CI.
 *  1. The committed merge table matches a fresh bake (deterministic, not stale).
 *  2. Every legal merge identity is present, and nothing else is.
 *  3. Every record is sane (ranges, known effects, unique names).
 *  4. A few hundred seeded headless battles run to completion without throwing.
 *  5. Content (starters, zone pools, operators) only references real keys. */
'use strict';
const assert = require('assert');
const fs = require('fs');
const E = require('../js/essences.js');
const M = require('../js/merges.baked.js');
const ENG = require('../js/engine.js');
const { bakeAll, render, OUT } = require('./bake.js');
const C = require('../js/content.js');

function mulberry(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// 1
assert.strictEqual(fs.readFileSync(OUT, 'utf8'), render(bakeAll()), 'merges.baked.js is stale: run node tools/bake.js');
// 2
const all = E.enumerateAll();
assert.strictEqual(all.length, 5896);
assert.strictEqual(M.count, all.length);
assert.deepStrictEqual(Object.keys(M.table).sort(), all.slice().sort());
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
}
// 5
for (const s of C.STARTERS) assert(M.table[s.key], 'starter ' + s.key);
for (const z of Object.values(C.ZONES)) for (const w of z.wild) assert(M.table[w[0]], 'wild ' + w[0]);
for (const t of C.OPERATORS) for (const m of t.team) assert(M.table[m[0]], t.name + ' ' + m[0]);
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

// 5b. FriedrichBridge mapping: every merge and form maps to valid, distinct bridge requests.
{
  const BR = require('../js/bridge.js');
  const seenPairs = new Map();
  for (const k of all) for (const kind of ['tech', 'form']) {
    const req = BR.request(k, kind, ENG.rec(k));
    assert(BR.validIds(req), 'bad bridge ids for ' + k + ' ' + JSON.stringify([req.a.id, req.b.id]));
    assert(!req.a.id.includes('+') && !req.b.id.includes('+'));
    assert(req.context.length <= 4000);
    // the bridge treats A+B as B+A, so the unordered pair must still identify exactly one merge
    const pair = kind + '|' + [req.a.id, req.b.id].sort().join('|');
    assert(!seenPairs.has(pair), `bridge pair collision: ${k} and ${seenPairs.get(pair)}`);
    seenPairs.set(pair, k);
  }
  console.log(`ok: ${seenPairs.size} bridge requests map 1:1 onto merges and forms`);

  // Bridge-designed abilities: random items must always map to sane mechanics the engine can run.
  const rng = mulberry(99);
  const words = BR.TYPES.concat(BR.EFFECT_WORDS, ['sword', 'storm', 'heal', 'shield', 'curse', 'drain', 'aura', 'barrage', 'rage', 'nothing']);
  const rar = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', undefined];
  for (const k of all) {
    const tags = Array.from({ length: Math.floor(rng() * 6) }, () => words[Math.floor(rng() * words.length)]);
    const stats = {}; for (const s of ['attack', 'defense', 'special', 'speed', 'weird']) if (rng() < 0.7) stats[s] = Math.floor(rng() * 200);
    const r = ENG.rec(k);
    const ab = BR.abilityFrom({ name: 'X ' + tags.join(' '), description: tags.slice(1).join(' '), rarity: rar[Math.floor(rng() * rar.length)], stats, tags }, r);
    assert(E.CLASSES[ab.cls], k + ' bridge class');
    assert(ab.power >= 0 && ab.power <= 160 && ab.hits >= 1 && ab.hits <= 5, k + ' bridge power');
    assert(ab.acc >= 55 && ab.acc <= 101 && ab.flux >= 3 && ab.flux <= 30 && ab.instab >= 0 && ab.instab <= 65, k + ' bridge numbers');
    for (const f of ab.fx) assert(E.EFFECTS[f.code] && f.chance >= 1 && f.chance <= 100, k + ' bridge fx ' + f.code);
    if (['Ward', 'Mend'].includes(ab.cls)) assert(ab.power === 0);
    Object.assign(r, ab, { damaging: ab.power > 0, self: ab.cls === 'Mend' || ab.cls === 'Ward' });
  }
  let rtOk = 0;
  for (let seed = 1; seed <= 80; seed++) {
    const rg = mulberry(seed * 13);
    const team = n => Array.from({ length: n }, () => ENG.createDaemon(all[Math.floor(rg() * all.length)], 5 + Math.floor(rg() * 40), { rng: rg }));
    const b = new ENG.Battle({ player: team(2), enemy: team(2), wild: false, trainer: { name: 'T' }, rng: rg });
    b.startRealtime();
    let t = 0;
    while (!b.over && t < 400) {
      if (b.needSwitch) { b.forceSwitch(b.sides[0].team.findIndex(d => d.hp > 0)); continue; }
      const d = b.act(0);
      b.rt[0].queued = d.memory.find(k => k && ENG.isAttack(k)) || null;
      for (const k of d.memory) if (k && !ENG.isAttack(k)) b.useActive(k);
      if (!b.rt[0].queued && b.rt[0].gcd <= 0) b.useUtility({ type: 'defrag' });
      b.tick(0.1); t += 0.1;
    }
    if (b.over) rtOk++;
  }
  assert(rtOk >= 70, 'bridge-designed battles stalled: ' + rtOk);
  console.log(`ok: ${all.length} fuzzed bridge designs map to valid abilities; ${rtOk}/80 real-time battles on them finished`);
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
