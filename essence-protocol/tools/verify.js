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
assert.strictEqual(fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n'), render(bakeAll()), 'merges.baked.js is stale: run node tools/bake.js');
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

// 5c. Live baking: every design kind maps to valid, distinct bridge requests; seeds and the %RARITY%
//     modulator are deterministic; lineage and trait designs always map to sane mechanics.
{
  const BR = require('../js/bridge.js');
  const rng = mulberry(4242);
  const pick = () => all[Math.floor(rng() * all.length)];
  const hex = () => Math.floor(rng() * 4294967296).toString(16).padStart(8, '0');
  const pairs = new Map(); // unordered id pair -> what asked for it
  const check = (what, req) => {
    assert(BR.validIds(req), 'bad bridge ids for ' + what + ' ' + JSON.stringify([req.a.id, req.b.id]));
    assert(!req.a.id.includes('+') && !req.b.id.includes('+') && req.a.id !== req.b.id, what + ' ids');
    assert(req.context.length <= 4000 && !/%[A-Z]+%/.test(req.context), what + ' context');
    const pair = [req.a.id, req.b.id].sort().join('|');
    assert(!pairs.has(pair), `bridge pair collision: ${what} and ${pairs.get(pair)}`);
    pairs.set(pair, what);
  };
  const itemTypes = Object.keys(BR.ITEM_TYPES);
  for (const k of all) {
    for (const kind of ['tech', 'form'].concat(itemTypes.map(t => 'item.' + t))) check(kind + ':' + k, BR.request(k, kind, ENG.rec(k)));
  }
  let breeds = 0;
  for (let i = 0; i < 4000; i++) {
    const x = pick(), y = i % 50 === 0 ? x : pick(), pk = BR.breedKey(x, y);
    assert.strictEqual(pk, BR.breedKey(y, x), 'breed key must be symmetric');
    if (pairs.has(['ep.b.' + pk.split('~')[0], 'ep.b.' + pk.split('~')[1] + (x === y ? '.twin' : '')].sort().join('|'))) continue;
    check('breed:' + pk, BR.request(pk, 'breed', { names: ['A', 'B'] })); breeds++;
  }
  for (let i = 0; i < 4000; i++) {
    const tk = BR.traitKey(pick(), hex());
    check('trait:' + tk, BR.request(tk, 'trait', { name: 'X', gen: i % 4, ancestry: [{ name: 'Old', codes: ['forage'] }] }));
  }
  console.log(`ok: ${pairs.size} live-bake requests (techniques, forms, 6 item types, ${breeds} lineages, 4000 traits) are valid and distinct`);

  // seeds and the modulator
  const tiers = [0, 0, 0, 0, 0];
  for (const k of all) {
    const m = BR.modFor('tech', k, ENG.rec(k)), m2 = BR.modFor('tech', k, ENG.rec(k));
    assert.deepStrictEqual(m, m2, 'modulator must be deterministic');
    assert(/^[0-9a-f]{8}$/.test(m.seed) && m.pct >= 0.01 && m.pct <= 100 && m.tier >= 0 && m.tier <= 4 && m.odds >= 1, k + ' modulator');
    assert.strictEqual(BR.RARITY_NAMES[m.tier], m.rarity);
    tiers[m.tier]++;
  }
  assert(tiers[4] > 0 && tiers[4] < all.length * 0.05 && tiers[0] > all.length * 0.25, 'modulator spread ' + tiers);
  for (let i = 0; i < 200; i++) { const s = hex(); assert(BR.modulate(s, 0.9).pct <= BR.modulate(s, 0).pct, 'boost must only make designs rarer'); }

  // abilities with the modulator: tier comes from the roll and scope caps the effects
  const words = BR.TYPES.concat(BR.EFFECT_WORDS);
  for (let i = 0; i < 3000; i++) {
    const k = pick(), r = ENG.rec(k), mod = BR.modFor('tech', k, r);
    const tags = Array.from({ length: Math.floor(rng() * 9) }, () => words[Math.floor(rng() * words.length)]);
    const ab = BR.abilityFrom({ name: 'X', description: tags.join(' '), rarity: 'legendary', stats: { attack: rng() * 99, speed: rng() * 99 }, tags }, r, mod);
    assert.strictEqual(ab.tier, mod.tier, 'the modulator sets the tier');
    assert(ab.fx.length <= Math.min(7, 2 + mod.tier) && ab.power <= 160 && ab.flux <= 30, k + ' scoped ability');
  }

  // splice lineages -> offspring: symmetric, valid, and only from the parents' essences
  const ess = E.MAINS.map(m => E.MAIN[m].name).concat(E.SUB_ORDER.map(s => E.SUB[s].name), ['nonsense', 'fire-water']);
  for (let i = 0; i < 6000; i++) {
    const x = pick(), y = pick(), pk = BR.breedKey(x, y), mod = BR.modFor('breed', pk);
    const tags = Array.from({ length: Math.floor(rng() * 7) }, () => ess[Math.floor(rng() * ess.length)]);
    const stats = {}; for (const s of ['hp', 'attack', 'defense', 'speed', 'flux', 'special', 'weird']) if (rng() < 0.5) stats[s] = Math.floor(rng() * 100);
    const entry = i % 7 === 0 ? null : { name: 'Line', description: tags.slice(2).join(' '), rarity: 'epic', stats, tags };
    const o = BR.offspringFrom(entry, pk, mod), px = E.parseKey(x), py = E.parseKey(y);
    assert(M.table[o.key] && E.parseKey(o.key).subs.length === 0, pk + ' offspring must be a Seed genome');
    const mains = new Set([px.a, px.b, py.a, py.b]), subs = new Set(px.subs.concat(py.subs).map(t => t.s));
    assert(mains.has(o.lead) && mains.has(o.follow) && (o.lead !== o.follow || mains.size === 1), pk + ' offspring mains');
    assert(o.attune.every(s => subs.has(s) && (E.eligible(s, o.lead) || E.eligible(s, o.follow))), pk + ' inherited subs');
    assert(o.attune.length <= (entry ? BR.INHERIT[mod.tier] : 1), pk + ' inherit count');
    if (entry) {
      const sum = Object.values(o.pedigree).reduce((s, v) => s + v, 0);
      assert(sum > 0 && sum <= BR.PEDIGREE[mod.tier] + 3 && Object.keys(o.pedigree).every(k => ['hp', 'atk', 'def', 'spd', 'flux', 'coh'].includes(k)), pk + ' pedigree');
    } else assert.strictEqual(o.pedigree, null);
    const d = ENG.createDaemon(o.key, 5, { attune: o.attune, extraAttune: 0 });
    d.pedigree = o.pedigree;
    assert(ENG.calcStats(d).hp >= ENG.calcStats(Object.assign({}, d, { pedigree: null })).hp, 'pedigree never lowers stats');
  }

  // traits: valid codes, scope and magnitudes, and a description the game can show
  const tw = Object.keys(BR.TRAITS).concat(['utility', 'power', 'speed', 'mote', 'nothing', 'warp-drive']);
  const caps = {}; for (const [c, t] of Object.entries(BR.TRAITS)) caps[c] = t[2];
  for (let i = 0; i < 6000; i++) {
    const tk = BR.traitKey(pick(), hex()), mod = BR.modFor('trait', tk, { gen: i % 5, parentTier: i % 3, prism: i % 11 === 0 });
    const tags = Array.from({ length: Math.floor(rng() * 6) }, () => tw[Math.floor(rng() * tw.length)]);
    const stats = {}; for (const w of tags) if (rng() < 0.5) stats[w] = Math.floor(rng() * 90);
    const t = BR.traitFrom({ name: 'T', description: tags.join(' '), stats, tags }, mod, rng() < 0.5 ? ['forage', 'logic'] : []);
    assert(t.fx.length >= 1 && t.fx.length <= BR.TRAIT_SCOPE[mod.tier] && t.tier === mod.tier, tk + ' trait scope');
    for (const f of t.fx) {
      assert(BR.TRAITS[f.code] && BR.describeTrait(f), tk + ' trait code ' + f.code);
      const hi = Math.max(...caps[f.code]), lo = Math.min(...caps[f.code]);
      if (f.code === 'warp' || f.code === 'transmute') assert(f.mag >= 2 && f.mag <= hi * 2.5, tk + ' ' + f.code + ' ' + f.mag);
      else assert(f.mag >= 1 && f.mag <= hi && f.mag >= Math.floor(lo * 0.4), tk + ' ' + f.code + ' ' + f.mag);
    }
    assert(Object.keys(t.stats).every(k => ['hp', 'atk', 'def', 'spd', 'flux', 'coh'].includes(k) && t.stats[k] <= 15), tk + ' trait stats');
  }

  // battles with pedigrees, trait stats and party bonuses still finish
  let ok = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const rg = mulberry(seed * 31);
    const team = n => Array.from({ length: n }, () => { const d = ENG.createDaemon(all[Math.floor(rg() * all.length)], 10 + Math.floor(rg() * 30), { rng: rg }); d.pedigree = { atk: 8, spd: 3 }; d.trait = { stats: { def: 11, hp: 4 } }; return d; });
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
  assert(ok >= 34, 'battles with live-baked bonuses stalled: ' + ok);
  const t0 = ENG.createDaemon('WW', 20); const c = ENG.captureChance(t0, 10, 100, { power: 1 }, false, 0), cb = ENG.captureChance(t0, 10, 100, { power: 1 }, false, 22);
  assert(cb > c && cb <= 0.97, 'bind bonus');
  console.log(`ok: modulator tiers ${tiers.join('/')}, 6000 lineages and 6000 traits map to sane mechanics, ${ok}/40 battles with bonuses finished`);
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

// 7. The bridge client against a fake bridge: nothing is lost while it is down (the outbox persists
//    and replays), cached designs need no request, failures are sorted, play events jump the queue.
(async () => {
  const BR = require('../js/bridge.js');
  const store = new Map();
  global.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  BR.load();
  let up = false;
  const sent = [];
  const resp = (status, body) => ({ status, json: async () => body });
  global.fetch = async (url, opts) => {
    if (!up) throw new TypeError('fetch failed');
    if (url.endsWith('/health')) return resp(200, { ok: true });
    const req = JSON.parse(opts.body);
    sent.push(req.a.id);
    await new Promise(r => setTimeout(r, 2));
    if (req.a.id.startsWith('ep.f.')) return resp(422, { detail: 'invalid JSON twice', retryable: false });
    if (req.a.id.startsWith('ep.i.')) return resp(422, { detail: [{ loc: ['body', 'a', 'id'], msg: 'bad id' }] });
    return resp(200, { key: [req.a.id, req.b.id].sort().join('+'), cached: false, item: { id: 'mx_0', name: 'Design ' + req.a.id, description: 'd', rarity: 'rare', stats: { attack: 5 }, tags: ['strike'] } });
  };
  const until = async f => { for (let i = 0; i < 500 && !f(); i++) await new Promise(r => setTimeout(r, 5)); assert(f(), 'timed out waiting'); };
  BR.init({ rec: (key, kind) => (kind === 'breed' ? { names: ['A', 'B'] } : ENG.rec(key)) });
  const errs = console.error; console.error = () => {}; // the malformed case logs on purpose
  try {
    const pk = BR.breedKey('FW', 'EA');
    assert.strictEqual(await BR.flavor('FW', 'tech', ENG.rec('FW')), null);
    assert.strictEqual(BR.status.state, 'offline');
    await BR.flavor(pk, 'breed', { names: ['A', 'B'] });
    assert.deepStrictEqual(BR.waiting().sort(), ['breed:' + pk, 'tech:FW'].sort(), 'requests wait in the outbox');
    assert(JSON.parse(store.get('ep-bridge-outbox-v1'))['tech:FW'], 'the outbox is saved');
    up = true;
    await BR.health(); // online again: the outbox replays
    await until(() => BR.pending() === 0 && BR.cached('FW', 'tech') && BR.cached(pk, 'breed'));
    assert.strictEqual(BR.waiting().length, 0, 'the database has everything');
    const n = sent.length;
    await BR.flavor('FW', 'tech', ENG.rec('FW'));
    assert.strictEqual(sent.length, n, 'a cached design needs no request');
    await BR.flavor('WW', 'form', ENG.rec('WW'));
    await BR.flavor('WW', 'item.patch', ENG.rec('WW'));
    assert(BR.waiting().includes('form:WW') && !BR.waiting().includes('item.patch:WW'), 'model failures wait for next session; game bugs are dropped');
    sent.length = 0;
    const bulk = ['AA', 'AE', 'AF', 'AW'].map(k => BR.flavor(k, 'tech', ENG.rec(k), { pri: 0, record: false }));
    const live = BR.flavor('EE', 'tech', ENG.rec('EE'));
    await Promise.all(bulk.concat([live]));
    assert.strictEqual(sent[1], 'ep.t.lead.E', 'a play event jumps ahead of bulk design: ' + sent.join(','));
    assert(!BR.waiting().some(ck => ck.startsWith('tech:A')), 'bulk design is not kept in the outbox');
    console.log('ok: bridge client keeps an outbox while the bridge is down, replays it, and orders play before bulk');
  } finally { console.error = errs; }
})().catch(e => { console.error(e); process.exit(1); });
