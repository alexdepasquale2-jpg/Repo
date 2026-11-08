/* Essence Protocol: the overworld's pixel art, shared by the game, the world builder and the
   content editor's map preview, so a map looks the same everywhere.

   const R = WORLD_RENDER.create(ctx)       one per canvas
   R.setThemes(world.themes)                zone colors (data/world.json themes)
   R.drawTile(view, x, y, sx, sy, s, lights) one map tile at screen (sx, sy), s pixels wide
   R.drawThing(view, thing, sx, sy, s, lights, opened)   signs, chests, warps, blocks
   R.drawPerson(sx, sy, s, pal, dir, frame, kind, bob)   people (R.personPal for their colors)
   R.drawAmbient(dt, camX, camY, W, H, s, theme)         floating particles
   R.flushLights(lights)                    additive glows collected while drawing

   view: { tile(x, y) -> tile char, theme(x, y) -> palette, t: seconds, rustle: Map, gateOpen(ch) }
   Everything is cached so a frame allocates nothing new. */
(function (root) {
  'use strict';
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const f = v => clamp(Math.round(v + (amt < 0 ? v * amt : (255 - v) * amt)), 0, 255);
    return '#' + [n >> 16 & 255, n >> 8 & 255, n & 255].map(v => f(v).toString(16).padStart(2, '0')).join('');
  }
  function mix(a, b, t) {
    const x = parseInt(a.slice(1), 16), y = parseInt(b.slice(1), 16);
    const c = s => Math.round((x >> s & 255) * (1 - t) + (y >> s & 255) * t);
    return '#' + [16, 8, 0].map(s => c(s).toString(16).padStart(2, '0')).join('');
  }
  const rgbOf = hex => { const n = parseInt(hex.slice(1), 16); return `${n >> 16 & 255},${n >> 8 & 255},${n & 255}`; };
  function hash2(x, y) { let h = x * 374761393 + y * 668265263; h = (h ^ (h >> 13)) * 1274126177; return (h ^ (h >> 16)) >>> 0; }

  // A theme from data/world.json, with the extra tones the tiles use.
  function palette(t) {
    const p = {
      id: t.id, name: t.name, f1: t.floor[0], f2: t.floor[1], speck: t.speck, line: t.line, wall: t.wall, face: t.face, trim: t.trim,
      grass: t.static.slice(), obst: t.obstacle, accent: t.accent, sky: t.sky.slice(), part: t.particles || 'none',
    };
    p.rgb = rgbOf(p.accent);
    p.face2 = shade(p.face, -0.4); p.blade = shade(p.grass[1], -0.15); p.obst2 = shade(p.obst, -0.25); p.obst3 = shade(p.obst, 0.25);
    p.slab = shade(p.f2, 0.1); p.sand = mix(p.f2, '#c9a86a', 0.5); p.sand2 = shade(p.sand, -0.18);
    p.ice = mix(p.f2, '#cdefff', 0.62); p.ice2 = shade(p.ice, 0.35);
    p.trimRgb = rgbOf(p.trim);
    return p;
  }
  const FALLBACK = palette({ id: 'nexus', name: 'Nexus', floor: ['#141b2e', '#172036'], speck: '#22304f', line: '#243457', wall: '#0c1120', face: '#1d2846', trim: '#46f3ff', static: ['#15443f', '#23796b', '#7ffff0'], obstacle: '#46f3ff', accent: '#46f3ff', sky: ['#050814', '#111a33'], particles: 'data' });

  // ---- people: 16x17 pixel templates, cached per palette/dir/frame
  const PT = {
    down: ['................', '.....HHHHHH.....', '....HHHHHHHH....', '....HSSSSSSH....', '....SVVVVVVS....', '....SVEVVEVS....', '.....SSSSSS.....', '....JJJJJJJJ....', '...JJjJLLJjJJ...', '...SJjJJJJjJS...', '...SJJJJJJJJS...', '....jjjjjjjj....'],
    up: ['................', '.....HHHHHH.....', '....HHHHHHHH....', '....HHHHHHHH....', '....HHHHHHHH....', '....SHHHHHHS....', '.....SSSSSS.....', '....JJJJJJJJ....', '...JJjJJJJjJJ...', '...SJjJJJJjJS...', '...SJJJJJJJJS...', '....jjjjjjjj....'],
    side: ['................', '.....HHHHHH.....', '....HHHHHHHH....', '....SSSSSHHH....', '...VVVVVSSHH....', '...VEVVSSSHH....', '.....SSSSSS.....', '.....JJJJJJ.....', '....JLJJJjJ.....', '....JSJJJjJ.....', '....JSJJJJJ.....', '.....jjjjjj.....'],
  };
  const PLAYER = { id: 'p', H: '#46f3ff', S: '#f0c9a0', V: '#101421', E: '#c8feff', J: '#1f6f82', j: '#134653', L: 'rgba(255,255,255,.35)', P: '#1c2130', B: '#07090f', cape: '#46f3ff' };
  const FOLK = { id: 'f', H: '#9aa6c8', S: '#e8c0a0', V: '#101421', E: '#ffe9a0', J: '#3a4466', j: '#262d45', L: 'rgba(255,255,255,.25)', P: '#1c2130', B: '#07090f', cape: '#3a4466' };
  const palCache = new Map();
  // kind 'player' | 'folk' | 'op' | 'warden'; color: an outfit color, or null for the usual look
  function personPal(kind, color, theme) {
    if (kind === 'player') return PLAYER;
    if (kind === 'folk' && !color) return FOLK;
    const base = color || (theme || FALLBACK).accent, trim = color ? shade(color, 0.55) : (theme || FALLBACK).trim;
    const id = 'c' + base + trim;
    let p = palCache.get(id);
    if (!p) { p = { id, H: base, S: '#e8c0a0', V: '#101421', E: trim, J: shade(base, -0.45), j: shade(base, -0.65), L: 'rgba(255,255,255,.25)', P: '#1c2130', B: '#07090f', cape: shade(base, -0.2) }; palCache.set(id, p); }
    return p;
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

  const glows = new Map();
  function glow(col, r) {
    const R = Math.max(1, Math.round(r)), id = col + '|' + R;
    let c = glows.get(id);
    if (!c) {
      c = document.createElement('canvas'); c.width = c.height = R * 2;
      const g = c.getContext('2d'), gr = g.createRadialGradient(R, R, 0, R, R, R);
      gr.addColorStop(0, `rgba(${col},1)`); gr.addColorStop(1, `rgba(${col},0)`);
      g.fillStyle = gr; g.fillRect(0, 0, R * 2, R * 2);
      glows.set(id, c);
    }
    return c;
  }

  function create(ctx) {
    const R = {};
    let themes = {};
    R.setThemes = list => { themes = {}; for (const t of list || []) { try { themes[t.id] = palette(t); } catch (e) { /* a half-made theme */ } } };
    R.theme = id => themes[id] || FALLBACK;
    R.personPal = personPal;
    R.glow = glow;

    // ---- floor and walls
    const isWall = ch => ch === '#';
    function floor(v, x, y, sx, sy, s, th, h, u) {
      ctx.fillStyle = (x + y) % 2 ? th.f1 : th.f2; ctx.fillRect(sx, sy, s, s);
      ctx.fillStyle = th.speck; ctx.fillRect(sx + (h % 14 + 1) * u, sy + ((h >> 5) % 14 + 1) * u, u, u);
      if (h % 6 === 0) {
        const ox = (h >> 3) % 7 + 2;
        ctx.fillStyle = th.line;
        ctx.fillRect(sx + ox * u, sy + 8 * u, 6 * u, 0.7 * u); ctx.fillRect(sx + ox * u, sy + 8 * u, 0.7 * u, 5 * u); ctx.fillRect(sx + (ox + 5.5) * u, sy + 7.5 * u, 1.6 * u, 1.6 * u);
      }
    }
    function shadows(v, x, y, sx, sy, s, u) {
      if (isWall(v.tile(x, y - 1))) { ctx.fillStyle = 'rgba(0,0,0,.4)'; ctx.fillRect(sx, sy, s, 3 * u); ctx.fillStyle = 'rgba(0,0,0,.18)'; ctx.fillRect(sx, sy + 3 * u, s, 2 * u); }
      if (isWall(v.tile(x - 1, y))) { ctx.fillStyle = 'rgba(0,0,0,.22)'; ctx.fillRect(sx, sy, 2 * u, s); }
      if (isWall(v.tile(x + 1, y))) { ctx.fillStyle = 'rgba(0,0,0,.22)'; ctx.fillRect(sx + s - 2 * u, sy, 2 * u, s); }
      if (v.tile(x, y - 1) === 'V') { ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(sx, sy, s, 2 * u); }
    }

    R.drawTile = function (v, x, y, sx, sy, s, lights) {
      const ch = v.tile(x, y), th = v.theme(x, y), h = hash2(x, y), u = s / 16, t = v.t;
      if (ch === '#') {
        ctx.fillStyle = th.wall; ctx.fillRect(sx, sy, s, s);
        const below = v.tile(x, y + 1);
        if (below !== '#' && below !== 'V') {
          // front face of a wall block (the 2.5D part)
          const fy = sy + s * 0.4;
          ctx.fillStyle = th.face; ctx.fillRect(sx, fy, s, s * 0.6);
          ctx.fillStyle = th.face2; ctx.fillRect(sx, fy + s * 0.38, s, s * 0.22);
          ctx.fillStyle = 'rgba(0,0,0,.28)';
          for (let i = 2; i < 16; i += 5) ctx.fillRect(sx + (i + (y % 2) * 2) * u, fy + 1.5 * u, 0.6 * u, s * 0.5);
          ctx.globalAlpha = 0.5 + 0.3 * Math.sin(t * 2 + x * 0.7);
          ctx.fillStyle = th.trim; ctx.fillRect(sx, fy - 0.5 * u, s, 0.9 * u);
          ctx.globalAlpha = 1;
          if (h % 7 === 0) { ctx.fillStyle = th.trim; ctx.fillRect(sx + 7 * u, fy + 4 * u, 2 * u, u); lights.push([sx + 8 * u, fy + 4.5 * u, s * 0.7, th.rgb, 0.18]); }
        } else if (h % 11 === 0) { ctx.fillStyle = th.face; ctx.fillRect(sx + 6 * u, sy + 6 * u, u, u); }
        return;
      }
      if (ch === 'V') {
        ctx.fillStyle = '#020308'; ctx.fillRect(sx, sy, s, s);
        if (h % 9 === 0) { ctx.globalAlpha = 0.3 + 0.3 * Math.sin(t * 1.5 + h); ctx.fillStyle = th.trim; ctx.fillRect(sx + (h % 13 + 1) * u, sy + ((h >> 4) % 13 + 1) * u, u * 0.8, u * 0.8); ctx.globalAlpha = 1; }
        return;
      }
      floor(v, x, y, sx, sy, s, th, h, u);
      shadows(v, x, y, sx, sy, s, u);
      object(v, ch, x, y, sx, sy, s, lights, th, h, u, t);
    };

    // everything that stands on the floor (also used by blocks: a boulder is the boulder tile)
    function object(v, ch, x, y, sx, sy, s, lights, th, h, u, t) {
      switch (ch) {
        case ',': {
          const [c1, c2, c3] = th.grass;
          const r = v.rustle ? v.rustle.get(x + ',' + y) : null, age = r == null ? 9 : t - r;
          const shake = age < 0.5 ? Math.sin(age * 40) * u * (0.5 - age) * 4 : 0;
          ctx.fillStyle = c1; ctx.fillRect(sx + u, sy + 3 * u, s - 2 * u, s - 4 * u);
          for (let i = 0; i < 7; i++) {
            const bx = sx + (1.5 + i * 2) * u, sway = Math.sin(t * 2.2 + x * 0.9 + i) * u * 0.8 + shake;
            const bh = (6 + (hash2(x + i, y) % 5)) * u;
            ctx.fillStyle = i % 2 ? c2 : th.blade;
            ctx.fillRect(bx + sway * 0.5, sy + s - u - bh, u, bh);
            ctx.fillRect(bx + sway, sy + s - 2 * u - bh, u, u);
          }
          if ((h + Math.floor(t * 6)) % 11 === 0) { ctx.fillStyle = c3; ctx.fillRect(sx + (h % 12 + 2) * u, sy + ((h >> 4) % 8 + 3) * u, u, u); }
          break;
        }
        case ':': {
          ctx.fillStyle = th.line; ctx.fillRect(sx, sy, s, s);
          ctx.fillStyle = th.slab;
          const o = (y % 2) * 4;
          ctx.fillRect(sx + (0.5 + o) * u, sy + 0.5 * u, 7 * u, 7 * u); ctx.fillRect(sx + ((8.5 + o) % 16) * u, sy + 0.5 * u, Math.min(7, 16 - (8.5 + o) % 16) * u, 7 * u);
          if (o) ctx.fillRect(sx, sy + 0.5 * u, 3.5 * u, 7 * u);
          ctx.fillRect(sx + 0.5 * u, sy + 8.5 * u, 7 * u, 7 * u); ctx.fillRect(sx + 8.5 * u, sy + 8.5 * u, 7 * u, 7 * u);
          ctx.fillStyle = th.speck; ctx.fillRect(sx + (h % 12 + 2) * u, sy + ((h >> 5) % 12 + 2) * u, u, u);
          break;
        }
        case 'S': {
          ctx.fillStyle = th.sand; ctx.fillRect(sx, sy, s, s);
          ctx.fillStyle = th.sand2;
          for (let i = 0; i < 5; i++) { const g = hash2(x * 7 + i, y * 3); ctx.fillRect(sx + (g % 15) * u, sy + ((g >> 4) % 15) * u, u, u); }
          if (h % 4 === 0) { ctx.fillStyle = 'rgba(255,255,255,.12)'; ctx.fillRect(sx + (h % 9 + 2) * u, sy + ((h >> 3) % 9 + 3) * u, 5 * u, 0.7 * u); }
          break;
        }
        case '&': {
          const cols = [th.trim, '#ff8fb8', '#ffe27a', '#b48cff'];
          for (let i = 0; i < 4; i++) {
            const g = hash2(x * 5 + i, y * 11), fx = sx + (g % 12 + 2) * u, fy = sy + ((g >> 4) % 11 + 3) * u + Math.sin(t * 2 + i + x) * 0.3 * u;
            ctx.fillStyle = th.blade; ctx.fillRect(fx, fy + u, 0.7 * u, 2 * u);
            ctx.fillStyle = cols[(g >> 8) % cols.length]; ctx.fillRect(fx - u, fy, u, u); ctx.fillRect(fx + u * 0.7, fy, u, u); ctx.fillRect(fx, fy - u, 0.7 * u, u); ctx.fillRect(fx, fy + u * 0.4, 0.7 * u, 0.7 * u);
          }
          break;
        }
        case '=': {
          const across = v.tile(x, y - 1) === '~' || v.tile(x, y + 1) === '~' || v.tile(x - 1, y) === '=' || v.tile(x + 1, y) === '=';
          ctx.fillStyle = '#2a1d13'; ctx.fillRect(sx, sy, s, s);
          ctx.fillStyle = '#6b4f33';
          for (let i = 0; i < 4; i++) { if (across) ctx.fillRect(sx + (i * 4 + 0.5) * u, sy + u, 3.2 * u, s - 2 * u); else ctx.fillRect(sx + u, sy + (i * 4 + 0.5) * u, s - 2 * u, 3.2 * u); }
          ctx.fillStyle = '#8a6a45';
          for (let i = 0; i < 4; i++) { if (across) ctx.fillRect(sx + (i * 4 + 0.5) * u, sy + u, 3.2 * u, 0.8 * u); else ctx.fillRect(sx + u, sy + (i * 4 + 0.5) * u, 0.8 * u, 3.2 * u); }
          ctx.fillStyle = '#1a120b';
          if (across) { ctx.fillRect(sx, sy, s, u); ctx.fillRect(sx, sy + s - u, s, u); } else { ctx.fillRect(sx, sy, u, s); ctx.fillRect(sx + s - u, sy, u, s); }
          break;
        }
        case '_': {
          ctx.fillStyle = th.ice; ctx.fillRect(sx, sy, s, s);
          ctx.fillStyle = th.ice2; ctx.fillRect(sx + 2 * u, sy + 3 * u, 6 * u, 0.8 * u); ctx.fillRect(sx + 9 * u, sy + 10 * u, 4 * u, 0.8 * u);
          ctx.fillStyle = 'rgba(255,255,255,.55)';
          const sh = (t * 0.6 + x * 0.13 + y * 0.07) % 3;
          if (sh < 1) ctx.fillRect(sx + sh * 14 * u, sy + (2 + sh * 10) * u, 2 * u, 2 * u);
          ctx.fillStyle = 'rgba(0,40,70,.18)'; ctx.fillRect(sx, sy + s - u, s, u);
          break;
        }
        case '~': {
          ctx.fillStyle = th.obst; ctx.fillRect(sx, sy, s, s);
          if (v.tile(x, y - 1) !== '~') { ctx.fillStyle = 'rgba(0,15,45,.45)'; ctx.fillRect(sx, sy, s, 3 * u); ctx.fillStyle = 'rgba(170,220,255,.5)'; ctx.fillRect(sx, sy + 3 * u, s, 0.7 * u); }
          ctx.fillStyle = 'rgba(170,220,255,.4)';
          const o = (t * 5 + x * 5 + y * 3) % 16;
          ctx.fillRect(sx + (o % 12) * u, sy + 7 * u, 4 * u, 0.8 * u);
          ctx.fillRect(sx + ((o + 7) % 12) * u, sy + 12 * u, 3 * u, 0.8 * u);
          break;
        }
        case '^': {
          const g = 0.5 + 0.5 * Math.sin(t * 3 + x + y);
          ctx.fillStyle = '#5a1a08'; ctx.fillRect(sx, sy, s, s);
          ctx.fillStyle = `rgb(255,${100 + 80 * g | 0},30)`; ctx.fillRect(sx + 1.5 * u, sy + 1.5 * u, 13 * u, 13 * u);
          ctx.fillStyle = '#ffe08a'; ctx.fillRect(sx + (h % 9 + 3) * u, sy + ((h >> 3) % 7 + 4) * u, 2 * u, 2 * u);
          if ((h + Math.floor(t * 2)) % 5 === 0) { ctx.fillStyle = '#fff6c8'; ctx.fillRect(sx + (h % 11 + 2) * u, sy + 3 * u, u, u); }
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
          const b = Math.sin(t * 2 + x) * u;
          ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.fillRect(sx + 3 * u, sy + 13 * u, 10 * u, 2 * u);
          ctx.fillStyle = '#7fb8c4'; ctx.fillRect(sx + 4 * u, sy + 8 * u, 8 * u, 6 * u);
          ctx.fillStyle = '#2c5b66'; ctx.fillRect(sx + 5 * u, sy + 9 * u, 6 * u, 2 * u);
          ctx.fillStyle = th.obst; ctx.beginPath(); ctx.arc(sx + 8 * u, sy + 5 * u + b, 4.5 * u, 0, 7); ctx.arc(sx + 5 * u, sy + 6 * u + b, 3 * u, 0, 7); ctx.arc(sx + 11 * u, sy + 6 * u + b, 3 * u, 0, 7); ctx.fill();
          break;
        }
        case 'x': {
          const g = 0.5 + 0.5 * Math.sin(t * 2.5 + x);
          ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(sx + 2 * u, sy + 13 * u, 12 * u, 3 * u);
          ctx.fillStyle = '#2a1850'; ctx.fillRect(sx + 3 * u, sy - 8 * u, 10 * u, s + 6 * u);
          ctx.fillStyle = '#3d2672'; ctx.fillRect(sx + 3 * u, sy - 8 * u, 10 * u, 2 * u);
          ctx.fillStyle = `rgba(190,140,255,${0.45 + 0.5 * g})`; ctx.fillRect(sx + 7 * u, sy - 5 * u, 2 * u, 15 * u);
          lights.push([sx + s / 2, sy + 2 * u, s * 1.3, '180,140,255', 0.12 + 0.08 * g]);
          break;
        }
        case '+': {
          const g = 0.5 + 0.5 * Math.sin(t * 2 + x * 1.3 + y);
          ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(sx + 2 * u, sy + 13 * u, 12 * u, 2.5 * u);
          ctx.fillStyle = th.obst2;
          ctx.beginPath(); ctx.moveTo(sx + 3 * u, sy + 14 * u); ctx.lineTo(sx + 5 * u, sy + 6 * u); ctx.lineTo(sx + 7 * u, sy + 14 * u); ctx.fill();
          ctx.beginPath(); ctx.moveTo(sx + 9 * u, sy + 14 * u); ctx.lineTo(sx + 12 * u, sy + 5 * u); ctx.lineTo(sx + 14 * u, sy + 14 * u); ctx.fill();
          ctx.fillStyle = th.accent;
          ctx.beginPath(); ctx.moveTo(sx + 5 * u, sy + 14 * u); ctx.lineTo(sx + 8 * u, sy + 1 * u); ctx.lineTo(sx + 11 * u, sy + 14 * u); ctx.fill();
          ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.fillRect(sx + 7.5 * u, sy + 4 * u, u, 6 * u);
          lights.push([sx + s / 2, sy + 7 * u, s * 1.5, th.rgb, 0.12 + 0.1 * g]);
          break;
        }
        case '|': {
          const lr = v.tile(x - 1, y) === '|' || v.tile(x + 1, y) === '|' || !(v.tile(x, y - 1) === '|' || v.tile(x, y + 1) === '|');
          ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.fillRect(sx, sy + 13 * u, s, 2 * u);
          ctx.fillStyle = th.face;
          if (lr) {
            ctx.fillRect(sx, sy + 6 * u, s, 1.5 * u); ctx.fillRect(sx, sy + 10 * u, s, 1.5 * u);
            ctx.fillStyle = th.face2; ctx.fillRect(sx + 2 * u, sy + 4 * u, 2 * u, 10 * u); ctx.fillRect(sx + 12 * u, sy + 4 * u, 2 * u, 10 * u);
            ctx.fillStyle = th.trim; ctx.fillRect(sx + 2 * u, sy + 4 * u, 2 * u, u); ctx.fillRect(sx + 12 * u, sy + 4 * u, 2 * u, u);
          } else {
            ctx.fillRect(sx + 6 * u, sy, 1.5 * u, s); ctx.fillRect(sx + 9 * u, sy, 1.5 * u, s);
            ctx.fillStyle = th.face2; ctx.fillRect(sx + 5.5 * u, sy + 2 * u, 5.5 * u, 2 * u); ctx.fillRect(sx + 5.5 * u, sy + 11 * u, 5.5 * u, 2 * u);
          }
          break;
        }
        case 'T': {
          const g = 0.5 + 0.5 * Math.sin(t * 3 + h);
          ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(sx + u, sy + 13 * u, 14 * u, 3 * u);
          ctx.fillStyle = '#10141f'; ctx.fillRect(sx + u, sy + 2 * u, 14 * u, 12 * u);
          ctx.fillStyle = '#1c2334'; ctx.fillRect(sx + u, sy + 2 * u, 14 * u, 2 * u);
          ctx.fillStyle = `rgba(${th.rgb},${0.35 + 0.35 * g})`; ctx.fillRect(sx + 3 * u, sy + 5 * u, 10 * u, 5 * u);
          ctx.fillStyle = `rgba(${th.rgb},.9)`;
          for (let i = 0; i < 3; i++) ctx.fillRect(sx + 4 * u, sy + (6 + i * 1.5) * u, ((hash2(h, i + Math.floor(t * 2)) % 7) + 2) * u, 0.7 * u);
          ctx.fillStyle = '#2a3348'; ctx.fillRect(sx + 3 * u, sy + 11 * u, 10 * u, 1.5 * u);
          lights.push([sx + s / 2, sy + 7 * u, s * 1.2, th.rgb, 0.1 + 0.06 * g]);
          break;
        }
        case 'B': {
          ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(sx, sy + 13 * u, s, 3 * u);
          ctx.fillStyle = '#1a1420'; ctx.fillRect(sx + u, sy - 4 * u, 14 * u, 18 * u);
          ctx.fillStyle = '#2c2233'; ctx.fillRect(sx + u, sy - 4 * u, 14 * u, u);
          const cols = [th.accent, th.trim, '#ff8a3d', '#8fe6d4', '#b48cff', '#e0b060'];
          for (let r = 0; r < 3; r++) {
            ctx.fillStyle = '#0d0a12'; ctx.fillRect(sx + 2 * u, sy + (-2 + r * 5) * u, 12 * u, 4 * u);
            for (let i = 0; i < 5; i++) { const g = hash2(x * 3 + i, y * 5 + r); ctx.fillStyle = cols[g % cols.length]; ctx.fillRect(sx + (2.4 + i * 2.3) * u, sy + (-1.5 + r * 5 + (g >> 5) % 2 * 0.5) * u, 1.6 * u, (3.5 - (g >> 5) % 2 * 0.5) * u); }
          }
          break;
        }
        case 'L': {
          const g = 0.5 + 0.5 * Math.sin(t * 1.7 + h);
          ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.fillRect(sx + 5 * u, sy + 13 * u, 6 * u, 2 * u);
          ctx.fillStyle = '#1c2130'; ctx.fillRect(sx + 7 * u, sy - 2 * u, 2 * u, 16 * u);
          ctx.fillStyle = '#2c3348'; ctx.fillRect(sx + 5.5 * u, sy - 5 * u, 5 * u, 3 * u);
          ctx.fillStyle = `rgba(${th.trimRgb},${0.75 + 0.25 * g})`; ctx.fillRect(sx + 6 * u, sy - 4.5 * u, 4 * u, 2 * u);
          lights.push([sx + s / 2, sy - 3 * u, s * 2.4, th.trimRgb, 0.2 + 0.05 * g]);
          break;
        }
        case 'H': {
          ctx.fillStyle = '#0c1a16'; ctx.fillRect(sx + u, sy - 3 * u, 14 * u, 17 * u);
          ctx.fillStyle = '#12352b'; ctx.fillRect(sx + 2 * u, sy - 2 * u, 12 * u, 9 * u);
          ctx.fillStyle = '#5dff9a'; ctx.fillRect(sx + 7 * u, sy - u, 2 * u, 7 * u); ctx.fillRect(sx + 4.5 * u, sy + 1.5 * u, 7 * u, 2 * u);
          ctx.fillStyle = '#1d4a3c'; ctx.fillRect(sx + 3 * u, sy + 9 * u, 10 * u, 2 * u);
          lights.push([sx + s / 2, sy + 2 * u, s * 1.8, '93,255,154', 0.16 + 0.05 * Math.sin(t * 3)]);
          break;
        }
        case 'F': {
          ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(sx + u, sy + 13 * u, 14 * u, 3 * u);
          ctx.fillStyle = '#2b1e17'; ctx.fillRect(sx + 2 * u, sy + 6 * u, 12 * u, 8 * u);
          ctx.fillStyle = '#4a342a'; ctx.fillRect(sx + u, sy + 5 * u, 14 * u, 3 * u);
          ctx.fillStyle = `rgba(255,190,90,${0.5 + 0.4 * Math.sin(t * 4)})`; ctx.fillRect(sx + 4 * u, sy + 9 * u, 8 * u, 3 * u);
          for (let i = 0; i < 4; i++) {
            const a = t * 1.6 + i * Math.PI / 2;
            ctx.fillStyle = FORGE_ORBS[i]; ctx.fillRect(sx + (8 + Math.cos(a) * 5) * u - u, sy + (2 + Math.sin(a) * 2) * u - u, 2 * u, 2 * u);
          }
          lights.push([sx + s / 2, sy + 6 * u, s * 1.8, '255,170,90', 0.16]);
          break;
        }
        case 'R': rift(sx + s / 2, sy + s / 2, u, s, t, lights, 1); break;
        default:
          if (ch >= '1' && ch <= '9') gate(v, ch, sx, sy, s, u, t, y, lights);
      }
    }
    const FORGE_ORBS = ['#ff6b3d', '#3aa6ff', '#c9913d', '#8fe6d4'];
    const RIFT_RINGS = ['#b48cff', '#46f3ff', '#ff5cf0'];
    function rift(cx, cy, u, s, t, lights, k) {
      ctx.lineWidth = u * 1.2;
      for (let i = 0; i < 3; i++) {
        ctx.strokeStyle = RIFT_RINGS[i];
        ctx.beginPath(); ctx.arc(cx, cy, (6 - i * 1.6) * u * k, t * (1.5 + i) + i, t * (1.5 + i) + i + 4.2); ctx.stroke();
      }
      ctx.fillStyle = '#fff'; ctx.fillRect(cx - u / 2, cy - u / 2, u, u);
      lights.push([cx, cy, s * 2 * k, '180,140,255', 0.22 + 0.08 * Math.sin(t * 4)]);
    }
    function gate(v, ch, sx, sy, s, u, t, y, lights) {
      if (v.gateOpen && v.gateOpen(ch)) { ctx.fillStyle = 'rgba(70,243,255,.12)'; ctx.fillRect(sx, sy + 7 * u, s, 2 * u); return; }
      const g = 0.5 + 0.5 * Math.sin(t * 5 + y);
      ctx.fillStyle = `rgba(255,84,112,${0.25 + 0.25 * g})`; ctx.fillRect(sx, sy, s, s);
      ctx.fillStyle = '#ffd0d8';
      for (let i = 0; i < 4; i++) ctx.fillRect(sx + (i * 4 + 1.5) * u, sy, 0.8 * u, s);
      lights.push([sx + s / 2, sy + s / 2, s * 1.2, '255,84,112', 0.14]);
    }

    // ---- things that aren't people
    const LOOK_TILE = { boulder: 'o', crystal: '+', tree: '*', pillar: 'x' };
    R.drawThing = function (v, th0, sx, sy, s, lights, opened) {
      const u = s / 16, t = v.t, th = v.theme(th0.x, th0.y), h = hash2(th0.x, th0.y);
      switch (th0.type) {
        case 'sign': {
          ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(sx + 4 * u, sy + 13 * u, 8 * u, 2 * u);
          ctx.fillStyle = '#3a2a1c'; ctx.fillRect(sx + 7 * u, sy + 7 * u, 2 * u, 7 * u);
          ctx.fillStyle = th.face2; ctx.fillRect(sx + 2 * u, sy + 1 * u, 12 * u, 8 * u);
          ctx.fillStyle = th.face; ctx.fillRect(sx + 3 * u, sy + 2 * u, 10 * u, 6 * u);
          ctx.fillStyle = th.trim; ctx.fillRect(sx + 2 * u, sy + 1 * u, 12 * u, 0.8 * u);
          ctx.fillStyle = `rgba(${th.trimRgb},.8)`;
          ctx.fillRect(sx + 4 * u, sy + 3.5 * u, 8 * u, 0.8 * u); ctx.fillRect(sx + 4 * u, sy + 5.5 * u, 5 * u, 0.8 * u);
          return;
        }
        case 'chest': {
          if (th0.look === 'orb') {
            if (opened) return;
            const b = Math.sin(t * 3 + h) * u;
            ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.beginPath(); ctx.ellipse(sx + 8 * u, sy + 13.5 * u, 4 * u, 1.3 * u, 0, 0, 7); ctx.fill();
            ctx.fillStyle = th.accent; ctx.beginPath(); ctx.arc(sx + 8 * u, sy + 7 * u + b, 3.6 * u, 0, 7); ctx.fill();
            ctx.fillStyle = 'rgba(255,255,255,.8)'; ctx.fillRect(sx + 6.5 * u, sy + 5 * u + b, 1.5 * u, 1.5 * u);
            lights.push([sx + 8 * u, sy + 7 * u + b, s * 1.4, th.rgb, 0.25]);
            return;
          }
          ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(sx + 2 * u, sy + 13 * u, 12 * u, 2.5 * u);
          if (th0.look === 'cache') {
            ctx.fillStyle = '#10141f'; ctx.fillRect(sx + 3 * u, sy + 4 * u, 10 * u, 10 * u);
            ctx.fillStyle = opened ? '#2a3348' : th.accent;
            ctx.fillRect(sx + 3 * u, sy + 8.5 * u, 10 * u, u); ctx.fillRect(sx + 7.5 * u, sy + 4 * u, u, 10 * u);
            if (!opened) lights.push([sx + 8 * u, sy + 9 * u, s * 1.2, th.rgb, 0.15 + 0.08 * Math.sin(t * 3 + h)]);
            return;
          }
          ctx.fillStyle = '#3a2618'; ctx.fillRect(sx + 2 * u, sy + 7 * u, 12 * u, 7 * u);
          ctx.fillStyle = '#5a3c24';
          if (opened) { ctx.fillRect(sx + 2 * u, sy + 2 * u, 12 * u, 4 * u); ctx.fillStyle = '#0b0705'; ctx.fillRect(sx + 3 * u, sy + 7 * u, 10 * u, 2 * u); }
          else ctx.fillRect(sx + 2 * u, sy + 4 * u, 12 * u, 4 * u);
          ctx.fillStyle = th.trim; ctx.fillRect(sx + 2 * u, sy + (opened ? 5 : 7) * u, 12 * u, 0.8 * u);
          if (!opened) { ctx.fillStyle = '#ffd23d'; ctx.fillRect(sx + 7 * u, sy + 7.5 * u, 2 * u, 2 * u); }
          return;
        }
        case 'warp': {
          if (th0.look === 'hidden') return;
          if (th0.look === 'door') {
            ctx.fillStyle = th.face2; ctx.fillRect(sx + u, sy, 14 * u, s);
            ctx.fillStyle = '#05070c'; ctx.fillRect(sx + 3 * u, sy + 2 * u, 10 * u, s - 2 * u);
            ctx.fillStyle = th.trim; ctx.fillRect(sx + 2 * u, sy + u, 12 * u, u); ctx.fillRect(sx + 2 * u, sy + u, u, s - u); ctx.fillRect(sx + 13 * u, sy + u, u, s - u);
            ctx.fillStyle = `rgba(${th.rgb},${0.18 + 0.1 * Math.sin(t * 2 + h)})`; ctx.fillRect(sx + 3 * u, sy + 10 * u, 10 * u, 6 * u);
            return;
          }
          if (th0.look === 'stairs') {
            for (let i = 0; i < 4; i++) { ctx.fillStyle = shade(th.face, -0.15 * i); ctx.fillRect(sx + u, sy + (1 + i * 3.6) * u, 14 * u, 3.6 * u); ctx.fillStyle = th.trim; ctx.fillRect(sx + u, sy + (1 + i * 3.6) * u, 14 * u, 0.6 * u); }
            return;
          }
          if (th0.look === 'pad') {
            ctx.fillStyle = '#10141f'; ctx.beginPath(); ctx.ellipse(sx + 8 * u, sy + 9 * u, 7 * u, 4.5 * u, 0, 0, 7); ctx.fill();
            ctx.strokeStyle = th.accent; ctx.lineWidth = u; ctx.beginPath(); ctx.ellipse(sx + 8 * u, sy + 9 * u, 5.5 * u, 3.3 * u, 0, 0, 7); ctx.stroke();
            ctx.fillStyle = `rgba(${th.rgb},${0.25 + 0.2 * Math.sin(t * 4 + h)})`; ctx.fillRect(sx + 7 * u, sy + (2 + ((t * 8 + h) % 6)) * u, 2 * u, 2 * u);
            lights.push([sx + 8 * u, sy + 8 * u, s * 1.3, th.rgb, 0.16]);
            return;
          }
          rift(sx + s / 2, sy + s / 2, u, s, t, lights, 0.9);
          return;
        }
        case 'block': {
          if (th0.look === 'gate') return gate(v, '0', sx, sy, s, u, t, th0.y, lights);
          if (th0.look === 'barrier') {
            const g = 0.5 + 0.5 * Math.sin(t * 4 + th0.x);
            ctx.fillStyle = `rgba(${th.rgb},${0.18 + 0.15 * g})`; ctx.fillRect(sx, sy + u, s, s - 2 * u);
            ctx.fillStyle = `rgba(${th.rgb},.7)`;
            for (let i = 0; i < 4; i++) ctx.fillRect(sx, sy + (2 + i * 4 + (t * 6) % 4) * u, s, 0.6 * u);
            lights.push([sx + s / 2, sy + s / 2, s * 1.2, th.rgb, 0.14]);
            return;
          }
          object(v, LOOK_TILE[th0.look] || 'o', th0.x, th0.y, sx, sy, s, lights, th, h, u, t);
          return;
        }
        default:
      }
    };

    R.drawPerson = function (sx, sy, s, pal, dir, frame, kind, bob) {
      const u = s / 16;
      ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.ellipse(sx + s / 2, sy + s - u, 5 * u, 1.8 * u, 0, 0, 7); ctx.fill();
      ctx.drawImage(personCanvas(pal, dir, frame, kind), sx, sy - 3 * u + (bob || 0), s, s * 17 / 16);
    };

    R.flushLights = function (lights) {
      ctx.globalCompositeOperation = 'lighter';
      for (const [lx, ly, r, col, a] of lights) { ctx.globalAlpha = Math.min(1, a); ctx.drawImage(glow(col, r), lx - r, ly - r); }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    };

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
        case 'snow': return { kind, x, y: camY - 10, vx: (Math.random() - 0.3) * 12 * k, vy: (18 + Math.random() * 16) * k, life: 9, size: k * (1 + Math.random()), col: 'rgba(240,248,255,' };
        case 'leaf': return { kind, x, y: camY - 10, vx: (10 + Math.random() * 14) * k, vy: (14 + Math.random() * 10) * k, life: 9, size: k * 1.5, col: Math.random() < 0.5 ? 'rgba(150,210,110,' : 'rgba(230,160,70,' };
        default: return { kind: 'data', x, y: camY - 10, vx: 0, vy: (12 + Math.random() * 18) * k, life: 8, size: k, col: 'rgba(70,243,255,' };
      }
    }
    R.drawAmbient = function (dt, camX, camY, W, H, s, th, t) {
      const kind = (th || FALLBACK).part;
      if (kind === 'none') { amb.length = 0; return; }
      while (amb.length < 34) amb.push(spawnAmb(kind, camX, camY, W, H, s));
      for (let i = amb.length - 1; i >= 0; i--) {
        const p = amb[i];
        p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt;
        if (p.kind === 'ember') p.x += Math.sin(t * 3 + p.y * 0.01) * 0.3;
        if (p.kind === 'snow' || p.kind === 'leaf') p.x += Math.sin(t * 2 + i) * 0.4;
        const sx = p.x - camX, sy = p.y - camY;
        if (p.life <= 0 || sx < -40 || sx > W * 1.4 || sy < -40 || sy > H + 40 || (p.kind !== kind && Math.random() < 0.02)) { amb.splice(i, 1); continue; }
        const a = Math.min(1, p.life) * (p.kind === 'spark' ? 0.5 + 0.5 * Math.sin(t * 10 + i) : 0.7);
        ctx.fillStyle = p.col + a + ')';
        if (p.kind === 'wind') ctx.fillRect(sx, sy, p.size * 10, p.size * 0.6);
        else if (p.kind === 'bubble') { ctx.strokeStyle = p.col + a + ')'; ctx.lineWidth = p.size * 0.4; ctx.beginPath(); ctx.arc(sx, sy, p.size, 0, 7); ctx.stroke(); }
        else if (p.kind === 'leaf') ctx.fillRect(sx, sy, p.size * 1.6, p.size * 0.8);
        else ctx.fillRect(sx, sy, p.size, p.size);
      }
    };
    R.clearAmbient = () => { amb.length = 0; };
    return R;
  }

  // A small overview of one map of a world (raw data/world.json shape): one block per tile.
  function tileColor(ch, th) {
    switch (ch) {
      case '#': return th.face; case 'V': return '#020308'; case ',': return th.grass[1]; case ':': return th.slab; case 'S': return th.sand;
      case '&': return th.grass[2]; case '=': return '#6b4f33'; case '_': return th.ice; case '~': return th.obst; case '^': return '#ff6a1e';
      case 'o': case '*': return th.obst2; case 'x': return '#3d2672'; case '+': return th.accent; case '|': return th.face2; case 'L': return th.trim;
      case 'T': case 'B': return '#28304a'; case 'H': return '#5dff9a'; case 'F': return '#ffbe5a'; case 'R': return '#b48cff';
      default: return ch >= '1' && ch <= '9' ? '#ff5470' : th.f2;
    }
  }
  const THING_DOT = { person: '#e8eeff', trainer: '#ff8a5a', sign: '#e0b060', chest: '#ffd23d', warp: '#46f3ff', trigger: '#b48cff', block: '#8e9abb' };
  function mini(cv, world, mapId, k) {
    const m = (world.maps || []).find(x => x && x.id === mapId) || (world.maps || [])[0];
    if (!m || !m.tiles || !m.tiles.length) return;
    const themes = {}, marks = {}, zoneTheme = {};
    for (const t of world.themes || []) { try { themes[t.id] = palette(t); } catch (e) { /* half-made */ } }
    for (const z of world.zones || []) { if (z.mark) marks[z.mark] = z.id; zoneTheme[z.id] = themes[z.theme] || FALLBACK; }
    const h = m.tiles.length, w = String(m.tiles[0]).length;
    k = k || Math.max(2, Math.min(6, Math.floor(480 / Math.max(w, h))));
    cv.width = w * k; cv.height = h * k;
    const g = cv.getContext('2d');
    for (let y = 0; y < h; y++) {
      const row = String(m.tiles[y]), zr = String((m.zones || [])[y] || '');
      for (let x = 0; x < w; x++) {
        const mk = zr[x], zid = mk && mk !== '.' && marks[mk] ? marks[mk] : m.zone;
        g.fillStyle = tileColor(row[x], zoneTheme[zid] || FALLBACK);
        g.fillRect(x * k, y * k, k, k);
      }
    }
    for (const t of m.things || []) { if (!t || t.x == null) continue; g.fillStyle = THING_DOT[t.type] || '#fff'; g.fillRect(t.x * k, t.y * k, k, k); }
    if (world.start && world.start.map === m.id) { g.strokeStyle = '#ffd23d'; g.lineWidth = Math.max(1, k / 2); g.strokeRect(world.start.x * k - k / 2, world.start.y * k - k / 2, k * 2, k * 2); }
  }

  root.WORLD_RENDER = { create, palette, shade, mix, hash2, rgbOf, mini, tileColor };
})(typeof self !== 'undefined' ? self : this);
