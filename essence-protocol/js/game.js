/* Essence Protocol: game shell (overworld, battle UI, composer, menus, forge,
   requests, rift). Rules live in engine.js and outcomes in merges.baked.js;
   this file only presents them. */
(function () {
  'use strict';
  const E = window.ESSENCE, ENG = window.ENGINE, C = window.CONTENT, SP = window.SPRITES, M = window.MERGES;
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const rnd = n => Math.floor(Math.random() * n);
  const SAVE_KEY = 'essence-protocol-save-v1';
  const RARITY = ['Base', 'Compound', 'Resonant', 'Trinity', 'Anomaly'];
  const TIER = ['Seed', 'Build', 'Release', 'Prime'];
  const ALL_KEYS = Object.keys(M.table);
  const BY_TIER = [0, 1, 2, 3].map(t => ALL_KEYS.filter(k => E.parseKey(k).subs.length === t));
  const pairTotal = pk => (pk[0] === pk[1] ? 64 : 470);

  // ------------------------------------------------------------------ state
  let S = null;
  let discovered = new Set(), seen = new Set(), boundForms = new Set();
  let B = null, bctx = null, ui = null, riftRun = null;
  let mode = 'title'; // title | starter | world | busy | sheet | battle
  let sheetTab = 'party', detailUid = null, codexView = 'merges', codexFilter = 'all', codexSearch = '';
  let pendingXp = [];
  let skipping = false;
  let muted = false;
  const map = C.buildMap();
  const npcs = map.npcs.map(n => Object.assign({}, n));

  function defaults(s) {
    s.settings = Object.assign({ speed: 'normal', tips: 'compact' }, s.settings || {});
    s.tips = s.tips || [];
    s.quests = s.quests || [];
    s.stats = Object.assign({ reacts: 0, wild: 0, forged: 0, binds: 0 }, s.stats || {});
    s.rift = Object.assign({ best: 0 }, s.rift || {});
    s.prisms = s.prisms || [];
    s.milestone = s.milestone || 0;
    s.rematches = s.rematches || {};
    s.sinceFight = s.sinceFight || 0;
    return s;
  }

  function newState(starter) {
    const d = ENG.createDaemon(starter.key, 5, { attune: starter.attune, extraAttune: 0 });
    const p = E.parseKey(starter.key);
    d.memory = [p.a + p.b, p.b + p.a, p.a + p.a, p.b + p.b];
    return defaults({
      v: 1, party: [d], box: [], bag: { 'lattice:basic': basicLattice(5) },
      motes: {}, discovered: [], seen: [starter.key], bound: [starter.key], badges: 0, keys: [], beaten: [],
      pos: { x: map.spawn.x, y: map.spawn.y, dir: 'down' }, lastHeal: { x: map.heal.x, y: map.heal.y }, steps: 0, won: false, started: Date.now(),
    });
  }
  function basicLattice(n) { return { id: 'lattice:basic', kind: 'lattice', name: 'Basic Lattice', power: 1, count: n }; }

  function save() {
    if (!S) return;
    S.discovered = [...discovered]; S.seen = [...seen]; S.bound = [...boundForms];
    S.pos = { x: player.x, y: player.y, dir: player.dir };
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(S)); } catch (e) { /* storage unavailable */ }
  }
  function loadSave() {
    try { const raw = localStorage.getItem(SAVE_KEY); if (!raw) return null; const s = JSON.parse(raw); return s && s.v === 1 ? s : null; } catch (e) { return null; }
  }
  function adopt(s) {
    S = defaults(s);
    discovered = new Set(s.discovered); seen = new Set(s.seen); boundForms = new Set(s.bound);
    for (const list of [S.party, S.box]) for (const d of list) d.memory = d.memory.map(k => (k && M.table[k] ? k : null));
    player.x = player.px = s.pos.x; player.y = player.py = s.pos.y; player.dir = s.pos.dir || 'down';
    follower.x = follower.px = player.x; follower.y = follower.py = player.y;
    ensureQuests();
  }

  // ------------------------------------------------------------------ helpers
  const MAINC = m => E.MAIN[m].color;
  const subColor = s => SP.ACCENT[s];
  function essChip(code, extra) {
    if (E.MAIN[code]) return `<span class="ess" data-tip="e:${code}" style="color:${MAINC(code)}"><i></i>${E.MAIN[code].name}${extra ? ` <small>${extra}</small>` : ''}</span>`;
    return `<span class="ess sub" data-tip="e:${code}" style="color:${subColor(code)}"><i></i>${E.SUB[code].name}${extra ? ` <small>${extra}</small>` : ''}</span>`;
  }
  function genomeHTML(key) {
    const p = E.parseKey(key);
    let h = `<span class="genome">${essChip(p.a, p.a === p.b ? 'pure' : 'lead')}${p.a !== p.b ? `<span class="arrow">+</span>${essChip(p.b, 'follow')}` : ''}`;
    for (const t of p.subs) h += essChip(t.s, '→ ' + E.MAIN[E.hostMain(p, t.h)].name);
    return h + '</span>';
  }
  // Compact genome: a dot per main, a diamond per sub.
  function genomeDots(key) {
    const p = E.parseKey(key);
    let h = `<span class="gdots"><i class="gm" data-tip="e:${p.a}" style="background:${MAINC(p.a)}"></i>${p.a !== p.b ? `<i class="gm" data-tip="e:${p.b}" style="background:${MAINC(p.b)}"></i>` : ''}`;
    for (const t of p.subs) h += `<i class="gs" data-tip="e:${t.s}" style="background:${subColor(t.s)}"></i>`;
    return h + '</span>';
  }
  const dName = d => d.nick || ENG.rec(d.key).dName;
  function toast(html, cls, ms) {
    const t = document.createElement('div'); t.className = 'toast ' + (cls || ''); t.innerHTML = html;
    t.style.animationDuration = (ms || 3200) + 'ms';
    $('toasts').appendChild(t); setTimeout(() => t.remove(), (ms || 3200) + 100);
  }
  function tip(id, text) {
    if (!S || S.tips.includes(id)) return;
    S.tips.push(id);
    toast(`<b>Tip</b> ${esc(text)}`, 'tip', 6500);
  }
  const mergeLabel = key => (discovered.has(key) ? ENG.rec(key).name : 'Unknown merge');
  const statTotal = key => ENG.rec(key).dStats.reduce((a, b) => a + b, 0);
  function lore(key) {
    const p = E.parseKey(key), r = ENG.rec(key), n = p.subs.length;
    const A = E.MAIN[p.a].name, Bn = E.MAIN[p.b].name;
    const an = w => (/^[AEIOU]/.test(w) ? 'An ' : 'A ') + w;
    let s = `${TIER[n]}-tier daemon. ${p.a === p.b ? `A pure ${A} kernel.` : `${an(A)} kernel braided with ${Bn}.`}`;
    if (n) s += ` It has grown ${p.subs.map(t => `${E.SUB[t.s].name} on its ${E.MAIN[E.hostMain(p, t.h)].name} ${p.a === p.b ? 'core' : t.h === 1 ? 'lead' : 'follow'}`).join(', ')}.`;
    const role = { Strike: 'breaking through', Barrage: 'overwhelming numbers', Siphon: 'outlasting its prey', Hex: 'crippling its foes', Ward: 'holding the line', Mend: 'self-repair', Field: 'reshaping the arena' }[r.cls];
    return s + ` Its signature merge, ${discovered.has(key) ? r.name : 'still undiscovered'}, is built for ${role}.`;
  }
  function resonancesFound() {
    const out = new Set();
    for (const k of discovered) for (const t of ENG.rec(k).tags) out.add(t);
    return out;
  }
  const countPair = pk => { let n = 0; for (const k of discovered) if (k[0] === pk[0] && k[1] === pk[1]) n++; return n; };

  function markDiscovered(key, silent) {
    if (discovered.has(key)) return;
    discovered.add(key);
    const r = ENG.rec(key);
    if (!silent) toast(`◈ New merge: <b>${esc(r.name)}</b> <span class="rar r${r.rarity}">${RARITY[r.rarity]}</span>`, r.rarity >= 3 ? 'myth' : r.rarity === 2 ? 'rare' : '');
    if (S) {
      questEvent('discover'); questEvent('pair', { key }); questEvent('resonant', { rarity: r.rarity });
      const m = Math.floor(discovered.size / 50);
      if (m > S.milestone) {
        S.milestone = m;
        const rw = { lattices: 2, motes: {} };
        for (let i = 0; i < 3; i++) { const s = E.SUB_ORDER[rnd(16)]; rw.motes[s] = (rw.motes[s] || 0) + 1; }
        grant(rw);
        toast(`★ Codex milestone: ${m * 50} merges! Reward: ${rewardText(rw)}`, 'quest', 5500);
      }
    }
    updateHud();
  }

  // Adds one sub to a key (for rematches and rogue spawns). Random or first legal.
  function upgradeKey(key, random) {
    const p = E.parseKey(key);
    if (p.subs.length >= 3) return key;
    const opts = E.slotsFor(p.a, p.b).filter(t => !p.subs.some(u => u.s === t.s && u.h === t.h)).map(t => E.makeKey(p.a, p.b, p.subs.concat([t]))).filter(k => M.table[k]);
    if (!opts.length) return key;
    return random ? opts[rnd(opts.length)] : opts[0];
  }
  const partyAvg = () => Math.round(S.party.reduce((s, d) => s + d.level, 0) / S.party.length);

  // ------------------------------------------------------------------ requests
  const QUEST_TYPES = ['discover', 'pair', 'bind', 'react', 'defeat', 'resonant', 'forge'];
  function unlockedMains() { return ['A', 'F', 'W', 'E'].slice(0, Math.min(4, S.badges + 1)); }
  function makeReward() {
    const roll = rnd(4);
    if (roll === 0) return { lattices: 3 };
    if (roll === 1) { const a = E.SUB_ORDER[rnd(16)], b = E.SUB_ORDER[rnd(16)]; const m = {}; m[a] = 2; m[b] = (m[b] || 0) + 2; return { motes: m }; }
    if (roll === 2) { const m = {}; m[E.MAINS[rnd(4)]] = 6; return { motes: m }; }
    return { cells: 1, lattices: 1 };
  }
  function makeQuest(type) {
    const q = { id: 'q' + Date.now().toString(36) + rnd(1e6).toString(36), type, progress: 0, target: 1 };
    if (type === 'discover') { q.target = 4 + rnd(5); q.text = `Discover ${q.target} new merges`; }
    else if (type === 'pair') {
      const ms = [...new Set(S.party.flatMap(d => ENG.mainsOf(d.key)))];
      const a = ms[rnd(ms.length)], b = ms[rnd(ms.length)];
      q.param = a + b; q.target = 2; q.text = `Discover 2 new ${E.MAIN[a].name} › ${E.MAIN[b].name} merges`;
    } else if (type === 'bind') { const els = unlockedMains(); q.param = els[rnd(els.length)]; q.text = `Bind a ${E.MAIN[q.param].name}-led daemon`; }
    else if (type === 'react') { q.target = 3; q.text = 'Trigger 3 residue reactions in battle'; }
    else if (type === 'defeat') { q.target = 5 + rnd(4); q.text = `Defeat ${q.target} wild daemons`; }
    else if (type === 'resonant') { q.text = 'Discover a Resonant, Trinity or Anomaly merge'; }
    else if (type === 'forge') { q.target = 2; q.text = 'Forge 2 items at the Nexus Forge'; }
    q.reward = makeReward();
    return q;
  }
  function rewardText(r) {
    const bits = [];
    if (r.lattices) bits.push(`${r.lattices} Lattice${r.lattices > 1 ? 's' : ''}`);
    if (r.cells) bits.push(`${r.cells} Flux Cell`);
    if (r.motes) for (const [k, n] of Object.entries(r.motes)) bits.push(`${n} ${E.MAIN[k] ? E.MAIN[k].name : E.SUB[k].name} motes`);
    return bits.join(', ');
  }
  function grant(r) {
    if (r.lattices) { const l = S.bag['lattice:basic'] || (S.bag['lattice:basic'] = basicLattice(0)); l.count += r.lattices; }
    if (r.cells) { const c = S.bag['cell:basic'] || (S.bag['cell:basic'] = { id: 'cell:basic', kind: 'cell', name: 'Flux Cell', count: 0 }); c.count += r.cells; }
    if (r.motes) for (const [k, n] of Object.entries(r.motes)) S.motes[k] = (S.motes[k] || 0) + n;
  }
  function ensureQuests() {
    while (S.quests.length < 3) {
      const used = new Set(S.quests.map(q => q.type));
      const pool = QUEST_TYPES.filter(t => !used.has(t));
      S.quests.push(makeQuest(pool[rnd(pool.length)]));
    }
  }
  function questEvent(type, data) {
    if (!S) return;
    let changed = false;
    for (const q of S.quests) {
      if (q.type !== type) continue;
      let inc = 1;
      if (type === 'pair') inc = data.key[0] === q.param[0] && data.key[1] === q.param[1] ? 1 : 0;
      else if (type === 'bind') inc = data.key[0] === q.param ? 1 : 0;
      else if (type === 'resonant') inc = data.rarity >= 2 ? 1 : 0;
      if (!inc) continue;
      q.progress = Math.min(q.target, q.progress + inc);
      if (q.progress >= q.target) {
        q.done = true; changed = true;
        grant(q.reward);
        beep(784, 0.1, 'triangle'); setTimeout(() => beep(1175, 0.18, 'triangle'), 110);
        toast(`✔ Request complete: <b>${esc(q.text)}</b><br>Reward: ${esc(rewardText(q.reward))}`, 'quest', 5500);
      }
    }
    if (changed) { S.quests = S.quests.filter(q => !q.done); ensureQuests(); }
  }

  // ------------------------------------------------------------------ audio
  let actx = null;
  function beep(freq, dur, type, vol) {
    if (muted) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = type || 'square'; o.frequency.value = freq;
      g.gain.setValueAtTime(vol || 0.04, actx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + dur);
      o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime + dur);
    } catch (e) { /* no audio */ }
  }
  const NOTE = { F: 392, W: 330, E: 196, A: 523 };
  function castSfx(key) { const p = E.parseKey(key); beep(NOTE[p.a], 0.12, 'square'); setTimeout(() => beep(NOTE[p.b] * 1.5, 0.12, 'triangle'), 70); p.subs.forEach((t, i) => setTimeout(() => beep(600 + i * 180, 0.08, 'sine'), 140 + i * 60)); }

  // ------------------------------------------------------------------ world
  const cv = $('world'), ctx = cv.getContext('2d');
  const TS = 16;
  let zoom = 3, dpr = 1, vignette = null;
  const player = { x: 0, y: 0, px: 0, py: 0, dir: 'down', moving: false, from: null, t: 0 };
  const follower = { x: 0, y: 0, px: 0, py: 0 };
  let held = null, lastTime = 0, animT = 0, spotted = null;
  const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
  const OPP = { up: 'down', down: 'up', left: 'right', right: 'left' };
  const rustle = new Map();

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.floor(innerWidth * dpr); cv.height = Math.floor(innerHeight * dpr);
    zoom = Math.max(2, Math.round(Math.min(innerWidth / (TS * 12), innerHeight / (TS * 11))));
    vignette = null;
    if (bctx && !$('battle').classList.contains('hidden')) drawBattleBg();
  }
  addEventListener('resize', resize);

  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const f = v => clamp(Math.round(v + (amt < 0 ? v * amt : (255 - v) * amt)), 0, 255);
    return '#' + [n >> 16 & 255, n >> 8 & 255, n & 255].map(v => f(v).toString(16).padStart(2, '0')).join('');
  }
  const THEME = {
    nexus:  { f1: '#141b2e', f2: '#172036', speck: '#22304f', line: '#243457', wall: '#0c1120', face: '#1d2846', trim: '#46f3ff', grass: ['#15443f', '#23796b', '#7ffff0'], obst: '#46f3ff', accent: '#46f3ff', rgb: '70,243,255', part: 'data', sky: ['#050814', '#111a33'] },
    fringe: { f1: '#141c2c', f2: '#172233', speck: '#223449', line: '#243c55', wall: '#0b1320', face: '#1b2c44', trim: '#7ffff0', grass: ['#15443f', '#23796b', '#7ffff0'], obst: '#46f3ff', accent: '#5fe0d0', rgb: '95,224,208', part: 'data', sky: ['#050b12', '#0f2230'] },
    air:    { f1: '#15303a', f2: '#183641', speck: '#24505c', line: '#235563', wall: '#0a1b22', face: '#1f4a57', trim: '#bff8ee', grass: ['#1f6a60', '#3fae98', '#e2fff8'], obst: '#dff6fa', accent: '#8fe6d4', rgb: '143,230,212', part: 'wind', sky: ['#0b2230', '#2d6474'] },
    fire:   { f1: '#2c1813', f2: '#321b15', speck: '#46261c', line: '#4f2b1f', wall: '#150a07', face: '#3d1d14', trim: '#ff8a3d', grass: ['#6d2c14', '#b4522a', '#ffc27a'], obst: '#ff6b1a', accent: '#ff6b3d', rgb: '255,107,61', part: 'ember', sky: ['#120505', '#4a160c'] },
    water:  { f1: '#0f213b', f2: '#122644', speck: '#1b365c', line: '#1c3b66', wall: '#060e1b', face: '#16335a', trim: '#6cc4ff', grass: ['#18507f', '#2a7cbc', '#aadcff'], obst: '#1c5fb0', accent: '#3aa6ff', rgb: '58,166,255', part: 'bubble', sky: ['#030a18', '#123a6a'] },
    earth:  { f1: '#2a2217', f2: '#2f261a', speck: '#3e3222', line: '#463826', wall: '#130e08', face: '#3a2d1c', trim: '#e0b060', grass: ['#56451c', '#86672c', '#efd49c'], obst: '#6b5a45', accent: '#c9913d', rgb: '201,145,61', part: 'dust', sky: ['#0d0904', '#3c2c16'] },
    core:   { f1: '#160d27', f2: '#1a102f', speck: '#281a45', line: '#2e1d52', wall: '#090512', face: '#26164a', trim: '#b48cff', grass: ['#3a2466', '#6a3fbf', '#e0c8ff'], obst: '#6a3fbf', accent: '#b48cff', rgb: '180,140,255', part: 'spark', sky: ['#07030f', '#2a1552'] },
  };
  for (const t of Object.values(THEME)) { t.face2 = shade(t.face, -0.4); t.blade = shade(t.grass[1], -0.15); t.obst2 = shade(t.obst, -0.25); t.obst3 = shade(t.obst, 0.25); }

  const tileAt = (x, y) => (map.tiles[y] || '')[x] || '#';
  const zoneAt = (x, y) => (map.zone[y] || [])[x] || 'nexus';
  const npcAt = (x, y) => npcs.find(n => n.x === x && n.y === y);
  const gateOpen = ch => C.GATES[ch] != null && S && S.badges >= C.GATES[ch];
  function passable(x, y) {
    const ch = tileAt(x, y);
    if (C.SOLID.has(ch) && !gateOpen(ch)) return false;
    return !npcAt(x, y);
  }
  function hash2(x, y) { let h = x * 374761393 + y * 668265263; h = (h ^ (h >> 13)) * 1274126177; return (h ^ (h >> 16)) >>> 0; }

  function drawTile(x, y, sx, sy, s, lights) {
    const ch = tileAt(x, y), th = THEME[zoneAt(x, y)] || THEME.nexus, h = hash2(x, y), u = s / 16;
    if (ch === '#') {
      ctx.fillStyle = th.wall; ctx.fillRect(sx, sy, s, s);
      if (tileAt(x, y + 1) !== '#') {
        // front face of a wall block (the 2.5D part)
        const fy = sy + s * 0.4;
        ctx.fillStyle = th.face; ctx.fillRect(sx, fy, s, s * 0.6);
        ctx.fillStyle = th.face2; ctx.fillRect(sx, fy + s * 0.38, s, s * 0.22);
        ctx.fillStyle = 'rgba(0,0,0,.28)';
        for (let i = 2; i < 16; i += 5) ctx.fillRect(sx + (i + (y % 2) * 2) * u, fy + 1.5 * u, 0.6 * u, s * 0.5);
        ctx.globalAlpha = 0.5 + 0.3 * Math.sin(animT * 2 + x * 0.7);
        ctx.fillStyle = th.trim; ctx.fillRect(sx, fy - 0.5 * u, s, 0.9 * u);
        ctx.globalAlpha = 1;
        if (h % 7 === 0) { ctx.fillStyle = th.trim; ctx.fillRect(sx + 7 * u, fy + 4 * u, 2 * u, u); lights.push([sx + 8 * u, fy + 4.5 * u, s * 0.7, th.rgb, 0.18]); }
      } else if (h % 11 === 0) { ctx.fillStyle = th.face; ctx.fillRect(sx + 6 * u, sy + 6 * u, u, u); }
      return;
    }
    // floor
    ctx.fillStyle = (x + y) % 2 ? th.f1 : th.f2; ctx.fillRect(sx, sy, s, s);
    ctx.fillStyle = th.speck; ctx.fillRect(sx + (h % 14 + 1) * u, sy + ((h >> 5) % 14 + 1) * u, u, u);
    if (h % 6 === 0) {
      const ox = (h >> 3) % 7 + 2;
      ctx.fillStyle = th.line;
      ctx.fillRect(sx + ox * u, sy + 8 * u, 6 * u, 0.7 * u); ctx.fillRect(sx + ox * u, sy + 8 * u, 0.7 * u, 5 * u); ctx.fillRect(sx + (ox + 5.5) * u, sy + 7.5 * u, 1.6 * u, 1.6 * u);
    }
    if (tileAt(x, y - 1) === '#') { ctx.fillStyle = 'rgba(0,0,0,.4)'; ctx.fillRect(sx, sy, s, 3 * u); ctx.fillStyle = 'rgba(0,0,0,.18)'; ctx.fillRect(sx, sy + 3 * u, s, 2 * u); }
    if (tileAt(x - 1, y) === '#') { ctx.fillStyle = 'rgba(0,0,0,.22)'; ctx.fillRect(sx, sy, 2 * u, s); }
    if (tileAt(x + 1, y) === '#') { ctx.fillStyle = 'rgba(0,0,0,.22)'; ctx.fillRect(sx + s - 2 * u, sy, 2 * u, s); }
    switch (ch) {
      case ',': {
        const [c1, c2, c3] = th.grass;
        const r = rustle.get(x + ',' + y), age = r == null ? 9 : animT - r;
        const shake = age < 0.5 ? Math.sin(age * 40) * u * (0.5 - age) * 4 : 0;
        ctx.fillStyle = c1; ctx.fillRect(sx + u, sy + 3 * u, s - 2 * u, s - 4 * u);
        for (let i = 0; i < 7; i++) {
          const bx = sx + (1.5 + i * 2) * u, sway = Math.sin(animT * 2.2 + x * 0.9 + i) * u * 0.8 + shake;
          const bh = (6 + (hash2(x + i, y) % 5)) * u;
          ctx.fillStyle = i % 2 ? c2 : th.blade;
          ctx.fillRect(bx + sway * 0.5, sy + s - u - bh, u, bh);
          ctx.fillRect(bx + sway, sy + s - 2 * u - bh, u, u);
        }
        if ((h + Math.floor(animT * 6)) % 11 === 0) { ctx.fillStyle = c3; ctx.fillRect(sx + (h % 12 + 2) * u, sy + ((h >> 4) % 8 + 3) * u, u, u); }
        break;
      }
      case '~': {
        ctx.fillStyle = th.obst; ctx.fillRect(sx, sy, s, s);
        if (tileAt(x, y - 1) !== '~') { ctx.fillStyle = 'rgba(0,15,45,.45)'; ctx.fillRect(sx, sy, s, 3 * u); ctx.fillStyle = 'rgba(170,220,255,.5)'; ctx.fillRect(sx, sy + 3 * u, s, 0.7 * u); }
        ctx.fillStyle = 'rgba(170,220,255,.4)';
        const o = (animT * 5 + x * 5 + y * 3) % 16;
        ctx.fillRect(sx + (o % 12) * u, sy + 7 * u, 4 * u, 0.8 * u);
        ctx.fillRect(sx + ((o + 7) % 12) * u, sy + 12 * u, 3 * u, 0.8 * u);
        break;
      }
      case '^': {
        const g = 0.5 + 0.5 * Math.sin(animT * 3 + x + y);
        ctx.fillStyle = '#5a1a08'; ctx.fillRect(sx, sy, s, s);
        ctx.fillStyle = `rgb(255,${100 + 80 * g | 0},30)`; ctx.fillRect(sx + 1.5 * u, sy + 1.5 * u, 13 * u, 13 * u);
        ctx.fillStyle = '#ffe08a'; ctx.fillRect(sx + (h % 9 + 3) * u, sy + ((h >> 3) % 7 + 4) * u, 2 * u, 2 * u);
        if ((h + Math.floor(animT * 2)) % 5 === 0) { ctx.fillStyle = '#fff6c8'; ctx.fillRect(sx + (h % 11 + 2) * u, sy + 3 * u, u, u); }
        lights.push([sx + s / 2, sy + s / 2, s * 1.4, '255,110,30', 0.14 + 0.05 * g]);
        break;
      }
      case 'o': {
        ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(sx + 2 * u, sy + 12 * u, 13 * u, 3 * u);
        ctx.fillStyle = th.obst2; ctx.fillRect(sx + 2 * u, sy + 4 * u, 12 * u, 10 * u);
        ctx.fillStyle = th.obst; ctx.fillRect(sx + 2 * u, sy + 3 * u, 12 * u, 7 * u);
        ctx.fillStyle = th.obst3; ctx.fillRect(sx + 3 * u, sy + 3 * u, 7 * u, 2 * u);
        break;
      }
      case '*': {
        const b = Math.sin(animT * 2 + x) * u;
        ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.fillRect(sx + 3 * u, sy + 13 * u, 10 * u, 2 * u);
        ctx.fillStyle = '#7fb8c4'; ctx.fillRect(sx + 4 * u, sy + 8 * u, 8 * u, 6 * u);
        ctx.fillStyle = '#2c5b66'; ctx.fillRect(sx + 5 * u, sy + 9 * u, 6 * u, 2 * u);
        ctx.fillStyle = th.obst; ctx.beginPath(); ctx.arc(sx + 8 * u, sy + 5 * u + b, 4.5 * u, 0, 7); ctx.arc(sx + 5 * u, sy + 6 * u + b, 3 * u, 0, 7); ctx.arc(sx + 11 * u, sy + 6 * u + b, 3 * u, 0, 7); ctx.fill();
        break;
      }
      case 'x': {
        const g = 0.5 + 0.5 * Math.sin(animT * 2.5 + x);
        ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(sx + 2 * u, sy + 13 * u, 12 * u, 3 * u);
        ctx.fillStyle = '#2a1850'; ctx.fillRect(sx + 3 * u, sy - 8 * u, 10 * u, s + 6 * u);
        ctx.fillStyle = '#3d2672'; ctx.fillRect(sx + 3 * u, sy - 8 * u, 10 * u, 2 * u);
        ctx.fillStyle = `rgba(190,140,255,${0.45 + 0.5 * g})`; ctx.fillRect(sx + 7 * u, sy - 5 * u, 2 * u, 15 * u);
        lights.push([sx + s / 2, sy + 2 * u, s * 1.3, '180,140,255', 0.12 + 0.08 * g]);
        break;
      }
      case 'H': {
        ctx.fillStyle = '#0c1a16'; ctx.fillRect(sx + u, sy - 3 * u, 14 * u, 17 * u);
        ctx.fillStyle = '#12352b'; ctx.fillRect(sx + 2 * u, sy - 2 * u, 12 * u, 9 * u);
        ctx.fillStyle = '#5dff9a'; ctx.fillRect(sx + 7 * u, sy - u, 2 * u, 7 * u); ctx.fillRect(sx + 4.5 * u, sy + 1.5 * u, 7 * u, 2 * u);
        ctx.fillStyle = '#1d4a3c'; ctx.fillRect(sx + 3 * u, sy + 9 * u, 10 * u, 2 * u);
        lights.push([sx + s / 2, sy + 2 * u, s * 1.8, '93,255,154', 0.16 + 0.05 * Math.sin(animT * 3)]);
        break;
      }
      case 'F': {
        ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(sx + u, sy + 13 * u, 14 * u, 3 * u);
        ctx.fillStyle = '#2b1e17'; ctx.fillRect(sx + 2 * u, sy + 6 * u, 12 * u, 8 * u);
        ctx.fillStyle = '#4a342a'; ctx.fillRect(sx + u, sy + 5 * u, 14 * u, 3 * u);
        ctx.fillStyle = `rgba(255,190,90,${0.5 + 0.4 * Math.sin(animT * 4)})`; ctx.fillRect(sx + 4 * u, sy + 9 * u, 8 * u, 3 * u);
        ['#ff6b3d', '#3aa6ff', '#c9913d', '#8fe6d4'].forEach((c, i) => {
          const a = animT * 1.6 + i * Math.PI / 2;
          ctx.fillStyle = c; ctx.fillRect(sx + (8 + Math.cos(a) * 5) * u - u, sy + (2 + Math.sin(a) * 2) * u - u, 2 * u, 2 * u);
        });
        lights.push([sx + s / 2, sy + 6 * u, s * 1.8, '255,170,90', 0.16]);
        break;
      }
      case 'R': {
        const cx = sx + s / 2, cy = sy + s / 2;
        ctx.lineWidth = u * 1.2;
        for (let i = 0; i < 3; i++) {
          ctx.strokeStyle = ['#b48cff', '#46f3ff', '#ff5cf0'][i];
          ctx.beginPath(); ctx.arc(cx, cy, (6 - i * 1.6) * u, animT * (1.5 + i) + i, animT * (1.5 + i) + i + 4.2); ctx.stroke();
        }
        ctx.fillStyle = '#fff'; ctx.fillRect(cx - u / 2, cy - u / 2, u, u);
        lights.push([cx, cy, s * 2, '180,140,255', 0.22 + 0.08 * Math.sin(animT * 4)]);
        break;
      }
      case '2': case '3': case '4': case '5': {
        if (gateOpen(ch)) { ctx.fillStyle = 'rgba(70,243,255,.12)'; ctx.fillRect(sx, sy + 7 * u, s, 2 * u); break; }
        const g = 0.5 + 0.5 * Math.sin(animT * 5 + y);
        ctx.fillStyle = `rgba(255,84,112,${0.25 + 0.25 * g})`; ctx.fillRect(sx, sy, s, s);
        ctx.fillStyle = '#ffd0d8';
        for (let i = 0; i < 4; i++) ctx.fillRect(sx + (i * 4 + 1.5) * u, sy, 0.8 * u, s);
        lights.push([sx + s / 2, sy + s / 2, s * 1.2, '255,84,112', 0.14]);
        break;
      }
      default: break;
    }
  }

  // ---- people: 16x17 pixel templates, cached per palette/dir/frame
  const PT = {
    down: ['................', '.....HHHHHH.....', '....HHHHHHHH....', '....HSSSSSSH....', '....SVVVVVVS....', '....SVEVVEVS....', '.....SSSSSS.....', '....JJJJJJJJ....', '...JJjJLLJjJJ...', '...SJjJJJJjJS...', '...SJJJJJJJJS...', '....jjjjjjjj....'],
    up: ['................', '.....HHHHHH.....', '....HHHHHHHH....', '....HHHHHHHH....', '....HHHHHHHH....', '....SHHHHHHS....', '.....SSSSSS.....', '....JJJJJJJJ....', '...JJjJJJJjJJ...', '...SJjJJJJjJS...', '...SJJJJJJJJS...', '....jjjjjjjj....'],
    side: ['................', '.....HHHHHH.....', '....HHHHHHHH....', '....SSSSSHHH....', '...VVVVVSSHH....', '...VEVVSSSHH....', '.....SSSSSS.....', '.....JJJJJJ.....', '....JLJJJjJ.....', '....JSJJJjJ.....', '....JSJJJJJ.....', '.....jjjjjj.....'],
  };
  const PAL = {
    player: { id: 'p', H: '#46f3ff', S: '#f0c9a0', V: '#101421', E: '#c8feff', J: '#1f6f82', j: '#134653', L: 'rgba(255,255,255,.35)', P: '#1c2130', B: '#07090f', cape: '#46f3ff' },
    folk: { id: 'f', H: '#9aa6c8', S: '#e8c0a0', V: '#101421', E: '#ffe9a0', J: '#3a4466', j: '#262d45', L: 'rgba(255,255,255,.25)', P: '#1c2130', B: '#07090f', cape: '#3a4466' },
  };
  for (const z of ['air', 'fire', 'water', 'earth', 'core']) {
    const th = THEME[z];
    PAL[z] = { id: z, H: th.accent, S: '#e8c0a0', V: '#101421', E: th.trim, J: shade(th.accent, -0.45), j: shade(th.accent, -0.65), L: 'rgba(255,255,255,.25)', P: '#1c2130', B: '#07090f', cape: shade(th.accent, -0.2) };
  }
  const personCache = new Map();
  function personCanvas(pal, dir, frame, kind) {
    const id = pal.id + dir + frame + kind;
    if (personCache.has(id)) return personCache.get(id);
    const c = document.createElement('canvas'); c.width = 16; c.height = 17;
    const g = c.getContext('2d');
    const side = dir === 'left' || dir === 'right';
    const px = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
    if (kind === 'warden') px(3, 8, 10, 8, pal.cape);
    PT[side ? 'side' : dir].forEach((row, y) => { for (let x = 0; x < 16; x++) { const k = row[x]; if (k !== '.') px(x, y + 1, 1, 1, pal[k]); } });
    const L = pal.P, Bt = pal.B;
    if (side) {
      const a = frame === 1 ? -1 : frame === 2 ? 1 : 0;
      px(6 + a, 13, 2, 3, L); px(6 + a, 16, 2, 1, Bt);
      px(8 - a, 13, 2, 3, L); px(8 - a, 16, 2, 1, Bt);
    } else {
      const l = frame === 1 ? 1 : 0, r = frame === 2 ? 1 : 0;
      px(5, 13, 3, 3 - l, L); px(5, 16 - l, 3, 1, Bt);
      px(8, 13, 3, 3 - r, L); px(8, 16 - r, 3, 1, Bt);
    }
    if (kind === 'warden') { px(5, 0, 6, 1, '#ffd23d'); px(7, 0, 2, 1, '#fff2a8'); }
    let out = c;
    if (dir === 'right') { out = document.createElement('canvas'); out.width = 16; out.height = 17; const o = out.getContext('2d'); o.translate(16, 0); o.scale(-1, 1); o.drawImage(c, 0, 0); }
    personCache.set(id, out);
    return out;
  }
  function drawPerson(sx, sy, s, pal, dir, frame, kind, bob) {
    const u = s / 16;
    ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.ellipse(sx + s / 2, sy + s - u, 5 * u, 1.8 * u, 0, 0, 7); ctx.fill();
    ctx.drawImage(personCanvas(pal, dir, frame, kind), sx, sy - 3 * u + (bob || 0), s, s * 17 / 16);
  }

  // ---- ambient particles (world pixels)
  const amb = [];
  function spawnAmb(kind, camX, camY, W, H, s) {
    const x = camX + Math.random() * W, y = camY + Math.random() * H, k = s / 16;
    switch (kind) {
      case 'wind': return { kind, x: camX + W + Math.random() * W * 0.3, y, vx: -(140 + Math.random() * 120) * k, vy: 8 * k, life: 4, size: k, col: 'rgba(230,255,250,' };
      case 'ember': return { kind, x, y: camY + H + 10, vx: (Math.random() - 0.5) * 20 * k, vy: -(25 + Math.random() * 35) * k, life: 6, size: k * (1 + Math.random()), col: 'rgba(255,150,60,' };
      case 'bubble': return { kind, x, y: camY + H + 10, vx: 0, vy: -(15 + Math.random() * 20) * k, life: 7, size: k * (1.5 + Math.random() * 1.5), col: 'rgba(170,220,255,' };
      case 'dust': return { kind, x, y, vx: (8 + Math.random() * 10) * k, vy: (Math.random() - 0.5) * 6 * k, life: 5, size: k, col: 'rgba(239,212,156,' };
      case 'spark': return { kind, x, y, vx: 0, vy: -6 * k, life: 1 + Math.random() * 2, size: k, col: 'rgba(200,160,255,' };
      default: return { kind: 'data', x, y: camY - 10, vx: 0, vy: (12 + Math.random() * 18) * k, life: 8, size: k, col: 'rgba(70,243,255,' };
    }
  }
  function drawAmbient(dt, camX, camY, W, H, s, zone) {
    const th = THEME[zone] || THEME.nexus;
    while (amb.length < 34) amb.push(spawnAmb(th.part, camX, camY, W, H, s));
    for (let i = amb.length - 1; i >= 0; i--) {
      const p = amb[i];
      p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt;
      if (p.kind === 'ember') p.x += Math.sin(animT * 3 + p.y * 0.01) * 0.3 * dpr;
      const sx = p.x - camX, sy = p.y - camY;
      if (p.life <= 0 || sx < -40 || sx > W * 1.4 || sy < -40 || sy > H + 40 || (p.kind !== th.part && Math.random() < 0.02)) { amb.splice(i, 1); continue; }
      const a = Math.min(1, p.life) * (p.kind === 'spark' ? 0.5 + 0.5 * Math.sin(animT * 10 + i) : 0.7);
      ctx.fillStyle = p.col + a + ')';
      if (p.kind === 'wind') ctx.fillRect(sx, sy, p.size * 10, p.size * 0.6);
      else if (p.kind === 'bubble') { ctx.strokeStyle = p.col + a + ')'; ctx.lineWidth = p.size * 0.4; ctx.beginPath(); ctx.arc(sx, sy, p.size, 0, 7); ctx.stroke(); }
      else ctx.fillRect(sx, sy, p.size, p.size);
    }
  }

  function renderWorld(dt) {
    const W = cv.width, H = cv.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#04060c'; ctx.fillRect(0, 0, W, H);
    const s = TS * zoom * dpr, u = s / 16;
    const camX = Math.round((player.px + 0.5) * s - W / 2), camY = Math.round((player.py + 0.5) * s - H / 2);
    const x0 = Math.floor(camX / s) - 1, y0 = Math.floor(camY / s) - 1;
    const x1 = x0 + Math.ceil(W / s) + 2, y1 = y0 + Math.ceil(H / s) + 2;
    const lights = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (x < 0 || y < 0 || x >= map.w || y >= map.h) continue;
      drawTile(x, y, Math.round(x * s - camX), Math.round(y * s - camY), s, lights);
    }
    const actors = [];
    for (const n of npcs) if (n.x >= x0 && n.x <= x1 && n.y >= y0 && n.y <= y1) actors.push({ y: n.y, draw: () => {
      const sx = Math.round(n.x * s - camX), sy = Math.round(n.y * s - camY);
      const pal = n.kind === 'folk' ? PAL.folk : PAL[n.zone] || PAL.folk;
      drawPerson(sx, sy, s, pal, n.dir, 0, n.kind, Math.sin(animT * 2 + n.x) > 0.6 ? -u * 0.5 : 0);
      const beaten = S.beaten.includes(n.id);
      const marker = spotted === n || (n.warden && (!beaten || S.won));
      if (marker) {
        const by = sy - 8 * u + Math.sin(animT * 4) * u;
        ctx.fillStyle = spotted === n ? '#ffd23d' : beaten ? '#b48cff' : '#46f3ff';
        ctx.fillRect(sx + 5 * u, by, 6 * u, 5 * u); ctx.fillRect(sx + 7 * u, by + 5 * u, 2 * u, u);
        ctx.fillStyle = '#0b0e18';
        if (spotted === n) { ctx.fillRect(sx + 7.5 * u, by + u, u, 2 * u); ctx.fillRect(sx + 7.5 * u, by + 3.5 * u, u, 0.8 * u); }
        else ctx.fillRect(sx + 7 * u, by + 1.5 * u, 2 * u, 2 * u);
      }
    } });
    const lead = S.party.find(d => d.hp > 0) || S.party[0];
    actors.push({ y: follower.py, draw: () => {
      const sx = Math.round(follower.px * s - camX), sy = Math.round(follower.py * s - camY);
      ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.beginPath(); ctx.ellipse(sx + s / 2, sy + s - u, 5 * u, 1.6 * u, 0, 0, 7); ctx.fill();
      ctx.drawImage(SP.get(lead.key, lead.prism), sx - s * 0.1, sy - s * 0.3 + Math.sin(animT * 5) * u * 0.7, s * 1.2, s * 1.2);
    } });
    actors.push({ y: player.py + 0.01, draw: () => {
      const sx = Math.round(player.px * s - camX), sy = Math.round(player.py * s - camY);
      const fr = player.moving && player.t < 0.6 ? 1 + (S.steps % 2) : 0;
      drawPerson(sx, sy, s, PAL.player, player.dir, fr, 'player', 0);
    } });
    actors.sort((a, b) => a.y - b.y).forEach(a => a.draw());
    // additive lights
    ctx.globalCompositeOperation = 'lighter';
    for (const [lx, ly, r, col, a] of lights) {
      const g = ctx.createRadialGradient(lx, ly, 0, lx, ly, r);
      g.addColorStop(0, `rgba(${col},${a})`); g.addColorStop(1, `rgba(${col},0)`);
      ctx.fillStyle = g; ctx.fillRect(lx - r, ly - r, r * 2, r * 2);
    }
    ctx.globalCompositeOperation = 'source-over';
    drawAmbient(dt, camX, camY, W, H, s, zoneAt(player.x, player.y));
    if (!vignette) { vignette = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.75); vignette.addColorStop(0, 'rgba(2,3,8,0)'); vignette.addColorStop(1, 'rgba(2,3,8,.72)'); }
    ctx.fillStyle = vignette; ctx.fillRect(0, 0, W, H);
  }

  function frame(t) {
    const dt = Math.min(0.05, (t - lastTime) / 1000 || 0); lastTime = t; animT += dt;
    if (S && (mode === 'world' || mode === 'busy')) {
      if (player.moving) {
        player.t += dt / 0.12;
        const [fx, fy] = player.from;
        if (player.t >= 1) { player.moving = false; player.px = player.x; player.py = player.y; follower.px = follower.x; follower.py = follower.y; onStep(); }
        else {
          player.px = fx + (player.x - fx) * player.t; player.py = fy + (player.y - fy) * player.t;
          const k = Math.min(1, dt * 14); follower.px += (follower.x - follower.px) * k; follower.py += (follower.y - follower.py) * k;
        }
      }
      if (!player.moving && mode === 'world' && held) tryMove(held);
      renderWorld(dt);
    }
    requestAnimationFrame(frame);
  }

  function tryMove(dir) {
    player.dir = dir;
    const [dx, dy] = DIRS[dir];
    const nx = player.x + dx, ny = player.y + dy;
    if (!passable(nx, ny)) return;
    player.from = [player.x, player.y];
    follower.x = player.x; follower.y = player.y;
    player.x = nx; player.y = ny; player.t = 0; player.moving = true;
  }

  function onStep() {
    S.steps++; S.sinceFight++;
    const z = zoneAt(player.x, player.y);
    updateHud();
    if (tileAt(player.x, player.y) === ',') rustle.set(player.x + ',' + player.y, animT);
    if (checkSight()) return;
    if (tileAt(player.x, player.y) === ',' && C.ZONES[z] && S.sinceFight >= 4 && Math.random() < 0.12) { S.sinceFight = 0; startWild(z); return; }
    if (S.steps % 20 === 0) save();
  }

  function checkSight() {
    for (const n of npcs) {
      if (!n.sight || n.kind === 'folk' || S.beaten.includes(n.id)) continue;
      const [dx, dy] = DIRS[n.dir];
      for (let d = 1; d <= n.sight; d++) {
        const x = n.x + dx * d, y = n.y + dy * d;
        if (C.SOLID.has(tileAt(x, y))) break;
        if (x === player.x && y === player.y) { challenge(n, d); return true; }
      }
    }
    return false;
  }

  async function challenge(n, dist) {
    mode = 'busy'; held = null; setPad(false);
    spotted = n; beep(880, 0.15, 'square', 0.05);
    await sleep(650);
    spotted = null;
    const [dx, dy] = DIRS[n.dir];
    for (let i = 1; i < dist; i++) { n.x += dx; n.y += dy; await sleep(120); }
    player.dir = OPP[n.dir];
    await say(n.name, [n.intro]);
    startTrainer(n);
  }

  async function interact() {
    if (mode !== 'world' || player.moving) return;
    const [dx, dy] = DIRS[player.dir];
    const x = player.x + dx, y = player.y + dy;
    const n = npcAt(x, y), ch = tileAt(x, y);
    const back = () => { mode = 'world'; setPad(true); };
    if (n) {
      n.dir = OPP[player.dir];
      mode = 'busy'; setPad(false);
      if (n.kind === 'folk') { await say(n.name, n.lines); return back(); }
      if (S.beaten.includes(n.id)) {
        if (n.warden && S.won) {
          const times = S.rematches[n.id] || 0;
          const c = await choose(n.name, `${times ? `Rematches won: ${times}. ` : ''}My daemons have recompiled since we last met, and they're ${n.final ? 10 : 14} levels stronger. Want a rematch?`, ['Rematch', 'Later']);
          if (c === 0) return startTrainer(n, { rematch: true });
          return back();
        }
        await say(n.name, [n.outro]); return back();
      }
      await say(n.name, [n.intro]);
      return startTrainer(n);
    }
    if (ch === 'H') return healTerminal();
    if (ch === 'F') return openSheet('forge');
    if (ch === 'R') return riftTerminal();
    if (C.GATES[ch] != null && !gateOpen(ch)) {
      mode = 'busy';
      await say('Gate', [`A firewall gate. It needs ${C.GATES[ch]} Warden key${C.GATES[ch] > 1 ? 's' : ''} to open. You have ${S.badges}.`]);
      back();
    }
  }

  function healTerminal() {
    for (const d of S.party) d.hp = ENG.calcStats(d).hp;
    const lat = S.bag['lattice:basic'];
    const topped = !lat || lat.count < 3;
    if (!lat) S.bag['lattice:basic'] = basicLattice(3); else lat.count = Math.max(3, lat.count);
    S.lastHeal = { x: player.x, y: player.y };
    beep(523, 0.1, 'sine'); setTimeout(() => beep(784, 0.15, 'sine'), 100);
    mode = 'busy'; setPad(false);
    say('Terminal', ['Your daemons are fully restored.' + (topped ? ' The dispenser tops your Basic Lattices up to 3.' : '')]).then(() => { mode = 'world'; setPad(true); save(); });
  }

  // ------------------------------------------------------------------ input
  const KEYMAP = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', w: 'up', s: 'down', a: 'left', d: 'right', W: 'up', S: 'down', A: 'left', D: 'right' };
  addEventListener('keydown', e => {
    if (e.target && e.target.tagName === 'INPUT') return;
    if ((e.key === 't' || e.key === 'T') && S) { cycleTips(); return; }
    if (!$('dialog').classList.contains('hidden') && ['Enter', ' ', 'z', 'Z'].includes(e.key)) { advanceDialog(); e.preventDefault(); return; }
    if (mode === 'world') {
      if (KEYMAP[e.key]) { held = KEYMAP[e.key]; e.preventDefault(); }
      else if (['Enter', ' ', 'z', 'Z', 'e', 'E'].includes(e.key)) { interact(); e.preventDefault(); }
      else if (['Escape', 'm', 'M', 'x', 'X'].includes(e.key)) openSheet('party');
    } else if (mode === 'battle') {
      const open = !$('bpanel').classList.contains('hidden');
      if ('1234'.includes(e.key) && !open) useSlot(+e.key - 1);
      else if (e.key === 'Escape' && open) { const bb = $('bpanel').querySelector('[data-back]'); if (bb) bb.click(); }
      else if (e.key === ' ') { e.preventDefault(); skipping = true; if (!open && B && B.rt) setPaused(!paused); }
      else if ((e.key === 'r' || e.key === 'R') && !open && B && B.rt) utility({ type: 'defrag' }, 'Rest is cooling down.');
    } else if (e.key === 'Escape' && !$('sheet').classList.contains('hidden')) closeSheet();
  });
  addEventListener('keyup', e => { if (KEYMAP[e.key] === held) held = null; });
  document.querySelectorAll('.dpad button').forEach(b => {
    const on = e => { e.preventDefault(); held = b.dataset.dir; b.classList.add('on'); };
    const off = e => { e.preventDefault(); if (held === b.dataset.dir) held = null; b.classList.remove('on'); };
    b.addEventListener('pointerdown', on); b.addEventListener('pointerup', off); b.addEventListener('pointerleave', off); b.addEventListener('pointercancel', off);
  });
  $('aBtn').addEventListener('pointerdown', e => { e.preventDefault(); if (!$('dialog').classList.contains('hidden')) advanceDialog(); else interact(); });
  $('menuBtn').addEventListener('click', () => { if (mode === 'world') openSheet('party'); });
  function setPad(on) { $('pad').classList.toggle('hidden', !on); if (!on) { held = null; document.querySelectorAll('.dpad button').forEach(b => b.classList.remove('on')); } }

  function updateHud() {
    if (!S) return;
    const z = zoneAt(player.x, player.y);
    $('zoneName').textContent = z === 'nexus' ? 'The Nexus' : z === 'core' ? 'The Core' : (C.ZONES[z] ? C.ZONES[z].name : 'The Nexus');
    $('keysText').textContent = `${Math.min(S.badges, 4)}/4`;
    $('codexText').textContent = discovered.size;
  }

  // ------------------------------------------------------------------ dialog (typewriter)
  let dq = null, typing = null;
  function say(who, lines) {
    return new Promise(res => {
      dq = { lines: lines.slice(), res };
      $('dialog').classList.remove('hidden');
      $('dialog').querySelector('.who').textContent = who;
      showLine();
    });
  }
  function showLine() {
    const el = $('dialog').querySelector('.text'), full = dq.lines[0];
    let i = 0;
    clearInterval(typing); el.textContent = '';
    typing = setInterval(() => { i += 2; el.textContent = full.slice(0, i); if (i >= full.length) { clearInterval(typing); typing = null; } }, 16);
    beep(660, 0.03, 'square', 0.02);
  }
  function advanceDialog() {
    if (!dq) return;
    if (typing) { clearInterval(typing); typing = null; $('dialog').querySelector('.text').textContent = dq.lines[0]; return; }
    dq.lines.shift();
    if (dq.lines.length) return showLine();
    $('dialog').classList.add('hidden');
    const r = dq.res; dq = null; r();
  }
  $('dialog').addEventListener('click', advanceDialog);

  // ------------------------------------------------------------------ battle setup
  function pickWeighted(list) {
    const tot = list.reduce((s, x) => s + x[3], 0);
    let r = Math.random() * tot;
    for (const x of list) { r -= x[3]; if (r <= 0) return x; }
    return list[0];
  }
  function startWild(zoneId) {
    const z = C.ZONES[zoneId];
    const pick = pickWeighted(z.wild);
    let key = pick[0], lv = pick[1] + rnd(pick[2] - pick[1] + 1), rogue = false;
    if (Math.random() < 0.07) { const up = upgradeKey(key, true); if (up !== key) { key = up; lv += 2; rogue = true; } }
    const foe = ENG.createDaemon(key, lv);
    if (Math.random() < 1 / 64) { foe.prism = true; foe.hp = ENG.calcStats(foe).hp; }
    startBattle({ enemy: [foe], wild: true, rogue, zone: zoneId });
  }
  function seeded(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function startTrainer(n, opts) {
    opts = opts || {};
    const rng = seeded(n.id.split('').reduce((h, c) => h * 31 + c.charCodeAt(0), 7) + (opts.rematch ? 99 : 0));
    const base = opts.rematch ? n.team.map(([k, lv]) => [upgradeKey(k), lv + (n.final ? 10 : 14)]) : n.team;
    const team = base.map(([key, lv], i) => ENG.createDaemon(key, lv, { rng, uid: n.id + i, extraAttune: opts.rematch ? 2 : undefined }));
    startBattle({ enemy: team, wild: false, trainer: n, rematch: !!opts.rematch, zone: n.zone });
  }

  function transition() {
    const f = $('flash'); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
    beep(220, 0.08, 'square', 0.04); setTimeout(() => beep(440, 0.08, 'square', 0.04), 90); setTimeout(() => beep(880, 0.12, 'square', 0.04), 180);
    return sleep(430);
  }

  async function startBattle(o) {
    mode = 'battle'; setPad(false); held = null;
    await transition();
    $('hud').classList.add('hidden');
    B = new ENG.Battle({ player: S.party, enemy: o.enemy, wild: o.wild, trainer: o.trainer ? { name: o.trainer.name } : null, discovered: new Set(discovered) });
    bctx = o;
    for (const d of o.enemy) seen.add(d.key);
    ui = [snapshot(0), snapshot(1)];
    $('battle').classList.remove('hidden');
    $('blog').innerHTML = '';
    $('bpanel').classList.add('hidden'); $('bctrl').classList.add('hidden');
    for (const i of [0, 1]) { const el = spriteEl(i); el.classList.remove('faint', 'enter'); void el.offsetWidth; el.classList.add('enter'); paintSide(i); }
    renderCards(); renderResidue();
    drawBattleBg();
    startFx();
    const foe = o.enemy[0], fr = ENG.rec(foe.key);
    if (o.wild) await logMsg(foe.prism ? `✦ A prismatic ${fr.dName} shimmers into view!` : o.rogue ? `A rogue ${fr.dName} build materializes!` : `A wild ${fr.dName} materializes!`);
    else if (o.rift) await logMsg(`Rift floor ${o.floor}${o.floor % 5 === 0 ? ': a guardian awaits' : ''}. ${fr.dName} emerges!`);
    else { await logMsg(`${o.trainer.name} ${o.rematch ? 'accepts the rematch' : 'challenges you'}!`); await logMsg(`${o.trainer.name} deploys ${fr.dName}!`); }
    await logMsg(`Go, ${dName(B.act(0))}!`);
    B.startRealtime();
    B.rt[0].queued = defaultAttack();
    tip('battle', 'Combat is live. Red ATTACKS repeat on your global cooldown: tap one to queue it. Violet ACTIVES fire instantly and then cool down. Gold PASSIVES are always on. Space pauses.');
    buildControls(); setPaused(false); startLoop();
  }

  function snapshot(i) {
    const s = B.sides[i], d = s.team[s.active], v = s.v;
    return { key: d.key, prism: !!d.prism, name: dName(d), level: d.level, hp: d.hp, max: v.stats.hp, flux: v.flux, fmax: v.stats.flux, shield: v.shield, status: v.status && v.status.id, stages: Object.assign({}, v.stages), soak: v.soak > 0, regen: v.regen > 0, uid: d.uid };
  }
  const spriteEl = i => (i === 0 ? $('allySprite') : $('foeSprite'));
  function paintSide(i) { SP.paint(spriteEl(i), ui[i].key, { flip: i === 0, prism: ui[i].prism }); }

  function renderCards() {
    for (const i of [0, 1]) {
      const u = ui[i], el = i === 0 ? $('allyCard') : $('foeCard');
      const pct = clamp(u.hp / u.max, 0, 1), sh = clamp(u.shield / u.max, 0, 1);
      const col = pct > 0.5 ? 'var(--good)' : pct > 0.2 ? 'var(--warn)' : 'var(--bad)';
      const chips = [];
      if (u.status) chips.push(`<span class="st bad" data-tip="s:${u.status}">${ENG.STATUS[u.status].name}</span>`);
      if (u.soak) chips.push('<span class="st inf">Soaked</span>');
      if (u.regen) chips.push('<span class="st good">Regen</span>');
      const nm = { atk: 'LOG', def: 'FWL', spd: 'CLK', acc: 'ACC', eva: 'EVA' };
      for (const k in u.stages) if (u.stages[k]) chips.push(`<span class="st ${u.stages[k] > 0 ? 'good' : 'bad'}">${nm[k]}${u.stages[k] > 0 ? '▲' : '▼'}${Math.abs(u.stages[k])}</span>`);
      el.dataset.tip = 'd:' + i;
      el.innerHTML = `<span class="nm"><b>${esc(u.name)}${u.prism ? ' <em class="prism">✦</em>' : ''}</b><span>Lv ${u.level}</span></span>
        <span class="sub2">${genomeDots(u.key)}<span>${TIER[E.parseKey(u.key).subs.length]}</span></span>
        <span class="bar"><i style="width:${pct * 100}%;background:${col}"></i><b style="left:${pct * 100}%;width:${Math.min(sh, 1 - pct) * 100}%"></b></span>
        ${i === 0 ? `<span class="nums"><span>${u.hp}/${u.max} HP</span><span>${Math.floor(u.flux)}/${u.fmax} Flux</span></span>` : ''}
        <span class="bar flux"><i style="width:${clamp(u.flux / u.fmax, 0, 1) * 100}%"></i></span>
        <span class="bar cast" title="${i === 0 ? 'Your global cooldown' : 'Foe is winding up its next action'}"><i id="cast${i}"></i></span>
        ${chips.length ? `<span class="stat-chips">${chips.join('')}</span>` : ''}`;
    }
  }
  $('allyCard').onclick = () => { if (B && !B.over && !$('bctrl').classList.contains('hidden')) panelInfo(0); };
  $('foeCard').onclick = () => { if (B && !B.over && !$('bctrl').classList.contains('hidden')) panelInfo(1); };

  function renderResidue(res, field) {
    res = res || B.residue; field = field === undefined ? B.field : field;
    let h = '';
    for (const m of E.MAINS) {
      if (!res[m]) continue;
      h += `<span class="rs" title="${E.MAIN[m].name} residue" style="color:${MAINC(m)}">`;
      for (let i = 0; i < 6; i++) h += `<i style="${i < res[m] ? `background:${MAINC(m)}` : ''}"></i>`;
      h += '</span>';
    }
    if (field) h += `<span class="fieldtag" style="color:${MAINC(field.el)}">${E.MAIN[field.el].name} field · ${field.turns}</span>`;
    $('residue').innerHTML = h;
  }

  // ---- battle backdrop, drawn once per battle (and on resize)
  function drawBattleBg() {
    const c = $('bbg'), a = $('arena').getBoundingClientRect();
    const d = Math.min(window.devicePixelRatio || 1, 2);
    c.width = Math.max(1, Math.round(a.width * d)); c.height = Math.max(1, Math.round(a.height * d));
    const g = c.getContext('2d'), W = c.width, H = c.height;
    const th = THEME[bctx.zone] || THEME.nexus;
    const hz = H * 0.44;
    let gr = g.createLinearGradient(0, 0, 0, hz);
    gr.addColorStop(0, th.sky[0]); gr.addColorStop(1, th.sky[1]);
    g.fillStyle = gr; g.fillRect(0, 0, W, hz);
    for (let i = 0; i < 60; i++) { const h = hash2(i, 7); g.fillStyle = `rgba(${th.rgb},${0.15 + (h % 50) / 120})`; g.fillRect(h % W, (h >> 8) % Math.max(1, Math.round(hz * 0.9)), d, d); }
    const sky0 = shade(th.sky[0], 0.06);
    for (let i = 0; i < 18; i++) {
      const h = hash2(i, 3), w = (10 + h % 26) * d, x = (h >> 4) % W, ht = (12 + (h >> 9) % 60) * d;
      g.fillStyle = sky0; g.fillRect(x, hz - ht, w, ht);
      g.fillStyle = `rgba(${th.rgb},.35)`;
      for (let k = 0; k < ht / (6 * d) - 1; k++) if (hash2(i, k) % 3 === 0) g.fillRect(x + 3 * d, hz - ht + (4 + k * 6) * d, 2 * d, 2 * d);
    }
    gr = g.createLinearGradient(0, hz, 0, H);
    gr.addColorStop(0, th.face); gr.addColorStop(1, th.wall);
    g.fillStyle = gr; g.fillRect(0, hz, W, H - hz);
    gr = g.createLinearGradient(0, hz - 30 * d, 0, hz + 30 * d);
    gr.addColorStop(0, `rgba(${th.rgb},0)`); gr.addColorStop(0.5, `rgba(${th.rgb},.45)`); gr.addColorStop(1, `rgba(${th.rgb},0)`);
    g.fillStyle = gr; g.fillRect(0, hz - 30 * d, W, 60 * d);
    g.strokeStyle = `rgba(${th.rgb},.16)`; g.lineWidth = d;
    for (let i = -14; i <= 14; i++) { g.beginPath(); g.moveTo(W / 2 + i * W * 0.012, hz); g.lineTo(W / 2 + i * W * 0.16, H); g.stroke(); }
    for (let i = 1; i <= 12; i++) { const y = hz + (H - hz) * Math.pow(i / 12, 2); g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
    for (const el of [$('foeSprite'), $('allySprite')]) {
      const r = el.getBoundingClientRect();
      const cx = (r.left - a.left + r.width / 2) * d, cy = (r.top - a.top + r.height * 0.9) * d, rx = r.width * 0.46 * d, ry = r.width * 0.12 * d;
      g.fillStyle = 'rgba(0,0,0,.35)'; g.beginPath(); g.ellipse(cx, cy + ry * 0.35, rx, ry, 0, 0, 7); g.fill();
      g.fillStyle = `rgba(${th.rgb},.14)`; g.beginPath(); g.ellipse(cx, cy, rx, ry, 0, 0, 7); g.fill();
      g.strokeStyle = `rgba(${th.rgb},.6)`; g.lineWidth = 1.5 * d; g.beginPath(); g.ellipse(cx, cy, rx, ry, 0, 0, 7); g.stroke();
      g.strokeStyle = `rgba(${th.rgb},.25)`; g.beginPath(); g.ellipse(cx, cy, rx * 0.65, ry * 0.65, 0, 0, 7); g.stroke();
    }
  }

  // ---- fx layer: particles, projectiles, rings
  const fxc = $('fx'), fctx = fxc.getContext('2d');
  let parts = [], shots = [], rings = [], fxRun = false;
  function startFx() { if (fxRun) return; fxRun = true; requestAnimationFrame(fxLoop); }
  function fxLoop(now) {
    const r = fxc.getBoundingClientRect();
    if (fxc.width !== Math.round(r.width) || fxc.height !== Math.round(r.height)) { fxc.width = Math.round(r.width); fxc.height = Math.round(r.height); }
    fctx.clearRect(0, 0, fxc.width, fxc.height);
    fctx.globalCompositeOperation = 'lighter';
    parts = parts.filter(p => (p.life -= 1) > 0);
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy; p.vx *= 0.96; p.vy *= 0.96; p.vy += p.g || 0;
      if (p.tx != null) { p.x += (p.tx - p.x) * 0.07; p.y += (p.ty - p.y) * 0.07; }
      fctx.globalAlpha = Math.min(1, p.life / 20);
      fctx.fillStyle = p.c; fctx.fillRect(p.x - p.s / 2, p.y - p.s / 2, p.s, p.s);
    }
    shots = shots.filter(sh => {
      const t = (now - sh.t0) / sh.dur;
      if (t < 0) return true;
      if (t >= 1) return false;
      const e = t * t * (3 - 2 * t);
      const x = sh.x0 + (sh.x1 - sh.x0) * e, y = sh.y0 + (sh.y1 - sh.y0) * e - Math.sin(t * Math.PI) * sh.arc;
      fctx.globalAlpha = 1;
      const g = fctx.createRadialGradient(x, y, 0, x, y, sh.size * 2.4);
      g.addColorStop(0, '#ffffff'); g.addColorStop(0.35, sh.col); g.addColorStop(1, 'rgba(0,0,0,0)');
      fctx.fillStyle = g; fctx.fillRect(x - sh.size * 2.4, y - sh.size * 2.4, sh.size * 4.8, sh.size * 4.8);
      if (Math.random() < 0.8) parts.push({ x, y, vx: (Math.random() - 0.5) * 1.5, vy: (Math.random() - 0.5) * 1.5, c: sh.trail[rnd(sh.trail.length)], s: 2 + Math.random() * 3, life: 18 });
      return true;
    });
    rings = rings.filter(rg => {
      const t = (now - rg.t0) / rg.dur;
      if (t < 0) return true;
      if (t >= 1) return false;
      const rad = rg.r0 + (rg.r1 - rg.r0) * t;
      fctx.globalAlpha = 1 - t;
      fctx.strokeStyle = rg.col; fctx.lineWidth = rg.w || 3;
      fctx.beginPath();
      if (rg.hex) { for (let k = 0; k <= 6; k++) { const a = k * Math.PI / 3 + rg.rot; const px = rg.x + Math.cos(a) * rad, py = rg.y + Math.sin(a) * rad * 0.9; if (k) fctx.lineTo(px, py); else fctx.moveTo(px, py); } }
      else fctx.ellipse(rg.x, rg.y, rad, rad * (rg.flat || 1), 0, 0, 7);
      fctx.stroke();
      return true;
    });
    fctx.globalAlpha = 1; fctx.globalCompositeOperation = 'source-over';
    if (mode === 'battle' || parts.length || shots.length || rings.length) requestAnimationFrame(fxLoop); else fxRun = false;
  }
  function centerOf(el) { const a = $('arena').getBoundingClientRect(), b = el.getBoundingClientRect(); return [b.left - a.left + b.width / 2, b.top - a.top + b.height / 2]; }
  function burstAt(x, y, colors, n, spd) {
    for (let i = 0; i < n; i++) { const a = Math.random() * Math.PI * 2, sp = (1 + Math.random() * 4) * (spd || 1); parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, c: colors[i % colors.length], s: 3 + Math.random() * 4, life: 30 + Math.random() * 30 }); }
  }
  function sparkles(x, y, col, n) { for (let i = 0; i < n; i++) parts.push({ x: x + (Math.random() - 0.5) * 80, y: y + 20 + Math.random() * 30, vx: 0, vy: -1 - Math.random() * 2.5, c: col, s: 2 + Math.random() * 3, life: 40 + Math.random() * 20 }); }
  function stream(x0, y0, x1, y1, col, n) { for (let i = 0; i < n; i++) parts.push({ x: x0 + (Math.random() - 0.5) * 40, y: y0 + (Math.random() - 0.5) * 40, vx: 0, vy: 0, tx: x1, ty: y1, c: col, s: 3, life: 40 + i }); }
  function shot(x0, y0, x1, y1, col, size, dur, trail, delay, arc) { shots.push({ x0, y0, x1, y1, col, size, dur, trail, t0: performance.now() + (delay || 0), arc: arc || 0 }); }
  function ring(x, y, r0, r1, col, dur, delay, extra) { rings.push(Object.assign({ x, y, r0, r1, col, dur, t0: performance.now() + (delay || 0), rot: Math.random() }, extra || {})); }
  function keyColors(key) { const p = E.parseKey(key); return [MAINC(p.a), MAINC(p.b), ...p.subs.map(t => subColor(t.s))]; }
  function flashSprite(side, cls, ms) { const el = spriteEl(side); el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); setTimeout(() => el.classList.remove(cls), ms || 400); }
  function shakeArena() { const a = $('arena'); a.classList.remove('shake'); void a.offsetWidth; a.classList.add('shake'); }
  function fieldFlash(col) { const f = $('fieldFlash'); f.style.background = `radial-gradient(ellipse at center, ${col}55, ${col}11 70%)`; f.classList.remove('go'); void f.offsetWidth; f.classList.add('go'); }
  function dmgNum(side, text, cls) {
    const [x, y] = centerOf(spriteEl(side));
    const d = document.createElement('div'); d.className = 'dmg ' + (cls || ''); d.textContent = text;
    d.style.left = (x + (Math.random() - 0.5) * 50) + 'px'; d.style.top = (y - 20 + (Math.random() - 0.5) * 20) + 'px';
    $('arena').appendChild(d); setTimeout(() => d.remove(), 1100);
  }
  const speedMul = () => (skipping ? 0.35 : S.settings.speed === 'fast' ? 0.65 : 1);
  const wait = ms => sleep(ms * speedMul());

  // Each merge class has its own animation, colored by the merge's essences.
  async function animateCast(side, key) {
    const r = ENG.rec(key), cols = keyColors(key).concat(['#ffffff']);
    const me = spriteEl(side), foe = spriteEl(1 - side);
    me.style.setProperty('--glow', MAINC(r.a)); me.classList.add('cast');
    castSfx(key);
    const [x0, y0] = centerOf(me), [x1, y1] = centerOf(foe);
    const k = speedMul();
    switch (r.cls) {
      case 'Strike':
        shot(x0, y0, x1, y1, cols[0], 9, 340 * k, cols, 0, 30);
        await sleep(340 * k); burstAt(x1, y1, cols, 36, 1.3); ring(x1, y1, 10, 70, cols[0], 350 * k);
        break;
      case 'Barrage':
        for (let i = 0; i < r.hits; i++) shot(x0, y0, x1 + (Math.random() - 0.5) * 50, y1 + (Math.random() - 0.5) * 40, cols[i % (cols.length - 1)], 5, 260 * k, cols, i * 90 * k, 20 + Math.random() * 40);
        await sleep((260 + r.hits * 90) * k); burstAt(x1, y1, cols, 24);
        break;
      case 'Siphon':
        shot(x0, y0, x1, y1, cols[0], 7, 300 * k, cols);
        await sleep(300 * k); burstAt(x1, y1, cols, 16); stream(x1, y1, x0, y0, '#5dff9a', 26);
        await sleep(260 * k);
        break;
      case 'Hex':
        ring(x1, y1, 95, 12, cols[0], 460 * k, 0, { w: 3 }); ring(x1, y1, 75, 8, cols[1], 460 * k, 140 * k, { hex: true, w: 2 });
        if (cols.length > 3) ring(x1, y1, 60, 6, cols[2], 420 * k, 260 * k, { w: 2 });
        await sleep(560 * k); burstAt(x1, y1, cols, 14, 0.6);
        break;
      case 'Ward':
        ring(x0, y0, 30, 100, cols[0], 520 * k, 0, { hex: true, w: 4 }); ring(x0, y0, 20, 80, '#cfe8ff', 480 * k, 120 * k, { hex: true, w: 2 });
        await sleep(480 * k);
        break;
      case 'Mend':
        sparkles(x0, y0, '#5dff9a', 26); sparkles(x0, y0, cols[0], 12); ring(x0, y0 + 40, 10, 90, '#5dff9a', 500 * k, 0, { flat: 0.3 });
        await sleep(460 * k);
        break;
      case 'Field':
        fieldFlash(MAINC(r.a));
        for (let i = 0; i < 5; i++) shot(x0, y0, Math.random() * fxc.width, Math.random() * fxc.height, cols[i % cols.length], 5, 380 * k, cols, i * 60 * k, 60);
        await sleep(560 * k); burstAt(x1, y1, cols, 20);
        break;
      default: await sleep(300 * k);
    }
    me.classList.remove('cast');
  }

  const STATUS_COL = { burn: '#ff7a2e', frozen: '#bff3ff', static: '#ffe23d', rooted: '#5fbf4a', corrupt: '#9b4dff', dormant: '#9aa6c8', soak: '#3aa6ff', petrify: '#c9913d' };

  // ---- ticker
  function print(text) {
    const box = $('blog');
    [...box.children].forEach(c => c.classList.add('old'));
    const d = document.createElement('div'); d.textContent = text; box.appendChild(d);
    while (box.children.length > 3) box.firstChild.remove();
  }
  async function logMsg(text) { print(text); await sleep(skipping ? 110 : 520); }
  $('blog').addEventListener('click', () => { skipping = true; });

  // ---- live event rendering (never blocks the clock)
  function consume(events) {
    let dirty = false;
    for (const e of events) {
      switch (e.type) {
        case 'msg': {
          print(e.text);
          if (e.anim === 'cast' && e.key) { animateCast(e.side, e.key); break; }
          if (e.anim === 'glitch') { const [x, y] = centerOf(spriteEl(e.side == null ? 0 : e.side)); burstAt(x, y, ['#ff5cf0', '#46f3ff', '#ffffff'], 40, 1.4); shakeArena(); beep(90, 0.25, 'sawtooth', 0.05); }
          else if (e.anim === 'react') {
            const [x, y] = centerOf(spriteEl(1)); burstAt(x, y, [MAINC(e.el), MAINC(e.el2), '#fff'], 60, 1.5); ring(x, y, 10, 120, MAINC(e.el2), 500);
            S.stats.reacts++; questEvent('react');
            tip('react', 'Residue reaction! Casting one essence into another\'s residue (the bars at the bottom left of the arena) triggers bonus effects.');
          } else if (e.anim === 'field') fieldFlash(MAINC(e.el));
          else if (e.anim === 'heal') { const [x, y] = centerOf(spriteEl(e.side)); sparkles(x, y, '#5dff9a', 20); }
          else if (e.anim === 'shield') { const [x, y] = centerOf(spriteEl(e.side)); ring(x, y, 30, 95, '#cfe8ff', 450, 0, { hex: true }); }
          else if (e.anim === 'buff' || e.anim === 'debuff') { const [x, y] = centerOf(spriteEl(e.side)); for (let i = 0; i < 10; i++) parts.push({ x: x + (Math.random() - 0.5) * 70, y: y + (e.anim === 'buff' ? 30 : -30), vx: 0, vy: e.anim === 'buff' ? -2.5 : 2.5, c: e.anim === 'buff' ? '#5dff9a' : '#ff5470', s: 3, life: 26 }); }
          else if (STATUS_COL[e.anim] && e.side != null) { const [x, y] = centerOf(spriteEl(e.side)); ring(x, y, 70, 20, STATUS_COL[e.anim], 400); burstAt(x, y, [STATUS_COL[e.anim]], 16, 0.8); }
          else if (e.anim === 'levelup') { beep(988, 0.2, 'triangle', 0.05); const [x, y] = centerOf(spriteEl(0)); sparkles(x, y, '#ffd23d', 24); }
          else if (e.anim === 'bound') { beep(784, 0.15, 'sine'); setTimeout(() => beep(1046, 0.25, 'sine'), 150); const [x, y] = centerOf(spriteEl(1)); burstAt(x, y, ['#46f3ff', '#ffffff', '#ffd23d'], 50); }
          else if (e.anim === 'bind') { const [x0, y0] = centerOf(spriteEl(0)), [x1, y1] = centerOf(spriteEl(1)); shot(x0, y0, x1, y1, '#46f3ff', 7, 380, ['#46f3ff', '#ffffff'], 0, 70); ring(x1, y1, 90, 30, '#46f3ff', 400, 380, { hex: true }); }
          else if (e.anim === 'miss') dmgNum(e.side, 'MISS', 'miss');
          break;
        }
        case 'hit':
          flashSprite(e.side, 'hit', 360);
          dmgNum(e.side, (e.crit ? '✹' : '') + e.amount, e.crit ? 'crit' : '');
          if (e.crit || e.amount >= ui[e.side].max * 0.3) shakeArena();
          beep(e.crit ? 90 : 140, 0.08, 'square', 0.05);
          break;
        case 'healed': dmgNum(e.side, '+' + e.amount, 'heal'); break;
        case 'absorb': dmgNum(e.side, '◈' + e.amount, 'absorb'); break;
        case 'hp': ui[e.side].hp = e.hp; ui[e.side].max = e.max; ui[e.side].shield = e.shield; dirty = true; break;
        case 'flux': ui[e.side].flux = e.flux; ui[e.side].fmax = e.max; dirty = true; break;
        case 'status': Object.assign(ui[e.side], { status: e.status, stages: e.stages, soak: e.soak, shield: e.shield, regen: e.regen }); dirty = true; break;
        case 'field': renderResidue(e.residue, e.field); break;
        case 'switch': {
          ui[e.side] = snapshot(e.side);
          const el = spriteEl(e.side); el.classList.remove('faint', 'enter'); void el.offsetWidth; el.classList.add('enter');
          paintSide(e.side); dirty = true; seen.add(e.key);
          const [x, y] = centerOf(el); ring(x, y, 10, 90, MAINC(e.key[0]), 400);
          if (e.side === 0 && B.rt) { B.rt[0].queued = defaultAttack(); buildControls(); }
          break;
        }
        case 'faint': spriteEl(e.side).classList.add('faint'); beep(110, 0.4, 'sawtooth', 0.05); break;
        case 'discover': markDiscovered(e.key); break;
        case 'shake': { const el = spriteEl(1); setTimeout(() => { el.classList.add('wobble'); beep(300 + e.n * 100, 0.08); setTimeout(() => el.classList.remove('wobble'), 420); }, (e.n - 1) * 480); break; }
        case 'unbind': { const [x, y] = centerOf(spriteEl(1)); setTimeout(() => burstAt(x, y, ['#46f3ff'], 24), 1000); break; }
        case 'xp': pendingXp.push(e); break;
        default: break;
      }
    }
    if (dirty) renderCards();
  }

  // ---- the real-time loop
  let loopOn = false, paused = false, lastT = 0, uiT = 0;
  const pace = () => (S.settings.speed === 'fast' ? 1.15 : 0.85);
  function startLoop() { if (loopOn) return; loopOn = true; lastT = performance.now(); requestAnimationFrame(loop); }
  function loop(t) {
    if (!loopOn || !B) { loopOn = false; return; }
    const dt = Math.min(0.1, (t - lastT) / 1000); lastT = t;
    if (!paused && !B.over && !B.needSwitch) consume(B.tick(dt * pace()));
    uiT -= dt; if (uiT <= 0) { uiT = 0.08; refreshControls(); }
    if (B.over) { loopOn = false; $('bctrl').classList.add('locked'); setTimeout(endBattle, B.result === 'bind' ? 1700 : 900); return; }
    if (B.needSwitch) { loopOn = false; panelSwitch(true); return; }
    requestAnimationFrame(loop);
  }
  function setPaused(p) { paused = p; $('battle').classList.toggle('paused', p); refreshControls(); }
  addEventListener('blur', () => { if (mode === 'battle' && B && !paused) setPaused(true); });

  // ---- controls: color-coded ATTACK / ACTIVE / PASSIVE / UTILITY
  function chanceWith(lat) { const t = B.act(1), v = B.sides[1].v; return ENG.captureChance(t, t.hp, v.stats.hp, lat, !!v.status); }
  function bestLattice() {
    let best = null, bc = -1;
    for (const it of Object.values(S.bag)) {
      if (it.kind !== 'lattice' || it.count <= 0) continue;
      const c = chanceWith(it);
      if (c > bc) { bc = c; best = it; }
    }
    return best;
  }
  const defaultAttack = () => { const d = B.act(0); return d.memory.find(k => k && ENG.isAttack(k)) || null; };
  function kindBadge(k) { return ENG.isAttack(k) ? '<span class="kb atk">Attack · GCD</span>' : `<span class="kb act">Active · ${ENG.cooldownFor(ENG.rec(k))}s CD</span>`; }

  function abilityBtn(k, i) {
    const r = ENG.rec(k), known = discovered.has(k), p = E.parseKey(k), atk = ENG.isAttack(k);
    const eff = ENG.effectiveness(k, ui[1].key);
    const effTxt = r.damaging && eff >= 1.2 ? '<span class="eff up">▲</span>' : r.damaging && eff <= 0.83 ? '<span class="eff dn">▼</span>' : '';
    return `<button class="ab ${atk ? 'atk' : 'act'} ${known ? '' : 'unk'}" data-slot="${i}" data-key="${k}" data-tip="m:${k}" style="--c:${MAINC(p.a)};--c2:${MAINC(p.b)}">
      <span class="cdo" id="cd${i}"></span>
      <span class="an">${known ? esc(r.name) : '? ? ?'}${effTxt}</span>
      <span class="am">${genomeDots(k)}<span>${known ? r.cls : 'Unknown'}</span><span class="fl">${r.flux}◆</span></span>
      <span class="ak">${atk ? '<em class="qtag">Queued</em><em class="rtag">Tap to queue</em>' : `<em>Instant · ${ENG.cooldownFor(r)}s cooldown</em>`}</span></button>`;
  }

  function buildControls() {
    const d = B.act(0), r = ENG.rec(d.key), pv = ENG.PASSIVES[r.dPassive];
    const slots = d.memory.map((k, i) => ({ k, i }));
    const atks = slots.filter(x => x.k && ENG.isAttack(x.k)), acts = slots.filter(x => x.k && !ENG.isAttack(x.k));
    const empties = slots.filter(x => !x.k);
    const uts = [['compose', '⚗', 'Compose'], ['swap', '⇄', 'Swap'], ['bag', '✚', 'Items'], ['rest', '↻', 'Rest'], ['pause', '❚❚', 'Pause']].concat(bctx.wild ? [['run', '↩', 'Run']] : [['info', 'ⓘ', 'Info']]);
    $('bctrl').classList.remove('locked');
    $('bctrl').innerHTML = `
      <div class="lane atk"><span class="lbl">Attack</span><div class="gcd"><i id="gcdFill"></i><span id="gcdText"></span></div></div>
      <div class="abgrid">${atks.map(x => abilityBtn(x.k, x.i)).join('') || '<p class="fine">No attacks in memory. Compose one.</p>'}</div>
      <div class="lane act"><span class="lbl">Active</span><div class="abgrid acts">${acts.map(x => abilityBtn(x.k, x.i)).join('')}${empties.map(x => `<button class="ab empty" data-empty="${x.i}"><span class="an">＋ Empty slot</span><span class="am">Compose an attack or active</span></button>`).join('') || (acts.length ? '' : '<p class="fine">Hex, Ward, Mend and Field merges become actives.</p>')}</div></div>
      <div class="lane pas"><span class="lbl">Passive</span><span class="pchip" data-tip="p:${r.dPassive}"><b>${pv[0]}</b> ${esc(pv[1])}</span></div>
      ${bctx.wild ? '<button class="bind utl" id="bindBtn"></button>' : ''}
      <div class="utils">${uts.map(([id, ic, lb]) => `<button class="ub" data-u="${id}"><span class="cdo" id="cdu-${id}"></span><i>${ic}</i>${lb}</button>`).join('')}</div>`;
    const c = $('bctrl');
    c.querySelectorAll('.ab[data-key]').forEach(b => { b.onclick = () => useSlot(+b.dataset.slot); });
    c.querySelectorAll('[data-empty]').forEach(b => { b.onclick = () => panelCompose(); });
    c.querySelector('[data-u=compose]').onclick = () => panelCompose();
    c.querySelector('[data-u=swap]').onclick = () => panelSwitch(false);
    c.querySelector('[data-u=bag]').onclick = () => panelBag();
    c.querySelector('[data-u=rest]').onclick = () => utility({ type: 'defrag' }, 'Rest is cooling down.');
    c.querySelector('[data-u=pause]').onclick = () => setPaused(!paused);
    const last = c.querySelector('[data-u=run]') || c.querySelector('[data-u=info]');
    last.onclick = () => (bctx.wild ? utility({ type: 'run' }, 'Wait for your global cooldown.') : panelInfo(1));
    if (bctx.wild) $('bindBtn').onclick = () => {
      const lat = bestLattice(); if (!lat) return;
      const ev = B.useUtility({ type: 'bind', item: lat });
      if (!ev) return toast('Wait for your global cooldown.');
      lat.count--; if (lat.count <= 0 && lat.id !== 'lattice:basic') delete S.bag[lat.id];
      consume(ev);
    };
    refreshControls();
  }

  function useSlot(i) {
    if (!B || B.over || !B.rt) return;
    const k = B.act(0).memory[i]; if (!k) return;
    if (ENG.isAttack(k)) { B.rt[0].queued = k; refreshControls(); beep(520, 0.03, 'square', 0.02); return; }
    if (paused) setPaused(false);
    const ev = B.useActive(k);
    if (!ev) { toast(B.rt[0].cds[k] > 0 ? 'That active is cooling down.' : 'Not enough Flux.'); return; }
    consume(ev);
  }
  function utility(action, busyMsg) {
    if (!B || B.over) return false;
    const ev = B.useUtility(action);
    if (!ev) { toast(busyMsg); return false; }
    consume(ev); refreshControls();
    return true;
  }

  function refreshControls() {
    if (!B || !B.rt || !ui) return;
    const rt = B.rt[0], d = B.act(0), flux = B.sides[0].v.flux;
    const q = rt.queued, qr = q && ENG.rec(q);
    const full = B.gcdFor(0, qr);
    const fill = $('gcdFill'), txt = $('gcdText');
    if (fill) {
      fill.style.width = (clamp(1 - rt.gcd / full, 0, 1) * 100) + '%';
      fill.classList.toggle('ready', rt.gcd <= 0);
      txt.textContent = paused ? 'Paused · tap Pause or press Space to resume'
        : !q ? 'Tap a red attack to queue it'
        : rt.starved ? `${mergeLabel(q)}: waiting for Flux (${Math.floor(flux)}/${qr.flux})`
        : rt.gcd > 0 ? `Next: ${mergeLabel(q)} in ${rt.gcd.toFixed(1)}s` : `Firing ${mergeLabel(q)}`;
      if (rt.starved) tip('flux', 'Your queued attack needs more Flux. Rest (↻) refills a big chunk, or queue a cheaper attack.');
    }
    document.querySelectorAll('#bctrl .ab[data-key]').forEach(b => {
      const k = b.dataset.key, r = ENG.rec(k), cdEl = b.querySelector('.cdo');
      const short = r.flux > flux;
      if (ENG.isAttack(k)) { b.classList.toggle('q', k === q); b.classList.toggle('short', short); }
      else {
        const cd = rt.cds[k] || 0, tot = ENG.cooldownFor(r);
        b.classList.toggle('cooling', cd > 0); b.classList.toggle('short', short); b.classList.toggle('ready', !cd && !short);
        cdEl.style.setProperty('--p', cd > 0 ? (cd / tot * 360) + 'deg' : '0deg');
        cdEl.textContent = cd > 0 ? Math.ceil(cd) + 's' : '';
      }
    });
    const cdu = (id, key, lock) => {
      const el = $('cdu-' + id); if (!el) return;
      const cd = key ? rt.cds[key] || 0 : 0, tot = key ? ENG.UTIL_CD[key] || 1 : 1;
      el.style.setProperty('--p', cd > 0 ? (cd / tot * 360) + 'deg' : '0deg');
      el.textContent = cd > 0 ? Math.ceil(cd) + 's' : '';
      el.parentElement.classList.toggle('cooling', cd > 0 || !!lock);
    };
    cdu('rest', 'defrag'); cdu('bag', 'item'); cdu('swap', 'switch', rt.gcd > 0);
    const pb = document.querySelector('#bctrl [data-u=pause]'); if (pb) pb.classList.toggle('on', paused);
    const rb = document.querySelector('#bctrl [data-u=rest]'); if (rb) rb.classList.toggle('hot', flux < (qr ? qr.flux : 0) && !rt.cds.defrag);
    const bind = $('bindBtn');
    if (bind) {
      const lat = bestLattice(), ch = lat ? chanceWith(lat) : 0;
      bind.disabled = !lat || rt.gcd > 0;
      bind.classList.toggle('hot', ch >= 0.35);
      bind.innerHTML = lat ? `<span>◇ Bind</span><b>${Math.round(ch * 100)}%</b><small>${esc(lat.name)} ×${lat.count}${rt.gcd > 0 ? ' · after GCD' : ''}</small>` : '<span>◇ Bind</span><small>No lattices left</small>';
      if (ui[1].hp / ui[1].max < 0.5) tip('bind', 'The foe is weak. Tap Bind to capture it. Lower HP and status effects raise the odds.');
    }
    // foe cast bar telegraphs its next action
    const fc = $('cast1'); if (fc) { const e = B.rt[1]; fc.style.width = (clamp(1 - e.gcd / B.gcdFor(1, null), 0, 1) * 100) + '%'; }
    const pc = $('cast0'); if (pc) pc.style.width = (clamp(1 - rt.gcd / full, 0, 1) * 100) + '%';
  }

  function panel(title, html, back) {
    setPaused(true);
    const p = $('bpanel'); $('bctrl').classList.add('hidden'); p.classList.remove('hidden');
    p.innerHTML = `<div class="ph"><span>${title} <em class="fine">· paused</em></span>${back !== false ? '<button class="btn small" data-back>Back</button>' : ''}</div>${html}`;
    const bb = p.querySelector('[data-back]'); if (bb) bb.onclick = closePanel;
    p.scrollTop = 0;
    return p;
  }
  function closePanel() { $('bpanel').classList.add('hidden'); $('bctrl').classList.remove('hidden'); buildControls(); setPaused(false); }

  function panelCompose() {
    const d = B.act(0), w = ENG.width(d);
    tip('compose', 'Choose two main essences and bind sub-essences to either one. Strike, Barrage and Siphon merges become red attacks; Hex, Ward, Mend and Field become violet actives with a cooldown.');
    const p = panel(`Compose · up to ${w} sub${w > 1 ? 's' : ''}`, '<div id="cmp"></div>');
    const remember = k => { if (!d.memory.includes(k)) { const i = d.memory.indexOf(null); if (i >= 0) { d.memory[i] = k; toast(`Saved to memory slot ${i + 1}.`); } } };
    composer(p.querySelector('#cmp'), {
      mains: ENG.mainsOf(d.key), subs: d.attuned, width: w, extra: k => `<div class="row">${kindBadge(k)}</div>`,
      actions: [
        { label: 'Use now', pri: true, ok: k => ENG.rec(k).flux <= B.sides[0].v.flux, fn: k => {
          remember(k); closePanel();
          if (ENG.isAttack(k)) { B.rt[0].queued = k; refreshControls(); }
          else { const ev = B.useActive(k); if (ev) consume(ev); else toast('That active is cooling down.'); }
        } },
        { label: 'Save to memory', ok: k => !d.memory.includes(k), fn: k => { const i = d.memory.indexOf(null), slot = i >= 0 ? i : 3; d.memory[slot] = k; toast(`Saved to memory slot ${slot + 1}.`); closePanel(); } },
      ],
    });
  }

  function panelSwitch(forced) {
    const html = `<div class="plist">${S.party.map((d, i) => partyCard(d, i === B.sides[0].active)).join('')}</div>${forced ? '' : '<p class="fine">Swapping uses your global cooldown and has a 4s cooldown.</p>'}`;
    const p = panel(forced ? 'Choose your next daemon' : 'Swap daemon', html, !forced);
    p.querySelectorAll('[data-i]').forEach(b => { b.onclick = () => {
      const i = +b.dataset.i, d = S.party[i];
      if (d.hp <= 0 || i === B.sides[0].active) return;
      if (forced) { const ev = B.forceSwitch(i); closePanel(); consume(ev); startLoop(); return; }
      closePanel();
      utility({ type: 'switch', idx: i }, 'Wait for your global cooldown before swapping.');
    }; });
    hydrateCanvases(p);
  }

  function panelBag() {
    const items = Object.values(S.bag).filter(it => it.count > 0 && ['patch', 'ward', 'catalyst', 'cell'].includes(it.kind));
    const html = items.length ? `<div class="mlist">${items.map(it => `<button class="mbtn" data-id="${esc(it.id)}" data-tip="i:${esc(it.id)}"><span class="t">${esc(it.name)} ×${it.count}</span><span class="m">${itemDesc(it)}</span></button>`).join('')}</div><p class="fine">Items fire instantly and share a 6s cooldown.</p>`
      : '<p class="sub">No battle items. Forge Patches, Modules, Catalysts and Flux Cells from motes at the Nexus Forge.</p>';
    const p = panel('Items', html);
    p.querySelectorAll('[data-id]').forEach(b => { b.onclick = () => {
      const it = S.bag[b.dataset.id];
      closePanel();
      if (utility({ type: 'item', item: it }, 'Items are cooling down.')) { it.count--; if (it.count <= 0 && it.id !== 'lattice:basic') delete S.bag[it.id]; }
    }; });
  }

  function panelInfo(side) {
    const d = B.act(side), r = ENG.rec(d.key), pv = ENG.PASSIVES[r.dPassive], v = B.sides[side].v;
    const st = side === 0 ? v.stats : null;
    const nm = { atk: 'Logic', def: 'Firewall', spd: 'Clock', acc: 'Accuracy', eva: 'Evasion' };
    const stages = Object.entries(v.stages).filter(([, x]) => x).map(([k, x]) => `${nm[k]} ${x > 0 ? '+' : ''}${x}`).join(', ') || 'none';
    const status = v.status ? `${ENG.STATUS[v.status.id].name} (${v.status.turns * ENG.PULSE}s left)` : 'none';
    const html = `<div class="info"><canvas data-sprite="${d.key}" ${d.prism ? 'data-prism="1"' : ''} width="96" height="96"></canvas><div>
      <div class="pn">${esc(dName(d))} <span class="fine">Lv ${d.level} · ${TIER[r.tier]}</span></div>${genomeHTML(d.key)}
      <p class="fine"><span class="kb pas">Passive</span> <b>${pv[0]}</b>: ${esc(pv[1])}</p>
      <p class="fine">Status: ${esc(status)} · Stat changes: ${esc(stages)}${v.shield ? ` · Shield ${v.shield}` : ''} · Global cooldown ${B.gcdFor(side, null).toFixed(1)}s</p>
      ${st ? `<p class="fine">Logic ${st.atk} · Firewall ${st.def} · Clock ${st.spd} · Coherence ${st.coh}</p>` : `<p class="fine">Pure merges against it: ${E.MAINS.map(m => `<span style="color:${MAINC(m)}">${E.MAIN[m].name} ×${ENG.effectiveness(m + m, d.key)}</span>`).join(' · ')}</p>`}
      </div></div>`;
    const p = panel(side === 0 ? 'Your daemon' : 'Foe', html);
    hydrateCanvases(p);
  }

  async function endBattle() {
    const res = B.result, o = bctx;
    await sleep(250);
    if (res === 'win') {
      for (const [k, n] of Object.entries(B.rewards.motes)) S.motes[k] = (S.motes[k] || 0) + n;
      const got = Object.entries(B.rewards.motes).map(([k, n]) => `${n} ${E.MAIN[k] ? E.MAIN[k].name : E.SUB[k].name}`).join(', ');
      if (got) await logMsg(`Collected motes: ${got}.`);
      if (o.wild) { S.stats.wild++; questEvent('defeat'); }
      if (o.trainer && !o.rift) {
        if (o.rematch) S.rematches[o.trainer.id] = (S.rematches[o.trainer.id] || 0) + 1;
        else if (!S.beaten.includes(o.trainer.id)) S.beaten.push(o.trainer.id);
        grant({ lattices: o.rematch ? 3 : 2 });
        await logMsg(`Received ${o.rematch ? 3 : 2} Basic Lattices.`);
      }
    }
    if (res === 'bind') {
      const d = B.rewards.bound;
      d.uid = 'd' + Date.now().toString(36) + rnd(1e6).toString(36);
      boundForms.add(d.key); seen.add(d.key);
      S.stats.binds++;
      if (d.prism) S.prisms.push(d.key);
      if (S.party.length < 6) S.party.push(d); else { S.box.push(d); toast(`${esc(dName(d))} was sent to Storage.`); }
      questEvent('bind', { key: d.key });
    }
    for (const k of B.discovered) if (!discovered.has(k)) markDiscovered(k, true);
    $('battle').classList.add('hidden');
    mode = 'busy';
    if (res === 'lose') {
      for (const d of S.party) d.hp = ENG.calcStats(d).hp;
      player.x = player.px = follower.x = follower.px = S.lastHeal.x; player.y = player.py = follower.y = follower.py = S.lastHeal.y;
      if (o.rift) { S.rift.best = Math.max(S.rift.best, o.floor - 1); riftRun = null; }
      await say('System', [o.rift ? `The Rift ejects you after floor ${o.floor - 1}.` : 'All of your daemons were deallocated...', 'Rebooting at the last terminal. Your daemons have been restored.']);
    }
    await processXp();
    if (res === 'win' && o.trainer && !o.rift && !o.rematch) {
      await say(o.trainer.name, [o.trainer.outro]);
      if (o.trainer.badge && !S.keys.includes(o.trainer.badge)) {
        S.keys.push(o.trainer.badge); S.badges = S.keys.length;
        await say('System', [`You received the ${o.trainer.badge}! (${Math.min(S.badges, 4)}/4)` + (o.trainer.final ? '' : ' A firewall gate somewhere just opened.')]);
      }
      if (o.trainer.final) { S.won = true; B = null; bctx = null; save(); showEnding(); return; }
    }
    if (res === 'win' && o.rematch) await say(o.trainer.name, ['Now that was a real test. Come back any time.']);
    if (res === 'win' && o.rift && (await riftCleared(o.floor))) { B = null; startRiftFloor(o.floor + 1); return; }
    B = null; bctx = null;
    save();
    $('hud').classList.remove('hidden'); updateHud();
    mode = 'world'; setPad(true);
  }

  async function processXp() {
    const list = pendingXp; pendingXp = [];
    const byUid = new Map();
    for (const e of list) { const x = byUid.get(e.uid) || { attune: 0, recompile: false }; x.attune += e.attune; x.recompile = x.recompile || e.recompile; byUid.set(e.uid, x); }
    for (const [uid, x] of byUid) {
      const d = S.party.find(p => p.uid === uid); if (!d) continue;
      for (let i = 0; i < x.attune; i++) await attuneModal(d);
      if (x.recompile) await recompileModal(d);
    }
  }

  // ------------------------------------------------------------------ the Rift
  async function riftTerminal() {
    mode = 'busy'; setPad(false);
    if (!S.won) { await say('Rift', ['A tear in the lattice, humming with every merge at once. It stays sealed until the Architect falls.']); mode = 'world'; setPad(true); return; }
    const c = await choose('The Rift', `Endless floors of daemons drawn from the entire lattice, any of the ${M.count} genomes. Floors get harder, every fifth floor holds a guardian, and rewards grow as you descend. You recover 30% HP between floors and can leave after any floor. Your best: floor ${S.rift.best}.`, ['Enter the Rift', 'Not now']);
    if (c !== 0) { mode = 'world'; setPad(true); return; }
    startRiftFloor(1);
  }
  function riftTeam(n) {
    const boss = n % 5 === 0;
    const tierMax = Math.min(3, 1 + Math.floor(n / 4)), tierMin = boss ? tierMax : Math.min(3, Math.floor(n / 7));
    const size = boss ? 3 : n >= 8 ? 2 : 1;
    const lvl = Math.round(Math.max(24, partyAvg() - 3) + n * 1.1);
    const team = [];
    for (let i = 0; i < size; i++) {
      const pool = BY_TIER[tierMin + rnd(tierMax - tierMin + 1)];
      team.push(ENG.createDaemon(pool[rnd(pool.length)], Math.min(ENG.LEVEL_CAP, lvl + (boss && i === size - 1 ? 3 : 0)), { extraAttune: 2 }));
    }
    return team;
  }
  function startRiftFloor(n) {
    riftRun = { floor: n };
    startBattle({ enemy: riftTeam(n), wild: false, trainer: { name: `Rift · Floor ${n}`, id: 'rift' }, rift: true, floor: n, zone: 'core' });
  }
  async function riftCleared(n) {
    S.rift.best = Math.max(S.rift.best, n);
    const rw = { motes: {} };
    for (let i = 0; i < 2 + Math.floor(n / 2); i++) { const k = rnd(3) ? E.SUB_ORDER[rnd(16)] : E.MAINS[rnd(4)]; rw.motes[k] = (rw.motes[k] || 0) + 1; }
    let script = '';
    if (n % 5 === 0) {
      rw.lattices = 2;
      const s = E.SUB_ORDER[rnd(16)], id = 'script:rift-' + s;
      if (S.bag[id]) S.bag[id].count++; else S.bag[id] = { id, kind: 'script', name: `${E.SUB[s].name} Attune Script`, subs: [s], count: 1 };
      script = `, and a ${E.SUB[s].name} Attune Script`;
    }
    grant(rw);
    for (const d of S.party) if (d.hp > 0) { const mx = ENG.calcStats(d).hp; d.hp = Math.min(mx, d.hp + Math.ceil(mx * 0.3)); }
    save();
    const c = await choose(`Floor ${n} cleared`, `Rewards: ${rewardText(rw)}${script}. Your daemons recover 30% HP. ${(n + 1) % 5 === 0 ? `A guardian holds floor ${n + 1}.` : `Floor ${n + 1} is next.`}`, [`Descend to floor ${n + 1}`, 'Leave the Rift']);
    if (c !== 0) riftRun = null;
    return c === 0;
  }

  // ------------------------------------------------------------------ modals
  function modal(html) { $('modal').classList.remove('hidden'); $('modalCard').innerHTML = html; hydrateCanvases($('modalCard')); return $('modalCard'); }
  function closeModal() { $('modal').classList.add('hidden'); }
  // In-page replacement for confirm(): resolves the index of the button pressed.
  function choose(title, text, buttons) {
    return new Promise(res => {
      const card = modal(`<h2>${esc(title)}</h2><p>${esc(text)}</p><div class="btnrow">${buttons.map((b, i) => `<button class="btn ${i ? '' : 'pri'}" data-c="${i}">${esc(b)}</button>`).join('')}</div>`);
      card.querySelectorAll('[data-c]').forEach(b => { b.onclick = () => { closeModal(); res(+b.dataset.c); }; });
    });
  }
  // In-page replacement for prompt(): resolves the text, or null on cancel.
  function askText(title, text, value, ok) {
    return new Promise(res => {
      const card = modal(`<h2>${esc(title)}</h2><p>${esc(text)}</p><input class="search" id="askInput" maxlength="16" value="${esc(value)}"><div class="btnrow"><button class="btn pri" data-ok>${esc(ok)}</button><button class="btn" data-cancel>Cancel</button></div>`);
      const inp = card.querySelector('#askInput'); inp.focus(); inp.select();
      const done = v => { closeModal(); res(v); };
      card.querySelector('[data-ok]').onclick = () => done(inp.value);
      card.querySelector('[data-cancel]').onclick = () => done(null);
      inp.onkeydown = e => { if (e.key === 'Enter') done(inp.value); };
    });
  }

  function attuneModal(d) {
    return new Promise(res => {
      const pool = ENG.eligibleSubs(d.key).filter(s => !d.attuned.includes(s));
      if (!pool.length) return res();
      const opts = [];
      while (opts.length < Math.min(3, pool.length)) { const s = pool[rnd(pool.length)]; if (!opts.includes(s)) opts.push(s); }
      const card = modal(`<h2>${esc(dName(d))} can attune a new essence</h2><p>Attuned sub-essences can be used in composed merges and in recompiles. Pick one.</p>
        <div class="opts">${opts.map(s => `<button class="opt" data-s="${s}"><span class="grow">${essChip(s, E.SUB[s].host ? E.MAIN[E.SUB[s].host].name + '-bound' : 'universal')}<small>${esc(E.SUB[s].desc)}</small></span></button>`).join('')}</div>`);
      card.querySelectorAll('[data-s]').forEach(b => { b.onclick = () => { d.attuned.push(b.dataset.s); closeModal(); toast(`${esc(dName(d))} attuned ${E.SUB[b.dataset.s].name}.`); res(); }; });
    });
  }

  function recompileModal(d) {
    return new Promise(res => {
      const opts = ENG.recompileOptions(d);
      if (!opts.length) return res();
      const cur = statTotal(d.key);
      const card = modal(`<h2>${esc(dName(d))} is ready to recompile</h2><p>Binding one attuned sub-essence into its genome creates a new form. This can't be undone. You can also wait and recompile later from the Party menu.</p>
        <div class="opts">${opts.map(k => { const r = ENG.rec(k), p = E.parseKey(k), added = p.subs.find(t => !E.parseKey(d.key).subs.some(u => u.s === t.s && u.h === t.h)); const dt = statTotal(k) - cur;
          return `<button class="opt" data-k="${k}"><canvas data-sprite="${k}" ${d.prism ? 'data-prism="1"' : ''} width="64" height="64"></canvas><span class="grow"><b>${seen.has(k) ? esc(r.dName) : '??? form'}</b> <span class="delta up">+${dt} stats</span><small>+ ${E.SUB[added.s].name} → ${E.MAIN[E.hostMain(p, added.h)].name} · passive ${ENG.PASSIVES[r.dPassive][0]}</small></span></button>`; }).join('')}</div>
        <button class="btn" data-no>Not now</button>`);
      card.querySelectorAll('[data-k]').forEach(b => { b.onclick = () => {
        const before = dName(d);
        ENG.recompile(d, b.dataset.k); seen.add(d.key); boundForms.add(d.key);
        closeModal();
        toast(`${esc(before)} recompiled into <b>${esc(ENG.rec(d.key).dName)}</b>!`, 'rare');
        res();
      }; });
      card.querySelector('[data-no]').onclick = () => { closeModal(); res(); };
    });
  }

  function hydrateCanvases(root) {
    root.querySelectorAll('canvas[data-sprite]').forEach(c => SP.paint(c, c.dataset.sprite, { silhouette: c.dataset.sil === '1', prism: c.dataset.prism === '1' }));
  }

  // ------------------------------------------------------------------ composer
  // What the player can reason about before a merge is discovered: the pair
  // reaction, what each bound sub tends to do on its host, and whether the
  // chosen subs resonate (named once found, hinted before).
  function composeHints(a, b, toks) {
    const rx = E.REACTION[E.pairId(a, b)];
    const out = [`<span class="hint">${esc(rx.names[a])}${rx.volatile ? ' · <b class="bad">volatile</b>' : ''}</span>`];
    const present = new Set();
    for (const t of toks) {
      const s = t.slice(0, 2), host = t[2] === '1' ? a : b, sub = E.SUB[s];
      present.add(s);
      out.push(sub.host ? `<span class="hint" style="color:${subColor(s)}">${sub.name}: ${E.EFFECTS[sub.fx]}</span>`
        : `<span class="hint" style="color:${subColor(s)}">${sub.name} on ${E.MAIN[host].name}: ${E.FACET[s][host].name} (${E.EFFECTS[E.FACET[s][host].fx]})</span>`);
    }
    const found = resonancesFound();
    for (const r of E.RESONANCE) if (r.subs.every(s => present.has(s))) out.push(found.has(r.name) ? `<span class="hint res">✧ ${r.name}</span>` : '<span class="hint res">✧ Two of these essences resonate…</span>');
    for (const r of E.TRINITY) if (r.subs.every(s => present.has(s))) out.push(found.has(r.name) ? `<span class="hint tri">✦ ${r.name}</span>` : '<span class="hint tri">✦ Perfect alignment…</span>');
    return out.join('');
  }

  function composer(root, o) {
    const mains = Array.from(new Set(o.mains));
    let a = mains[0], b = mains[1] || mains[0];
    const tok = new Set(); // "Em1"
    if (o.initial) { const p = E.parseKey(o.initial); a = p.a; b = p.b; for (const t of p.subs) tok.add(t.s + t.h); }
    const key = () => E.makeKey(a, b, [...tok].map(t => ({ s: t.slice(0, 2), h: +t[2] })));
    const hostsFor = s => { const h = []; if (E.eligible(s, a)) h.push(1); if (a !== b && E.eligible(s, b)) h.push(2); return h; };
    const cycle = s => {
      const hs = hostsFor(s);
      const cur = hs.filter(h => tok.has(s + h));
      const states = [[]].concat(hs.map(h => [h]));
      if (hs.length === 2) states.push([1, 2]);
      let idx = states.findIndex(st => st.length === cur.length && st.every(h => cur.includes(h)));
      const others = [...tok].filter(t => t.slice(0, 2) !== s).length;
      for (let n = 0; n < states.length; n++) { idx = (idx + 1) % states.length; if (others + states[idx].length <= o.width) break; }
      for (const h of [1, 2]) tok.delete(s + h);
      for (const h of states[idx]) tok.add(s + h);
    };
    const prune = () => { for (const t of [...tok]) { const s = t.slice(0, 2), h = +t[2]; if (!hostsFor(s).includes(h)) tok.delete(t); } };
    function render() {
      prune();
      const k = key(), r = ENG.rec(k), known = discovered.has(k);
      const mainBtns = which => mains.map(m => `<button class="mainbtn ${((which === 1 ? a : b) === m) ? 'on' : ''}" style="--c:${MAINC(m)}" data-m${which}="${m}">${E.MAIN[m].name}</button>`).join('');
      const subsHTML = E.SUB_ORDER.filter(s => o.subs.includes(s)).map(s => {
        const hs = hostsFor(s), on = hs.filter(h => tok.has(s + h));
        const hostLbl = on.map(h => E.MAIN[h === 1 ? a : b].name[0]).join('+');
        const cnt = o.counts ? `<span class="cnt">×${o.counts[s] || 0}</span>` : '';
        return `<button class="subchip ${on.length ? 'on' : ''}" style="--c:${subColor(s)};--hc:${on.length ? MAINC(on[0] === 1 ? a : b) : '#333'}" data-s="${s}" ${hs.length ? '' : 'disabled'}>
          <span style="color:${subColor(s)}">◆</span> ${E.SUB[s].name}${on.length ? `<span class="host">${hostLbl}</span>` : ''}<small>${E.SUB[s].host ? E.MAIN[E.SUB[s].host].name + ' only' : 'any host'}</small>${cnt}</button>`;
      }).join('');
      const pk = a + b;
      const fxHTML = known ? r.fx.map(f => `<span class="st ${E.SELF_FX.has(f.code) ? 'good' : f.code === 'recoil' ? 'bad' : 'inf'}">${esc(ENG.describeFx(f))}</span>`).join('') : '';
      const prev = known ? `<div class="preview">
          <span class="genome">${kindBadge(k)}<span class="rar r${r.rarity}">${RARITY[r.rarity]}</span><span class="cls">${r.cls}</span>${r.tags.map(t => `<span class="rar r2">${esc(t)}</span>`).join('')}</span>
          <div class="pn">${esc(r.name)}</div>
          <div class="pm">${r.damaging ? `<span>Power <b>${r.power}${r.hits > 1 ? '×' + r.hits : ''}</b></span>` : ''}<span>Acc <b>${r.acc > 100 ? 'sure' : r.acc}</b></span><span>Flux <b>${r.flux}</b></span>${r.prio ? `<span>Priority <b>${r.prio > 0 ? '+' : ''}${r.prio}</b></span>` : ''}<span>Instability <b style="color:${r.instab >= 35 ? 'var(--bad)' : r.instab >= 18 ? 'var(--warn)' : 'var(--good)'}">${r.instab}%</b></span></div>
          <div class="fxl">${fxHTML}</div>
          <div class="txt">${esc(E.REACTION[E.pairId(a, b)].line + ' ' + r.text)}</div></div>`
        : `<div class="preview unknown"><div class="pn">? ? ? ? ?</div><div class="pm"><span>Flux <b>${r.flux}</b></span><span>${o.forge ? 'Forge' : 'Cast'} it to reveal what it becomes.</span></div><div class="fxl">${composeHints(a, b, [...tok])}</div></div>`;
      root.innerHTML = `<div class="composer">
        <div class="row"><label>Main</label>${mainBtns(1)}</div>
        ${mains.length > 1 ? `<div class="row"><label>Second</label>${mainBtns(2)}</div>` : ''}
        <div class="row"><label>Subs ${tok.size}/${o.width}</label><span class="fine">Tap to bind, tap again to switch host.</span></div>
        <div class="subgrid">${subsHTML || '<span class="fine">No sub-essences attuned yet. They come with levels, scripts and recompiles.</span>'}</div>
        <div class="row">${genomeHTML(k)}<span class="fine">${countPair(pk)}/${pairTotal(pk)} found</span></div>
        ${prev}
        ${o.extra ? o.extra(k) : ''}
        <div class="btnrow">${o.actions.map((ac, i) => `<button class="btn ${ac.pri ? 'pri' : ''}" data-act="${i}" ${ac.ok && !ac.ok(k) ? 'disabled' : ''}>${ac.label}</button>`).join('')}</div>
      </div>`;
      root.querySelectorAll('[data-m1]').forEach(x => { x.onclick = () => { a = x.dataset.m1; render(); }; });
      root.querySelectorAll('[data-m2]').forEach(x => { x.onclick = () => { b = x.dataset.m2; render(); }; });
      root.querySelectorAll('[data-s]').forEach(x => { x.onclick = () => { cycle(x.dataset.s); render(); }; });
      root.querySelectorAll('[data-act]').forEach(x => { x.onclick = () => o.actions[+x.dataset.act].fn(key(), render); });
    }
    render();
  }

  // ------------------------------------------------------------------ menus
  const TABS = [['party', 'Party'], ['bag', 'Bag'], ['requests', 'Requests'], ['codex', 'Codex'], ['forge', 'Forge'], ['system', 'System']];
  function openSheet(tab) {
    if (mode !== 'world' && mode !== 'sheet') return;
    mode = 'sheet'; setPad(false);
    sheetTab = tab; detailUid = null;
    $('sheet').classList.remove('hidden'); $('hud').classList.add('hidden');
    renderSheet();
  }
  function closeSheet() { $('sheet').classList.add('hidden'); $('hud').classList.remove('hidden'); mode = 'world'; setPad(true); updateHud(); save(); }
  $('sheetClose').onclick = closeSheet;
  function atForge() { const [dx, dy] = DIRS[player.dir]; return tileAt(player.x + dx, player.y + dy) === 'F'; }

  function renderSheet() {
    $('sheetTabs').innerHTML = TABS.filter(([id]) => id !== 'forge' || atForge()).map(([id, nm]) => `<button class="${id === sheetTab ? 'on' : ''}" data-tab="${id}">${nm}${id === 'requests' ? ` <small>${S.quests.length}</small>` : ''}</button>`).join('');
    $('sheetTabs').querySelectorAll('[data-tab]').forEach(b => { b.onclick = () => { sheetTab = b.dataset.tab; detailUid = null; renderSheet(); }; });
    const body = $('sheetBody');
    body.scrollTop = 0;
    ({ party: sheetParty, bag: sheetBag, requests: sheetRequests, codex: sheetCodex, forge: sheetForge, system: sheetSystem })[sheetTab](body);
    hydrateCanvases(body);
  }

  function partyCard(d, sel, idx) {
    const st = ENG.calcStats(d), pct = clamp(d.hp / st.hp, 0, 1);
    const i = idx != null ? idx : S.party.indexOf(d);
    const canRc = ENG.recompileOptions(d).length > 0;
    return `<button class="pcard ${d.hp <= 0 ? 'fainted' : ''} ${sel ? 'sel' : ''}" data-i="${i}" data-uid="${d.uid}">
      <canvas data-sprite="${d.key}" ${d.prism ? 'data-prism="1"' : ''} width="64" height="64"></canvas>
      <span class="grow"><span class="n">${esc(dName(d))}${d.prism ? ' <em class="prism">✦</em>' : ''}<span>Lv ${d.level}</span></span>${genomeDots(d.key)}
      <span class="bar"><i style="width:${pct * 100}%;background:${pct > 0.5 ? 'var(--good)' : pct > 0.2 ? 'var(--warn)' : 'var(--bad)'}"></i></span>
      <span class="nums"><span>HP ${d.hp}/${st.hp}</span><span>${canRc ? '<b class="rc">Recompile ready</b>' : TIER[E.parseKey(d.key).subs.length]}</span></span></span></button>`;
  }

  function sheetParty(body) {
    if (detailUid) return daemonDetail(body, detailUid);
    body.innerHTML = `<h3>Party (${S.party.length}/6)</h3><div class="plist">${S.party.map(d => partyCard(d)).join('')}</div>
      <p class="fine">Daemons that sit out a battle still earn half XP, as long as they're standing.</p>
      <h3>Storage (${S.box.length})</h3>${S.box.length ? `<div class="plist">${S.box.map((d, i) => partyCard(d, false, 'b' + i)).join('')}</div>` : '<p class="sub">Daemons you bind with a full party are stored here.</p>'}`;
    body.querySelectorAll('[data-uid]').forEach(b => { b.onclick = () => { detailUid = b.dataset.uid; renderSheet(); }; });
  }
  const findDaemon = uid => S.party.find(d => d.uid === uid) || S.box.find(d => d.uid === uid);

  function daemonDetail(body, uid) {
    const d = findDaemon(uid); if (!d) { detailUid = null; return sheetParty(body); }
    const inParty = S.party.includes(d);
    const r = ENG.rec(d.key), st = ENG.calcStats(d), pv = ENG.PASSIVES[r.dPassive];
    const stats = [['HP', st.hp, r.dStats[0]], ['Logic', st.atk, r.dStats[1]], ['Firewall', st.def, r.dStats[2]], ['Clock', st.spd, r.dStats[3]], ['Flux', st.flux, r.dStats[4]], ['Coherence', st.coh, r.dStats[5]]];
    const rc = ENG.recompileOptions(d);
    const next = ENG.xpFor(d.level + 1), cur = ENG.xpFor(d.level);
    const w = ENG.width(d);
    body.innerHTML = `<button class="btn small" data-back>← Party</button>
      <div class="detail">
        <div><canvas class="big" data-sprite="${d.key}" ${d.prism ? 'data-prism="1"' : ''} width="160" height="160"></canvas></div>
        <div>
          <h2>${esc(dName(d))}${d.prism ? ' <em class="prism">✦ prismatic</em>' : ''} <span class="fine">Lv ${d.level} · ${TIER[r.tier]}</span></h2>
          ${genomeHTML(d.key)}
          <p class="lore">${esc(lore(d.key))}</p>
          <div class="xpbar"><i style="width:${clamp((d.xp - cur) / (next - cur), 0, 1) * 100}%"></i></div>
          <div class="fine">XP ${d.xp - cur}/${next - cur} · Passive <b>${pv[0]}</b>: ${esc(pv[1])}</div>
        </div>
      </div>
      ${rc.length ? '<div class="btnrow gap"><button class="btn pri" data-rc>Recompile into a new form…</button></div>' : ''}
      <h3>Memory</h3>
      <div class="mem">${d.memory.map((k, i) => `<button class="mbtn" data-slot="${i}" ${k ? `data-tip="m:${k}"` : ''} style="--lc:${k ? (ENG.isAttack(k) ? 'var(--atk)' : 'var(--act)') : 'var(--line)'}"><span class="t">${k ? esc(mergeLabel(k)) : '— empty slot —'}</span>${k ? `<span class="m">${genomeDots(k)}${discovered.has(k) ? `<span class="cls">${ENG.rec(k).cls}</span>` : ''}<span>Flux ${ENG.rec(k).flux}</span></span>` : '<span class="m">Tap to compose</span>'}</button>`).join('')}</div>
      <div id="memEdit"></div>
      <h3>Attuned essences · merges up to ${w} sub${w > 1 ? 's' : ''}</h3>
      <span class="genome">${ENG.mainsOf(d.key).map(m => essChip(m)).join('')}${d.attuned.map(s => essChip(s)).join('')}</span>
      <p class="fine">Next attunements at levels ${ENG.ATTUNE_LEVELS.filter(l => l > d.level).slice(0, 3).join(', ') || '—'}. Sub width grows at 10 and 22. Recompiles unlock at ${ENG.RECOMPILE_LEVELS.join(', ')}.</p>
      <h3>Stats</h3>
      <div class="kv">${stats.map(([n, v, b]) => `<span class="lab">${n}</span><span class="sbar"><i style="width:${Math.min(100, b / 1.6)}%"></i></span><b>${v}</b>`).join('')}</div>
      <h3>Manage</h3>
      <div class="btnrow">
        ${inParty && S.party.indexOf(d) > 0 ? '<button class="btn" data-lead>Make lead</button>' : ''}
        ${inParty && S.party.length > 1 ? '<button class="btn" data-store>Move to storage</button>' : ''}
        ${!inParty && S.party.length < 6 ? '<button class="btn" data-take>Move to party</button>' : ''}
        <button class="btn" data-auto>Auto-fill memory</button>
        <button class="btn" data-nick>Rename</button>
      </div>`;
    body.querySelector('[data-back]').onclick = () => { detailUid = null; renderSheet(); };
    body.querySelectorAll('[data-slot]').forEach(b => { b.onclick = () => {
      const i = +b.dataset.slot, box = body.querySelector('#memEdit');
      box.innerHTML = `<h3>Compose memory slot ${i + 1}</h3><div id="cmpm"></div>`;
      composer(box.querySelector('#cmpm'), {
        mains: ENG.mainsOf(d.key), subs: d.attuned, width: w, initial: d.memory[i] || undefined,
        actions: [
          { label: 'Save to slot', pri: true, fn: k => { d.memory[i] = k; save(); renderSheet(); } },
          { label: 'Clear slot', fn: () => { d.memory[i] = null; renderSheet(); } },
        ],
      });
      box.scrollIntoView({ behavior: 'smooth' });
    }; });
    const q = s => body.querySelector(s);
    if (q('[data-lead]')) q('[data-lead]').onclick = () => { S.party.splice(S.party.indexOf(d), 1); S.party.unshift(d); renderSheet(); };
    if (q('[data-rc]')) q('[data-rc]').onclick = async () => { await recompileModal(d); renderSheet(); };
    if (q('[data-store]')) q('[data-store]').onclick = () => { S.party.splice(S.party.indexOf(d), 1); S.box.push(d); renderSheet(); };
    if (q('[data-take]')) q('[data-take]').onclick = () => { S.box.splice(S.box.indexOf(d), 1); S.party.push(d); renderSheet(); };
    q('[data-auto]').onclick = () => {
      // strongest merges the player already knows first, then the engine's picks
      const known = ENG.composableFor(d).filter(k => discovered.has(k) && ENG.rec(k).damaging)
        .sort((x, y) => (ENG.rec(y).power * ENG.rec(y).hits) - (ENG.rec(x).power * ENG.rec(x).hits)).slice(0, 2);
      d.memory = [...new Set(known.concat(ENG.autoMemory(d).filter(Boolean)))].slice(0, 4).concat([null, null, null, null]).slice(0, 4);
      toast('Memory filled.'); renderSheet();
    };
    q('[data-nick]').onclick = async () => { const n = await askText('Rename daemon', 'Leave it empty to use the form name.', d.nick || '', 'Rename'); if (n !== null) { d.nick = n.trim().slice(0, 16) || null; renderSheet(); } };
  }

  function itemDesc(it) {
    switch (it.kind) {
      case 'lattice': return `Binds wild daemons. Strength ×${it.power}${it.main ? `, ×1.5 against ${E.MAIN[it.main].name}-led daemons` : ''}. The Bind button picks your best one.`;
      case 'patch': return `Restores ${it.mag}% HP${it.cleanse ? ' and clears status' : ''}.`;
      case 'ward': return `In battle: shield for ${it.mag}% of max HP.`;
      case 'catalyst': return `In battle: +3 ${E.MAIN[it.main].name} residue and a ${E.MAIN[it.main].name} field.`;
      case 'script': return `Attunes a daemon to ${it.subs.map(s => E.SUB[s].name).join(' / ')} (the first one it can take).`;
      case 'cell': return 'In battle: fully restores Flux.';
      default: return '';
    }
  }

  function sheetBag(body) {
    const items = Object.values(S.bag).filter(it => it.count > 0);
    const motes = Object.entries(S.motes).filter(([, n]) => n > 0);
    body.innerHTML = `<h3>Items</h3>${items.length ? `<div class="clist">${items.map(it => `<div class="crow" data-tip="i:${esc(it.id)}" style="--lc:var(--acc)"><span class="grow"><span class="t">${esc(it.name)} ×${it.count}</span><span class="fine">${itemDesc(it)}</span></span>${['patch', 'script'].includes(it.kind) ? `<button class="btn small" data-use="${esc(it.id)}">Use</button>` : ''}</div>`).join('')}</div>` : '<p class="sub">Empty.</p>'}
      <h3>Motes</h3><p class="fine">Defeated daemons leave motes of the essences they were made from. The Nexus Forge merges them into items.</p>
      <div class="motes">${motes.length ? motes.map(([k, n]) => essChip(k, '×' + n)).join('') : '<span class="fine">None yet.</span>'}</div>
      <div id="useBox"></div>`;
    body.querySelectorAll('[data-use]').forEach(b => { b.onclick = () => {
      const it = S.bag[b.dataset.use], box = body.querySelector('#useBox');
      box.innerHTML = `<h3>Use ${esc(it.name)} on…</h3><div class="plist">${S.party.map(d => partyCard(d)).join('')}</div>`;
      hydrateCanvases(box);
      box.querySelectorAll('[data-uid]').forEach(c => { c.onclick = () => {
        const d = findDaemon(c.dataset.uid);
        if (it.kind === 'patch') {
          const st = ENG.calcStats(d); if (d.hp >= st.hp) return toast('Already at full HP.');
          d.hp = Math.min(st.hp, d.hp + Math.ceil(st.hp * it.mag / 100)); toast(`${esc(dName(d))} restored.`);
        } else if (it.kind === 'script') {
          const ok = ENG.eligibleSubs(d.key), s = it.subs.find(x => ok.includes(x) && !d.attuned.includes(x));
          if (!s) return toast(`${esc(dName(d))} can't learn anything from this script.`);
          d.attuned.push(s); toast(`${esc(dName(d))} attuned ${E.SUB[s].name}!`, 'rare');
        }
        it.count--; if (it.count <= 0 && it.id !== 'lattice:basic') delete S.bag[it.id];
        renderSheet();
      }; });
      box.scrollIntoView({ behavior: 'smooth' });
    }; });
  }

  function sheetRequests(body) {
    const next = (S.milestone + 1) * 50;
    const wardens = C.OPERATORS.filter(o => o.warden);
    const goal = wardens[Math.min(S.badges, wardens.length - 1)];
    const goalZone = C.ZONES[goal.zone] ? C.ZONES[goal.zone].name : 'the Core';
    body.innerHTML = `<h3>Archive requests</h3><p class="fine">The Archivists always have three requests open. Finishing one pays out right away and posts a new one.</p>
      <div class="qlist">${S.quests.map(q => `<div class="quest"><div class="qt">${esc(q.text)}</div><div class="xpbar"><i style="width:${q.progress / q.target * 100}%"></i></div><div class="fine">${q.progress}/${q.target} · Reward: ${esc(rewardText(q.reward))}</div></div>`).join('')}</div>
      <h3>Codex milestone</h3><div class="quest"><div class="qt">Discover ${next} merges</div><div class="xpbar"><i style="width:${(discovered.size % 50) / 50 * 100}%"></i></div><div class="fine">${discovered.size}/${next} · Reward: 2 Lattices and 3 sub-essence motes</div></div>
      <h3>Journey</h3><div class="kv two">
        <span class="lab">Next goal</span><b>${S.won ? 'Rematch Wardens, dive the Rift, fill the Codex' : `Beat ${esc(goal.name)} in ${goalZone}`}</b>
        <span class="lab">Warden keys</span><b>${S.keys.join(', ') || 'none yet'}</b>
        <span class="lab">Operators beaten</span><b>${S.beaten.length}/${C.OPERATORS.length}</b>
        <span class="lab">Rift best floor</span><b>${S.won ? S.rift.best : 'sealed'}</b>
        <span class="lab">Prismatics bound</span><b>${S.prisms.length}</b>
        <span class="lab">Reactions triggered</span><b>${S.stats.reacts}</b>
      </div>`;
  }

  function mergeDetail(k) {
    const r = ENG.rec(k), p = E.parseKey(k);
    return `<div class="preview">
      <span class="genome"><span class="rar r${r.rarity}">${RARITY[r.rarity]}</span><span class="cls">${r.cls}</span>${r.tags.map(t => `<span class="rar r2" data-tip="r:${esc(t)}">${esc(t)}</span>`).join('')}${r.anomaly ? `<span class="rar r4">Anomaly: ${esc(r.anomaly)}</span>` : ''}</span>
      <div class="pn">${esc(r.name)}</div>${genomeHTML(k)}
      <div class="pm">${r.damaging ? `<span>Power <b>${r.power}${r.hits > 1 ? '×' + r.hits : ''}</b></span>` : ''}<span>Acc <b>${r.acc > 100 ? 'sure' : r.acc}</b></span><span>Flux <b>${r.flux}</b></span><span>Priority <b>${r.prio}</b></span><span>Instability <b>${r.instab}%</b></span></div>
      <div class="fxl">${r.fx.map(f => `<span class="st ${E.SELF_FX.has(f.code) ? 'good' : f.code === 'recoil' ? 'bad' : 'inf'}">${esc(ENG.describeFx(f))}</span>`).join('')}</div>
      <div class="txt">${esc(E.REACTION[E.pairId(p.a, p.b)].line + ' ' + r.text)}</div>
      ${r.anomaly ? `<div class="txt">∆ ${esc(E.ANOMALY[r.anomaly])}</div>` : ''}
      <div class="fine">Forges into: ${esc(forgeItem(k).name)}. As a daemon genome: ${seen.has(k) ? esc(r.dName) : 'unseen form'}.</div></div>`;
  }

  function sheetCodex(body) {
    const views = [['merges', `Merges ${discovered.size}`], ['forms', `Forms ${seen.size}`], ['lexicon', 'Lexicon']];
    body.innerHTML = `<div class="subtabs">${views.map(([id, nm]) => `<button class="${codexView === id ? 'on' : ''}" data-v="${id}">${nm}</button>`).join('')}</div><div id="cv"></div>`;
    body.querySelectorAll('[data-v]').forEach(b => { b.onclick = () => { codexView = b.dataset.v; renderSheet(); }; });
    ({ merges: codexMerges, forms: codexForms, lexicon: codexLexicon })[codexView](body.querySelector('#cv'));
  }

  function codexMerges(body) {
    const total = M.count, n = discovered.size;
    const pairs = []; for (const a of E.MAINS) for (const b of E.MAINS) pairs.push(a + b);
    let list = [...discovered];
    if (codexFilter !== 'all') list = list.filter(k => k.slice(0, 2) === codexFilter);
    if (codexSearch) { const q = codexSearch.toLowerCase(); list = list.filter(k => ENG.rec(k).name.toLowerCase().includes(q) || ENG.rec(k).tags.some(t => t.toLowerCase().includes(q))); }
    list.sort((x, y) => ENG.rec(y).rarity - ENG.rec(x).rarity || (ENG.rec(x).name < ENG.rec(y).name ? -1 : 1));
    const byRar = [0, 0, 0, 0, 0]; for (const k of discovered) byRar[ENG.rec(k).rarity]++;
    body.innerHTML = `<div><b>${n}</b> / ${total} merges discovered (${(n / total * 100).toFixed(1)}%)</div>
      <div class="progress"><i style="width:${n / total * 100}%"></i></div>
      <span class="genome">${RARITY.map((nm, i) => `<span class="rar r${i}">${nm} ${byRar[i]}</span>`).join('')}</span>
      <div class="filters"><button data-f="all" class="${codexFilter === 'all' ? 'on' : ''}">All</button>${pairs.map(pk => `<button data-f="${pk}" class="${codexFilter === pk ? 'on' : ''}"><span style="color:${MAINC(pk[0])}">${E.MAIN[pk[0]].name[0]}</span>›<span style="color:${MAINC(pk[1])}">${E.MAIN[pk[1]].name[0]}</span> ${countPair(pk)}/${pairTotal(pk)}</button>`).join('')}</div>
      <input class="search" id="codexSearch" placeholder="Search names or resonances…" value="${esc(codexSearch)}">
      <div id="cdet"></div>
      <div class="clist">${list.slice(0, 300).map(k => { const r = ENG.rec(k); return `<button class="crow" data-k="${k}" data-tip="m:${k}" style="--lc:${MAINC(k[0])}"><span class="t">${esc(r.name)}</span>${kindBadge(k)}<span class="rar r${r.rarity}">${RARITY[r.rarity]}</span></button>`; }).join('') || '<p class="sub">Nothing here yet. Compose merges in battle, watch what your opponents cast, or experiment at the Forge.</p>'}</div>
      ${list.length > 300 ? `<p class="fine">Showing 300 of ${list.length}. Filter to narrow it down.</p>` : ''}`;
    body.querySelectorAll('[data-f]').forEach(b => { b.onclick = () => { codexFilter = b.dataset.f; renderSheet(); }; });
    const inp = body.querySelector('#codexSearch');
    inp.oninput = () => { codexSearch = inp.value; const pos = inp.selectionStart; renderSheet(); const i2 = $('codexSearch'); i2.focus(); i2.setSelectionRange(pos, pos); };
    body.querySelectorAll('[data-k]').forEach(b => { b.onclick = () => { const box = body.querySelector('#cdet'); box.innerHTML = mergeDetail(b.dataset.k); box.scrollIntoView({ behavior: 'smooth' }); }; });
  }

  function codexForms(body) {
    const list = [...seen].sort((x, y) => E.parseKey(x).subs.length - E.parseKey(y).subs.length || (x < y ? -1 : 1));
    body.innerHTML = `<div>Seen <b>${seen.size}</b> · Bound <b>${boundForms.size}</b> · Prismatic <b>${S.prisms.length}</b> of ${M.count} possible genomes</div>
      <div class="progress"><i style="width:${seen.size / M.count * 100}%"></i></div>
      <p class="fine">Every merge identity is also a daemon genome. Recompiling adds a sub-essence and turns a daemon into a new form. About one wild daemon in 64 is prismatic.</p>
      <div id="fdet"></div>
      <div class="grid-sprites">${list.map(k => `<button class="gs ${boundForms.has(k) ? 'bound' : ''}" data-k="${k}"><canvas data-sprite="${k}" ${S.prisms.includes(k) ? 'data-prism="1"' : ''} width="64" height="64"></canvas><span>${esc(ENG.rec(k).dName)}</span></button>`).join('')}</div>`;
    body.querySelectorAll('[data-k]').forEach(b => { b.onclick = () => {
      const k = b.dataset.k, r = ENG.rec(k), pv = ENG.PASSIVES[r.dPassive], box = body.querySelector('#fdet');
      box.innerHTML = `<div class="preview detail"><div><canvas class="big" data-sprite="${k}" width="160" height="160"></canvas></div><div><div class="pn">${esc(r.dName)}</div>${genomeHTML(k)}<p class="lore">${esc(lore(k))}</p>
        <div class="fine">Base stats: HP ${r.dStats[0]} · Logic ${r.dStats[1]} · Firewall ${r.dStats[2]} · Clock ${r.dStats[3]} · Flux ${r.dStats[4]} · Coherence ${r.dStats[5]} (total ${statTotal(k)})</div>
        <div class="fine">Passive <b>${pv[0]}</b>: ${esc(pv[1])}</div></div></div>`;
      hydrateCanvases(box); box.scrollIntoView({ behavior: 'smooth' });
    }; });
  }

  function codexLexicon(body) {
    const found = resonancesFound();
    const anomalies = new Set([...discovered].map(k => ENG.rec(k).anomaly).filter(Boolean));
    const chart = `<div class="scrollx"><table class="chart"><tr><th>atk ↓ def →</th>${E.MAINS.map(m => `<th style="color:${MAINC(m)}">${E.MAIN[m].name}</th>`).join('')}</tr>${E.MAINS.map(a => `<tr><th style="color:${MAINC(a)}">${E.MAIN[a].name}</th>${E.MAINS.map(b => { const v = E.chart(a, b); return `<td class="${v > 1 ? 'sup' : v < 1 ? 'res' : ''}">×${v}</td>`; }).join('')}</tr>`).join('')}</table></div>`;
    const reactions = Object.values(E.REACTION).map(rx => `<div class="lexc"><div class="hd"><b>${Object.entries(rx.names).map(([m, nm]) => `<span style="color:${MAINC(m)}">${nm}</span>`).join(' / ')}</b>${rx.volatile ? '<span class="st bad">volatile</span>' : ''}</div><p>${esc(rx.line)}</p></div>`).join('');
    const subCard = s => { const sub = E.SUB[s]; return `<div class="lexc"><div class="hd">${essChip(s)}<span class="fine">${sub.host ? E.MAIN[sub.host].name + ' only' : 'any host'}</span></div><p>${esc(sub.desc)}</p>${!sub.host ? `<div class="facets">${E.MAINS.map(m => `<span style="color:${MAINC(m)}">on ${E.MAIN[m].name}</span><span>${E.FACET[s][m].name}: ${E.EFFECTS[E.FACET[s][m].fx]}</span>`).join('')}</div>` : ''}<p class="fine">As lead sub: ${ENG.PASSIVES[s][0]}</p></div>`; };
    const KIND = { blast: 'Steam scalds the target for 10% of its HP.', boost: 'The merge hits 30% harder.', guard: 'Caster Firewall +1.', quench: 'Caster sheds burn and heals 10%.', blind: 'Target accuracy −1.', chill: 'Target Clock −1.', soak: 'Target is soaked.', burn: 'May burn the target.', shield: 'Caster gains a small shield.', veil: 'Caster evasion +1.' };
    body.innerHTML = `<h3>How combat works</h3><div class="lex">
        <div class="lexc kc atk"><div class="hd"><span class="kb atk">Attack</span></div><p>Strike, Barrage and Siphon merges. Queue one and it repeats every global cooldown (GCD). The GCD is shorter with more Clock and longer for heavy merges.</p></div>
        <div class="lexc kc act"><div class="hd"><span class="kb act">Active</span></div><p>Hex, Ward, Mend and Field merges. They fire instantly, off the GCD, then go on their own cooldown (5s + 0.7s per Flux).</p></div>
        <div class="lexc kc pas"><div class="hd"><span class="kb pas">Passive</span></div><p>Always on. One per daemon, from its genome's lead sub-essence or main essence.</p></div>
        <div class="lexc kc utl"><div class="hd"><span class="kb utl">Utility</span></div><p>Rest (14s cooldown, big Flux refill), Swap (uses the GCD), Items (6s shared cooldown), Bind and Run. Statuses tick every 2 seconds. Opening a menu pauses the fight.</p></div></div>
      <h3>How merges work</h3><p class="fine">A merge has a lead Main, a second Main (the same one makes a pure merge), and up to three sub-essences, each bound to one of the two. The lead carries more weight in the merge and in combat typing (65/35).</p>
      <h3>Type chart</h3>${chart}
      <h3>Main reactions</h3><div class="lex">${reactions}</div>
      <h3>Residue reactions</h3><p class="fine">Every merge leaves residue of its essences in the arena. A merge whose lead lands in 2+ residue of another essence triggers a reaction and consumes it.</p>
      <div class="lex">${Object.entries(ENG.REACT).map(([a, o]) => Object.entries(o).map(([b, [nm, kind]]) => `<div class="lexc"><div class="hd"><b>${nm}</b></div><span class="genome">${essChip(a, 'cast')}<span class="arrow">into</span>${essChip(b, 'residue')}</span><p>${KIND[kind]}</p></div>`).join('')).join('')}</div>
      <h3>Sub-essences</h3><div class="lex">${E.SUB_ORDER.map(subCard).join('')}</div>
      <h3>Resonances (${E.RESONANCE.filter(r => found.has(r.name)).length}/${E.RESONANCE.length})</h3><p class="fine">Two specific sub-essences in the same merge, on any host. The composer hints when you've put a pair together.</p>
      <div class="lex">${E.RESONANCE.map(r => (found.has(r.name) ? `<div class="lexc"><div class="hd"><b style="color:var(--warn)">${r.name}</b></div><span class="genome">${r.subs.map(s => essChip(s)).join('')}</span></div>` : '<div class="lexc dim"><div class="hd"><b>??? resonance</b></div></div>')).join('')}</div>
      <h3>Trinities (${E.TRINITY.filter(r => found.has(r.name)).length}/${E.TRINITY.length})</h3>
      <div class="lex">${E.TRINITY.map(r => (found.has(r.name) ? `<div class="lexc"><div class="hd"><b style="color:#ff5cf0">${r.name}</b></div><span class="genome">${r.subs.map(s => essChip(s)).join('')}</span></div>` : '<div class="lexc dim"><div class="hd"><b>??? trinity</b></div></div>')).join('')}</div>
      <h3>Anomalies (${anomalies.size}/${Object.keys(E.ANOMALY).length} kinds)</h3><p class="fine">About one merge in sixty is a glitch in the lattice. Nobody knows which until it's cast.</p>
      <div class="lex">${Object.entries(E.ANOMALY).map(([id, d]) => (anomalies.has(id) ? `<div class="lexc"><div class="hd"><span class="rar r4">∆${id}</span></div><p>${esc(d)}</p></div>` : '<div class="lexc dim"><div class="hd"><b>∆???</b></div></div>')).join('')}</div>`;
  }

  // ---- forge
  function forgeCost(k) {
    const p = E.parseKey(k), c = {};
    const add = (x, n) => { c[x] = (c[x] || 0) + n; };
    if (p.a === p.b) add(p.a, 3); else { add(p.a, 2); add(p.b, 1); }
    for (const t of p.subs) add(t.s, 1);
    return c;
  }
  function forgeItem(k) {
    const r = ENG.rec(k), fx = code => r.fx.find(f => f.code === code);
    switch (r.cls) {
      case 'Mend': return { id: 'patch:' + k, kind: 'patch', name: r.name + ' Patch', mag: (fx('heal') || { mag: 25 }).mag, cleanse: !!fx('cleanse') };
      case 'Ward': return { id: 'ward:' + k, kind: 'ward', name: r.name + ' Module', mag: (fx('shield') || { mag: 20 }).mag };
      case 'Hex': { const best = Math.max(0, ...r.fx.filter(f => !E.SELF_FX.has(f.code)).map(f => f.chance)); return { id: 'lattice:' + k, kind: 'lattice', name: r.name + ' Lattice', power: +(1 + 0.15 * r.rarity + best / 250).toFixed(2), main: r.a }; }
      case 'Field': return { id: 'catalyst:' + k, kind: 'catalyst', name: r.name + ' Catalyst', main: r.a };
      default: return r.subs.length ? { id: 'script:' + k, kind: 'script', name: r.name + ' Script', subs: [...new Set(r.subs.map(t => t.s))] } : { id: 'cell:' + k, kind: 'cell', name: r.name + ' Flux Cell' };
    }
  }
  const KIND_NAME = { patch: 'Patch', ward: 'Module', lattice: 'Lattice', catalyst: 'Catalyst', script: 'Script', cell: 'Flux Cell' };
  function sheetForge(body) {
    const have = S.motes;
    const subs = E.SUB_ORDER.filter(s => (have[s] || 0) > 0);
    const mains = E.MAINS.filter(m => (have[m] || 0) > 0);
    body.innerHTML = `<h3>Nexus Forge</h3><p class="fine">Merge motes into items. The merge's class decides the item: Mend → Patch, Ward → Module, Hex → Lattice, Field → Catalyst, other merges with subs → Attune Script, plain merges → Flux Cell. Forging also records the merge in your Codex.</p>
      <div class="motes">${Object.entries(have).filter(([, n]) => n > 0).map(([k, n]) => essChip(k, '×' + n)).join('') || '<span class="fine">You have no motes. Defeat daemons to collect them.</span>'}</div>
      <div id="fcmp"></div>`;
    if (!mains.length) return;
    const afford = k => Object.entries(forgeCost(k)).every(([x, n]) => (have[x] || 0) >= n);
    composer(body.querySelector('#fcmp'), {
      mains, subs, width: 3, counts: have, forge: true,
      extra: k => { const c = forgeCost(k), it = forgeItem(k);
        return `<div class="preview"><div class="fine">Cost: ${Object.entries(c).map(([x, n]) => essChip(x, `${n}/${have[x] || 0}`)).join(' ')}</div><div>Produces: <b>${discovered.has(k) ? esc(it.name) : `a ${KIND_NAME[it.kind]}?`}</b>${afford(k) ? '' : ' <span class="st bad">not enough motes</span>'}</div></div>`; },
      actions: [{ label: 'Forge', pri: true, ok: afford, fn: k => {
        for (const [x, n] of Object.entries(forgeCost(k))) have[x] -= n;
        markDiscovered(k);
        const it = forgeItem(k);
        if (S.bag[it.id]) S.bag[it.id].count++; else S.bag[it.id] = Object.assign({ count: 1 }, it);
        S.stats.forged++; questEvent('forge');
        beep(440, 0.1, 'triangle'); setTimeout(() => beep(660, 0.12, 'triangle'), 90);
        toast(`Forged <b>${esc(it.name)}</b>.`);
        save(); renderSheet();
      } }],
    });
  }

  function sheetSystem(body) {
    const mins = Math.round((Date.now() - S.started) / 60000);
    body.innerHTML = `<h3>Settings</h3><div class="btnrow">
        <button class="btn ${S.settings.speed === 'normal' ? 'pri' : ''}" data-speed="normal">Battle speed: normal</button>
        <button class="btn ${S.settings.speed === 'fast' ? 'pri' : ''}" data-speed="fast">Battle speed: fast</button>
        <button class="btn" data-mute>${muted ? 'Unmute' : 'Mute'} sound</button></div>
      <div class="btnrow gap"><button class="btn ${S.settings.tips === 'compact' ? 'pri' : ''}" data-tips="compact">Tooltips: compact</button><button class="btn ${S.settings.tips === 'complex' ? 'pri' : ''}" data-tips="complex">Tooltips: complex</button><button class="btn ${S.settings.tips === 'off' ? 'pri' : ''}" data-tips="off">Tooltips: off</button></div>
      <p class="fine">Hover (or press and hold on touch) any merge, essence, status, item or daemon card for details. Press T or tap ⓘ in the top bar to switch compact and complex.</p>
      <p class="fine">Tap the battle text or press Space to fast-forward a turn. Keys 1–4 cast your memory merges.</p>
      <h3>Save</h3><div class="btnrow"><button class="btn pri" data-save>Save now</button><button class="btn" data-wipe>Delete save…</button></div>
      <p class="fine">Playing for ${mins} min · ${S.steps} steps · ${S.stats.wild} wild daemons defeated · ${S.stats.binds} bound · ${S.stats.forged} items forged.</p>
      <h3>About</h3><p class="fine">Essence Protocol. All ${M.count} merge outcomes were generated ahead of time by tools/bake.js from the rules in js/essences.js. Nothing is rolled when you compose a merge; the only randomness is in battle (accuracy, effect chances, instability).</p>`;
    body.querySelectorAll('[data-speed]').forEach(b => { b.onclick = () => { S.settings.speed = b.dataset.speed; save(); renderSheet(); }; });
    body.querySelectorAll('[data-tips]').forEach(b => { b.onclick = () => { S.settings.tips = b.dataset.tips; save(); renderSheet(); }; });
    body.querySelector('[data-save]').onclick = () => { save(); toast('Saved.'); };
    body.querySelector('[data-mute]').onclick = () => { muted = !muted; try { localStorage.setItem('ep-muted', muted ? '1' : '0'); } catch (e) { /* ignore */ } renderSheet(); };
    body.querySelector('[data-wipe]').onclick = async () => {
      if ((await choose('Delete save?', 'Your progress is erased and the game returns to the title screen. This can\'t be undone.', ['Delete save', 'Cancel'])) === 0) { try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ } location.reload(); }
    };
  }

  // ------------------------------------------------------------------ ending
  function showEnding() {
    $('hud').classList.add('hidden'); setPad(false);
    const card = modal(`<h2>The lattice is yours</h2><p>The Architect is beaten and all four keys are turned. But the lattice still holds ${M.count - discovered.size} merges nobody has cast, and now it's open to you.</p>
      <div class="kv two"><span class="lab">Merges discovered</span><b>${discovered.size} / ${M.count}</b><span class="lab">Forms seen</span><b>${seen.size}</b><span class="lab">Forms bound</span><b>${boundForms.size}</b><span class="lab">Resonances</span><b>${resonancesFound().size}</b></div>
      <p>Unlocked: <b>the Rift</b>, the swirling terminal in the Core, an endless descent through every genome. <b>Warden rematches</b> are open too, with recompiled teams.</p>
      <div class="btnrow"><button class="btn pri" data-go>Keep exploring</button></div>`);
    card.querySelector('[data-go]').onclick = () => { closeModal(); $('hud').classList.remove('hidden'); mode = 'world'; setPad(true); updateHud(); };
  }

  // ------------------------------------------------------------------ title & starter
  function titleArt() {
    const c = $('titleArt'), g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    const keys = ['FA-Em1Pl1As1', 'WW-Ti1Fr1Mi1', 'EE-St1Me1Ro1', 'AA-Sp1Ga1Ec1'];
    let t = 0;
    const draw = () => {
      if (mode !== 'title') return;
      t += 0.05;
      g.clearRect(0, 0, c.width, c.height);
      keys.forEach((k, i) => {
        g.fillStyle = 'rgba(0,0,0,.35)'; g.beginPath(); g.ellipse(48 + i * 78, 108, 26, 5, 0, 0, 7); g.fill();
        g.drawImage(SP.get(k, i === 3 && Math.sin(t * 0.3) > 0.9), 8 + i * 78, 16 + Math.sin(t + i * 1.4) * 5, 80, 80);
      });
      requestAnimationFrame(draw);
    };
    draw();
  }
  function showStarter() {
    mode = 'starter';
    $('title').classList.add('hidden'); $('starter').classList.remove('hidden');
    $('starterList').innerHTML = C.STARTERS.map((s, i) => { const r = ENG.rec(s.key); return `<button class="starter" data-i="${i}"><canvas data-sprite="${s.key}" width="96" height="96"></canvas><span class="grow"><b class="h">${esc(r.dName)}</b>${genomeHTML(s.key)}<small>${esc(s.blurb)}</small><small>Starts attuned to ${E.SUB[s.attune[0]].name}. Passive: ${ENG.PASSIVES[r.dPassive][0]}.</small></span></button>`; }).join('');
    hydrateCanvases($('starterList'));
    $('starterList').querySelectorAll('[data-i]').forEach(b => { b.onclick = async () => {
      const st = C.STARTERS[+b.dataset.i];
      adopt(newState(st));
      for (const k of S.party[0].memory) if (k) discovered.add(k);
      $('starter').classList.add('hidden');
      enterWorld();
      mode = 'busy'; setPad(false);
      await say('Archivist Lo', [`${ENG.rec(st.key).dName}, a fine first daemon. It already knows its four basic merges.`, 'Walk into static, the flickering tiles, to meet wild daemons. Weaken one, then tap Bind to capture it.', 'Head west to the Cirrus Array when you\'re ready. Its Warden holds the first key. Your Requests tab always has something to chase.']);
      mode = 'world'; setPad(true); save();
    }; });
  }
  function enterWorld() {
    $('title').classList.add('hidden'); $('starter').classList.add('hidden');
    $('hud').classList.remove('hidden');
    for (const n of npcs) { const o = map.npcs.find(x => x.id === n.id); n.x = o.x; n.y = o.y; n.dir = o.dir; }
    mode = 'world'; setPad(true); updateHud();
  }

  // ------------------------------------------------------------------ tooltips
  // Any element with data-tip="kind:id" gets a hover (or long-press) card.
  // kinds: m merge key · e essence code · s status · i bag item · d battle side · r resonance/trinity name
  const tipEl = document.createElement('div'); tipEl.id = 'tooltip'; tipEl.className = 'hidden'; document.body.appendChild(tipEl);
  function cycleTips() {
    S.settings.tips = S.settings.tips === 'compact' ? 'complex' : 'compact';
    toast(`Tooltips: <b>${S.settings.tips}</b>`); hideTip(); save();
  }
  $('tipBtn').onclick = () => { if (S) cycleTips(); };
  const row = (k, v) => `<div class="tr"><span>${k}</span><b>${v}</b></div>`;
  function tipMerge(k, full) {
    const r = ENG.rec(k), known = discovered.has(k), p = E.parseKey(k), rx = E.REACTION[E.pairId(p.a, p.b)];
    let h = `<div class="th">${known ? esc(r.name) : 'Undiscovered merge'}</div>${genomeHTML(k)}`;
    if (!known) return h + `<div class="tfx">${composeHints(p.a, p.b, p.subs.map(t => t.s + t.h))}</div>` + row('Flux', r.flux) + (full ? `<p>${esc(rx.line)}</p><p class="fine">Cast or forge it to reveal its stats.</p>` : '');
    h += `<div class="tfx">${kindBadge(k)}<span class="rar r${r.rarity}">${RARITY[r.rarity]}</span><span class="cls">${r.cls}</span>${r.tags.map(t => `<span class="rar r2">${esc(t)}</span>`).join('')}</div>`;
    if (r.damaging) h += row('Power', r.power + (r.hits > 1 ? ` × ${r.hits} hits` : ''));
    h += row('Accuracy', r.acc > 100 ? 'never misses' : r.acc + '%') + row('Flux cost', r.flux);
    if (B && ui && r.damaging) { const eff = ENG.effectiveness(k, ui[1].key); h += row('Vs. current foe', `×${eff}`); }
    h += `<div class="tfx">${r.fx.map(f => `<span class="st ${E.SELF_FX.has(f.code) ? 'good' : f.code === 'recoil' ? 'bad' : 'inf'}">${esc(ENG.describeFx(f))}</span>`).join('')}</div>`;
    if (!full) return h;
    h += row('Priority', r.prio > 0 ? '+' + r.prio + ' (acts first)' : r.prio < 0 ? r.prio + ' (acts last)' : '0') + row('Instability', r.instab + '% (may backfire or mutate)');
    h += row('Typing', p.a === p.b ? `${E.MAIN[p.a].name} 100%` : `${E.MAIN[p.a].name} 65% · ${E.MAIN[p.b].name} 35%`);
    h += row('Residue left', r.cls === 'Field' ? `+3 ${E.MAIN[p.a].name}, field for 5 turns` : `+1 ${E.MAIN[p.a].name}`);
    h += row('Forges into', esc(forgeItem(k).name));
    h += `<p>${esc(rx.line + ' ' + r.text)}</p>`;
    if (r.anomaly) h += `<p class="bad">∆ ${esc(E.ANOMALY[r.anomaly])}</p>`;
    h += `<p class="fine">${esc(E.CLASSES[r.cls])} As a daemon genome: ${seen.has(k) ? esc(r.dName) : 'unseen form'}.</p>`;
    return h;
  }
  function tipEssence(c, full) {
    if (E.MAIN[c]) {
      const m = E.MAIN[c], pv = ENG.PASSIVES[c];
      const weak = E.MAINS.find(x => E.BEATS[x] === c);
      let h = `<div class="th" style="color:${m.color}">${m.name}</div>` + row('Strong against', E.MAIN[E.BEATS[c]].name) + row('Weak to', E.MAIN[weak].name) + row('Merging with', `${E.MAIN[E.OPPOSITE[c]].name} is volatile`);
      if (!full) return h;
      h += row('Passive (no subs)', `${pv[0]}: ${esc(pv[1])}`);
      h += `<div class="tr"><span>Reactions</span><b>${E.MAINS.map(o => { const rx = E.REACTION[E.pairId(c, o)]; return `${rx.names[c] || rx.names[o]}`; }).join(', ')}</b></div>`;
      h += `<div class="tr"><span>Attack ×</span><b>${E.MAINS.map(o => `${E.MAIN[o].name[0]} ${E.chart(c, o)}`).join(' · ')}</b></div>`;
      h += `<div class="tr"><span>Status immunity</span><b>${{ F: 'Burn', W: 'Freeze', E: 'Static', A: 'Root' }[c]} (as lead)</b></div>`;
      return h;
    }
    const sub = E.SUB[c], pv = ENG.PASSIVES[c];
    let h = `<div class="th" style="color:${subColor(c)}">${sub.name}</div><p>${esc(sub.desc)}</p>` + row('Binds to', sub.host ? `${E.MAIN[sub.host].name} only` : 'any main') + row('Effect', E.EFFECTS[sub.fx]);
    if (!full) return h;
    h += row('Passive as lead sub', `${pv[0]}: ${esc(pv[1])}`);
    if (!sub.host) h += `<div class="tr"><span>Facets</span><b>${E.MAINS.map(m => `${E.MAIN[m].name}: ${E.FACET[c][m].name} (${E.EFFECTS[E.FACET[c][m].fx]})`).join('<br>')}</b></div>`;
    h += row('Traits', Object.entries(sub.traits).map(([t, v]) => `${t} +${v}`).join(', '));
    const found = resonancesFound();
    const res = E.RESONANCE.concat(E.TRINITY).filter(r => r.subs.includes(c));
    h += row('Resonances', res.map(r => (found.has(r.name) ? r.name : '???')).join(', '));
    return h;
  }
  const STATUS_TXT = { burn: 'Loses 1/16 HP each turn and deals 15% less damage. Fire leads are immune.', frozen: 'Can\'t act for 1–2 turns. Thawed by Fire-led hits. Water leads are immune.', static: '25% chance to lock up each turn and Clock ×0.75. Earth leads are immune.', rooted: 'Can\'t switch or run; loses 1/16 HP to the foe each turn. Air leads are immune.', corrupt: 'Loses 3 Flux per turn and merges are 15% more unstable.', dormant: 'Can\'t act until hit, up to 3 turns.' };
  function tipSide(i, full) {
    if (!B) return '';
    const d = B.act(i), r = ENG.rec(d.key), pv = ENG.PASSIVES[r.dPassive], v = B.sides[i].v;
    let h = `<div class="th">${esc(dName(d))} · Lv ${d.level}</div>${genomeHTML(d.key)}` + row('Passive', `${pv[0]}: ${esc(pv[1])}`) + row('HP', `${d.hp}/${v.stats.hp}`);
    if (i === 0 || full) h += row('Flux', `${v.flux}/${v.stats.flux}`);
    if (!full) return h;
    if (i === 0) h += row('Stats', `Logic ${v.stats.atk} · Firewall ${v.stats.def} · Clock ${v.stats.spd} · Coherence ${v.stats.coh}`);
    else h += row('Your pure merges', E.MAINS.map(m => `${E.MAIN[m].name[0]} ×${ENG.effectiveness(m + m, d.key)}`).join(' · '));
    h += row('Status', v.status ? `${ENG.STATUS[v.status.id].name}, ${v.status.turns} turns` : 'none') + row('Shield', v.shield || 0) + row('Turns on field', v.turnsIn);
    if (i === 1 && B.wild) { const lat = bestLattice(); if (lat) h += row('Bind chance', Math.round(chanceWith(lat) * 100) + '%'); }
    return h;
  }
  function tipHTML(spec, full) {
    const kind = spec[0], id = spec.slice(2);
    if (kind === 'm' && M.table[id]) return tipMerge(id, full);
    if (kind === 'e' && (E.MAIN[id] || E.SUB[id])) return tipEssence(id, full);
    if (kind === 's' && ENG.STATUS[id]) return `<div class="th">${ENG.STATUS[id].name}</div><p>${STATUS_TXT[id]}</p>` + (full ? row('Base duration', ENG.STATUS[id].turns + ' turns') : '');
    if (kind === 'i' && S.bag[id]) { const it = S.bag[id]; return `<div class="th">${esc(it.name)}</div><p>${itemDesc(it)}</p>` + row('Owned', it.count) + (full && M.table[id.split(':')[1]] ? tipMerge(id.split(':')[1], false) : ''); }
    if (kind === 'd') return tipSide(+id, full);
    if (kind === 'p' && ENG.PASSIVES[id]) return `<div class="th"><span class="kb pas">Passive</span> ${ENG.PASSIVES[id][0]}</div><p>${esc(ENG.PASSIVES[id][1])}</p>` + (full ? '<p class="fine">Always on. It comes from the genome\'s lead sub-essence (or its main essence if it has none), so recompiling can change it.</p>' : '');
    if (kind === 'r') { const r = E.RESONANCE.concat(E.TRINITY).find(x => x.name === id); if (r) return `<div class="th">${esc(r.name)}</div><span class="genome">${r.subs.map(x => essChip(x)).join('')}</span>` + (full ? row('Adds', Object.entries(r.traits).map(([t, v]) => `${t} +${v}`).join(', ') + (r.fx.length ? ' · ' + r.fx.map(f => `${E.EFFECTS[f[0]]} ${f[1]}%`).join(', ') : '')) : ''); }
    return '';
  }
  let tipTarget = null, pressTimer = null;
  function showTip(el, x, y) {
    if (!S || S.settings.tips === 'off') return;
    const html = tipHTML(el.dataset.tip, S.settings.tips === 'complex');
    if (!html) return;
    tipTarget = el;
    tipEl.innerHTML = html + `<div class="tmode">${S.settings.tips === 'complex' ? 'Complex' : 'Compact'} · T or ⓘ to switch</div>`;
    tipEl.className = S.settings.tips;
    const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    tipEl.style.left = clamp(x + 14, 8, innerWidth - w - 8) + 'px';
    tipEl.style.top = (y + 16 + h > innerHeight - 8 ? Math.max(8, y - h - 12) : y + 16) + 'px';
  }
  function hideTip() { tipTarget = null; tipEl.className = 'hidden'; }
  document.addEventListener('mouseover', e => {
    const el = e.target.closest && e.target.closest('[data-tip]');
    if (!el) { if (tipTarget) hideTip(); return; }
    if (el !== tipTarget) showTip(el, e.clientX, e.clientY);
  });
  document.addEventListener('mousemove', e => { if (tipTarget) { const w = tipEl.offsetWidth, h = tipEl.offsetHeight; tipEl.style.left = clamp(e.clientX + 14, 8, innerWidth - w - 8) + 'px'; tipEl.style.top = (e.clientY + 16 + h > innerHeight - 8 ? Math.max(8, e.clientY - h - 12) : e.clientY + 16) + 'px'; } });
  document.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse') return;
    hideTip();
    const el = e.target.closest && e.target.closest('[data-tip]');
    if (!el) return;
    pressTimer = setTimeout(() => { showTip(el, e.clientX, e.clientY - 60); el.dataset.held = '1'; }, 450);
  });
  document.addEventListener('pointerup', () => clearTimeout(pressTimer));
  document.addEventListener('pointercancel', () => clearTimeout(pressTimer));
  // a long-press that opened a tooltip shouldn't also fire the button
  document.addEventListener('click', e => { const el = e.target.closest && e.target.closest('[data-held]'); if (el) { delete el.dataset.held; e.stopPropagation(); e.preventDefault(); } }, true);
  document.addEventListener('scroll', hideTip, true);

  // ------------------------------------------------------------------ boot
  resize();
  try { muted = localStorage.getItem('ep-muted') === '1'; } catch (e) { /* ignore */ }
  $('bakeInfo').textContent = `${M.count.toLocaleString()} merges pre-baked · 4 main essences · 16 sub-essences · ${E.RESONANCE.length} resonances · ${E.TRINITY.length} trinities`;
  titleArt();
  const existing = loadSave();
  if (existing) $('contBtn').classList.remove('hidden');
  $('newBtn').onclick = async () => { if (existing && (await choose('Start a new game?', 'Your current save is overwritten the next time the game saves.', ['Start over', 'Cancel'])) !== 0) return; showStarter(); };
  $('contBtn').onclick = () => { adopt(existing); enterWorld(); if (S.won) toast('Welcome back. The Rift is waiting in the Core.'); };
  requestAnimationFrame(frame);

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});

  window.EP = { get state() { return S; }, get battle() { return B; }, get mode() { return mode; }, get discovered() { return discovered; }, forgeItem,
    teleport(x, y, dir) { player.x = player.px = follower.x = follower.px = x; player.y = player.py = follower.y = follower.py = y; if (dir) player.dir = dir; updateHud(); } };
})();
