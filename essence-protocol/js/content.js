/* Essence Protocol: the world (maps, zones, themes, things, starters) from data/world.json.
   UMD so tools/verify.js and the content editor can build it too.
   CONTENT.make(E) builds from E.data.world; C.withWorld(world) builds the same tables for another
   world (a player-made one), on the same essences and merges.
   A player's world can be half made, so nothing here throws: a wild daemon, team member or thing
   that can't be used is left out and listed in C.problems (the schema says why in more detail). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./essences.js'), require('./schema.js'));
  else root.CONTENT = factory(root.ESSENCE, root.CONTENT_SCHEMA);
})(typeof self !== 'undefined' ? self : this, function make(E, SC) {
  'use strict';
  SC = SC || (typeof self !== 'undefined' && self.CONTENT_SCHEMA) || require('./schema.js');
  const WORLD = E.data.world;
  const problems = [];
  const bad = (path, msg) => problems.push({ level: 'error', path, msg });
  const valid = (key, path) => { if (typeof key === 'string' && E.validKey(key)) return true; bad(path, `"${key}" is not a merge key`); return false; };

  // k('FW', 'Em1 Li2') -> canonical key "FW-Em1Li2"
  function k(pair, subs) {
    const list = (subs || '').split(/\s+/).filter(Boolean).map(t => ({ s: t.slice(0, 2), h: +t[2] }));
    const key = E.makeKey(pair[0], pair[1], list);
    if (!E.validKey(key)) throw new Error('bad content key ' + pair + ' ' + subs);
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
  const say = t => String(t).replace(/\{merges\}/g, numberWords(MERGES)).replace(/\{mergeCount\}/g, MERGES.toLocaleString('en-US'));
  const sayAll = list => (Array.isArray(list) ? list.map(say) : []);

  const STARTERS = (WORLD.starters || []).filter((s, i) => s && valid(s.key, `world.starters[${i}]`)).map(s => ({ key: s.key, attune: (s.attune || []).slice(), blurb: s.blurb || '' }));

  // ---- themes and zones. wild: [key, minLevel, maxLevel, weight]
  const THEMES = {};
  for (const t of WORLD.themes || []) if (t && t.id) THEMES[t.id] = t;
  const firstTheme = Object.keys(THEMES)[0];
  const ZONES = {}, MARKS = {};
  for (const z of WORLD.zones || []) {
    if (!z || !z.id) continue;
    ZONES[z.id] = {
      id: z.id, name: z.name || z.id, mark: z.mark, theme: THEMES[z.theme] ? z.theme : firstTheme, el: z.element || null,
      rate: z.rate != null ? z.rate : 12,
      wild: (z.wild || []).filter(w => w && valid(w.key, `world.zones[${z.id}].wild`) && w.min <= w.max).map(w => [w.key, w.min, w.max, w.weight || 1]),
    };
    if (z.mark) MARKS[z.mark] = z.id;
  }
  const firstZone = Object.keys(ZONES)[0];

  // ---- tiles
  const TILES = SC.TILES;
  const SOLID = new Set(Object.keys(TILES).filter(ch => TILES[ch].solid));
  const GATES = {};
  for (const ch of Object.keys(TILES)) if (TILES[ch].keys) GATES[ch] = TILES[ch].keys;

  // ---- maps and the things on them
  const cond = (str, path) => { if (str == null || str === '') return null; const c = SC.parseCond(str); if (!c) bad(path, `"${str}" is not a condition`); return c && c.length ? c : null; };
  function thing(t, M, path) {
    const o = { id: t.id, type: t.type, map: M.id, x: t.x, y: t.y, zone: (M.zone[t.y] || [])[t.x] || M.zoneId, cond: cond(t.if, path + '.if'), sets: t.sets || null };
    switch (t.type) {
      case 'person':
        Object.assign(o, { kind: 'folk', name: t.name || 'Someone', dir: t.facing || 'down', sight: 0, lines: sayAll(t.lines), after: t.after ? sayAll(t.after) : null, gives: t.gives || null, heal: !!t.heal, color: t.color || null });
        if (!o.lines.length) o.lines = ['…'];
        break;
      case 'trainer': {
        const team = (t.team || []).filter(m => m && valid(m.key, path + '.team')).map(m => [m.key, m.level]);
        if (!team.length) { bad(path + '.team', `${t.name || t.id} has nobody to battle with`); return null; }
        Object.assign(o, { kind: t.warden ? 'warden' : 'op', name: t.name || 'Trainer', dir: t.facing || 'down', sight: t.sight || 0, team, intro: say(t.intro || '…'), outro: say(t.outro || '…'), gives: t.gives || null, color: t.color || null });
        if (t.warden) o.warden = true;
        if (t.final) o.final = true;
        if (t.badge) o.badge = t.badge;
        break;
      }
      case 'sign': Object.assign(o, { who: t.who || '', lines: sayAll(t.lines) }); if (!o.lines.length) o.lines = ['…']; break;
      case 'chest': Object.assign(o, { look: t.look || 'chest', gives: t.gives || null }); break;
      case 'warp':
        if (!t.to || !MAPS_BY_ID[t.to.map]) { bad(path + '.to', 'the warp leads nowhere'); return null; }
        Object.assign(o, { look: t.look || 'door', to: { map: t.to.map, x: t.to.x, y: t.to.y, facing: t.to.facing || null } });
        break;
      case 'trigger': Object.assign(o, { who: t.who || '', lines: t.lines ? sayAll(t.lines) : [], gives: t.gives || null, heal: !!t.heal }); break;
      case 'block': Object.assign(o, { look: t.look || 'boulder', who: t.who || '', lines: t.lines ? sayAll(t.lines) : [] }); break;
      default: bad(path, `"${t.type}" is not a kind of thing`); return null;
    }
    return o;
  }
  const MAPS_BY_ID = {};
  for (const m of WORLD.maps || []) if (m && m.id) MAPS_BY_ID[m.id] = m;
  const MAPS = {}, THINGS = {};
  for (const m of WORLD.maps || []) {
    if (!m || !m.id || !Array.isArray(m.tiles) || !m.tiles.length) continue;
    const h = m.tiles.length, w = String(m.tiles[0]).length;
    const zoneId = ZONES[m.zone] ? m.zone : firstZone;
    const tiles = m.tiles.map(r => { r = String(r); return r.length === w ? r : (r + '#'.repeat(w)).slice(0, w); });
    const zone = [];
    for (let y = 0; y < h; y++) {
      const row = String((m.zones || [])[y] || ''), out = new Array(w);
      for (let x = 0; x < w; x++) { const ch = row[x]; out[x] = ch && ch !== '.' && MARKS[ch] ? MARKS[ch] : zoneId; }
      zone.push(out);
    }
    const M = { id: m.id, name: m.name || m.id, w, h, tiles, zone, zoneId, things: [] };
    MAPS[m.id] = M;
  }
  for (const m of WORLD.maps || []) {
    const M = m && MAPS[m.id];
    if (!M) continue;
    for (const t of m.things || []) {
      if (!t || !t.id) continue;
      const path = `world.maps[${m.id}].things[${t.id}]`;
      if (THINGS[t.id]) { bad(path, `the id "${t.id}" is used twice`); continue; }
      if (!(t.x >= 0 && t.y >= 0 && t.x < M.w && t.y < M.h)) { bad(path, 'it stands outside the map'); continue; }
      const o = thing(t, M, path);
      if (o) { M.things.push(o); THINGS[o.id] = o; }
    }
  }
  const firstMap = Object.keys(MAPS)[0];
  // how many keys the gates on the maps ask for (1 to 9), smallest first
  const GATE_KEYS = [];
  for (const M of Object.values(MAPS)) for (const row of M.tiles) for (const ch of row) if (GATES[ch] && !GATE_KEYS.includes(GATES[ch])) GATE_KEYS.push(GATES[ch]);
  GATE_KEYS.sort((a, b) => a - b);

  // where a new game starts (kept on the map even if the data is off)
  const START = (() => {
    const s = WORLD.start || {}, M = MAPS[s.map] || MAPS[firstMap];
    if (!M) return null;
    return { map: M.id, x: Math.max(0, Math.min(M.w - 1, s.x | 0)), y: Math.max(0, Math.min(M.h - 1, s.y | 0)), facing: s.facing || 'down' };
  })();

  const OPERATORS = Object.values(THINGS).filter(t => t.type === 'trainer');
  const FOLK = Object.values(THINGS).filter(t => t.type === 'person');
  // keys a player can hold (the final boss's is the prize, not a gate key)
  const KEYS = new Set(OPERATORS.filter(t => t.badge && !t.final).map(t => t.badge)).size;
  const RULES = { mains: (WORLD.rules && WORLD.rules.mains) || 'all' };

  // Lines the game says in its own voice ({daemon} is filled in where they are used).
  const T = WORLD.text || {};
  const TEXT = { guide: T.guide || 'Guide', tutorial: sayAll(T.tutorial), ending: T.ending ? sayAll(T.ending) : null };

  const withWorld = w => make(Object.assign(Object.create(E), { data: Object.assign({}, E.data, { world: w }) }), SC);

  return {
    make, withWorld, k, numberWords, say, problems,
    TITLE: WORLD.title || 'Untitled world', ABOUT: WORLD.about || '', AUTHOR: WORLD.author || '', MERGE_EDITS: WORLD.merges || {},
    STARTERS, THEMES, ZONES, MARKS, MAPS, THINGS, OPERATORS, FOLK, START, RULES, KEYS, GATE_KEYS, TEXT, TILES, SOLID, GATES,
  };
});
