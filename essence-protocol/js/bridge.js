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
      context = `Essence Protocol, a creature RPG where daemons (artificial minds) merge essences into techniques. ` +
        `This merge is a ${rec.cls} technique. The two mains react as "${rx.names[p.a]}"${rx.volatile ? ' (volatile)' : ''}. ` +
        `Power ${rec.power}${rec.hits > 1 ? ' x' + rec.hits : ''}, effects: ${fx || 'none'}${rec.tags.length ? ', resonance: ' + rec.tags.join(', ') : ''}. ` +
        `Name the TECHNIQUE in 2 to 4 words and describe what it looks like when cast, in one or two sentences.`;
    }
    return { a, b, context: context.slice(0, 4000) };
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

  function ls(get, k, v) { try { if (get) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } return null; }
  function loadLocal() {
    try { conf = Object.assign(conf, JSON.parse(ls(true, CONF_KEY) || '{}')); } catch (e) { /* keep defaults */ }
    try { cache = JSON.parse(ls(true, CACHE_KEY) || '{}') || {}; } catch (e) { cache = {}; }
  }
  function saveCache() { ls(false, CACHE_KEY, JSON.stringify(cache)); }
  function setConf(c) { conf = Object.assign(conf, c); ls(false, CONF_KEY, JSON.stringify(conf)); status = { state: 'unknown', detail: '' }; failed.clear(); emit(); }
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
      return { status: 0, body: { detail: e.name === 'AbortError' ? 'timed out' : 'connection refused' }, network: true };
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
        status = { state: 'online', detail: '' };
        return { ok: true, item: r.body.item, cached: !!r.body.cached, bridgeKey: r.body.key };
      }
      const b = r.body || {};
      if (r.network || b.bridge_down) { status = { state: 'offline', detail: 'FriedrichBridge is not running. Start it with start_bridge.bat.' }; return { ok: false, stop: true }; }
      if (r.status === 401) { status = { state: 'error', detail: 'The bridge rejected the API key (401). Check FRIEDRICH_BRIDGE_KEY.' }; console.error('[bridge] 401', b); return { ok: false, stop: true }; }
      if (r.status === 404) { status = { state: 'error', detail: 'The configured Ollama model is not installed (404).' }; console.error('[bridge] 404', b); return { ok: false, stop: true }; }
      if (r.status === 422 && Array.isArray(b.detail)) { console.error('[bridge] malformed request (game bug)', job.req, b.detail); return { ok: false }; }
      if (r.status === 422) return { ok: false, modelFailed: true };
      if ([502, 503, 504].includes(r.status) && b.retryable !== false && attempt < BACKOFF.length) { await sleep(BACKOFF[attempt]); continue; }
      status = { state: 'error', detail: `The AI backend is unavailable (${r.status}). Try again later.` };
      return { ok: false };
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
        const entry = { name: String(it.name || '').slice(0, 48), description: String(it.description || '').slice(0, 400), rarity: it.rarity || '', tags: Array.isArray(it.tags) ? it.tags.slice(0, 12) : [], stats: it.stats || {}, id: it.id, at: Date.now() };
        if (entry.name) { cache[job.cacheKey] = entry; saveCache(); }
        job.resolve(entry.name ? entry : null);
        emit({ type: 'flavor', kind: job.kind, key: job.key, entry, fresh: !res.cached });
      } else {
        if (res.modelFailed) failed.add(job.cacheKey);
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
    request, validIds, ID_RE,
    health, flavor, cached, allCached, clearCache, pending, recipes, on, setConf,
    get conf() { return Object.assign({}, conf); }, get status() { return status; },
  };
});
