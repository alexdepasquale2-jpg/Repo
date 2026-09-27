/* Essence Protocol: FriedrichBridge client.
 *
 * Hybrid model: battle numbers always come from the baked table
 * (merges.baked.js), so combat stays deterministic. What a merge is called
 * and how it reads (name, description, rarity, tags) comes from
 * FriedrichBridge when it is reachable, and is cached locally. If the bridge
 * is down, the game keeps the baked text.
 *
 * Every Essence Protocol merge is sent as a two-item bridge merge:
 *   a = the lead main plus the subs bound to it      (id "ep.t.lead.F.Em")
 *   b = the second main plus the subs bound to it    (id "ep.t.follow.W.Li")
 * The role is part of the id because lead/follow order matters here
 * (Fire-led Scald is not Water-led Steam), while the bridge treats A+B as
 * B+A. Daemon forms use the same shape with the "ep.f." prefix so they
 * get their own recipes.
 *
 * By default requests go to "/bridge", the same-origin proxy in
 * tools/serve.py, which adds the API key server side. A direct URL + key
 * can also be set in System > Bridge (kept in this browser only). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./essences.js'));
  else root.BRIDGE = factory(root.ESSENCE);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  const ID_RE = /^[A-Za-z0-9_.:\-]{1,128}$/;
  const CACHE_KEY = 'ep-bridge-cache-v1';
  const CONF_KEY = 'ep-bridge-conf';
  const TIMEOUT_MS = 75000;
  const BACKOFF = [2000, 5000, 10000];

  // ---- request mapping (pure, testable in Node) ----
  function side(p, role, main, subs) {
    const names = subs.map(s => E.SUB[s].name);
    return {
      id: ['ep', role === 'lead' ? 'lead' : 'follow', main].concat(subs).join('.'),
      name: E.MAIN[main].name + (names.length ? ' (' + names.join(', ') + ')' : ''),
      element: E.MAIN[main].name.toLowerCase(),
      role,
      essences: [E.MAIN[main].name].concat(names),
    };
  }
  function request(key, kind, rec) {
    const p = E.parseKey(key);
    const onA = p.subs.filter(t => t.h === 1).map(t => t.s);
    const onB = p.subs.filter(t => t.h === 2).map(t => t.s);
    const a = side(p, 'lead', p.a, onA), b = side(p, 'follow', p.b, onB);
    const pre = kind === 'form' ? 'ep.f.' : 'ep.t.';
    a.id = pre + a.id.slice(3); b.id = pre + b.id.slice(3);
    const rx = E.REACTION[E.pairId(p.a, p.b)];
    let context;
    if (kind === 'form') {
      context = `Essence Protocol, a creature RPG where the creatures are daemons: artificial minds made of essence. ` +
        `Name and describe the DAEMON whose genome is ${a.name} leading ${b.name}. ` +
        `It is a ${['Seed', 'Build', 'Release', 'Prime'][p.subs.length]}-tier form with base stats ${JSON.stringify(rec.dStats)} (hp, logic, firewall, clock, flux, coherence). ` +
        `The name should be one invented word of 2 to 4 syllables, like a creature species.`;
    } else {
      const fx = rec.fx.map(f => f.code).join(', ');
      context = `Essence Protocol, a creature RPG where daemons (artificial minds) merge essences into combat techniques. ` +
        `Design the TECHNIQUE created by merging these. The two mains react as "${rx.names[p.a]}"${rx.volatile ? ' (volatile, so risky and powerful)' : ''}. ` +
        `Name it in 2 to 4 words and describe what it does when cast in one or two sentences. ` +
        `In tags, include exactly one type from [${TYPES.join(', ')}] and any effects from [${EFFECT_WORDS.join(', ')}]. ` +
        `Use stats attack (damage), defense (shielding/healing strength), special (effect strength) and speed. Higher rarity means a stronger, riskier technique. ` +
        `For reference, the lattice's own reading is a ${rec.cls} with effects: ${fx || 'none'}.`;
    }
    return { a, b, context: context.slice(0, 4000) };
  }
  // ---- bridge item -> ability mechanics (pure, deterministic) ----
  const TYPES = ['strike', 'barrage', 'siphon', 'hex', 'ward', 'mend', 'field'];
  const CLASS_OF = { strike: 'Strike', barrage: 'Barrage', siphon: 'Siphon', hex: 'Hex', ward: 'Ward', mend: 'Mend', field: 'Field' };
  const CLASS_WORDS = {
    Strike: ['strike', 'blade', 'sword', 'lance', 'slash', 'spear', 'fang', 'punch', 'smash', 'hammer', 'bolt', 'edge', 'cleave', 'impale'],
    Barrage: ['barrage', 'volley', 'swarm', 'rain', 'hail', 'shards', 'flurry', 'salvo', 'scatter', 'multi', 'storm', 'torrent'],
    Siphon: ['siphon', 'drain', 'leech', 'vampir', 'absorb', 'devour', 'steal', 'feast'],
    Hex: ['hex', 'curse', 'poison', 'venom', 'stun', 'slow', 'fear', 'bind', 'snare', 'toxic', 'jinx', 'debuff'],
    Ward: ['ward', 'shield', 'barrier', 'armor', 'armour', 'guard', 'wall', 'aegis', 'protect', 'deflect'],
    Mend: ['mend', 'heal', 'restore', 'regen', 'cure', 'repair', 'renew', 'soothe', 'recover'],
    Field: ['field', 'aura', 'zone', 'domain', 'weather', 'terrain', 'realm', 'area', 'surround'],
  };
  const EFFECT_MAP = {
    burn: ['burn', 'fire', 'flame', 'blaze', 'ember', 'scorch', 'magma', 'lava', 'inferno'],
    freeze: ['freeze', 'frozen', 'ice', 'frost', 'glacial', 'cryo'],
    chill: ['chill', 'cold', 'slow', 'sluggish'],
    static: ['static', 'shock', 'lightning', 'spark', 'thunder', 'electric', 'paraly', 'stun'],
    root: ['root', 'vine', 'entangle', 'thorn', 'snare', 'bind'],
    corrupt: ['corrupt', 'poison', 'venom', 'void', 'shadow', 'toxic', 'decay', 'rot'],
    lullaby: ['sleep', 'dream', 'lullaby', 'dormant', 'trance'],
    blind: ['blind', 'smoke', 'ash', 'dazzle', 'glare', 'fog'],
    soak: ['soak', 'wet', 'drench', 'water', 'tide', 'flood'],
    petrify: ['petrify', 'stone', 'fossil', 'calcify'],
    pierce: ['pierce', 'piercing', 'penetrat', 'armor-break', 'sunder'],
    crit: ['crit', 'precise', 'sharp', 'lethal', 'keen', 'assassin'],
    echo: ['echo', 'resonat', 'reverb', 'sound', 'repeat'],
    delay: ['delay', 'time', 'delayed', 'temporal', 'chrono'],
    drain: ['drain', 'leech', 'lifesteal', 'vampir', 'siphon'],
    heal: ['heal', 'restore', 'mend', 'cure'],
    shield: ['shield', 'barrier', 'ward', 'protect'],
    guard: ['guard', 'fortify', 'harden', 'armor'],
    overclock: ['overclock', 'empower', 'strength', 'rage', 'boost'],
    haste: ['haste', 'speed', 'swift', 'quick', 'wind', 'gale'],
    veil: ['veil', 'evasion', 'mist', 'invisible', 'phase'],
    regen: ['regen', 'regenerat', 'renew', 'bloom'],
    wash: ['wash', 'dispel', 'cleanse-foe', 'purge-foe'],
    cleanse: ['cleanse', 'purify', 'purge'],
    priority: ['priority', 'first-strike', 'instant', 'quickdraw'],
  };
  const EFFECT_WORDS = Object.keys(EFFECT_MAP).concat(['recoil']);
  const SELF = new Set(['heal', 'cleanse', 'shield', 'guard', 'overclock', 'haste', 'veil', 'regen']);
  const RARITY_TIER = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4 };
  const lc = x => String(x || '').toLowerCase();
  // Word-prefix matching ("burning" matches "burn"; "barrage" does not match "rage").
  const tokens = text => text.split(/[^a-z0-9-]+/).filter(Boolean);
  const hasWord = (toks, words) => words.some(w => toks.some(t => t.startsWith(w)));
  function statOf(stats, keys) { let v = 0; for (const [k, n] of Object.entries(stats || {})) if (typeof n === 'number' && isFinite(n) && keys.some(w => lc(k).includes(w))) v += Math.max(0, n); return v; }
  const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // Turns a bridge item into the ability mechanics the engine understands.
  // `baked` is the lattice record for the same merge; its element typing and
  // anything the item doesn't speak to are kept.
  function abilityFrom(entry, baked) {
    const tags = (entry.tags || []).map(lc);
    const text = tokens([lc(entry.name), lc(entry.description)].concat(tags).join(' '));
    const tier = RARITY_TIER[lc(entry.rarity)] != null ? RARITY_TIER[lc(entry.rarity)] : 1;
    // class: an explicit type tag wins, then keywords in name/description/tags, then the lattice's own class
    let cls = null;
    for (const t of tags) if (CLASS_OF[t]) { cls = CLASS_OF[t]; break; }
    if (!cls) {
      let best = 0;
      for (const [c, words] of Object.entries(CLASS_WORDS)) { const n = words.filter(w => text.some(t => t.startsWith(w))).length; if (n > best) { best = n; cls = c; } }
    }
    cls = cls || baked.cls;
    const atk = statOf(entry.stats, ['attack', 'atk', 'power', 'damage', 'offen', 'strength', 'magic', 'might']);
    const def = statOf(entry.stats, ['defen', 'def', 'armor', 'armour', 'guard', 'resist', 'toughness', 'heal']);
    const spc = statOf(entry.stats, ['special', 'spell', 'effect', 'mana', 'intellig', 'wisdom', 'control']);
    const spd = statOf(entry.stats, ['speed', 'agility', 'haste', 'quick']);
    const total = atk + def + spc + spd || 1;
    const aS = atk / total, dS = def / total, sS = spc / total, vS = spd / total;
    const damaging = !['Ward', 'Mend'].includes(cls);
    const base = [60, 75, 90, 108, 130][tier];
    let power = 0, hits = 1;
    if (damaging) {
      power = base * (0.6 + aS * 1.1);
      if (cls === 'Barrage') { hits = clampN(2 + Math.floor(tier / 2) + (vS > 0.25 ? 1 : 0), 2, 5); power = power * 1.15 / hits; }
      else if (cls === 'Siphon') power *= 0.85;
      else if (cls === 'Hex') power *= 0.4;
      else if (cls === 'Field') power *= 0.5;
      power = clampN(Math.round(power / 5) * 5, 15, 160);
    }
    const acc = ['Ward', 'Mend'].includes(cls) ? 101 : clampN(Math.round((96 - tier * 3 + vS * 10) / 5) * 5, 60, 100);
    const flux = clampN(Math.round(4 + tier * 3 + (damaging ? power * hits / 30 : 4) + ((baked.subs || []).length)), 3, 30);
    const instab = clampN(Math.round(3 + tier * 5 + (baked.instab || 0) * 0.3 - vS * 10), 0, 60);
    const prio = hasWord(text, EFFECT_MAP.priority) || vS > 0.4 ? 1 : (aS > 0.6 && vS < 0.05 ? -1 : 0);
    // effects: every effect word the item uses, with strength from rarity and its special stat
    const fx = [];
    const chance = clampN(Math.round(25 + tier * 10 + sS * 40 + (cls === 'Hex' ? 25 : 0)), 10, 100);
    for (const [code, words] of Object.entries(EFFECT_MAP)) {
      if (code === 'priority') continue;
      if (!hasWord(text, words)) continue;
      if (!damaging && !SELF.has(code)) continue;
      if (['pierce', 'crit'].includes(code)) fx.push({ code, chance: 100, mag: 1 });
      else if (code === 'drain') fx.push({ code, chance: 100, mag: clampN(Math.round(35 + tier * 8 + dS * 20), 30, 85) });
      else if (code === 'heal') fx.push({ code, chance: 100, mag: clampN(Math.round(20 + tier * 8 + dS * 30), 15, 75) });
      else if (code === 'shield') fx.push({ code, chance: 100, mag: clampN(Math.round(15 + tier * 6 + dS * 30), 12, 60) });
      else if (code === 'regen') fx.push({ code, chance: 100, mag: 5 + tier });
      else if (code === 'delay' || code === 'echo') fx.push({ code, chance: chance, mag: 50 + tier * 5 });
      else fx.push({ code, chance: SELF.has(code) ? clampN(chance + 20, 10, 100) : chance, mag: 0 });
    }
    // every class keeps its core so a sparse item still does something
    const has = c => fx.some(f => f.code === c);
    if (cls === 'Siphon' && !has('drain')) fx.push({ code: 'drain', chance: 100, mag: clampN(Math.round(35 + tier * 8), 30, 85) });
    if (cls === 'Mend' && !has('heal')) fx.push({ code: 'heal', chance: 100, mag: clampN(Math.round(25 + tier * 8 + dS * 30), 15, 75) });
    if (cls === 'Ward' && !has('shield')) fx.push({ code: 'shield', chance: 100, mag: clampN(Math.round(18 + tier * 6 + dS * 30), 12, 60) });
    if (cls === 'Hex' && !fx.some(f => !SELF.has(f.code) && !['pierce', 'crit', 'drain', 'delay', 'echo'].includes(f.code))) fx.push({ code: (baked.fx.find(f => ['burn', 'freeze', 'static', 'root', 'corrupt', 'blind', 'chill', 'soak'].includes(f.code)) || { code: 'chill' }).code, chance: clampN(chance + 20, 10, 100), mag: 0 });
    if (tier >= 3 && damaging && (baked.fx || []).some(f => f.code === 'recoil')) fx.push({ code: 'recoil', chance: 100, mag: 15 });
    fx.sort((x, y) => y.chance - x.chance || (x.code < y.code ? -1 : 1));
    return { cls, power, hits, acc, flux, instab, prio, fx: fx.slice(0, 7), tier };
  }

  function validIds(req) { return ID_RE.test(req.a.id) && ID_RE.test(req.b.id); }

  // ---- browser client ----
  let conf = { url: '/bridge', key: '' };
  let status = { state: 'unknown', detail: '' }; // unknown | online | offline | error
  let cache = {};
  const inflight = new Map();
  const queue = [];
  let busy = false;
  const listeners = [];
  const failed = new Set();
  let strikes = 0; // merges in a row that used up their retries

  function ls(get, k, v) { try { if (get) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } return null; }
  function loadLocal() {
    try { conf = Object.assign(conf, JSON.parse(ls(true, CONF_KEY) || '{}')); } catch (e) { /* keep defaults */ }
    try { cache = JSON.parse(ls(true, CACHE_KEY) || '{}') || {}; } catch (e) { cache = {}; }
  }
  function saveCache() { ls(false, CACHE_KEY, JSON.stringify(cache)); }
  function setConf(c) { conf = Object.assign(conf, c); ls(false, CONF_KEY, JSON.stringify(conf)); status = { state: 'unknown', detail: '' }; failed.clear(); strikes = 0; emit(); }
  function emit(ev) { for (const f of listeners) try { f(ev || { type: 'status', status }); } catch (e) { /* listener error */ } }
  function on(f) { listeners.push(f); }
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function call(path, opts) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    const headers = { 'Content-Type': 'application/json' };
    if (conf.key) headers['X-API-Key'] = conf.key;
    try {
      const res = await fetch(conf.url.replace(/\/$/, '') + path, Object.assign({ headers, signal: ctl.signal }, opts || {}));
      let body = null;
      try { body = await res.json(); } catch (e) { body = null; }
      return { status: res.status, body };
    } catch (e) {
      // a client-side timeout means the bridge is slow, not down: treat it like a retryable 504
      if (e.name === 'AbortError') return { status: 504, body: { detail: 'timed out', retryable: true } };
      return { status: 0, body: { detail: 'connection refused' }, network: true };
    } finally { clearTimeout(timer); }
  }

  async function health() {
    const r = await call('/health', { method: 'GET' });
    if (r.status === 200) status = { state: 'online', detail: '' };
    else if (r.network || (r.body && r.body.bridge_down)) status = { state: 'offline', detail: 'FriedrichBridge is not running. Start it with start_bridge.bat.' };
    else if (r.status === 401) status = { state: 'error', detail: 'The bridge rejected the API key (401).' };
    else status = { state: 'error', detail: `Bridge health check failed (${r.status}).` };
    emit();
    return status;
  }

  // Handles every outcome in the bridge contract.
  async function doMerge(job) {
    for (let attempt = 0; attempt <= BACKOFF.length; attempt++) {
      const r = await call('/merge', { method: 'POST', body: JSON.stringify(job.req) });
      if (r.status === 200 && r.body && r.body.item) {
        status = { state: 'online', detail: '' }; strikes = 0;
        return { ok: true, item: r.body.item, cached: !!r.body.cached, bridgeKey: r.body.key };
      }
      const b = r.body || {};
      if (r.network || b.bridge_down) { status = { state: 'offline', detail: 'FriedrichBridge is not running. Start it with start_bridge.bat.' }; return { ok: false, stop: true }; }
      if (r.status === 401) { status = { state: 'error', detail: 'The bridge rejected the API key (401). Check FRIEDRICH_BRIDGE_KEY.' }; console.error('[bridge] 401', b); return { ok: false, stop: true }; }
      if (r.status === 404) { status = { state: 'error', detail: 'The configured Ollama model is not installed (404): ' + String(b.detail || '') }; console.error('[bridge] 404', b); return { ok: false, stop: true }; }
      if (r.status === 403) { status = { state: 'error', detail: 'The game proxy refused the request (403): ' + String(b.detail || '') }; console.error('[bridge] 403', b); return { ok: false, stop: true }; }
      if (r.status === 422 && Array.isArray(b.detail)) { console.error('[bridge] malformed request (game bug)', job.req, b.detail); return { ok: false }; }
      if (r.status === 422) return { ok: false, modelFailed: true };
      if ([502, 503, 504].includes(r.status) && b.retryable !== false && attempt < BACKOFF.length) { await sleep(BACKOFF[attempt]); continue; }
      // retries used up: this merge is "try again later" (not retried this session). Only a second
      // merge in a row failing this way marks the backend unavailable and drops the queue.
      if (++strikes >= 2) { status = { state: 'error', detail: `The AI backend is unavailable (${r.status}). Try again later.` }; return { ok: false, later: true, stop: true }; }
      return { ok: false, later: true };
    }
    return { ok: false };
  }

  async function pump() {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const job = queue.shift();
      const res = await doMerge(job);
      if (res.ok) {
        const it = res.item;
        // unknown fields (e.g. added later through merge_schema) are kept in the cache
        const entry = { ...it, name: String(it.name || '').slice(0, 48), description: String(it.description || '').slice(0, 400), rarity: it.rarity || '', tags: Array.isArray(it.tags) ? it.tags.slice(0, 12) : [], stats: it.stats || {}, id: it.id, at: Date.now() };
        if (entry.name) { cache[job.cacheKey] = entry; saveCache(); }
        job.resolve(entry.name ? entry : null);
        emit({ type: 'flavor', kind: job.kind, key: job.key, entry, fresh: !res.cached });
      } else {
        if (res.modelFailed || res.later) failed.add(job.cacheKey);
        job.resolve(null);
      }
      inflight.delete(job.cacheKey);
      emit();
      if (res.stop) { // bridge down or misconfigured: drop the rest of the queue for now
        while (queue.length) { const j = queue.shift(); inflight.delete(j.cacheKey); j.resolve(null); }
      }
    }
    busy = false;
  }

  // Ask for a flavor. Resolves with the cached entry, a fresh one, or null.
  function flavor(key, kind, rec) {
    const cacheKey = kind + ':' + key;
    if (cache[cacheKey]) return Promise.resolve(cache[cacheKey]);
    if (status.state === 'offline' || status.state === 'error' || failed.has(cacheKey)) return Promise.resolve(null);
    if (inflight.has(cacheKey)) return inflight.get(cacheKey);
    const req = request(key, kind, rec);
    if (!validIds(req)) { console.error('[bridge] invalid ids', req); return Promise.resolve(null); }
    const pr = new Promise(resolve => queue.push({ key, kind, cacheKey, req, resolve }));
    inflight.set(cacheKey, pr);
    pump();
    return pr;
  }

  function cached(key, kind) { return cache[kind + ':' + key] || null; }
  function allCached() { return cache; }
  function clearCache() { cache = {}; saveCache(); emit(); }
  function pending() { return queue.length + (busy ? 1 : 0); }
  async function recipes(limit) { const r = await call('/merge/recipes?limit=' + (limit || 50), { method: 'GET' }); return r.status === 200 ? r.body : null; }

  if (typeof window !== 'undefined') loadLocal();

  return {
    request, validIds, ID_RE, abilityFrom, TYPES, EFFECT_WORDS,
    health, flavor, cached, allCached, clearCache, pending, recipes, on, setConf,
    get conf() { return Object.assign({}, conf); }, get status() { return status; },
  };
});
