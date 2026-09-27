/* Essence Protocol: the world builder. Make the game inside the game.

   It edits one of the player's worlds (js/worlds.js) on the game's own canvas, drawn by the game's
   own renderer, so what you paint is exactly what you play. Tools: move, paint, rectangle, room,
   fill and pick, on the tile layer or the zone layer, and things (people, trainers, signs, chests,
   warps, triggers, blocks, the start). The ☰ menu edits maps, zones, themes, starters, the world's
   text and rules, and its own merge names; it lists problems and exports the world. ▶ plays it
   right away from where you are, and ✎ in the game comes back here.

   Every change is one step of undo (whole-world snapshots) and is saved to the browser at once. */
(function () {
  'use strict';
  const G = window.EP_GAME, SC = window.CONTENT_SCHEMA, CT = window.CONTENT, WR = window.WORLD_RENDER, W = window.WORLDS;
  if (!G || !W) return;
  const E = G.E, ENG = G.ENG, SP = G.SP, DB = G.DB, R = G.R, cv = G.cv, ctx = G.ctx;
  const esc = G.esc, clone = SC.clone;
  const TILES = SC.TILES;
  const DIRV = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }, OPP = { up: 'down', down: 'up', left: 'right', right: 'left' };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const debounce = (fn, ms) => { let t = 0; const d = () => { clearTimeout(t); t = setTimeout(fn, ms); }; d.now = () => { clearTimeout(t); fn(); }; return d; };
  const RARITY = ['Base', 'Compound', 'Resonant', 'Trinity', 'Anomaly'];
  const THING_ICON = { person: '☺', trainer: '⚔', sign: '⚑', chest: '▣', warp: '⇥', trigger: '!', block: '■' };

  // ---------------------------------------------------------------- state
  const B = {
    id: null, w: null, mapId: null, grid: null, zgrid: null,
    cam: { x: 0, y: 0, s: 32 },
    tool: 'hand', layer: 'tiles', tile: '#', mark: '.', place: 'person', brush: 1,
    sel: null, picking: null, sheet: null, drawer: null, tab: 'maps',
    past: [], future: [], lastJSON: '', lastEdit: null,
    issues: [], hover: null, rect: null, low: null,
  };
  const map = () => B.w.maps.find(m => m.id === B.mapId) || B.w.maps[0];
  const size = m => ({ w: String(m.tiles[0]).length, h: m.tiles.length });
  const allThings = () => [].concat(...B.w.maps.map(m => m.things.map(t => ({ t, m }))));
  const findThing = id => { for (const m of B.w.maps) { const t = m.things.find(x => x.id === id); if (t) return { t, m }; } return null; };
  const thingAt = (x, y) => map().things.find(t => t.x === x && t.y === y) || null;
  const tileAt = (x, y) => (B.grid[y] || [])[x] || '#';
  const solid = ch => !!(TILES[ch] && TILES[ch].solid);
  const inMap = (x, y) => { const s = size(map()); return x >= 0 && y >= 0 && x < s.w && y < s.h; };
  const zoneOf = id => B.w.zones.find(z => z.id === id);
  const marks = () => { const o = {}; for (const z of B.w.zones) o[z.mark] = z.id; return o; };
  function zoneIdAt(x, y) { const mk = (B.zgrid[y] || [])[x], m = map(); return mk && mk !== '.' ? (marks()[mk] || m.zone) : m.zone; }
  const themeOfZone = zid => { const z = zoneOf(zid); return R.theme(z ? z.theme : null); };
  const ZCOL = ['#ff6b3d', '#46f3ff', '#ffd23d', '#b48cff', '#5dff9a', '#ff5cf0', '#3aa6ff', '#c9913d', '#8fe6d4', '#ff5470', '#9df28a', '#e0e0ff'];
  const zoneColor = zid => ZCOL[Math.max(0, B.w.zones.findIndex(z => z.id === zid)) % ZCOL.length];
  function uid(base) {
    const used = new Set(allThings().map(o => o.t.id));
    for (let n = 1; ; n++) { const id = `${base}-${n}`; if (!used.has(id)) return id; }
  }
  const slugId = (name, used) => { let b = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x'; let id = b; for (let n = 2; used.includes(id); n++) id = b + '-' + n; return id; };
  const nameOf = id => { const f = findThing(id); return f ? f.t.name || `${f.t.type} ${id}` : id; };

  // ---------------------------------------------------------------- history, saving, checking
  function loadGrids() {
    const m = map();
    B.mapId = m.id;
    B.grid = m.tiles.map(r => String(r).split(''));
    const s = size(m);
    B.zgrid = [];
    for (let y = 0; y < s.h; y++) { const r = String((m.zones || [])[y] || ''); const row = []; for (let x = 0; x < s.w; x++) row.push(r[x] || '.'); B.zgrid.push(row); }
    B.low = null;
  }
  function writeGrids() { const m = map(); m.tiles = B.grid.map(r => r.join('')); m.zones = B.zgrid.map(r => r.join('')); B.low = null; }
  // One undo step. Typing into one field keeps extending the same step.
  function commit(label) {
    const now = Date.now(), json = JSON.stringify(B.w);
    if (json === B.lastJSON) return;
    if (label && B.lastEdit && B.lastEdit.label === label && now - B.lastEdit.at < 1500) { B.lastEdit.at = now; B.lastJSON = json; }
    else { B.past.push(B.lastJSON); if (B.past.length > 150) B.past.shift(); B.lastEdit = label ? { label, at: now } : null; B.lastJSON = json; }
    B.future = [];
    persist(); checkSoon(); chrome();
  }
  function restore(json) {
    B.w = JSON.parse(json); B.lastJSON = json; B.lastEdit = null;
    if (!B.w.maps.some(m => m.id === B.mapId)) B.mapId = B.w.maps[0].id;
    loadGrids(); R.setThemes(B.w.themes);
    if (B.sel && !findThing(B.sel)) B.sel = null;
    persist(); checkSoon(); renderAll();
  }
  const undo = () => { if (!B.past.length) return; B.future.push(B.lastJSON); restore(B.past.pop()); };
  const redo = () => { if (!B.future.length) return; B.past.push(B.lastJSON); restore(B.future.pop()); };
  const persist = debounce(() => { if (B.id && B.w && !W.save(B.id, B.w)) G.toast('This browser is out of space for worlds. Export this one to keep it.', 'bad'); }, 350);
  const vctx = () => ({ mechanics: Object.keys(ENG.MECHANICS), organs: Object.keys(SP.ORGANS || {}), reactionKinds: Object.keys(ENG.REACTION_KINDS), validKey: E.validKey });
  function runCheck() {
    if (!B.w) return;
    let C = null;
    try { C = CT.withWorld(B.w); } catch (e) { C = null; }
    try { B.issues = SC.validateWorld(B.w, window.EP_DATA, vctx(), C); } catch (e) { B.issues = [{ level: 'error', path: 'world', msg: 'The world can\'t be checked: ' + e.message }]; }
    chrome();
    if (B.drawer && B.tab === 'problems') drawer();
  }
  const checkSoon = debounce(runCheck, 450);

  // ---------------------------------------------------------------- the builder's screen
  let ui = null;
  const q = sel => ui.querySelector(sel);
  function mount() {
    if (ui) return;
    ui = document.createElement('div');
    ui.id = 'build'; ui.className = 'hidden nosheet';
    ui.innerHTML = `<div class="b-top">
        <button class="bw-btn icon" data-a="menu" aria-label="World menu" title="World menu (M)">☰</button>
        <div class="b-title"><select id="bMap" aria-label="Map"></select></div>
        <button class="bw-btn icon" data-a="undo" aria-label="Undo" title="Undo (Ctrl+Z)">↶</button>
        <button class="bw-btn icon" data-a="redo" aria-label="Redo" title="Redo (Ctrl+Y)">↷</button>
        <button class="bw-btn icon b-issues" data-a="issues" aria-label="Problems" title="Problems">✓</button>
        <button class="bw-btn pri" data-a="play" title="Play (P)">▶ Play</button>
      </div>
      <div class="b-hint hidden" id="bHint"></div>
      <div class="b-bottom"><div class="b-pal" id="bPal"></div><div class="b-tools" id="bTools"></div></div>
      <div class="b-sheet hidden" id="bSheet"><div class="grab"></div><header><h3 id="bSheetTitle"></h3><button class="bw-btn icon" data-a="sheet-close" aria-label="Close">✕</button></header><div class="b-body" id="bSheetBody"></div></div>
      <div class="b-drawer hidden" id="bDrawer"><header><h3 id="bDrawerTitle">World</h3><button class="bw-btn icon" data-a="drawer-close" aria-label="Close">✕</button></header><div class="b-tabs" id="bTabs"></div><div class="b-body" id="bDrawerBody"></div></div>`;
    document.body.appendChild(ui);
    ui.addEventListener('click', onClick);
    ui.addEventListener('change', onChange);
    ui.addEventListener('input', onInput);
    q('#bMap').addEventListener('change', e => { if (e.target.value === '+new') { e.target.value = B.mapId; openDrawer('maps', true); return; } goMap(e.target.value); });
  }

  const TOOLS = [
    ['hand', '✋', 'Move'], ['paint', '✎', 'Paint'], ['rect', '▭', 'Rect'], ['room', '⌂', 'Room'], ['fill', '▨', 'Fill'], ['pick', '⌖', 'Pick'], ['things', '☺', 'Things'],
  ];
  function chrome() {
    if (!ui || !B.w) return;
    const sel = q('#bMap');
    sel.innerHTML = B.w.maps.map(m => `<option value="${esc(m.id)}"${m.id === B.mapId ? ' selected' : ''}>${esc(m.name)}${m.id === B.w.start.map ? ' ⚑' : ''}</option>`).join('') + '<option value="+new">+ New map…</option>';
    q('[data-a=undo]').disabled = !B.past.length; q('[data-a=redo]').disabled = !B.future.length;
    const errs = B.issues.filter(i => i.level === 'error').length, warns = B.issues.length - errs;
    const ib = q('[data-a=issues]');
    ib.textContent = errs ? `⚠${errs}` : warns ? `△${warns}` : '✓';
    ib.className = 'bw-btn icon b-issues ' + (errs ? 'bad' : warns ? 'warn' : '');
    ib.title = errs ? `${errs} problem${errs > 1 ? 's' : ''} to fix` : warns ? `${warns} thing${warns > 1 ? 's' : ''} to look at` : 'No problems';
    const zonesOn = B.layer === 'zones';
    q('#bTools').innerHTML = TOOLS.map(([id, ico, lab]) => `<button class="b-tool${B.tool === id ? ' on' : ''}" data-tool="${id}" title="${lab}"><i>${ico}</i><small>${lab}</small></button>`).join('');
    B.lead = B.tool === 'things' ? '' : `<div class="b-grp b-lead"><div class="bw-seg b-layer"><button data-layer="tiles" class="${zonesOn ? '' : 'on'}">Tiles</button><button data-layer="zones" class="${zonesOn ? 'on' : ''}">Zones</button></div>` +
      (B.tool === 'paint' ? `<button class="b-sw txt" data-a="brush" title="Brush size">${B.brush}×${B.brush}</button>` : '') + '</div>';
    palette();
  }

  // ---- palette: tiles, zones or things, drawn with the game's renderer
  const swCanvas = document.createElement('canvas'); swCanvas.width = swCanvas.height = 48;
  const SR = WR.create(swCanvas.getContext('2d'));
  const swCache = new Map();
  function swatch(key, draw) {
    let url = swCache.get(key);
    if (!url) {
      const g = swCanvas.getContext('2d');
      g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, 48, 48); g.fillStyle = '#04060c'; g.fillRect(0, 0, 48, 48);
      const lights = [];
      draw(g, lights);
      SR.flushLights(lights);
      url = swCanvas.toDataURL();
      swCache.set(key, url);
    }
    return url;
  }
  function tileSwatch(ch, th) {
    return swatch('t' + ch + th.id, () => { SR.setThemes(B.w.themes); SR.drawTile({ tile: (x, y) => (x === 0 && y === 0 ? ch : '.'), theme: () => th, t: 0.4, rustle: null, gateOpen: () => false }, 0, 0, 0, 0, 48, []); });
  }
  function thingSwatch(type) {
    const th = themeOfZone(map().zone);
    return swatch('k' + type + th.id, (g, lights) => {
      SR.setThemes(B.w.themes);
      const v = { tile: () => '.', theme: () => th, t: 0.4, rustle: null, gateOpen: () => false };
      SR.drawTile(v, 0, 0, 0, 0, 48, lights);
      if (type === 'person') SR.drawPerson(0, 4, 48, SR.personPal('folk'), 'down', 0, 'folk');
      else if (type === 'trainer') SR.drawPerson(0, 4, 48, SR.personPal('op', null, th), 'down', 0, 'op');
      else if (type === 'start') SR.drawPerson(0, 4, 48, SR.personPal('player'), 'down', 0, 'player');
      else if (type === 'trigger') { g.strokeStyle = '#b48cff'; g.setLineDash([5, 4]); g.lineWidth = 3; g.strokeRect(6, 6, 36, 36); g.setLineDash([]); g.fillStyle = '#b48cff'; g.font = 'bold 22px sans-serif'; g.textAlign = 'center'; g.fillText('!', 24, 32); }
      else SR.drawThing(v, { type, x: 0, y: 0, look: type === 'warp' ? 'door' : type === 'chest' ? 'chest' : 'boulder' }, 0, 0, 48, lights, false);
    });
  }
  function palette() {
    const el = q('#bPal');
    const th = themeOfZone(map().zone);
    if (B.tool === 'things') {
      const types = SC.THING_TYPES.concat(['start']);
      el.innerHTML = `<div class="b-grp">${types.map(t => `<button class="b-sw${B.place === t ? ' on' : ''}" data-place="${t}" title="${esc(t === 'start' ? 'Where a new game starts' : SC.THING[t][1])}"><img src="${thingSwatch(t)}" alt="" style="width:100%;height:100%;image-rendering:pixelated"><span class="lab">${t === 'start' ? 'Start' : SC.THING[t][0]}</span></button>`).join('')}</div>`;
      return;
    }
    if (B.layer === 'zones') {
      el.innerHTML = B.lead + `<div class="b-grp"><button class="b-sw txt${B.mark === '.' ? ' on' : ''}" data-mark="." title="The map's own zone">${esc((zoneOf(map().zone) || { name: 'Map zone' }).name)} (map)</button>` +
        B.w.zones.map(z => `<button class="b-sw txt${B.mark === z.mark ? ' on' : ''}" data-mark="${esc(z.mark)}" style="border-left:6px solid ${zoneColor(z.id)}">${esc(z.name)}</button>`).join('') +
        '<button class="b-sw txt" data-a="new-zone">+ Zone</button></div>';
      return;
    }
    el.innerHTML = B.lead + SC.TILE_GROUPS.map(([g, label]) => `<div class="b-grp" title="${esc(label)}">${Object.keys(TILES).filter(ch => TILES[ch].group === g).map(ch => `<button class="b-sw${B.tile === ch ? ' on' : ''}" data-tile="${esc(ch)}" title="${esc(TILES[ch].name + (TILES[ch].help ? ': ' + TILES[ch].help : ''))}"><img src="${tileSwatch(ch, th)}" alt="" style="width:100%;height:100%;image-rendering:pixelated"><span class="lab">${esc(TILES[ch].name.replace(/ \(.*\)/, ''))}</span></button>`).join('')}</div>`).join('');
    const on = el.querySelector('.on'); if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  function hint(html) {
    const h = q('#bHint');
    if (!html) { h.classList.add('hidden'); return; }
    h.innerHTML = html; h.classList.remove('hidden');
  }

  // ---------------------------------------------------------------- drawing
  const lights = [];
  const view = { tile: tileAt, theme: (x, y) => themeOfZone(zoneIdAt(x, y)), t: 0, rustle: null, gateOpen: () => false };
  function lowDetail() {
    if (B.low) return B.low;
    const m = map(), s = size(m), c = document.createElement('canvas');
    c.width = s.w; c.height = s.h;
    const g = c.getContext('2d');
    for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) { g.fillStyle = WR.tileColor(B.grid[y][x], themeOfZone(zoneIdAt(x, y))); g.fillRect(x, y, 1, 1); }
    return (B.low = c);
  }
  function frame(dt, t) {
    if (!B.w) return;
    const Wc = cv.width, Hc = cv.height, s = B.cam.s, m = map(), sz = size(m);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#04060c'; ctx.fillRect(0, 0, Wc, Hc);
    const ox = Math.round(Wc / 2 - B.cam.x * s), oy = Math.round(Hc / 2 - B.cam.y * s);
    const x0 = Math.max(0, Math.floor(-ox / s)), y0 = Math.max(0, Math.floor(-oy / s));
    const x1 = Math.min(sz.w - 1, Math.ceil((Wc - ox) / s)), y1 = Math.min(sz.h - 1, Math.ceil((Hc - oy) / s));
    view.t = t; lights.length = 0;
    const low = s < 10;
    if (low) ctx.drawImage(lowDetail(), ox, oy, sz.w * s, sz.h * s);
    else for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) R.drawTile(view, x, y, ox + x * s, oy + y * s, s, lights);
    // things (people over the rest, rows in order)
    const u = s / 16;
    const list = m.things.slice().sort((a, b) => a.y - b.y);
    for (const th of list) {
      if (th.x < x0 - 1 || th.x > x1 + 1 || th.y < y0 - 1 || th.y > y1 + 1) continue;
      const sx = ox + th.x * s, sy = oy + th.y * s;
      if (low) { ctx.fillStyle = th.type === 'warp' ? '#46f3ff' : th.type === 'trainer' ? '#ff8a5a' : '#e8eeff'; ctx.fillRect(sx, sy, s, s); continue; }
      if (th.type === 'person' || th.type === 'trainer') {
        const kind = th.type === 'person' ? 'folk' : th.warden ? 'warden' : 'op';
        R.drawPerson(sx, sy, s, R.personPal(kind, th.color || null, themeOfZone(zoneIdAt(th.x, th.y))), th.facing || 'down', 0, kind, 0);
      } else if ((th.type === 'warp' && th.look === 'hidden') || th.type === 'trigger') {
        ctx.strokeStyle = th.type === 'warp' ? '#46f3ff' : '#b48cff'; ctx.lineWidth = Math.max(1, u); ctx.setLineDash([3 * u, 2 * u]);
        ctx.strokeRect(sx + u, sy + u, s - 2 * u, s - 2 * u); ctx.setLineDash([]);
        ctx.fillStyle = ctx.strokeStyle; ctx.font = `bold ${Math.round(9 * u)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(THING_ICON[th.type], sx + s / 2, sy + s / 2);
      } else R.drawThing(view, th, sx, sy, s, lights, false);
      if (th.if && s >= 14) { ctx.fillStyle = '#ffd23d'; ctx.beginPath(); ctx.arc(sx + s - 3 * u, sy + 3 * u, 2.6 * u, 0, 7); ctx.fill(); ctx.fillStyle = '#0b0e18'; ctx.font = `bold ${Math.round(4 * u)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('?', sx + s - 3 * u, sy + 3.2 * u); }
    }
    // the start
    if (B.w.start.map === m.id) {
      const sx = ox + B.w.start.x * s, sy = oy + B.w.start.y * s;
      if (!low) { ctx.globalAlpha = 0.85; R.drawPerson(sx, sy, s, R.personPal('player'), B.w.start.facing || 'down', 0, 'player', 0); ctx.globalAlpha = 1; }
      ctx.strokeStyle = '#ffd23d'; ctx.lineWidth = 2; ctx.strokeRect(sx + 1, sy + 1, s - 2, s - 2);
      if (s >= 20) { ctx.fillStyle = '#ffd23d'; ctx.font = `bold ${Math.max(9, Math.round(s * 0.28))}px sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText('⚑ START', sx + 2, sy + s + 1); }
    }
    if (!low) R.flushLights(lights);
    // zone layer
    if (B.layer === 'zones') {
      ctx.globalAlpha = 0.32;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { ctx.fillStyle = zoneColor(zoneIdAt(x, y)); ctx.fillRect(ox + x * s, oy + y * s, s, s); }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#ffffffaa'; ctx.lineWidth = Math.max(1, s / 16);
      ctx.beginPath();
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const z = zoneIdAt(x, y);
        if (x < sz.w - 1 && zoneIdAt(x + 1, y) !== z) { ctx.moveTo(ox + (x + 1) * s, oy + y * s); ctx.lineTo(ox + (x + 1) * s, oy + (y + 1) * s); }
        if (y < sz.h - 1 && zoneIdAt(x, y + 1) !== z) { ctx.moveTo(ox + x * s, oy + (y + 1) * s); ctx.lineTo(ox + (x + 1) * s, oy + (y + 1) * s); }
      }
      ctx.stroke();
    }
    // grid
    if (s >= 16) {
      ctx.strokeStyle = 'rgba(255,255,255,.09)'; ctx.lineWidth = 1; ctx.beginPath();
      for (let x = x0; x <= x1 + 1; x++) { ctx.moveTo(ox + x * s + 0.5, oy + y0 * s); ctx.lineTo(ox + x * s + 0.5, oy + (y1 + 1) * s); }
      for (let y = y0; y <= y1 + 1; y++) { ctx.moveTo(ox + x0 * s, oy + y * s + 0.5); ctx.lineTo(ox + (x1 + 1) * s, oy + y * s + 0.5); }
      ctx.stroke();
    }
    ctx.strokeStyle = '#46f3ff66'; ctx.lineWidth = 1; ctx.strokeRect(ox - 0.5, oy - 0.5, sz.w * s + 1, sz.h * s + 1);
    // labels
    if (s >= 26) {
      ctx.font = `600 ${Math.round(clamp(s * 0.26, 10, 14))}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      for (const th of list) {
        const label = th.name || (th.type === 'warp' ? '→ ' + ((B.w.maps.find(mm => mm.id === (th.to || {}).map) || { name: '?' }).name) : th.type === 'sign' ? 'Sign' : th.type === 'chest' ? 'Chest' : th.type === 'block' ? '' : '');
        if (!label) continue;
        const sx = ox + th.x * s + s / 2, sy = oy + th.y * s + s + 1;
        const wv = ctx.measureText(label).width + 8;
        ctx.fillStyle = '#0b0e18cc'; ctx.fillRect(sx - wv / 2, sy, wv, Math.round(clamp(s * 0.26, 10, 14)) + 4);
        ctx.fillStyle = th.type === 'trainer' ? '#ffb08a' : th.type === 'warp' ? '#7ff6ff' : '#e8eeff'; ctx.fillText(label, sx, sy + 2);
      }
    }
    // selection, warp link, hover and shapes
    const sel = B.sel && m.things.find(t => t.id === B.sel);
    if (sel) {
      const pulse = 0.6 + 0.4 * Math.sin(t * 6);
      ctx.strokeStyle = `rgba(255,210,61,${pulse})`; ctx.lineWidth = 3; ctx.strokeRect(ox + sel.x * s - 2, oy + sel.y * s - 2, s + 4, s + 4);
      if (sel.type === 'warp' && sel.to && sel.to.map === m.id) {
        ctx.strokeStyle = '#46f3ffcc'; ctx.lineWidth = 2; ctx.setLineDash([6, 5]);
        ctx.beginPath(); ctx.moveTo(ox + sel.x * s + s / 2, oy + sel.y * s + s / 2); ctx.lineTo(ox + sel.to.x * s + s / 2, oy + sel.to.y * s + s / 2); ctx.stroke(); ctx.setLineDash([]);
        ctx.strokeRect(ox + sel.to.x * s + 3, oy + sel.to.y * s + 3, s - 6, s - 6);
      }
    }
    if (B.picking && B.picking.kind === 'warp') {
      const f = findThing(B.picking.id);
      if (f && f.m.id === m.id) { ctx.strokeStyle = '#46f3ff'; ctx.lineWidth = 2; ctx.strokeRect(ox + f.t.x * s + 1, oy + f.t.y * s + 1, s - 2, s - 2); }
    }
    if (B.rect) {
      const r = normRect(B.rect);
      ctx.fillStyle = B.layer === 'zones' ? 'rgba(255,255,255,.15)' : 'rgba(70,243,255,.18)';
      ctx.fillRect(ox + r.x0 * s, oy + r.y0 * s, (r.x1 - r.x0 + 1) * s, (r.y1 - r.y0 + 1) * s);
      ctx.strokeStyle = '#46f3ff'; ctx.lineWidth = 2; ctx.strokeRect(ox + r.x0 * s, oy + r.y0 * s, (r.x1 - r.x0 + 1) * s, (r.y1 - r.y0 + 1) * s);
    } else if (B.hover && (B.tool === 'paint' || B.tool === 'fill' || B.tool === 'pick' || B.tool === 'things' || B.tool === 'rect' || B.tool === 'room')) {
      const n = B.tool === 'paint' ? B.brush : 1, o = Math.floor((n - 1) / 2);
      ctx.strokeStyle = '#ffffffcc'; ctx.lineWidth = 1.5; ctx.strokeRect(ox + (B.hover.x - o) * s + 0.5, oy + (B.hover.y - o) * s + 0.5, n * s - 1, n * s - 1);
    }
  }

  // ---------------------------------------------------------------- camera
  function centerOn(x, y) { B.cam.x = x + 0.5; B.cam.y = y + 0.5; }
  function fitMap() {
    const s = size(map());
    const k = Math.min((cv.width - 20) / s.w, (cv.height - 200) / s.h);
    B.cam.s = clamp(Math.floor(k), 4, 48);
    B.cam.x = s.w / 2; B.cam.y = s.h / 2;
  }
  function toTile(px, py) {
    const r = cv.getBoundingClientRect(), s = B.cam.s;
    const x = (px - r.left) * (cv.width / r.width), y = (py - r.top) * (cv.height / r.height);
    return { x: Math.floor((x - cv.width / 2) / s + B.cam.x), y: Math.floor((y - cv.height / 2) / s + B.cam.y), sx: x, sy: y };
  }
  function zoomAt(k, px, py) {
    const before = toTile(px, py), s0 = B.cam.s, s1 = clamp(s0 * k, 4, 72);
    if (s1 === s0) return;
    const r = cv.getBoundingClientRect(), x = (px - r.left) * (cv.width / r.width), y = (py - r.top) * (cv.height / r.height);
    const wx = (x - cv.width / 2) / s0 + B.cam.x, wy = (y - cv.height / 2) / s0 + B.cam.y;
    B.cam.s = s1;
    B.cam.x = wx - (x - cv.width / 2) / s1; B.cam.y = wy - (y - cv.height / 2) / s1;
    void before;
  }
  function goMap(id, at) {
    if (!B.w.maps.some(m => m.id === id)) return;
    if (B.mapId !== id) { B.mapId = id; loadGrids(); }
    if (at) { centerOn(at.x, at.y); if (B.cam.s < 20) B.cam.s = 32; } else fitMap();
    chrome();
    if (B.drawer === 'maps') drawer();
  }

  // ---------------------------------------------------------------- editing tiles and zones
  function setCell(x, y) {
    if (!inMap(x, y)) return false;
    if (B.layer === 'zones') { if (B.zgrid[y][x] === B.mark) return false; B.zgrid[y][x] = B.mark; return true; }
    if (B.grid[y][x] === B.tile) return false;
    B.grid[y][x] = B.tile; return true;
  }
  function stamp(x, y) {
    const n = B.brush, o = Math.floor((n - 1) / 2);
    let any = false;
    for (let dy = 0; dy < n; dy++) for (let dx = 0; dx < n; dx++) any = setCell(x - o + dx, y - o + dy) || any;
    if (any) B.low = null;
  }
  function line(a, b, fn) {
    let x = a.x, y = a.y;
    const dx = Math.abs(b.x - x), dy = -Math.abs(b.y - y), sx = x < b.x ? 1 : -1, sy = y < b.y ? 1 : -1;
    let err = dx + dy;
    for (let i = 0; i < 400; i++) { fn(x, y); if (x === b.x && y === b.y) break; const e2 = 2 * err; if (e2 >= dy) { err += dy; x += sx; } if (e2 <= dx) { err += dx; y += sy; } }
  }
  const normRect = r => ({ x0: Math.min(r.a.x, r.b.x), y0: Math.min(r.a.y, r.b.y), x1: Math.max(r.a.x, r.b.x), y1: Math.max(r.a.y, r.b.y) });
  function applyRect(rect, room) {
    const r = normRect(rect);
    for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) {
      if (!inMap(x, y)) continue;
      if (room && B.layer === 'tiles') {
        const edge = x === r.x0 || x === r.x1 || y === r.y0 || y === r.y1;
        B.grid[y][x] = edge ? '#' : (solid(B.tile) ? '.' : B.tile);
      } else setCell(x, y);
    }
    writeGrids();
    commit(room ? 'room' : 'rect');
  }
  function flood(x, y) {
    if (!inMap(x, y)) return;
    const g = B.layer === 'zones' ? B.zgrid : B.grid, want = B.layer === 'zones' ? B.mark : B.tile, from = g[y][x];
    if (from === want) return;
    const s = size(map()), stack = [[x, y]];
    let n = 0;
    while (stack.length && n < 40000) {
      const [cx, cy] = stack.pop();
      if (cx < 0 || cy < 0 || cx >= s.w || cy >= s.h || g[cy][cx] !== from) continue;
      g[cy][cx] = want; n++;
      stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
    writeGrids(); commit('fill');
  }
  function pickAt(x, y) {
    if (!inMap(x, y)) return;
    if (B.layer === 'zones') { B.mark = B.zgrid[y][x]; G.toast(`Picked the zone <b>${esc((zoneOf(zoneIdAt(x, y)) || {}).name || '')}</b>.`); }
    else { B.tile = B.grid[y][x]; G.toast(`Picked <b>${esc(TILES[B.tile] ? TILES[B.tile].name : B.tile)}</b>.`); }
    B.tool = 'paint'; chrome();
  }

  // ---------------------------------------------------------------- things
  function defaultsFor(type, x, y) {
    const id = uid(type), zid = zoneIdAt(x, y), z = zoneOf(zid);
    const key = (z && z.wild[0] && z.wild[0].key) || (B.w.starters[0] && B.w.starters[0].key) || 'FF';
    switch (type) {
      case 'person': return { id, type, x, y, name: 'Someone', facing: 'down', lines: ['Hello there!'] };
      case 'trainer': return { id, type, x, y, name: 'Operator', facing: 'down', sight: 3, team: [{ key, level: z && z.wild[0] ? z.wild[0].max + 1 : 5 }], intro: 'You look like you want a battle!', outro: 'Good battle. You win this one.' };
      case 'sign': return { id, type, x, y, lines: ['Write something here.'] };
      case 'chest': return { id, type, x, y, look: 'chest', gives: { lattices: 2 } };
      case 'warp': return { id, type, x, y, look: 'door', to: { map: B.mapId, x, y, facing: 'down' } };
      case 'trigger': return { id, type, x, y, lines: ['Something stirs.'], if: '!' + id + '-done', sets: id + '-done' };
      case 'block': return { id, type, x, y, look: 'boulder', lines: ['It won\'t budge.'] };
      default: return null;
    }
  }
  const canStand = (type, x, y) => !(SC.BLOCKING.has(type) && type !== 'block' && solid(tileAt(x, y))) && !(type === 'trigger' && solid(tileAt(x, y)));
  function place(type, x, y) {
    if (!inMap(x, y)) return;
    if (type === 'start') {
      if (solid(tileAt(x, y)) || thingAt(x, y)) return G.toast('The start needs an empty floor tile.', 'bad');
      B.w.start = { map: B.mapId, x, y, facing: B.w.start.facing || 'down' }; commit('start'); return G.toast('A new game starts here now.');
    }
    const here = thingAt(x, y);
    if (here) return select(here.id);
    if (!canStand(type, x, y)) return G.toast(`${SC.THING[type][0]}s stand on open ground: this tile is ${TILES[tileAt(x, y)].name.toLowerCase()}.`, 'bad');
    const t = defaultsFor(type, x, y);
    map().things.push(t);
    commit('add');
    select(t.id);
    if (type === 'warp') startPick({ kind: 'warp', id: t.id });
  }
  function moveThing(t, x, y) {
    if (!inMap(x, y) || (t.x === x && t.y === y)) return false;
    const other = thingAt(x, y);
    if (other && other !== t) return false;
    if (!canStand(t.type, x, y)) return false;
    t.x = x; t.y = y; return true;
  }
  function removeThing(id) {
    const f = findThing(id); if (!f) return;
    f.m.things.splice(f.m.things.indexOf(f.t), 1);
    if (B.sel === id) { B.sel = null; closeSheet(); }
    commit('remove');
  }
  function duplicateThing(id) {
    const f = findThing(id); if (!f) return;
    const s = size(f.m);
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [2, 0], [0, 2]]) {
      const x = f.t.x + dx, y = f.t.y + dy;
      if (x < 0 || y < 0 || x >= s.w || y >= s.h || f.m.things.some(t => t.x === x && t.y === y) || !canStand(f.t.type, x, y)) continue;
      const copy = Object.assign(clone(f.t), { id: uid(f.t.type), x, y });
      f.m.things.push(copy); commit('duplicate'); select(copy.id); return;
    }
    G.toast('There is no free tile next to it.', 'bad');
  }
  // a warp back from where this warp leads, to the tile in front of this warp
  function wayBack(id) {
    const f = findThing(id); if (!f || !f.t.to) return;
    const to = f.t.to, D = B.w.maps.find(m => m.id === to.map); if (!D) return;
    const face = to.facing || 'down', back = OPP[face], [bx, by] = DIRV[back], ds = size(D);
    let x = to.x + bx, y = to.y + by;
    if (x < 0 || y < 0 || x >= ds.w || y >= ds.h || D.things.some(t => t.x === x && t.y === y)) { x = to.x; y = to.y; }
    if (D.things.some(t => t.x === x && t.y === y)) return G.toast('Something already stands where the way back would go.', 'bad');
    const [fx, fy] = DIRV[back];
    const S0 = size(f.m);
    const tx = clamp(f.t.x + fx, 0, S0.w - 1), ty = clamp(f.t.y + fy, 0, S0.h - 1);
    const w = { id: uid('warp'), type: 'warp', x, y, look: f.t.look === 'stairs' ? 'stairs' : f.t.look === 'hidden' ? 'hidden' : 'door', to: { map: f.m.id, x: tx, y: ty, facing: back } };
    D.things.push(w); commit('way back');
    G.toast(`Added a way back on ${esc(D.name)}.`);
  }

  // ---------------------------------------------------------------- picking a spot (warp targets, moving)
  function startPick(p) {
    B.picking = p;
    B.sheet = null; closeSheet();
    const what = { warp: 'Tap where this warp leads (switch maps at the top if it goes somewhere else).', move: 'Tap where it should stand.', start: 'Tap where a new game starts.' }[p.kind];
    hint(`<span>${esc(what)}</span><button class="bw-btn small" data-a="pick-cancel">Cancel</button>`);
  }
  function endPick(x, y) {
    const p = B.picking; B.picking = null; hint(null);
    if (!p || x == null) return;
    if (p.kind === 'warp') {
      const f = findThing(p.id); if (!f) return;
      if (solid(tileAt(x, y)) && !thingAt(x, y)) G.toast('Heads up: that tile is solid, so the player would land inside it.', 'bad');
      f.t.to = { map: B.mapId, x, y, facing: f.t.to && f.t.to.facing || 'down' };
      commit('warp target');
      if (f.m.id !== B.mapId) G.toast(`The warp now leads to ${esc(map().name)} ${x},${y}. <b>Way back</b> in its panel adds the return trip.`);
      goMap(f.m.id, f.t); select(p.id);
      return;
    }
    if (p.kind === 'move') {
      const f = findThing(p.id); if (!f) return;
      if (f.m.id !== B.mapId) { if (thingAt(x, y) || !canStand(f.t.type, x, y)) return G.toast('It can\'t stand there.', 'bad'); f.m.things.splice(f.m.things.indexOf(f.t), 1); map().things.push(f.t); f.t.x = x; f.t.y = y; }
      else if (!moveThing(f.t, x, y)) return G.toast('It can\'t stand there.', 'bad');
      commit('move'); select(p.id); return;
    }
    if (p.kind === 'start') place('start', x, y);
  }

  // ---------------------------------------------------------------- pointer and keyboard input
  const pointers = new Map();
  let gesture = null;
  const active = () => G.mode === 'build' && ui && !ui.classList.contains('hidden');
  cv.addEventListener('pointerdown', e => {
    if (!active()) return;
    e.preventDefault();
    try { cv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) { cancelStroke(); const [a, b] = [...pointers.values()]; gesture = { kind: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }; return; }
    if (pointers.size > 2) return;
    const tl = toTile(e.clientX, e.clientY);
    const panButton = e.button === 1 || e.button === 2 || spaceHeld;
    if (panButton) { gesture = { kind: 'pan', x: e.clientX, y: e.clientY, cx: B.cam.x, cy: B.cam.y }; return; }
    gesture = { kind: 'tap', x: e.clientX, y: e.clientY, t0: performance.now(), tile: tl, moved: false };
    if (B.picking) { gesture.kind = 'pan'; gesture.cx = B.cam.x; gesture.cy = B.cam.y; return; }
    if (B.tool === 'paint') { gesture.kind = 'paint'; gesture.before = null; gesture.last = tl; stamp(tl.x, tl.y); }
    else if (B.tool === 'rect' || B.tool === 'room') { gesture.kind = 'rect'; B.rect = { a: tl, b: tl }; }
    else if (B.tool === 'hand' || B.tool === 'things') {
      const t = thingAt(tl.x, tl.y);
      const onStart = B.w.start.map === B.mapId && B.w.start.x === tl.x && B.w.start.y === tl.y;
      if (t && (B.tool === 'hand' || B.sel === t.id)) { gesture.kind = 'drag'; gesture.thing = t; gesture.from = { x: t.x, y: t.y }; }
      else if (onStart && B.tool === 'hand') { gesture.kind = 'drag-start'; }
      else if (B.tool === 'hand') { gesture.kind = 'pan'; gesture.cx = B.cam.x; gesture.cy = B.cam.y; }
    }
  });
  cv.addEventListener('pointermove', e => {
    if (!active()) return;
    const tl = toTile(e.clientX, e.clientY);
    if (e.pointerType === 'mouse') { B.hover = inMap(tl.x, tl.y) ? tl : null; }
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!gesture) return;
    if (gesture.kind === 'pinch' && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (gesture.d > 10) zoomAt(d / gesture.d, mx, my);
      const r = cv.getBoundingClientRect(), k = cv.width / r.width;
      B.cam.x -= (mx - gesture.mx) * k / B.cam.s; B.cam.y -= (my - gesture.my) * k / B.cam.s;
      gesture.d = d; gesture.mx = mx; gesture.my = my;
      return;
    }
    const far = Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y) > 8;
    if (far) gesture.moved = true;
    if (gesture.kind === 'pan') {
      const r = cv.getBoundingClientRect(), k = cv.width / r.width;
      B.cam.x = gesture.cx - (e.clientX - gesture.x) * k / B.cam.s; B.cam.y = gesture.cy - (e.clientY - gesture.y) * k / B.cam.s;
    } else if (gesture.kind === 'paint') {
      if (tl.x !== gesture.last.x || tl.y !== gesture.last.y) { line(gesture.last, tl, (x, y) => stamp(x, y)); gesture.last = tl; }
    } else if (gesture.kind === 'rect') { B.rect.b = tl; }
    else if (gesture.kind === 'drag' && gesture.moved) { moveThing(gesture.thing, tl.x, tl.y); }
    else if (gesture.kind === 'drag-start' && gesture.moved) { if (inMap(tl.x, tl.y) && !solid(tileAt(tl.x, tl.y)) && !thingAt(tl.x, tl.y)) { B.w.start.x = tl.x; B.w.start.y = tl.y; } }
    else if (gesture.kind === 'tap' && far && B.tool === 'things') { gesture.kind = 'pan'; gesture.cx = B.cam.x; gesture.cy = B.cam.y; gesture.x = e.clientX; gesture.y = e.clientY; }
  });
  function endPointer(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (!gesture) return;
    if (gesture.kind === 'pinch') { if (pointers.size === 0) gesture = null; return; }
    const g = gesture; gesture = null;
    if (e.type === 'pointercancel') { if (g.kind === 'paint') cancelStroke(g); B.rect = null; return; }
    const tl = toTile(e.clientX, e.clientY);
    if (B.picking && !g.moved) return endPick(tl.x, tl.y);
    switch (g.kind) {
      case 'paint': writeGrids(); commit('paint'); break;
      case 'rect': B.rect = null; applyRect({ a: g.tile, b: tl }, B.tool === 'room'); break;
      case 'drag':
        if (g.moved) { commit('move'); select(g.thing.id); } else select(g.thing.id);
        break;
      case 'drag-start': if (g.moved) commit('start'); break;
      case 'tap':
        if (g.moved) break;
        if (B.tool === 'fill') flood(tl.x, tl.y);
        else if (B.tool === 'pick') pickAt(tl.x, tl.y);
        else if (B.tool === 'things') place(B.place, tl.x, tl.y);
        else if (B.tool === 'hand') { const t = thingAt(tl.x, tl.y); if (t) select(t.id); else if (B.sel) { B.sel = null; closeSheet(); } }
        break;
      case 'pan':
        if (!g.moved && B.tool === 'hand') { const t = thingAt(tl.x, tl.y); if (t) select(t.id); else if (B.sel) { B.sel = null; closeSheet(); } }
        if (!g.moved && B.tool === 'things') place(B.place, tl.x, tl.y);
        break;
      default:
    }
  }
  function cancelStroke(g) {
    g = g || gesture;
    if (g && g.kind === 'paint') loadGrids();
    B.rect = null;
    if (g && g.kind === 'drag' && g.from) { g.thing.x = g.from.x; g.thing.y = g.from.y; }
    gesture = null;
  }
  cv.addEventListener('pointerup', endPointer);
  cv.addEventListener('pointercancel', endPointer);
  cv.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') B.hover = null; });
  cv.addEventListener('wheel', e => { if (!active()) return; e.preventDefault(); zoomAt(Math.exp(-e.deltaY * 0.0022), e.clientX, e.clientY); }, { passive: false });
  let spaceHeld = false;
  addEventListener('keydown', e => {
    if (!active()) return;
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) { if (e.key === 'Escape') e.target.blur(); return; }
    if (document.querySelector('.b-modal') || !document.getElementById('modal').classList.contains('hidden')) { if (e.key === 'Escape') { const m = document.querySelector('.b-modal'); if (m) m.remove(); } return; }
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); redo(); return; }
    if (mod) return;
    if (e.key === ' ') { spaceHeld = true; e.preventDefault(); return; }
    if (e.key === 'Escape') { if (B.picking) { B.picking = null; hint(null); } else if (!q('#bDrawer').classList.contains('hidden')) closeDrawer(); else if (B.sel) { B.sel = null; closeSheet(); } return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && B.sel) { removeThing(B.sel); return; }
    const tools = { v: 'hand', h: 'hand', b: 'paint', r: 'rect', o: 'room', f: 'fill', i: 'pick', t: 'things' };
    if (tools[k]) { setTool(tools[k]); return; }
    if (k === 'z') { B.layer = B.layer === 'zones' ? 'tiles' : 'zones'; if (B.tool === 'things' || B.tool === 'hand') B.tool = 'paint'; chrome(); return; }
    if (k === 'p') { playMenu(); return; }
    if (k === 'm') { openDrawer(B.tab); return; }
    if (k === '[' || k === '-') { B.cam.s = clamp(B.cam.s / 1.25, 4, 72); return; }
    if (k === ']' || k === '=' || k === '+') { B.cam.s = clamp(B.cam.s * 1.25, 4, 72); return; }
    if (k >= '1' && k <= '3') { B.brush = +k; chrome(); return; }
    const pan = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] }[k];
    if (pan) { e.preventDefault(); B.cam.x += pan[0] * 3; B.cam.y += pan[1] * 3; }
  });
  addEventListener('keyup', e => { if (e.key === ' ') spaceHeld = false; });
  function setTool(t) {
    B.tool = t;
    if (t === 'room' || t === 'things') B.layer = 'tiles';
    if (t !== 'things' && B.picking && B.picking.kind === 'start') { B.picking = null; hint(null); }
    chrome();
  }

  // ---------------------------------------------------------------- clicks in the builder's panels
  async function onClick(e) {
    const b = e.target.closest('button, [data-a]');
    if (!b || !ui.contains(b)) return;
    const d = b.dataset;
    if (d.tool) return setTool(d.tool);
    if (d.layer) { B.layer = d.layer; if (B.tool === 'things' || B.tool === 'room') B.tool = 'paint'; if (B.tool === 'hand') B.tool = 'paint'; return chrome(); }
    if (d.tile != null) { B.tile = d.tile; if (!['paint', 'rect', 'room', 'fill'].includes(B.tool)) B.tool = 'paint'; return chrome(); }
    if (d.mark != null) { B.mark = d.mark; if (!['paint', 'rect', 'fill'].includes(B.tool)) B.tool = 'paint'; return chrome(); }
    if (d.place) { B.place = d.place; B.tool = 'things'; chrome(); if (d.place === 'start') G.toast('Tap a floor tile: a new game starts there.'); return; }
    if (d.tab) { B.tab = d.tab; return drawer(); }
    const a = d.a;
    if (!a) return;
    switch (a) {
      case 'menu': return openDrawer(B.tab);
      case 'drawer-close': return closeDrawer();
      case 'sheet-close': B.sel = null; return closeSheet();
      case 'undo': return undo();
      case 'redo': return redo();
      case 'issues': return openDrawer('problems');
      case 'play': return playMenu(b);
      case 'brush': B.brush = B.brush % 3 + 1; return chrome();
      case 'pick-cancel': B.picking = null; return hint(null);
      case 'new-zone': return newZone();
      default: return panelAction(a, b, e);
    }
  }
  // edits typed into a form: the path is relative to what the form edits (data-p), the target in data-o
  function target(el) {
    const o = el.closest('[data-o]'); if (!o) return null;
    const spec = o.dataset.o;
    if (spec === 'world') return B.w;
    if (spec.startsWith('thing:')) { const f = findThing(spec.slice(6)); return f && f.t; }
    if (spec.startsWith('zone:')) return zoneOf(spec.slice(5));
    if (spec.startsWith('theme:')) return B.w.themes.find(t => t.id === spec.slice(6));
    if (spec.startsWith('map:')) return B.w.maps.find(m => m.id === spec.slice(4));
    if (spec.startsWith('starter:')) return B.w.starters.find(s => s.key === spec.slice(8));
    if (spec.startsWith('merge:')) { const k = spec.slice(6); B.w.merges = B.w.merges || {}; return (B.w.merges[k] = B.w.merges[k] || {}); }
    return null;
  }
  function setPath(obj, path, value) {
    const segs = path.split('.');
    let cur = obj;
    for (let i = 0; i < segs.length - 1; i++) { const s = segs[i]; if (cur[s] == null || typeof cur[s] !== 'object') cur[s] = /^\d+$/.test(segs[i + 1]) ? [] : {}; cur = cur[s]; }
    const last = segs[segs.length - 1];
    if (value === undefined) { if (Array.isArray(cur)) cur.splice(+last, 1); else delete cur[last]; } else cur[last] = value;
  }
  function valueOf(el) {
    const kind = el.dataset.k || el.type;
    if (kind === 'checkbox') return el.checked ? true : undefined;
    if (kind === 'number' || kind === 'range') { const v = el.value === '' ? undefined : Math.round(+el.value); return v === undefined || isNaN(v) ? undefined : v; }
    if (kind === 'lines') { const l = el.value.split('\n').map(s => s.trim()).filter(Boolean); return l.length ? l : undefined; }
    if (kind === 'opt') return el.value === '' ? undefined : el.value; // optional text: empty removes it
    if (kind === 'null') return el.value === '' ? null : el.value;
    return el.value;
  }
  function edit(el, rerender) {
    const obj = target(el), p = el.dataset.p;
    if (!obj || !p) return;
    let v = valueOf(el);
    if (el.dataset.k === 'text' && !String(v).trim()) return; // required text can't go empty
    if (el.dataset.min != null && v != null) v = clamp(v, +el.dataset.min, +el.dataset.max);
    setPath(obj, p, v);
    cleanup(obj);
    if (el.closest('[data-o]').dataset.o.startsWith('theme:')) { R.setThemes(B.w.themes); swCache.clear(); B.low = null; }
    if (/^(zone|map)/.test(p) || el.closest('[data-o]').dataset.o.startsWith('zone:')) B.low = null;
    commit('edit:' + el.closest('[data-o]').dataset.o + p);
    if (rerender) refreshPanels();
  }
  // leaves no empty optional objects behind (a reward with nothing in it, an empty merge edit)
  function cleanup(obj) {
    if (obj && obj.gives && typeof obj.gives === 'object') {
      if (obj.gives.motes && !Object.keys(obj.gives.motes).length) delete obj.gives.motes;
      if (!Object.keys(obj.gives).length && obj.type !== 'chest') delete obj.gives;
    }
    if (B.w.merges) { for (const [k, v] of Object.entries(B.w.merges)) if (!v || !Object.keys(v).length) delete B.w.merges[k]; if (!Object.keys(B.w.merges).length) delete B.w.merges; }
  }
  function onChange(e) {
    const el = e.target;
    if (!el.dataset) return;
    if (el.dataset.condKind != null || el.dataset.condArg != null) return condEdit(el, el.dataset.condKind != null || el.tagName === 'SELECT');
    if (el.dataset.p != null && el.id !== 'bMap') edit(el, el.type !== 'text' && el.tagName !== 'TEXTAREA' && el.type !== 'color');
  }
  function onInput(e) {
    const el = e.target;
    if (!el.dataset) return;
    if (el.dataset.condArg != null && el.tagName === 'INPUT') return condEdit(el, false);
    if (el.dataset.p != null && (el.type === 'text' || el.tagName === 'TEXTAREA' || el.type === 'range' || el.type === 'color')) edit(el, false);
    if (el.type === 'range' && el.nextElementSibling) el.nextElementSibling.textContent = el.value;
  }
  // one row of a thing's condition changed: its kind (which resets what it names) or its argument
  function condEdit(el, rerender) {
    const fnd = B.sel && findThing(B.sel); if (!fnd) return;
    const t = fnd.t, terms = SC.parseCond(t.if) || [];
    if (el.dataset.condKind != null) {
      const i = +el.dataset.condKind, [kind, not] = COND_KINDS[+el.value], old = terms[i] || {};
      // the nearest one on the same map first: "this gate opens when the trainer next to it falls"
      const first = type => { const os = allThings().filter(x => x.t.type === type && x.t.id !== t.id).sort((a, b) => (a.m.id !== fnd.m.id) - (b.m.id !== fnd.m.id) || Math.hypot(a.t.x - t.x, a.t.y - t.y) - Math.hypot(b.t.x - t.x, b.t.y - t.y)); return os.length ? os[0].t.id : ''; };
      const arg = kind === old.kind ? old.arg : kind === 'keys' ? '1' : kind === 'won' ? '' : kind === 'flag' ? 'my-flag' : first({ beat: 'trainer', open: 'chest', got: 'person' }[kind]);
      terms[i] = { kind, not, arg };
    } else {
      const i = +el.dataset.condArg, c = terms[i]; if (!c) return;
      c.arg = c.kind === 'keys' ? String(clamp(Math.round(+el.value) || 1, 1, 9)) : c.kind === 'flag' ? el.value.replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+/, '') : el.value;
    }
    setCond(t, terms);
    commit('cond:' + t.id);
    if (rerender) sheet();
  }
  function refreshPanels() { if (B.sheet) sheet(); if (B.drawer) drawer(); chrome(); }

  // ---------------------------------------------------------------- form pieces
  const f = {
    text: (label, p, v, o) => `<label class="bw-field"><span>${esc(label)}</span><input type="text" data-p="${p}" data-k="${o && o.optional ? 'opt' : 'text'}" value="${esc(v == null ? '' : v)}" maxlength="${(o && o.max) || 60}"${o && o.ph ? ` placeholder="${esc(o.ph)}"` : ''}${o && o.list ? ` list="${o.list}"` : ''}>${o && o.help ? `<small>${esc(o.help)}</small>` : ''}</label>`,
    lines: (label, p, v, help) => `<label class="bw-field"><span>${esc(label)}</span><textarea data-p="${p}" data-k="lines" rows="3">${esc((v || []).join('\n'))}</textarea><small>${esc(help || 'One line per box of dialog.')}</small></label>`,
    num: (label, p, v, min, max, help) => `<label class="bw-field"><span>${esc(label)}</span><input type="number" data-p="${p}" data-min="${min}" data-max="${max}" min="${min}" max="${max}" value="${v == null ? '' : v}">${help ? `<small>${esc(help)}</small>` : ''}</label>`,
    range: (label, p, v, min, max, help) => `<label class="bw-field"><span>${esc(label)}</span><div class="bw-row"><input type="range" data-p="${p}" min="${min}" max="${max}" value="${v || 0}" style="flex:1"><b>${v || 0}</b></div>${help ? `<small>${esc(help)}</small>` : ''}</label>`,
    check: (label, p, v, help) => `<label class="bw-check"><input type="checkbox" data-p="${p}" ${v ? 'checked' : ''}><span>${esc(label)}${help ? `<br><small class="bw-dim">${esc(help)}</small>` : ''}</span></label>`,
    select: (label, p, v, opts, help, nullable) => `<label class="bw-field"><span>${esc(label)}</span><select data-p="${p}"${nullable ? ' data-k="null"' : opts.some(o => o[0] === '') ? ' data-k="opt"' : ''}>${opts.map(([val, lab]) => `<option value="${esc(val)}"${String(v == null ? '' : v) === String(val) ? ' selected' : ''}>${esc(lab)}</option>`).join('')}</select>${help ? `<small>${esc(help)}</small>` : ''}</label>`,
    color: (label, p, v, dflt) => `<label class="bw-field"><span>${esc(label)}</span><div class="bw-row"><input type="color" data-p="${p}" value="${esc(v || dflt || '#46f3ff')}">${v ? `<button class="bw-btn small" data-a="clear" data-clear="${p}">Usual look</button>` : '<span class="bw-dim">the usual look</span>'}</div></label>`,
    seg: (label, p, v, opts) => `<div class="bw-field"><span>${esc(label)}</span><div class="bw-seg">${opts.map(([val, lab]) => `<button type="button" class="${String(v) === String(val) ? 'on' : ''}" data-a="seg" data-p="${p}" data-v="${esc(val)}">${esc(lab)}</button>`).join('')}</div></div>`,
  };
  const facingSeg = (p, v) => f.seg('Facing', p, v || 'down', [['up', '↑ Up'], ['down', '↓ Down'], ['left', '← Left'], ['right', '→ Right']]);
  const spriteChip = (key, extra) => `<span class="bw-chip"><canvas data-sprite="${esc(key)}" width="32" height="32"></canvas>${esc(DB.has(key) ? ENG.rec(key).dName : key)}${extra || ''}</span>`;
  function flagList() {
    const set = new Set();
    for (const { t } of allThings()) { if (t.sets) set.add(t.sets); for (const c of SC.parseCond(t.if) || []) if (c.kind === 'flag') set.add(c.arg); }
    return `<datalist id="bFlags">${[...set].map(x => `<option value="${esc(x)}">`).join('')}</datalist>`;
  }

  // conditions: rows of [what] [which]
  const COND_KINDS = [['flag', false, 'Flag is set'], ['flag', true, 'Flag is not set'], ['beat', false, 'After beating'], ['beat', true, 'Before beating'], ['open', false, 'After opening'], ['open', true, 'Before opening'], ['got', false, 'After the gift from'], ['got', true, 'Before the gift from'], ['keys', false, 'With at least … keys'], ['keys', true, 'With fewer than … keys'], ['won', false, 'After the final boss'], ['won', true, 'Before the final boss']];
  function condEditor(t) {
    const terms = SC.parseCond(t.if);
    if (terms === null) return `${f.text('Only while (condition)', 'if', t.if, { optional: true, max: 200 })}<div class="bw-note bad">That condition doesn't parse. Words like flag, !flag, beat:trainer-id, keys:2.</div>`;
    const of = type => allThings().filter(o => o.t.type === type && o.t.id !== t.id).map(o => [o.t.id, o.t.name || o.t.id]);
    const row = (c, i) => {
      const kindIdx = COND_KINDS.findIndex(k => k[0] === c.kind && k[1] === c.not);
      let arg = '';
      if (c.kind === 'flag') arg = `<input type="text" class="bw-in" data-cond-arg="${i}" value="${esc(c.arg)}" list="bFlags" placeholder="flag name" style="flex:1;min-width:120px">`;
      else if (c.kind === 'keys') arg = `<input type="number" class="bw-in" data-cond-arg="${i}" value="${esc(c.arg)}" min="1" max="9" style="width:72px">`;
      else if (c.kind !== 'won') { const opts = of({ beat: 'trainer', open: 'chest', got: 'person' }[c.kind]); arg = `<select class="bw-in" data-cond-arg="${i}" style="flex:1;min-width:120px">${opts.map(([id, nm]) => `<option value="${esc(id)}"${id === c.arg ? ' selected' : ''}>${esc(nm)}</option>`).join('') || '<option value="">(none yet)</option>'}</select>`; }
      return `<div class="bw-row" style="margin:6px 0"><select class="bw-in" data-cond-kind="${i}" style="flex:1;min-width:150px">${COND_KINDS.map((k, j) => `<option value="${j}"${j === kindIdx ? ' selected' : ''}>${esc(k[2])}</option>`).join('')}</select>${arg}<button class="bw-btn small icon" data-a="cond-del" data-i="${i}" aria-label="Remove">✕</button></div>`;
    };
    return `<div class="bw-field"><span>Only while</span>${terms.length ? terms.map(row).join('') : '<small>Always there. Add a condition to make it appear or vanish with the story.</small>'}
      <div class="bw-row"><button class="bw-btn small" data-a="cond-add">+ Condition</button>${terms.length ? `<small>${esc(SC.describeCond(t.if, nameOf))}</small>` : ''}</div></div>`;
  }
  function setCond(t, terms) {
    const s = terms.filter(c => c.kind === 'won' || c.arg).map(c => (c.not ? '!' : '') + (c.kind === 'flag' ? c.arg : c.kind === 'won' ? 'won' : c.kind + ':' + c.arg)).join(' ');
    if (s) t.if = s; else delete t.if;
  }
  function rewardEditor(t, required) {
    const g = t.gives || {};
    const motes = Object.entries(g.motes || {});
    const itemName = g.item && DB.has(g.item) && window.EP.forgeItem ? window.EP.forgeItem(g.item).name : g.item;
    return `<div class="bw-field"><span>${required ? 'Inside' : 'Gives (once)'}</span>
      <div class="bw-row">${f.num('Lattices', 'gives.lattices', g.lattices, 1, 99).replace('bw-field', 'bw-field" style="flex:1')}${f.num('Flux cells', 'gives.cells', g.cells, 1, 99).replace('bw-field', 'bw-field" style="flex:1')}</div>
      <div class="bw-row">${motes.map(([k, n]) => `<span class="bw-chip" style="padding-left:10px;color:${esc(essColor(k))}">${esc(essName(k))} ×${n}<button class="bw-btn small icon" data-a="mote-del" data-e="${esc(k)}" aria-label="Remove">✕</button></span>`).join('')}<button class="bw-btn small" data-a="mote-add">+ Motes</button></div>
      <div class="bw-row" style="margin-top:6px">${g.item ? `<span class="bw-chip" style="padding-left:10px">⬡ ${esc(itemName)}<button class="bw-btn small icon" data-a="item-del" aria-label="Remove">✕</button></span>` : '<button class="bw-btn small" data-a="item-add">+ Forged item</button>'}
      ${g.daemon ? `${spriteChip(g.daemon.key, ` · Lv <input type="number" class="bw-in" data-p="gives.daemon.level" data-min="1" data-max="60" value="${g.daemon.level}" style="width:64px;min-height:30px;padding:2px 6px">`)}<button class="bw-btn small icon" data-a="daemon-del" aria-label="Remove">✕</button>` : '<button class="bw-btn small" data-a="daemon-add">+ A daemon</button>'}</div>
      <small>${required ? 'Opened once per playthrough.' : 'Given the first time only.'}</small></div>`;
  }
  const essName = c => (E.MAIN[c] || E.SUB[c] || { name: c }).name;
  const essColor = c => (E.MAIN[c] ? E.MAIN[c].color : SP.ACCENT[c] || '#ccc');

  // ---------------------------------------------------------------- the inspector
  function select(id) {
    const f0 = findThing(id); if (!f0) return;
    B.sel = id;
    if (f0.m.id !== B.mapId) goMap(f0.m.id, f0.t);
    B.sheet = 'thing';
    sheet();
  }
  function closeSheet() { B.sheet = null; if (ui) { q('#bSheet').classList.add('hidden'); ui.classList.add('nosheet'); } }
  function openSheet(title, body) {
    q('#bSheetTitle').textContent = title;
    const el = q('#bSheetBody');
    const top = el.scrollTop;
    el.innerHTML = body;
    el.scrollTop = top;
    q('#bSheet').classList.remove('hidden'); ui.classList.remove('nosheet');
    G.hydrateCanvases(el);
  }
  function sheet() {
    if (B.sheet !== 'thing') return;
    const fnd = B.sel && findThing(B.sel);
    if (!fnd) return closeSheet();
    const t = fnd.t, m = fnd.m;
    const head = `<div class="bw-row spread" style="margin:8px 0"><span class="bw-dim">${esc(SC.THING[t.type][0])} · <b>${esc(t.id)}</b> · ${esc(m.name)} ${t.x},${t.y}</span>
      <span class="bw-row"><button class="bw-btn small" data-a="t-move">Move</button><button class="bw-btn small" data-a="t-dup">Copy</button><button class="bw-btn small bad" data-a="t-del">Delete</button></span></div>`;
    let body = '';
    const cond = condEditor(t) + f.text('Sets flag', 'sets', t.sets, { optional: true, max: 40, list: 'bFlags', ph: 'e.g. met-mira', help: 'Set after it happens. Other things can check it in "Only while".' });
    switch (t.type) {
      case 'person':
        body = f.text('Name', 'name', t.name, { max: 24 }) + facingSeg('facing', t.facing) + f.color('Outfit color', 'color', t.color, '#9aa6c8') +
          f.lines('What they say', 'lines', t.lines) + f.lines('Later they say', 'after', t.after, 'Said after their gift (or once their flag is set). Leave empty to repeat the lines above.') +
          f.check('Heals your daemons', 'heal', t.heal) + rewardEditor(t) + cond;
        break;
      case 'trainer': {
        const team = t.team || [];
        body = f.text('Name', 'name', t.name, { max: 24 }) + facingSeg('facing', t.facing) + f.range('Sight (tiles)', 'sight', t.sight, 0, 8, '0: you have to talk to them. Otherwise they walk up when you cross their line of sight.') +
          f.color('Outfit color', 'color', t.color, '#46f3ff') +
          `<div class="bw-field"><span>Team (${team.length}/6)</span><div class="b-team">${team.map((mm, i) => `<div class="bw-item wrap"><canvas data-sprite="${esc(mm.key)}" width="32" height="32"></canvas><div class="grow"><b>${esc(DB.has(mm.key) ? ENG.rec(mm.key).dName : mm.key)}</b><small>${esc(mm.key)}</small></div><div class="b-nums"><span class="bw-dim">Level</span><input type="number" class="bw-in" data-p="team.${i}.level" data-min="1" data-max="60" value="${mm.level}"><button class="bw-btn small" data-a="team-swap" data-i="${i}">Change</button><button class="bw-btn small icon" data-a="team-del" data-i="${i}" aria-label="Remove"${team.length <= 1 ? ' disabled' : ''}>✕</button></div></div>`).join('')}</div>${team.length < 6 ? '<button class="bw-btn small" data-a="team-add" style="margin-top:6px">+ Daemon</button>' : ''}</div>` +
          f.text('Before the battle', 'intro', t.intro, { max: 240 }) + f.text('After you win', 'outro', t.outro, { max: 240 }) +
          f.check('Warden (wears a crown, can give a key)', 'warden', t.warden) + f.text('Key they give', 'badge', t.badge, { optional: true, max: 24, ph: 'e.g. Cinder Key', help: 'Keys open gates (the 1-9 key tiles) and count on the HUD.' }) +
          f.check('The final boss', 'final', t.final, 'Beating them wins the world: the ending plays and the Rift opens.') + rewardEditor(t) + cond;
        break;
      }
      case 'sign': body = f.lines('What it says', 'lines', t.lines) + f.text('Speaker', 'who', t.who, { optional: true, max: 24, ph: 'Sign' }) + cond; break;
      case 'chest': body = f.seg('Looks like', 'look', t.look, [['chest', 'Chest'], ['cache', 'Data cache'], ['orb', 'Orb (vanishes)']]) + rewardEditor(t, true) + cond; break;
      case 'warp': {
        const to = t.to || {}, D = B.w.maps.find(mm => mm.id === to.map);
        body = f.seg('Looks like', 'look', t.look, [['door', 'Door'], ['stairs', 'Stairs'], ['portal', 'Portal'], ['pad', 'Pad'], ['hidden', 'Hidden']]) +
          `<div class="bw-field"><span>Leads to</span><div class="bw-row"><b>${esc(D ? D.name : '(missing map)')}</b> <span class="bw-dim">${to.x},${to.y}</span></div>
          <div class="bw-row" style="margin-top:6px"><button class="bw-btn small pri" data-a="w-pick">Pick on the map</button><button class="bw-btn small" data-a="w-go">Go there</button><button class="bw-btn small" data-a="w-back">+ Way back</button></div></div>` +
          f.seg('Arrive facing', 'to.facing', to.facing || 'down', [['up', '↑'], ['down', '↓'], ['left', '←'], ['right', '→']]) +
          '<small class="bw-dim">Warps work when you step on them, even in a wall (put doors in the front wall of a house). Hidden warps are map edges and secret passages.</small>' + cond;
        break;
      }
      case 'trigger': {
        const once = t.if === '!' + t.id + '-done' && t.sets === t.id + '-done';
        body = '<p class="bw-dim">Invisible. Runs when the player steps on it.</p>' + f.lines('Lines', 'lines', t.lines, 'Optional. One line per box of dialog.') + f.text('Speaker', 'who', t.who, { optional: true, max: 24 }) +
          f.check('Runs once', 'once', once, 'Uses the flag ' + t.id + '-done.').replace('data-p="once"', 'data-a="t-once"') + f.check('Heals your daemons', 'heal', t.heal) + rewardEditor(t) + cond;
        break;
      }
      case 'block':
        body = f.seg('Looks like', 'look', t.look, [['boulder', 'Boulder'], ['crystal', 'Crystal'], ['gate', 'Gate'], ['barrier', 'Barrier'], ['tree', 'Tree'], ['pillar', 'Pillar']]) +
          f.lines('When you bump into it', 'lines', t.lines, 'Optional.') + f.text('Speaker', 'who', t.who, { optional: true, max: 24 }) + cond +
          '<small class="bw-dim">Tip: "Before beating" a trainer makes a gate that opens when they fall.</small>';
        break;
      default:
    }
    openSheet(t.name || SC.THING[t.type][0], `<div data-o="thing:${esc(t.id)}">${head}${body}${flagList()}${issuesFor(`world.maps[${m.id}].things[${t.id}]`)}</div>`);
  }
  function issuesFor(prefix) {
    const list = B.issues.filter(i => i.path === prefix || i.path.startsWith(prefix + '.') || i.path.startsWith(prefix + '['));
    return list.map(i => `<div class="bw-note ${i.level === 'error' ? 'bad' : 'warn'}">${esc(i.msg)}</div>`).join('');
  }

  // ---------------------------------------------------------------- the world menu
  const TABS = [['maps', 'Maps'], ['zones', 'Zones'], ['themes', 'Themes'], ['starters', 'Starters'], ['world', 'Story & rules'], ['names', 'Merge names'], ['problems', 'Problems'], ['share', 'Save & share']];
  function openDrawer(tab, newMap) { B.drawer = true; B.tab = tab || B.tab; B.newMap = !!newMap; q('#bDrawer').classList.remove('hidden'); drawer(); }
  function closeDrawer() { B.drawer = null; if (ui) q('#bDrawer').classList.add('hidden'); B.editZone = B.editTheme = B.editMerge = null; }
  function drawer() {
    if (!B.drawer) return;
    const errs = B.issues.filter(i => i.level === 'error').length;
    q('#bDrawerTitle').textContent = B.w.title;
    q('#bTabs').innerHTML = TABS.map(([id, nm]) => `<button class="${B.tab === id ? 'on' : ''}" data-tab="${id}">${nm}${id === 'problems' && B.issues.length ? ` (${errs || B.issues.length})` : ''}</button>`).join('');
    const body = q('#bDrawerBody');
    const top = body.scrollTop;
    body.innerHTML = ({ maps: tabMaps, zones: tabZones, themes: tabThemes, starters: tabStarters, world: tabWorld, names: tabNames, problems: tabProblems, share: tabShare })[B.tab]();
    body.scrollTop = top;
    G.hydrateCanvases(body);
    for (const c of body.querySelectorAll('canvas[data-mini]')) try { WR.mini(c, B.w, c.dataset.mini, 3); } catch (e) { /* skip */ }
  }
  function tabMaps() {
    const presets = [['12x10', 'Room 12×10'], ['10x8', 'House 10×8'], ['20x16', 'Area 20×16'], ['30x24', 'Route 30×24'], ['40x40', 'Big 40×40'], ['60x46', 'Huge 60×46']];
    const nm = B.newMap ? `<div class="bw-note"><b>New map</b>${f.text('Name', 'x', 'New map', { max: 30 }).replace('data-p="x"', 'id="nmName"').replace('data-k="text"', '')}
      ${f.select('Size', 'x', '20x16', presets).replace('data-p="x"', 'id="nmSize"')}
      ${f.select('Starts as', 'x', 'room', [['room', 'A room: floor inside walls'], ['open', 'Open ground'], ['void', 'Void (paint the floor yourself)']]).replace('data-p="x"', 'id="nmFill"')}
      ${f.select('Zone', 'x', map().zone, B.w.zones.map(z => [z.id, z.name])).replace('data-p="x"', 'id="nmZone"')}
      <div class="bw-row"><button class="bw-btn pri" data-a="map-create">Create the map</button><button class="bw-btn" data-a="map-cancel">Cancel</button></div></div>` : '<button class="bw-btn pri" data-a="map-new" style="width:100%">+ New map</button>';
    const m = map(), s = size(m);
    return `<p class="bw-dim">Maps are places: towns, routes, caves, the inside of a house. Warps join them.</p>${nm}
      <div class="bw-list" style="margin-top:10px">${B.w.maps.map(mm => { const ss = size(mm); return `<button class="bw-item" data-a="map-open" data-id="${esc(mm.id)}" style="${mm.id === B.mapId ? 'border-color:var(--acc)' : ''}"><canvas data-mini="${esc(mm.id)}" style="width:64px;height:48px;object-fit:contain"></canvas><div class="grow"><b>${esc(mm.name)}${mm.id === B.w.start.map ? ' ⚑' : ''}</b><small>${ss.w}×${ss.h} · ${mm.things.length} thing${mm.things.length === 1 ? '' : 's'} · ${esc((zoneOf(mm.zone) || { name: '?' }).name)}</small></div></button>`; }).join('')}</div>
      <div class="bw-h">This map: ${esc(m.name)}</div>
      <div data-o="map:${esc(m.id)}">${f.text('Name', 'name', m.name, { max: 30 })}${f.select('Zone (for tiles without a zone painted)', 'zone', m.zone, B.w.zones.map(z => [z.id, z.name]))}</div>
      <div class="bw-field"><span>Size ${s.w} × ${s.h}</span><div class="bw-row"><input type="number" class="bw-in" id="rsW" min="4" max="160" value="${s.w}" style="width:84px">×<input type="number" class="bw-in" id="rsH" min="4" max="160" value="${s.h}" style="width:84px">
        <select class="bw-in" id="rsAnchor" style="width:auto"><option value="tl">Keep top-left</option><option value="c">Keep centered</option><option value="br">Keep bottom-right</option></select><button class="bw-btn small" data-a="map-resize">Resize</button></div><small>New space is wall. Things that end up outside are removed.</small></div>
      <div class="bw-row"><button class="bw-btn" data-a="map-fit">Fit on screen</button><button class="bw-btn" data-a="map-dup">Duplicate</button><button class="bw-btn bad" data-a="map-del"${B.w.maps.length <= 1 ? ' disabled' : ''}>Delete…</button></div>`;
  }
  function tabZones() {
    if (B.editZone) {
      const z = zoneOf(B.editZone);
      if (z) {
        const tot = z.wild.reduce((a, w) => a + w.weight, 0);
        return `<button class="bw-btn small" data-a="zone-back">← Zones</button><div data-o="zone:${esc(z.id)}">
          ${f.text('Name', 'name', z.name, { max: 24 })}${f.select('Theme', 'theme', z.theme, B.w.themes.map(t => [t.id, t.name]))}
          ${f.select('Element', 'element', z.element || '', [['', 'None']].concat(E.MAINS.map(m => [m, E.MAIN[m].name])), 'Shown on the zone; it doesn\'t change the daemons.', true)}
          ${f.range('Encounter rate (%)', 'rate', z.rate, 0, 50, 'The chance per step on static that a wild daemon appears.')}
          <div class="bw-field"><span>Wild daemons (on static tiles)</span><div class="b-team">${z.wild.map((w, i) => `<div class="bw-item wrap"><canvas data-sprite="${esc(w.key)}" width="32" height="32"></canvas><div class="grow"><b>${esc(DB.has(w.key) ? ENG.rec(w.key).dName : w.key)}</b><small>${esc(w.key)} · ${Math.round(w.weight / tot * 100)}% of encounters</small></div>
            <div class="b-nums"><span class="bw-dim">Level</span><input type="number" class="bw-in" data-p="wild.${i}.min" data-min="1" data-max="60" value="${w.min}" style="width:56px">–<input type="number" class="bw-in" data-p="wild.${i}.max" data-min="1" data-max="60" value="${w.max}" style="width:56px">
            <span class="bw-dim">weight</span><input type="number" class="bw-in" data-p="wild.${i}.weight" data-min="1" data-max="20" value="${w.weight}" style="width:56px" title="How common"><button class="bw-btn small icon" data-a="wild-del" data-i="${i}" aria-label="Remove">✕</button></div></div>`).join('') || '<small>No wild daemons here.</small>'}</div>
            <button class="bw-btn small" data-a="wild-add" style="margin-top:6px">+ Wild daemon</button></div></div>
          <div class="bw-row"><button class="bw-btn" data-a="zone-paint">Paint this zone</button><button class="bw-btn bad" data-a="zone-del"${B.w.zones.length <= 1 ? ' disabled' : ''}>Delete…</button></div>${issuesFor(`world.zones[${z.id}]`)}`;
      }
    }
    return `<p class="bw-dim">A zone is a region with a name, a look (its theme) and the wild daemons that live on its static. Paint zones on the map with the Zones layer.</p>
      <div class="bw-list">${B.w.zones.map(z => `<button class="bw-item" data-a="zone-edit" data-id="${esc(z.id)}"><span class="bw-sw" style="background:${zoneColor(z.id)}"></span><div class="grow"><b>${esc(z.name)}</b><small>${esc((B.w.themes.find(t => t.id === z.theme) || { name: '?' }).name)} · ${z.wild.length} wild · ${z.rate}% · letter ${esc(z.mark)}</small></div><span class="bw-row">${z.wild.slice(0, 4).map(w => `<canvas data-sprite="${esc(w.key)}" width="32" height="32" style="width:28px;height:28px"></canvas>`).join('')}</span></button>`).join('')}</div>
      <button class="bw-btn pri" data-a="new-zone" style="width:100%;margin-top:10px">+ New zone</button>`;
  }
  const COLOR_FIELDS = [['floor.0', 'Floor A'], ['floor.1', 'Floor B'], ['speck', 'Floor specks'], ['line', 'Floor lines'], ['wall', 'Wall top'], ['face', 'Wall face'], ['trim', 'Trim glow'], ['static.0', 'Static dark'], ['static.1', 'Static blades'], ['static.2', 'Static sparkle'], ['obstacle', 'Obstacles'], ['accent', 'Accent'], ['sky.0', 'Battle sky'], ['sky.1', 'Battle horizon']];
  function tabThemes() {
    if (B.editTheme) {
      const t = B.w.themes.find(x => x.id === B.editTheme);
      if (t) {
        const get = p => p.split('.').reduce((o, k) => o[k], t);
        return `<button class="bw-btn small" data-a="theme-back">← Themes</button><div data-o="theme:${esc(t.id)}">${f.text('Name', 'name', t.name, { max: 20 })}
          <div class="b-colors">${COLOR_FIELDS.map(([p, lab]) => `<label><input type="color" data-p="${p}" value="${esc(get(p))}"><span>${esc(lab)}</span></label>`).join('')}</div>
          ${f.select('Floating particles', 'particles', t.particles, SC.PARTICLES.map(p => [p, p[0].toUpperCase() + p.slice(1)]))}</div>
          <p class="bw-dim">Changes show on the map at once. ${B.w.zones.filter(z => z.theme === t.id).length} zone(s) use this theme.</p>
          <div class="bw-row"><button class="bw-btn" data-a="theme-dup">Duplicate</button><button class="bw-btn bad" data-a="theme-del"${B.w.themes.length <= 1 ? ' disabled' : ''}>Delete…</button></div>`;
      }
    }
    const lib = W.LIBRARY.filter(t => !B.w.themes.some(x => x.id === t.id));
    return `<p class="bw-dim">Themes are the colors zones are drawn in, on the map and behind battles.</p>
      <div class="bw-list">${B.w.themes.map(t => `<button class="bw-item" data-a="theme-edit" data-id="${esc(t.id)}"><span class="bw-row" style="gap:2px">${[t.floor[1], t.face, t.trim, t.static[1], t.accent].map(c => `<span class="bw-sw" style="background:${esc(c)}"></span>`).join('')}</span><div class="grow"><b>${esc(t.name)}</b><small>${esc(t.particles)} · used by ${B.w.zones.filter(z => z.theme === t.id).length} zone(s)</small></div></button>`).join('')}</div>
      ${lib.length ? `<div class="bw-h">From the library</div><div class="bw-row">${lib.map(t => `<button class="bw-btn small" data-a="theme-lib" data-id="${esc(t.id)}">+ ${esc(t.name)}</button>`).join('')}</div>` : ''}`;
  }
  function tabStarters() {
    return `<p class="bw-dim">The daemons a new game offers to pick from.</p><div class="bw-list">${B.w.starters.map((s, i) => `<div class="bw-item" style="flex-wrap:wrap"><canvas data-sprite="${esc(s.key)}" width="32" height="32"></canvas><div class="grow"><b>${esc(DB.has(s.key) ? ENG.rec(s.key).dName : s.key)}</b><small>${esc(s.key)} · attuned to ${s.attune.map(essName).join(', ')}</small></div>
      <button class="bw-btn small" data-a="st-attune" data-i="${i}">Attune</button><button class="bw-btn small icon" data-a="st-del" data-i="${i}" aria-label="Remove"${B.w.starters.length <= 1 ? ' disabled' : ''}>✕</button>
      <div data-o="starter:${esc(s.key)}" style="width:100%">${f.text('Blurb', 'blurb', s.blurb, { max: 120 })}</div></div>`).join('')}</div>
      ${B.w.starters.length < 8 ? '<button class="bw-btn pri" data-a="st-add" style="width:100%;margin-top:10px">+ Starter</button>' : ''}${issuesFor('world.starters')}`;
  }
  function tabWorld() {
    const w = B.w, sm = w.maps.find(m => m.id === w.start.map);
    return `<div data-o="world">${f.text('Title', 'title', w.title, { max: 40 })}
      <label class="bw-field"><span>About</span><textarea data-p="about" data-k="opt" rows="2" maxlength="300">${esc(w.about || '')}</textarea></label>
      ${f.text('Made by', 'author', w.author, { optional: true, max: 40 })}
      <div class="bw-field"><span>Start</span><div class="bw-row"><b>${esc(sm ? sm.name : '?')}</b><span class="bw-dim">${w.start.x},${w.start.y}</span><button class="bw-btn small" data-a="start-pick">Set on the map</button><button class="bw-btn small" data-a="start-go">Show</button></div></div>
      ${f.seg('Start facing', 'start.facing', w.start.facing, [['up', '↑'], ['down', '↓'], ['left', '←'], ['right', '→']])}
      ${f.select('Main essences', 'rules.mains', w.rules.mains, [['all', 'All four from the start'], ['keys', 'Air first, one more per key (like the original)']])}
      ${f.text('Who explains the basics', 'text.guide', w.text.guide, { max: 24 })}
      ${f.lines('After you pick a starter', 'text.tutorial', w.text.tutorial, '{daemon} is the starter\'s name. One line per box.')}
      ${f.lines('The ending', 'text.ending', w.text.ending, 'After the final boss. Empty: the usual ending.')}</div>`;
  }
  function tabNames() {
    const edits = Object.entries(B.w.merges || {});
    if (B.editMerge) {
      const k = B.editMerge, r = DB.has(k) ? ENG.rec(k) : null, o = (B.w.merges || {})[k] || {};
      return `<button class="bw-btn small" data-a="merge-back">← Merge names</button><div class="gp-prev"><canvas data-sprite="${esc(k)}" width="64" height="64"></canvas><div><b>${esc(r ? r.dName : k)}</b><div class="bw-dim">${esc(k)} · ${esc(r ? r.name : '')}</div></div></div>
        <div data-o="merge:${esc(k)}">${f.text('Daemon name', 'dName', o.dName, { optional: true, max: 24, ph: r ? r.dName : '' })}${f.text('Spell name', 'name', o.name, { optional: true, max: 40, ph: r ? r.name : '' })}
        <label class="bw-field"><span>Form description</span><textarea data-p="dDesc" data-k="opt" rows="2" placeholder="${esc(r ? r.dDesc : '')}">${esc(o.dDesc || '')}</textarea></label>
        <label class="bw-field"><span>Spell text</span><textarea data-p="text" data-k="opt" rows="2" placeholder="${esc(r ? r.text : '')}">${esc(o.text || '')}</textarea></label>
        ${f.text('Forged item name', 'itemName', o.itemName, { optional: true, max: 48, ph: r ? r.item.name : '' })}
        ${r && r.damaging ? f.num('Power', 'power', o.power, 1, 160, `Baked: ${r.power}. Empty keeps it.`) : ''}${f.num('Flux cost', 'flux', o.flux, 3, 30, r ? `Baked: ${r.flux}.` : '')}</div>
        <p class="bw-dim">Only in this world. Empty fields keep the baked ones.</p><button class="bw-btn bad" data-a="merge-del">Remove these edits</button>`;
    }
    return `<p class="bw-dim">Give any of the ${DB.count.toLocaleString()} merges your own names in this world: daemon names, spell names, descriptions, and a few numbers.</p>
      <button class="bw-btn pri" data-a="merge-add" style="width:100%">+ Rename a merge</button>
      <div class="bw-list" style="margin-top:10px">${edits.map(([k, o]) => `<button class="bw-item" data-a="merge-edit" data-id="${esc(k)}"><canvas data-sprite="${esc(k)}" width="32" height="32"></canvas><div class="grow"><b>${esc(o.dName || (DB.has(k) ? ENG.rec(k).dName : k))}</b><small>${esc(k)} · ${Object.keys(o).join(', ')}</small></div></button>`).join('')}</div>${issuesFor('world.merges')}`;
  }
  function tabProblems() {
    if (!B.issues.length) return '<div class="bw-note">No problems: everything can be reached and every reference is valid.</div>';
    return `<p class="bw-dim">Tap one to go to it. You can still play with problems; they may break things.</p>${B.issues.map((i, n) => `<button class="b-issue ${i.level}" data-a="issue-go" data-i="${n}"><b>${i.level === 'error' ? 'Problem' : 'Check'}</b>${esc(i.msg)}<br><small class="bw-dim">${esc(i.path)}</small></button>`).join('')}`;
  }
  function tabShare() {
    const ed = G.editorAround;
    return `<p class="bw-dim">Your world is saved in this browser after every change. Export it to keep a copy, move it to another device, or share it.</p>
      <div class="bw-list"><button class="bw-item" data-a="ex-file"><div class="grow"><b>Download the world file</b><small>A .json file anyone can import.</small></div></button>
      <button class="bw-item" data-a="ex-code"><div class="grow"><b>Copy a world code</b><small>A compact code to paste in a message; Import a world reads it.</small></div></button>
      <button class="bw-item" data-a="ex-claude"><div class="grow"><b>Ask Claude Code to add it to the game</b><small>Copies the world file with instructions. Claude Code can make it a world everyone gets, or change the original with it.</small></div></button>
      ${ed ? `<button class="bw-item" data-a="ex-editor"><div class="grow"><b>${B.id === 'editor' ? 'Send back to the content editor' : 'Make it the game\'s world in the content editor'}</b><small>It becomes the editor's draft of data/world.json, next to its spells, daemons and every other piece of content. ▶ Play there plays it all together.</small></div></button>` : ''}
      <button class="bw-item" data-a="exit"><div class="grow"><b>Leave the builder</b><small>Back to the Worlds screen.</small></div></button></div>`;
  }

  // ---------------------------------------------------------------- actions from panels
  async function panelAction(a, b, e) {
    const d = b.dataset;
    const fnd = B.sel && findThing(B.sel), t = fnd && fnd.t;
    switch (a) {
      case 'seg': { const obj = target(b); if (!obj) return; setPath(obj, d.p, d.v); commit('edit:' + d.p); return refreshPanels(); }
      case 'clear': { const obj = target(b); if (obj) { setPath(obj, d.clear, undefined); commit('clear'); refreshPanels(); } return; }
      case 't-move': B.sheet = null; closeSheet(); return startPick({ kind: 'move', id: B.sel });
      case 't-dup': return duplicateThing(B.sel);
      case 't-del': if ((await G.choose('Delete it?', `${t.name || SC.THING[t.type][0]} is removed from the map.`, ['Delete', 'Cancel'])) === 0) removeThing(B.sel); return;
      case 't-once': if (b.closest('label').querySelector('input').checked) { t.if = '!' + t.id + '-done'; t.sets = t.id + '-done'; } else { delete t.if; delete t.sets; } commit('once'); return sheet();
      case 'cond-add': { const terms = SC.parseCond(t.if) || []; terms.push({ not: false, kind: 'flag', arg: '' }); t.if = terms.map(c => (c.not ? '!' : '') + (c.kind === 'flag' ? c.arg || 'my-flag' : c.kind === 'won' ? 'won' : c.kind + ':' + c.arg)).join(' '); commit('cond'); return sheet(); }
      case 'cond-del': { const terms = SC.parseCond(t.if) || []; terms.splice(+d.i, 1); setCond(t, terms); commit('cond'); return sheet(); }
      case 'mote-add': return pickEssence(code => { t.gives = t.gives || {}; t.gives.motes = t.gives.motes || {}; t.gives.motes[code] = Math.min(99, (t.gives.motes[code] || 0) + 3); commit('motes'); sheet(); });
      case 'mote-del': delete t.gives.motes[d.e]; cleanup(t); commit('motes'); return sheet();
      case 'item-add': return pickGenome(null, 'Forge an item from…', key => { t.gives = t.gives || {}; t.gives.item = key; commit('item'); sheet(); }, 'item');
      case 'item-del': delete t.gives.item; cleanup(t); commit('item'); return sheet();
      case 'daemon-add': return pickGenome(null, 'Give a daemon', key => { t.gives = t.gives || {}; t.gives.daemon = { key, level: 5 }; commit('daemon'); sheet(); });
      case 'daemon-del': delete t.gives.daemon; cleanup(t); commit('daemon'); return sheet();
      case 'team-add': return pickGenome(t.team[t.team.length - 1] && t.team[t.team.length - 1].key, 'Add to the team', key => { t.team.push({ key, level: (t.team[t.team.length - 1] || { level: 5 }).level }); commit('team'); sheet(); });
      case 'team-swap': return pickGenome(t.team[+d.i].key, 'Change this daemon', key => { t.team[+d.i].key = key; commit('team'); sheet(); });
      case 'team-del': t.team.splice(+d.i, 1); commit('team'); return sheet();
      case 'w-pick': B.sheet = null; closeSheet(); return startPick({ kind: 'warp', id: B.sel });
      case 'w-go': if (t && t.to) { goMap(t.to.map, t.to); B.sel = null; closeSheet(); } return;
      case 'w-back': return wayBack(B.sel);
      // maps
      case 'map-open': closeDrawer(); return goMap(d.id);
      case 'map-new': B.newMap = true; return drawer();
      case 'map-cancel': B.newMap = false; return drawer();
      case 'map-create': return createMap();
      case 'map-fit': closeDrawer(); return fitMap();
      case 'map-dup': return duplicateMap();
      case 'map-del': return deleteMap();
      case 'map-resize': return resizeMap(+q('#rsW').value, +q('#rsH').value, q('#rsAnchor').value);
      // zones
      case 'zone-edit': B.editZone = d.id; return drawer();
      case 'zone-back': B.editZone = null; return drawer();
      case 'zone-paint': { const z = zoneOf(B.editZone); B.layer = 'zones'; B.mark = z.mark; B.tool = 'paint'; closeDrawer(); return chrome(); }
      case 'zone-del': return deleteZone(B.editZone);
      case 'wild-add': { const z = zoneOf(B.editZone); return pickGenome(z.wild[0] && z.wild[0].key, 'A wild daemon', key => { if (z.wild.some(w => w.key === key)) return G.toast('That genome already lives here.', 'bad'); const last = z.wild[z.wild.length - 1] || { min: 3, max: 6 }; z.wild.push({ key, min: last.min, max: last.max, weight: 2 }); commit('wild'); drawer(); }); }
      case 'wild-del': zoneOf(B.editZone).wild.splice(+d.i, 1); commit('wild'); return drawer();
      // themes
      case 'theme-edit': B.editTheme = d.id; return drawer();
      case 'theme-back': B.editTheme = null; return drawer();
      case 'theme-lib': { const t0 = clone(W.LIBRARY.find(x => x.id === d.id)); B.w.themes.push(t0); R.setThemes(B.w.themes); commit('theme'); return drawer(); }
      case 'theme-dup': { const t0 = clone(B.w.themes.find(x => x.id === B.editTheme)); t0.id = slugId(t0.id + '-copy', B.w.themes.map(x => x.id)); t0.name = (t0.name + ' copy').slice(0, 20); B.w.themes.push(t0); R.setThemes(B.w.themes); B.editTheme = t0.id; commit('theme'); return drawer(); }
      case 'theme-del': return deleteTheme(B.editTheme);
      // starters
      case 'st-add': return pickGenome('AA', 'A new starter', key => { if (B.w.starters.some(s => s.key === key)) return G.toast('That genome is already a starter.', 'bad'); const sub = E.SUB_ORDER.find(s => E.eligible(s, key[0])); B.w.starters.push({ key, attune: [sub], blurb: 'A new kernel.' }); commit('starter'); drawer(); });
      case 'st-del': B.w.starters.splice(+d.i, 1); commit('starter'); return drawer();
      case 'st-attune': { const s = B.w.starters[+d.i]; return pickEssence(code => { if (!E.SUB[code]) return G.toast('Starters attune to sub-essences.', 'bad'); if (!E.eligible(code, s.key[0]) && !E.eligible(code, s.key[1])) return G.toast(`${essName(code)} can't bind to this genome.`, 'bad'); s.attune = [code]; commit('attune'); drawer(); }, true); }
      // story
      case 'start-pick': closeDrawer(); return startPick({ kind: 'start' });
      case 'start-go': closeDrawer(); return goMap(B.w.start.map, B.w.start);
      // merge names
      case 'merge-add': return pickGenome(null, 'Rename which merge?', key => { B.editMerge = key; drawer(); });
      case 'merge-edit': B.editMerge = d.id; return drawer();
      case 'merge-back': B.editMerge = null; return drawer();
      case 'merge-del': if (B.w.merges) delete B.w.merges[B.editMerge]; cleanup({}); B.editMerge = null; commit('merge'); return drawer();
      // problems
      case 'issue-go': return goIssue(B.issues[+d.i]);
      // sharing
      case 'ex-file': { persist.now(); const text = W.fileText(B.w); if (!(await W.download(W.slug(B.w.title) + '.world.json', text))) W.showCopy('World file', text); return; }
      case 'ex-code': persist.now(); return W.showCopy('World code', await W.code(B.w), 'Anyone can paste it into Import a world.');
      case 'ex-claude': return W.showCopy('For Claude Code', `Add this world to Essence Protocol. It is a world file made in the in-game builder (format ${W.FORMAT}); save it and either ship it as a built-in world or apply it to data/world.json, then run node essence-protocol/tools/verify.js.\n\n` + W.fileText(B.w));
      case 'ex-editor': return toEditor();
      case 'exit': return exit();
      default:
    }
  }

  // ---------------------------------------------------------------- maps, zones, themes: structural edits
  function blankTiles(w, h, kind) {
    const g = Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => {
      if (kind === 'void') return 'V';
      const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1;
      return kind === 'room' && edge ? '#' : '.';
    }));
    return g.map(r => r.join(''));
  }
  function createMap() {
    const name = (q('#nmName').value || 'New map').trim().slice(0, 30), [w, h] = q('#nmSize').value.split('x').map(Number), kind = q('#nmFill').value, zone = q('#nmZone').value;
    const id = slugId(name, B.w.maps.map(m => m.id));
    B.w.maps.push({ id, name, zone, tiles: blankTiles(w, h, kind), zones: Array.from({ length: h }, () => '.'.repeat(w)), things: [] });
    B.newMap = false;
    commit('new map');
    closeDrawer(); goMap(id);
    G.toast(`<b>${esc(name)}</b> is ready. Add a warp (Things → Warp) somewhere to lead here.`);
  }
  function duplicateMap() {
    const m = clone(map()); m.id = slugId(m.id + '-copy', B.w.maps.map(x => x.id)); m.name = (m.name + ' copy').slice(0, 30);
    const used = new Set(allThings().map(o => o.t.id)); // ids stay unique across the world
    for (const t of m.things) { let n = 1, id; do { id = `${t.type}-${n++}`; } while (used.has(id)); used.add(id); t.id = id; }
    B.w.maps.push(m); commit('duplicate map'); closeDrawer(); goMap(m.id);
  }
  async function deleteMap() {
    const m = map();
    if (B.w.start.map === m.id) return G.toast('A new game starts on this map. Move the start to another map first (Story & rules).', 'bad');
    const into = allThings().filter(o => o.t.type === 'warp' && o.t.to && o.t.to.map === m.id && o.m.id !== m.id);
    if ((await G.choose(`Delete ${m.name}?`, `Its tiles and ${m.things.length} thing(s) are removed${into.length ? `, and ${into.length} warp(s) leading here go too` : ''}. Undo can bring it back.`, ['Delete', 'Cancel'])) !== 0) return;
    for (const o of into) o.m.things.splice(o.m.things.indexOf(o.t), 1);
    B.w.maps.splice(B.w.maps.indexOf(m), 1);
    B.mapId = B.w.maps[0].id; loadGrids(); B.sel = null; closeSheet();
    commit('delete map'); fitMap(); drawer();
  }
  function resizeMap(nw, nh, anchor) {
    if (!(nw >= 4 && nh >= 4 && nw <= 160 && nh <= 160)) return G.toast('Maps are 4 to 160 tiles wide and high.', 'bad');
    const m = map(), s = size(m);
    const dx = anchor === 'tl' ? 0 : anchor === 'br' ? nw - s.w : Math.floor((nw - s.w) / 2);
    const dy = anchor === 'tl' ? 0 : anchor === 'br' ? nh - s.h : Math.floor((nh - s.h) / 2);
    const tiles = [], zones = [];
    for (let y = 0; y < nh; y++) {
      let tr = '', zr = '';
      for (let x = 0; x < nw; x++) { const ox = x - dx, oy = y - dy; const inside = ox >= 0 && oy >= 0 && ox < s.w && oy < s.h; tr += inside ? B.grid[oy][ox] : '#'; zr += inside ? B.zgrid[oy][ox] : '.'; }
      tiles.push(tr); zones.push(zr);
    }
    const gone = m.things.filter(t => !(t.x + dx >= 0 && t.y + dy >= 0 && t.x + dx < nw && t.y + dy < nh));
    m.things = m.things.filter(t => !gone.includes(t));
    for (const t of m.things) { t.x += dx; t.y += dy; }
    for (const o of allThings()) if (o.t.type === 'warp' && o.t.to && o.t.to.map === m.id) { o.t.to.x = clamp(o.t.to.x + dx, 0, nw - 1); o.t.to.y = clamp(o.t.to.y + dy, 0, nh - 1); }
    if (B.w.start.map === m.id) { B.w.start.x = clamp(B.w.start.x + dx, 0, nw - 1); B.w.start.y = clamp(B.w.start.y + dy, 0, nh - 1); }
    m.tiles = tiles; m.zones = zones;
    loadGrids(); commit('resize');
    G.toast(`Resized to ${nw}×${nh}${gone.length ? `; ${gone.length} thing(s) outside were removed` : ''}.`);
    drawer();
  }
  function newZone() {
    const n = B.w.zones.length + 1, name = 'Zone ' + n, id = slugId(name, B.w.zones.map(z => z.id));
    const used = new Set(B.w.zones.map(z => z.mark));
    const mark = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('').find(c => !used.has(c));
    if (!mark) return G.toast('This world has as many zones as it can hold (62).', 'bad');
    const theme = (zoneOf(map().zone) || B.w.zones[0] || { theme: B.w.themes[0].id }).theme;
    B.w.zones.push({ id, name, mark, theme, element: null, rate: 12, wild: [] });
    commit('new zone');
    B.editZone = id; openDrawer('zones');
  }
  async function deleteZone(id) {
    const z = zoneOf(id); if (!z) return;
    if ((await G.choose(`Delete ${z.name}?`, 'Tiles painted with it go back to their map\'s zone.', ['Delete', 'Cancel'])) !== 0) return;
    const other = B.w.zones.find(x => x.id !== id);
    for (const m of B.w.maps) { m.zones = m.zones.map(r => r.split(z.mark).join('.')); if (m.zone === id) m.zone = other.id; }
    B.w.zones.splice(B.w.zones.indexOf(z), 1);
    B.editZone = null; loadGrids(); commit('delete zone'); drawer();
  }
  async function deleteTheme(id) {
    const t = B.w.themes.find(x => x.id === id); if (!t) return;
    const other = B.w.themes.find(x => x.id !== id);
    const users = B.w.zones.filter(z => z.theme === id);
    if ((await G.choose(`Delete ${t.name}?`, users.length ? `${users.length} zone(s) switch to ${other.name}.` : 'No zone uses it.', ['Delete', 'Cancel'])) !== 0) return;
    for (const z of users) z.theme = other.id;
    B.w.themes.splice(B.w.themes.indexOf(t), 1);
    B.editTheme = null; R.setThemes(B.w.themes); swCache.clear(); B.low = null; commit('delete theme'); drawer();
  }
  function goIssue(i) {
    if (!i) return;
    const m = /^world\.maps\[([^\]]+)\](?:\.things\[([^\]]+)\])?/.exec(i.path);
    if (m && m[2]) { closeDrawer(); return select(m[2]); }
    if (m) { closeDrawer(); const at = /at (?:[^,]* )?(\d+),(\d+)/.exec(i.msg); return goMap(m[1], at ? { x: +at[1], y: +at[2] } : null); }
    const z = /^world\.zones\[([^\]]+)\]/.exec(i.path); if (z) { B.editZone = z[1]; B.tab = 'zones'; return drawer(); }
    if (i.path.startsWith('world.starters')) { B.tab = 'starters'; return drawer(); }
    if (i.path.startsWith('world.themes')) { B.tab = 'themes'; return drawer(); }
    if (i.path.startsWith('world.merges')) { B.tab = 'names'; return drawer(); }
    if (i.path.startsWith('world.start')) { closeDrawer(); return goMap(B.w.start.map, B.w.start); }
    B.tab = 'world'; drawer();
  }

  // ---------------------------------------------------------------- pickers
  function modalOpen(html) {
    const el = document.createElement('div');
    el.className = 'b-modal';
    el.innerHTML = `<div class="card">${html}</div>`;
    document.body.appendChild(el);
    el.addEventListener('click', e => { if (e.target === el) el.remove(); });
    return el;
  }
  // A genome (merge key): lead main, second main, up to three sub-essences on either.
  function pickGenome(current, title, done, what) {
    let p = current && E.validKey(current) ? E.parseKey(current) : { a: 'F', b: 'F', subs: [] };
    p = { a: p.a, b: p.b, subs: p.subs.slice() };
    const el = modalOpen(`<h3>${esc(title)}</h3><div class="gp"></div>`);
    const box = el.querySelector('.gp');
    const draw = () => {
      const key = E.makeKey(p.a, p.b, p.subs), ok = E.validKey(key) && DB.has(key), r = ok ? ENG.rec(key) : null;
      const slots = E.slotsFor(p.a, p.b);
      const item = what === 'item' && ok && window.EP.forgeItem ? window.EP.forgeItem(key) : null;
      box.innerHTML = `<div class="bw-field"><span>Lead essence</span><div class="gp-mains">${E.MAINS.map(m => `<button data-ga="${m}" class="${p.a === m ? 'on' : ''}" style="--c:${E.MAIN[m].color}">${esc(E.MAIN[m].name)}</button>`).join('')}</div></div>
        <div class="bw-field"><span>Second essence</span><div class="gp-mains">${E.MAINS.map(m => `<button data-gb="${m}" class="${p.b === m ? 'on' : ''}" style="--c:${E.MAIN[m].color}">${esc(E.MAIN[m].name)}</button>`).join('')}</div></div>
        <div class="bw-field"><span>Sub-essences (${p.subs.length}/${E.MAX_SUBS})</span><div class="gp-subs">${slots.map(t => { const on = p.subs.some(u => u.s === t.s && u.h === t.h); return `<button data-gs="${t.s}" data-gh="${t.h}" class="${on ? 'on' : ''}"${!on && p.subs.length >= E.MAX_SUBS ? ' disabled' : ''} style="--c:${esc(SP.ACCENT[t.s] || '#ccc')}">${esc(E.SUB[t.s].name)}${p.a !== p.b ? ' → ' + esc(E.MAIN[t.h === 1 ? p.a : p.b].name) : ''}</button>`; }).join('')}</div></div>
        <div class="gp-prev"><canvas data-sprite="${esc(key)}" width="64" height="64"></canvas><div><b>${r ? esc(item ? item.name : r.dName) : 'Not a merge'}</b><div class="bw-dim">${esc(key)}${r ? ` · ${esc(r.name)} · ${RARITY[r.rarity]} · ${r.cls}` : ' · sub-essences must fit their host'}</div></div></div>
        <div class="bw-row"><button class="bw-btn pri" data-gu${ok ? '' : ' disabled'}>Use${r ? ' ' + esc(r.dName) : ''}</button><button class="bw-btn" data-gr>Random</button><button class="bw-btn" data-gc>Cancel</button></div>`;
      G.hydrateCanvases(box);
    };
    box.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.ga) { p.a = b.dataset.ga; p.subs = p.subs.filter(u => E.slotsFor(p.a, p.b).some(t => t.s === u.s && t.h === u.h)); }
      else if (b.dataset.gb) { p.b = b.dataset.gb; p.subs = p.subs.filter(u => E.slotsFor(p.a, p.b).some(t => t.s === u.s && t.h === u.h)); }
      else if (b.dataset.gs) { const s = b.dataset.gs, h = +b.dataset.gh, i = p.subs.findIndex(u => u.s === s && u.h === h); if (i >= 0) p.subs.splice(i, 1); else if (p.subs.length < E.MAX_SUBS) p.subs.push({ s, h }); }
      else if (b.hasAttribute('data-gr')) { const keys = DB.keys(); const k = keys[Math.floor(Math.random() * keys.length)]; const q0 = E.parseKey(k); p = { a: q0.a, b: q0.b, subs: q0.subs.slice() }; }
      else if (b.hasAttribute('data-gc')) { el.remove(); return; }
      else if (b.hasAttribute('data-gu')) { const key = E.makeKey(p.a, p.b, p.subs); el.remove(); done(key); return; }
      draw();
    });
    draw();
  }
  function pickEssence(done, subsOnly) {
    const list = (subsOnly ? [] : E.MAINS).concat(E.SUB_ORDER);
    const el = modalOpen(`<h3>${subsOnly ? 'Which sub-essence?' : 'Motes of which essence?'}</h3><div class="gp-subs">${list.map(c => `<button data-e="${c}" style="--c:${esc(essColor(c))}">${esc(essName(c))}</button>`).join('')}</div><div class="bw-row" style="margin-top:10px"><button class="bw-btn" data-c>Cancel</button></div>`);
    el.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; el.remove(); if (b.dataset.e) done(b.dataset.e); });
  }

  // ---------------------------------------------------------------- playing, opening, leaving
  function playMenu(anchor) {
    const old = document.querySelector('.b-menu'); if (old) { old.remove(); return; }
    const menu = document.createElement('div');
    menu.className = 'b-menu';
    const r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { right: innerWidth - 8, bottom: 56 };
    menu.style.right = Math.max(8, innerWidth - r.right) + 'px'; menu.style.top = (r.bottom + 6) + 'px';
    menu.innerHTML = `<button data-p="here">▶ Test here<small>Your test save, dropped on the spot in the middle of the screen</small></button>
      <button data-p="start">↺ Test from the start<small>A fresh test run with the first starter</small></button>
      <button data-p="real">★ Play for real<small>Your own save of this world, from the starter pick</small></button>`;
    document.body.appendChild(menu);
    const off = e => { if (!menu.contains(e.target)) { menu.remove(); removeEventListener('pointerdown', off, true); } };
    setTimeout(() => addEventListener('pointerdown', off, true), 0);
    menu.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; menu.remove(); removeEventListener('pointerdown', off, true); play(b.dataset.p); });
  }
  // the tile nearest the middle of the screen where the player can stand
  function spotHere() {
    const cx = Math.floor(B.cam.x), cy = Math.floor(B.cam.y), s = size(map());
    for (let r = 0; r < 12; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const x = cx + dx, y = cy + dy;
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r || x < 0 || y < 0 || x >= s.w || y >= s.h) continue;
      if (!solid(tileAt(x, y)) && !thingAt(x, y)) return { map: B.mapId, x, y, dir: 'down' };
    }
    return null;
  }
  function play(how) {
    persist.now();
    const id = B.id, w = clone(B.w);
    const at = how === 'here' ? spotHere() : null;
    hideUI();
    if (how === 'real') { G.useWorld(CT.withWorld(w), 'ep-save:' + id, { id, test: false }); G.playWorld(false); return; }
    if (how === 'start') { try { localStorage.removeItem('ep-test:' + id); } catch (e) { /* ignore */ } }
    G.useWorld(CT.withWorld(w), 'ep-test:' + id, { id, test: true });
    G.testWorld(at || (how === 'here' ? { map: w.start.map, x: w.start.x, y: w.start.y, dir: w.start.facing } : null));
    G.toast('Test run. Tap <b>✎</b> at the top to come back to the builder.');
  }
  function hideUI() { if (ui) ui.classList.add('hidden'); document.body.classList.remove('building'); const m = document.querySelector('.b-menu'); if (m) m.remove(); }
  function open(id, at) {
    const w = W.get(id);
    if (!w) { G.toast('That world is gone.', 'bad'); return; }
    mount();
    const same = B.id === id && B.w;
    B.id = id; B.w = same ? B.w : W.normalize(w);
    if (!same) { B.past = []; B.future = []; B.sel = null; B.picking = null; B.editZone = B.editTheme = B.editMerge = null; }
    B.lastJSON = JSON.stringify(B.w);
    G.hideScreens();
    const hub = document.getElementById('worlds'); if (hub) hub.classList.add('hidden');
    G.closeModal();
    G.mode = 'build';
    R.setThemes(B.w.themes); swCache.clear();
    B.mapId = (at && B.w.maps.some(m => m.id === at.map)) ? at.map : B.mapId && same ? B.mapId : B.w.start.map;
    loadGrids();
    if (at) { centerOn(at.x, at.y); B.cam.s = Math.max(B.cam.s, 32); } else if (!same) fitMap();
    ui.classList.remove('hidden'); document.body.classList.add('building');
    closeSheet(); closeDrawer(); hint(null);
    chrome(); runCheck();
    if (!W.hasSave(id) && !same && !localStorage.getItem('ep-build-tip')) {
      try { localStorage.setItem('ep-build-tip', '1'); } catch (e) { /* ignore */ }
      G.toast('Welcome to the builder. Pick a tile below and paint; ☺ Things places people, trainers, doors and more; ▶ plays it.', 'tip', 7000);
    }
  }
  function renderAll() { chrome(); if (B.sheet) sheet(); if (B.drawer) drawer(); }
  function exit() { persist.now(); hideUI(); closeSheet(); closeDrawer(); B.sel = null; W.open(); }
  async function fromPlay(playing, at) {
    if (!playing || playing.id === 'main') {
      const c = await G.choose('Build on this world?', 'The original world stays as it is, but you can remix it: your own copy to change however you like, starting from this spot.', ['Remix it', 'Cancel']);
      if (c !== 0) return;
      G.save();
      const id = W.create(W.templates.remix());
      if (id) open(id, at);
      return;
    }
    G.save();
    open(playing.id, at);
  }
  // Hands this world to the content editor (served next to the game): it arrives as the draft's world.
  function toEditor() {
    persist.now();
    try { localStorage.setItem('ep-editor-world-return', JSON.stringify({ world: B.w, at: Date.now() })); }
    catch (e) { G.toast('Couldn\'t hand it over: ' + esc(e.message), 'bad'); return; }
    location.href = 'editor/#world';
  }

  addEventListener('resize', () => { if (active()) chrome(); });
  // Android's back button: close the open panel, cancel a pick, or leave the builder.
  function back() {
    const m = document.querySelector('.b-menu'); if (m) { m.remove(); return true; }
    if (B.picking) { B.picking = null; hint(null); return true; }
    if (B.drawer) { closeDrawer(); return true; }
    if (B.sheet) { B.sel = null; closeSheet(); return true; }
    exit(); return true;
  }
  window.BUILD = { open, fromPlay, frame, exit, back, get state() { return B; }, undo, redo, commit, select, goMap, place, setTool, runCheck };
})();
