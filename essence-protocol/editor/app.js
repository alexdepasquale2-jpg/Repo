/* Essence Protocol content editor: the core.
 *
 * The content is data/*.json (bundled for the browser as js/data.js). The editor keeps the
 * content it loaded (`base`) and your edited copy (`cur`); your changes are always the diff
 * between them (a change set, see js/schema.js), so undo, saving, the Changes page and
 * Claude Code all see the same thing. Every edit is validated with the shared schema and
 * re-baked in a worker with the game's own baker (js/baker.js), so you see which spells,
 * daemons and items it changes before anything is saved.
 *
 * Where changes go depends on how the editor is opened:
 *   local   tools/serve.py: Save writes data/, db/ and js/data.js in the repo
 *   hosted  a claude.ai page: the draft is kept in the page's shared store for Claude Code to apply
 *   offline anywhere else: the draft stays in this browser; export it or copy it for Claude
 */
(function () {
  'use strict';
  const SC = window.CONTENT_SCHEMA, SP = window.SPRITES;
  const ROOT = window.EDITOR_ROOT != null ? window.EDITOR_ROOT : '../';
  const HERE = window.EDITOR_HERE != null ? window.EDITOR_HERE : '';

  // ---------------------------------------------------------------- small helpers
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clone = SC.clone, same = SC.same;
  const debounce = (fn, ms) => { let t = 0; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; d.now = (...a) => { clearTimeout(t); fn(...a); }; return d; };
  const fmt = n => Number(n).toLocaleString('en-US');
  const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : (many || one + 's')}`;
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage off */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* storage off */ } },
  };
  function fnv(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); }

  // ---------------------------------------------------------------- state
  const S = {
    mode: 'offline', modeNote: '', node: false,
    base: null, cur: null, baseHash: '',
    past: [], future: [],
    ops: [], issues: [], errors: 0, warns: 0,
    fields: [], keys: [], index: null,
    baseRows: null, curRows: null, changed: new Map(), bake: { state: 'idle', done: 0, total: 0, error: '' },
    saving: '', savedAt: 0, requests: [], applied: null,
    version: 0, bakes: 0,
  };
  const App = { S, SC, esc, fmt, plural, $, debounce, store, fnv, ROOT };
  window.EDITOR = App;

  // ---------------------------------------------------------------- modules for the edited content
  let modsCache = null;
  App.mods = function () {
    if (modsCache && modsCache.v === S.version) return modsCache.m;
    let m = null;
    try {
      const E = window.ESSENCE.make(S.cur), D = window.DESIGNS.make(E), B = window.BAKER.make(E, D, SC), C = window.CONTENT.make(E);
      const ENG = window.ENGINE.make(E, { fields: S.fields, row: k => (S.curRows && S.curRows[k]) || null, has: k => !!(S.curRows && S.curRows[k]) });
      m = { E, D, B, C, ENG };
    } catch (e) { m = { error: e.message }; }
    modsCache = { v: S.version, m };
    return m;
  };
  App.baseMods = (() => { let m = null; return () => m || (m = (() => { const E = window.ESSENCE.make(S.base); const D = window.DESIGNS.make(E); return { E, D, B: window.BAKER.make(E, D, SC), C: window.CONTENT.make(E) }; })()); })();

  // records: rows are arrays laid out by S.fields
  App.rec = function (key, which) {
    const rows = which === 'base' ? S.baseRows : S.curRows;
    const row = rows && rows[key];
    if (!row) return null;
    const r = { key };
    S.fields.forEach((f, i) => { r[f] = row[i]; });
    return r;
  };
  App.ctx = function () {
    const m = App.mods();
    return { mechanics: Object.keys(window.ENGINE.MECHANICS), organs: Object.keys(SP.ORGANS), reactionKinds: Object.keys(window.ENGINE.REACTION_KINDS), validKey: m.E ? m.E.validKey : null };
  };

  // ---------------------------------------------------------------- changes
  App.get = path => SC.getAt(S.cur, path);
  App.getBase = path => SC.getAt(S.base, path);
  App.isChanged = path => { const a = SC.resolve(S.base, path), b = SC.resolve(S.cur, path); return a.found !== b.found || !same(a.value, b.value); };
  function snapshot() { S.past.push(JSON.stringify(S.cur)); if (S.past.length > 200) S.past.shift(); S.future = []; }
  function applyAll(ops, label) {
    const res = SC.applyOps(S.cur, ops, { force: true });
    if (res.conflicts.length) { App.toast(`Couldn't ${label || 'change that'}: ${res.conflicts[0].why}.`, 'bad'); return false; }
    snapshot();
    S.cur = res.data;
    changed();
    return true;
  }
  // set a value (undefined removes an optional field). Filling in a field of a map entry that
  // doesn't exist yet (a first hand edit on a merge) creates the entry; emptying its last field
  // removes it again.
  App.set = (path, value) => {
    const r = SC.resolve(S.cur, path);
    if (r.found && same(r.value, value)) return true;
    const segs = SC.parsePath(path), parent = segs.slice(0, -1), gp = segs.slice(0, -2);
    const inMap = () => { const g = gp.length ? SC.resolve(S.cur, gp) : null; return !!(g && g.found && g.node && g.node.t === 'map'); };
    if (!r.found && parent.length) {
      const pr = SC.resolve(S.cur, parent);
      if (!pr.found) {
        if (value === undefined) return true;
        const last = segs[segs.length - 1], k = last.b != null ? last.b : last.k;
        if (inMap()) return applyAll([{ op: 'add', path: SC.pathString(parent), value: { [k]: value } }]);
        App.toast('That belongs to something that no longer exists.', 'bad'); return false;
      }
    }
    if (value === undefined) {
      if (!r.found) return true;
      const pr = SC.resolve(S.cur, parent);
      if (pr.found && inMap() && pr.value && Object.keys(pr.value).length === 1) return applyAll([{ op: 'remove', path: SC.pathString(parent) }]);
      return applyAll([{ op: 'remove', path }]);
    }
    return applyAll([{ op: 'set', path, value }]);
  };
  App.batch = (ops, label) => applyAll(ops, label);
  App.add = (listPath, id, item) => applyAll([{ op: 'add', path: `${listPath}[${id}]`, value: item }], 'add it');
  App.remove = path => applyAll([{ op: 'remove', path }], 'remove it');
  App.reset = path => { const b = SC.resolve(S.base, path); return b.found ? App.set(path, clone(b.value)) : App.remove(path); };
  App.replace = (data, label) => { snapshot(); S.cur = clone(data); changed(); if (label) App.toast(label); };
  App.undo = () => { if (!S.past.length) return; S.future.push(JSON.stringify(S.cur)); S.cur = JSON.parse(S.past.pop()); changed(); };
  App.redo = () => { if (!S.future.length) return; S.past.push(JSON.stringify(S.cur)); S.cur = JSON.parse(S.future.pop()); changed(); };
  App.discard = () => { snapshot(); S.cur = clone(S.base); changed(); };

  const listeners = [];
  App.onChange = fn => listeners.push(fn);
  function changed() {
    S.version++;
    S.ops = SC.diff(S.base, S.cur);
    const m = App.mods();
    if (m.E) SP.setEssence(m.E);
    validate();
    persist();
    scheduleBake();
    App.renderChrome();
    App.rerender();
    for (const fn of listeners) fn();
  }
  function validate() {
    const m = App.mods();
    let issues = SC.validate(S.cur, App.ctx());
    if (m.error) issues.push({ level: 'error', path: '', msg: 'The game can\'t load this content: ' + m.error });
    else if (!issues.some(i => i.level === 'error')) issues = issues.concat(SC.checkWorld(m.C));
    S.issues = issues;
    S.errors = issues.filter(i => i.level === 'error').length;
    S.warns = issues.length - S.errors;
  }
  App.issuesAt = path => S.issues.filter(i => i.path === path || i.path.startsWith(path + '.') || i.path.startsWith(path + '['));

  // ---------------------------------------------------------------- baking (worker, with a main-thread fallback)
  let worker = null, workerFailed = false, bakeSeq = 0;
  const waiting = new Map();
  function getWorker() {
    if (worker || workerFailed || typeof Worker === 'undefined') return worker;
    try {
      worker = new Worker(HERE + 'bake-worker.js');
      worker.onmessage = e => {
        const m = e.data, w = waiting.get(m.id);
        if (!w) return;
        if (m.type === 'progress') { w.progress && w.progress(m.done, m.total); return; }
        waiting.delete(m.id);
        if (m.type === 'error') w.reject(new Error(m.message)); else w.resolve(m);
      };
      worker.onerror = e => { e.preventDefault && e.preventDefault(); workerFailed = true; worker = null; for (const w of waiting.values()) w.reject(new Error('the bake worker stopped')); waiting.clear(); };
    } catch (e) { workerFailed = true; worker = null; }
    return worker;
  }
  function callWorker(type, data, progress) {
    const w = getWorker();
    if (!w) return Promise.reject(new Error('no worker'));
    const id = ++bakeSeq;
    return new Promise((resolve, reject) => { waiting.set(id, { resolve, reject, progress }); w.postMessage({ id, type, data }); });
  }
  function bakeHere(data, progress) {
    const E = window.ESSENCE.make(data), D = window.DESIGNS.make(E), B = window.BAKER.make(E, D, SC);
    const shards = B.bakeAll(progress), keys = [], rows = {};
    for (const sh of Object.values(shards)) for (const [k, r] of Object.entries(sh)) { keys.push(k); rows[k] = r; }
    return { fields: B.FIELDS, keys, rows };
  }
  App.bake = function (data, progress) {
    return callWorker('bake', data, progress).catch(err => {
      if (!workerFailed && worker) throw err; // a real bake error
      return new Promise((res, rej) => setTimeout(() => { try { res(bakeHere(data, progress)); } catch (e) { rej(e); } }, 30));
    });
  };
  // Every generated file (db/ shards and index, js/data.js) for some content.
  App.bakeFiles = async function (data) {
    let res;
    try { res = await callWorker('files', data); }
    catch (err) {
      if (!workerFailed && worker) throw err;
      const E = window.ESSENCE.make(data), D = window.DESIGNS.make(E), B = window.BAKER.make(E, D, SC);
      const { files, index } = B.renderAll(B.bakeAll());
      const shas = {};
      for (const s of index.shards) shas[s.pair] = await sha16(files['db/' + s.pair + '.json']);
      files['db/index.json'] = B.renderIndex(index, p => shas[p]);
      res = { files };
    }
    return res.files;
  };
  async function sha16(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  }
  let bakeWanted = 0, baseKeys = [];
  const scheduleBake = debounce(() => runBake(), 450);
  async function runBake() {
    const v = S.version;
    if (!S.ops.length) { S.curRows = S.baseRows; S.keys = baseKeys; S.changed = new Map(); S.index = null; S.bake = { state: 'done', done: 0, total: 0 }; S.bakes++; App.renderChrome(); App.refreshView(); return; }
    if (S.errors) { S.bake = { state: 'blocked', error: plural(S.errors, 'problem') + ' to fix first' }; App.renderChrome(); return; }
    if (S.bake.state === 'running') { bakeWanted = v; return; }
    S.bake = { state: 'running', done: 0, total: S.keys.length };
    App.renderChrome();
    try {
      const res = await App.bake(S.cur, (done, total) => { S.bake.done = done; S.bake.total = total; App.renderChrome(); });
      if (v === S.version) {
        S.curRows = res.rows;
        const keys = res.keys;
        if (keys.length !== S.keys.length || keys.some((k, i) => k !== S.keys[i])) { S.keys = keys; }
        diffRows();
        S.bake = { state: 'done' }; S.bakes++;
      } else S.bake = { state: 'idle' };
    } catch (e) {
      S.bake = { state: 'error', error: e.message };
    }
    App.renderChrome();
    App.refreshView();
    if (bakeWanted && bakeWanted !== v) { bakeWanted = 0; runBake(); } else if (v !== S.version) runBake();
  }
  function diffRows() {
    const ch = new Map();
    if (S.curRows !== S.baseRows) {
      for (const k of Object.keys(S.curRows)) {
        const a = S.baseRows[k], b = S.curRows[k];
        if (!a) { ch.set(k, ['new']); continue; }
        const fs = [];
        for (let i = 0; i < S.fields.length; i++) if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) fs.push(S.fields[i]);
        if (fs.length) ch.set(k, fs);
      }
      for (const k of Object.keys(S.baseRows)) if (!S.curRows[k]) ch.set(k, ['gone']);
    }
    S.changed = ch;
    S.index = null;
  }

  // ---------------------------------------------------------------- where changes go
  const DRAFT_KEY = 'ep-editor-draft-v1', REQ_KEY = 'ep-editor-requests-v1';
  let db = null;
  const persist = debounce(() => {
    if (S.mode === 'hosted') return syncDraft();
    const d = S.ops.length ? { base: S.baseHash, ops: S.ops, at: Date.now() } : null;
    if (d) store.set(DRAFT_KEY, d); else store.del(DRAFT_KEY);
  }, 600);
  // hosted: one document per change in the page's shared store, so Claude Code can read them
  const docIdFor = path => 'op-' + fnv(path) + fnv('x' + path).slice(0, 4);
  let synced = new Map(), syncing = false, syncAgain = false;
  async function syncDraft() {
    if (!db) return;
    if (syncing) { syncAgain = true; return; }
    syncing = true; S.saving = 'saving'; App.renderChrome();
    try {
      const want = new Map(S.ops.map(op => [docIdFor(op.path), op]));
      for (const [id, op] of want) {
        const prev = synced.get(id);
        if (prev && same(prev, op)) continue;
        const body = { path: op.path, op: op.op, label: SC.describePath(op.op === 'remove' ? S.base : S.cur, op.path), at: Date.now(), seq: S.ops.indexOf(op), base: S.baseHash };
        if ('value' in op) body.value = op.value === undefined ? null : op.value;
        if ('before' in op) body.before = op.before === undefined ? null : op.before;
        await db.doc('draft/' + id).set(body);
        synced.set(id, clone(op));
      }
      for (const id of [...synced.keys()]) if (!want.has(id)) { await db.doc('draft/' + id).delete(); synced.delete(id); }
      S.saving = 'saved'; S.savedAt = Date.now();
    } catch (e) {
      S.saving = 'error: ' + (e.message || e.code || e);
    }
    syncing = false; App.renderChrome();
    if (syncAgain) { syncAgain = false; syncDraft(); }
  }
  App.saveRequests = async function () {
    if (S.mode === 'hosted' && db) {
      try {
        const have = await db.collection('requests').get();
        const ids = new Set(S.requests.map(r => r.id));
        for (const d of have.docs) if (!ids.has(d.id)) await db.doc('requests/' + d.id).delete();
        for (const r of S.requests) await db.doc('requests/' + r.id).set({ text: r.text, at: r.at, status: r.status || 'open', reply: r.reply || '' });
      } catch (e) { App.toast('Couldn\'t save the request: ' + (e.message || e.code), 'bad'); }
    } else store.set(REQ_KEY, S.requests);
  };

  // local: the repo, through tools/serve.py
  async function api(method, path, body) {
    const res = await fetch(ROOT + 'api/' + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
    if (!res.ok) throw new Error((json && json.error) || text || res.statusText);
    return json;
  }
  App.api = api;
  App.saveToFiles = async function () {
    if (S.errors) { App.toast(`Fix ${plural(S.errors, 'problem')} first.`, 'bad'); return false; }
    S.saving = 'saving'; App.renderChrome();
    try {
      const files = await App.bakeFiles(S.cur);
      for (const f of SC.FILES) files['data/' + f + '.json'] = SC.format(S.cur[f]);
      const res = await api('PUT', 'files', { files, base: S.baseHash });
      S.base = clone(S.cur); S.baseHash = SC.hashData(S.base); S.baseRows = S.curRows; baseKeys = S.keys; S.past = []; S.future = [];
      store.del(DRAFT_KEY);
      S.saving = 'saved'; S.savedAt = Date.now();
      changed();
      App.toast(`Saved. ${plural(res.written.length, 'file')} written and every merge re-baked.`);
      return true;
    } catch (e) {
      S.saving = 'error: ' + e.message; App.renderChrome();
      App.toast('Saving failed: ' + e.message, 'bad');
      return false;
    }
  };
  // A change set file, the same format tools/content.js apply reads.
  App.changeSet = () => ({ format: SC.CHANGES_FORMAT, base: S.baseHash, made: new Date().toISOString(), ops: S.ops, requests: S.requests.filter(r => r.status !== 'done').map(r => ({ text: r.text, at: r.at })) });
  App.claudePrompt = () => {
    const cs = App.changeSet();
    return `Apply these Essence Protocol content edits from the content editor. Save the JSON below as a file and run \`node essence-protocol/tools/content.js apply <file>\`, then check the result with \`node essence-protocol/tools/verify.js\`.${cs.requests.length ? ' It also lists requests that need new code; do those too.' : ''}\n\n` + JSON.stringify(cs, null, 1);
  };
  App.download = async function (name, text) {
    if (S.mode === 'hosted' && window.claude) {
      try { const dl = await window.claude.use('downloads'); if (dl) { await dl.save({ filename: name, data: text }); return true; } } catch (e) { if (e && e.code === 'cancelled') return false; }
    }
    try {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
      return true;
    } catch (e) { return false; }
  };
  App.copy = async function (text, what) {
    try { await navigator.clipboard.writeText(text); App.toast(`Copied ${what || 'it'}.`); return true; }
    catch (e) { App.modal(`<h2>Copy ${esc(what || 'this')}</h2><p class="dim">Your browser blocked copying. Select the text and copy it yourself.</p><textarea rows="12" readonly>${esc(text)}</textarea><div class="row"><button class="btn pri" data-close>Done</button></div>`); const ta = $('modalCard').querySelector('textarea'); ta.focus(); ta.select(); return false; }
  };
  App.importChanges = function (text) {
    let cs;
    try { cs = JSON.parse(text); } catch (e) { App.toast('That isn\'t a change set (not JSON).', 'bad'); return; }
    const ops = Array.isArray(cs) ? cs : cs.ops;
    if (!Array.isArray(ops)) { App.toast('That isn\'t a change set: it has no "ops".', 'bad'); return; }
    const res = SC.applyOps(S.cur, ops);
    snapshot(); S.cur = res.data; changed();
    if (cs.requests) for (const r of cs.requests) App.addRequest(r.text || String(r));
    App.toast(`Imported ${plural(res.applied.length, 'edit')}${res.conflicts.length ? `; ${plural(res.conflicts.length, 'conflict')} skipped (the content changed since)` : ''}.`, res.conflicts.length ? 'bad' : '');
  };
  App.addRequest = function (text) {
    text = String(text || '').trim();
    if (!text) return;
    S.requests.push({ id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text, at: Date.now(), status: 'open' });
    App.saveRequests(); App.renderChrome(); App.rerender();
  };

  // ---------------------------------------------------------------- toasts and dialogs
  App.toast = function (text, kind) {
    const t = document.createElement('div');
    t.className = 'toast' + (kind ? ' ' + kind : ''); t.textContent = text;
    $('toasts').appendChild(t);
    setTimeout(() => t.remove(), kind === 'bad' ? 6000 : 3200);
    while ($('toasts').children.length > 3) $('toasts').firstElementChild.remove();
  };
  App.modal = function (html) {
    $('modalCard').innerHTML = html; $('modal').hidden = false;
    const f = $('modalCard').querySelector('input, textarea, select, button'); if (f) f.focus();
    return $('modalCard');
  };
  App.closeModal = () => { $('modal').hidden = true; $('modalCard').innerHTML = ''; };
  $('modal').addEventListener('click', e => { if (e.target.id === 'modal' || e.target.closest('[data-close]')) App.closeModal(); });
  // in-page confirm (confirm() does nothing inside a claude.ai page)
  App.confirm = (title, text, yes, danger) => new Promise(res => {
    const card = App.modal(`<h2>${esc(title)}</h2><p class="dim">${esc(text)}</p><div class="row"><button class="btn ${danger ? 'danger' : 'pri'}" data-yes>${esc(yes || 'OK')}</button><button class="btn" data-no>Cancel</button></div>`);
    card.querySelector('[data-yes]').onclick = () => { App.closeModal(); res(true); };
    card.querySelector('[data-no]').onclick = () => { App.closeModal(); res(false); };
  });

  // ---------------------------------------------------------------- sprites
  App.sprite = (key, px, cls) => `<canvas class="sprite ${cls || ''}" data-sp="${esc(key)}" width="${px >= 64 ? 64 : 32}" height="${px >= 64 ? 64 : 32}" style="width:${px}px;height:${px}px"></canvas>`;
  App.paintSprites = function (root) {
    for (const c of (root || document).querySelectorAll('canvas[data-sp]')) {
      if (c.dataset.painted === String(S.version)) continue;
      try { SP.paint(c, c.dataset.sp, { prism: c.dataset.prism === '1' }); c.dataset.painted = String(S.version); } catch (e) { /* a key the content no longer has */ }
    }
  };

  // ---------------------------------------------------------------- essences as chips
  App.essColor = code => { const d = S.cur.essences; const m = d.mains.find(x => x.code === code) || d.subs.find(x => x.code === code); return m ? m.color : '#888'; };
  App.essName = code => { const d = S.cur.essences; const m = d.mains.find(x => x.code === code) || d.subs.find(x => x.code === code); return m ? m.name : code; };
  App.essChip = (code, note) => `<span class="ess" style="--c:${esc(App.essColor(code))}"><i></i>${esc(App.essName(code))}${note ? ` <small>${esc(note)}</small>` : ''}</span>`;
  App.genome = key => {
    const m = App.mods(); if (!m.E || !m.E.validKey(key)) return `<span class="key">${esc(key)}</span>`;
    const p = m.E.parseKey(key);
    const parts = [App.essChip(p.a, p.a === p.b ? 'pure' : 'lead')];
    if (p.a !== p.b) parts.push(App.essChip(p.b, 'second'));
    for (const t of p.subs) parts.push(App.essChip(t.s, 'on ' + App.essName(m.E.hostMain(p, t.h))));
    return `<span class="genome">${parts.join('')}</span>`;
  };
  App.rar = r => `<span class="rar r${r}">${esc(SC.RARITY[r])}</span>`;
  App.tier = t => `<span class="rar r${t}">${esc(SC.TIERS[t])}</span>`;

  // ---------------------------------------------------------------- the form kit
  // Fields render from the schema (label, help, rules) and commit through App.set on change.
  const F = App.F = {};
  const nodeAt = path => { const r = SC.resolve(S.cur, path); if (r.node) return r.node; const b = SC.resolve(S.base, path); return b.node; };
  F.node = nodeAt;
  const pathId = p => 'f-' + fnv(p);
  F.field = function (path, opts) {
    opts = opts || {};
    const node = opts.node || nodeAt(path);
    if (!node) return `<div class="note bad">No field at ${esc(path)}</div>`;
    const v = SC.getAt(S.cur, path);
    const ch = App.isChanged(path);
    const readonly = node.readonly === true || (node.readonly === 'existing' && SC.resolve(S.base, path).found) || opts.readonly;
    const label = opts.label || node.label;
    const help = opts.help !== undefined ? opts.help : node.help;
    return `<div class="fld${ch ? ' changed' : ''}" data-f="${esc(path)}"><span class="lab">${esc(label)}${node.optional ? ' <span class="opt">optional</span>' : ''}${ch ? `<button class="reset" data-reset="${esc(path)}" title="Put back what was there">Reset</button>` : ''}</span>${F.widget(node, v, path, readonly, opts)}${help ? `<span class="help">${esc(help)}</span>` : ''}<span class="err" data-err="${esc(path)}"></span></div>`;
  };
  F.fields = (base, names, opts) => names.map(n => F.field(base + '.' + n, opts && opts[n])).join('');
  const optList = (node) => {
    if (node.options) return node.options.map(o => [o, o]);
    const E = window.ENGINE;
    if (node.catalog === 'mechanics') return Object.entries(E.MECHANICS).map(([k, d]) => [k, `${k}: ${d}`]);
    if (node.catalog === 'reactionKinds') return Object.entries(E.REACTION_KINDS).map(([k, d]) => [k, `${k}: ${d}`]);
    if (node.catalog === 'organs') return Object.entries(SP.ORGANS).map(([k, d]) => [k, `${k}: ${d}`]);
    if (node.catalog === 'rooms') return S.cur.world.rooms.map(r => [r.zone, r.zone]);
    return [];
  };
  F.widget = function (node, v, path, ro, opts) {
    const P = esc(path), dis = ro ? ' disabled' : '';
    switch (node.t) {
      case 'text': return `<input type="text" data-p="${P}" data-w="text" value="${esc(v == null ? '' : v)}"${node.max ? ` maxlength="${node.max * 2}"` : ''}${dis} spellcheck="${/^[a-z]/.test(v || '') ? 'false' : 'true'}">`;
      case 'longtext': return `<textarea data-p="${P}" data-w="text" rows="${Math.min(6, Math.max(2, Math.ceil(String(v || '').length / 70)))}"${dis}>${esc(v == null ? '' : v)}</textarea>`;
      case 'template': return `<textarea data-p="${P}" data-w="text" rows="2"${dis}>${esc(v == null ? '' : v)}</textarea><div class="row tight">${node.vars.map(x => `<button class="chip" data-insert="{${x}}" data-for="${P}" type="button">{${x}}</button>`).join('')}${opts.preview ? `<span class="dim">→ ${esc(opts.preview(v))}</span>` : ''}</div>`;
      case 'int': case 'num': return `<input type="number" data-p="${P}" data-w="num" value="${v == null ? '' : esc(v)}"${node.min != null ? ` min="${node.min}"` : ''}${node.max != null ? ` max="${node.max}"` : ''} step="${node.t === 'int' ? 1 : 0.1}" inputmode="decimal"${dis}>`;
      case 'bool': return `<label class="chk"><input type="checkbox" data-p="${P}" data-w="bool"${v ? ' checked' : ''}${dis}> ${esc(opts.check || 'Yes')}</label>`;
      case 'color': return `<div class="inline"><input type="color" data-p="${P}" data-w="color" value="${esc(v || '#888888')}"${dis}><input type="text" data-p="${P}" data-w="text" value="${esc(v || '')}" class="mono" style="max-width:120px"${dis}></div>`;
      case 'enum': return `<select data-p="${P}" data-w="enum"${dis}>${node.nullable ? `<option value="">${esc(node.nullable)}</option>` : ''}${optList(node).map(([k, l]) => `<option value="${esc(k)}"${k === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
      case 'main': return `<select data-p="${P}" data-w="enum"${dis}>${node.nullable ? `<option value=""${v == null ? ' selected' : ''}>${esc(node.nullable)}</option>` : ''}${S.cur.essences.mains.map(m => `<option value="${m.code}"${m.code === v ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</select>`;
      case 'effect': return `<select data-p="${P}" data-w="enum"${dis}>${S.cur.battle.effects.map(f => `<option value="${f.code}"${f.code === v ? ' selected' : ''}>${esc(f.name)} (${f.code})</option>`).join('')}</select>`;
      case 'subs': {
        const sel = new Set(v || []);
        return `<div class="chips" data-p="${P}" data-w="subs">${S.cur.essences.subs.map(s => `<button type="button" class="chip${sel.has(s.code) ? ' on' : ''}" data-sub="${s.code}" style="--c:${esc(s.color)}"${dis}><span class="sw"></span>${esc(s.name)}</button>`).join('')}</div>`;
      }
      case 'effects': {
        const list = v || [];
        return `<div class="fxrows" data-p="${P}" data-w="effects">${list.map((f, i) => `<div class="fxrow"><select data-i="${i}" data-part="effect"${dis}>${S.cur.battle.effects.map(x => `<option value="${x.code}"${x.code === f.effect ? ' selected' : ''}>${esc(x.name)} (${x.code})</option>`).join('')}</select><input type="number" data-i="${i}" data-part="chance" min="1" max="100" value="${esc(f.chance)}" title="Chance %"${dis}><button type="button" class="btn small ghost" data-i="${i}" data-act="del" aria-label="Remove"${dis}>✕</button></div>`).join('')}<div><button type="button" class="btn small" data-act="addfx"${dis}>+ Add effect</button></div></div>`;
      }
      case 'axes': {
        const o = v || {};
        return `<div class="axes" data-p="${P}" data-w="axes">${SC.AXES.map(a => `<label class="axis${o[a] ? ' on' : ''}" title="${esc(SC.AXIS[a][1])}"><span class="an">${esc(SC.AXIS[a][0])}</span><input type="range" min="0" max="${node.max || 9}" step="0.5" value="${o[a] || 0}" data-ax="${a}"${dis}><input type="number" min="0" max="${node.max || 9}" step="0.5" value="${o[a] || 0}" data-ax="${a}"${dis}></label>`).join('')}</div>`;
      }
      case 'lean': {
        const o = v || {}, codes = S.cur.traits.traits.map(t => t.code);
        return `<div class="fxrows" data-p="${P}" data-w="lean">${Object.entries(o).map(([c, w]) => `<div class="fxrow"><span>${esc(c)}</span><input type="number" min="0" max="5" step="0.1" value="${esc(w)}" data-code="${esc(c)}"${dis}><button type="button" class="btn small ghost" data-code="${esc(c)}" data-act="del" aria-label="Remove"${dis}>✕</button></div>`).join('')}<div class="inline"><select data-act="addsel"${dis}><option value="">+ Lean toward…</option>${codes.filter(c => !(c in o)).map(c => `<option>${c}</option>`).join('')}</select></div></div>`;
      }
      case 'stats': {
        const o = v || {};
        return `<div class="pairs" data-p="${P}" data-w="stats">${SC.STAT_KEYS.map(k => `<label>${esc(SC.STAT[k])}<input type="number" min="${node.min}" max="${node.max}" step="1" data-k="${k}" value="${o[k] == null ? '' : esc(o[k])}"${node.partial ? ' placeholder="rule"' : ''}${dis}></label>`).join('')}</div>`;
      }
      case 'statText': case 'axisText': {
        const keys = node.t === 'statText' ? SC.STAT_KEYS : SC.AXES, lab = k => node.t === 'statText' ? SC.STAT[k] : SC.AXIS[k][0];
        return `<div class="stack" data-p="${P}" data-w="keyed">${keys.map(k => `<label class="pairs" style="grid-template-columns:110px 1fr;align-items:center"><span class="dim">${esc(lab(k))}</span><input type="text" data-k="${k}" value="${esc((v || {})[k] || '')}"${dis}></label>`).join('')}</div>`;
      }
      case 'leadNames': {
        const pair = path.split('.').slice(-2, -1)[0] || '';
        return `<div class="pairs" data-p="${P}" data-w="keyed">${[...new Set(pair.split(''))].map(m => `<label>${esc(App.essName(m))} leads<input type="text" data-k="${m}" value="${esc((v || {})[m] || '')}"${dis}></label>`).join('')}</div>`;
      }
      case 'words': {
        const list = v || [], usage = opts.usage || {};
        return `<div class="words" data-p="${P}" data-w="words">${list.map((w, i) => `<span class="wd">${esc(w)}${usage[w] != null ? `<span class="u" title="merges using it">${fmt(usage[w])}</span>` : ''}${ro ? '' : `<button type="button" data-i="${i}" aria-label="Remove ${esc(w)}">✕</button>`}</span>`).join('')}${ro ? '' : `<input type="text" data-act="addword" placeholder="${list.length ? 'Add…' : 'Add a word…'} (Enter; paste several)" spellcheck="false">`}</div>`;
      }
      case 'lines': {
        const list = v || [];
        return `<div class="lines" data-p="${P}" data-w="lines">${list.map((l, i) => `<div class="line"><textarea data-i="${i}" rows="2"${dis}>${esc(l)}</textarea><div class="tools"><button type="button" class="btn small ghost" data-act="up" data-i="${i}" aria-label="Move up"${i ? '' : ' disabled'}>↑</button><button type="button" class="btn small ghost" data-act="del" data-i="${i}" aria-label="Remove">✕</button></div></div>`).join('')}${ro ? '' : '<div><button type="button" class="btn small" data-act="addline">+ Add a line</button></div>'}</div>`;
      }
      case 'tiers': {
        const list = v || [];
        return `<div class="tiers" data-p="${P}" data-w="tiers" data-of="${node.of}">${SC.TIERS.map((t, i) => `<label>${t}<input type="${node.of === 'int' ? 'number' : 'text'}" data-i="${i}" value="${esc(list[i] == null ? '' : list[i])}"${dis}></label>`).join('')}</div>`;
      }
      case 'suffixes': {
        return `<div class="stack">${SC.SUB_TIERS.map((t, i) => `<div class="fld"><span class="lab">${t}</span>${F.widget({ t: 'words' }, (v || [])[i], path + '[' + i + ']', ro, {})}</div>`).join('')}</div>`;
      }
      case 'facets': {
        return `<div class="grid g2">${S.cur.essences.mains.map(m => `<div class="card" style="padding:12px"><h4 style="margin-bottom:8px">On ${esc(m.name)}</h4><div class="form">${F.field(path + '.' + m.code + '.name', { node: { t: 'text', label: 'Facet name', max: 16 } })}${F.field(path + '.' + m.code + '.effect', { node: { t: 'effect', label: 'Extra effect' } })}${F.field(path + '.' + m.code + '.traits', { node: { t: 'axes', label: 'Extra pushes', max: 9 } })}</div></div>`).join('')}</div>`;
      }
      case 'mergeKey': {
        const m = App.mods(), ok = m.E && m.E.validKey(v), r = ok ? App.rec(v) : null;
        return `<div class="inline" data-keyfield="${P}">${ok ? App.sprite(v, 32) : ''}<input type="text" class="mono" data-p="${P}" data-w="key" value="${esc(v || '')}" spellcheck="false" style="max-width:190px"${dis}><button type="button" class="btn small" data-pick="${P}"${dis}>Pick…</button>${r ? `<span class="dim">${esc(r.dName)} · ${esc(r.name)}</span>` : ''}</div>`;
      }
      case 'grid': return `<textarea data-p="${P}" data-w="grid" class="mono" rows="${(v || []).length + 1}"${dis}>${esc((v || []).join('\n'))}</textarea>`;
      default: return `<textarea data-p="${P}" data-w="json" class="mono" rows="4"${dis}>${esc(JSON.stringify(v, null, 1))}</textarea>`;
    }
  };
  // Show validation messages next to the fields they belong to.
  App.showIssues = function (root) {
    root = root || $('view');
    for (const e of root.querySelectorAll('[data-err]')) {
      const p = e.dataset.err, own = S.issues.filter(i => i.path === p || i.path.startsWith(p + '.') || i.path.startsWith(p + '['));
      e.textContent = own.filter(i => i.level === 'error').map(i => i.msg).join(' · ') || own.map(i => i.msg).join(' · ');
      const box = e.closest('.fld');
      if (box) for (const inp of box.querySelectorAll(':scope > input, :scope > textarea, :scope > select, :scope > .words, :scope > .inline > input')) inp.classList.toggle('bad', own.some(i => i.level === 'error'));
    }
  };

  // one set of listeners for every field on the page
  function valueFromWidget(el) {
    const w = el.dataset.w, path = el.dataset.p;
    if (w === 'text') { const node = nodeAt(path); const t = el.value; return (node && node.optional && !t.trim()) ? undefined : t; }
    if (w === 'num') { const node = nodeAt(path); if (el.value === '') return node && node.optional ? undefined : null; const n = Number(el.value); return node && node.t === 'int' ? Math.round(n) : n; }
    if (w === 'bool') return el.checked || undefined;
    if (w === 'color') return el.value;
    if (w === 'enum') { const node = nodeAt(path); return el.value === '' && node && node.nullable ? null : el.value; }
    if (w === 'key') return el.value.trim();
    if (w === 'grid') return el.value.split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.length);
    if (w === 'json') { try { return JSON.parse(el.value); } catch (e) { App.toast('That isn\'t valid JSON.', 'bad'); return SC.getAt(S.cur, path); } }
    return el.value;
  }
  const setFromBool = (path, on) => { const node = nodeAt(path); App.set(path, on ? true : (node && node.t === 'bool' && !SC.resolve(S.base, path).found ? undefined : false)); };
  function compositeChange(host, target) {
    const path = host.dataset.p, w = host.dataset.w, v = clone(SC.getAt(S.cur, path));
    if (w === 'effects') {
      const list = v || [], i = +target.dataset.i;
      if (target.dataset.part === 'effect') list[i].effect = target.value;
      if (target.dataset.part === 'chance') list[i].chance = Math.max(1, Math.min(100, Math.round(Number(target.value) || 1)));
      return App.set(path, list);
    }
    if (w === 'axes') {
      const o = v || {}, a = target.dataset.ax, n = Math.max(0, Number(target.value) || 0);
      if (n) o[a] = n; else delete o[a];
      const ordered = {}; for (const k of SC.AXES) if (o[k]) ordered[k] = o[k];
      for (const k of Object.keys(o)) if (!(k in ordered)) ordered[k] = o[k];
      return App.set(path, ordered);
    }
    if (w === 'lean') { const o = v || {}; o[target.dataset.code] = Math.max(0, Number(target.value) || 0); return App.set(path, o); }
    if (w === 'stats') { const o = v || {}; if (target.value === '') delete o[target.dataset.k]; else o[target.dataset.k] = Math.round(Number(target.value)); return App.set(path, Object.keys(o).length ? o : undefined); }
    if (w === 'keyed') { const o = v || {}; o[target.dataset.k] = target.value; return App.set(path, o); }
    if (w === 'lines') { const list = v || []; list[+target.dataset.i] = target.value; return App.set(path, list); }
    if (w === 'tiers') { const list = v || []; list[+target.dataset.i] = host.dataset.of === 'int' ? Math.round(Number(target.value)) : target.value; return App.set(path, list); }
  }
  document.addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.act === 'addsel') { const host = t.closest('[data-w]'); const o = clone(SC.getAt(S.cur, host.dataset.p)) || {}; if (t.value) { o[t.value] = 1; App.set(host.dataset.p, o); } return; }
    if (t.dataset.w && t.dataset.p) {
      if (t.dataset.w === 'bool') return setFromBool(t.dataset.p, t.checked);
      return App.set(t.dataset.p, valueFromWidget(t));
    }
    const host = t.closest('[data-w]');
    if (host && host.dataset.p && ['effects', 'axes', 'lean', 'stats', 'keyed', 'lines', 'tiers'].includes(host.dataset.w)) compositeChange(host, t);
  });
  document.addEventListener('input', e => {
    const t = e.target;
    if (t.type === 'range' && t.dataset.ax) { const n = t.parentElement.querySelector('input[type=number]'); if (n) n.value = t.value; t.parentElement.classList.toggle('on', +t.value > 0); }
    if (t.type === 'color' && t.dataset.p) { const txt = t.parentElement.querySelector('input[type=text]'); if (txt) txt.value = t.value; }
  });
  function addWords(host, text) {
    const path = host.dataset.p, list = clone(SC.getAt(S.cur, path)) || [];
    const words = String(text).split(/[\n,;]+/).map(w => w.trim()).filter(Boolean);
    let added = 0;
    for (const w of words) if (!list.includes(w)) { list.push(w); added++; }
    if (added) App.set(path, list); else if (words.length) App.toast('Already in the list.');
  }
  document.addEventListener('keydown', e => {
    const t = e.target;
    if (t.dataset && t.dataset.act === 'addword' && (e.key === 'Enter' || e.key === ',')) { e.preventDefault(); const host = t.closest('[data-w="words"]'); const val = t.value; t.value = ''; addWords(host, val); setTimeout(() => { const again = document.querySelector(`[data-w="words"][data-p="${CSS.escape(host.dataset.p)}"] input[data-act="addword"]`); if (again) again.focus(); }, 0); }
    if (t.dataset && t.dataset.act === 'addword' && e.key === 'Backspace' && !t.value) { const host = t.closest('[data-w="words"]'); const list = clone(SC.getAt(S.cur, host.dataset.p)) || []; if (list.length) { list.pop(); App.set(host.dataset.p, list); setTimeout(() => { const again = document.querySelector(`[data-w="words"][data-p="${CSS.escape(host.dataset.p)}"] input[data-act="addword"]`); if (again) again.focus(); }, 0); } }
    if (t.tagName === 'INPUT' && t.type !== 'search' && e.key === 'Enter' && t.dataset.w && t.dataset.w !== 'text') t.blur();
  });
  document.addEventListener('paste', e => {
    const t = e.target;
    if (t.dataset && t.dataset.act === 'addword') { const text = (e.clipboardData || window.clipboardData).getData('text'); if (/[\n,;]/.test(text)) { e.preventDefault(); addWords(t.closest('[data-w="words"]'), text); } }
  });
  document.addEventListener('focusout', e => {
    const t = e.target;
    if (t.dataset && t.dataset.act === 'addword' && t.value.trim()) { const host = t.closest('[data-w="words"]'); const val = t.value; t.value = ''; addWords(host, val); }
  });
  document.addEventListener('click', e => {
    const t = e.target.closest('button, [data-go]');
    if (!t) return;
    if (t.dataset.reset) { App.reset(t.dataset.reset); return; }
    if (t.dataset.go) { e.preventDefault(); App.go(t.dataset.go); return; }
    if (t.dataset.insert) { const ta = document.querySelector(`[data-p="${CSS.escape(t.dataset.for)}"]`); if (ta) { const s = ta.selectionStart || ta.value.length; ta.value = ta.value.slice(0, s) + t.dataset.insert + ta.value.slice(ta.selectionEnd || s); ta.focus(); App.set(ta.dataset.p, ta.value); } return; }
    if (t.dataset.pick) { App.pickKey(SC.getAt(S.cur, t.dataset.pick), key => App.set(t.dataset.pick, key)); return; }
    const host = t.closest('[data-w]');
    if (!host || !host.dataset.p) return;
    const path = host.dataset.p, w = host.dataset.w, v = clone(SC.getAt(S.cur, path));
    if (w === 'words' && t.dataset.i != null) { v.splice(+t.dataset.i, 1); App.set(path, v); return; }
    if (w === 'subs' && t.dataset.sub) {
      const node = nodeAt(path) || {}, list = v || [], s = t.dataset.sub, i = list.indexOf(s);
      if (i >= 0) list.splice(i, 1); else { if (node.count && list.length >= node.count) list.shift(); list.push(s); }
      App.set(path, list); return;
    }
    if (w === 'effects') {
      if (t.dataset.act === 'addfx') { const list = v || []; list.push({ effect: S.cur.battle.effects[0].code, chance: 20 }); App.set(path, list); }
      if (t.dataset.act === 'del') { v.splice(+t.dataset.i, 1); App.set(path, v); }
      return;
    }
    if (w === 'lean' && t.dataset.act === 'del') { delete v[t.dataset.code]; App.set(path, v); return; }
    if (w === 'lines') {
      const i = +t.dataset.i, list = v || [];
      if (t.dataset.act === 'addline') { list.push(''); App.set(path, list); setTimeout(() => { const tas = document.querySelectorAll(`[data-w="lines"][data-p="${CSS.escape(path)}"] textarea`); if (tas.length) tas[tas.length - 1].focus(); }, 0); }
      if (t.dataset.act === 'del') { list.splice(i, 1); App.set(path, list); }
      if (t.dataset.act === 'up' && i > 0) { [list[i - 1], list[i]] = [list[i], list[i - 1]]; App.set(path, list); }
    }
  });

  // ---------------------------------------------------------------- genome picker (merge keys)
  App.pickKey = function (current, done) {
    const m = App.mods(); if (!m.E) return;
    const E = m.E;
    let p = current && E.validKey(current) ? E.parseKey(current) : { a: E.MAINS[0], b: E.MAINS[0], subs: [] };
    const card = App.modal('<div id="pk"></div>');
    function draw() {
      const key = E.makeKey(p.a, p.b, p.subs), r = App.rec(key);
      const slots = E.slotsFor(p.a, p.b);
      card.querySelector('#pk').innerHTML = `<h2>Pick a genome</h2>
        <p class="dim">A daemon is a lead main, a second main and up to ${E.MAX_SUBS} sub-essences bound to either one.</p>
        <div class="fld"><span class="lab">Lead</span><div class="chips">${E.MAINS.map(x => `<button class="chip${p.a === x ? ' on' : ''}" data-a="${x}" style="--c:${esc(App.essColor(x))}"><span class="sw"></span>${esc(App.essName(x))}</button>`).join('')}</div></div>
        <div class="fld"><span class="lab">Second</span><div class="chips">${E.MAINS.map(x => `<button class="chip${p.b === x ? ' on' : ''}" data-b="${x}" style="--c:${esc(App.essColor(x))}"><span class="sw"></span>${esc(App.essName(x))}</button>`).join('')}</div></div>
        <div class="fld"><span class="lab">Sub-essences <span class="opt">${p.subs.length}/${E.MAX_SUBS}</span></span><div class="chips">${slots.map(t => { const on = p.subs.some(u => u.s === t.s && u.h === t.h); return `<button class="chip${on ? ' on' : ''}" data-s="${t.s}" data-h="${t.h}" style="--c:${esc(App.essColor(t.s))}"${!on && p.subs.length >= E.MAX_SUBS ? ' disabled' : ''}><span class="sw"></span>${esc(App.essName(t.s))}${p.a !== p.b ? ` <small class="dim">on ${esc(App.essName(t.h === 1 ? p.a : p.b))}</small>` : ''}</button>`; }).join('')}</div></div>
        <div class="row" style="align-items:center">${App.sprite(key, 64)}<div><div><span class="key">${esc(key)}</span></div><b>${esc(r ? r.dName : '')}</b><div class="dim">${esc(r ? r.name + ' · ' + r.cls : '')}</div></div></div>
        <div class="row"><button class="btn pri" data-use>Use ${esc(key)}</button><button class="btn" data-close>Cancel</button></div>`;
      App.paintSprites(card);
    }
    card.onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.a) { p.a = b.dataset.a; if (p.a === p.b) p.subs = p.subs.filter(t => t.h === 1); p.subs = p.subs.filter(t => E.eligible(t.s, t.h === 1 ? p.a : p.b)); draw(); }
      else if (b.dataset.b) { p.b = b.dataset.b; if (p.a === p.b) p.subs = p.subs.filter(t => t.h === 1); p.subs = p.subs.filter(t => E.eligible(t.s, t.h === 1 ? p.a : p.b)); draw(); }
      else if (b.dataset.s) { const s = b.dataset.s, h = +b.dataset.h, i = p.subs.findIndex(u => u.s === s && u.h === h); if (i >= 0) p.subs.splice(i, 1); else if (p.subs.length < E.MAX_SUBS) p.subs.push({ s, h }); draw(); }
      else if (b.hasAttribute('data-use')) { const key = E.makeKey(p.a, p.b, p.subs); App.closeModal(); done(key); }
    };
    draw();
  };

  // ---------------------------------------------------------------- routing and chrome
  App.views = {};
  App.route = { name: 'dashboard', args: [] };
  App.go = function (hash) {
    hash = String(hash).replace(/^#?\/?/, '');
    if (location.hash.slice(1) !== hash) { try { location.hash = hash; return; } catch (e) { /* fall through */ } }
    onRoute();
  };
  function onRoute() {
    const parts = decodeURIComponent(location.hash.replace(/^#\/?/, '')).split('/').filter(Boolean);
    const name = App.views[parts[0]] ? parts[0] : 'dashboard';
    App.route = { name, args: parts.slice(1) };
    store.set('ep-editor-route', location.hash);
    closeNav();
    App.render();
    $('view').scrollTop = 0;
  }
  addEventListener('hashchange', onRoute);

  App.render = function () {
    if (!S.cur) return;
    const v = App.views[App.route.name];
    const el = $('view');
    try { el.innerHTML = v.render(App.route.args) || ''; }
    catch (e) { console.error(e); el.innerHTML = `<div class="page"><div class="note bad">This page failed to draw: ${esc(e.message)}</div></div>`; }
    if (v.after) try { v.after(el, App.route.args); } catch (e) { console.error(e); }
    App.paintSprites(el);
    App.showIssues(el);
    App.renderNav();
  };
  // re-draw after an edit, keeping focus and scroll (batched, so a click that caused a blur
  // still lands on the button it was aimed at)
  let rerenderQueued = false;
  App.rerender = function () {
    if (!S.cur || rerenderQueued) return;
    rerenderQueued = true;
    setTimeout(() => { rerenderQueued = false; rerenderNow(); }, 0);
  };
  function rerenderNow() {
    const el = $('view'), a = document.activeElement, top = el.scrollTop;
    const focusKey = a && el.contains(a) ? { p: a.dataset.p, i: a.dataset.i, part: a.dataset.part, ax: a.dataset.ax, k: a.dataset.k, code: a.dataset.code, act: a.dataset.act, type: a.type, sel: a.selectionStart } : null;
    App.render();
    el.scrollTop = top;
    if (focusKey && (focusKey.p || focusKey.act)) {
      const sel = Object.entries({ p: focusKey.p, i: focusKey.i, part: focusKey.part, ax: focusKey.ax, k: focusKey.k, code: focusKey.code }).filter(([, v]) => v != null).map(([k, v]) => `[data-${k}="${CSS.escape(v)}"]`).join('');
      const n = sel ? el.querySelector(sel + (focusKey.type ? `[type="${focusKey.type}"]` : '')) || el.querySelector(sel) : null;
      if (n) { n.focus({ preventScroll: true }); try { if (focusKey.sel != null && n.setSelectionRange) n.setSelectionRange(focusKey.sel, focusKey.sel); } catch (e) { /* not a text field */ } }
    }
  }
  // a lighter refresh after a bake finishes: views can update just their derived parts
  App.refreshView = function () {
    const v = App.views[App.route.name];
    if (v && v.refresh) { try { v.refresh($('view'), App.route.args); } catch (e) { console.error(e); } App.paintSprites($('view')); }
    else if (v && v.bakeAware) App.rerender();
    App.renderNav();
  };

  const NAV = [
    ['Overview', [['dashboard', '◈', 'Dashboard']]],
    ['Merges', [['spells', '⚔', 'Spells', () => S.keys.length], ['daemons', '☻', 'Daemons', () => S.keys.length], ['items', '⬡', 'Items', () => S.keys.length], ['overrides', '✎', 'Hand edits', () => Object.keys(S.cur.overrides).length]]],
    ['Content', [['essences', '◐', 'Essences', () => S.cur.essences.mains.length + S.cur.essences.subs.length], ['combos', '⁂', 'Combos', () => S.cur.combos.resonances.length + S.cur.combos.trinities.length], ['battle', '✴', 'Battle'], ['traits', '✦', 'Traits', () => S.cur.traits.traits.length], ['words', '¶', 'Words and names'], ['world', '⌖', 'World']]],
    ['Assets', [['assets', '▦', 'Sprites and colors']]],
    ['Your changes', [['changes', '⇄', 'Changes', () => S.ops.length, true], ['claude', '✉', 'Claude Code', () => S.requests.filter(r => r.status !== 'done').length]]],
  ];
  App.renderNav = function () {
    if (!S.cur) return;
    $('navList').innerHTML = NAV.map(([g, items]) => `<div class="navgroup">${esc(g)}</div>` + items.map(([id, ico, label, count, hot]) => {
      const n = count ? count() : null;
      return `<button class="navlink${App.route.name === id ? ' on' : ''}" data-go="${id}"><span class="ico">${ico}</span>${esc(label)}${n != null ? `<span class="ct${hot && n ? ' hot' : ''}">${fmt(n)}</span>` : ''}</button>`;
    }).join('')).join('');
    const modeText = { local: 'Saving to the repo files', hosted: 'Draft kept for Claude Code', offline: 'Draft kept in this browser' }[S.mode];
    $('navFoot').innerHTML = `<div class="row"><span>${esc(modeText)}</span></div><div class="row"><button class="btn small" id="themeBtn" type="button">Theme: ${esc(store.get('ep-editor-theme', 'system'))}</button></div>`;
  };
  App.renderChrome = function () {
    if (!S.cur) return;
    const pills = [];
    const b = S.bake;
    if (b.state === 'running') pills.push(`<span class="pill acc"><span class="spin"></span>Baking ${b.total ? Math.round(b.done / b.total * 100) + '%' : ''}</span>`);
    else if (b.state === 'error') pills.push(`<span class="pill bad" title="${esc(b.error)}">Bake failed</span>`);
    else if (b.state === 'blocked') pills.push(`<button class="pill bad" data-go="changes">${esc(b.error)}</button>`);
    else if (S.ops.length) pills.push(`<span class="pill good"><span class="dot"></span>${plural(S.changed.size, 'merge')} change</span>`);
    if (S.errors) pills.push(`<button class="pill bad" data-go="changes">${plural(S.errors, 'problem')}</button>`);
    if (S.mode === 'hosted' && S.ops.length) pills.push(S.saving === 'saving' ? '<span class="pill">Saving draft…</span>' : S.saving.startsWith('error') ? `<span class="pill bad" title="${esc(S.saving)}">Draft not saved</span>` : '<span class="pill good">Draft saved</span>');
    if (S.mode === 'local' && S.saving.startsWith('error')) pills.push(`<span class="pill bad" title="${esc(S.saving)}">Not saved</span>`);
    $('status').innerHTML = pills.join('');
    $('changesCount').textContent = fmt(S.ops.length);
    $('undoBtn').disabled = !S.past.length; $('redoBtn').disabled = !S.future.length;
  };

  // nav drawer on phones
  const openNav = () => { $('nav').classList.add('open'); $('scrim').hidden = false; };
  function closeNav() { $('nav').classList.remove('open'); $('scrim').hidden = true; }
  $('menuBtn').onclick = openNav; $('scrim').onclick = closeNav;
  $('undoBtn').onclick = App.undo; $('redoBtn').onclick = App.redo;
  $('changesBtn').onclick = () => App.go('changes');
  $('nav').addEventListener('click', e => { if (e.target.id === 'themeBtn') { const order = ['system', 'light', 'dark']; const next = order[(order.indexOf(store.get('ep-editor-theme', 'system')) + 1) % 3]; store.set('ep-editor-theme', next); applyTheme(); App.renderNav(); } });
  function applyTheme() { const t = store.get('ep-editor-theme', 'system'); if (t === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t); }
  applyTheme();
  addEventListener('keydown', e => {
    const inField = /INPUT|TEXTAREA|SELECT/.test((e.target.tagName || ''));
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !inField) { e.preventDefault(); if (e.shiftKey) App.redo(); else App.undo(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y' && !inField) { e.preventDefault(); App.redo(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('q').focus(); }
    if (e.key === '/' && !inField) { e.preventDefault(); $('q').focus(); }
    if (e.key === 'Escape' && !$('modal').hidden) App.closeModal();
  });
  // the draft is kept (in this browser, or in the page's store) so leaving never loses edits; only
  // warn when this browser can't keep it
  addEventListener('beforeunload', e => { if (S.mode !== 'hosted' && S.ops.length && store.get(DRAFT_KEY, null) === null) { e.preventDefault(); e.returnValue = ''; } });

  // ---------------------------------------------------------------- search everything
  function buildIndex() {
    const items = [];
    const d = S.cur;
    for (const k of S.keys) {
      const r = S.curRows[k];
      if (!r) continue;
      items.push({ kind: 'merge', key: k, text: (k + ' ' + r[0] + ' ' + r[12] + ' ' + r[17][1]).toLowerCase(), t: r[12], s: `${r[0]} · ${r[17][1]}`, go: 'spells/' + k });
    }
    const ent = (kind, t, s, go, extra) => items.push({ kind, t, s, go, text: (t + ' ' + (extra || '') + ' ' + s).toLowerCase() });
    for (const m of d.essences.mains) ent('Essence', m.name, 'main essence · ' + m.passive.name, 'essences/' + m.code, m.code);
    for (const x of d.essences.subs) ent('Essence', x.name, `sub-essence · ${x.host ? 'on ' + App.essName(x.host) : 'universal'} · ${x.passive.name}`, 'essences/' + x.code, x.code + ' ' + x.adjectives.join(' '));
    for (const [pid, r] of Object.entries(d.essences.reactions)) ent('Reaction', Object.values(r.names).join(' / '), 'pair reaction ' + pid, 'essences/pair/' + pid, pid);
    for (const r of d.combos.resonances) ent('Resonance', r.name, r.subs.map(App.essName).join(' + '), 'combos/resonances/' + r.id);
    for (const r of d.combos.trinities) ent('Trinity', r.name, r.subs.map(App.essName).join(' + '), 'combos/trinities/' + r.id);
    for (const a of d.combos.anomalies) ent('Anomaly', a.id, a.desc, 'combos/anomalies/' + a.id);
    for (const c of d.battle.classes) ent('Class', c.id, c.desc, 'battle/classes/' + c.id, c.nouns.join(' '));
    for (const f of d.battle.effects) ent('Effect', f.name, f.code, 'battle/effects');
    for (const s of d.battle.statuses) ent('Status', s.name, s.text, 'battle/statuses/' + s.id);
    for (const r of d.battle.residue) ent('Residue', r.name, `${App.essName(r.cast)} into ${App.essName(r.into)} residue · ${r.kind}`, 'battle/residue');
    for (const t of d.traits.traits) ent('Trait', t.code, t.does, 'traits/' + t.code, t.nouns.join(' ') + ' ' + t.epithet);
    for (const z of d.world.zones) ent('Zone', z.name, `${z.wild.length} wild daemons`, 'world/zones/' + z.id);
    for (const t of d.world.trainers) ent('Trainer', t.name, `${t.zone} · ${t.team.length} daemons`, 'world/trainers/' + t.id, t.intro + ' ' + t.outro);
    for (const n of d.world.npcs) ent('Person', n.name, n.lines[0] || '', 'world/people/' + n.id, n.lines.join(' '));
    for (const k of d.items.kinds) ent('Item kind', k.name, k.desc, 'words/items');
    S.index = items;
  }
  let qSel = 0, qItems = [];
  function runSearch() {
    const q = $('q').value.trim().toLowerCase(), box = $('qResults');
    if (!q) { box.hidden = true; return; }
    if (!S.index) buildIndex();
    const words = q.split(/\s+/);
    const hit = it => words.every(w => it.text.includes(w));
    const ents = S.index.filter(it => it.kind !== 'merge' && hit(it)).slice(0, 8);
    const merges = S.index.filter(it => it.kind === 'merge' && hit(it));
    qItems = ents.concat(merges.slice(0, 12)); qSel = 0;
    box.innerHTML = (ents.length ? '<div class="shead">Content</div>' + ents.map((it, i) => `<button class="sres" data-qi="${i}"><span class="dim" style="font-size:11px">${esc(it.kind)}</span><span><div class="t">${esc(it.t)}</div><div class="s">${esc(it.s)}</div></span></button>`).join('') : '') +
      (merges.length ? `<div class="shead">Merges · ${fmt(merges.length)}</div>` + merges.slice(0, 12).map((it, i) => `<button class="sres" data-qi="${ents.length + i}">${App.sprite(it.key, 32)}<span><div class="t">${esc(it.t)}</div><div class="s">${esc(it.s)}</div></span><span class="key">${esc(it.key)}</span></button>`).join('') : '') +
      (!ents.length && !merges.length ? '<div class="empty">Nothing matches.</div>' : '');
    box.hidden = false;
    App.paintSprites(box);
    markSel();
  }
  const markSel = () => { for (const b of $('qResults').querySelectorAll('.sres')) b.classList.toggle('on', +b.dataset.qi === qSel); };
  $('q').addEventListener('input', debounce(runSearch, 120));
  $('q').addEventListener('focus', () => { if ($('q').value.trim()) runSearch(); });
  $('q').addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { qSel = Math.min(qItems.length - 1, qSel + 1); markSel(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { qSel = Math.max(0, qSel - 1); markSel(); e.preventDefault(); }
    if (e.key === 'Enter' && qItems[qSel]) { App.go(qItems[qSel].go); $('qResults').hidden = true; $('q').blur(); }
    if (e.key === 'Escape') { $('qResults').hidden = true; $('q').blur(); }
  });
  $('qResults').addEventListener('mousedown', e => e.preventDefault());
  $('qResults').addEventListener('click', e => { const b = e.target.closest('.sres'); if (b && qItems[+b.dataset.qi]) { App.go(qItems[+b.dataset.qi].go); $('qResults').hidden = true; $('q').blur(); } });
  $('q').addEventListener('blur', () => setTimeout(() => { $('qResults').hidden = true; }, 150));

  // ---------------------------------------------------------------- start
  async function detectMode() {
    // a claude.ai page keeps the draft in its shared store; anywhere else, look for tools/serve.py
    if (window.claude && window.claude.use) {
      try { db = await window.claude.use('db'); } catch (e) { db = null; }
      S.mode = db ? 'hosted' : 'offline';
      return;
    }
    try {
      const info = await api('GET', 'info');
      if (info && info.editor) { S.mode = 'local'; S.node = !!info.node; return; }
    } catch (e) { /* not the local server */ }
    S.mode = 'offline';
  }
  const boot = (pct, text) => { const b = $('bootBar'); if (b) b.style.width = pct + '%'; const t = $('bootText'); if (t && text) t.textContent = text; };
  async function start() {
    boot(8, 'Finding out where changes go…');
    await detectMode();
    let data = window.EP_DATA;
    if (S.mode === 'local') {
      try { data = await api('GET', 'data'); } catch (e) { App.toast('Couldn\'t read data/ from the server; using js/data.js.', 'bad'); }
    }
    if (!data) { $('view').innerHTML = '<div class="page"><div class="note bad">The content (js/data.js) didn\'t load.</div></div>'; return; }
    S.base = clone(data); S.cur = clone(data); S.baseHash = SC.hashData(S.base);
    SP.setEssence(window.ESSENCE.make(S.cur));
    boot(20, 'Baking every merge…');
    let res;
    try { res = await App.bake(S.base, (d, t) => boot(20 + d / t * 70, `Baking every merge… ${fmt(d)}/${fmt(t)}`)); }
    catch (e) { $('view').innerHTML = `<div class="page"><div class="note bad">The content couldn't be baked: ${esc(e.message)}</div></div>`; return; }
    S.fields = res.fields; S.keys = res.keys; baseKeys = res.keys; S.baseRows = res.rows; S.curRows = res.rows;
    boot(95, 'Opening…');
    // bring back the draft
    let restored = null;
    if (S.mode === 'hosted') {
      try {
        const snap = await db.collection('draft').get();
        const ops = snap.docs.map(d => d.data()).sort((a, b) => (a.seq || 0) - (b.seq || 0)).map(b => { const op = { op: b.op, path: b.path }; if ('value' in b) op.value = b.value; if ('before' in b) op.before = b.before; return op; });
        for (const d of snap.docs) synced.set(d.id, (() => { const b = d.data(); const op = { op: b.op, path: b.path }; if ('value' in b) op.value = b.value; if ('before' in b) op.before = b.before; return op; })());
        if (ops.length) restored = ops;
        const req = await db.collection('requests').get();
        S.requests = req.docs.map(d => Object.assign({ id: d.id }, d.data())).sort((a, b) => a.at - b.at);
        const ap = await db.doc('meta/applied').get();
        if (ap.exists) S.applied = ap.data();
      } catch (e) { App.toast('Couldn\'t read the saved draft: ' + (e.message || e.code), 'bad'); }
    } else {
      const d = store.get(DRAFT_KEY, null);
      if (d && d.ops && d.ops.length) restored = d.ops;
      S.requests = store.get(REQ_KEY, []);
    }
    if (restored) {
      const r = SC.applyOps(S.cur, restored);
      S.cur = r.data;
      if (r.conflicts.length) App.toast(`${plural(r.conflicts.length, 'saved edit')} no longer fit the content and were left out.`, 'bad');
      else App.toast(`Your draft is back: ${plural(r.applied.length, 'change')}.`);
    }
    S.version++;
    S.ops = SC.diff(S.base, S.cur);
    SP.setEssence(App.mods().E || window.ESSENCE);
    validate();
    if (S.ops.length) runBake(); else S.bake = { state: 'done' };
    const saved = store.get('ep-editor-route', '');
    if (!location.hash && saved) { try { history.replaceState(null, '', saved); } catch (e) { /* ignore */ } }
    App.renderChrome();
    onRoute();
  }
  App.start = start;
  window.addEventListener('DOMContentLoaded', () => setTimeout(start, 0));
})();
