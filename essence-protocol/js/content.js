/* Essence Protocol: world content (map, zones, trainers, NPCs, starters) from data/world.json.
   UMD so tools/verify.js can check every reference against the baked table.
   CONTENT.make(E) builds a copy for other data (the content editor previews edits this way). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./essences.js'));
  else root.CONTENT = factory(root.ESSENCE);
})(typeof self !== 'undefined' ? self : this, function make(E) {
  'use strict';
  const WORLD = E.data.world;

  // k('FW', 'Em1 Li2') -> canonical key "FW-Em1Li2"
  function k(pair, subs) {
    const list = (subs || '').split(/\s+/).filter(Boolean).map(t => ({ s: t.slice(0, 2), h: +t[2] }));
    const key = E.makeKey(pair[0], pair[1], list);
    if (!E.validKey(key)) throw new Error('bad content key ' + pair + ' ' + subs);
    return key;
  }
  function checked(key, where) {
    if (!E.validKey(key)) throw new Error(`${where}: "${key}" is not a merge key (see data/world.json)`);
    return key;
  }

  // 5896 -> "five thousand eight hundred ninety-six" (for lines that say how big the lattice is)
  function numberWords(n) {
    const ones = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
    const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
    const small = x => x < 20 ? ones[x] : x < 100 ? tens[Math.floor(x / 10)] + (x % 10 ? '-' + ones[x % 10] : '') : ones[Math.floor(x / 100)] + ' hundred' + (x % 100 ? ' ' + small(x % 100) : '');
    if (n < 1000) return small(n);
    return small(Math.floor(n / 1000)) + ' thousand' + (n % 1000 ? ' ' + small(n % 1000) : '');
  }
  const MERGES = E.enumerateAll().length;
  const say = t => t.replace(/\{merges\}/g, numberWords(MERGES)).replace(/\{mergeCount\}/g, MERGES.toLocaleString('en-US'));

  const STARTERS = WORLD.starters.map(s => ({ key: checked(s.key, 'starter'), attune: s.attune, blurb: s.blurb }));

  // wild: [key, minLevel, maxLevel, weight]
  const ZONES = {};
  for (const z of WORLD.zones) ZONES[z.id] = { name: z.name, el: z.element, wild: z.wild.map(w => [checked(w.key, z.id + ' wild'), w.min, w.max, w.weight]) };

  // slot: the letter in the room layout. team: [key, level]
  const OPERATORS = WORLD.trainers.map(t => {
    const o = { id: t.id, zone: t.zone, slot: t.slot };
    if (t.warden) o.warden = true;
    if (t.final) o.final = true;
    Object.assign(o, { name: t.name, dir: t.facing, sight: t.sight, team: t.team.map(m => [checked(m.key, t.name), m.level]), intro: say(t.intro), outro: say(t.outro) });
    if (t.badge) o.badge = t.badge;
    return o;
  });

  const FOLK = WORLD.npcs.map(f => ({ id: f.id, x: f.x, y: f.y, name: f.name, dir: f.facing, lines: f.lines.map(say) }));

  // Lines the game says in its own voice ({daemon} is filled in where they are used).
  const TEXT = {};
  for (const [id, v] of Object.entries(WORLD.text || {})) TEXT[id] = Array.isArray(v) ? v.map(say) : say(v);

  // ---- map ----
  const ROOMS = {};
  for (const r of WORLD.rooms) ROOMS[r.zone] = { x: r.x, y: r.y, rows: r.rows };

  // Gates: tile char -> keys required
  const GATES = { '2': 1, '3': 2, '4': 3, '5': 4 };
  const SOLID = new Set(['#', '~', '^', 'o', '*', 'x', 'H', 'F', 'R', '2', '3', '4', '5']);
  // Letters that are tiles; any other letter in a room marks where the trainer with that slot stands.
  const TILE_LETTERS = new Set(['o', 'x', 'H', 'F', 'R']);
  const isSlot = ch => /^[A-Za-z]$/.test(ch) && !TILE_LETTERS.has(ch);

  function buildMap() {
    const W = 60, H = 46;
    const g = Array.from({ length: H }, () => Array(W).fill('#'));
    const zone = Array.from({ length: H }, () => Array(W).fill(null));
    const rect = (x0, y0, x1, y1, ch, z) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { g[y][x] = ch; if (z !== undefined) zone[y][x] = z; } };
    const npcs = [];

    // Nexus
    rect(24, 18, 35, 27, '.', 'nexus');
    g[19][26] = 'H'; g[19][33] = 'F';
    // corridors
    rect(12, 20, 23, 21, '.', 'fringe'); rect(12, 16, 13, 21, '.', 'fringe'); rect(15, 20, 20, 21, ',', 'fringe');
    rect(36, 20, 48, 21, '.', 'nexus'); rect(47, 16, 48, 21, '.', 'nexus');
    rect(36, 25, 48, 26, '.', 'nexus'); rect(47, 25, 48, 29, '.', 'nexus');
    rect(12, 25, 23, 26, '.', 'nexus'); rect(12, 25, 13, 29, '.', 'nexus');
    rect(29, 13, 30, 17, '.', 'nexus');
    // gates
    g[20][36] = g[21][36] = '2';
    g[25][36] = g[26][36] = '3';
    g[25][23] = g[26][23] = '4';
    g[16][29] = g[16][30] = '5';

    for (const [zid, room] of Object.entries(ROOMS)) {
      room.rows.forEach((row, ry) => {
        if (row.length !== room.rows[0].length) throw new Error(`room ${zid} row ${ry} has width ${row.length}`);
        for (let rx = 0; rx < row.length; rx++) {
          const x = room.x + rx, y = room.y + ry;
          if (x < 0 || y < 0 || x >= W || y >= H) throw new Error(`room ${zid} runs off the map at ${x},${y}`);
          let ch = row[rx];
          if (isSlot(ch)) {
            const op = OPERATORS.find(o => o.zone === zid && o.slot === ch);
            if (!op) throw new Error(`no trainer for ${zid}/${ch}`);
            npcs.push(Object.assign({ x, y, kind: op.warden ? 'warden' : 'op' }, op));
            ch = '.';
          }
          g[y][x] = ch;
          zone[y][x] = zid;
        }
      });
    }
    for (const f of FOLK) npcs.push(Object.assign({ kind: 'folk', sight: 0 }, f));
    return { w: W, h: H, tiles: g.map(r => r.join('')), zone, npcs, spawn: { x: 29, y: 24 }, heal: { x: 26, y: 20 } };
  }

  return { make, k, numberWords, STARTERS, ZONES, OPERATORS, FOLK, TEXT, ROOMS, GATES, SOLID, TILE_LETTERS, isSlot, buildMap };
});
