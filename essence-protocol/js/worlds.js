/* Essence Protocol: the worlds players make.
   A world is the same JSON as data/world.json (its fields are described in js/schema.js). This file
   keeps the player's worlds in this browser, starts new ones from templates, imports and exports
   them, and draws the Worlds screen: play any world, or open it in the builder (js/build.js). */
(function () {
  'use strict';
  const G = window.EP_GAME, SC = window.CONTENT_SCHEMA, CT = window.CONTENT, WR = window.WORLD_RENDER;
  if (!G) return;
  const $ = id => document.getElementById(id);
  const esc = G.esc;
  const INDEX = 'ep-worlds-v1', KEY = id => 'ep-world:' + id;
  const FORMAT = 'essence-protocol.world/2';
  const read = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } };
  const drop = k => { try { localStorage.removeItem(k); } catch (e) { /* storage off */ } };
  const clone = SC.clone;

  // ---------------------------------------------------------------- the registry
  const list = () => read(INDEX, []).filter(x => x && x.id);
  const get = id => read(KEY(id), null);
  const newId = () => 'w' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  const countThings = w => (w.maps || []).reduce((n, m) => n + ((m && m.things) || []).length, 0);
  function save(id, world) {
    const ok = write(KEY(id), world);
    const idx = list();
    let m = idx.find(x => x.id === id);
    if (!m) { m = { id, created: Date.now() }; idx.unshift(m); }
    Object.assign(m, { title: world.title, updated: Date.now(), maps: (world.maps || []).length, things: countThings(world) });
    write(INDEX, idx);
    return ok;
  }
  function create(world) { const id = newId(); if (!save(id, world)) { G.toast('This browser is out of storage for worlds. Export and delete one first.', 'bad'); return null; } return id; }
  function remove(id) { drop(KEY(id)); drop('ep-save:' + id); drop('ep-test:' + id); write(INDEX, list().filter(x => x.id !== id)); }
  const hasSave = id => { try { return !!localStorage.getItem(id === 'main' ? G.SAVE_KEY : 'ep-save:' + id); } catch (e) { return false; } };

  // ---------------------------------------------------------------- themes and templates
  const LIBRARY = [
    { id: 'meadow', name: 'Meadow', floor: ['#1d3322', '#203826'], speck: '#2c4a33', line: '#2a4a30', wall: '#1a3020', face: '#2c4c32', trim: '#9df28a', static: ['#1f5a2a', '#3f9a4a', '#d8ffb0'], obstacle: '#3f8a4a', accent: '#8fe07a', sky: ['#0a1a10', '#2a5a3a'], particles: 'leaf' },
    { id: 'frost', name: 'Frost', floor: ['#1c2a3a', '#20304a'], speck: '#2e425c', line: '#34506e', wall: '#0c1622', face: '#2a4460', trim: '#dff4ff', static: ['#2a5a7a', '#6ab4d8', '#f0fbff'], obstacle: '#9fd6f0', accent: '#bfe8ff', sky: ['#0a1624', '#4a7aa0'], particles: 'snow' },
    { id: 'dusk', name: 'Dusk', floor: ['#241a30', '#2a1e38'], speck: '#3a2a4c', line: '#40305a', wall: '#120b1a', face: '#35244a', trim: '#ffb86b', static: ['#4a2a5a', '#8a4a8a', '#ffd0a0'], obstacle: '#7a4aa0', accent: '#ff9a6b', sky: ['#12081c', '#6a3050'], particles: 'spark' },
    { id: 'hearth', name: 'Hearth', floor: ['#2e2218', '#33261b'], speck: '#46341f', line: '#4a3822', wall: '#150e08', face: '#3e2c1a', trim: '#ffcf7a', static: ['#5a4a1c', '#8a7a2c', '#ffe9a0'], obstacle: '#8a6a3a', accent: '#ffb45a', sky: ['#140c06', '#4a3016'], particles: 'dust' },
  ];
  // every theme a new world starts with: the game's own and the library's
  const allThemes = () => clone(Object.values(CT.THEMES)).concat(clone(LIBRARY).filter(t => !CT.THEMES[t.id]));
  const official = () => clone(window.EP_DATA.world);

  // grids for the templates
  const canvas = (w, h, ch) => Array.from({ length: h }, () => Array(w).fill(ch));
  const fill = (g, x0, y0, x1, y1, ch) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) g[y][x] = ch; };
  const border = (g, ch) => { const h = g.length, w = g[0].length; fill(g, 0, 0, w - 1, 0, ch); fill(g, 0, h - 1, w - 1, h - 1, ch); fill(g, 0, 0, 0, h - 1, ch); fill(g, w - 1, 0, w - 1, h - 1, ch); };
  const rows = g => g.map(r => r.join(''));
  const dots = (w, h) => Array.from({ length: h }, () => '.'.repeat(w));
  const zone = (id, name, mark, theme, rate, wild) => ({ id, name, mark, theme, element: null, rate, wild: wild.map(([key, min, max, weight]) => ({ key, min, max, weight })) });
  const warp = (id, x, y, look, map, tx, ty, facing) => ({ id, type: 'warp', x, y, look, to: { map, x: tx, y: ty, facing } });

  function blank(title) {
    const g = canvas(24, 18, '.');
    border(g, '#');
    fill(g, 3, 3, 7, 6, ','); fill(g, 16, 10, 20, 14, ',');
    g[2][11] = 'H'; g[2][13] = 'F';
    return {
      format: 2, title: title || 'My world',
      start: { map: 'home', x: 12, y: 9, facing: 'down' }, rules: { mains: 'all' },
      starters: clone(window.EP_DATA.world.starters), themes: allThemes(),
      zones: [zone('home', 'Home', 'h', 'meadow', 12, [['AF', 2, 4, 3], ['WA', 2, 4, 3], ['EW', 2, 4, 3], ['FE', 2, 4, 3]])],
      maps: [{ id: 'home', name: 'Home', zone: 'home', tiles: rows(g), zones: dots(24, 18), things: [
        { id: 'welcome', type: 'sign', x: 12, y: 7, lines: ['Welcome to your world!', 'Open the builder with ✎ to paint tiles, place people and trainers, and add new maps.'] },
      ] }],
      text: { guide: 'Guide', tutorial: ['{daemon} is ready. Walk into static, the flickering tiles, to meet wild daemons.'] },
    };
  }

  // The demo: a small town, a route, two houses and a shrine that use every kind of thing.
  function demo() {
    const town = canvas(30, 22, '.');
    border(town, '*');
    town[0][14] = town[0][15] = ':';
    fill(town, 14, 1, 15, 20, ':'); fill(town, 2, 10, 27, 11, ':');
    fill(town, 1, 1, 3, 2, '&'); fill(town, 26, 1, 28, 2, '&'); fill(town, 1, 19, 3, 20, '&'); fill(town, 26, 19, 28, 20, '&');
    fill(town, 3, 3, 9, 6, '#'); fill(town, 20, 3, 26, 7, '#');
    town[8][12] = 'H'; town[8][17] = 'F'; town[13][12] = 'L'; town[13][17] = 'L'; town[4][12] = 'L'; town[4][17] = 'L';
    fill(town, 3, 14, 8, 18, ','); fill(town, 21, 14, 26, 17, ',');
    fill(town, 9, 16, 12, 19, '~'); fill(town, 9, 15, 12, 15, '|');
    const house = canvas(10, 8, '.');
    border(house, '#');
    house[1][1] = house[1][2] = 'B'; house[1][7] = house[1][8] = 'T'; house[1][5] = 'H';
    fill(house, 3, 3, 6, 4, '&');
    const lab = canvas(12, 9, '.');
    border(lab, '#');
    fill(lab, 2, 1, 9, 1, 'T'); lab[1][1] = lab[1][10] = 'B'; lab[4][2] = lab[4][9] = 'x';
    const route = canvas(20, 30, '.');
    border(route, '*');
    route[29][9] = route[29][10] = ':';
    fill(route, 1, 4, 18, 4, '|'); route[4][9] = route[4][10] = '1';
    fill(route, 9, 5, 10, 28, ':'); fill(route, 9, 1, 10, 3, ':');
    fill(route, 2, 20, 7, 26, ','); fill(route, 12, 18, 17, 24, ','); fill(route, 2, 8, 6, 13, ',');
    fill(route, 12, 7, 17, 13, '_'); route[10][14] = route[12][16] = 'o'; route[9][12] = 'o';
    fill(route, 1, 16, 18, 16, '~'); route[16][9] = route[16][10] = '=';
    route[15][3] = route[15][4] = route[26][15] = route[27][16] = route[2][3] = route[2][16] = '*';
    route[1][9] = '.';
    const shrine = canvas(14, 12, '.');
    border(shrine, '#');
    shrine[1][1] = shrine[1][12] = shrine[10][1] = shrine[10][12] = '+';
    shrine[4][3] = shrine[4][10] = shrine[7][3] = shrine[7][10] = 'x';
    shrine[1][11] = 'R'; shrine[1][2] = 'H';
    return {
      format: 2, title: 'Brightwater (demo)', about: 'A small example world: a town, a route with an ice patch, a Warden\'s lab and a shrine. Open it in the builder to see how it is made.', author: 'Essence Protocol',
      start: { map: 'town', x: 15, y: 13, facing: 'up' }, rules: { mains: 'all' },
      starters: clone(window.EP_DATA.world.starters), themes: allThemes(),
      zones: [
        zone('brightwater', 'Brightwater', 'b', 'meadow', 12, [['AF', 2, 4, 3], ['WA', 2, 4, 3], ['EW', 3, 5, 2], ['FE', 3, 5, 2]]),
        zone('house', 'Mira\'s House', 'h', 'hearth', 0, []),
        zone('lab', 'Oda\'s Lab', 'l', 'nexus', 0, []),
        zone('route', 'Static Route', 'r', 'air', 14, [['AA', 4, 7, 3], ['AE', 5, 7, 3], ['AF', 5, 8, 2], ['WA', 4, 6, 2], ['AA-Ga1', 7, 8, 1]]),
        zone('shrine', 'Crystal Shrine', 's', 'dusk', 0, []),
      ],
      maps: [
        { id: 'town', name: 'Brightwater', zone: 'brightwater', tiles: rows(town), zones: dots(30, 22), things: [
          warp('town-house', 6, 6, 'door', 'house', 4, 6, 'up'),
          warp('town-lab', 23, 7, 'door', 'lab', 5, 7, 'up'),
          warp('town-north-a', 14, 0, 'hidden', 'route', 9, 28, 'up'),
          warp('town-north-b', 15, 0, 'hidden', 'route', 10, 28, 'up'),
          { id: 'town-sign', type: 'sign', x: 13, y: 12, lines: ['Brightwater.', 'North: the Static Route. East: Warden Oda\'s lab. West: Mira\'s house.'] },
          { id: 'pip', type: 'person', x: 20, y: 12, name: 'Pip', facing: 'left', color: '#ffb45a', lines: ['New in town? Take these. Weaken a wild daemon, then Bind it.'], gives: { lattices: 3 }, after: ['Static tiles are where the wild daemons hide.'] },
          { id: 'kai', type: 'person', x: 8, y: 12, name: 'Kai', facing: 'up', lines: ['I heard the ice on the Static Route hides something shiny.', 'You slide on ice until something stops you. Aim for the corner.'] },
          { id: 'guard', type: 'person', x: 23, y: 8, name: 'Lab Guard', facing: 'down', color: '#8a9ab8', if: '!beat:sol', lines: ['Warden Oda only sees trainers who have beaten Sol on the Static Route.'] },
        ] },
        { id: 'house', name: 'Mira\'s House', zone: 'house', tiles: rows(house), zones: dots(10, 8), things: [
          warp('house-exit', 4, 7, 'door', 'town', 6, 7, 'down'),
          { id: 'mira', type: 'person', x: 7, y: 4, name: 'Mira', facing: 'left', color: '#ff8fb8', heal: true, lines: ['Oh, you\'re the new trainer! Let me patch your daemons up.', 'And take a few Lattices. Everyone needs more than they think.'], gives: { lattices: 5 }, after: ['Rest here whenever you like. I\'ll keep your daemons healthy.'] },
          { id: 'house-chest', type: 'chest', x: 1, y: 5, look: 'chest', gives: { motes: { F: 2, W: 2, E: 2, A: 2 } } },
        ] },
        { id: 'lab', name: 'Oda\'s Lab', zone: 'lab', tiles: rows(lab), zones: dots(12, 9), things: [
          warp('lab-exit', 5, 8, 'door', 'town', 23, 8, 'down'),
          { id: 'oda', type: 'trainer', x: 5, y: 2, name: 'Warden Oda', facing: 'down', sight: 0, warden: true, badge: 'Bright Key', team: [{ key: 'AW', level: 8 }, { key: 'EA', level: 9 }], intro: 'So Sol sent you. Show me what your daemon has learned.', outro: 'Well fought. Take the Bright Key: the gate on the Static Route will open for you.' },
          { id: 'lab-tech', type: 'trainer', x: 9, y: 6, name: 'Tech Juri', facing: 'left', sight: 3, team: [{ key: 'EW', level: 6 }], intro: 'Careful, the consoles are live!', outro: 'Okay, okay. The Warden is right up there.', gives: { cells: 1 } },
        ] },
        { id: 'route', name: 'Static Route', zone: 'route', tiles: rows(route), zones: dots(20, 30), things: [
          warp('route-south-a', 9, 29, 'hidden', 'town', 14, 1, 'down'),
          warp('route-south-b', 10, 29, 'hidden', 'town', 15, 1, 'down'),
          warp('route-stairs', 9, 1, 'stairs', 'shrine', 6, 9, 'up'),
          { id: 'route-sign', type: 'sign', x: 8, y: 27, lines: ['Static Route.', 'Wild daemons hide in the static. The gate to the north needs a Warden\'s key.'] },
          { id: 'sol', type: 'trainer', x: 8, y: 19, name: 'Operator Sol', facing: 'right', sight: 3, team: [{ key: 'FW', level: 6 }, { key: 'AF', level: 7 }], intro: 'Nobody gets past me without a battle!', outro: 'Fine, you win. Oda will want to meet you now.', gives: { lattices: 2 } },
          { id: 'rue', type: 'trainer', x: 11, y: 9, name: 'Operator Rue', facing: 'left', sight: 3, team: [{ key: 'EW-Ro1', level: 8 }], intro: 'The ice? Mine. The orb? Also mine.', outro: 'Take the orb, then. If you can reach it.' },
          { id: 'route-orb', type: 'chest', x: 18, y: 7, look: 'orb', gives: { daemon: { key: 'WA-Fr1', level: 8 } } },
          { id: 'route-note', type: 'trigger', x: 9, y: 5, lines: ['The gate hums. A Warden\'s key would open it.'], if: '!keys:1 !route-note-seen', sets: 'route-note-seen' },
        ] },
        { id: 'shrine', name: 'Crystal Shrine', zone: 'shrine', tiles: rows(shrine), zones: dots(14, 12), things: [
          warp('shrine-stairs', 6, 10, 'stairs', 'route', 9, 2, 'down'),
          { id: 'vale', type: 'trainer', x: 6, y: 3, name: 'Keeper Vale', facing: 'down', sight: 0, warden: true, final: true, badge: 'Crown Key', team: [{ key: 'FF-Em1', level: 12 }, { key: 'WW-Ti1', level: 12 }, { key: 'EE-St1', level: 13 }], intro: 'Few climb this far. Let the crystals judge us both.', outro: 'The shrine is yours. Brightwater has a new champion.' },
          { id: 'shrine-hum', type: 'trigger', x: 6, y: 8, lines: ['The crystals hum as you climb the last step.'], if: '!shrine-entered', sets: 'shrine-entered' },
        ] },
      ],
      text: {
        guide: 'Mira', tutorial: ['{daemon}! What a lovely first daemon.', 'Walk into static to meet wild daemons, and come see me in my house if you get hurt.'],
        ending: ['Keeper Vale bows. Brightwater\'s lattice is yours to explore.', 'That was the demo. Open it in the builder (✎) to see how every piece is made, then build your own.'],
      },
    };
  }
  function remix() {
    const w = official();
    w.title = 'Essence Protocol (remix)';
    w.about = 'My own copy of the original world.';
    for (const t of LIBRARY) if (!w.themes.some(x => x.id === t.id)) w.themes.push(clone(t));
    return w;
  }
  const TEMPLATES = [
    ['demo', 'Brightwater (demo)', 'A little town, a route, a Warden and a shrine. Every kind of thing, ready to take apart.', demo],
    ['blank', 'Empty map', 'One room with some static and a terminal. Start from scratch.', () => blank('My world')],
    ['remix', 'Remix the original', 'A copy of Essence Protocol itself, all five zones and the Architect.', remix],
  ];

  // ---------------------------------------------------------------- import and export
  const b64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  const unb64 = str => { const s = atob(str.replace(/-/g, '+').replace(/_/g, '/')); const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; };
  // a world file: the canonical JSON layout, so it diffs well and Claude Code can apply it
  const fileText = world => SC.format({ format: FORMAT, world });
  // a world code: the same, compressed to paste in a message
  async function code(world) {
    const bytes = new TextEncoder().encode(JSON.stringify(world));
    if (typeof CompressionStream === 'undefined') return 'EPW0:' + b64(bytes);
    const out = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
    return 'EPW1:' + b64(out);
  }
  async function parse(text) {
    text = String(text || '').trim();
    let obj;
    if (/^EPW[01]:/.test(text)) {
      const bytes = unb64(text.slice(5).replace(/\s+/g, ''));
      if (text[3] === '0') obj = JSON.parse(new TextDecoder().decode(bytes));
      else {
        if (typeof DecompressionStream === 'undefined') throw new Error('this browser can\'t unpack world codes; import the .json file instead');
        obj = JSON.parse(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text());
      }
    } else obj = JSON.parse(text);
    const w = obj && obj.format === FORMAT ? obj.world : obj;
    if (!w || !Array.isArray(w.maps) || !Array.isArray(w.zones) || !w.maps.length) throw new Error('that is not an Essence Protocol world');
    return normalize(w);
  }
  // fills in what an imported world leaves out, so the builder and the game can open it
  function normalize(w) {
    w = clone(w);
    w.format = 2;
    w.title = String(w.title || 'Imported world').slice(0, 40);
    if (!Array.isArray(w.themes) || !w.themes.length) w.themes = allThemes();
    if (!Array.isArray(w.starters) || !w.starters.length) w.starters = clone(window.EP_DATA.world.starters);
    if (!w.rules) w.rules = { mains: 'all' };
    if (!w.text) w.text = { guide: 'Guide', tutorial: ['{daemon} is ready.'] };
    for (const m of w.maps) { m.things = m.things || []; if (!Array.isArray(m.zones)) m.zones = dots(String(m.tiles[0]).length, m.tiles.length); }
    if (!w.start || !w.maps.some(m => m.id === w.start.map)) w.start = { map: w.maps[0].id, x: 1, y: 1, facing: 'down' };
    return w;
  }
  async function download(name, text) {
    try {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      return true;
    } catch (e) { return false; }
  }
  const slug = s => String(s || 'world').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'world';
  // shows text to copy (the clipboard is not always allowed, e.g. inside a hosted frame)
  async function showCopy(title, text, note) {
    let copied = false;
    try { await navigator.clipboard.writeText(text); copied = true; } catch (e) { /* not allowed here */ }
    const card = G.modal(`<h2>${esc(title)}</h2><p>${copied ? 'Copied to the clipboard.' : 'Select it all and copy it.'} ${esc(note || '')}</p><textarea class="bw-in" style="width:100%;min-height:160px;font-family:monospace;font-size:12px" readonly>${esc(text)}</textarea><div class="btnrow"><button class="btn pri" data-ok>Done</button></div>`);
    const ta = card.querySelector('textarea'); ta.focus(); ta.select();
    card.querySelector('[data-ok]').onclick = () => G.closeModal();
  }

  // ---------------------------------------------------------------- the Worlds screen
  let root = null;
  function mount() {
    if (root) return root;
    root = document.createElement('section');
    root.id = 'worlds'; root.className = 'screen hidden';
    document.body.appendChild(root);
    root.addEventListener('click', onClick);
    return root;
  }
  const when = t => { const d = (Date.now() - t) / 1000; return d < 60 ? 'just now' : d < 3600 ? Math.round(d / 60) + ' min ago' : d < 86400 ? Math.round(d / 3600) + ' h ago' : new Date(t).toLocaleDateString(); };
  function render() {
    const mine = list();
    root.innerHTML = `<div class="wrap">
      <div class="bw-row spread"><h2>Worlds</h2><button class="bw-btn icon" data-act="close" aria-label="Back to the title">✕</button></div>
      <p class="bw-dim">Play the original, or make your own: paint maps, place people, trainers, signs, chests and doors, set up zones of wild daemons, then play what you made. Your worlds stay in this browser; export one to keep it or share it.</p>
      <div class="w-cards">
        <div class="w-card official"><canvas class="w-prev" data-mini="main"></canvas><div class="w-body"><div class="w-title">Essence Protocol</div><div class="bw-dim">The original world: four Wardens, four keys and the Architect.</div>
          <div class="bw-row"><button class="bw-btn pri" data-act="play-main">${hasSave('main') ? '▶ Continue' : '▶ Play'}</button><button class="bw-btn" data-act="remix">Remix</button></div></div></div>
        ${mine.map(m => `<div class="w-card"><canvas class="w-prev" data-mini="${esc(m.id)}"></canvas><div class="w-body"><div class="w-title">${esc(m.title)}</div><div class="bw-dim">${m.maps} map${m.maps === 1 ? '' : 's'} · ${m.things} thing${m.things === 1 ? '' : 's'} · edited ${when(m.updated)}</div>
          <div class="bw-row"><button class="bw-btn pri" data-act="play" data-id="${esc(m.id)}">${hasSave(m.id) ? '▶ Continue' : '▶ Play'}</button><button class="bw-btn warn" data-act="build" data-id="${esc(m.id)}">✎ Build</button><button class="bw-btn icon" data-act="more" data-id="${esc(m.id)}" aria-label="More">⋯</button></div></div></div>`).join('')}
      </div>
      <div class="bw-h">Start a new world</div>
      <div class="w-tpls">${TEMPLATES.map(([id, name, text]) => `<button class="w-tpl" data-act="new" data-tpl="${id}"><b>${esc(name)}</b><span>${esc(text)}</span></button>`).join('')}
        <button class="w-tpl" data-act="import"><b>Import a world</b><span>A world file (.json) or a world code someone shared with you.</span></button></div>
    </div>`;
    for (const c of root.querySelectorAll('canvas[data-mini]')) {
      const w = c.dataset.mini === 'main' ? window.EP_DATA.world : get(c.dataset.mini);
      if (w) try { WR.mini(c, w, w.start && w.start.map); } catch (e) { /* a broken world just has no preview */ }
    }
  }
  function open() {
    mount(); render();
    G.hideScreens();
    G.mode = 'worlds';
    root.classList.remove('hidden');
    root.scrollTop = 0;
  }
  function close(toTitle) { if (!root) return; root.classList.add('hidden'); if (toTitle !== false) G.toTitle(); }

  function play(id, fresh) {
    const w = get(id);
    if (!w) return G.toast('That world is gone.', 'bad');
    close(false);
    G.useWorld(CT.withWorld(w), 'ep-save:' + id, { id, test: false });
    G.playWorld(fresh);
  }
  async function onClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = b.dataset.id, act = b.dataset.act;
    if (act === 'close') return close();
    if (act === 'play-main') {
      close(false); G.useWorld(null);
      const saved = G.loadSave();
      if (saved) G.playWorld(false); else G.playWorld(true);
      return;
    }
    if (act === 'play') {
      if (hasSave(id)) {
        const c = await G.choose('Play', 'Continue where you left off, or start this world over?', ['Continue', 'Start over', 'Cancel']);
        if (c === 2) return;
        if (c === 1) { drop('ep-save:' + id); return play(id, true); }
      }
      return play(id, false);
    }
    if (act === 'build') { close(false); return window.BUILD.open(id); }
    if (act === 'remix') { const nid = create(remix()); if (nid) { close(false); window.BUILD.open(nid); } return; }
    if (act === 'new') {
      const t = TEMPLATES.find(x => x[0] === b.dataset.tpl);
      const w = t[3]();
      const nid = create(w);
      if (nid) { close(false); window.BUILD.open(nid); }
      return;
    }
    if (act === 'import') return importDialog();
    if (act === 'more') return moreMenu(id);
  }
  async function moreMenu(id) {
    const w = get(id); if (!w) return;
    const c = await G.choose(w.title, 'What do you want to do with this world?', ['Export a file', 'Copy a world code', 'Duplicate', 'Delete…', 'Cancel']);
    if (c === 0) { if (!(await download(slug(w.title) + '.world.json', fileText(w)))) showCopy('World file', fileText(w)); }
    else if (c === 1) showCopy('World code', await code(w), 'Anyone can paste it into Import a world.');
    else if (c === 2) { const copy = clone(w); copy.title = (w.title + ' copy').slice(0, 40); create(copy); render(); }
    else if (c === 3) {
      if ((await G.choose('Delete this world?', `${w.title} and its saves are erased from this browser. Export it first if you might want it back.`, ['Delete', 'Cancel'])) === 0) { remove(id); render(); }
    }
  }
  function importDialog() {
    const card = G.modal(`<h2>Import a world</h2><p>Paste a world code or the contents of a world file, or open the file.</p>
      <textarea class="bw-in" id="wImport" style="width:100%;min-height:140px;font-family:monospace;font-size:12px" placeholder="EPW1:… or { &quot;format&quot;: … }"></textarea>
      <div class="btnrow"><button class="btn pri" data-go>Import</button><label class="btn">Open a file<input type="file" accept=".json,application/json,text/plain" hidden id="wFile"></label><button class="btn" data-cancel>Cancel</button></div>`);
    const ta = card.querySelector('#wImport');
    const go = async text => {
      try { const w = await parse(text); const nid = create(w); G.closeModal(); if (nid) { render(); G.toast(`Imported <b>${esc(w.title)}</b>.`); } }
      catch (err) { G.toast('Couldn\'t import: ' + esc(err.message), 'bad'); }
    };
    card.querySelector('[data-go]').onclick = () => go(ta.value);
    card.querySelector('[data-cancel]').onclick = () => G.closeModal();
    card.querySelector('#wFile').onchange = e => { const f = e.target.files[0]; if (f) f.text().then(go); };
  }

  window.WORLDS = { list, get, save, create, remove, duplicate: id => { const w = get(id); return w ? create(Object.assign(clone(w), { title: (w.title + ' copy').slice(0, 40) })) : null; },
    open, close, play, templates: { demo, blank, remix }, LIBRARY, allThemes, fileText, code, parse, normalize, download, showCopy, slug, FORMAT, hasSave };
})();
