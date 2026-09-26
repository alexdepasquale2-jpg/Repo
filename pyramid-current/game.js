/* Pyramid Current — a 2.5D (isometric) mobile action game.
 * Plain canvas + DOM HUD, no dependencies. World units are tiles; iso() maps
 * a tile position (plus height z in px) to screen pixels before camera/zoom. */
'use strict';
(() => {
  const TW = 64, TH = 32, N = 36, WALL = 90;
  const $ = (id) => document.getElementById(id);
  const cv = $('game');
  let ctx = cv.getContext('2d');
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const iso = (x, y, z = 0) => ({ x: (x - y) * TW / 2, y: (x + y) * TH / 2 - z });
  const rand = (a, b) => a + Math.random() * (b - a);
  function mulberry(seed) {
    return () => {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- World layout (inferred from the source photos) ----------
  const PYRS = [
    { x: 8, y: 7, s: 3.2, h: 140, coils: [0, 1] },
    { x: 18, y: 6.5, s: 4.2, h: 190, coils: [2, 3] },
    { x: 28, y: 8, s: 3.2, h: 140, coils: [4, 5] },
  ];
  const COIL_POS = [[5.5, 13], [10.5, 13], [15.5, 13.5], [20.5, 13.5], [25.5, 14.5], [30.5, 14.5]];
  const CORE = { x: 26, y: 27, s: 1.4, h: 66 };
  const TREE = { x: 8, y: 26 };
  const PAINTER = { x: 10.6, y: 27.4 };
  const BUS_Y = 20.5;

  const treeImg = new Image();
  treeImg.src = 'assets/tree.png';

  // ---------- Canvas sizing ----------
  let W = 0, H = 0, DPR = 1, ZOOM = 1;
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    ZOOM = clamp(Math.min(W, H * 0.75) / 430, 0.8, 1.5);
  }
  window.addEventListener('resize', resize);
  resize();

  // ---------- Pre-rendered ground diorama ----------
  const PAD = 20;
  const ground = document.createElement('canvas');
  ground.width = N * TW + PAD * 2;
  ground.height = N * TH + WALL + PAD * 2;
  const GOX = N * TW / 2 + PAD, GOY = PAD;
  (function buildGround() {
    const g = ground.getContext('2d');
    const r = mulberry(7);
    const P = (x, y, z = 0) => { const p = iso(x, y, z); return { x: p.x + GOX, y: p.y + GOY }; };
    const poly = (pts, fill, stroke) => {
      g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.closePath();
      if (fill) { g.fillStyle = fill; g.fill(); }
      if (stroke) { g.strokeStyle = stroke; g.stroke(); }
    };
    // cutaway earth walls (the cross-section look of the pyramid diagram)
    const down = (p) => ({ x: p.x, y: p.y + WALL });
    const lw = [P(0, N), P(N, N), down(P(N, N)), down(P(0, N))];
    const lg = g.createLinearGradient(0, P(0, N).y, 0, P(0, N).y + WALL + N * TH / 2);
    lg.addColorStop(0, '#8a5a2c'); lg.addColorStop(1, '#4a2c12');
    poly(lw, lg);
    const rw = [P(N, 0), P(N, N), down(P(N, N)), down(P(N, 0))];
    const rg = g.createLinearGradient(0, P(N, 0).y, 0, P(N, N).y + WALL);
    rg.addColorStop(0, '#6a4220'); rg.addColorStop(1, '#351f0c');
    poly(rw, rg);
    // strata lines
    g.lineWidth = 1;
    for (let k = 1; k < 5; k++) {
      const off = (WALL * k) / 5 + r() * 6;
      g.strokeStyle = 'rgba(30,16,6,.35)';
      g.beginPath(); g.moveTo(P(0, N).x, P(0, N).y + off); g.lineTo(P(N, N).x, P(N, N).y + off); g.lineTo(P(N, 0).x, P(N, 0).y + off); g.stroke();
    }
    // buried coil shafts visible in the cutaway
    for (let k = 0; k < 5; k++) {
      const t = 0.12 + k * 0.19, top = P(t * N, N);
      g.fillStyle = '#3d2410'; g.fillRect(top.x - 6, top.y + 4, 12, WALL - 18);
      g.strokeStyle = '#c9974f'; g.lineWidth = 2;
      for (let j = 0; j < 4; j++) { g.beginPath(); g.ellipse(top.x, top.y + 18 + j * 15, 9, 3.5, -0.3, 0, Math.PI); g.stroke(); }
    }
    for (let i = 0; i < 900; i++) {
      const onLeft = r() < 0.55, t = r();
      const top = onLeft ? P(t * N, N) : P(N, t * N);
      g.fillStyle = `rgba(${r() < 0.5 ? '20,10,4' : '200,150,90'},${0.15 + r() * 0.25})`;
      g.fillRect(top.x, top.y + r() * WALL, 1.5, 1.5);
    }
    // tiles
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const dune = Math.sin(x * 0.45 + y * 0.2) * 0.5 + Math.sin(y * 0.37 - x * 0.12) * 0.5;
        let cr = 222 + dune * 14 + r() * 8, cg = 186 + dune * 12 + r() * 8, cb = 124 + dune * 8 + r() * 6;
        const dTree = Math.hypot(x + 0.5 - TREE.x, y + 0.5 - TREE.y);
        if (dTree < 4.2) {
          const k = clamp((4.2 - dTree) / 1.6, 0, 1);
          cr = lerp(cr, 118 + r() * 14, k); cg = lerp(cg, 150 + r() * 16, k); cb = lerp(cb, 70 + r() * 10, k);
        }
        const plaza = Math.max(Math.abs(x + 0.5 - CORE.x), Math.abs(y + 0.5 - CORE.y)) < 3;
        if (plaza) { cr = 186 + r() * 10; cg = 158 + r() * 10; cb = 112 + r() * 8; }
        poly([P(x, y), P(x + 1, y), P(x + 1, y + 1), P(x, y + 1)],
          `rgb(${cr | 0},${cg | 0},${cb | 0})`, plaza ? 'rgba(80,50,20,.45)' : 'rgba(110,70,30,.10)');
      }
    }
    // sand speckle + ripples
    for (let i = 0; i < 5000; i++) {
      const p = P(r() * N, r() * N);
      g.fillStyle = r() < 0.7 ? `rgba(90,55,20,${0.1 + r() * 0.2})` : `rgba(255,240,200,${0.2 + r() * 0.2})`;
      g.fillRect(p.x, p.y, 1.4, 1.4);
    }
    g.strokeStyle = 'rgba(120,80,35,.18)'; g.lineWidth = 1.2;
    for (let i = 0; i < 70; i++) {
      const x = r() * N, y = r() * N;
      if (Math.hypot(x - TREE.x, y - TREE.y) < 5) continue;
      const a = P(x, y), b = P(x + 1.2, y - 0.2);
      g.beginPath(); g.moveTo(a.x, a.y); g.quadraticCurveTo((a.x + b.x) / 2, a.y - 4, b.x, b.y); g.stroke();
    }
    // rim highlight on the diorama edge
    g.strokeStyle = '#f2dcaa'; g.lineWidth = 2;
    g.beginPath(); const e1 = P(0, N), e2 = P(N, N), e3 = P(N, 0);
    g.moveTo(e1.x, e1.y); g.lineTo(e2.x, e2.y); g.lineTo(e3.x, e3.y); g.stroke();
  })();

  // ---------- Audio ----------
  let actx = null, muted = false;
  function sfx(kind) {
    if (muted || !actx) return;
    const t = actx.currentTime, o = actx.createOscillator(), gn = actx.createGain();
    o.connect(gn); gn.connect(actx.destination);
    const set = (type, f0, f1, dur, vol) => {
      o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
      gn.gain.setValueAtTime(vol, t); gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.start(t); o.stop(t + dur + 0.02);
    };
    switch (kind) {
      case 'shot': set('triangle', 900, 1400, 0.06, 0.025); break;
      case 'hit': set('square', 220, 90, 0.08, 0.03); break;
      case 'hurt': set('sawtooth', 180, 60, 0.2, 0.08); break;
      case 'zap': set('sawtooth', 1600, 300, 0.25, 0.06); break;
      case 'echo': set('sine', 300, 80, 0.4, 0.12); break;
      case 'buff': set('triangle', 400, 1200, 0.3, 0.07); break;
      case 'coil': set('sine', 220, 880, 0.6, 0.12); break;
      case 'five': set('square', 700, 1400, 0.12, 0.06); break;
      case 'boom': set('sawtooth', 120, 30, 0.6, 0.14); break;
      case 'cuff': set('square', 1200, 500, 0.12, 0.06); break;
    }
  }

  // ---------- Campaign ----------
  // Speakers: W = the Wanderer (hero), P = the Painter, C = Warden Captain, F = the Pyre.
  const WHO = {
    W: { name: 'The Wanderer', color: '#39e6ff' },
    P: { name: 'Vasko, the Painter', color: '#ffc23d' },
    C: { name: 'Warden Captain Orlov', color: '#8fb1ff' },
    F: { name: 'The Pyre', color: '#ff7a1a' },
  };
  const CHAPTERS = [
    {
      name: 'The Sleeping Grid', blurb: 'Wake the two coils beneath the small pyramid.',
      coils: [0, 1], warden: 0, rate: 0.75, boss: false, reward: 30, abilities: 2,
      intro: [
        ['P', 'You came. Good. Keep that hat on. The sand remembers heat.'],
        ['W', 'Your postcard said you found something under the pyramids.'],
        ['P', 'Not found. Remembered. They were never tombs. They were power plants.'],
        ['P', 'Two coils under the small pyramid still hum. Stand on their pads and wake them.'],
        ['W', 'And the things made of fire walking toward us?'],
        ['P', 'Embers. The grid’s fever. Keep moving and let your blade do the talking.'],
      ],
      outro: [
        ['P', 'Look at the capstone. Blue. First time in four thousand years.'],
        ['W', 'Somebody is going to notice.'],
        ['P', 'Somebody already has. Come back tomorrow, and bring your nerve.'],
      ],
    },
    {
      name: 'Copper Veins', blurb: 'Wake four coils. The Wardens arrive.',
      coils: [0, 1, 2, 3], warden: 0.2, rate: 0.9, boss: false, reward: 50, abilities: 4,
      intro: [
        ['C', 'Attention, wanderer. This plateau is sealed by order of the Grid Authority.'],
        ['W', 'Nobody dug anything. The coils woke up on their own.'],
        ['C', 'Then they will be put back to sleep. Step away from the copper.'],
        ['P', 'Don’t argue with them. They cuff first and do the paperwork later.'],
        ['P', 'Wake four coils. If a Warden stands on a live pad, knock him off before it goes dark.'],
      ],
      outro: [
        ['W', 'Why do they care so much about a few old coils?'],
        ['P', 'Because a lit grid shows what is underneath. And what is underneath is hungry.'],
      ],
    },
    {
      name: 'Lockdown', blurb: 'Wake all six coils under heavy Warden pressure.',
      coils: [0, 1, 2, 3, 4, 5], warden: 0.34, rate: 1, boss: false, reward: 80, abilities: 5,
      intro: [
        ['C', 'Final warning. The Authority has declared the plateau under lockdown.'],
        ['P', 'Six coils, six shafts, one Core. Light them all and nobody can switch it off again.'],
        ['W', 'And when they’re all lit?'],
        ['P', 'Then we find out what the Authority has been keeping buried.'],
      ],
      outro: [
        ['C', 'You fool. The grid wasn’t asleep. It was holding something down.'],
        ['P', 'The Core is drinking the current. Something under it is waking up.'],
      ],
    },
    {
      name: 'The Pyre', blurb: 'Relight the grid and burn out the Pyre Colossus.',
      coils: [0, 1, 2, 3, 4, 5], warden: 0.14, rate: 1, boss: true, reward: 150, abilities: 6,
      intro: [
        ['F', 'FOUR THOUSAND YEARS OF COLD. AND NOW A LITTLE MAN IN A FUR HAT BRINGS ME WARMTH.'],
        ['W', 'That’s what the Wardens were guarding?'],
        ['C', 'Guarding everyone else from it. Our cuffs are useless now. Your blade isn’t.'],
        ['P', 'Light the coils again. The Core fires on the Pyre, and every live coil makes it hit harder.'],
      ],
      outro: [
        ['C', 'The plateau is clear. The Authority owes you an apology. I owe you a drink.'],
        ['P', 'Hold still. Hat tilted, just so. This one goes in a museum.'],
        ['W', 'Paint the capstones blue. That’s how they were meant to look.'],
      ],
    },
    {
      name: 'Endless Current', blurb: 'Survive as long as you can. The Pyre returns every two minutes.',
      coils: [0, 1, 2, 3, 4, 5], warden: 0.25, rate: 1.1, boss: false, endless: true, reward: 0, abilities: 6,
      intro: [
        ['P', 'The Pyre left embers in every crack of the plateau. They will keep coming.'],
        ['W', 'Then I’ll keep the lights on.'],
      ],
      outro: [],
    },
  ];
  const BEATS = {
    coil: ['P', 'That’s it! Follow the blue line. It runs to the Core.'],
    warden: ['C', 'Wanderer, you are interfering with Authority infrastructure.'],
    lowhp: ['P', 'You’re smoking. Get under the tree. It’s older than the pyramids and it still heals.'],
    token: ['P', 'Come by my easel. I owe you a high five.'],
    drained: ['C', 'Coil secured. Next.'],
    bosshalf: ['F', 'THE CURRENT… IT BURNS…'],
  };
  // Order abilities unlock in: Logic, Echo, Surge, Sanctum, Atlas, Flow.
  const UNLOCK_ORDER = [0, 2, 1, 3, 4, 5];
  const WORKSHOP = [
    { id: 'hp', name: 'Padded Coat', d: '+15 max HP', max: 5 },
    { id: 'dmg', name: 'Honed Blade', d: '+10% damage', max: 5 },
    { id: 'rate', name: 'Steady Hands', d: '+8% fire rate', max: 5 },
    { id: 'speed', name: 'Desert Boots', d: '+5% move speed', max: 4 },
    { id: 'cd', name: 'Copper Focus', d: '−5% ability cooldowns', max: 4 },
    { id: 'token', name: 'Old Friends', d: 'Start with +1 high-five token', max: 2 },
  ];
  const upCost = (lvl) => 25 + lvl * 20;
  const SAVE_KEY = 'pyramid-current-save-v1';
  let save = { sparks: 0, cleared: 0, best: 0, up: {} };
  try { const raw = localStorage.getItem(SAVE_KEY); if (raw) save = Object.assign(save, JSON.parse(raw)); } catch (_) {}
  save.up = save.up || {};
  const persist = () => { try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch (_) {} };
  const lvl = (id) => save.up[id] || 0;
  let chapter = 0;
  const CH = () => CHAPTERS[chapter];
  const abilityLocked = (i) => UNLOCK_ORDER.indexOf(i) >= CH().abilities;

  // ---------- Game state ----------
  let S = null, hero = null, coils = [], enemies = [], shots = [], fx = [], parts = [];
  let running = false, cam = { x: 0, y: 0 };
  const cds = [0, 0, 0, 0, 0, 0];

  function newGame() {
    S = {
      t: 0, phase: 'coils', kills: 0, killsTok: 0, tokens: 0, spawnT: 4, awakenT: 0, boss: null,
      flowT: 0, linkT: 0, linkTick: 0, sanctum: null, shake: 0, coreBeamT: 1.5, hurtFlash: 0,
      over: false, paused: false, modal: false, hintT: 6, hfT: 0, nid: 1, beats: new Set(), comms: null, nextBossT: 120, sparksRun: 0,
    };
    hero = {
      x: 18, y: 20, r: 0.32, hp: 100, maxHp: 100, speed: 3.3, dmg: 12, fireRate: 2.2, fireCd: 0.5,
      range: 5.5, face: 1, walk: 0, moving: false, stun: 0, inv: 0, surgeT: 0,
      cdMul: 1, echoMul: 1, chain: 4, sanctumDur: 4, dmgMul: 1,
    };
    coils = COIL_POS.map((p, i) => ({
      x: p[0], y: p[1], i, active: false, ever: false, prog: 0, drain: 0, drained: false,
      path: [[p[0], p[1]], [p[0], BUS_Y], [CORE.x, BUS_Y], [CORE.x, CORE.y - CORE.s]],
    }));
    enemies = []; shots = []; fx = []; parts = [];
    cds.fill(0);
    // permanent Workshop upgrades
    hero.maxHp = hero.hp = 100 + 15 * lvl('hp');
    hero.dmgMul = 1 + 0.1 * lvl('dmg');
    hero.fireRate *= 1 + 0.08 * lvl('rate');
    hero.speed *= 1 + 0.05 * lvl('speed');
    hero.cdMul = 1 - 0.05 * lvl('cd');
    S.tokens = lvl('token');
    const req = CH().coils;
    coils.forEach((c) => { c.locked = !req.includes(c.i); });
    const c = iso(hero.x, hero.y); cam.x = c.x; cam.y = c.y;
  }

  const activeCount = () => coils.reduce((n, c) => n + (c.active ? 1 : 0), 0);
  const reqCount = () => CH().coils.length;
  function beat(key) {
    if (!S || S.beats.has(key)) return;
    S.beats.add(key);
    const [who, text] = BEATS[key];
    S.comms = { who, text, t: 4.5 };
  }

  // ---------- Collision ----------
  function pushBox(o, cx, cy, half, r) {
    const dx = o.x - cx, dy = o.y - cy, hw = half + r;
    if (Math.abs(dx) < hw && Math.abs(dy) < hw) {
      if (hw - Math.abs(dx) < hw - Math.abs(dy)) o.x = cx + Math.sign(dx || 1) * hw;
      else o.y = cy + Math.sign(dy || 1) * hw;
    }
  }
  function collide(o, r) {
    for (const p of PYRS) pushBox(o, p.x, p.y, p.s, r);
    pushBox(o, CORE.x, CORE.y, CORE.s, r);
    const dt = Math.hypot(o.x - TREE.x, o.y - TREE.y), tr = 0.45 + r;
    if (dt < tr && dt > 0) { o.x = TREE.x + (o.x - TREE.x) / dt * tr; o.y = TREE.y + (o.y - TREE.y) / dt * tr; }
    o.x = clamp(o.x, 0.5, N - 0.5); o.y = clamp(o.y, 0.5, N - 0.5);
  }

  // ---------- Enemies ----------
  const EDEF = {
    ember: { hp: 32, speed: 1.7, r: 0.34, dmg: 9, zc: 22 },
    warden: { hp: 80, speed: 1.25, r: 0.36, dmg: 12, zc: 24 },
    boss: { hp: 1500, speed: 0.8, r: 1.0, dmg: 22, zc: 64 },
  };
  function spawnEnemy(type, x, y) {
    const d = EDEF[type], scale = type === 'boss' ? 1 : 1 + S.t / 240;
    const e = {
      id: S.nid++, type, x, y, r: d.r, hp: d.hp * scale, maxHp: d.hp * scale, speed: d.speed, dmg: d.dmg, zc: d.zc,
      atk: 0.5, flash: 0, kx: 0, ky: 0, face: 1, walk: Math.random() * 6, rise: type === 'boss' ? 1 : 0.35,
      shootT: 3, sumT: 6,
    };
    collide(e, e.r);
    enemies.push(e);
    return e;
  }
  function edgeSpawn(type) {
    for (let k = 0; k < 14; k++) {
      const side = Math.floor(Math.random() * 4), t = rand(1, N - 1);
      const x = side === 0 ? 1 : side === 1 ? N - 1 : t, y = side === 2 ? 1 : side === 3 ? N - 1 : t;
      if (Math.hypot(x - hero.x, y - hero.y) > 9) return spawnEnemy(type, x, y);
    }
    return null;
  }
  function nearestEnemy(x, y, maxD, skip) {
    let best = null, bd = maxD;
    for (const e of enemies) {
      if (e.hp <= 0 || (skip && skip.has(e))) continue;
      const d = Math.hypot(e.x - x, e.y - y) - e.r * 0.5;
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }
  function addText(x, y, z, str, color, size = 13) {
    fx.push({ k: 'text', x, y, z, str, color, size, life: 0.8, max: 0.8 });
  }
  function burst(x, y, z, color, n, spd = 2, size = 3) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, v = rand(0.3, 1) * spd;
      parts.push({ x, y, z, vx: Math.cos(a) * v, vy: Math.sin(a) * v, vz: rand(20, 90), life: rand(0.4, 0.9), max: 0.9, color, size });
    }
  }
  function damage(e, amt, color) {
    if (e.hp <= 0) return;
    e.hp -= amt; e.flash = 0.1;
    if (color) addText(e.x, e.y, e.zc + 18, Math.round(amt), color);
    if (e.hp <= 0) kill(e);
  }
  function kill(e) {
    S.kills++; S.killsTok++;
    burst(e.x, e.y, e.zc, e.type === 'warden' ? '#6f8cff' : '#ff8a2a', e.type === 'boss' ? 80 : 14, e.type === 'boss' ? 5 : 2.2);
    if (e.type === 'boss') {
      S.boss = null; S.shake = 1.2; sfx('boom');
      if (CH().endless) { S.nextBossT = 120; S.sparksRun += 40; toast('The Pyre falls again · +40 sparks', 2); }
      else { setTimeout(() => endGame(true), 1400); S.phase = 'won'; }
    } else sfx('hit');
    if (S.killsTok >= 25) { S.killsTok -= 25; giveToken('25 takedowns'); }
  }
  function giveToken(why) {
    S.tokens++;
    toast(`✋ High-five token (${why}) — visit the Painter`);
    beat('token');
  }

  // ---------- Hero ----------
  const inSanctum = (o) => S.sanctum && Math.hypot(o.x - S.sanctum.x, o.y - S.sanctum.y) < S.sanctum.r;
  function hurt(amt) {
    if (S.over || hero.inv > 0 || inSanctum(hero)) return;
    hero.hp -= amt; hero.inv = 0.4; S.shake = Math.max(S.shake, 0.35); S.hurtFlash = 0.35;
    addText(hero.x, hero.y, 60, '-' + Math.round(amt), '#ff5a4a', 14);
    sfx('hurt');
    if (hero.hp <= 0) { hero.hp = 0; endGame(false); }
    else if (hero.hp < hero.maxHp * 0.35) beat('lowhp');
  }

  // ---------- Abilities ----------
  const ABIL = [
    { name: 'Logic Cascade', cd: 5, color: '#39e6ff', cast() {
      let t = nearestEnemy(hero.x, hero.y, 6.5);
      if (!t) return 'No target in range';
      const pts = [{ x: hero.x, y: hero.y, z: 26 }], hit = new Set();
      let dmg = 48 * hero.dmgMul;
      for (let j = 0; j <= hero.chain && t; j++) {
        hit.add(t); pts.push({ x: t.x, y: t.y, z: t.zc });
        damage(t, dmg, '#9ff4ff'); dmg *= 0.85;
        t = nearestEnemy(t.x, t.y, 3.4, hit);
      }
      fx.push({ k: 'bolt', pts, life: 0.35, max: 0.35, color: '#39e6ff' });
      sfx('zap');
    } },
    { name: 'Dopamine Surge', cd: 14, color: '#3dffb5', cast() {
      hero.surgeT = 5; hero.hp = Math.min(hero.maxHp, hero.hp + 20);
      addText(hero.x, hero.y, 64, '+20', '#3dffb5', 15);
      burst(hero.x, hero.y, 30, '#3dffb5', 24, 2.5);
      sfx('buff');
    } },
    { name: 'Echo Verse', cd: 7, color: '#b36bff', cast() {
      const R = 3.5 * hero.echoMul;
      fx.push({ k: 'ring', x: hero.x, y: hero.y, r: R, life: 0.5, max: 0.5, color: '#b36bff' });
      for (const e of enemies) {
        const d = Math.hypot(e.x - hero.x, e.y - hero.y);
        if (d < R + e.r) {
          const k = e.type === 'boss' ? 0.15 : 1, nx = (e.x - hero.x) / (d || 1), ny = (e.y - hero.y) / (d || 1);
          e.kx += nx * 7 * k; e.ky += ny * 7 * k;
          damage(e, 32 * hero.dmgMul * hero.echoMul, '#d7b3ff');
        }
      }
      S.shake = Math.max(S.shake, 0.2); sfx('echo');
    } },
    { name: 'Network Sanctum', cd: 16, color: '#ffc23d', cast() {
      S.sanctum = { x: hero.x, y: hero.y, r: 2.6, t: hero.sanctumDur, max: hero.sanctumDur };
      sfx('buff');
    } },
    { name: 'Atlas Core Link', cd: 18, color: '#4da6ff', cast() {
      if (!activeCount()) return 'Wake a coil first — Atlas links through them';
      S.linkT = 6; S.linkTick = 0; sfx('coil');
    } },
    { name: 'Cognitive Flow', cd: 22, color: '#5fffe0', cast() {
      S.flowT = 5;
      for (let i = 0; i < 6; i++) if (i !== 5) cds[i] *= 0.5;
      sfx('buff');
    } },
  ];
  function useAbility(i) {
    if (!running || S.paused || S.modal || S.over || cds[i] > 0 || hero.stun > 0) return;
    if (abilityLocked(i)) { toast(`${ABIL[i].name} unlocks in a later chapter`, 1.4); return; }
    const fail = ABIL[i].cast();
    if (fail) { toast(fail, 1.2); return; }
    cds[i] = ABIL[i].cd * hero.cdMul;
    abBtns[i].dataset.wasCd = '1';
  }

  // ---------- Upgrades (the Painter) ----------
  const UPGRADES = [
    { ic: '🗡️', name: 'Sharper Shards', d: 'Shots and abilities +30% damage', f: () => { hero.dmgMul *= 1.3; } },
    { ic: '🧥', name: 'Thicker Coat', d: '+25 max HP and a full heal', f: () => { hero.maxHp += 25; hero.hp = hero.maxHp; } },
    { ic: '🤲', name: 'Quick Hands', d: 'Auto-fire rate +25%', f: () => { hero.fireRate *= 1.25; } },
    { ic: '👟', name: 'Fleet Boots', d: 'Move speed +12%', f: () => { hero.speed *= 1.12; } },
    { ic: '⏱️', name: 'Overclock', d: 'Ability cooldowns −15%', f: () => { hero.cdMul *= 0.85; } },
    { ic: '🎵', name: 'Wide Echo', d: 'Echo Verse radius and power +30%', f: () => { hero.echoMul *= 1.3; } },
    { ic: '⛓️', name: 'Long Cascade', d: 'Logic Cascade jumps 2 more times', f: () => { hero.chain += 2; } },
    { ic: '⚖️', name: 'Deep Sanctum', d: 'Network Sanctum lasts 1.5s longer', f: () => { hero.sanctumDur += 1.5; } },
    { ic: '🎯', name: 'Long Sight', d: 'Auto-fire range +1.5 tiles', f: () => { hero.range += 1.5; } },
  ];
  function highFive() {
    if (S.tokens <= 0 || S.modal) return;
    S.tokens--; S.hfT = 0.6; sfx('five');
    addText(PAINTER.x, PAINTER.y, 80, 'HIGH FIVE!', '#ffdf8a', 18);
    burst((hero.x + PAINTER.x) / 2, (hero.y + PAINTER.y) / 2, 50, '#ffc23d', 20, 2);
    setTimeout(openUpgrade, 350);
  }
  function openUpgrade() {
    S.modal = true;
    const pool = UPGRADES.slice().sort(() => Math.random() - 0.5).slice(0, 3);
    const box = $('cards'); box.innerHTML = '';
    for (const u of pool) {
      const b = document.createElement('button');
      b.className = 'card';
      b.innerHTML = `<span class="ic">${u.ic}</span><span><b>${u.name}</b><small>${u.d}</small></span>`;
      b.onclick = () => { u.f(); $('upgrade').classList.add('hidden'); S.modal = false; toast(u.name + '!', 1.2); };
      box.appendChild(b);
    }
    $('upgrade').classList.remove('hidden');
  }

  // ---------- Input ----------
  const keys = new Set();
  const joy = { id: null, ox: 0, oy: 0, dx: 0, dy: 0 };
  const joyEl = $('joy'), knobEl = $('knob');
  cv.addEventListener('pointerdown', (e) => {
    if (joy.id !== null) return;
    joy.id = e.pointerId; joy.ox = e.clientX; joy.oy = e.clientY; joy.dx = joy.dy = 0;
    joyEl.style.left = joy.ox + 'px'; joyEl.style.top = joy.oy + 'px'; joyEl.classList.add('on');
    knobEl.style.transform = '';
    S && (S.hintT = 0);
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener('pointermove', (e) => {
    if (e.pointerId !== joy.id) return;
    let dx = e.clientX - joy.ox, dy = e.clientY - joy.oy;
    const l = Math.hypot(dx, dy), M = 50;
    if (l > M) { dx = dx / l * M; dy = dy / l * M; }
    joy.dx = dx / M; joy.dy = dy / M;
    knobEl.style.transform = `translate(${dx}px,${dy}px)`;
  });
  const endJoy = (e) => {
    if (e.pointerId !== joy.id) return;
    joy.id = null; joy.dx = joy.dy = 0; joyEl.classList.remove('on');
  };
  cv.addEventListener('pointerup', endJoy);
  cv.addEventListener('pointercancel', endJoy);
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    keys.add(k);
    if (k >= '1' && k <= '6') useAbility(+k - 1);
    if ((k === 'e' || k === ' ') && nearPainter()) highFive();
    if (k === 'p' || k === 'escape') togglePause();
  });
  window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

  function inputVec() {
    let sx = 0, sy = 0;
    if (keys.has('a') || keys.has('arrowleft')) sx -= 1;
    if (keys.has('d') || keys.has('arrowright')) sx += 1;
    if (keys.has('w') || keys.has('arrowup')) sy -= 1;
    if (keys.has('s') || keys.has('arrowdown')) sy += 1;
    let mag = 1;
    if (!sx && !sy) { sx = joy.dx; sy = joy.dy; mag = Math.min(1, Math.hypot(sx, sy)); if (mag < 0.15) return null; }
    // screen direction -> world (iso) direction
    let wx = (sx / 32 + sy / 16) / 2, wy = (sy / 16 - sx / 32) / 2;
    const l = Math.hypot(wx, wy);
    return { x: wx / l, y: wy / l, mag, sx };
  }
  const nearPainter = () => hero && Math.hypot(hero.x - PAINTER.x, hero.y - PAINTER.y) < 2;

  // ---------- Update ----------
  function update(dt) {
    S.t += dt;
    const es = S.flowT > 0 ? 0.35 : 1, edt = dt * es;
    S.flowT = Math.max(0, S.flowT - dt);
    S.shake = Math.max(0, S.shake - dt * 1.5);
    S.hurtFlash = Math.max(0, S.hurtFlash - dt);
    S.hfT = Math.max(0, S.hfT - dt);
    S.hintT = Math.max(0, S.hintT - dt);
    for (let i = 0; i < 6; i++) cds[i] = Math.max(0, cds[i] - dt);

    // hero
    hero.inv = Math.max(0, hero.inv - dt);
    hero.surgeT = Math.max(0, hero.surgeT - dt);
    hero.moving = false;
    if (hero.stun > 0) hero.stun -= dt;
    else {
      const v = inputVec();
      if (v) {
        const sp = hero.speed * (hero.surgeT > 0 ? 1.5 : 1) * v.mag;
        hero.x += v.x * sp * dt; hero.y += v.y * sp * dt;
        hero.moving = true; hero.walk += dt * 9 * v.mag;
        if (Math.abs(v.x - v.y) > 0.2) hero.face = v.x - v.y > 0 ? 1 : -1;
      }
    }
    collide(hero, hero.r);
    hero.fireCd -= dt * (hero.surgeT > 0 ? 2 : 1);
    if (hero.fireCd <= 0) {
      const t = nearestEnemy(hero.x, hero.y, hero.range);
      if (t) {
        const dx = t.x - hero.x, dy = t.y - hero.y, l = Math.hypot(dx, dy) || 1;
        shots.push({ x: hero.x, y: hero.y, vx: dx / l * 11, vy: dy / l * 11, dmg: hero.dmg * hero.dmgMul, hero: true, life: 0.8, z: 24 });
        hero.fireCd = 1 / hero.fireRate; sfx('shot');
        if (Math.abs(dx - dy) > 0.1) hero.face = dx - dy > 0 ? 1 : -1;
      } else hero.fireCd = 0.1;
    }
    // Tree of life heals
    if (Math.hypot(hero.x - TREE.x, hero.y - TREE.y) < 2.8 && hero.hp < hero.maxHp) {
      hero.hp = Math.min(hero.maxHp, hero.hp + 8 * dt);
      if (Math.random() < dt * 8) parts.push({ x: hero.x + rand(-0.3, 0.3), y: hero.y + rand(-0.3, 0.3), z: 10, vx: 0, vy: 0, vz: 40, life: 0.8, max: 0.8, color: '#9dff6a', size: 3 });
    }

    // coils
    for (const c of coils) {
      if (!c.active && !c.locked) {
        if (Math.hypot(hero.x - c.x, hero.y - c.y) < 1.0) {
          c.prog += dt / 2.2;
          if (c.prog >= 1) activateCoil(c);
        } else c.prog = Math.max(0, c.prog - dt * 0.3);
      }
      c.drained = false;
    }

    // phase flow
    if (S.phase === 'coils' && !CH().endless && activeCount() >= reqCount()) {
      if (CH().boss) {
        S.phase = 'awaken'; S.awakenT = 3.2;
        toast('All six coils live — the Core awakens…', 2.6);
        S.shake = 0.6; sfx('boom');
      } else {
        S.phase = 'won'; S.shake = 0.6; sfx('boom');
        toast('Chapter complete', 1.6);
        setTimeout(() => endGame(true), 1200);
      }
    } else if (CH().endless && !S.boss && S.phase !== 'won') {
      S.nextBossT -= dt;
      if (S.nextBossT <= 0) {
        S.boss = spawnEnemy('boss', 18, 17);
        S.boss.hp = S.boss.maxHp = 900 + S.t * 4;
        burst(18, 17, 20, '#ff6a00', 60, 4, 4);
        toast('THE PYRE RETURNS', 2); S.shake = 1; sfx('boom');
      }
    } else if (S.phase === 'awaken') {
      S.awakenT -= dt;
      if (S.awakenT <= 0) {
        S.phase = 'boss';
        S.boss = spawnEnemy('boss', 18, 17);
        burst(18, 17, 20, '#ff6a00', 60, 4, 4);
        toast('THE PYRE COLOSSUS RISES', 2.4); S.shake = 1; sfx('boom');
      }
    }

    // spawning
    S.spawnT -= edt;
    if (S.spawnT <= 0 && (S.phase === 'coils' || S.phase === 'boss')) {
      const ch = CH();
      const ac = activeCount();
      if (S.phase === 'coils') {
        if (enemies.length < 36) {
          const wc = ch.warden && ac ? ch.warden + ac * 0.03 : 0;
          const e = edgeSpawn(Math.random() < wc ? 'warden' : 'ember');
          if (e && e.type === 'warden') beat('warden');
          if (S.t > 60 && Math.random() < 0.3) edgeSpawn('ember');
        }
        S.spawnT = Math.max(0.6, 2.4 - ac * 0.24 - S.t * 0.004) / ch.rate;
      } else {
        if (enemies.length < 22) edgeSpawn(Math.random() < 0.25 ? 'warden' : 'ember');
        S.spawnT = 2.2;
      }
    }

    // enemies
    for (const e of enemies) {
      e.flash -= dt; e.atk -= edt; e.rise = Math.max(0, e.rise - dt);
      if (e.rise > 0 && e.type === 'boss') continue;
      const inS = inSanctum(e);
      if (inS) damage(e, 22 * dt * hero.dmgMul, null);
      const slow = inS ? 0.45 : 1;
      let gx = hero.x, gy = hero.y, stop = e.r + hero.r * 0.8;
      if (e.type === 'warden') {
        let tc = null, bd = 1e9;
        for (const c of coils) if (c.active) { const d = Math.hypot(c.x - e.x, c.y - e.y); if (d < bd) { bd = d; tc = c; } }
        const dh = Math.hypot(hero.x - e.x, hero.y - e.y);
        if (tc && dh > 2.2) {
          gx = tc.x; gy = tc.y; stop = 0.7;
          if (bd < 0.9) {
            tc.drain += edt; tc.drained = true; e.draining = tc;
            if (tc.drain >= 3.2) {
              tc.active = false; tc.prog = 0; tc.drain = 0;
              toast('A Warden shut down a coil!', 1.6); sfx('cuff'); beat('drained');
              if (S.phase === 'awaken') S.phase = 'coils';
            }
          } else e.draining = null;
        } else e.draining = null;
        if (dh < 1.1 && e.atk <= 0 && hero.inv <= 0 && !inSanctum(hero)) {
          hurt(e.dmg); hero.stun = 0.55; e.atk = 2.4;
          addText(hero.x, hero.y, 72, 'CUFFED', '#8fb1ff', 13); sfx('cuff');
        }
      } else if (e.type === 'boss') {
        e.shootT -= edt;
        if (e.shootT <= 0) {
          const a0 = Math.atan2(hero.y - e.y, hero.x - e.x);
          for (let k = -2; k <= 2; k++) {
            const a = a0 + k * 0.22;
            shots.push({ x: e.x, y: e.y, vx: Math.cos(a) * 5, vy: Math.sin(a) * 5, dmg: 12, hero: false, life: 3, z: 50 });
          }
          e.shootT = 2.4; sfx('boom');
        }
        e.sumT -= edt;
        if (e.sumT <= 0) {
          for (let k = 0; k < 3; k++) spawnEnemy('ember', e.x + rand(-1.5, 1.5), e.y + rand(-1.5, 1.5));
          e.sumT = 8;
        }
      }
      const dx = gx - e.x, dy = gy - e.y, l = Math.hypot(dx, dy) || 1;
      if (l > stop) {
        e.x += dx / l * e.speed * slow * edt; e.y += dy / l * e.speed * slow * edt;
        e.walk += edt * 8;
      }
      if (Math.abs(dx - dy) > 0.1) e.face = dx - dy > 0 ? 1 : -1;
      e.x += e.kx * dt; e.y += e.ky * dt; e.kx *= Math.pow(0.02, dt); e.ky *= Math.pow(0.02, dt);
      if (e.type !== 'warden' && Math.hypot(hero.x - e.x, hero.y - e.y) < e.r + hero.r + 0.1 && e.atk <= 0) {
        hurt(e.dmg); e.atk = 0.9;
      }
      if (e.type === 'ember' && Math.random() < dt * 6)
        parts.push({ x: e.x + rand(-0.15, 0.15), y: e.y + rand(-0.15, 0.15), z: 34, vx: 0, vy: 0, vz: 40, life: 0.5, max: 0.5, color: '#ffb347', size: 2 });
    }
    // separation
    for (let i = 0; i < enemies.length; i++) for (let j = i + 1; j < enemies.length; j++) {
      const a = enemies[i], b = enemies[j], dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), m = a.r + b.r;
      if (d < m && d > 0.001) {
        const p = (m - d) / 2, nx = dx / d, ny = dy / d;
        const wa = a.type === 'boss' ? 0 : 1, wb = b.type === 'boss' ? 0 : 1;
        a.x -= nx * p * wa * (wb ? 1 : 2); a.y -= ny * p * wa * (wb ? 1 : 2);
        b.x += nx * p * wb * (wa ? 1 : 2); b.y += ny * p * wb * (wa ? 1 : 2);
      }
    }
    for (const e of enemies) collide(e, e.r);
    enemies = enemies.filter((e) => e.hp > 0);
    for (const c of coils) if (!c.drained) c.drain = Math.max(0, c.drain - dt * 0.6);

    // shots
    for (const s of shots) {
      const sdt = s.hero ? dt : edt;
      s.x += s.vx * sdt; s.y += s.vy * sdt; s.life -= sdt;
      if (s.hero) {
        for (const e of enemies) {
          if (e.hp > 0 && Math.hypot(e.x - s.x, e.y - s.y) < e.r + 0.2) {
            damage(e, s.dmg, '#ffffff'); s.life = 0;
            burst(s.x, s.y, e.zc, '#9ff4ff', 4, 1.2, 2);
            break;
          }
        }
      } else {
        if (inSanctum(s)) { s.life = 0; burst(s.x, s.y, s.z, '#ffc23d', 6); }
        else if (Math.hypot(hero.x - s.x, hero.y - s.y) < 0.45) { hurt(s.dmg); s.life = 0; }
      }
      if (s.x < 0 || s.y < 0 || s.x > N || s.y > N) s.life = 0;
    }
    shots = shots.filter((s) => s.life > 0);

    // ability timers
    if (S.sanctum) { S.sanctum.t -= dt; if (S.sanctum.t <= 0) S.sanctum = null; }
    if (S.linkT > 0) {
      S.linkT -= dt; S.linkTick -= dt;
      if (S.linkTick <= 0) {
        S.linkTick = 0.5;
        for (const c of coils) if (c.active) {
          const t = nearestEnemy(c.x, c.y, 8);
          if (t) {
            damage(t, 26 * hero.dmgMul, '#a8d4ff');
            fx.push({ k: 'beam', a: { x: c.x, y: c.y, z: 72 }, b: { x: t.x, y: t.y, z: t.zc }, life: 0.25, max: 0.25, color: '#4da6ff', w: 3 });
          }
        }
      }
    }
    if (S.phase === 'boss' && S.boss && S.boss.hp > 0) {
      S.coreBeamT -= dt;
      const ac = activeCount();
      if (S.coreBeamT <= 0 && ac > 0) {
        S.coreBeamT = 1.6;
        damage(S.boss, 11 * ac, '#39e6ff');
        fx.push({ k: 'beam', a: { x: CORE.x, y: CORE.y, z: CORE.h + 30 }, b: { x: S.boss.x, y: S.boss.y, z: 60 }, life: 0.4, max: 0.4, color: '#39e6ff', w: 6 });
      }
    }

    if (S.comms) { S.comms.t -= dt; if (S.comms.t <= 0) S.comms = null; }
    if (S.boss && S.boss.hp < S.boss.maxHp / 2) beat('bosshalf');
    // effects
    for (const f of fx) { f.life -= dt; if (f.k === 'text') f.z += dt * 40; }
    fx = fx.filter((f) => f.life > 0);
    for (const p of parts) {
      p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; p.vz -= 60 * dt;
      if (p.z < 0) { p.z = 0; p.vz = 0; p.vx *= 0.5; p.vy *= 0.5; }
    }
    parts = parts.filter((p) => p.life > 0);
    if (parts.length > 500) parts.splice(0, parts.length - 500);
  }

  function activateCoil(c) {
    c.active = true; c.prog = 1; c.drain = 0;
    burst(c.x, c.y, 60, '#5ff4ff', 30, 3);
    S.shake = Math.max(S.shake, 0.3); sfx('coil');
    const n = activeCount(), m = reqCount();
    if (!c.ever) {
      c.ever = true;
      S.tokens++; S.sparksRun += 5;
      toast(`Coil ${n}/${m} online · +1 high-five token`);
      beat('coil');
    } else toast(`Coil restored · ${n}/${m}`);
    const p = PYRS.find((p) => p.coils.includes(c.i));
    if (p.coils.every((i) => coils[i].active)) setTimeout(() => toast('A pyramid capstone ignites!', 1.6), 1300);
  }

  // ---------- Drawing ----------
  function ellipse(x, y, rx, ry, fill, stroke, lw) {
    ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw || 1; ctx.stroke(); }
  }
  function polyFill(pts, fill, stroke, lw) {
    ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw || 1; ctx.stroke(); }
  }
  const shadow = (x, y, rx) => ellipse(x, y, rx, rx * 0.45, 'rgba(40,20,5,.35)');

  function drawConduits() {
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const pass of [0, 1]) {
      for (const c of coils) {
        const pts = c.path.map(([x, y]) => iso(x, y));
        if (pass === 0) {
          ctx.strokeStyle = 'rgba(70,40,15,.55)'; ctx.lineWidth = 9;
          ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.stroke();
          ctx.strokeStyle = '#2e1b0a'; ctx.lineWidth = 3;
          ctx.stroke();
        } else if (c.active) {
          ctx.globalCompositeOperation = 'lighter';
          ctx.strokeStyle = 'rgba(57,230,255,.35)'; ctx.lineWidth = 7;
          ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.stroke();
          ctx.strokeStyle = '#8ff6ff'; ctx.lineWidth = 2; ctx.stroke();
          // pulses flowing to the Core
          let len = 0; const segs = [];
          for (let i = 1; i < c.path.length; i++) {
            const a = c.path[i - 1], b = c.path[i], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
            segs.push({ a, b, l, s: len }); len += l;
          }
          for (let k = 0; k < len; k += 2.2) {
            const d = (k + S.t * 4 + c.i * 0.7) % len;
            const sg = segs.find((s) => d >= s.s && d <= s.s + s.l) || segs[segs.length - 1];
            const t = (d - sg.s) / sg.l, p = iso(lerp(sg.a[0], sg.b[0], t), lerp(sg.a[1], sg.b[1], t));
            ellipse(p.x, p.y, 3.5, 2, '#e8fdff');
          }
          ctx.globalCompositeOperation = 'source-over';
        }
      }
    }
  }

  function drawPyramid(p, alpha) {
    const A = iso(p.x - p.s, p.y + p.s), B = iso(p.x + p.s, p.y + p.s), C = iso(p.x + p.s, p.y - p.s), P = iso(p.x, p.y, p.h);
    ctx.globalAlpha = alpha;
    shadow(B.x - 10, B.y - 20, p.s * 30);
    polyFill([A, B, P], '#d2a868');
    polyFill([B, C, P], '#8f6536');
    // stone courses
    const n = Math.round(p.h / 9);
    ctx.lineWidth = 1;
    for (let k = 1; k < n; k++) {
      const t = k / n;
      const a = { x: lerp(A.x, P.x, t), y: lerp(A.y, P.y, t) }, b = { x: lerp(B.x, P.x, t), y: lerp(B.y, P.y, t) }, c = { x: lerp(C.x, P.x, t), y: lerp(C.y, P.y, t) };
      ctx.strokeStyle = 'rgba(90,55,20,.45)';
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.strokeStyle = 'rgba(40,22,8,.45)';
      ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.stroke();
      // staggered block joints
      ctx.strokeStyle = 'rgba(90,55,20,.3)';
      const nb = Math.max(1, Math.round((1 - t) * p.s * 3));
      for (let j = 0; j < nb; j++) {
        const u = (j + (k % 2 ? 0.5 : 0.25)) / nb, t2 = (k - 1) / n;
        const lo = { x: lerp(lerp(A.x, P.x, t2), lerp(B.x, P.x, t2), u), y: lerp(lerp(A.y, P.y, t2), lerp(B.y, P.y, t2), u) };
        ctx.beginPath(); ctx.moveTo(lo.x, lo.y); ctx.lineTo(lo.x + (P.x - lo.x) / (n - k + 1), lo.y + (P.y - lo.y) / (n - k + 1)); ctx.stroke();
      }
    }
    polyFill([A, B, C, P], null, '#3b2612', 1.6);
    ctx.beginPath(); ctx.moveTo(B.x, B.y); ctx.lineTo(P.x, P.y); ctx.stroke();
    // capstone ignites when both of its coils are live
    if (p.coils.every((i) => coils[i].active)) {
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(P.x, P.y + 6, 0, P.x, P.y + 6, 46);
      g.addColorStop(0, 'rgba(160,250,255,.95)'); g.addColorStop(1, 'rgba(57,230,255,0)');
      ctx.fillStyle = g; ctx.fillRect(P.x - 50, P.y - 44, 100, 100);
      const bg = ctx.createLinearGradient(0, P.y - 300, 0, P.y);
      bg.addColorStop(0, 'rgba(57,230,255,0)'); bg.addColorStop(1, 'rgba(57,230,255,.35)');
      ctx.fillStyle = bg; ctx.fillRect(P.x - 3 - Math.sin(S.t * 6), P.y - 300, 6 + Math.sin(S.t * 6) * 2, 300);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.globalAlpha = 1;
  }

  function drawCoil(c) {
    const p = iso(c.x, c.y), on = c.active, col = on ? '#5ff4ff' : c.locked ? '#7a5a36' : '#c9974f';
    ctx.save(); ctx.translate(p.x, p.y);
    ellipse(0, 0, 24, 12, '#4a2c12', '#2a1606', 1.5);
    ctx.lineWidth = 2.5; ctx.strokeStyle = col;
    for (let k = 0; k < 3; k++) { ctx.beginPath(); ctx.ellipse(0, -k * 4, 17, 8, 0, 0, Math.PI * 2); ctx.stroke(); }
    // back half of the spiral
    ctx.strokeStyle = on ? 'rgba(95,244,255,.45)' : '#6b4422'; ctx.lineWidth = 3;
    for (let k = 0; k < 4; k++) { ctx.beginPath(); ctx.ellipse(0, -22 - k * 13, 11, 4, -0.3, Math.PI, Math.PI * 2); ctx.stroke(); }
    const g = ctx.createLinearGradient(-8, 0, 8, 0);
    g.addColorStop(0, '#4d2f15'); g.addColorStop(0.45, '#9c6f3e'); g.addColorStop(1, '#3d240f');
    ctx.fillStyle = g; ctx.fillRect(-8, -78, 16, 78);
    ellipse(0, -78, 8, 4, on ? '#bff9ff' : '#b58550');
    ctx.strokeStyle = col; ctx.lineWidth = 3;
    for (let k = 0; k < 4; k++) { ctx.beginPath(); ctx.ellipse(0, -22 - k * 13, 11, 4, -0.3, 0, Math.PI); ctx.stroke(); }
    if (on) {
      ctx.globalCompositeOperation = 'lighter';
      const gl = ctx.createRadialGradient(0, -78, 0, 0, -78, 28 + Math.sin(S.t * 8) * 3);
      gl.addColorStop(0, 'rgba(160,250,255,.9)'); gl.addColorStop(1, 'rgba(57,230,255,0)');
      ctx.fillStyle = gl; ctx.fillRect(-32, -110, 64, 64);
      ctx.globalCompositeOperation = 'source-over';
      if (Math.random() < 0.25) parts.push({ x: c.x + rand(-0.2, 0.2), y: c.y + rand(-0.2, 0.2), z: 20, vx: 0, vy: 0, vz: 70, life: 0.7, max: 0.7, color: '#8ff6ff', size: 2 });
    } else if (!c.locked) {
      // floating marker so the player knows where to go
      const b = Math.sin(S.t * 3 + c.i) * 4;
      polyFill([{ x: 0, y: -104 + b }, { x: 7, y: -94 + b }, { x: 0, y: -84 + b }, { x: -7, y: -94 + b }], '#39e6ff', '#0b4452', 1.5);
    }
    ctx.lineWidth = 4;
    if (!on && c.prog > 0) {
      ctx.save(); ctx.scale(1, 0.5); ctx.strokeStyle = '#39e6ff';
      ctx.beginPath(); ctx.arc(0, 0, 32, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * c.prog); ctx.stroke(); ctx.restore();
    }
    if (on && c.drain > 0) {
      ctx.save(); ctx.scale(1, 0.5); ctx.strokeStyle = '#ff4a4a';
      ctx.beginPath(); ctx.arc(0, 0, 32, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (c.drain / 3.2)); ctx.stroke(); ctx.restore();
    }
    ctx.restore();
  }

  function drawCore() {
    const { x, y, s, h } = CORE, ac = activeCount(), ch = ac / 6;
    const T = [iso(x - s, y - s, h), iso(x + s, y - s, h), iso(x + s, y + s, h), iso(x - s, y + s, h)];
    const L = [iso(x - s, y + s), iso(x + s, y + s), T[2], T[3]];
    const R = [iso(x + s, y + s), iso(x + s, y - s), T[1], T[2]];
    const b = iso(x, y); shadow(b.x + 8, b.y + 6, 60);
    polyFill(L, '#caa065', '#3b2612', 1.5);
    polyFill(R, '#94693a', '#3b2612', 1.5);
    polyFill(T, '#e6c992', '#3b2612', 1.5);
    // circuit glyphs light up with each live coil
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = `rgba(57,230,255,${0.12 + ch * 0.8})`; ctx.lineWidth = 2;
    const f = (u, v, face) => {
      const [a, bb, , d] = face; // a->bb bottom edge, a->d up edge
      return { x: a.x + (bb.x - a.x) * u + (d.x - a.x) * v, y: a.y + (bb.y - a.y) * u + (d.y - a.y) * v };
    };
    for (const face of [L, R]) {
      const lines = [[[0.15, 0.2], [0.15, 0.55], [0.45, 0.55], [0.45, 0.8]], [[0.85, 0.15], [0.85, 0.4], [0.6, 0.4], [0.6, 0.85]], [[0.3, 0.3], [0.7, 0.3]]];
      for (const ln of lines) {
        ctx.beginPath(); ln.forEach(([u, v], i) => { const q = f(u, v, face); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); }); ctx.stroke();
      }
    }
    if (ac) {
      const c = iso(x, y, h), r = 20 + ch * 40 + Math.sin(S.t * 4) * 4;
      const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, r);
      g.addColorStop(0, `rgba(160,250,255,${0.3 + ch * 0.6})`); g.addColorStop(1, 'rgba(57,230,255,0)');
      ctx.fillStyle = g; ctx.fillRect(c.x - r, c.y - r, r * 2, r * 2);
      if (S.phase !== 'coils') {
        ctx.fillStyle = 'rgba(57,230,255,.25)'; ctx.fillRect(c.x - 5, c.y - 500, 10, 500);
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawTree() {
    const p = iso(TREE.x, TREE.y);
    shadow(p.x + 6, p.y + 2, 46);
    if (treeImg.complete && treeImg.naturalWidth) {
      const w = 180, h = w * treeImg.naturalHeight / treeImg.naturalWidth;
      ctx.drawImage(treeImg, p.x - w * 0.52, p.y - h * 0.93, w, h);
    } else {
      ctx.fillStyle = '#6b4a2a'; ctx.fillRect(p.x - 8, p.y - 80, 16, 80);
      ellipse(p.x, p.y - 110, 60, 45, '#7aa33a');
    }
    if (hero && Math.hypot(hero.x - TREE.x, hero.y - TREE.y) < 2.8) {
      ctx.globalAlpha = 0.25 + Math.sin(S.t * 4) * 0.1;
      ellipse(p.x, p.y, 2.8 * TW / 2, 2.8 * TH / 2, null, '#9dff6a', 2);
      ctx.globalAlpha = 1;
    }
  }

  // Characters are drawn around their feet at (0,0), facing +x on screen.
  function limb(x1, y1, x2, y2, w, c) {
    ctx.strokeStyle = c; ctx.lineWidth = w; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }
  function drawHero() {
    const p = iso(hero.x, hero.y), sw = hero.moving ? Math.sin(hero.walk) * 5 : 0, bob = hero.moving ? Math.abs(Math.cos(hero.walk)) * 1.6 : 0;
    const five = S.hfT > 0;
    shadow(p.x, p.y, 13);
    ctx.save(); ctx.translate(p.x, p.y - bob);
    if (hero.inv > 0 && Math.floor(S.t * 30) % 2) ctx.globalAlpha = 0.5;
    ctx.scale(hero.face, 1);
    if (hero.surgeT > 0) { ctx.globalAlpha *= 0.5; ellipse(0, -26, 16, 28, 'rgba(61,255,181,.25)'); ctx.globalAlpha = hero.inv > 0 && Math.floor(S.t * 30) % 2 ? 0.5 : 1; }
    // legs (grey denim) + sneakers
    limb(-3, -17, -3 + sw, -3, 6, '#6f7b89');
    limb(3, -17, 3 - sw, -3, 6, '#7d8997');
    ellipse(-2 + sw, -1.5, 5, 2.6, '#c9ced6', '#555', 0.8);
    ellipse(4 - sw, -1.5, 5, 2.6, '#dfe3ea', '#555', 0.8);
    // back arm
    limb(-7, -32, five ? -6 : -10 - sw * 0.4, five ? -50 : -21, 5, '#232838');
    // jacket: dark top, slate lower panel
    ctx.fillStyle = '#262b3b'; ctx.beginPath(); ctx.roundRect(-9, -37, 18, 21, 5); ctx.fill();
    ctx.fillStyle = '#556176'; ctx.beginPath(); ctx.roundRect(-9, -27, 18, 11, [0, 0, 5, 5]); ctx.fill();
    limb(0, -36, 0, -17, 1, '#9aa3b5');
    // bandolier
    limb(-8, -36, 8, -19, 4, '#6b4423');
    ctx.fillStyle = '#e0ab45';
    for (let k = 0; k < 5; k++) { const t = 0.12 + k * 0.19; ctx.save(); ctx.translate(-8 + 16 * t, -36 + 17 * t); ctx.rotate(0.8); ctx.fillRect(-1, -3.5, 2, 5); ctx.restore(); }
    // checked scarf
    ctx.fillStyle = '#9ba1a8'; ctx.beginPath(); ctx.roundRect(-7, -40, 14, 5, 2); ctx.fill();
    ctx.fillStyle = '#c1542b'; ctx.fillRect(-3, -40, 2, 5); ctx.fillRect(2, -40, 2, 5);
    // head
    ellipse(0, -46, 7, 7.5, '#d2a07a');
    ctx.fillStyle = '#35261b'; ctx.beginPath(); ctx.ellipse(0.5, -43, 7, 5.5, 0, 0, Math.PI); ctx.fill();
    ctx.fillRect(-4, -44.5, 9, 2);
    ellipse(-2, -47.5, 2.5, 2.5, 'rgba(255,255,255,.15)', '#d8b25a', 1);
    ellipse(4, -47.5, 2.5, 2.5, 'rgba(255,255,255,.15)', '#d8b25a', 1);
    ellipse(-2, -47.5, 0.9, 0.9, '#221');
    ellipse(4, -47.5, 0.9, 0.9, '#221');
    // ushanka
    ellipse(-7.5, -46, 3.8, 6.5, '#7d5029');
    ellipse(7.5, -46, 3.8, 6.5, '#8b5a2e');
    ellipse(0, -55, 10.5, 7, '#8b5a2e');
    ctx.fillStyle = '#a8703b'; ctx.beginPath(); ctx.roundRect(-10.5, -55, 21, 5.5, 3); ctx.fill();
    ctx.strokeStyle = 'rgba(60,35,15,.6)'; ctx.lineWidth = 0.8;
    for (let k = -8; k <= 8; k += 3) { ctx.beginPath(); ctx.moveTo(k, -61 + Math.abs(k) * 0.3); ctx.lineTo(k + 1, -57); ctx.stroke(); }
    // front arm + glowing card-blade
    const ax = five ? 6 : 11 + sw * 0.4, ay = five ? -54 : -22;
    limb(7, -32, ax, ay, 5, '#2c3244');
    ellipse(ax, ay, 2.6, 2.6, '#d2a07a');
    if (!five) {
      ctx.globalCompositeOperation = 'lighter';
      polyFill([{ x: ax + 1, y: ay - 2 }, { x: ax + 11, y: ay - 6 }, { x: ax + 13, y: ay - 1 }, { x: ax + 3, y: ay + 3 }], 'rgba(57,230,255,.85)', '#bff9ff', 1);
      ctx.globalCompositeOperation = 'source-over';
    }
    if (hero.stun > 0) {
      ctx.strokeStyle = '#c9d4e6'; ctx.lineWidth = 2;
      ellipse(-4, -70, 4, 3, null, '#c9d4e6', 2); ellipse(4, -70, 4, 3, null, '#c9d4e6', 2);
    }
    ctx.restore();
  }

  function drawEmber(e, scale) {
    const p = iso(e.x, e.y), t = S.t * 10 + e.id, sw = Math.sin(e.walk) * 4;
    shadow(p.x, p.y, 12 * scale);
    ctx.save(); ctx.translate(p.x, p.y); ctx.scale(e.face * scale, scale);
    if (e.rise > 0) { ctx.globalAlpha = 1 - e.rise; ctx.translate(0, e.rise * 30); }
    const hot = e.flash > 0;
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(0, -24, 2, 0, -24, 26);
    g.addColorStop(0, 'rgba(255,170,60,.55)'); g.addColorStop(1, 'rgba(255,90,0,0)');
    ctx.fillStyle = g; ctx.fillRect(-26, -52, 52, 52);
    ctx.globalCompositeOperation = 'source-over';
    limb(-3, -16, -4 + sw, -2, 5, '#c2410c');
    limb(3, -16, 4 - sw, -2, 5, '#d9530f');
    limb(-6, -30, -12 - sw * 0.5, -18, 4.5, '#d9530f');
    limb(6, -30, 12 + sw * 0.5, -18, 4.5, '#ea6a12');
    const bg = ctx.createLinearGradient(0, -40, 0, -12);
    bg.addColorStop(0, hot ? '#ffffff' : '#ffd36b'); bg.addColorStop(1, hot ? '#ffe0b0' : '#ff6a00');
    ctx.fillStyle = bg; ctx.beginPath(); ctx.ellipse(0, -25, 8, 12, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(110,30,0,.6)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(-3, -32); ctx.lineTo(1, -24); ctx.lineTo(-2, -16); ctx.stroke();
    ellipse(0, -40, 6, 6.5, hot ? '#fff' : '#ffb347');
    // flame crown
    ctx.fillStyle = hot ? '#fff' : '#ff8a1a';
    for (let k = -1; k <= 1; k++) {
      const hgt = 10 + Math.sin(t + k * 2) * 4;
      ctx.beginPath(); ctx.moveTo(k * 4 - 3, -43); ctx.quadraticCurveTo(k * 5 + Math.sin(t * 1.3 + k) * 3, -45 - hgt, k * 4 + 3, -43); ctx.fill();
    }
    ellipse(2.5, -41, 1.3, 1.1, '#4a0f00');
    ctx.restore();
  }

  function drawWarden(e) {
    const p = iso(e.x, e.y), sw = Math.sin(e.walk) * 4, hot = e.flash > 0;
    shadow(p.x, p.y, 13);
    if (e.draining) {
      const c = iso(e.draining.x, e.draining.y, 40);
      ctx.strokeStyle = `rgba(255,70,70,${0.5 + Math.sin(S.t * 20) * 0.3})`; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(p.x, p.y - 26); ctx.lineTo(c.x, c.y); ctx.stroke();
    }
    ctx.save(); ctx.translate(p.x, p.y); ctx.scale(e.face, 1);
    if (e.rise > 0) { ctx.globalAlpha = 1 - e.rise; }
    limb(-3, -17, -3 + sw, -3, 6, '#1a2338');
    limb(3, -17, 3 - sw, -3, 6, '#1e2740');
    ellipse(-2 + sw, -1.5, 5, 2.5, '#111');
    ellipse(4 - sw, -1.5, 5, 2.5, '#111');
    limb(-7, -32, -10 - sw * 0.4, -20, 5, '#1b2640');
    ctx.fillStyle = hot ? '#9fb3ff' : '#1f2c4a'; ctx.beginPath(); ctx.roundRect(-9.5, -38, 19, 22, 4); ctx.fill();
    ctx.fillStyle = '#0e1424'; ctx.fillRect(-9.5, -21, 19, 3);
    ellipse(-4, -32, 2.2, 2.6, '#e8c15a');
    ctx.fillStyle = '#e8eefc'; ctx.font = 'bold 3.6px sans-serif'; ctx.fillText('POLICE', 0.5, -30);
    ellipse(0, -45, 6.5, 7, '#e2b99a');
    ctx.fillStyle = '#6b4a38'; ctx.beginPath(); ctx.ellipse(0.5, -41.5, 5.5, 3, 0, 0, Math.PI); ctx.fill();
    ellipse(3, -46, 0.9, 0.9, '#111');
    // dark fur ushanka with badge
    ellipse(-7, -45, 3.2, 5.5, '#23252e');
    ellipse(0, -53, 10, 6.5, '#2a2c36');
    ctx.fillStyle = '#383b48'; ctx.beginPath(); ctx.roundRect(-10, -53, 20, 5, 3); ctx.fill();
    ellipse(0, -53, 2.2, 2.2, '#c7ccd8', '#e8c15a', 0.8);
    limb(7, -32, 12 + sw * 0.4, -21, 5, '#24304f');
    limb(12 + sw * 0.4, -21, 16 + sw * 0.4, -33, 2.5, '#111');
    ctx.restore();
  }

  function drawPainter(portraitMode) {
    const p = iso(PAINTER.x, PAINTER.y), five = S.hfT > 0;
    // easel + canvas
    if (!portraitMode) {
    const ep = iso(PAINTER.x + 0.9, PAINTER.y - 0.5);
    shadow(ep.x, ep.y, 12);
    limb(ep.x - 8, ep.y, ep.x, ep.y - 50, 2.5, '#6b4423');
    limb(ep.x + 8, ep.y, ep.x, ep.y - 50, 2.5, '#6b4423');
    ctx.fillStyle = '#f2e2c0'; ctx.fillRect(ep.x - 14, ep.y - 46, 28, 22);
    const cg = ctx.createLinearGradient(0, ep.y - 44, 0, ep.y - 26);
    cg.addColorStop(0, '#e9a34a'); cg.addColorStop(1, '#6d7f3a');
    ctx.fillStyle = cg; ctx.fillRect(ep.x - 12, ep.y - 44, 24, 18);
    polyFill([{ x: ep.x - 8, y: ep.y - 28 }, { x: ep.x - 2, y: ep.y - 40 }, { x: ep.x + 4, y: ep.y - 28 }], '#c7954f');
    ellipse(ep.x + 6, ep.y - 36, 4, 5, '#3f6e2a');
    }
    shadow(p.x, p.y, 13);
    ctx.save(); ctx.translate(p.x, p.y); ctx.scale(-1, 1);
    limb(-3, -17, -3, -3, 6, '#3a2c22');
    limb(3, -17, 3, -3, 6, '#3f3126');
    ellipse(-2, -1.5, 5, 2.5, '#2a1c12'); ellipse(4, -1.5, 5, 2.5, '#2a1c12');
    ctx.fillStyle = '#4a3a2e'; ctx.beginPath(); ctx.roundRect(-9.5, -38, 19, 26, 4); ctx.fill();
    ctx.fillStyle = '#2f4a6b'; ctx.beginPath(); ctx.moveTo(-4, -38); ctx.lineTo(4, -38); ctx.lineTo(1, -28); ctx.fill();
    ellipse(-5, -26, 1.3, 1.3, '#c89a3a'); ellipse(-5, -20, 1.3, 1.3, '#c89a3a');
    ellipse(0, -46, 6.5, 7.5, '#d9ae88');
    ctx.fillStyle = '#2a1d17'; ctx.beginPath(); ctx.moveTo(-3, -40); ctx.lineTo(3, -40); ctx.lineTo(0, -36); ctx.fill();
    ctx.strokeStyle = '#2a1d17'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(0, -42.5); ctx.quadraticCurveTo(5, -43, 7, -46); ctx.moveTo(0, -42.5); ctx.quadraticCurveTo(-5, -43, -7, -46); ctx.stroke();
    ellipse(2.5, -47, 0.9, 0.9, '#111');
    for (const [hx, hy] of [[-6, -52], [-2, -55], [3, -54], [7, -51], [-7, -47], [0, -57], [6, -47]]) ellipse(hx, hy, 3.6, 3.6, '#1c1612');
    const hx = five ? 6 : 11, hy = five ? -55 : -20;
    limb(7, -33, hx, hy, 5, '#4a3a2e');
    ellipse(hx, hy, 2.6, 2.6, '#d9ae88');
    limb(-7, -33, -10, -21, 5, '#43342a');
    ctx.restore();
    if (S.tokens > 0 && !portraitMode) {
      const b = Math.sin(S.t * 4) * 3;
      ellipse(p.x, p.y - 76 + b, 11, 11, '#ffc23d', '#6b4a0a', 2);
      ctx.fillStyle = '#3a2400'; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('✋', p.x, p.y - 71 + b);
    }
  }

  function drawShot(s) {
    const p = iso(s.x, s.y, s.z);
    shadow(iso(s.x, s.y).x, iso(s.x, s.y).y, 4);
    ctx.globalCompositeOperation = 'lighter';
    if (s.hero) {
      const a = Math.atan2(iso(s.vx, s.vy).y, iso(s.vx, s.vy).x);
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(a);
      polyFill([{ x: -8, y: -2 }, { x: 6, y: -3 }, { x: 9, y: 0 }, { x: 6, y: 3 }, { x: -8, y: 2 }], 'rgba(57,230,255,.9)', '#e0fdff', 1);
      ctx.restore();
    } else {
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 12);
      g.addColorStop(0, '#fff3c0'); g.addColorStop(0.4, '#ff8a1a'); g.addColorStop(1, 'rgba(255,60,0,0)');
      ctx.fillStyle = g; ctx.fillRect(p.x - 12, p.y - 12, 24, 24);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawEnemyBar(e) {
    if (e.hp >= e.maxHp || e.type === 'boss') return;
    const p = iso(e.x, e.y, e.zc + 38);
    ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(p.x - 12, p.y, 24, 3.5);
    ctx.fillStyle = e.type === 'warden' ? '#8fb1ff' : '#ffb347'; ctx.fillRect(p.x - 12, p.y, 24 * Math.max(0, e.hp / e.maxHp), 3.5);
  }

  function drawSanctum() {
    const sc = S.sanctum; if (!sc) return;
    const p = iso(sc.x, sc.y), rx = sc.r * TW / 2, ry = sc.r * TH / 2, a = Math.min(1, sc.t / 0.4, (sc.max - sc.t) / 0.2 + 0.2);
    ctx.globalAlpha = a;
    ellipse(p.x, p.y, rx, ry, 'rgba(255,194,61,.14)', '#ffc23d', 2);
    ctx.strokeStyle = 'rgba(255,214,110,.55)'; ctx.lineWidth = 1.2;
    for (let k = 0; k < 5; k++) {
      const sx = Math.cos(k / 5 * Math.PI + S.t * 0.8);
      ctx.beginPath(); ctx.ellipse(p.x, p.y, Math.abs(sx) * rx + 0.1, rx * 0.9, 0, Math.PI, Math.PI * 2); ctx.stroke();
    }
    ctx.beginPath(); ctx.ellipse(p.x, p.y, rx, rx * 0.9, 0, Math.PI, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,194,61,.08)'; ctx.fill(); ctx.strokeStyle = '#ffd36b'; ctx.lineWidth = 2; ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function drawFx() {
    ctx.globalCompositeOperation = 'lighter';
    for (const f of fx) {
      const a = f.life / f.max;
      if (f.k === 'bolt') {
        for (const [w, col] of [[5, f.color], [1.6, '#ffffff']]) {
          ctx.strokeStyle = col; ctx.globalAlpha = a; ctx.lineWidth = w; ctx.beginPath();
          for (let i = 0; i < f.pts.length - 1; i++) {
            const A = iso(f.pts[i].x, f.pts[i].y, f.pts[i].z), B = iso(f.pts[i + 1].x, f.pts[i + 1].y, f.pts[i + 1].z);
            if (i === 0) ctx.moveTo(A.x, A.y);
            for (let s = 1; s <= 5; s++) {
              const t = s / 5, j = s < 5 ? 7 : 0;
              ctx.lineTo(lerp(A.x, B.x, t) + rand(-j, j), lerp(A.y, B.y, t) + rand(-j, j));
            }
          }
          ctx.stroke();
        }
      } else if (f.k === 'ring') {
        const p = iso(f.x, f.y), r = f.r * (1 - a * a);
        ctx.globalAlpha = a; ellipse(p.x, p.y, r * TW / 2, r * TH / 2, null, f.color, 5);
        ellipse(p.x, p.y, r * TW / 2 * 0.8, r * TH / 2 * 0.8, null, '#ffffff', 1.5);
      } else if (f.k === 'beam') {
        const A = iso(f.a.x, f.a.y, f.a.z), B = iso(f.b.x, f.b.y, f.b.z);
        ctx.globalAlpha = a;
        limb(A.x, A.y, B.x, B.y, f.w * 2.2, f.color);
        limb(A.x, A.y, B.x, B.y, f.w * 0.5, '#ffffff');
      }
    }
    for (const p of parts) {
      const q = iso(p.x, p.y, p.z);
      ctx.globalAlpha = Math.min(1, p.life / p.max * 1.5);
      ctx.fillStyle = p.color; ctx.fillRect(q.x - p.size / 2, q.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    ctx.textAlign = 'center';
    for (const f of fx) if (f.k === 'text') {
      const p = iso(f.x, f.y, f.z);
      ctx.globalAlpha = Math.min(1, f.life / f.max * 2);
      ctx.font = `800 ${f.size}px system-ui, sans-serif`;
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.strokeText(f.str, p.x, p.y);
      ctx.fillStyle = f.color; ctx.fillText(f.str, p.x, p.y);
    }
    ctx.globalAlpha = 1;
  }

  function drawIndicator() {
    let tgt = null;
    if (S.boss) tgt = { x: S.boss.x, y: S.boss.y, c: '#ff7a1a' };
    else if (S.phase === 'coils') {
      let bd = 1e9;
      for (const c of coils) if (!c.active && !c.locked) { const d = Math.hypot(c.x - hero.x, c.y - hero.y); if (d < bd) { bd = d; tgt = { x: c.x, y: c.y, c: '#39e6ff' }; } }
    }
    if (S.tokens > 0 && !tgt) tgt = { x: PAINTER.x, y: PAINTER.y, c: '#ffc23d' };
    if (!tgt) return;
    const w = iso(tgt.x, tgt.y, 30);
    const sx = (w.x - cam.x) * ZOOM + W / 2, sy = (w.y - cam.y) * ZOOM + H * 0.46;
    const m = 34, top = 110, bot = H - 120;
    if (sx > m && sx < W - m && sy > top && sy < bot) return;
    const cx = W / 2, cy = H * 0.46, dx = sx - cx, dy = sy - cy;
    const k = Math.min((dx > 0 ? W - m - cx : cx - m) / Math.abs(dx || 1e-3), (dy > 0 ? bot - cy : cy - top) / Math.abs(dy || 1e-3));
    const x = cx + dx * k, y = cy + dy * k, a = Math.atan2(dy, dx);
    ctx.save(); ctx.translate(x, y); ctx.rotate(a);
    ctx.globalAlpha = 0.75 + Math.sin(S.t * 6) * 0.25;
    polyFill([{ x: 14, y: 0 }, { x: -8, y: -10 }, { x: -3, y: 0 }, { x: -8, y: 10 }], tgt.c, 'rgba(0,0,0,.6)', 2);
    ctx.restore();
  }

  function draw(dt) {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#f0dcae'); bg.addColorStop(0.55, '#caa46a'); bg.addColorStop(1, '#3a240f');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    if (!S) return;

    const hc = iso(hero.x, hero.y, 20), k = Math.min(1, dt * 6);
    cam.x += (hc.x - cam.x) * k; cam.y += (hc.y - cam.y) * k;
    const sh = S.shake * 8, shx = rand(-sh, sh), shy = rand(-sh, sh);
    ctx.setTransform(DPR * ZOOM, 0, 0, DPR * ZOOM, DPR * (W / 2 + shx), DPR * (H * 0.46 + shy));
    ctx.translate(-cam.x, -cam.y);

    ctx.drawImage(ground, -GOX, -GOY);
    drawConduits();

    const items = [];
    const hk = hero.x + hero.y, hs = iso(hero.x, hero.y);
    for (const p of PYRS) {
      const ps = iso(p.x, p.y);
      const behind = hk < p.x + p.y && Math.abs(hs.x - ps.x) < p.s * TW * 0.9 && hs.y > ps.y - p.h - 20 && hs.y < ps.y + p.s * TH;
      items.push({ k: p.x + p.y, f: () => drawPyramid(p, behind ? 0.45 : 1) });
    }
    for (const c of coils) items.push({ k: c.x + c.y, f: () => drawCoil(c) });
    items.push({ k: CORE.x + CORE.y, f: drawCore });
    items.push({ k: TREE.x + TREE.y, f: drawTree });
    items.push({ k: PAINTER.x + PAINTER.y, f: drawPainter });
    items.push({ k: hk, f: drawHero });
    for (const e of enemies) items.push({ k: e.x + e.y, f: () => (e.type === 'warden' ? drawWarden(e) : drawEmber(e, e.type === 'boss' ? 2.6 : 1)) });
    for (const s of shots) items.push({ k: s.x + s.y + 0.01, f: () => drawShot(s) });
    items.sort((a, b) => a.k - b.k);
    for (const it of items) it.f();
    for (const e of enemies) drawEnemyBar(e);
    drawSanctum();
    drawFx();

    // screen-space overlays
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    if (S.flowT > 0) { ctx.fillStyle = `rgba(95,255,224,${0.08 + Math.sin(S.t * 5) * 0.03})`; ctx.fillRect(0, 0, W, H); }
    if (S.hurtFlash > 0) {
      const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.7);
      g.addColorStop(0, 'rgba(255,0,0,0)'); g.addColorStop(1, `rgba(200,20,10,${S.hurtFlash})`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
    drawIndicator();
  }

  // ---------- HUD ----------
  const abBtns = [...document.querySelectorAll('.ab')];
  abBtns.forEach((b, i) => b.addEventListener('pointerdown', (e) => { e.preventDefault(); useAbility(i); }));
  const actionBtn = $('actionBtn');
  actionBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); highFive(); });
  let toastT = 0;
  function toast(msg, dur = 2) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); toastT = dur; }
  function hud(dt) {
    $('hpFill').style.width = (hero.hp / hero.maxHp * 100) + '%';
    $('hpText').textContent = `${Math.ceil(hero.hp)} / ${hero.maxHp}`;
    $('killText').textContent = S.kills;
    $('tokenText').textContent = S.tokens;
    $('tokenChip').classList.toggle('glow', S.tokens > 0);
    abBtns.forEach((b, i) => {
      const max = ABIL[i].cd * hero.cdMul, p = cds[i] / max;
      b.querySelector('.cd').style.setProperty('--p', p.toFixed(3));
      b.querySelector('em').textContent = cds[i] > 0 ? Math.ceil(cds[i]) : '';
      if (cds[i] <= 0 && b.dataset.wasCd === '1') { b.dataset.wasCd = ''; b.classList.remove('ready'); void b.offsetWidth; b.classList.add('ready'); }
    });
    actionBtn.classList.toggle('hidden', !(nearPainter() && S.tokens > 0 && !S.modal));
    const ob = $('objective');
    const ac = activeCount(), m = reqCount();
    $('coilText').textContent = ac + '/' + m;
    abBtns.forEach((b, i) => b.classList.toggle('locked', abilityLocked(i)));
    const cm = $('comms');
    if (S.comms) { cm.classList.remove('hidden'); cm.querySelector('b').textContent = WHO[S.comms.who].name; cm.querySelector('b').style.color = WHO[S.comms.who].color; cm.querySelector('span').textContent = S.comms.text; }
    else cm.classList.add('hidden');
    ob.textContent = CH().endless ? (S.boss ? 'The Pyre has returned — burn it out' : `Survive · ${Math.floor(S.t)}s · ${ac}/6 coils live`)
      : S.phase === 'coils' ? `Ch. ${chapter + 1}: wake the coils (${ac}/${m}) — stand on a glowing pad`
      : S.phase === 'awaken' ? 'The Core is charging…'
      : S.phase === 'boss' ? `Burn out the Pyre · live coils power the Core beam (${ac}/6)` : 'The grid is yours';
    $('bossbar').classList.toggle('hidden', !S.boss);
    if (S.boss) $('bossFill').style.width = Math.max(0, S.boss.hp / S.boss.maxHp * 100) + '%';
    $('moveHint').classList.toggle('hidden', S.hintT <= 0);
    if (toastT > 0) { toastT -= dt; if (toastT <= 0) $('toast').classList.remove('show'); }
  }

  // ---------- Flow ----------
  const show = (id, on) => $(id).classList.toggle('hidden', !on);
  function ensureAudio() {
    if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { actx = null; } }
    if (actx && actx.state === 'suspended') actx.resume();
  }
  const ALL_OVERLAYS = ['title', 'end', 'pause', 'upgrade', 'chapters', 'dialog'];
  const IN_GAME = ['hud', 'abilities', 'objective', 'bossbar', 'actionBtn', 'moveHint', 'comms'];
  function startChapter(i) {
    ensureAudio();
    chapter = i;
    newGame(); running = true;
    ALL_OVERLAYS.forEach((id) => show(id, false));
    ['hud', 'abilities', 'objective'].forEach((id) => show(id, true));
    S.modal = true;
    dialog(CH().intro, () => { S.modal = false; toast(`Chapter ${i + 1} · ${CH().name}`, 2); });
  }
  function toTitle() {
    running = false; S = null;
    ALL_OVERLAYS.concat(IN_GAME).forEach((id) => show(id, false));
    show('title', true);
  }
  function togglePause(force) {
    if (!running || S.over || S.modal) return;
    S.paused = force !== undefined ? force : !S.paused;
    show('pause', S.paused);
  }
  function endGame(win) {
    if (S.over) return;
    S.over = true;
    const ch = CH(), firstClear = win && !ch.endless && save.cleared <= chapter;
    const earned = S.sparksRun + S.kills + (win ? ch.reward : 0);
    save.sparks += earned;
    if (firstClear) save.cleared = chapter + 1;
    if (ch.endless) save.best = Math.max(save.best || 0, Math.floor(S.t));
    persist();
    const results = () => {
      running = false;
      $('endTitle').textContent = ch.endless ? 'The current fades' : win ? `${ch.name}: cleared` : 'The grid went dark';
      $('endSub').textContent = ch.endless ? `You held the plateau for ${Math.floor(S.t)} seconds. Best: ${save.best}s.`
        : win ? (chapter === 3 ? 'The Pyre is ash and the capstones burn blue. Endless Current is now open.'
          : firstClear ? `Chapter ${chapter + 2} is now open.` : 'Chapter replayed.')
        : 'The Wardens drag you off through the dusk. Spend your sparks in the Workshop and try again.';
      const m = Math.floor(S.t / 60), sec = Math.floor(S.t % 60);
      $('endStats').innerHTML = `<div><b>${m}:${String(sec).padStart(2, '0')}</b>time</div><div><b>${S.kills}</b>takedowns</div><div><b>+${earned}</b>sparks</div>`;
      $('againBtn').textContent = win && !ch.endless && chapter < 4 ? 'Next chapter' : 'Try again';
      IN_GAME.forEach((id) => show(id, false));
      show('end', true);
    };
    if (win && ch.outro.length) setTimeout(() => { S.modal = true; dialog(ch.outro, results); }, 200);
    else setTimeout(results, win ? 0 : 900);
  }

  // ---------- Story dialog ----------
  const pcv = $('portrait'), pctx = pcv.getContext('2d');
  function drawPortrait(who) {
    const d = 2;
    pcv.width = 96 * d; pcv.height = 96 * d;
    const saved = ctx; ctx = pctx;
    pctx.setTransform(d, 0, 0, d, 0, 0);
    const g = pctx.createRadialGradient(48, 40, 4, 48, 48, 70);
    g.addColorStop(0, WHO[who].color + '55'); g.addColorStop(1, '#120c06');
    pctx.fillStyle = g; pctx.fillRect(0, 0, 96, 96);
    pctx.translate(48, 158); pctx.scale(2.3, 2.3);
    const t = S ? S.t : 0;
    if (who === 'W') {
      const h = hero; hero = Object.assign({}, h, { x: 0, y: 0, face: 1, moving: false, inv: 0, stun: 0, surgeT: 0 });
      drawHero(); hero = h;
    } else if (who === 'P') {
      const p = iso(PAINTER.x, PAINTER.y); pctx.translate(-p.x, -p.y); drawPainter(true);
    } else if (who === 'C') {
      drawWarden({ x: 0, y: 0, walk: 0, face: 1, flash: 0, rise: 0, draining: null });
    } else {
      pctx.translate(0, -8); pctx.scale(0.7, 0.7);
      drawEmber({ x: 0, y: 0, id: 3, walk: 0, face: -1, rise: 0, flash: 0 }, 1.2);
    }
    ctx = saved;
    void t;
  }
  let dlg = null;
  function dialog(lines, done) {
    if (!lines.length) { done(); return; }
    dlg = { lines, i: 0, done };
    show('dialog', true);
    showLine();
  }
  function showLine() {
    const [who, text] = dlg.lines[dlg.i];
    $('dlgName').textContent = WHO[who].name;
    $('dlgName').style.color = WHO[who].color;
    $('dlgText').textContent = text;
    $('dlgStep').textContent = `${dlg.i + 1} / ${dlg.lines.length}`;
    drawPortrait(who);
  }
  function advance(skip) {
    if (!dlg) return;
    dlg.i++;
    if (skip || dlg.i >= dlg.lines.length) {
      const done = dlg.done; dlg = null; show('dialog', false); done();
    } else showLine();
  }
  $('dialog').addEventListener('click', (e) => { if (e.target.id !== 'dlgSkip') advance(false); });
  $('dlgSkip').addEventListener('click', () => advance(true));

  // ---------- Chapter select + Workshop ----------
  function openChapters() {
    ensureAudio();
    ALL_OVERLAYS.forEach((id) => show(id, false));
    IN_GAME.forEach((id) => show(id, false));
    running = false; S = null;
    $('sparkText').textContent = save.sparks;
    const list = $('chapterList'); list.innerHTML = '';
    CHAPTERS.forEach((ch, i) => {
      const open = i <= save.cleared, done = i < save.cleared && !ch.endless;
      const b = document.createElement('button');
      b.className = 'chap' + (open ? '' : ' shut') + (done ? ' done' : '');
      b.disabled = !open;
      const tag = ch.endless ? (save.best ? `Best ${save.best}s` : 'Survival') : done ? 'Cleared' : open ? `+${ch.reward} sparks` : 'Locked';
      b.innerHTML = `<i>${ch.endless ? '∞' : i + 1}</i><span><b>${ch.name}</b><small>${open ? ch.blurb : 'Clear the previous chapter to open this one.'}</small></span><em>${tag}</em>`;
      b.onclick = () => startChapter(i);
      list.appendChild(b);
    });
    const shop = $('shopList'); shop.innerHTML = '';
    WORKSHOP.forEach((u) => {
      const l = lvl(u.id), maxed = l >= u.max, cost = upCost(l);
      const b = document.createElement('button');
      b.className = 'shop';
      b.disabled = maxed || save.sparks < cost;
      b.innerHTML = `<span><b>${u.name}</b><small>${u.d}</small></span><span class="pips">${'●'.repeat(l)}${'○'.repeat(u.max - l)}</span><em>${maxed ? 'Max' : '✦ ' + cost}</em>`;
      b.onclick = () => { if (save.sparks < cost || maxed) return; save.sparks -= cost; save.up[u.id] = l + 1; persist(); sfx('five'); openChapters(); };
      shop.appendChild(b);
    });
    show('chapters', true);
  }
  $('playBtn').onclick = openChapters;
  $('againBtn').onclick = () => {
    const ch = CH();
    const next = !ch.endless && chapter < 4 && save.cleared > chapter && $('againBtn').textContent === 'Next chapter';
    startChapter(next ? chapter + 1 : chapter);
  };
  $('chapBackBtn').onclick = toTitle;
  $('quitBtn').onclick = openChapters;
  $('endQuitBtn').onclick = openChapters;
  $('resumeBtn').onclick = () => togglePause(false);
  $('pauseBtn').onclick = () => togglePause();
  $('muteBtn').onclick = () => { muted = !muted; $('muteBtn').textContent = muted ? '🔇' : '🔊'; };
  document.addEventListener('visibilitychange', () => { if (document.hidden) togglePause(true); });

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (running && !S.paused && !S.modal) update(dt);
    if (S) { draw(running && !S.paused && !S.modal ? dt : 0); hud(dt); }
    else draw(0);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  // test hook for automated checks
  window.__pc = { get S() { return S; }, get hero() { return hero; }, get coils() { return coils; }, get enemies() { return enemies; }, get save() { return save; }, startChapter, openChapters, useAbility, advance };
})();
