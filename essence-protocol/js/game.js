/* Essence Protocol: game shell (overworld, battle UI, composer, menus, forge).
   Rules live in engine.js and outcomes live in merges.baked.js; this file
   only presents them. */
(function () {
  'use strict';
  const E = window.ESSENCE, ENG = window.ENGINE, C = window.CONTENT, SP = window.SPRITES, M = window.MERGES;
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const SAVE_KEY = 'essence-protocol-save-v1';
  const RARITY = ['Base', 'Compound', 'Resonant', 'Trinity', 'Anomaly'];
  const TIER = ['Seed', 'Build', 'Release', 'Prime'];

  // ------------------------------------------------------------------ state
  let S = null;            // save state
  let discovered = new Set();
  let seen = new Set();
  let boundForms = new Set();
  const map = C.buildMap();
  const npcs = map.npcs.map(n => Object.assign({}, n));

  function newState(starter) {
    const d = ENG.createDaemon(starter.key, 5, { attune: starter.attune, extraAttune: 0 });
    const p = E.parseKey(starter.key);
    d.memory = [p.a + p.b, p.b + p.a, p.a + p.a, p.b + p.b];
    return {
      v: 1, party: [d], box: [], bag: { 'lattice:basic': { id: 'lattice:basic', kind: 'lattice', name: 'Basic Lattice', power: 1, count: 5 } },
      motes: {}, discovered: [], seen: [starter.key], bound: [starter.key], badges: 0, keys: [], beaten: [],
      pos: { x: map.spawn.x, y: map.spawn.y, dir: 'down' }, lastHeal: { x: map.heal.x, y: map.heal.y }, steps: 0, won: false, started: Date.now(),
    };
  }

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
    S = s;
    discovered = new Set(s.discovered); seen = new Set(s.seen); boundForms = new Set(s.bound);
    // drop anything that no longer exists in the table (future re-bakes)
    for (const list of [S.party, S.box]) for (const d of list) d.memory = d.memory.map(k => (k && M.table[k] ? k : null));
    player.x = s.pos.x; player.y = s.pos.y; player.dir = s.pos.dir || 'down';
    player.px = player.x; player.py = player.y;
    follower.x = player.x; follower.y = player.y; follower.px = player.x; follower.py = player.y;
  }

  // ------------------------------------------------------------------ helpers
  const MAINC = m => E.MAIN[m].color;
  function subColor(s) { return SP.ACCENT[s]; }
  function essChip(code, extra) {
    if (E.MAIN[code]) return `<span class="ess" style="color:${MAINC(code)}"><i></i>${E.MAIN[code].name}${extra ? ` <small>${extra}</small>` : ''}</span>`;
    return `<span class="ess sub" style="color:${subColor(code)}"><i></i>${E.SUB[code].name}${extra ? ` <small>${extra}</small>` : ''}</span>`;
  }
  function genomeHTML(key) {
    const p = E.parseKey(key);
    let h = `<div class="genome">${essChip(p.a, p.a === p.b ? 'pure' : 'lead')}${p.a !== p.b ? `<span class="arrow">+</span>${essChip(p.b, 'follow')}` : ''}`;
    for (const t of p.subs) h += essChip(t.s, '→ ' + E.MAIN[E.hostMain(p, t.h)].name);
    return h + '</div>';
  }
  function dName(d) { return d.nick || ENG.rec(d.key).dName; }
  function canvasFor(key, size, opts) { const c = document.createElement('canvas'); c.width = c.height = size; SP.paint(c, key, opts); return c; }
  function spriteImg(key, size, opts) { return canvasFor(key, size, opts).toDataURL(); }
  function toast(html, cls) {
    const t = document.createElement('div'); t.className = 'toast ' + (cls || ''); t.innerHTML = html;
    $('toasts').appendChild(t); setTimeout(() => t.remove(), 3300);
  }
  function mergeLabel(key) { return discovered.has(key) ? ENG.rec(key).name : 'Unknown merge'; }
  function lore(key) {
    const p = E.parseKey(key), r = ENG.rec(key), n = p.subs.length;
    const A = E.MAIN[p.a].name, B = E.MAIN[p.b].name;
    const an = w => (/^[AEIOU]/.test(w) ? 'An ' : 'A ') + w;
    let s = `${TIER[n]}-tier daemon. ${p.a === p.b ? `A pure ${A} kernel.` : `${an(A)} kernel braided with ${B}.`}`;
    if (n) s += ` It has grown ${p.subs.map(t => `${E.SUB[t.s].name} on its ${E.MAIN[E.hostMain(p, t.h)].name} ${p.a === p.b ? 'core' : t.h === 1 ? 'lead' : 'follow'}`).join(', ')}.`;
    const role = { Strike: 'breaking through', Barrage: 'overwhelming numbers', Siphon: 'outlasting its prey', Hex: 'crippling its foes', Ward: 'holding the line', Mend: 'self-repair', Field: 'reshaping the arena' }[r.cls];
    return s + ` Its signature merge, ${discovered.has(key) ? r.name : 'still undiscovered'}, is built for ${role}.`;
  }
  function resonancesFound() {
    const out = new Set();
    for (const k of discovered) for (const t of ENG.rec(k).tags) out.add(t);
    return out;
  }
  function markDiscovered(key, silent) {
    if (discovered.has(key)) return;
    discovered.add(key);
    const r = ENG.rec(key);
    if (!silent) toast(`◈ New merge: <b>${esc(r.name)}</b> <span class="rar r${r.rarity}">${RARITY[r.rarity]}</span>`, r.rarity >= 3 ? 'myth' : r.rarity === 2 ? 'rare' : '');
    updateHud();
  }

  // ------------------------------------------------------------------ audio
  let actx = null, muted = false;
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
  let zoom = 3, vw = 0, vh = 0, dpr = 1;
  const player = { x: 0, y: 0, px: 0, py: 0, dir: 'down', moving: false, from: null, t: 0 };
  const follower = { x: 0, y: 0, px: 0, py: 0 };
  let mode = 'title'; // title | starter | world | battle | busy
  let held = null;
  let lastTime = 0, animT = 0;
  const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    vw = innerWidth; vh = innerHeight;
    cv.width = Math.floor(vw * dpr); cv.height = Math.floor(vh * dpr);
    zoom = Math.max(2, Math.round(Math.min(vw / (TS * 13), vh / (TS * 11))));
  }
  addEventListener('resize', resize); resize();

  const THEME = {
    nexus:  { f1: '#161d30', f2: '#1a2238', line: '#26324f', wall: '#0a0e19', wtop: '#28324f', grass: ['#1f5c52', '#2c8574', '#46f3ff'] },
    fringe: { f1: '#161d30', f2: '#1a2238', line: '#26324f', wall: '#0a0e19', wtop: '#28324f', grass: ['#1f5c52', '#2c8574', '#46f3ff'] },
    air:    { f1: '#16303a', f2: '#1a3742', line: '#23505c', wall: '#0a1a20', wtop: '#2f6070', grass: ['#2b7d70', '#4fbfa8', '#e2fff8'], obst: '#cdeff5' },
    fire:   { f1: '#2e1914', f2: '#351d17', line: '#4a2a1f', wall: '#170b08', wtop: '#5a2a1c', grass: ['#7a3318', '#b8542a', '#ffc27a'], obst: '#ff6b1a' },
    water:  { f1: '#10223d', f2: '#132846', line: '#1c3a63', wall: '#070f1d', wtop: '#1f416e', grass: ['#1d5a8f', '#2c7fc0', '#aadcff'], obst: '#1c5fb0' },
    earth:  { f1: '#2b2318', f2: '#30271b', line: '#453826', wall: '#140f09', wtop: '#4d3d27', grass: ['#5c4a1f', '#8a6a2e', '#efd49c'], obst: '#6b5a45' },
    core:   { f1: '#170e2a', f2: '#1b1132', line: '#2e1d52', wall: '#0a0614', wtop: '#3a2466', grass: ['#3a2466', '#6a3fbf', '#e0c8ff'], obst: '#6a3fbf' },
  };
  function tileAt(x, y) { return (map.tiles[y] || '')[x] || '#'; }
  function zoneAt(x, y) { return (map.zone[y] || [])[x] || 'nexus'; }
  function npcAt(x, y) { return npcs.find(n => n.x === x && n.y === y); }
  function gateOpen(ch) { return C.GATES[ch] != null && S && S.badges >= C.GATES[ch]; }
  function passable(x, y) {
    const ch = tileAt(x, y);
    if (C.SOLID.has(ch) && !gateOpen(ch)) return false;
    return !npcAt(x, y);
  }
  function hash2(x, y) { let h = x * 374761393 + y * 668265263; h = (h ^ (h >> 13)) * 1274126177; return (h ^ (h >> 16)) >>> 0; }

  function drawTile(x, y, sx, sy, s) {
    const ch = tileAt(x, y), th = THEME[zoneAt(x, y)] || THEME.nexus, hsh = hash2(x, y);
    const floor = () => {
      ctx.fillStyle = (x + y) % 2 ? th.f1 : th.f2; ctx.fillRect(sx, sy, s, s);
      if (hsh % 5 === 0) { ctx.fillStyle = th.line; ctx.fillRect(sx + (hsh % 12) * s / 16, sy + s / 2, s / 3, s / 16); ctx.fillRect(sx + (hsh % 12) * s / 16, sy + s / 2, s / 16, s / 4); }
    };
    if (ch === '#') {
      ctx.fillStyle = th.wall; ctx.fillRect(sx, sy, s, s);
      if (!C.SOLID.has(tileAt(x, y + 1)) || tileAt(x, y + 1) === 'H') { ctx.fillStyle = th.wtop; ctx.fillRect(sx, sy + s * 0.55, s, s * 0.45); ctx.fillStyle = '#0006'; ctx.fillRect(sx, sy + s - s / 16, s, s / 16); }
      return;
    }
    floor();
    const u = s / 16;
    switch (ch) {
      case ',': {
        const [c1, c2, c3] = th.grass;
        ctx.fillStyle = c1; ctx.fillRect(sx + u, sy + u, s - 2 * u, s - 2 * u);
        for (let i = 0; i < 6; i++) {
          const k = hash2(x * 7 + i, y * 13 + Math.floor(animT * 6 + i) % 9);
          ctx.fillStyle = k % 7 === 0 ? c3 : c2;
          ctx.fillRect(sx + (k % 13 + 1) * u, sy + ((k >> 4) % 12 + 2) * u, u * 2, u * (k % 3 + 2));
        }
        break;
      }
      case '~': {
        ctx.fillStyle = th.obst; ctx.fillRect(sx, sy, s, s);
        ctx.fillStyle = '#aadcff66';
        const o = Math.floor((animT * 8 + x * 3) % 16);
        ctx.fillRect(sx + o * u, sy + 5 * u, 4 * u, u); ctx.fillRect(sx + ((o + 8) % 16) * u, sy + 11 * u, 4 * u, u);
        break;
      }
      case '^': {
        const g = 0.5 + 0.5 * Math.sin(animT * 3 + x + y);
        ctx.fillStyle = '#5a1a08'; ctx.fillRect(sx, sy, s, s);
        ctx.fillStyle = `rgba(255,${100 + 80 * g | 0},30,1)`; ctx.fillRect(sx + 2 * u, sy + 2 * u, 12 * u, 12 * u);
        ctx.fillStyle = '#ffe08a'; ctx.fillRect(sx + (hsh % 9 + 3) * u, sy + (hsh % 7 + 4) * u, 2 * u, 2 * u);
        break;
      }
      case 'o': {
        ctx.fillStyle = '#0005'; ctx.fillRect(sx + 2 * u, sy + 12 * u, 13 * u, 3 * u);
        ctx.fillStyle = th.obst; ctx.fillRect(sx + 2 * u, sy + 3 * u, 12 * u, 10 * u);
        ctx.fillStyle = '#8f7c62'; ctx.fillRect(sx + 3 * u, sy + 3 * u, 9 * u, 4 * u);
        break;
      }
      case '*': {
        const b = Math.sin(animT * 2 + x) * u;
        ctx.fillStyle = '#9fd6e0'; ctx.fillRect(sx + 3 * u, sy + 7 * u, 10 * u, 7 * u);
        ctx.fillStyle = th.obst; ctx.beginPath(); ctx.arc(sx + 8 * u, sy + 6 * u + b, 5 * u, 0, 7); ctx.fill();
        break;
      }
      case 'x': {
        const g = 0.5 + 0.5 * Math.sin(animT * 2.5 + x);
        ctx.fillStyle = '#2a1850'; ctx.fillRect(sx + 3 * u, sy, 10 * u, s);
        ctx.fillStyle = `rgba(160,110,255,${0.4 + 0.5 * g})`; ctx.fillRect(sx + 6 * u, sy + 2 * u, 4 * u, 12 * u);
        break;
      }
      case 'H': {
        ctx.fillStyle = '#0c1a16'; ctx.fillRect(sx + u, sy, 14 * u, 15 * u);
        ctx.fillStyle = '#5dff9a'; ctx.fillRect(sx + 7 * u, sy + 3 * u, 2 * u, 8 * u); ctx.fillRect(sx + 4 * u, sy + 6 * u, 8 * u, 2 * u);
        ctx.fillStyle = `rgba(93,255,154,${0.2 + 0.2 * Math.sin(animT * 3)})`; ctx.fillRect(sx + u, sy, 14 * u, 15 * u);
        break;
      }
      case 'F': {
        ctx.fillStyle = '#1d1410'; ctx.fillRect(sx + u, sy + u, 14 * u, 14 * u);
        const g = 0.5 + 0.5 * Math.sin(animT * 4);
        ['#ff6b3d', '#3aa6ff', '#c9913d', '#8fe6d4'].forEach((c, i) => { ctx.fillStyle = c; ctx.fillRect(sx + (3 + i * 3) * u, sy + (4 + (i % 2) * 2) * u, 2 * u, 2 * u); });
        ctx.fillStyle = `rgba(255,190,90,${0.3 + 0.4 * g})`; ctx.fillRect(sx + 3 * u, sy + 10 * u, 10 * u, 3 * u);
        break;
      }
      case '2': case '3': case '4': case '5': {
        if (gateOpen(ch)) { ctx.fillStyle = '#46f3ff22'; ctx.fillRect(sx, sy + 7 * u, s, 2 * u); break; }
        const g = 0.5 + 0.5 * Math.sin(animT * 5 + y);
        ctx.fillStyle = `rgba(255,84,112,${0.35 + 0.35 * g})`; ctx.fillRect(sx, sy, s, s);
        ctx.fillStyle = '#ffd0d8'; for (let i = 0; i < 4; i++) ctx.fillRect(sx + (i * 4 + 1) * u, sy, u, s);
        break;
      }
      default: break;
    }
  }

  function drawPerson(sx, sy, s, dir, body, accent, kind, bob) {
    const u = s / 16;
    ctx.fillStyle = '#0006'; ctx.fillRect(sx + 3 * u, sy + 14 * u, 10 * u, 2 * u);
    const y0 = sy - 2 * u + bob;
    if (kind === 'warden') { ctx.fillStyle = accent; ctx.fillRect(sx + 2 * u, y0 + 7 * u, 12 * u, 8 * u); }
    ctx.fillStyle = body; ctx.fillRect(sx + 4 * u, y0 + 7 * u, 8 * u, 7 * u);
    ctx.fillStyle = '#1c2130'; ctx.fillRect(sx + 5 * u, y0 + 14 * u, 2 * u, 2 * u); ctx.fillRect(sx + 9 * u, y0 + 14 * u, 2 * u, 2 * u);
    ctx.fillStyle = '#f0c9a0'; ctx.fillRect(sx + 4 * u, y0 + 1 * u, 8 * u, 7 * u);
    ctx.fillStyle = accent; ctx.fillRect(sx + 4 * u, y0, 8 * u, 3 * u);
    if (dir !== 'up') {
      ctx.fillStyle = '#101421';
      const ex = dir === 'left' ? -1 : dir === 'right' ? 1 : 0;
      ctx.fillRect(sx + (5 + ex) * u, y0 + 4 * u, 6 * u, 2 * u);
      ctx.fillStyle = '#46f3ff'; ctx.fillRect(sx + (6 + ex) * u, y0 + 4 * u, u, u); ctx.fillRect(sx + (9 + ex) * u, y0 + 4 * u, u, u);
    } else { ctx.fillStyle = accent; ctx.fillRect(sx + 4 * u, y0 + 3 * u, 8 * u, 4 * u); }
    if (kind === 'warden') { ctx.fillStyle = '#ffd23d'; ctx.fillRect(sx + 5 * u, y0 - 2 * u, 6 * u, 2 * u); ctx.fillRect(sx + 7 * u, y0 - 3 * u, 2 * u, u); }
  }

  const NPC_COLORS = { air: ['#2f7c73', '#8fe6d4'], fire: ['#8f2a12', '#ff6b3d'], water: ['#123f7a', '#3aa6ff'], earth: ['#553814', '#c9913d'], core: ['#3a2466', '#e0c8ff'] };
  let spotted = null; // npc showing "!"

  function renderWorld() {
    const W = cv.width, H = cv.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#05070d'; ctx.fillRect(0, 0, W, H);
    const s = TS * zoom * dpr;
    const camX = (player.px + 0.5) * s - W / 2, camY = (player.py + 0.5) * s - H / 2;
    const x0 = Math.floor(camX / s) - 1, y0 = Math.floor(camY / s) - 1;
    const x1 = x0 + Math.ceil(W / s) + 2, y1 = y0 + Math.ceil(H / s) + 2;
    ctx.imageSmoothingEnabled = false;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const sx = Math.round(x * s - camX), sy = Math.round(y * s - camY);
      if (x < 0 || y < 0 || x >= map.w || y >= map.h) { ctx.fillStyle = '#05070d'; ctx.fillRect(sx, sy, s, s); continue; }
      drawTile(x, y, sx, sy, s);
    }
    // actors sorted by y
    const actors = [];
    for (const n of npcs) if (n.x >= x0 && n.x <= x1 && n.y >= y0 && n.y <= y1) actors.push({ y: n.y, draw: () => {
      const sx = Math.round(n.x * s - camX), sy = Math.round(n.y * s - camY);
      const [body, acc] = n.kind === 'folk' ? ['#3a4466', '#46f3ff'] : NPC_COLORS[n.zone] || ['#444', '#aaa'];
      drawPerson(sx, sy, s, n.dir, body, acc, n.kind, 0);
      if (spotted === n || (n.kind !== 'folk' && !S.beaten.includes(n.id) && n.warden)) {
        ctx.fillStyle = spotted === n ? '#ffd23d' : '#46f3ff'; ctx.font = `bold ${Math.round(s * 0.6)}px system-ui`; ctx.textAlign = 'center';
        ctx.fillText(spotted === n ? '!' : '◆', sx + s / 2, sy - s * 0.25 + Math.sin(animT * 4) * s * 0.05);
      }
    } });
    const lead = S.party.find(d => d.hp > 0) || S.party[0];
    actors.push({ y: follower.py, draw: () => {
      const sx = Math.round(follower.px * s - camX), sy = Math.round(follower.py * s - camY);
      const img = SP.get(lead.key);
      ctx.drawImage(img, sx - s * 0.1, sy - s * 0.25 + Math.sin(animT * 5) * s * 0.04, s * 1.2, s * 1.2);
    } });
    actors.push({ y: player.py + 0.01, draw: () => {
      const sx = Math.round(player.px * s - camX), sy = Math.round(player.py * s - camY);
      const bob = player.moving ? Math.round(Math.sin(player.t * Math.PI) * -s / 16) : 0;
      drawPerson(sx, sy, s, player.dir, '#1f7a8c', '#46f3ff', 'player', bob);
    } });
    actors.sort((a, b) => a.y - b.y).forEach(a => a.draw());
  }

  function frame(t) {
    const dt = Math.min(0.05, (t - lastTime) / 1000 || 0); lastTime = t; animT += dt;
    if (S && (mode === 'world' || mode === 'busy')) {
      if (player.moving) {
        player.t += dt / 0.14;
        const [fx, fy] = player.from;
        if (player.t >= 1) { player.moving = false; player.px = player.x; player.py = player.y; follower.px = follower.x; follower.py = follower.y; onStep(); }
        else { player.px = fx + (player.x - fx) * player.t; player.py = fy + (player.y - fy) * player.t; follower.px += (follower.x - follower.px) * Math.min(1, dt * 12); follower.py += (follower.y - follower.py) * Math.min(1, dt * 12); }
      }
      if (!player.moving && mode === 'world' && held) tryMove(held);
      renderWorld();
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
    S.steps++;
    const z = zoneAt(player.x, player.y);
    updateHud();
    if (checkSight()) return;
    if (tileAt(player.x, player.y) === ',' && C.ZONES[z] && Math.random() < 0.11) startWild(z);
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
    await sleep(700);
    spotted = null;
    const [dx, dy] = DIRS[n.dir];
    for (let i = 1; i < dist; i++) { n.x += dx; n.y += dy; await sleep(140); }
    player.dir = { up: 'down', down: 'up', left: 'right', right: 'left' }[n.dir];
    await say(n.name, [n.intro]);
    startTrainer(n);
  }

  function interact() {
    if (mode !== 'world' || player.moving) return;
    const [dx, dy] = DIRS[player.dir];
    const x = player.x + dx, y = player.y + dy;
    const n = npcAt(x, y), ch = tileAt(x, y);
    if (n) {
      n.dir = { up: 'down', down: 'up', left: 'right', right: 'left' }[player.dir];
      if (n.kind === 'folk') { mode = 'busy'; say(n.name, n.lines).then(() => { mode = 'world'; setPad(true); }); return; }
      if (S.beaten.includes(n.id)) { mode = 'busy'; say(n.name, [n.outro]).then(() => { mode = 'world'; setPad(true); }); return; }
      mode = 'busy'; setPad(false);
      say(n.name, [n.intro]).then(() => startTrainer(n));
      return;
    }
    if (ch === 'H') return healTerminal(x, y);
    if (ch === 'F') { openSheet('forge'); return; }
    if (C.GATES[ch] != null && !gateOpen(ch)) { mode = 'busy'; say('Gate', [`A firewall gate. It needs ${C.GATES[ch]} Warden key${C.GATES[ch] > 1 ? 's' : ''} to open. You have ${S.badges}.`]).then(() => { mode = 'world'; }); }
  }

  function healTerminal() {
    for (const d of S.party) d.hp = ENG.calcStats(d).hp;
    const lat = S.bag['lattice:basic'];
    const topped = !lat || lat.count < 3;
    if (!lat) S.bag['lattice:basic'] = { id: 'lattice:basic', kind: 'lattice', name: 'Basic Lattice', power: 1, count: 3 };
    else lat.count = Math.max(3, lat.count);
    S.lastHeal = { x: player.x, y: player.y };
    beep(523, 0.1, 'sine'); setTimeout(() => beep(784, 0.15, 'sine'), 100);
    mode = 'busy';
    say('Terminal', ['Your daemons are fully restored.' + (topped ? ' The dispenser tops your Basic Lattices up to 3.' : '')]).then(() => { mode = 'world'; save(); });
  }

  // ------------------------------------------------------------------ input
  const KEYMAP = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', w: 'up', s: 'down', a: 'left', d: 'right', W: 'up', S: 'down', A: 'left', D: 'right' };
  addEventListener('keydown', e => {
    if (e.target && e.target.tagName === 'INPUT') return;
    if (!$('dialog').classList.contains('hidden') && ['Enter', ' ', 'z', 'Z'].includes(e.key)) { advanceDialog(); e.preventDefault(); return; }
    if (mode === 'world') {
      if (KEYMAP[e.key]) { held = KEYMAP[e.key]; e.preventDefault(); }
      else if (['Enter', ' ', 'z', 'Z', 'e', 'E'].includes(e.key)) { interact(); e.preventDefault(); }
      else if (['Escape', 'm', 'M', 'x', 'X'].includes(e.key)) openSheet('party');
    } else if (e.key === 'Escape' && !$('sheet').classList.contains('hidden') && sheetClosable) closeSheet();
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

  // ------------------------------------------------------------------ dialog
  let dq = null;
  function say(who, lines) {
    return new Promise(res => {
      dq = { lines: lines.slice(), res };
      $('dialog').classList.remove('hidden');
      $('dialog').querySelector('.who').textContent = who;
      showLine();
    });
  }
  function showLine() { $('dialog').querySelector('.text').textContent = dq.lines[0]; beep(660, 0.03, 'square', 0.02); }
  function advanceDialog() {
    if (!dq) return;
    dq.lines.shift();
    if (dq.lines.length) return showLine();
    $('dialog').classList.add('hidden');
    const r = dq.res; dq = null; r();
  }
  $('dialog').addEventListener('click', advanceDialog);

  // ------------------------------------------------------------------ battle
  let B = null;            // ENGINE.Battle
  let bctx = null;         // {trainer npc, wild}
  let ui = null;           // snapshot per side
  let fast = false;

  function pickWeighted(list) {
    const tot = list.reduce((s, x) => s + x[3], 0);
    let r = Math.random() * tot;
    for (const x of list) { r -= x[3]; if (r <= 0) return x; }
    return list[0];
  }
  function startWild(zoneId) {
    const z = C.ZONES[zoneId];
    const [key, lo, hi] = pickWeighted(z.wild);
    const lv = lo + Math.floor(Math.random() * (hi - lo + 1));
    const foe = ENG.createDaemon(key, lv);
    startBattle({ enemy: [foe], wild: true });
  }
  function seeded(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function startTrainer(n) {
    const rng = seeded(n.id.split('').reduce((h, c) => h * 31 + c.charCodeAt(0), 7));
    const team = n.team.map(([key, lv], i) => ENG.createDaemon(key, lv, { rng, uid: n.id + i }));
    startBattle({ enemy: team, wild: false, trainer: n });
  }

  function startBattle(o) {
    mode = 'battle'; setPad(false);
    $('hud').classList.add('hidden');
    const firstAlive = S.party.findIndex(d => d.hp > 0);
    B = new ENG.Battle({ player: S.party, enemy: o.enemy, wild: o.wild, trainer: o.trainer ? { name: o.trainer.name } : null, discovered: new Set(discovered) });
    bctx = o;
    for (const d of o.enemy) seen.add(d.key);
    ui = [0, 1].map(i => snapshot(i));
    $('battle').classList.remove('hidden');
    $('blog').innerHTML = '';
    $('bpanel').classList.add('hidden');
    paintSide(0); paintSide(1);
    $('foeSprite').classList.remove('faint'); $('allySprite').classList.remove('faint');
    renderCards(); renderResidue(null, null);
    startFx();
    (async () => {
      await logMsg(o.wild ? `A wild ${ENG.rec(o.enemy[0].key).dName} materializes!` : `${o.trainer.name} challenges you!`);
      if (!o.wild) await logMsg(`${o.trainer.name} deploys ${ENG.rec(o.enemy[0].key).dName}!`);
      await logMsg(`Go, ${dName(S.party[firstAlive])}!`);
      showActions();
    })();
  }

  function snapshot(i) {
    const s = B.sides[i], d = s.team[s.active], v = s.v;
    return { key: d.key, name: dName(d), level: d.level, hp: d.hp, max: v.stats.hp, flux: v.flux, fmax: v.stats.flux, shield: v.shield, status: v.status && v.status.id, stages: Object.assign({}, v.stages), soak: v.soak > 0, regen: v.regen > 0, uid: d.uid };
  }
  function paintSide(i) { SP.paint(i === 0 ? $('allySprite') : $('foeSprite'), ui[i].key, { flip: i === 0 }); }

  function renderCards() {
    for (const i of [0, 1]) {
      const u = ui[i], el = i === 0 ? $('allyCard') : $('foeCard');
      const pct = clamp(u.hp / u.max, 0, 1);
      const sh = clamp(u.shield / u.max, 0, 1);
      const col = pct > 0.5 ? 'var(--good)' : pct > 0.2 ? 'var(--warn)' : 'var(--bad)';
      const chips = [];
      if (u.status) chips.push(`<span class="st bad">${ENG.STATUS[u.status].name}</span>`);
      if (u.soak) chips.push('<span class="st inf">Soaked</span>');
      if (u.regen) chips.push('<span class="st good">Regen</span>');
      if (u.shield > 0) chips.push(`<span class="st inf">Shield ${u.shield}</span>`);
      const nm = { atk: 'LOG', def: 'FWL', spd: 'CLK', acc: 'ACC', eva: 'EVA' };
      for (const k in u.stages) if (u.stages[k]) chips.push(`<span class="st ${u.stages[k] > 0 ? 'good' : 'bad'}">${nm[k]} ${u.stages[k] > 0 ? '+' : ''}${u.stages[k]}</span>`);
      const tier = E.parseKey(u.key).subs.length;
      el.innerHTML = `<div class="nm">${esc(u.name)}<span>${TIER[tier]} · Lv ${u.level}</span></div>
        ${genomeHTML(u.key)}
        <div class="bar"><i style="width:${pct * 100}%;background:${col}"></i><b style="left:${pct * 100}%;width:${Math.min(sh, 1 - pct) * 100}%"></b></div>
        ${i === 0 ? `<div class="nums"><span>HP ${u.hp}/${u.max}</span><span>Flux ${u.flux}/${u.fmax}</span></div>` : ''}
        <div class="bar flux"><i style="width:${clamp(u.flux / u.fmax, 0, 1) * 100}%"></i></div>
        <div class="stat-chips">${chips.join('')}</div>`;
    }
  }
  function renderResidue(res, field) {
    res = res || B.residue; field = field === undefined ? B.field : field;
    let h = '';
    for (const m of E.MAINS) {
      h += `<div class="rs" title="${E.MAIN[m].name} residue" style="color:${MAINC(m)}">`;
      for (let i = 0; i < 6; i++) h += `<i style="${i < res[m] ? `background:${MAINC(m)}` : ''}"></i>`;
      h += '</div>';
    }
    if (field) h += `<span class="fieldtag" style="color:${MAINC(field.el)}">${E.MAIN[field.el].name} field · ${field.turns}</span>`;
    $('residue').innerHTML = h;
  }

  function logMsg(text) {
    const box = $('blog');
    [...box.children].forEach(c => c.classList.add('old'));
    const d = document.createElement('div'); d.textContent = text; box.appendChild(d);
    while (box.children.length > 3) box.firstChild.remove();
    return sleep(fast ? 260 : 700);
  }
  $('blog').addEventListener('click', () => { fast = true; });

  // particles
  const fxc = $('fx'), fctx = fxc.getContext('2d');
  let parts = [], fxRun = false;
  function startFx() { if (fxRun) return; fxRun = true; requestAnimationFrame(fxLoop); }
  function fxLoop() {
    const r = fxc.getBoundingClientRect();
    if (fxc.width !== Math.round(r.width)) { fxc.width = Math.round(r.width); fxc.height = Math.round(r.height); }
    fctx.clearRect(0, 0, fxc.width, fxc.height);
    parts = parts.filter(p => (p.life -= 1) > 0);
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy; p.vx *= 0.97; p.vy *= 0.97; p.vy += p.g || 0;
      if (p.tx != null) { p.x += (p.tx - p.x) * 0.06; p.y += (p.ty - p.y) * 0.06; }
      fctx.globalAlpha = Math.min(1, p.life / 20);
      fctx.fillStyle = p.c; fctx.fillRect(p.x, p.y, p.s, p.s);
    }
    fctx.globalAlpha = 1;
    if (mode === 'battle' || parts.length) requestAnimationFrame(fxLoop); else fxRun = false;
  }
  function centerOf(el) { const a = $('arena').getBoundingClientRect(), b = el.getBoundingClientRect(); return [b.left - a.left + b.width / 2, b.top - a.top + b.height / 2]; }
  function burst(side, colors, n, toSide) {
    const [x, y] = centerOf(side === 0 ? $('allySprite') : $('foeSprite'));
    const t = toSide != null ? centerOf(toSide === 0 ? $('allySprite') : $('foeSprite')) : null;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, sp = 1 + Math.random() * 4;
      parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, c: colors[i % colors.length], s: 3 + Math.random() * 4, life: 40 + Math.random() * 30, tx: t && t[0] + (Math.random() - 0.5) * 50, ty: t && t[1] + (Math.random() - 0.5) * 50 });
    }
  }
  function keyColors(key) { const p = E.parseKey(key); return [MAINC(p.a), MAINC(p.b), ...p.subs.map(t => subColor(t.s)), '#ffffff']; }
  function flashSprite(side, cls, ms) { const el = side === 0 ? $('allySprite') : $('foeSprite'); el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); setTimeout(() => el.classList.remove(cls), ms || 400); }

  async function play(events) {
    for (const e of events) {
      switch (e.type) {
        case 'msg':
          if (e.anim === 'cast' && e.key) {
            const el = e.side === 0 ? $('allySprite') : $('foeSprite');
            el.style.setProperty('--glow', MAINC(E.parseKey(e.key).a)); el.classList.add('cast');
            castSfx(e.key); burst(e.side, keyColors(e.key), 50, ENG.rec(e.key).self ? null : 1 - e.side);
            setTimeout(() => el.classList.remove('cast'), 700);
          } else if (e.anim === 'glitch') { burst(e.side == null ? 0 : e.side, ['#ff5cf0', '#46f3ff', '#ffffff'], 40); beep(90, 0.25, 'sawtooth', 0.05); }
          else if (e.anim === 'react') burst(1, [MAINC(e.el), MAINC(e.el2), '#fff'], 70);
          else if (e.anim === 'field') { burst(0, [MAINC(e.el)], 30); burst(1, [MAINC(e.el)], 30); }
          else if (e.anim === 'heal' || e.anim === 'shield') burst(e.side, [e.anim === 'heal' ? '#5dff9a' : '#cfe8ff', '#ffffff'], 25);
          else if (e.anim === 'levelup') beep(988, 0.2, 'triangle', 0.05);
          else if (e.anim === 'bound') { beep(784, 0.15, 'sine'); setTimeout(() => beep(1046, 0.25, 'sine'), 150); }
          else if (e.anim === 'bind') burst(0, ['#46f3ff', '#ffffff'], 30, 1);
          await logMsg(e.text);
          break;
        case 'hit': flashSprite(e.side, 'hit', 360); beep(140, 0.08, 'square', 0.05); break;
        case 'hp': ui[e.side].hp = e.hp; ui[e.side].max = e.max; ui[e.side].shield = e.shield; renderCards(); await sleep(fast ? 80 : 220); break;
        case 'flux': ui[e.side].flux = e.flux; ui[e.side].fmax = e.max; renderCards(); break;
        case 'status': Object.assign(ui[e.side], { status: e.status, stages: e.stages, soak: e.soak, shield: e.shield, regen: e.regen }); renderCards(); break;
        case 'field': renderResidue(e.residue, e.field); break;
        case 'switch': {
          ui[e.side] = snapshot(e.side);
          const el = e.side === 0 ? $('allySprite') : $('foeSprite'); el.classList.remove('faint');
          paintSide(e.side); renderCards(); seen.add(e.key); break;
        }
        case 'faint': (e.side === 0 ? $('allySprite') : $('foeSprite')).classList.add('faint'); beep(110, 0.4, 'sawtooth', 0.05); await sleep(300); break;
        case 'discover': markDiscovered(e.key); break;
        case 'shake': $('foeSprite').style.opacity = 0.3; await sleep(250); $('foeSprite').style.opacity = ''; beep(300 + e.n * 100, 0.08); await sleep(350); break;
        case 'unbind': burst(1, ['#46f3ff'], 20); break;
        case 'xp': pendingXp.push(e); break;
        default: break;
      }
    }
  }
  let pendingXp = [];

  function showActions() {
    fast = false;
    const a = $('bactions'); a.classList.remove('hidden'); $('bpanel').classList.add('hidden');
    a.innerHTML = '';
    const add = (label, fn, cls, dis) => { const b = document.createElement('button'); b.textContent = label; if (cls) b.className = cls; b.disabled = !!dis; b.onclick = fn; a.appendChild(b); };
    add('Memory', () => panelMemory(), 'pri');
    add('Compose', () => panelCompose(), 'pri');
    add('Defrag', () => doTurn({ type: 'defrag' }));
    add('Daemons', () => panelSwitch(false));
    add('Bag', () => panelBag());
    add('Run', () => doTurn({ type: 'run' }), '', !bctx.wild);
  }
  function hideActions() { $('bactions').classList.add('hidden'); $('bpanel').classList.add('hidden'); }
  function panel(title, html, back) {
    const p = $('bpanel'); $('bactions').classList.add('hidden'); p.classList.remove('hidden');
    p.innerHTML = `<div class="ph"><span>${title}</span>${back !== false ? '<button class="btn small" data-back>Back</button>' : ''}</div>${html}`;
    const bb = p.querySelector('[data-back]'); if (bb) bb.onclick = showActions;
    return p;
  }

  function mergeButton(key, flux, extra) {
    const r = ENG.rec(key), known = discovered.has(key), p = E.parseKey(key);
    const eff = ENG.effectiveness(key, ui[1].key);
    const effTxt = r.damaging ? (eff >= 1.2 ? '<b style="color:var(--good)">Effective</b>' : eff <= 0.83 ? '<b style="color:var(--bad)">Resisted</b>' : '') : '';
    return `<button class="mbtn" data-key="${key}" style="--lc:${MAINC(p.a)}" ${r.flux > flux ? 'disabled' : ''}>
      <div class="t">${known ? esc(r.name) : 'Unknown merge'}</div>
      <div class="m">${genomeHTML(key)}</div>
      <div class="m">${known ? `<span class="cls">${r.cls}</span>${r.damaging ? `<span>Pow ${r.power}${r.hits > 1 ? '×' + r.hits : ''}</span>` : ''}<span>Acc ${r.acc > 100 ? '—' : r.acc}</span>` : '<span>???</span>'}<span>Flux ${r.flux}</span>${effTxt}${extra || ''}</div>
    </button>`;
  }

  function panelMemory() {
    const d = B.act(0);
    const keys = d.memory.filter(Boolean);
    const p = panel('Memory', `<div class="mlist">${keys.map(k => mergeButton(k, ui[0].flux)).join('') || '<p class="sub">No merges in memory. Use Compose.</p>'}</div>`);
    p.querySelectorAll('[data-key]').forEach(b => b.onclick = () => doTurn({ type: 'merge', key: b.dataset.key }));
  }

  function panelCompose() {
    const d = B.act(0);
    const p = panel(`Compose · width ${ENG.width(d)}`, '<div id="cmp"></div>');
    composer(p.querySelector('#cmp'), {
      mains: ENG.mainsOf(d.key), subs: d.attuned, width: ENG.width(d),
      actions: [
        { label: 'Cast', pri: true, ok: k => ENG.rec(k).flux <= ui[0].flux, fn: k => doTurn({ type: 'merge', key: k }) },
        { label: 'Save to memory', ok: k => !d.memory.includes(k), fn: k => { const i = d.memory.indexOf(null); d.memory[i >= 0 ? i : 3] = k; toast('Saved to memory.'); panelCompose(); } },
      ],
    });
  }

  function panelSwitch(forced) {
    const html = `<div class="plist">${S.party.map((d, i) => partyCard(d, i === B.sides[0].active)).join('')}</div>`;
    const p = panel(forced ? 'Choose a daemon to deploy' : 'Swap daemon', html, !forced);
    p.querySelectorAll('[data-i]').forEach(b => b.onclick = () => {
      const i = +b.dataset.i, d = S.party[i];
      if (d.hp <= 0 || i === B.sides[0].active) return;
      if (forced) { play(B.forceSwitch(i)).then(afterTurn); hideActions(); }
      else doTurn({ type: 'switch', idx: i });
    });
    hydrateCanvases(p);
  }

  function battleUsable(it) { return it.count > 0 && ['patch', 'ward', 'catalyst', 'cell'].includes(it.kind) || (it.kind === 'lattice' && bctx.wild && it.count > 0); }
  function panelBag() {
    const items = Object.values(S.bag).filter(battleUsable);
    const html = items.length ? `<div class="mlist">${items.map(it => `<button class="mbtn" data-id="${esc(it.id)}"><div class="t">${esc(it.name)} ×${it.count}</div><div class="m">${itemDesc(it)}</div></button>`).join('')}</div>` : '<p class="sub">Nothing usable in battle. Forge items from motes at the Nexus Forge.</p>';
    const p = panel('Bag', html);
    p.querySelectorAll('[data-id]').forEach(b => b.onclick = () => {
      const it = S.bag[b.dataset.id];
      it.count--; if (it.count <= 0 && it.id !== 'lattice:basic') delete S.bag[it.id];
      if (it.kind === 'lattice') doTurn({ type: 'bind', item: it });
      else doTurn({ type: 'item', item: it });
    });
  }

  async function doTurn(action) {
    hideActions();
    const ev = B.turnWith(action);
    await play(ev);
    afterTurn();
  }

  async function afterTurn() {
    if (B.over) return endBattle();
    if (B.needSwitch) return panelSwitch(true);
    showActions();
  }

  async function endBattle() {
    const res = B.result, o = bctx;
    await sleep(300);
    if (res === 'win') {
      for (const [k, n] of Object.entries(B.rewards.motes)) S.motes[k] = (S.motes[k] || 0) + n;
      const got = Object.entries(B.rewards.motes).map(([k, n]) => `${n} ${E.MAIN[k] ? E.MAIN[k].name : E.SUB[k].name}`).join(', ');
      if (got) await logMsg(`Collected motes: ${got}.`);
      if (o.trainer) {
        S.beaten.push(o.trainer.id);
        const lat = S.bag['lattice:basic'] || (S.bag['lattice:basic'] = { id: 'lattice:basic', kind: 'lattice', name: 'Basic Lattice', power: 1, count: 0 });
        lat.count += 2;
        await logMsg('Received 2 Basic Lattices.');
      }
    }
    if (res === 'bind') {
      const d = B.rewards.bound;
      d.uid = 'd' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
      boundForms.add(d.key); seen.add(d.key);
      if (S.party.length < 6) S.party.push(d); else { S.box.push(d); toast(`${esc(dName(d))} was sent to Storage.`); }
    }
    for (const k of B.discovered) if (!discovered.has(k)) markDiscovered(k, true);
    $('battle').classList.add('hidden');
    mode = 'busy';
    if (res === 'lose') {
      for (const d of S.party) d.hp = ENG.calcStats(d).hp;
      player.x = S.lastHeal.x; player.y = S.lastHeal.y; player.px = player.x; player.py = player.y; follower.x = follower.px = player.x; follower.y = follower.py = player.y + 0;
      await say('System', ['All of your daemons were deallocated...', 'Rebooting at the last terminal. Your daemons have been restored.']);
    }
    // level-up choices
    await processXp();
    if (res === 'win' && o.trainer) {
      await say(o.trainer.name, [o.trainer.outro]);
      if (o.trainer.badge && !S.keys.includes(o.trainer.badge)) {
        S.keys.push(o.trainer.badge); S.badges = S.keys.length;
        await say('System', [`You received the ${o.trainer.badge}! (${Math.min(S.badges, 4)}/4)` + (o.trainer.final ? '' : ' A firewall gate somewhere just opened.')]);
      }
      if (o.trainer.final) { S.won = true; save(); showEnding(); return; }
    }
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

  // ------------------------------------------------------------------ modals
  function modal(html) {
    $('modal').classList.remove('hidden'); $('modalCard').innerHTML = html; hydrateCanvases($('modalCard'));
    return $('modalCard');
  }
  function closeModal() { $('modal').classList.add('hidden'); }
  // In-page replacement for confirm()/prompt(). Resolves true/false, or the typed text (null on cancel).
  function ask(title, text, opts) {
    opts = opts || {};
    return new Promise(res => {
      const card = modal(`<h2>${esc(title)}</h2><p>${esc(text)}</p>${opts.input != null ? `<input class="search" id="askInput" maxlength="16" value="${esc(opts.input)}">` : ''}
        <div class="btnrow"><button class="btn pri" data-ok>${esc(opts.ok || 'OK')}</button><button class="btn" data-cancel>Cancel</button></div>`);
      const inp = card.querySelector('#askInput');
      if (inp) { inp.focus(); inp.select(); }
      const done = v => { closeModal(); res(v); };
      card.querySelector('[data-ok]').onclick = () => done(inp ? inp.value : true);
      card.querySelector('[data-cancel]').onclick = () => done(inp ? null : false);
      if (inp) inp.onkeydown = e => { if (e.key === 'Enter') done(inp.value); };
    });
  }

  function attuneModal(d) {
    return new Promise(res => {
      const pool = ENG.eligibleSubs(d.key).filter(s => !d.attuned.includes(s));
      if (!pool.length) return res();
      const opts = [];
      while (opts.length < Math.min(3, pool.length)) { const s = pool[Math.floor(Math.random() * pool.length)]; if (!opts.includes(s)) opts.push(s); }
      const card = modal(`<h2>${esc(dName(d))} can attune a new essence</h2><p>An attuned sub-essence can be used in composed merges and in recompiles. Pick one.</p>
        <div class="opts">${opts.map(s => `<button class="opt" data-s="${s}"><div class="grow">${essChip(s, E.SUB[s].host ? E.MAIN[E.SUB[s].host].name + '-bound' : 'universal')}<small>${esc(E.SUB[s].desc)}</small></div></button>`).join('')}</div>`);
      card.querySelectorAll('[data-s]').forEach(b => b.onclick = () => { d.attuned.push(b.dataset.s); closeModal(); toast(`${esc(dName(d))} attuned ${E.SUB[b.dataset.s].name}.`); res(); });
    });
  }

  function statTotal(key) { return ENG.rec(key).dStats.reduce((a, b) => a + b, 0); }
  function recompileModal(d) {
    return new Promise(res => {
      const opts = ENG.recompileOptions(d);
      if (!opts.length) return res();
      const cur = statTotal(d.key);
      const card = modal(`<h2>${esc(dName(d))} is ready to recompile</h2><p>Binding one attuned sub-essence into its genome creates a new form. You can't undo this. You can also wait and recompile later from the Party menu.</p>
        <div class="opts">${opts.map(k => { const r = ENG.rec(k), p = E.parseKey(k), added = p.subs.find(t => !E.parseKey(d.key).subs.some(u => u.s === t.s && u.h === t.h)); const dt = statTotal(k) - cur;
          return `<button class="opt" data-k="${k}"><canvas data-sprite="${k}" width="64" height="64"></canvas><div class="grow"><b>${seen.has(k) ? esc(r.dName) : '??? form'}</b> <span class="delta up">+${dt} stats</span><small>+ ${E.SUB[added.s].name} → ${E.MAIN[E.hostMain(p, added.h)].name} · passive ${ENG.PASSIVES[r.dPassive][0]}</small></div></button>`; }).join('')}</div>
        <button class="btn" data-no>Not now</button>`);
      card.querySelectorAll('[data-k]').forEach(b => b.onclick = async () => {
        const before = dName(d);
        ENG.recompile(d, b.dataset.k); seen.add(d.key); boundForms.add(d.key);
        closeModal();
        toast(`${esc(before)} recompiled into <b>${esc(ENG.rec(d.key).dName)}</b>!`, 'rare');
        res();
      });
      card.querySelector('[data-no]').onclick = () => { closeModal(); res(); };
    });
  }

  function hydrateCanvases(root) {
    root.querySelectorAll('canvas[data-sprite]').forEach(c => SP.paint(c, c.dataset.sprite, { silhouette: c.dataset.sil === '1' }));
  }

  // ------------------------------------------------------------------ composer
  function composer(root, o) {
    const mains = Array.from(new Set(o.mains));
    let a = mains[0], b = mains[1] || mains[0];
    if (o.initial) { const p = E.parseKey(o.initial); a = p.a; b = p.b; }
    let tok = new Set(); // "Em1"
    if (o.initial) for (const t of E.parseKey(o.initial).subs) tok.add(t.s + t.h);
    const key = () => E.makeKey(a, b, [...tok].map(t => ({ s: t.slice(0, 2), h: +t[2] })));
    const hostsFor = s => { const h = []; if (E.eligible(s, a)) h.push(1); if (a !== b && E.eligible(s, b)) h.push(2); return h; };
    const cycle = s => {
      const hs = hostsFor(s);
      const cur = hs.filter(h => tok.has(s + h));
      const states = [[]].concat(hs.map(h => [h]));
      if (hs.length === 2) states.push([1, 2]);
      let idx = states.findIndex(st => st.length === cur.length && st.every(h => cur.includes(h)));
      for (let n = 0; n < states.length; n++) {
        idx = (idx + 1) % states.length;
        const others = [...tok].filter(t => t.slice(0, 2) !== s).length;
        if (others + states[idx].length <= o.width) break;
      }
      for (const h of [1, 2]) tok.delete(s + h);
      for (const h of states[idx]) tok.add(s + h);
    };
    const prune = () => { for (const t of [...tok]) { const s = t.slice(0, 2), h = +t[2]; if (!hostsFor(s).includes(h)) tok.delete(t); } if (a === b) for (const t of [...tok]) if (t[2] === '2') tok.delete(t); };
    function render() {
      prune();
      const k = key(), r = ENG.rec(k), known = discovered.has(k);
      const rx = E.REACTION[E.pairId(a, b)].names[a];
      const mainBtns = which => mains.map(m => `<button class="mainbtn ${((which === 1 ? a : b) === m) ? 'on' : ''}" style="--c:${MAINC(m)}" data-m${which}="${m}">${E.MAIN[m].name}</button>`).join('');
      const subsHTML = E.SUB_ORDER.filter(s => o.subs.includes(s)).map(s => {
        const hs = hostsFor(s);
        const on = hs.filter(h => tok.has(s + h));
        const hostLbl = on.map(h => E.MAIN[h === 1 ? a : b].name[0]).join('+');
        const cnt = o.counts ? `<span class="cnt">×${o.counts[s] || 0}</span>` : '';
        return `<button class="subchip ${on.length ? 'on' : ''}" style="--c:${subColor(s)};--hc:${on.length ? MAINC(on[0] === 1 ? a : b) : '#333'}" data-s="${s}" ${hs.length ? '' : 'disabled'}>
          <span style="color:${subColor(s)}">◆</span> ${E.SUB[s].name}${on.length ? `<span class="host">${hostLbl}</span>` : ''}<small>${E.SUB[s].host ? E.MAIN[E.SUB[s].host].name + ' only' : 'any host'}</small>${cnt}</button>`;
      }).join('');
      const fxHTML = known ? r.fx.map(f => `<span class="st ${E.SELF_FX.has(f.code) ? 'good' : f.code === 'recoil' ? 'bad' : 'inf'}">${esc(ENG.describeFx(f))}</span>`).join('') : '';
      const prev = known ? `<div class="preview">
          <div class="genome"><span class="rar r${r.rarity}">${RARITY[r.rarity]}</span><span class="cls">${r.cls}</span>${r.tags.map(t => `<span class="rar r2">${esc(t)}</span>`).join('')}</div>
          <div class="pn">${esc(r.name)}</div>
          <div class="pm">${r.damaging ? `<span>Power <b>${r.power}${r.hits > 1 ? '×' + r.hits : ''}</b></span>` : ''}<span>Acc <b>${r.acc > 100 ? 'sure' : r.acc}</b></span><span>Flux <b>${r.flux}</b></span>${r.prio ? `<span>Priority <b>${r.prio > 0 ? '+' : ''}${r.prio}</b></span>` : ''}<span>Instability <b style="color:${r.instab >= 35 ? 'var(--bad)' : r.instab >= 18 ? 'var(--warn)' : 'var(--good)'}">${r.instab}%</b></span></div>
          <div class="fxl">${fxHTML}</div>
          <div class="txt">${esc(E.REACTION[E.pairId(a, b)].line + ' ' + r.text)}</div></div>`
        : `<div class="preview unknown"><div class="genome"><span class="cls">${rx}</span></div><div class="pn">? ? ? ? ?</div><div class="pm"><span>Flux <b>${r.flux}</b></span><span>Undiscovered. ${o.forge ? 'Forge' : 'Cast'} it to find out what it becomes.</span></div></div>`;
      root.innerHTML = `<div class="composer">
        <div class="row"><label>Main</label>${mainBtns(1)}</div>
        ${mains.length > 1 ? `<div class="row"><label>Second</label>${mainBtns(2)}</div>` : ''}
        <div class="row"><label>Subs ${tok.size}/${o.width}</label><span class="fine">Tap to bind to a host. Tap again to switch hosts.</span></div>
        <div class="subgrid">${subsHTML || '<span class="fine">No sub-essences attuned yet.</span>'}</div>
        <div class="row">${genomeHTML(k)}</div>
        ${prev}
        ${o.extra ? o.extra(k) : ''}
        <div class="btnrow">${o.actions.map((ac, i) => `<button class="btn ${ac.pri ? 'pri' : ''}" data-act="${i}" ${ac.ok && !ac.ok(k) ? 'disabled' : ''}>${ac.label}</button>`).join('')}</div>
      </div>`;
      root.querySelectorAll('[data-m1]').forEach(x => x.onclick = () => { a = x.dataset.m1; render(); });
      root.querySelectorAll('[data-m2]').forEach(x => x.onclick = () => { b = x.dataset.m2; render(); });
      root.querySelectorAll('[data-s]').forEach(x => x.onclick = () => { cycle(x.dataset.s); render(); });
      root.querySelectorAll('[data-act]').forEach(x => x.onclick = () => o.actions[+x.dataset.act].fn(key(), render));
    }
    render();
  }

  // ------------------------------------------------------------------ sheet (menus)
  let sheetTab = 'party', sheetClosable = true, detailUid = null, codexFilter = 'all', codexSearch = '', codexKey = null;
  const TABS = [['party', 'Party'], ['bag', 'Bag'], ['codex', 'Codex'], ['forms', 'Forms'], ['lexicon', 'Lexicon'], ['forge', 'Forge'], ['system', 'System']];
  function openSheet(tab) {
    if (mode !== 'world' && mode !== 'sheet') return;
    mode = 'sheet'; setPad(false);
    sheetTab = tab; detailUid = null; codexKey = null;
    $('sheet').classList.remove('hidden'); $('hud').classList.add('hidden');
    renderSheet();
  }
  function closeSheet() { $('sheet').classList.add('hidden'); $('hud').classList.remove('hidden'); mode = 'world'; setPad(true); updateHud(); save(); }
  $('sheetClose').onclick = closeSheet;
  function atForge() { const [dx, dy] = DIRS[player.dir]; return tileAt(player.x + dx, player.y + dy) === 'F'; }

  function renderSheet() {
    $('sheetTabs').innerHTML = TABS.filter(([id]) => id !== 'forge' || atForge()).map(([id, nm]) => `<button class="${id === sheetTab ? 'on' : ''}" data-tab="${id}">${nm}</button>`).join('');
    $('sheetTabs').querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { sheetTab = b.dataset.tab; detailUid = null; codexKey = null; renderSheet(); });
    const body = $('sheetBody');
    body.scrollTop = 0;
    ({ party: sheetParty, bag: sheetBag, codex: sheetCodex, forms: sheetForms, lexicon: sheetLexicon, forge: sheetForge, system: sheetSystem })[sheetTab](body);
    hydrateCanvases(body);
  }

  function partyCard(d, sel, idx) {
    const st = ENG.calcStats(d), pct = clamp(d.hp / st.hp, 0, 1);
    const i = idx != null ? idx : S.party.indexOf(d);
    return `<button class="pcard ${d.hp <= 0 ? 'fainted' : ''} ${sel ? 'sel' : ''}" data-i="${i}" data-uid="${d.uid}">
      <canvas data-sprite="${d.key}" width="64" height="64"></canvas>
      <div class="grow"><div class="n">${esc(dName(d))}<span>Lv ${d.level}</span></div>${genomeHTML(d.key)}
      <div class="bar"><i style="width:${pct * 100}%;background:${pct > 0.5 ? 'var(--good)' : pct > 0.2 ? 'var(--warn)' : 'var(--bad)'}"></i></div>
      <div class="nums" style="display:flex;justify-content:space-between;color:var(--dim);font-size:11px"><span>HP ${d.hp}/${st.hp}</span><span>${TIER[E.parseKey(d.key).subs.length]}</span></div></div></button>`;
  }

  function sheetParty(body) {
    if (detailUid) return daemonDetail(body, detailUid);
    body.innerHTML = `<h3>Party (${S.party.length}/6)</h3><div class="plist">${S.party.map(d => partyCard(d)).join('')}</div>
      <h3>Storage (${S.box.length})</h3>${S.box.length ? `<div class="plist">${S.box.map((d, i) => partyCard(d, false, 'b' + i)).join('')}</div>` : '<p class="sub">Daemons you bind with a full party are stored here.</p>'}`;
    body.querySelectorAll('[data-uid]').forEach(b => b.onclick = () => { detailUid = b.dataset.uid; renderSheet(); });
  }

  function findDaemon(uid) { return S.party.find(d => d.uid === uid) || S.box.find(d => d.uid === uid); }

  function daemonDetail(body, uid) {
    const d = findDaemon(uid); if (!d) { detailUid = null; return sheetParty(body); }
    const inParty = S.party.includes(d);
    const r = ENG.rec(d.key), st = ENG.calcStats(d), pv = ENG.PASSIVES[r.dPassive];
    const stats = [['HP', st.hp, r.dStats[0]], ['Logic', st.atk, r.dStats[1]], ['Firewall', st.def, r.dStats[2]], ['Clock', st.spd, r.dStats[3]], ['Flux', st.flux, r.dStats[4]], ['Coherence', st.coh, r.dStats[5]]];
    const rc = ENG.recompileOptions(d);
    const next = ENG.xpFor(d.level + 1), cur = ENG.xpFor(d.level);
    body.innerHTML = `<button class="btn small" data-back>← Party</button>
      <div class="detail" style="margin-top:10px">
        <div><canvas class="big" data-sprite="${d.key}" width="160" height="160"></canvas></div>
        <div>
          <h2 style="margin:0">${esc(dName(d))} <span class="fine">Lv ${d.level} · ${TIER[r.tier]}</span></h2>
          ${genomeHTML(d.key)}
          <p class="lore">${esc(lore(d.key))}</p>
          <div class="fine">XP ${d.xp - cur}/${next - cur} · Passive: <b style="color:var(--ink)">${pv[0]}</b>: ${esc(pv[1])}</div>
        </div>
      </div>
      <h3>Stats</h3>
      <div class="kv">${stats.map(([n, v, b]) => `<span class="lab">${n}</span><span class="sbar"><i style="width:${Math.min(100, b / 1.6)}%"></i></span><b>${v}</b>`).join('')}</div>
      <h3>Attuned essences · merge width ${ENG.width(d)}</h3>
      <div class="genome">${ENG.mainsOf(d.key).map(m => essChip(m)).join('')}${d.attuned.map(s => essChip(s)).join('') || ''}</div>
      <p class="fine">New attunements at levels ${ENG.ATTUNE_LEVELS.filter(l => l > d.level).slice(0, 3).join(', ')}. Width grows at 10 and 22. Recompiles unlock at ${ENG.RECOMPILE_LEVELS.join(', ')}.</p>
      <h3>Memory</h3>
      <div class="mem">${d.memory.map((k, i) => `<button class="mbtn" data-slot="${i}" style="--lc:${k ? MAINC(k[0]) : 'var(--line)'}"><div class="t">${k ? esc(mergeLabel(k)) : '— empty slot —'}</div>${k ? `<div class="m">${genomeHTML(k)}</div><div class="m">${discovered.has(k) ? `<span class="cls">${ENG.rec(k).cls}</span>` : ''}<span>Flux ${ENG.rec(k).flux}</span></div>` : '<div class="m">Tap to compose</div>'}</button>`).join('')}</div>
      <div id="memEdit"></div>
      <h3>Actions</h3>
      <div class="btnrow">
        ${inParty && S.party.indexOf(d) > 0 ? '<button class="btn" data-lead>Make lead</button>' : ''}
        ${rc.length ? '<button class="btn pri" data-rc>Recompile…</button>' : ''}
        ${inParty && S.party.length > 1 ? '<button class="btn" data-store>Move to storage</button>' : ''}
        ${!inParty && S.party.length < 6 ? '<button class="btn" data-take>Move to party</button>' : ''}
        <button class="btn" data-nick>Rename</button>
      </div>`;
    body.querySelector('[data-back]').onclick = () => { detailUid = null; renderSheet(); };
    body.querySelectorAll('[data-slot]').forEach(b => b.onclick = () => {
      const i = +b.dataset.slot;
      const box = body.querySelector('#memEdit');
      box.innerHTML = `<h3>Compose memory slot ${i + 1}</h3><div id="cmpm"></div>`;
      composer(box.querySelector('#cmpm'), {
        mains: ENG.mainsOf(d.key), subs: d.attuned, width: ENG.width(d), initial: d.memory[i] || undefined,
        actions: [
          { label: 'Save to slot', pri: true, fn: k => { d.memory[i] = k; save(); renderSheet(); } },
          { label: 'Clear slot', fn: () => { d.memory[i] = null; renderSheet(); } },
        ],
      });
      box.scrollIntoView({ behavior: 'smooth' });
    });
    const q = s => body.querySelector(s);
    if (q('[data-lead]')) q('[data-lead]').onclick = () => { S.party.splice(S.party.indexOf(d), 1); S.party.unshift(d); renderSheet(); };
    if (q('[data-rc]')) q('[data-rc]').onclick = async () => { $('sheet').classList.add('hidden'); await recompileModal(d); $('sheet').classList.remove('hidden'); renderSheet(); };
    if (q('[data-store]')) q('[data-store]').onclick = () => { S.party.splice(S.party.indexOf(d), 1); S.box.push(d); renderSheet(); };
    if (q('[data-take]')) q('[data-take]').onclick = () => { S.box.splice(S.box.indexOf(d), 1); S.party.push(d); renderSheet(); };
    q('[data-nick]').onclick = async () => { const n = await ask('Rename daemon', 'Leave it empty to use the form name.', { input: d.nick || '', ok: 'Rename' }); if (n !== null) { d.nick = n.trim().slice(0, 16) || null; renderSheet(); } };
  }

  function itemDesc(it) {
    switch (it.kind) {
      case 'lattice': return `Bind a wild daemon. Strength ×${it.power}${it.main ? `, ×1.5 against ${E.MAIN[it.main].name}-led daemons` : ''}.`;
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
    body.innerHTML = `<h3>Items</h3>${items.length ? `<div class="clist">${items.map(it => `<div class="crow" style="--lc:var(--acc)"><span class="t">${esc(it.name)} ×${it.count}</span>${['patch', 'script'].includes(it.kind) ? `<button class="btn small" data-use="${esc(it.id)}">Use</button>` : ''}</div><div class="fine" style="margin:-2px 0 4px 12px">${itemDesc(it)}</div>`).join('')}</div>` : '<p class="sub">Empty.</p>'}
      <h3>Motes</h3><p class="fine">Defeated daemons leave behind motes of the essences they were made from. The Nexus Forge merges them into items.</p>
      <div class="motes">${motes.length ? motes.map(([k, n]) => essChip(k, '×' + n)).join('') : '<span class="fine">None yet.</span>'}</div>
      <div id="useBox"></div>`;
    body.querySelectorAll('[data-use]').forEach(b => b.onclick = () => {
      const it = S.bag[b.dataset.use];
      const box = body.querySelector('#useBox');
      box.innerHTML = `<h3>Use ${esc(it.name)} on…</h3><div class="plist">${S.party.map(d => partyCard(d)).join('')}</div>`;
      hydrateCanvases(box);
      box.querySelectorAll('[data-uid]').forEach(c => c.onclick = () => {
        const d = findDaemon(c.dataset.uid);
        if (it.kind === 'patch') {
          const st = ENG.calcStats(d); if (d.hp >= st.hp) return toast('Already at full HP.');
          d.hp = Math.min(st.hp, d.hp + Math.ceil(st.hp * it.mag / 100)); toast(`${esc(dName(d))} restored.`);
        } else if (it.kind === 'script') {
          const ok = ENG.eligibleSubs(d.key);
          const s = it.subs.find(x => ok.includes(x) && !d.attuned.includes(x));
          if (!s) return toast(`${esc(dName(d))} can't learn anything from this script.`);
          d.attuned.push(s); toast(`${esc(dName(d))} attuned ${E.SUB[s].name}!`, 'rare');
        }
        it.count--; if (it.count <= 0 && it.id !== 'lattice:basic') delete S.bag[it.id];
        renderSheet();
      });
      box.scrollIntoView({ behavior: 'smooth' });
    });
  }

  function mergeDetail(k) {
    const r = ENG.rec(k), p = E.parseKey(k);
    return `<div class="preview">
      <div class="genome"><span class="rar r${r.rarity}">${RARITY[r.rarity]}</span><span class="cls">${r.cls}</span>${r.tags.map(t => `<span class="rar r2">${esc(t)}</span>`).join('')}${r.anomaly ? `<span class="rar r4">Anomaly: ${esc(r.anomaly)}</span>` : ''}</div>
      <div class="pn">${esc(r.name)}</div>${genomeHTML(k)}
      <div class="pm" style="margin-top:6px">${r.damaging ? `<span>Power <b>${r.power}${r.hits > 1 ? '×' + r.hits : ''}</b></span>` : ''}<span>Acc <b>${r.acc > 100 ? 'sure' : r.acc}</b></span><span>Flux <b>${r.flux}</b></span><span>Priority <b>${r.prio}</b></span><span>Instability <b>${r.instab}%</b></span></div>
      <div class="fxl">${r.fx.map(f => `<span class="st ${E.SELF_FX.has(f.code) ? 'good' : f.code === 'recoil' ? 'bad' : 'inf'}">${esc(ENG.describeFx(f))}</span>`).join('')}</div>
      <div class="txt">${esc(E.REACTION[E.pairId(p.a, p.b)].line + ' ' + r.text)}</div>
      ${r.anomaly ? `<div class="txt">∆ ${esc(E.ANOMALY[r.anomaly])}</div>` : ''}
      <div class="fine" style="margin-top:6px">Forges into: ${esc(forgeItem(k).name)}. As a daemon genome: ${seen.has(k) ? esc(r.dName) : 'unseen form'}.</div></div>`;
  }

  function sheetCodex(body) {
    const total = M.count, n = discovered.size;
    const pairs = [];
    for (const a of E.MAINS) for (const b of E.MAINS) pairs.push(a + b);
    let list = [...discovered];
    if (codexFilter !== 'all') list = list.filter(k => k.slice(0, 2) === codexFilter);
    if (codexSearch) { const q = codexSearch.toLowerCase(); list = list.filter(k => ENG.rec(k).name.toLowerCase().includes(q) || ENG.rec(k).tags.some(t => t.toLowerCase().includes(q))); }
    list.sort((x, y) => ENG.rec(y).rarity - ENG.rec(x).rarity || (ENG.rec(x).name < ENG.rec(y).name ? -1 : 1));
    const byRar = [0, 0, 0, 0, 0]; for (const k of discovered) byRar[ENG.rec(k).rarity]++;
    const pairTotal = pk => pk[0] === pk[1] ? 64 : 470;
    body.innerHTML = `<h3>Merge Codex</h3><div><b>${n}</b> / ${total} merges discovered (${(n / total * 100).toFixed(1)}%)</div>
      <div class="progress"><i style="width:${n / total * 100}%"></i></div>
      <div class="genome" style="margin-bottom:8px">${RARITY.map((nm, i) => `<span class="rar r${i}">${nm} ${byRar[i]}</span>`).join('')}</div>
      <div class="filters"><button data-f="all" class="${codexFilter === 'all' ? 'on' : ''}">All</button>${pairs.map(pk => `<button data-f="${pk}" class="${codexFilter === pk ? 'on' : ''}"><span style="color:${MAINC(pk[0])}">${E.MAIN[pk[0]].name[0]}</span>›<span style="color:${MAINC(pk[1])}">${E.MAIN[pk[1]].name[0]}</span> ${[...discovered].filter(k => k.slice(0, 2) === pk).length}/${pairTotal(pk)}</button>`).join('')}</div>
      <input class="search" placeholder="Search names or resonances…" value="${esc(codexSearch)}">
      <div id="cdet"></div>
      <div class="clist">${list.slice(0, 300).map(k => { const r = ENG.rec(k); return `<button class="crow" data-k="${k}" style="--lc:${MAINC(k[0])}"><span class="t">${esc(r.name)}</span><span class="cls">${r.cls}</span><span class="rar r${r.rarity}">${RARITY[r.rarity]}</span></button>`; }).join('') || '<p class="sub">Nothing here yet. Compose new merges in battle, watch your opponents, or experiment at the Forge.</p>'}</div>
      ${list.length > 300 ? `<p class="fine">Showing 300 of ${list.length}. Filter to narrow it down.</p>` : ''}`;
    body.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { codexFilter = b.dataset.f; renderSheet(); });
    const inp = body.querySelector('.search');
    inp.oninput = () => { codexSearch = inp.value; const pos = inp.selectionStart; renderSheet(); const i2 = $('sheetBody').querySelector('.search'); i2.focus(); i2.setSelectionRange(pos, pos); };
    body.querySelectorAll('[data-k]').forEach(b => b.onclick = () => { const box = body.querySelector('#cdet'); box.innerHTML = mergeDetail(b.dataset.k); box.scrollIntoView({ behavior: 'smooth' }); });
  }

  function sheetForms(body) {
    const list = [...seen].sort((x, y) => E.parseKey(x).subs.length - E.parseKey(y).subs.length || (x < y ? -1 : 1));
    body.innerHTML = `<h3>Daemon forms</h3><div>Seen <b>${seen.size}</b> · Bound <b>${boundForms.size}</b> of ${M.count} possible genomes</div>
      <div class="progress"><i style="width:${seen.size / M.count * 100}%"></i></div>
      <p class="fine">Every merge identity is also a daemon genome. Recompiling adds a sub-essence to a genome and turns the daemon into a new form.</p>
      <div id="fdet"></div>
      <div class="grid-sprites">${list.map(k => `<button class="gs ${boundForms.has(k) ? 'bound' : ''}" data-k="${k}"><canvas data-sprite="${k}" width="64" height="64"></canvas><div>${esc(ENG.rec(k).dName)}</div></button>`).join('')}</div>`;
    body.querySelectorAll('[data-k]').forEach(b => b.onclick = () => {
      const k = b.dataset.k, r = ENG.rec(k), pv = ENG.PASSIVES[r.dPassive];
      const box = body.querySelector('#fdet');
      box.innerHTML = `<div class="preview detail"><div><canvas class="big" data-sprite="${k}" width="160" height="160"></canvas></div><div><div class="pn">${esc(r.dName)}</div>${genomeHTML(k)}<p class="lore">${esc(lore(k))}</p>
        <div class="fine">Base stats: HP ${r.dStats[0]} · Logic ${r.dStats[1]} · Firewall ${r.dStats[2]} · Clock ${r.dStats[3]} · Flux ${r.dStats[4]} · Coherence ${r.dStats[5]} (total ${statTotal(k)})</div>
        <div class="fine">Passive: <b style="color:var(--ink)">${pv[0]}</b>: ${esc(pv[1])}</div></div></div>`;
      hydrateCanvases(box); box.scrollIntoView({ behavior: 'smooth' });
    });
  }

  function sheetLexicon(body) {
    const found = resonancesFound();
    const anomalies = new Set([...discovered].map(k => ENG.rec(k).anomaly).filter(Boolean));
    const chart = `<table class="chart"><tr><th>atk ↓ def →</th>${E.MAINS.map(m => `<th style="color:${MAINC(m)}">${E.MAIN[m].name}</th>`).join('')}</tr>${E.MAINS.map(a => `<tr><th style="color:${MAINC(a)}">${E.MAIN[a].name}</th>${E.MAINS.map(b => { const v = E.chart(a, b); return `<td class="${v > 1 ? 'sup' : v < 1 ? 'res' : ''}">×${v}</td>`; }).join('')}</tr>`).join('')}</table>`;
    const reactions = Object.entries(E.REACTION).map(([pid, rx]) => `<div class="lexc"><div class="hd"><b>${Object.entries(rx.names).map(([m, n]) => `<span style="color:${MAINC(m)}">${n}</span>`).join(' / ')}</b>${rx.volatile ? '<span class="st bad">volatile</span>' : ''}</div><div class="genome">${[...new Set(pid.split(''))].map(m => essChip(m)).join('')}</div><p>${esc(rx.line)}</p></div>`).join('');
    const subCard = s => { const sub = E.SUB[s]; return `<div class="lexc"><div class="hd">${essChip(s)}<span class="fine">${sub.host ? E.MAIN[sub.host].name + ' only' : 'any host'}</span></div><p>${esc(sub.desc)}</p>${!sub.host ? `<div class="facets">${E.MAINS.map(m => `<span style="color:${MAINC(m)}">on ${E.MAIN[m].name}</span><span>${E.FACET[s][m].name}: ${E.EFFECTS[E.FACET[s][m].fx]}</span>`).join('')}</div>` : ''}<p class="fine">Passive as lead sub: ${ENG.PASSIVES[s][0]}</p></div>`; };
    body.innerHTML = `<h3>Main essences</h3><p class="fine">A merge has a lead Main, a second Main (the same one makes a pure merge), and up to three sub-essences, each bound to one of the two. The lead carries more weight in the merge and in combat typing (65/35).</p>
      <div class="lex">${E.MAINS.map(m => `<div class="lexc"><div class="hd">${essChip(m)}<span class="fine">beats ${E.MAIN[E.BEATS[m]].name}</span></div><p>Passive as a lead with no subs: ${ENG.PASSIVES[m][0]}: ${esc(ENG.PASSIVES[m][1])}</p></div>`).join('')}</div>
      <h3>Type chart</h3>${chart}
      <h3>Main reactions</h3><div class="lex">${reactions}</div>
      <h3>Residue reactions</h3><p class="fine">Every merge leaves residue of its essences in the arena. A merge led by one essence landing in 2+ residue of another triggers a reaction and consumes it.</p>
      <div class="lex">${Object.entries(ENG.REACT).map(([a, o]) => Object.entries(o).map(([b, [nm, kind]]) => `<div class="lexc"><div class="hd"><b>${nm}</b></div><div class="genome">${essChip(a, 'cast')}<span class="arrow">into</span>${essChip(b, 'residue')}</div><p>${{ blast: 'Steam scalds the target for 10% of its HP.', boost: 'The merge hits 30% harder.', guard: 'Caster Firewall +1.', quench: 'Caster sheds burn and heals 10%.', blind: 'Target accuracy −1.', chill: 'Target Clock −1.', soak: 'Target is soaked.', burn: 'May burn the target.', shield: 'Caster gains a small shield.', veil: 'Caster evasion +1.' }[kind]}</p></div>`).join('')).join('')}</div>
      <h3>Sub-essences</h3><div class="lex">${E.SUB_ORDER.map(subCard).join('')}</div>
      <h3>Resonances (${E.RESONANCE.filter(r => found.has(r.name)).length}/${E.RESONANCE.length})</h3><p class="fine">Two specific sub-essences in the same merge, on any host.</p>
      <div class="lex">${E.RESONANCE.map(r => found.has(r.name) ? `<div class="lexc"><div class="hd"><b style="color:var(--warn)">${r.name}</b></div><div class="genome">${r.subs.map(s => essChip(s)).join('')}</div></div>` : '<div class="lexc"><div class="hd"><b class="fine">??? resonance</b></div><p>Undiscovered</p></div>').join('')}</div>
      <h3>Trinities (${E.TRINITY.filter(r => found.has(r.name)).length}/${E.TRINITY.length})</h3><p class="fine">Three sub-essences that align completely.</p>
      <div class="lex">${E.TRINITY.map(r => found.has(r.name) ? `<div class="lexc"><div class="hd"><b style="color:#ff5cf0">${r.name}</b></div><div class="genome">${r.subs.map(s => essChip(s)).join('')}</div></div>` : '<div class="lexc"><div class="hd"><b class="fine">??? trinity</b></div><p>Undiscovered</p></div>').join('')}</div>
      <h3>Anomalies (${anomalies.size}/${Object.keys(E.ANOMALY).length} kinds)</h3><p class="fine">About one merge in sixty is a glitch in the lattice. Nobody knows which ones until they're cast.</p>
      <div class="lex">${Object.entries(E.ANOMALY).map(([id, d]) => anomalies.has(id) ? `<div class="lexc"><div class="hd"><span class="rar r4">∆${id}</span></div><p>${esc(d)}</p></div>` : '<div class="lexc"><div class="hd"><span class="fine">∆???</span></div></div>').join('')}</div>`;
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
    const r = ENG.rec(k);
    const fx = code => r.fx.find(f => f.code === code);
    switch (r.cls) {
      case 'Mend': return { id: 'patch:' + k, kind: 'patch', name: r.name + ' Patch', mag: (fx('heal') || { mag: 25 }).mag, cleanse: !!fx('cleanse') };
      case 'Ward': return { id: 'ward:' + k, kind: 'ward', name: r.name + ' Module', mag: (fx('shield') || { mag: 20 }).mag };
      case 'Hex': { const best = Math.max(0, ...r.fx.filter(f => !E.SELF_FX.has(f.code)).map(f => f.chance)); return { id: 'lattice:' + k, kind: 'lattice', name: r.name + ' Lattice', power: +(1 + 0.15 * r.rarity + best / 250).toFixed(2), main: r.a }; }
      case 'Field': return { id: 'catalyst:' + k, kind: 'catalyst', name: r.name + ' Catalyst', main: r.a };
      default: return r.subs.length ? { id: 'script:' + k, kind: 'script', name: r.name + ' Script', subs: [...new Set(r.subs.map(t => t.s))] } : { id: 'cell:' + k, kind: 'cell', name: r.name + ' Flux Cell' };
    }
  }
  function sheetForge(body) {
    const have = S.motes;
    const subs = E.SUB_ORDER.filter(s => (have[s] || 0) > 0);
    const mains = E.MAINS.filter(m => (have[m] || 0) > 0);
    body.innerHTML = `<h3>Nexus Forge</h3><p class="fine">Merge motes into items. The merge's class decides what you get: Mend → Patch, Ward → Module, Hex → Lattice, Field → Catalyst, other merges with subs → Attune Script, and plain merges → Flux Cell. Forging also records the merge in your Codex.</p>
      <div class="motes">${Object.entries(have).filter(([, n]) => n > 0).map(([k, n]) => essChip(k, '×' + n)).join('') || '<span class="fine">You have no motes. Defeat daemons to collect them.</span>'}</div>
      <div id="fcmp"></div>`;
    if (!mains.length) return;
    composer(body.querySelector('#fcmp'), {
      mains, subs, width: 3, counts: have, forge: true,
      extra: k => { const c = forgeCost(k); const it = forgeItem(k); const ok = Object.entries(c).every(([x, n]) => (have[x] || 0) >= n);
        return `<div class="preview"><div class="fine">Cost: ${Object.entries(c).map(([x, n]) => essChip(x, `${n}/${have[x] || 0}`)).join(' ')}</div><div style="margin-top:4px">Produces: <b>${discovered.has(k) ? esc(it.name) : `a ${it.kind === 'patch' ? 'Patch' : it.kind === 'ward' ? 'Module' : it.kind === 'lattice' ? 'Lattice' : it.kind === 'catalyst' ? 'Catalyst' : it.kind === 'script' ? 'Script' : 'Flux Cell'}?`}</b>${ok ? '' : ' <span class="st bad">not enough motes</span>'}</div></div>`; },
      actions: [{ label: 'Forge', pri: true, ok: k => Object.entries(forgeCost(k)).every(([x, n]) => (have[x] || 0) >= n), fn: k => {
        for (const [x, n] of Object.entries(forgeCost(k))) have[x] -= n;
        markDiscovered(k);
        const it = forgeItem(k);
        if (S.bag[it.id]) S.bag[it.id].count++; else S.bag[it.id] = Object.assign({ count: 1 }, it);
        beep(440, 0.1, 'triangle'); setTimeout(() => beep(660, 0.12, 'triangle'), 90);
        toast(`Forged <b>${esc(it.name)}</b>.`);
        save(); renderSheet();
      } }],
    });
  }

  function sheetSystem(body) {
    const mins = Math.round((Date.now() - S.started) / 60000);
    body.innerHTML = `<h3>Progress</h3><div class="kv" style="grid-template-columns:auto 1fr"><span class="lab">Warden keys</span><b>${S.keys.join(', ') || 'none'}</b><span class="lab">Merges discovered</span><b>${discovered.size} / ${M.count}</b><span class="lab">Forms seen / bound</span><b>${seen.size} / ${boundForms.size}</b><span class="lab">Operators beaten</span><b>${S.beaten.length} / ${C.OPERATORS.length}</b><span class="lab">Steps</span><b>${S.steps}</b><span class="lab">Session age</span><b>${mins} min</b></div>
      <h3>System</h3><div class="btnrow"><button class="btn pri" data-save>Save now</button><button class="btn" data-mute>${muted ? 'Unmute' : 'Mute'} sound</button><button class="btn" data-wipe>Delete save…</button></div>
      <h3>About</h3><p class="fine">Essence Protocol v${M.version}. All ${M.count} merge outcomes were generated ahead of time by tools/bake.js from the rules in js/essences.js. Nothing is rolled when you compose a merge; the only randomness is in battle (accuracy, effect chances, instability).</p>`;
    body.querySelector('[data-save]').onclick = () => { save(); toast('Saved.'); };
    body.querySelector('[data-mute]').onclick = () => { muted = !muted; try { localStorage.setItem('ep-muted', muted ? '1' : '0'); } catch (e) { /* ignore */ } renderSheet(); };
    body.querySelector('[data-wipe]').onclick = async () => { if (await ask('Delete save?', 'Your progress is erased and the game returns to the title screen. This can\'t be undone.', { ok: 'Delete save' })) { try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ } location.reload(); } };
  }

  // ------------------------------------------------------------------ ending
  function showEnding() {
    $('hud').classList.add('hidden'); setPad(false);
    const card = modal(`<h2>The lattice is yours</h2><p>The Architect is beaten and all four keys are turned. But the lattice still holds ${M.count - discovered.size} merges nobody has cast.</p>
      <div class="kv" style="grid-template-columns:auto 1fr"><span class="lab">Merges discovered</span><b>${discovered.size} / ${M.count}</b><span class="lab">Forms seen</span><b>${seen.size}</b><span class="lab">Forms bound</span><b>${boundForms.size}</b><span class="lab">Resonances</span><b>${resonancesFound().size}</b></div>
      <div class="btnrow" style="margin-top:12px"><button class="btn pri" data-go>Keep exploring</button></div>`);
    card.querySelector('[data-go]').onclick = () => { closeModal(); B = null; bctx = null; $('hud').classList.remove('hidden'); mode = 'world'; setPad(true); updateHud(); };
  }

  // ------------------------------------------------------------------ title & starter
  function titleArt() {
    const c = $('titleArt'), g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    const keys = ['FA-Em1Pl1As1', 'WW-Ti1Fr1Mi1', 'EE-St1Me1Ro1', 'AA-Sp1Ga1Ec1'];
    keys.forEach((k, i) => { g.drawImage(SP.get(k), 8 + i * 78, 16, 80, 80); });
  }
  function showStarter() {
    mode = 'starter';
    $('title').classList.add('hidden'); $('starter').classList.remove('hidden');
    $('starterList').innerHTML = C.STARTERS.map((s, i) => { const r = ENG.rec(s.key); return `<button class="starter" data-i="${i}"><canvas data-sprite="${s.key}" width="96" height="96"></canvas><div><h3>${esc(r.dName)}</h3>${genomeHTML(s.key)}<p>${esc(s.blurb)}</p><p>Starts attuned to ${E.SUB[s.attune[0]].name}. Passive: ${ENG.PASSIVES[r.dPassive][0]}.</p></div></button>`; }).join('');
    hydrateCanvases($('starterList'));
    $('starterList').querySelectorAll('[data-i]').forEach(b => b.onclick = async () => {
      const st = C.STARTERS[+b.dataset.i];
      adopt(newState(st));
      for (const k of S.party[0].memory) if (k) discovered.add(k);
      $('starter').classList.add('hidden');
      enterWorld();
      mode = 'busy';
      await say('Archivist Lo', [`${ENG.rec(st.key).dName}, a fine first daemon. It already knows its basic merges.`, 'Walk into static (the flickering tiles) to find wild daemons. Weaken them, then cast a Lattice from your Bag to bind them.', 'Head west to the Cirrus Array when you\'re ready. Its Warden holds the first key. Talk to me again any time.']);
      mode = 'world'; setPad(true); save();
    });
  }
  function enterWorld() {
    $('title').classList.add('hidden'); $('starter').classList.add('hidden');
    $('hud').classList.remove('hidden');
    for (const n of npcs) { const o = map.npcs.find(x => x.id === n.id); n.x = o.x; n.y = o.y; }
    mode = 'world'; setPad(true); updateHud();
  }

  // boot
  try { muted = localStorage.getItem('ep-muted') === '1'; } catch (e) { /* ignore */ }
  $('bakeInfo').textContent = `${M.count.toLocaleString()} merges pre-baked · 4 main essences · 16 sub-essences · ${E.RESONANCE.length} resonances · ${E.TRINITY.length} trinities`;
  titleArt();
  const existing = loadSave();
  if (existing) $('contBtn').classList.remove('hidden');
  $('newBtn').onclick = async () => { if (existing && !(await ask('Start a new game?', 'Your current save is overwritten the next time the game saves.', { ok: 'Start over' }))) return; showStarter(); };
  $('contBtn').onclick = () => { adopt(existing); enterWorld(); if (S.won) toast('Welcome back, Architect-breaker.'); };
  requestAnimationFrame(frame);

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});

  // expose for debugging / tests
  window.EP = { get state() { return S; }, get battle() { return B; }, get mode() { return mode; }, get discovered() { return discovered; }, forgeItem,
    teleport(x, y, dir) { player.x = player.px = follower.x = follower.px = x; player.y = player.py = follower.y = follower.py = y; if (dir) player.dir = dir; updateHud(); } };
})();
