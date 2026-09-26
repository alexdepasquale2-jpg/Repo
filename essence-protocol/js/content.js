/* Essence Protocol: world content (map, zones, operators, starters).
   UMD so tools/verify.js can check every reference against the baked table. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./essences.js'));
  else root.CONTENT = factory(root.ESSENCE);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  // k('FW', 'Em1 Li2') -> canonical key "FW-Em1Li2"
  function k(pair, subs) {
    const list = (subs || '').split(/\s+/).filter(Boolean).map(t => ({ s: t.slice(0, 2), h: +t[2] }));
    const key = E.makeKey(pair[0], pair[1], list);
    if (!E.validKey(key)) throw new Error('bad content key ' + pair + ' ' + subs);
    return key;
  }

  const STARTERS = [
    { key: k('FA'), attune: ['Em'], blurb: 'A Fire kernel that feeds on moving air. Fast and aggressive.' },
    { key: k('WE'), attune: ['Fr'], blurb: 'A Water kernel set in Earth. It wears enemies down.' },
    { key: k('EF'), attune: ['St'], blurb: 'An Earth kernel with a molten heart. Hard to break.' },
    { key: k('AW'), attune: ['Sp'], blurb: 'An Air kernel that carries rain. Its charge locks foes up.' },
  ];

  // wild: [key, minLevel, maxLevel, weight]
  const ZONES = {
    fringe: { name: 'Nexus Fringe', el: null, wild: [[k('AF'), 2, 4, 3], [k('WA'), 2, 4, 3], [k('EW'), 2, 4, 3], [k('FE'), 2, 4, 3], [k('AA'), 3, 4, 1]] },
    air:    { name: 'Cirrus Array', el: 'A', wild: [[k('AA'), 4, 7, 4], [k('AW'), 4, 7, 3], [k('AE'), 5, 8, 3], [k('AF'), 5, 8, 3], [k('AA', 'Ga1'), 7, 9, 1], [k('AW', 'Sp1'), 7, 9, 1], [k('EA', 'Ga2'), 7, 9, 1]] },
    fire:   { name: 'Cinder Foundry', el: 'F', wild: [[k('FF'), 9, 12, 4], [k('FA'), 9, 12, 3], [k('FE'), 9, 12, 3], [k('FW'), 10, 13, 2], [k('FF', 'Em1'), 11, 14, 1], [k('FE', 'Pl1'), 11, 14, 1], [k('FA', 'As1'), 11, 14, 1], [k('EF', 'Em2'), 12, 14, 1]] },
    water:  { name: 'Tidal Archive', el: 'W', wild: [[k('WW'), 14, 17, 3], [k('WF'), 14, 17, 3], [k('WA'), 14, 17, 3], [k('WE'), 14, 17, 3], [k('WW', 'Ti1'), 16, 19, 1], [k('WA', 'Fr1'), 16, 19, 1], [k('WE', 'Mi1'), 16, 19, 1], [k('AW', 'Ti2'), 16, 19, 1], [k('WF', 'Li1'), 17, 20, 1]] },
    earth:  { name: 'Bedrock Vault', el: 'E', wild: [[k('EE'), 20, 23, 3], [k('EW'), 20, 23, 3], [k('EA'), 20, 23, 3], [k('EF'), 20, 23, 3], [k('EE', 'St1'), 22, 25, 1], [k('EW', 'Ro1'), 22, 25, 1], [k('EA', 'Me1'), 22, 25, 1], [k('EF', 'St1 Pl2'), 24, 26, 1], [k('EE', 'Ro1 Li1'), 24, 26, 1]] },
  };

  // slot: the letter in the room layout. team: [key, level]
  const OPERATORS = [
    { id: 'air-a', zone: 'air', slot: 'a', name: 'Operator Wren', dir: 'down', sight: 3, team: [[k('AA'), 5], [k('AE'), 6]], intro: 'Your daemon looks freshly compiled. Let\'s stress-test it.', outro: 'Clean run. You\'ve got good instincts.' },
    { id: 'air-b', zone: 'air', slot: 'b', name: 'Operator Juno', dir: 'left', sight: 3, team: [[k('AW'), 6], [k('AF'), 7]], intro: 'Wind carries everything, even your defeat!', outro: 'Guess the wind changed.' },
    { id: 'air-c', zone: 'air', slot: 'c', name: 'Operator Pim', dir: 'right', sight: 4, team: [[k('AA', 'Ga1'), 8]], intro: 'Gale bound to Air. Fastest merge you\'ll ever see!', outro: 'Speed isn\'t everything, huh.' },
    { id: 'air-W', zone: 'air', slot: 'W', warden: true, name: 'Warden Sylph', dir: 'down', sight: 0, team: [[k('AW', 'Sp1'), 8], [k('AE'), 8], [k('AA', 'Ec1'), 10]],
      intro: 'The Cirrus Array answers to me. Show me you understand that a merge is more than its lead essence.', outro: 'You bind subs like you mean it. Take the Cirrus Key. The Foundry gate will open for you.', badge: 'Cirrus Key' },

    { id: 'fire-a', zone: 'fire', slot: 'a', name: 'Operator Cole', dir: 'down', sight: 3, team: [[k('FF'), 10], [k('FE'), 11]], intro: 'The Foundry runs hot. Hope your firewall does too.', outro: 'Melted. Me, not you.' },
    { id: 'fire-b', zone: 'fire', slot: 'b', name: 'Operator Ashe', dir: 'left', sight: 3, team: [[k('FA', 'Em1'), 12], [k('FW'), 12]], intro: 'Ever seen Scald go unstable? You\'re about to.', outro: 'Instability cuts both ways...' },
    { id: 'fire-c', zone: 'fire', slot: 'c', name: 'Operator Vex', dir: 'right', sight: 4, team: [[k('FE', 'Pl1'), 13]], intro: 'Plasma pierces shields. Try to block it.', outro: 'You didn\'t block. You dodged. Smart.' },
    { id: 'fire-W', zone: 'fire', slot: 'W', warden: true, name: 'Warden Pyra', dir: 'down', sight: 0, team: [[k('FF', 'Em1'), 12], [k('FA'), 12], [k('FE', 'Pl1'), 14]],
      intro: 'Fire is the first essence any daemon learns and the last it masters. Burn bright or burn out.', outro: 'Bright enough. The Cinder Key is yours. The Archive awaits.', badge: 'Cinder Key' },

    { id: 'water-a', zone: 'water', slot: 'a', name: 'Operator Rill', dir: 'right', sight: 3, team: [[k('WW'), 16], [k('WA', 'Sp2'), 17]], intro: 'Soaked daemons take Air hits hard. Just so you know.', outro: 'Well. You knew.' },
    { id: 'water-b', zone: 'water', slot: 'b', name: 'Operator Moss', dir: 'right', sight: 3, team: [[k('WE', 'Fr1'), 18], [k('WF', 'Ti1'), 18]], intro: 'Residue! Watch the residue! Everyone forgets the residue.', outro: 'You watched the residue.' },
    { id: 'water-c', zone: 'water', slot: 'c', name: 'Operator Nami', dir: 'left', sight: 4, team: [[k('WA', 'Mi1'), 19], [k('WW', 'Ti1'), 19]], intro: 'Can you hit what you can\'t see?', outro: 'Apparently yes.' },
    { id: 'water-W', zone: 'water', slot: 'W', warden: true, name: 'Warden Mareth', dir: 'left', sight: 0, team: [[k('WW', 'Ti1'), 16], [k('WA', 'Fr1'), 17], [k('WE', 'Mi1'), 17], [k('WW', 'Fr1 Mi1'), 19]],
      intro: 'Water takes the shape of whatever holds it. So does a daemon. Let me see what holds yours.', outro: 'Deep enough. Take the Tidal Key, and mind the Vault. Earth does not forgive.', badge: 'Tidal Key' },

    { id: 'earth-a', zone: 'earth', slot: 'a', name: 'Operator Flint', dir: 'left', sight: 3, team: [[k('EE', 'St1'), 22], [k('EA', 'Me1'), 23]], intro: 'Stone on Earth. You\'ll need Plasma to crack it.', outro: 'Cracked.' },
    { id: 'earth-b', zone: 'earth', slot: 'b', name: 'Operator Bram', dir: 'right', sight: 3, team: [[k('EW', 'Ro1'), 24], [k('EF', 'Me1'), 24]], intro: 'Once the roots take hold, you\'re not going anywhere.', outro: 'You tore free. Respect.' },
    { id: 'earth-c', zone: 'earth', slot: 'c', name: 'Operator Ore', dir: 'left', sight: 4, team: [[k('EE', 'Ro1'), 25], [k('EA', 'St1 Sp2'), 25]], intro: 'Earth grounds Spark. No static on my watch.', outro: 'Grounded... but beaten.' },
    { id: 'earth-W', zone: 'earth', slot: 'W', warden: true, name: 'Warden Gault', dir: 'right', sight: 0, team: [[k('EE', 'St1'), 23], [k('EF', 'Ro1'), 23], [k('EW', 'St1'), 24], [k('EE', 'St1 Me1'), 26]],
      intro: 'Everything in this world was merged from four essences. I am the one that holds them down.', outro: 'The Bedrock Key. With all four, the Core will open. The Architect is waiting.', badge: 'Bedrock Key' },

    { id: 'core-A', zone: 'core', slot: 'A', warden: true, final: true, name: 'The Architect', dir: 'down', sight: 0,
      team: [[k('FW', 'Li1 Vo2'), 28], [k('AE', 'Me2 Sp1 Si1'), 28], [k('WW', 'Ti1 Fr1 Mi1'), 29], [k('FF', 'Em1 Pl1 As1'), 29], [k('AA', 'Sp1 Ga1 Ec1'), 30], [k('EW', 'Li1 Vo2 Tm1'), 31]],
      intro: 'I baked every merge this world will ever know: five thousand eight hundred ninety-six of them. Each one waiting. Let\'s see how many you found.', outro: 'You didn\'t just find merges. You understood them. The lattice is yours now.', badge: 'Prime Key' },
  ];

  const FOLK = [
    { id: 'guide', x: 27, y: 22, name: 'Archivist Lo', dir: 'down', lines: [
      'Every thing in this world is a merge: a lead essence, a second essence, and up to three sub-essences bound to either one.',
      'Every combination already exists, baked into the lattice. You just have to find them. Compose a merge in battle and you\'ll learn what it does.',
      'Sub-essences like Light, Void, Signal and Time change depending on which main you bind them to. Try the same sub on each host.',
      'The terminal on the left heals your daemons. The Forge on the right merges motes into items. Tap Menu to check your Codex.'] },
    { id: 'tech', x: 32, y: 25, name: 'Tech Ira', dir: 'left', lines: [
      'Casting a merge leaves residue in the arena. Cast a different essence into enough residue and they react: Steam Burst, Quench, Mudslide...',
      'Unstable merges can backfire or mutate into a neighboring merge. High Coherence daemons keep them together.',
      'When two particular sub-essences meet in one merge they resonate. Three can form a Trinity. Nobody has found them all.'] },
  ];

  // ---- map ----
  const ROOMS = {
    air: { x: 3, y: 3, rows: [
      '##################',
      '#W.,,,,..*...,,,,#',
      '#...,,,..*..,,,,,#',
      '#**.....a....,,,.#',
      '#,,,,.......**...#',
      '#,,,,..**.......b#',
      '#.,,,..**..,,,...#',
      '#......,,,,,,,..*#',
      '#.c....,,,,,,,...#',
      '#**.............*#',
      '#,,,..H....,,,,,,#',
      '#,,,,.......,,,,,#',
      '#########..#######'] },
    fire: { x: 39, y: 3, rows: [
      '##################',
      '#,,,...^^^...,,,W#',
      '#,,,...^^^...,,,.#',
      '#......a.........#',
      '#^^..,,,,,,..^^..#',
      '#^^..,,,,,,..^^.b#',
      '#....,,,,,,......#',
      '#.c..........,,,.#',
      '#^^^.....^^..,,,.#',
      '#,,,.....^^......#',
      '#,,,..H..........#',
      '#,,,.............#',
      '########..########'] },
    water: { x: 39, y: 30, rows: [
      '########..########',
      '#.....H..........#',
      '#,,,.........,,,.#',
      '#,,,..~~~~..,,,,.#',
      '#.a...~~~~..,,,,.#',
      '#.....~~~~.......#',
      '#,,,,.......~~~..#',
      '#,,,,..b....~~~..#',
      '#~~.....,,,,.....#',
      '#~~.....,,,,..c..#',
      '#...,,,.,,,,.....#',
      '#...,,,.......~~W#',
      '##################'] },
    earth: { x: 3, y: 30, rows: [
      '#########..#######',
      '#......H.........#',
      '#.,,,,.....,,,,..#',
      '#.,,,,..oo.,,,,..#',
      '#.......oo....a..#',
      '#oo..,,,,,,......#',
      '#oo..,,,,,,..oo..#',
      '#..b.........oo..#',
      '#.....,,,,,......#',
      '#.oo..,,,,,..c...#',
      '#.oo.........,,,.#',
      '#W.....,,,,..,,,.#',
      '##################'] },
    core: { x: 25, y: 4, rows: [
      '##########',
      '#...A....#',
      '#........#',
      '#.x....x.#',
      '#........#',
      '#.x....x.#',
      '#........#',
      '#........#',
      '####..####'] },
  };

  // Gates: tile char -> keys required
  const GATES = { '2': 1, '3': 2, '4': 3, '5': 4 };
  const SOLID = new Set(['#', '~', '^', 'o', '*', 'x', 'H', 'F', '2', '3', '4', '5']);

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
          let ch = row[rx];
          if (/[abcWA]/.test(ch)) {
            const op = OPERATORS.find(o => o.zone === zid && o.slot === ch);
            if (!op) throw new Error(`no operator for ${zid}/${ch}`);
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

  return { k, STARTERS, ZONES, OPERATORS, FOLK, ROOMS, GATES, SOLID, buildMap };
});
