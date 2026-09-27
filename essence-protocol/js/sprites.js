/* Essence Protocol: procedural daemon sprites.
   A sprite is a pure function of its genome key. The lead main sets the body
   plan, the second main sets the belly and a secondary feature, and every
   bound sub adds a visible organ. Sprites are drawn once to a 32x32 canvas
   and cached. */
(function (root) {
  'use strict';
  const E = root.ESSENCE;
  const S = 32;
  const cache = new Map();

  function fnv(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
  function rng(seed) { return function () { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  const ACCENT = {
    Em: '#ff9a2e', Pl: '#ff5cf0', As: '#8a8a94', Ti: '#2f7dff', Fr: '#dff8ff', Mi: '#bfe3ff', St: '#8b7b68', Me: '#d8dde6',
    Ro: '#5fbf4a', Sp: '#ffe23d', Ga: '#f2fffb', Ec: '#c7a6ff', Li: '#ffe9a0', Vo: '#6b2fa8', Si: '#46f3ff', Tm: '#d1a15a',
  };

  // Prismatic variants rotate every hue of the palette.
  function hueShift(hex, deg) {
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
    let h = 0, sat = 0;
    if (d) {
      sat = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h *= 60;
    }
    h = (h + deg) % 360; sat = Math.min(1, sat * 1.25);
    const c = (1 - Math.abs(2 * l - 1)) * sat, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
    const [a, bb, cc] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    const to = v => Math.round((v + m) * 255).toString(16).padStart(2, '0');
    return '#' + to(a) + to(bb) + to(cc);
  }

  function inEllipse(x, y, cx, cy, rx, ry) { const dx = (x - cx) / rx, dy = (y - cy) / ry; return dx * dx + dy * dy <= 1; }

  function draw(key, prism) {
    const p = E.parseKey(key);
    const tier = p.subs.length;
    const R = rng(fnv(key));
    const sc = 0.72 + tier * 0.1;
    const A = E.MAIN[p.a], B = E.MAIN[p.b];
    const subs = new Set(p.subs.map(t => t.s));
    const g = Array.from({ length: S }, () => Array(S).fill(null));
    const set = (x, y, c) => { if (x >= 0 && x < S && y >= 0 && y < S) g[y][x] = c; };
    const setM = (x, y, c) => { set(x, y, c); set(S - 1 - x, y, c); };
    const cx = 15.5, base = 27;
    const body = (x, y) => {
      const u = x, v = y;
      switch (p.a) {
        case 'F': {
          if (inEllipse(u, v, cx, base - 7 * sc, 8 * sc, 7 * sc)) return true;
          const top = base - 22 * sc;
          if (v >= top && v <= base - 7 * sc) { const hw = (v - top) / (15 * sc) * 7.5 * sc; return Math.abs(u - cx) <= hw; }
          return false;
        }
        case 'W': {
          if (inEllipse(u, v, cx, base - 8 * sc, 9 * sc, 8 * sc)) return true;
          const top = base - 21 * sc;
          if (v >= top && v <= base - 12 * sc) { const hw = (v - top) / (9 * sc) * 5 * sc; return Math.abs(u - cx) <= hw; }
          return false;
        }
        case 'E': {
          const hw = 7 * sc, top = base - 18 * sc;
          if (v >= top && v <= base - 3 && Math.abs(u - cx) <= hw) return true;
          if (v >= top + 3 * sc && v <= top + 8 * sc && Math.abs(u - cx) <= hw + 3.5 * sc) return true; // shoulders
          if (v > base - 3 && v <= base && Math.abs(u - cx) >= 2 && Math.abs(u - cx) <= hw - 1) return true; // legs
          return false;
        }
        default: {
          if (inEllipse(u, v, cx, base - 11 * sc, 5.5 * sc, 7 * sc)) return true;
          if (v > base - 6 * sc && v <= base && Math.abs(u - cx) <= (base - v) * 0.5) return true; // wisp tail
          return false;
        }
      }
    };
    for (let y = 0; y < S; y++) for (let x = 0; x < 16; x++) if (body(x + 0.5, y + 0.5)) setM(x, y, 'b');
    // jagged edges from the seed
    for (let y = 0; y < S; y++) for (let x = 0; x < 16; x++) if (g[y][x] === 'b' && (x === 0 || g[y][x - 1] === null) && R() < 0.25) setM(x, y, null);

    // Air leads get wings, Fire leads get flame tongues
    if (p.a === 'A' || p.b === 'A' || subs.has('Ga')) {
      const wy = Math.round(base - 13 * sc);
      const span = p.a === 'A' ? 8 : 5;
      for (let i = 0; i < span; i++) for (let j = 0; j < 3 - Math.floor(i / 3); j++) setM(Math.round(cx - 5 * sc) - i, wy + j - Math.floor(i / 2), subs.has('Ga') ? 'g' : 'w');
    }
    if (p.a === 'F' || p.b === 'F') {
      const n = p.a === 'F' ? 3 : 2;
      for (let i = 0; i < n; i++) { const x = Math.round(cx - 1 - i * 3 * sc); const top = Math.round(base - 22 * sc) - 2 + i; for (let y = top; y < top + 3; y++) setM(x, y, 'b'); }
    }
    if (p.b === 'W' || subs.has('Ti')) { const y = Math.round(base - 6 * sc); for (let i = 0; i < 3; i++) setM(Math.round(cx - 8 * sc) - i, y - i, subs.has('Ti') ? 'Ti' : 's'); }
    if (p.b === 'E' && p.a !== 'E') for (let x = 4; x < 12; x++) if (R() < 0.6) setM(x, base, 's');

    // shading: belly takes the second main's color
    const top = g.findIndex(r => r.some(Boolean));
    const bottom = S - 1 - [...g].reverse().findIndex(r => r.some(Boolean));
    const h = Math.max(1, bottom - top);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      if (g[y][x] !== 'b') continue;
      const t = (y - top) / h;
      const edge = x === 0 || !g[y][x - 1];
      if (t > 0.62 && Math.abs(x - cx) < 5 * sc) g[y][x] = 's';
      else if (edge || (x < cx - 3 && t < 0.4 && (x + y) % 3 === 0)) g[y][x] = 'l';
    }

    // face: a visor with glowing eyes (every daemon is an AI)
    const fy = Math.round(top + h * (p.a === 'A' ? 0.35 : 0.42));
    for (let x = Math.round(cx - 4 * sc); x < 16; x++) if (g[fy][x] || g[fy + 1][x]) { setM(x, fy, 'v'); setM(x, fy + 1, 'v'); }
    const eyeX = Math.round(cx - 2.5 * sc);
    const eyeColor = subs.has('Vo') ? 'Vo' : subs.has('Si') ? 'Si' : 'e';
    setM(eyeX, fy, eyeColor); if (tier >= 2) setM(eyeX - 1, fy, eyeColor);

    // organs from sub-essences
    const midY = Math.round(top + h * 0.62);
    const feat = {
      Em: () => { for (let i = 0; i < 3; i++) setM(Math.round(cx - 6 * sc) + i, Math.round(top + h * 0.3) - i, 'Em'); },
      Pl: () => { set(15, midY, 'Pl'); set(16, midY, 'Pl'); set(15, midY - 1, 'Pl'); set(16, midY - 1, 'Pl'); },
      As: () => { for (let i = 0; i < 5; i++) set(Math.round(cx) + Math.round((R() - 0.5) * 12), top - 1 - Math.floor(R() * 3), 'As'); },
      Fr: () => { for (let i = 0; i < 3; i++) { setM(Math.round(cx - 2 - i * 2), top - i % 2 - 1, 'Fr'); setM(Math.round(cx - 2 - i * 2), top - i % 2, 'Fr'); } },
      Mi: () => { for (let i = 0; i < 10; i++) { const x = Math.floor(R() * S), y = Math.floor(R() * S); if (!g[y][x]) set(x, y, 'Mi'); } },
      St: () => { for (let i = 0; i < 4; i++) { const x = Math.round(cx - 6 * sc + R() * 4), y = Math.round(top + h * (0.35 + R() * 0.4)); if (g[y][x]) { setM(x, y, 'St'); setM(x + 1, y, 'St'); } } },
      Me: () => { const y = Math.round(top + h * 0.55); for (let x = 0; x < 16; x++) if (g[y][x]) setM(x, y, 'Me'); },
      Ro: () => { for (let i = 0; i < 3; i++) { const x = Math.round(cx - 2 - i * 3 * sc); for (let y = bottom + 1; y < Math.min(S, bottom + 4); y++) setM(x + (y % 2), y, 'Ro'); } },
      Sp: () => { const x = Math.round(cx - 3); setM(x, top - 1, 'Sp'); setM(x - 1, top - 2, 'Sp'); setM(x, top - 3, 'Sp'); },
      Ec: () => { for (let y = top + 2; y < bottom - 2; y++) { setM(Math.round(cx - 11 * sc), y, (y % 3) ? 'Ec' : null); } },
      Li: () => { for (let x = Math.round(cx - 4); x <= Math.round(cx + 4); x++) set(x, top - 3, 'Li'); set(Math.round(cx - 5), top - 2, 'Li'); set(Math.round(cx + 5), top - 2, 'Li'); },
      Vo: () => { set(15, midY + 1, 'Vo'); set(16, midY + 1, 'Vo'); },
      Si: () => { const x = Math.round(cx + 3); for (let y = top - 3; y < top; y++) set(x, y, 'Me'); set(x, top - 4, 'Si'); },
      Tm: () => { const y = midY - 2; setM(13, y, 'Tm'); setM(14, y - 1, 'Tm'); setM(14, y + 1, 'Tm'); },
    };
    for (const s of subs) if (feat[s]) feat[s]();

    // outline
    const out = g.map(r => r.slice());
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      if (g[y][x]) continue;
      const n = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => { const c = (g[y + dy] || [])[x + dx]; return c && c !== 'Mi' && c !== 'As'; });
      if (n) out[y][x] = 'o';
    }

    const pal = { b: A.color, l: A.light, s: B.color, w: B.light, g: ACCENT.Ga, v: '#101421', e: '#f4ffff', o: '#0b0d16' };
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const ctx = c.getContext('2d');
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const k = out[y][x];
      if (!k) continue;
      const col = pal[k] || ACCENT[k] || '#fff';
      ctx.fillStyle = prism && k !== 'o' && k !== 'v' ? hueShift(col, 150) : col;
      if (k === 'Mi' || k === 'As') ctx.globalAlpha = 0.55;
      ctx.fillRect(x, y, 1, 1);
      ctx.globalAlpha = 1;
    }
    if (prism) {
      ctx.fillStyle = '#ffffff';
      for (const [x, y] of [[3, 5], [28, 9], [5, 22], [27, 25], [16, 1]]) { ctx.fillRect(x, y, 1, 1); ctx.globalAlpha = 0.5; ctx.fillRect(x - 1, y, 3, 1); ctx.fillRect(x, y - 1, 1, 3); ctx.globalAlpha = 1; }
    }
    return c;
  }

  function get(key, prism) {
    const id = key + (prism ? '*' : '');
    let c = cache.get(id);
    if (!c) { c = draw(key, !!prism); cache.set(id, c); }
    return c;
  }

  // Draw a daemon into a canvas element at an integer scale.
  function paint(canvas, key, opts) {
    opts = opts || {};
    const src = get(key, opts.prism);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const scale = Math.max(1, Math.floor(Math.min(canvas.width, canvas.height) / S));
    const w = S * scale;
    ctx.save();
    if (opts.flip) { ctx.translate(canvas.width, 0); ctx.scale(-1, 1); }
    if (opts.silhouette) ctx.filter = 'brightness(0) opacity(0.5)';
    ctx.drawImage(src, Math.floor((canvas.width - w) / 2), Math.floor((canvas.height - w) / 2), w, w);
    ctx.restore();
  }

  root.SPRITES = { get, paint, ACCENT, SIZE: S };
})(typeof self !== 'undefined' ? self : this);
