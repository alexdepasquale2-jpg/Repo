/* Lattice — mobile control surface for world-model jobs.
 * The phone composes lattice.job/1 objects; weights run on a Jetson / RTX / datacenter worker.
 * Nothing here runs inference. The HF token is only ever sent as the X-HF-Token header on POST /jobs.
 */
(function () {
  'use strict';

  /* ================================================================
   * 0. Constants & helpers
   * ================================================================ */
  const SCHEMA = 'lattice.job/1';
  const MAX_INLINE = 24 * 1024 * 1024;
  const TERMINAL = ['done', 'failed', 'cancelled'];
  const KEYS = { settings: 'lattice.settings', jobs: 'lattice.jobs', license: 'lattice.license' };
  const LIC = { cosmos: 'OpenMDW-1.1', hy: 'Tencent-HY-World-2.0' };

  const COSMOS_MODELS = [
    { id: 'cosmos3-edge-4b', name: 'Edge 4B', sub: 'Jetson · RTX · datacenter', targets: ['jetson', 'rtx', 'datacenter'], hf: 'nvidia/Cosmos-3-Edge-4B' },
    { id: 'cosmos3-nano-16b', name: 'Nano 16B', sub: 'RTX · datacenter', targets: ['rtx', 'datacenter'], hf: 'nvidia/Cosmos-3-Nano-16B' },
    { id: 'cosmos3-super-64b', name: 'Super 64B', sub: 'datacenter only', targets: ['datacenter'], hf: 'nvidia/Cosmos-3-Super-64B' },
    { id: 'cosmos3-i2v', name: 'I2V', sub: 'image → video · RTX · datacenter', targets: ['rtx', 'datacenter'], hf: 'nvidia/Cosmos-3-I2V' },
    { id: 'cosmos3-droid-policy', name: 'DROID policies', sub: 'robot action · Jetson · RTX · datacenter', targets: ['jetson', 'rtx', 'datacenter'], hf: 'nvidia/Cosmos-3-DROID-Policy' }
  ];
  const HY_MODEL = { id: 'hy-world-2.0', name: 'HY-World 2.0', targets: ['rtx', 'datacenter'], hf: 'tencent/HY-World-2.0' };
  const TARGETS = [
    { id: 'jetson', name: 'Jetson', sub: 'edge · on-device' },
    { id: 'rtx', name: 'RTX', sub: 'workstation' },
    { id: 'datacenter', name: 'Datacenter', sub: 'H100 / B200' }
  ];
  const COSMOS_MODES = [
    { id: 'reason', name: 'Reason' }, { id: 'generate', name: 'Generate' },
    { id: 'action', name: 'Action' }, { id: 'edge', name: 'Edge' }
  ];
  const HY_MODES = [
    { id: 'pano', name: 'Pano' }, { id: 'worldmirror', name: 'WorldMirror' },
    { id: 'stereo', name: 'Stereo' }, { id: 'export', name: 'Export' }
  ];
  const EXPORT_TARGETS = [{ id: 'unity', name: 'Unity' }, { id: 'unreal', name: 'Unreal' }, { id: 'isaac', name: 'Isaac' }];
  const FORMATS = ['ply', 'spz', 'glb', 'usd'];
  // Mirror of exporters.SUPPORTED (worker.py EXPORT_SUPPORTED).
  const EXPORT_SUPPORTED = { unity: ['ply', 'spz', 'glb', 'usd'], unreal: ['ply', 'spz', 'glb', 'usd'], isaac: ['ply', 'glb', 'usd'] };
  // HY-World 2.0 license does not apply in the EU-27, UK and South Korea (mirrors worker.py HY_EXCLUDED).
  const EU27 = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV',
    'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'];
  const HY_EXCLUDED = EU27.concat(['GB', 'KR']);
  function normRegion(v) {
    let r = String(v || '').trim().toUpperCase();
    if (r === 'UK') r = 'GB';
    if (r === 'EL') r = 'GR';
    return /^[A-Z]{2}$/.test(r) ? r : '';
  }
  function formatReason(target, fmt) {
    const sup = EXPORT_SUPPORTED[target];
    return sup && !sup.includes(fmt) ? fmt + ' not supported for ' + target : null;
  }
  const HY_STAGES = ['pano', 'WorldNav', 'WorldStereo', '3DGS / mesh'];
  const LICENSE_TERMS = {
    [LIC.cosmos]: [
      'OpenMDW 1.1: commercial use OK',
      'Notices / attribution required',
      'No competing public model API',
      'Generated outputs are yours'
    ],
    [LIC.hy]: [
      'Tencent HY-World 2.0 Community License (License.txt) applies unchanged',
      'Lattice does not relicense HY-World',
      'Territory / usage restrictions in License.txt apply'
    ]
  };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    const u = ['KB', 'MB', 'GB']; let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
  }
  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso); if (isNaN(d)) return '';
    const s = (Date.now() - d.getTime()) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return d.toLocaleDateString();
  }
  function pad(n, w) { return String(n).padStart(w || 2, '0'); }
  function newJobId() {
    const d = new Date();
    const ts = d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds());
    const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const rnd = new Uint8Array(6); (window.crypto || {}).getRandomValues ? crypto.getRandomValues(rnd) : rnd.forEach((_, i) => { rnd[i] = Math.random() * 256; });
    return 'lj_' + ts + '_' + Array.from(rnd, b => abc[b % abc.length]).join('');
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  let toastTimer = 0;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  }
  async function copyText(text, label) {
    let ok = false;
    try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); ok = true; } } catch (e) { ok = false; }
    if (!ok) {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
    }
    toast(ok ? (label || 'Copied') + ' to clipboard' : 'Copy failed — select manually');
  }
  function download(name, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  /* ================================================================
   * 1. State & storage
   * ================================================================ */
  function load(key, fallback) {
    try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; } catch (e) { return fallback; }
  }
  function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { toast('Storage unavailable'); } }

  const DEFAULT_SETTINGS = { workerUrl: 'http://localhost:8787', workerToken: '', hfToken: '', territory: '', target: 'rtx', pollMs: 1500 };
  const state = {
    settings: Object.assign({}, DEFAULT_SETTINGS, load(KEYS.settings, {})),
    jobs: load(KEYS.jobs, []),
    license: Object.assign({ [LIC.cosmos]: null, [LIC.hy]: null }, load(KEYS.license, {})),
    health: null, healthErr: null,
    tab: 'home',
    sheetJob: null,
    pollers: {},
    roleSig: 'null'
  };
  if (!Array.isArray(state.jobs)) state.jobs = [];

  const forms = {
    cosmos: {
      mode: 'generate', model: 'cosmos3-edge-4b', target: state.settings.target, prompt: '', lang: 'python', media: [],
      params: { frames: 121, fps: 24, resolution: '1280x704', seed: 0, guidance: 7, steps: 35, action: '', horizon: 16, question: '', latency_ms: 100 }
    },
    hyworld: {
      mode: 'pano', model: HY_MODEL.id, target: state.settings.target === 'jetson' ? 'rtx' : state.settings.target, prompt: '', lang: 'python', media: [],
      params: { resolution: '2048x1024', seed: 0, export_target: 'unity', format: 'ply' }
    },
    bridge: {
      mode: 'bridge', cosmosModel: 'cosmos3-edge-4b', target: state.settings.target === 'jetson' ? 'rtx' : state.settings.target, prompt: '', lang: 'python', media: [],
      params: { frames: 121, keyframe_stride: 8, export_target: 'unity', format: 'ply' }
    }
  };

  function saveSettings() { save(KEYS.settings, state.settings); }
  function saveJobs() { state.jobs = state.jobs.slice(0, 200); save(KEYS.jobs, state.jobs); }
  function saveLicense() { save(KEYS.license, state.license); }
  function baseUrl() { return String(state.settings.workerUrl || '').trim().replace(/\/+$/, ''); }

  /* ================================================================
   * 2. API
   * ================================================================ */
  function authHeaders(extra) {
    const h = Object.assign({}, extra || {});
    if (state.settings.workerToken) h['Authorization'] = 'Bearer ' + state.settings.workerToken;
    return h;
  }
  async function api(path, opts) {
    opts = opts || {};
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeout || 8000);
    let res;
    try {
      res = await fetch(baseUrl() + path, { method: opts.method || 'GET', headers: opts.headers || authHeaders(), body: opts.body, signal: ctrl.signal, cache: 'no-store' });
    } catch (e) {
      const err = new Error(e.name === 'AbortError' ? 'Worker timed out' : 'Worker unreachable'); err.offline = true; throw err;
    } finally { clearTimeout(timer); }
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      const err = new Error((data && data.error) || ('HTTP ' + res.status)); err.status = res.status; throw err;
    }
    return data;
  }
  const API = {
    // Health carries the worker token (when set) so a multi-user worker can say who we are.
    health: () => api('/health', { headers: authHeaders(), timeout: 5000 }),
    audit: (n) => api('/audit?limit=' + (n || 200)),
    report: (since) => api('/report' + (since ? '?since=' + encodeURIComponent(since) : '')),
    list: (n) => api('/jobs?limit=' + (n || 8)),
    get: (id) => api('/jobs/' + encodeURIComponent(id)),
    cancel: (id) => api('/jobs/' + encodeURIComponent(id) + '/cancel', { method: 'POST' }),
    submit: (job) => {
      const h = authHeaders({ 'Content-Type': 'application/json' });
      if (state.settings.hfToken) h['X-HF-Token'] = state.settings.hfToken;
      return api('/jobs', { method: 'POST', headers: h, body: JSON.stringify(job), timeout: 120000 });
    }
  };

  async function refreshHealth() {
    try { state.health = await API.health(); state.healthErr = null; }
    catch (e) { state.health = null; state.healthErr = e.message; }
    const sig = String(territoryReason('hyworld'));
    const rsig = String(roleReason());
    const redo = [];
    if (sig !== state.terrSig) { state.terrSig = sig; redo.push('hyworld', 'bridge'); }
    if (rsig !== state.roleSig) { state.roleSig = rsig; redo.push('cosmos', 'hyworld', 'bridge'); }
    Array.from(new Set(redo)).forEach(e => { if ($('#panel-' + e + ' form')) renderForm(e); });
    renderHeaderHealth();
    if (state.tab === 'home') renderHealthCard();
    if (state.tab === 'more') renderAdmin();
    if (state.sheetJob) renderJobDetail(state.sheetJob, true);
    return state.health;
  }

  /* Multi-user workers (LATTICE_USERS): /health says who we are ("you": {name, role}). */
  function you() { return state.health && state.health.auth_mode === 'users' ? state.health.you || null : null; }
  /* null if this client may submit jobs, otherwise the reason (viewer role / not signed in). */
  function roleReason() {
    const h = state.health;
    if (!h || h.auth_mode !== 'users') return null;
    if (!h.you) return 'Not signed in: this worker uses per-user tokens. Set your worker token in More → Settings';
    if (h.you.role === 'viewer') return 'Your role is viewer (read-only). Ask a workspace admin for operator access to submit jobs';
    return null;
  }
  function cancelReason(j) {
    const h = state.health;
    if (!h || h.auth_mode !== 'users' || !j) return null;
    if (!h.you) return 'Not signed in';
    if (h.you.role === 'viewer') return 'Viewers cannot cancel jobs';
    if (h.you.role === 'operator' && j.submitted_by !== h.you.name) return 'Operators can only cancel their own jobs';
    return null;
  }
  /* Audit & costs is for admins; a single-token or open worker grants its caller full access. */
  function isAdmin() {
    const h = state.health;
    if (!h || !h.auth_mode) return false;
    if (h.auth_mode === 'users') return !!(h.you && h.you.role === 'admin');
    return h.auth_mode === 'open' || !!state.settings.workerToken;
  }

  /* ================================================================
   * 3. Job builder
   * ================================================================ */
  function cosmosModel(id) { return COSMOS_MODELS.find(m => m.id === id) || COSMOS_MODELS[0]; }

  /* Honest feasibility: returns null if feasible, otherwise a reason string. */
  function feasibility(engine, f, target) {
    const t = target || f.target;
    const tName = (TARGETS.find(x => x.id === t) || {}).name || t;
    if (engine === 'cosmos' || engine === 'bridge') {
      const m = cosmosModel(engine === 'bridge' ? f.cosmosModel : f.model);
      if (!m.targets.includes(t)) {
        if (m.id === 'cosmos3-super-64b') return 'Super 64B needs datacenter — not on-device';
        return m.name + ' needs ' + m.targets.map(x => (TARGETS.find(y => y.id === x) || {}).name).join(' or ') + ' — not ' + tName;
      }
    }
    if ((engine === 'hyworld' || engine === 'bridge') && !HY_MODEL.targets.includes(t)) {
      return 'HY-World 2.0 needs RTX or datacenter — not ' + tName;
    }
    return null;
  }
  function modeModelReason(f, modelId) {
    if (modelId === 'cosmos3-droid-policy' && f.mode !== 'action') return 'DROID policies run in Action mode';
    if (modelId === 'cosmos3-i2v' && f.mode !== 'generate') return 'I2V is a Generate model';
    return null;
  }

  /* HY-World territory gate: null if OK, otherwise the license reason. */
  function territoryReason(engine) {
    if (engine !== 'hyworld' && engine !== 'bridge') return null;
    const where = [normRegion(state.health && state.health.region), normRegion(state.settings.territory)];
    const bad = where.find(r => r && HY_EXCLUDED.includes(r));
    if (!bad && state.health && state.health.hy_territory_ok === false) return 'HY-World 2.0 license does not apply where this worker runs';
    return bad ? 'HY-World 2.0 license does not apply in ' + bad + ' (EU-27, UK, South Korea excluded — License.txt)' : null;
  }
  function licenseFor(engine) {
    if (engine === 'cosmos') return [LIC.cosmos];
    if (engine === 'hyworld') return [LIC.hy];
    return [LIC.cosmos, LIC.hy];
  }
  function licensesAccepted(engine) { return licenseFor(engine).every(k => !!state.license[k]); }

  function paramsFor(engine, f) {
    const p = f.params; const num = (v) => (v === '' || v == null || isNaN(Number(v))) ? null : Number(v);
    if (engine === 'cosmos') {
      if (f.mode === 'generate') return { frames: num(p.frames), fps: num(p.fps), resolution: p.resolution, seed: num(p.seed), guidance: num(p.guidance), steps: num(p.steps) };
      if (f.mode === 'action') return { action: p.action, horizon: num(p.horizon) };
      if (f.mode === 'reason') return { question: p.question };
      return { latency_ms: num(p.latency_ms) };
    }
    if (engine === 'hyworld') {
      if (f.mode === 'export') return { export_target: p.export_target, format: p.format };
      if (f.mode === 'pano') return { resolution: p.resolution, seed: num(p.seed) };
      return { seed: num(p.seed), export_target: p.export_target, format: p.format };
    }
    return { frames: num(p.frames), keyframe_stride: num(p.keyframe_stride), export_target: p.export_target, format: p.format };
  }
  function outputFormats(engine, f) {
    if (engine === 'cosmos') return f.mode === 'reason' ? ['json'] : f.mode === 'action' ? ['json', 'mp4'] : ['mp4'];
    if (engine === 'hyworld') return f.mode === 'pano' ? ['png'] : [f.params.format];
    return ['mp4', f.params.format];
  }

  /* Build a lattice.job/1. mediaData: array of data URLs (or undefined) parallel to f.media. */
  function buildJob(engine, id, mediaData) {
    const f = forms[engine];
    const lic = licenseFor(engine);
    const acceptedAt = lic.map(k => state.license[k]).filter(Boolean).sort().pop() || null;
    const terms = lic.reduce((a, k) => a.concat(LICENSE_TERMS[k]), []);
    const job = {
      schema: SCHEMA,
      id: id,
      created: new Date().toISOString(),
      engine: engine,
      mode: engine === 'bridge' ? 'bridge' : f.mode,
      model: engine === 'cosmos' ? f.model : engine === 'hyworld' ? HY_MODEL.id : f.cosmosModel + '+' + HY_MODEL.id,
      target: f.target,
      inputs: {
        prompt: f.prompt,
        media: f.media.map((m, i) => {
          const o = { name: m.file.name, type: m.file.type || 'application/octet-stream', size: m.file.size, kind: m.kind };
          if (mediaData && mediaData[i]) o.data = mediaData[i];
          return o;
        }),
        params: paramsFor(engine, f)
      },
      outputs: { dir: './runs/' + id + '/', formats: outputFormats(engine, f) },
      license: { id: lic.join('+'), accepted: true, acceptedAt: acceptedAt, notices_required: true, terms: terms }
    };
    const terr = normRegion(state.settings.territory);
    if (terr) job.license.territory = terr;
    job.code = genCode(engine, job);
    return job;
  }
  function stripMedia(job) {
    const j = clone(Object.assign({}, job, { inputs: Object.assign({}, job.inputs, { media: (job.inputs.media || []).map(m => { const o = Object.assign({}, m); delete o.data; return o; }) }) }));
    return j;
  }
  function readDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result); r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
  }

  /* ================================================================
   * 4. Code generation (never embeds the HF token)
   * ================================================================ */
  function shq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
  // Mirrors worker.py commands(): same modules, model ids and per-engine param whitelist.
  const ENGINE_PARAMS = {
    cosmos: ['frames', 'fps', 'resolution', 'seed', 'guidance', 'steps'],
    hyworld: ['resolution', 'seed', 'export_target', 'format'],
    bridgeCosmos: ['frames', 'fps', 'resolution', 'seed', 'guidance', 'steps'],
    bridgeHy: ['seed', 'export_target', 'format']
  };
  function engineCommand(engine, job) {
    const p = job.inputs.params; const out = job.outputs.dir;
    const flags = (keys) => keys.filter(k => p[k] !== null && p[k] !== '' && p[k] !== undefined).map(k => '--' + k.replace(/_/g, '-') + ' ' + shq(p[k])).join(' ');
    const media = job.inputs.media.map(m => '--input ' + shq(out + 'inputs/' + m.name)).join(' ');
    const cmd = (head, keys, outSuffix, noMedia) => [head + ' \\',
      '    --prompt ' + shq(job.inputs.prompt || '') + ' --out ' + out + (outSuffix || '') + ' \\',
      (media && !noMedia ? '    ' + media + ' \\' : null),
      (flags(keys) ? '    ' + flags(keys) : null)].filter(Boolean).join('\n').replace(/ \\$/, '');
    if (engine === 'cosmos') return cmd('python -m cosmos3.cli ' + job.mode + ' --model ' + job.model, ENGINE_PARAMS.cosmos);
    if (engine === 'hyworld') return cmd('python -m hyworld.cli ' + job.mode + ' --model ' + job.model, ENGINE_PARAMS.hyworld);
    const cm = job.model.split('+')[0];
    return [
      '# 1) Cosmos rollout',
      cmd('python -m cosmos3.cli generate --model ' + cm, ENGINE_PARAMS.bridgeCosmos, 'rollout/'),
      '# 2) keyframes every ' + (p.keyframe_stride || 8) + ' frames',
      'ffmpeg -y -i ' + out + 'rollout/<rollout>.mp4 -vf ' + shq('select=not(mod(n\\,' + (p.keyframe_stride || 8) + '))') + ' -vsync vfr ' + out + 'keyframes/kf_%04d.png',
      '# 3) HY freeze: pano -> WorldNav -> WorldStereo -> 3DGS/mesh',
      cmd('python -m hyworld.cli worldmirror --model hy-world-2.0 --input-dir ' + out + 'keyframes', ENGINE_PARAMS.bridgeHy, '', true)
    ].join('\n');
  }
  function jobForCode(job) { const j = stripMedia(job); delete j.code; return j; }
  function genCode(engine, job) {
    const j = jobForCode(job);
    const hasMedia = j.inputs.media.length > 0;
    const json = JSON.stringify(j, null, 2);
    const url = baseUrl() || 'http://localhost:8787';
    const python = [
      'import os, json, time, requests',
      '',
      'WORKER = os.environ.get("LATTICE_WORKER", ' + JSON.stringify(url) + ')',
      'HEADERS = {"X-HF-Token": os.environ["HF_TOKEN"]}',
      'if os.environ.get("LATTICE_TOKEN"):',
      '    HEADERS["Authorization"] = "Bearer " + os.environ["LATTICE_TOKEN"]',
      '',
      'job = json.loads(r"""' + json + '""")',
      hasMedia ? '# media listed as metadata; attach "data" (data: URL, <= 24 MB) per item to upload' : null,
      '',
      'r = requests.post(f"{WORKER}/jobs", json=job, headers=HEADERS, timeout=120)',
      'r.raise_for_status()',
      'job_id = r.json()["id"]',
      'while True:',
      '    s = requests.get(f"{WORKER}/jobs/{job_id}", headers=HEADERS, timeout=10).json()',
      '    print(s["status"], round(s["progress"] * 100), s["stage"])',
      '    if s["status"] in ("done", "failed", "cancelled"):',
      '        break',
      '    time.sleep(' + (Math.max(500, Number(state.settings.pollMs) || 1500) / 1000) + ')',
      'for a in s.get("artifacts", []):',
      '    print(a["kind"], WORKER + a["url"])'
    ].filter(l => l !== null).join('\n');
    const cli = [
      'export LATTICE_WORKER=' + shq(url),
      '# export HF_TOKEN=...   (set in your shell; never commit it)',
      "cat > job.json <<'EOF'",
      json,
      'EOF',
      '',
      'curl -X POST $LATTICE_WORKER/jobs -H "Content-Type: application/json" \\',
      '  -H "X-HF-Token: $HF_TOKEN"' + (state.settings.workerToken ? ' -H "Authorization: Bearer $LATTICE_TOKEN"' : '') + ' -d @job.json',
      '',
      '# poll',
      'curl $LATTICE_WORKER/jobs/' + j.id + (state.settings.workerToken ? ' -H "Authorization: Bearer $LATTICE_TOKEN"' : ''),
      '',
      '# on the worker (' + j.target + ') this maps to:',
      engineCommand(engine, j)
    ].join('\n');
    return { python: python, cli: cli };
  }

  /* ================================================================
   * 5. UI shell: tabs, sheet
   * ================================================================ */
  const TABS = ['home', 'cosmos', 'hyworld', 'bridge', 'more'];
  function selectTab(tab, focus) {
    if (!TABS.includes(tab)) tab = 'home';
    state.tab = tab;
    TABS.forEach(t => {
      const b = $('#tab-' + t); const on = t === tab;
      b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1;
      $('#panel-' + t).hidden = !on;
    });
    if (focus) $('#tab-' + tab).focus();
    if (tab === 'home') renderHome();
    if (tab === 'more') renderMore();
    if (location.hash !== '#' + tab) history.replaceState(null, '', '#' + tab);
    window.scrollTo(0, 0);
  }
  function bindTabs() {
    $$('.tabbar [role=tab]').forEach(b => {
      b.addEventListener('click', () => selectTab(b.dataset.tab));
      b.addEventListener('keydown', (e) => {
        const i = TABS.indexOf(b.dataset.tab);
        let n = null;
        if (e.key === 'ArrowRight') n = TABS[(i + 1) % TABS.length];
        if (e.key === 'ArrowLeft') n = TABS[(i + TABS.length - 1) % TABS.length];
        if (e.key === 'Home') n = TABS[0];
        if (e.key === 'End') n = TABS[TABS.length - 1];
        if (n) { e.preventDefault(); selectTab(n, true); }
      });
    });
    $('#hdrHealth').addEventListener('click', () => { selectTab('home'); refreshHealth(); });
  }

  let sheetReturnFocus = null;
  function openSheet(title, html, onMount) {
    sheetReturnFocus = document.activeElement;
    $('#sheetTitle').textContent = title;
    $('#sheetBody').innerHTML = html;
    $('#sheet').hidden = false; $('#sheetBackdrop').hidden = false;
    document.body.style.overflow = 'hidden';
    if (onMount) onMount($('#sheetBody'));
    $('#sheetClose').focus();
  }
  function closeSheet() {
    $('#sheet').hidden = true; $('#sheetBackdrop').hidden = true;
    document.body.style.overflow = '';
    $('#sheetBody').querySelectorAll('video').forEach(v => { try { v.pause(); } catch (e) { /* ignore */ } });
    $('#sheetBody').innerHTML = '';
    state.sheetJob = null;
    if (sheetReturnFocus && sheetReturnFocus.focus) sheetReturnFocus.focus();
  }
  function bindSheet() {
    $('#sheetClose').addEventListener('click', closeSheet);
    $('#sheetBackdrop').addEventListener('click', closeSheet);
    document.addEventListener('keydown', (e) => {
      if ($('#sheet').hidden) return;
      if (e.key === 'Escape') { closeSheet(); return; }
      if (e.key === 'Tab') {
        const f = $$('button, a[href], input, select, textarea, video[controls], [tabindex]:not([tabindex="-1"])', $('#sheet')).filter(x => !x.disabled && x.offsetParent !== null);
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });
  }

  function renderHeaderHealth() {
    const b = $('#hdrHealth'); const dot = $('.dot', b); const lbl = $('.hdr-label', b);
    dot.className = 'dot';
    if (state.health) {
      dot.classList.add(state.health.dry_run ? 'dry' : 'on');
      lbl.textContent = state.health.dry_run ? 'dry-run' : 'online';
      b.setAttribute('aria-label', 'Worker ' + (state.health.dry_run ? 'online, dry run' : 'online, executing') + '. Go to Home.');
    } else if (state.healthErr) {
      dot.classList.add('off'); lbl.textContent = 'offline';
      b.setAttribute('aria-label', 'Worker offline. Go to Home.');
    } else { lbl.textContent = 'worker'; }
  }

  /* ================================================================
   * 6. Home
   * ================================================================ */
  function renderHome() {
    const p = $('#panel-home');
    p.innerHTML = `
      <header>
        <h1 class="sr-only">Home</h1>
        <p class="lede">Control surface. The phone composes jobs; Cosmos 3 and HY-World 2.0 run on your worker.</p>
      </header>
      <div class="card" id="healthCard" aria-live="polite"></div>
      <div class="card">
        <div class="card-head"><h3>Recent jobs</h3><button class="btn small ghost" id="homeRefresh" type="button">Refresh</button></div>
        <ul class="jobs" id="homeJobs"></ul>
      </div>`;
    $('#homeRefresh').addEventListener('click', () => { refreshHealth(); syncRemoteJobs(); });
    renderHealthCard(); renderJobList($('#homeJobs'), state.jobs.slice(0, 8));
  }
  function renderHealthCard() {
    const c = $('#healthCard'); if (!c) return;
    const h = state.health;
    if (!h) {
      c.innerHTML = `
        <div class="card-head"><h3>Worker</h3><span class="pill failed">${state.healthErr ? 'offline' : 'checking'}</span></div>
        <p class="note mono">${esc(baseUrl() || '(no worker URL)')}</p>
        ${mixedContent() ? '<p class="note err-text">' + esc(MIXED_MSG) + '</p>' : ''}
        <p class="note">${state.healthErr ? esc(state.healthErr) + '. Start <code>worker.py</code> on your Jetson / RTX box, then set its URL in More → Settings.' : 'Contacting worker…'}</p>
        <div class="row"><button class="btn small" type="button" data-act="retry">Retry</button><button class="btn small ghost" type="button" data-act="settings">Settings</button></div>`;
    } else {
      const eng = h.engines || {};
      const e = (k) => eng[k] ? (eng[k].installed ? 'installed' : 'not installed (dry run)') : 'unknown';
      c.innerHTML = `
        <div class="card-head"><h3>Worker</h3><span class="pill ${h.dry_run ? 'dry' : 'done'}">${h.dry_run ? 'online · dry-run' : 'online · exec'}</span></div>
        <dl class="kv">
          <dt>url</dt><dd class="mono">${esc(baseUrl())}</dd>
          <dt>version</dt><dd>${esc(h.service)} ${esc(h.version)}</dd>
          <dt>cosmos</dt><dd>${esc(e('cosmos'))}</dd>
          <dt>hy-world</dt><dd>${esc(e('hyworld'))}</dd>
          <dt>gpu</dt><dd>${h.gpu ? esc(h.gpu.name) + ' · ' + esc(fmtBytes((h.gpu.memory_mb || 0) * 1048576)) : 'none detected'}</dd>
          <dt>queue</dt><dd>${esc(h.queue)}</dd>
          <dt>region</dt><dd>${h.region ? esc(h.region) : 'unset'}</dd>
          <dt>hy-world</dt><dd data-testid="health-hy-territory">${h.hy_territory_ok === false ? '<span class="err-text">license does not apply here</span>' : 'territory ok'}</dd>
          <dt>auth</dt><dd>${h.auth_mode === 'users' ? 'per-user tokens' : h.auth ? 'token required' + (state.settings.workerToken ? ' · set' : ' · <span class="warn-text">not set</span>') : 'open'}</dd>
          ${h.auth_mode === 'users' ? '<dt>you</dt><dd class="whoami" data-testid="whoami">' + (h.you
            ? 'Signed in as <b>' + esc(h.you.name) + '</b> (' + esc(h.you.role) + ')'
            : '<span class="warn-text">Not signed in — set your worker token in More → Settings</span>') + '</dd>' : ''}
        </dl>
        ${h.dry_run ? '<p class="note warn-text">Dry run: stages are walked and planned commands logged; no weights are loaded.</p>' : ''}`;
    }
    const r = $('[data-act=retry]', c); if (r) r.addEventListener('click', refreshHealth);
    const s = $('[data-act=settings]', c); if (s) s.addEventListener('click', () => { selectTab('more'); const d = $('#moreSettings'); if (d) { d.open = true; d.scrollIntoView(); } });
  }

  function engClass(engine) { return 'eng-' + (['cosmos', 'hyworld', 'bridge'].includes(engine) ? engine : 'cosmos'); }
  function jobTitle(j) {
    const prompt = j.inputs && j.inputs.prompt;
    return prompt ? prompt : (j.engine || '?') + ' · ' + (j.mode || '?');
  }
  function renderJobList(ul, jobs) {
    if (!ul) return;
    if (!jobs.length) { ul.innerHTML = '<li class="empty">No jobs yet. Compose one in Cosmos, HY-World or Bridge.</li>'; return; }
    ul.innerHTML = jobs.map(j => {
      const st = j.draft ? 'draft' : (j.status || 'queued');
      const pct = Math.round((Number(j.progress) || 0) * 100);
      return `<li><button type="button" class="job ${engClass(j.engine)}" data-id="${esc(j.id)}" aria-label="${esc(j.engine + ' ' + j.mode + ' job, ' + st + ', ' + pct + ' percent')}">
        <span class="job-top"><span class="j-title">${esc(jobTitle(j))}</span><span class="pill ${esc(st)}">${esc(st)}</span></span>
        <span class="bar" aria-hidden="true"><i style="width:${pct}%"></i></span>
        <span class="job-sub"><span>${esc(j.engine)} · ${esc(j.mode)} · ${esc(j.model)}</span><span>${esc(fmtTime(j.created))}</span></span>
      </button></li>`;
    }).join('');
    $$('button.job', ul).forEach(b => b.addEventListener('click', () => openJob(b.dataset.id)));
  }

  /* ================================================================
   * 7. Jobs: store, poll, detail
   * ================================================================ */
  function findJob(id) { return state.jobs.find(j => j.id === id); }
  function upsertJob(rec) {
    const i = state.jobs.findIndex(j => j.id === rec.id);
    if (i >= 0) state.jobs[i] = Object.assign({}, state.jobs[i], rec);
    else state.jobs.unshift(rec);
    state.jobs.sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')));
    saveJobs();
  }
  function mergeStatus(s) {
    if (!s || !s.id) return;
    const rec = {};
    ['id', 'status', 'progress', 'stage', 'engine', 'mode', 'model', 'created', 'updated', 'dry_run', 'error', 'log', 'artifacts', 'metrics', 'submitted_by'].forEach(k => { if (k in s) rec[k] = s[k]; });
    rec.draft = false;
    upsertJob(rec);
    onJobsChanged(s.id);
  }
  function onJobsChanged(id) {
    if (state.tab === 'home') renderJobList($('#homeJobs'), state.jobs.slice(0, 8));
    if (state.tab === 'more') renderJobList($('#moreJobs'), state.jobs);
    if (state.sheetJob && state.sheetJob === id) renderJobDetail(id, true);
  }

  function startPolling(id) {
    if (state.pollers[id]) return;
    let fails = 0;
    const tick = async () => {
      try {
        const s = await API.get(id); fails = 0; mergeStatus(s);
        if (TERMINAL.includes(s.status)) { delete state.pollers[id]; if (s.status === 'done') toast('Job done: ' + id); return; }
      } catch (e) {
        if (e.status === 404) { delete state.pollers[id]; return; }
        fails++;
      }
      const ms = Math.max(500, Number(state.settings.pollMs) || 1500) * Math.min(8, 1 + fails);
      state.pollers[id] = setTimeout(tick, ms);
    };
    state.pollers[id] = setTimeout(tick, 50);
  }
  function resumePolling() {
    state.jobs.filter(j => !j.draft && !TERMINAL.includes(j.status)).forEach(j => startPolling(j.id));
  }
  async function syncRemoteJobs() {
    try {
      const r = await API.list(8);
      (r.jobs || []).forEach(s => { if (!findJob(s.id) || !TERMINAL.includes(findJob(s.id).status)) mergeStatus(s); });
      resumePolling();
    } catch (e) { /* offline is shown by health card */ }
  }

  function openJob(id) {
    state.sheetJob = id;
    openSheet('Job', '<div id="jobDetail"></div>');
    renderJobDetail(id, false);
    const j = findJob(id);
    if (j && !j.draft) API.get(id).then(mergeStatus).catch(() => { /* keep local copy */ });
  }
  function artifactUrl(a) { return /^https?:/i.test(a.url) ? a.url : baseUrl() + a.url; }
  /* Display-only URL: adds ?token= for GET /runs when a worker token is set. Never exported or put in code. */
  function artifactViewUrl(a) {
    const u = artifactUrl(a); const t = state.settings.workerToken;
    return t ? u + (u.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(t) : u;
  }
  function mixedContent() { return location.protocol === 'https:' && /^http:/i.test(baseUrl()); }
  const MIXED_MSG = 'This page is HTTPS but the worker URL is http:// — browsers block mixed content. Serve the worker over HTTPS or through a tunnel (e.g. cloudflared, tailscale serve).';
  function renderJobDetail(id, update) {
    const box = $('#jobDetail'); const j = findJob(id);
    if (!box) return;
    if (!j) { box.innerHTML = '<p class="empty">Job not found.</p>'; return; }
    const st = j.draft ? 'draft' : (j.status || 'queued');
    const pct = Math.round((Number(j.progress) || 0) * 100);
    const log = Array.isArray(j.log) ? j.log.slice(-50).join('\n') : '';
    const head = `
      <div class="${engClass(j.engine)}" style="display:flex;flex-direction:column;gap:10px">
        <div class="card-head"><span class="eng-tag">${esc(j.engine)} · ${esc(j.mode)}</span><span class="pill ${esc(st)}">${esc(st)}</span></div>
        <div class="bar" role="progressbar" aria-label="Progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div>
        <dl class="kv">
          <dt>id</dt><dd class="mono">${esc(j.id)}</dd>
          <dt>stage</dt><dd>${esc(j.stage || '—')} (${pct}%)</dd>
          <dt>model</dt><dd>${esc(j.model)}</dd>
          <dt>target</dt><dd>${esc(j.target || '—')}</dd>
          ${j.submitted_by ? '<dt>by</dt><dd>' + esc(j.submitted_by) + '</dd>' : ''}
          <dt>created</dt><dd>${esc(j.created ? new Date(j.created).toLocaleString() : '—')}</dd>
          ${j.dry_run ? '<dt>mode</dt><dd class="warn-text">dry run</dd>' : ''}
          ${j.error ? '<dt>error</dt><dd class="err-text">' + esc(j.error) + '</dd>' : ''}
        </dl>
      </div>`;
    const logHtml = `<div class="field"><span class="label">log tail</span><pre class="code plain" id="jobLog" tabindex="0" aria-label="Job log">${esc(log || (j.draft ? 'Draft — not yet sent to a worker.' : '(no log yet)'))}</pre></div>`;
    if (update && $('#jobHead', box)) {
      $('#jobHead', box).innerHTML = head;
      $('#jobLogWrap', box).innerHTML = logHtml;
      const known = $('#jobArts', box).dataset.sig; const sig = JSON.stringify((j.artifacts || []).map(a => a.url));
      if (known !== sig) renderArtifacts($('#jobArts', box), j);
      $('#jobMetrics', box).innerHTML = metricsHtml(j);
      const cb = $('#jobCancel', box); const cr = cancelReason(j);
      cb.disabled = j.draft || TERMINAL.includes(j.status) || !!cr; cb.title = cr || '';
      const lg = $('#jobLog', box); lg.scrollTop = lg.scrollHeight;
      return;
    }
    box.innerHTML = `
      <div id="jobHead">${head}</div>
      <div class="row">
        <button class="btn danger grow" type="button" id="jobCancel" data-testid="job-cancel" title="${esc(cancelReason(j) || '')}" ${j.draft || TERMINAL.includes(j.status) || cancelReason(j) ? 'disabled' : ''}>Cancel job</button>
        <button class="btn grow" type="button" id="jobCopy">Copy job JSON</button>
        ${j.draft ? '<button class="btn primary grow eng-cosmos" type="button" id="jobResend" data-testid="draft-send">Send to worker</button><button class="btn grow" type="button" id="jobDl">Download job.json</button>' : ''}
      </div>
      <div id="jobMetrics">${metricsHtml(j)}</div>
      <div id="jobArts"></div>
      <div id="jobLogWrap">${logHtml}</div>`;
    renderArtifacts($('#jobArts', box), j);
    const lg = $('#jobLog', box); lg.scrollTop = lg.scrollHeight;
    $('#jobCancel', box).addEventListener('click', async () => {
      try { mergeStatus(await API.cancel(j.id)); toast('Cancel requested'); } catch (e) { toast('Cancel failed: ' + e.message); }
    });
    $('#jobCopy', box).addEventListener('click', () => copyText(JSON.stringify(recordForExport(findJob(id)), null, 2), 'Job JSON'));
    const rs = $('#jobResend', box);
    if (rs) rs.addEventListener('click', () => resendDraft(id));
    const dl = $('#jobDl', box);
    if (dl) dl.addEventListener('click', () => download('job.json', jobFromRecord(findJob(id))));
  }
  function fmtDur(s) {
    s = Number(s); if (!isFinite(s)) return '—';
    if (s < 60) return s.toFixed(s < 10 ? 1 : 0) + ' s';
    const m = Math.floor(s / 60); return m < 60 ? m + 'm ' + Math.round(s % 60) + 's' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }
  function metricsHtml(j) {
    const m = j.metrics;
    if (!m || typeof m !== 'object') return '';
    const stages = Array.isArray(m.stages) ? m.stages : [];
    let cost;
    if (j.dry_run) cost = 'not billed (dry run)';
    else if (m.cost_usd != null && isFinite(Number(m.cost_usd))) cost = '$' + Number(m.cost_usd).toFixed(Number(m.cost_usd) < 1 ? 4 : 2) + (m.gpu_usd_hr != null ? ' @ $' + esc(m.gpu_usd_hr) + '/GPU-h' : '');
    else cost = 'no rate set (LATTICE_GPU_USD_HR)';
    const gh = Number(m.gpu_hours);
    return `<div class="field" data-testid="job-metrics"><span class="label">metrics</span>
      <dl class="kv">
        <dt>wall time</dt><dd>${esc(fmtDur(m.wall_s))}</dd>
        <dt>gpu-hours</dt><dd>${isFinite(gh) ? esc(gh === 0 ? '0' : gh.toFixed(gh < 0.01 ? 5 : 3)) : '—'}</dd>
        <dt>cost</dt><dd>${esc(cost)}</dd>
      </dl>
      ${stages.length ? `<div class="tbl-wrap"><table class="stages"><thead><tr><th scope="col">stage</th><th scope="col">wall</th><th scope="col">gpu</th><th scope="col">vram</th><th scope="col">exit</th></tr></thead><tbody>${stages.map(st => `<tr>
        <td>${esc(st.stage)}</td><td>${esc(st.wall_s == null ? '—' : fmtDur(st.wall_s))}</td>
        <td>${esc(st.gpu_name ? st.gpu_name + (st.gpu_count > 1 ? ' ×' + st.gpu_count : '') : '—')}</td>
        <td>${esc(st.peak_vram_mb == null ? '—' : fmtBytes(st.peak_vram_mb * 1048576))}</td>
        <td class="${st.exit_code ? 'err-text' : ''}">${esc(st.exit_code == null ? '—' : st.exit_code)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    </div>`;
  }
  function renderArtifacts(el, j) {
    const arts = Array.isArray(j.artifacts) ? j.artifacts : [];
    el.dataset.sig = JSON.stringify(arts.map(a => a.url));
    if (!arts.length) { el.innerHTML = '<div class="field"><span class="label">artifacts</span><p class="empty">No artifacts yet.</p></div>'; return; }
    el.innerHTML = '<div class="field"><span class="label">artifacts</span></div>' + arts.map((a, i) => {
      const url = artifactViewUrl(a); const ext = String(a.name || '').split('.').pop().toLowerCase();
      let body = '';
      if (a.kind === 'bundle') {
        const tgt = String(a.name || '').replace(/-bundle\.zip$/i, '');
        return `<div class="artifact bundle" data-testid="bundle-card">
        <div class="card-head"><span class="a-name">${esc(a.name)}</span><span class="pill">bundle · ${esc(fmtBytes(a.bytes))}</span></div>
        <p class="note">Engine-ready zip${EXPORT_SUPPORTED[tgt] ? ' for ' + esc(tgt) : ''}: scene file(s), import script / README with the manual steps, manifest.json, and the NOTICE / License text that must travel with HY-World outputs.${j.dry_run ? ' <span class="warn-text">Dry run: contains a placeholder scene, not a real one.</span>' : ''}</p>
        <div class="row"><a class="btn small primary" href="${esc(url)}" download="${esc(a.name)}" data-testid="bundle-download">Download bundle</a></div>
      </div>`;
      }
      if (a.kind === 'video') body = `<video controls playsinline preload="metadata" src="${esc(url)}"></video>`;
      else if (a.kind === 'image') body = `<img src="${esc(url)}" alt="${esc(a.name)}" loading="lazy">`;
      else if (a.kind === 'json' || a.kind === 'text') body = `<button class="btn small" type="button" data-fetch="${i}">Show contents</button><pre class="code plain" hidden></pre>`;
      const viewer = (ext === 'splat' || ext === 'ply') ? `<a class="btn small" href="https://antimatter15.com/splat/?url=${encodeURIComponent(url)}" target="_blank" rel="noopener">Open in viewer</a>` : '';
      return `<div class="artifact">
        <div class="card-head"><span class="a-name">${esc(a.name)}</span><span class="pill">${esc(a.kind)} · ${esc(fmtBytes(a.bytes))}</span></div>
        ${body}
        <div class="row"><a class="btn small" href="${esc(url)}" target="_blank" rel="noopener" download="${esc(a.name)}">Download / open</a>${viewer}</div>
      </div>`;
    }).join('');
    $$('[data-fetch]', el).forEach(b => b.addEventListener('click', async () => {
      const a = arts[Number(b.dataset.fetch)]; const pre = b.nextElementSibling;
      b.disabled = true;
      try {
        const r = await fetch(artifactUrl(a), { headers: authHeaders() });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        let t = await r.text();
        if (a.kind === 'json') { try { t = JSON.stringify(JSON.parse(t), null, 2); } catch (e) { /* show raw */ } }
        pre.textContent = t.length > 200000 ? t.slice(0, 200000) + '\n…(truncated)' : t;
        pre.hidden = false; b.hidden = true;
      } catch (e) { toast('Fetch failed: ' + e.message); b.disabled = false; }
    }));
  }
  function recordForExport(r) {
    const o = clone(r || {});
    if (o.inputs && Array.isArray(o.inputs.media)) o.inputs.media.forEach(m => { delete m.data; });
    delete o.hfToken; delete o.workerToken;
    return o;
  }
  function jobFromRecord(r) {
    const o = recordForExport(r);
    const job = {};
    ['schema', 'id', 'created', 'engine', 'mode', 'model', 'target', 'inputs', 'outputs', 'license', 'code'].forEach(k => { if (k in o) job[k] = o[k]; });
    return job;
  }
  async function resendDraft(id) {
    const r = findJob(id); if (!r) return;
    if (!licensesAccepted(r.engine)) { openLicenseSheet(r.engine); return; }
    const terr = territoryReason(r.engine);
    if (terr) { toast(terr); return; }
    const rr = roleReason();
    if (rr) { toast(rr); return; }
    try {
      const res = await API.submit(jobFromRecord(r));
      upsertJob({ id: r.id, status: res.status || 'queued', draft: false, progress: 0 });
      toast('Sent ' + (res.id || id)); startPolling(res.id || id); onJobsChanged(id);
    } catch (e) { toast(e.offline ? 'Worker still offline' : 'Rejected: ' + e.message); }
  }

  /* ================================================================
   * 8. Forms (Cosmos / HY-World / Bridge)
   * ================================================================ */
  function segHtml(name, items, cur, label, reasonFn) {
    return `<div class="seg" role="radiogroup" aria-label="${esc(label)}">${items.map(i => { const why = reasonFn ? reasonFn(i.id) : null; return `<button type="button" role="radio" aria-checked="${i.id === cur}" data-${name}="${esc(i.id)}"${why ? ' disabled aria-disabled="true" title="' + esc(why) + '"' : ''}>${esc(i.name)}</button>`; }).join('')}</div>`;
  }
  function formatSegHtml(p) {
    return `<div class="field"><span class="label">format</span>${segHtml('format', FORMATS.map(x => ({ id: x, name: x })), p.format, 'Format', (x) => formatReason(p.export_target, x))}
      ${EXPORT_SUPPORTED[p.export_target] && EXPORT_SUPPORTED[p.export_target].length < FORMATS.length ? '<p class="note">' + esc(p.export_target) + ' supports ' + esc(EXPORT_SUPPORTED[p.export_target].join(', ')) + '.</p>' : ''}</div>`;
  }
  function optHtml(attr, o, checked, reason) {
    return `<button type="button" class="opt" role="radio" aria-checked="${checked}" ${reason ? 'aria-disabled="true"' : ''} data-${attr}="${esc(o.id)}" title="${esc(reason || '')}">
      <span class="o-mark" aria-hidden="true"></span><span class="o-main"><span>${esc(o.name)}</span><span class="o-sub">${esc(reason || o.sub || '')}</span></span></button>`;
  }
  function targetsHtml(engine, f) {
    return `<div class="field"><span class="label" id="${engine}-tl">target</span>
      <div class="targets" role="radiogroup" aria-labelledby="${engine}-tl">${TARGETS.map(t => optHtml('target', t, t.id === f.target, feasibility(engine, f, t.id))).join('')}</div>
      <p class="feas ${feasibility(engine, f) ? 'bad' : ''}" role="status">${esc(feasibility(engine, f) || feasText(engine, f))}</p></div>`;
  }
  function feasText(engine, f) {
    const t = (TARGETS.find(x => x.id === f.target) || {}).name;
    const m = engine === 'cosmos' ? cosmosModel(f.model).name : engine === 'hyworld' ? 'HY-World 2.0' : cosmosModel(f.cosmosModel).name + ' + HY-World 2.0';
    return 'Feasible: ' + m + ' on ' + t + '. Weights load on the worker, not this phone.';
  }
  function num(name, label, v, attrs) { return `<div class="field"><label for="f-${name}">${esc(label)}</label><input type="number" id="f-${name}" data-param="${name}" value="${esc(v)}" inputmode="decimal" ${attrs || ''}></div>`; }
  function sel(name, label, v, opts, isParam) {
    return `<div class="field"><label for="f-${name}">${esc(label)}</label><select id="f-${name}" ${isParam === false ? 'data-field' : 'data-param'}="${name}">${opts.map(o => `<option value="${esc(o.id || o)}" ${String(o.id || o) === String(v) ? 'selected' : ''}>${esc(o.name || o)}</option>`).join('')}</select></div>`;
  }
  function ingestHtml(engine) {
    const tid = (k) => 'data-testid="media-' + k + '"';
    return `<div class="field"><span class="label">media ingest</span>
      <div class="ingest">
        <button class="btn" type="button" data-pick="cam">Camera</button>
        <button class="btn" type="button" data-pick="vid">Video</button>
        <button class="btn" type="button" data-pick="lib">Library</button>
      </div>
      <input type="file" accept="image/*" capture="environment" data-in="cam" ${tid('camera')} hidden aria-label="Take photo">
      <input type="file" accept="video/*" capture="environment" data-in="vid" ${tid('video')} hidden aria-label="Record video">
      <input type="file" accept="image/*,video/*" multiple data-in="lib" ${tid('library')} hidden aria-label="Choose from library">
      <div class="thumbs" id="${engine}-thumbs"></div>
      <p class="note">Files ≤ 24 MB are uploaded inline; larger ones are sent as metadata only.</p></div>`;
  }
  function codeHtml(engine) {
    const f = forms[engine];
    return `<div class="card code-card">
      <div class="code-head">
        <div class="seg small" role="radiogroup" aria-label="Code language">
          <button type="button" role="radio" aria-checked="${f.lang === 'python'}" data-lang="python">Python</button>
          <button type="button" role="radio" aria-checked="${f.lang === 'cli'}" data-lang="cli">CLI</button>
        </div>
        <button class="btn small" type="button" data-copycode>Copy</button>
      </div>
      <pre class="code" id="${engine}-code" tabindex="0" aria-label="Generated ${engine} code" aria-live="off"></pre></div>`;
  }
  function submitHtml(engine) {
    const lic = licenseFor(engine);
    const ok = licensesAccepted(engine);
    const terr = territoryReason(engine);
    const role = roleReason();
    const why = [terr ? engine + '-terr' : '', role ? engine + '-role' : ''].filter(Boolean).join(' ');
    return `<div class="card">
      <p class="note">${ok ? 'License accepted: ' + esc(lic.join(' + ')) + '.' : '<span class="warn-text">License not accepted yet: ' + esc(lic.filter(k => !state.license[k]).join(' + ')) + '. Submitting opens the license gate.</span>'}</p>
      <button class="btn primary block" type="submit" data-submit data-testid="${engine}-submit" ${why ? 'disabled aria-describedby="' + why + '"' : ''}>Submit to worker</button>
      ${terr ? '<p class="note err-text" id="' + engine + '-terr" data-testid="territory-reason">' + esc(terr) + '. Change your country in More → Settings, or use a worker outside these territories.</p>' : ''}
      ${role ? '<p class="note warn-text" id="' + engine + '-role" data-testid="role-reason">' + esc(role) + '.</p>' : ''}
      <p class="note" data-submit-msg role="status"></p></div>`;
  }

  function cosmosFormHtml() {
    const f = forms.cosmos; const p = f.params;
    let modeFields = '';
    if (f.mode === 'generate') {
      modeFields = `<div class="grid2">${num('frames', 'frames', p.frames, 'min="1" max="2048"')}${num('fps', 'fps', p.fps, 'min="1" max="120"')}
        ${sel('resolution', 'resolution', p.resolution, ['640x352', '960x528', '1280x704', '1920x1056'])}${num('seed', 'seed', p.seed)}
        ${num('guidance', 'guidance', p.guidance, 'step="0.5" min="0" max="30"')}${num('steps', 'steps', p.steps, 'min="1" max="200"')}</div>`;
    } else if (f.mode === 'action') {
      modeFields = `<div class="field"><label for="f-action">action / policy</label><textarea id="f-action" data-param="action" rows="3" placeholder="pick up the red cup and place it in the bin">${esc(p.action)}</textarea></div>
        ${num('horizon', 'horizon (steps)', p.horizon, 'min="1" max="512"')}`;
    } else if (f.mode === 'reason') {
      modeFields = `<div class="field"><label for="f-question">question</label><textarea id="f-question" data-param="question" rows="3" placeholder="Will the stack of boxes tip if the bottom one is pulled?">${esc(p.question)}</textarea></div>`;
    } else {
      modeFields = `${num('latency_ms', 'latency budget (ms)', p.latency_ms, 'min="10" max="5000"')}<p class="note">Edge mode targets low-latency streaming on Jetson / RTX.</p>`;
    }
    return `
      <header class="eng-cosmos"><span class="eng-tag">Cosmos 3 · OpenMDW 1.1</span><h1>Physics &amp; action</h1><div class="eng-bar"></div>
        <p class="lede">Cosmos invents motion. Compose a job; the worker runs it.</p></header>
      <form class="panel eng-cosmos" data-engine="cosmos" novalidate>
        <div class="card">
          ${segHtml('mode', COSMOS_MODES, f.mode, 'Cosmos mode')}
          <div class="field"><span class="label" id="cosmos-ml">model</span>
            <div class="opts" role="radiogroup" aria-labelledby="cosmos-ml">${COSMOS_MODELS.map(m => optHtml('model', m, m.id === f.model, modeModelReason(f, m.id))).join('')}</div></div>
          ${targetsHtml('cosmos', f)}
        </div>
        <div class="card">
          <div class="field"><label for="f-prompt-c">prompt</label><textarea id="f-prompt-c" data-field="prompt" rows="3" placeholder="A forklift reverses around a pallet in a dim warehouse">${esc(f.prompt)}</textarea></div>
          ${modeFields}
          ${ingestHtml('cosmos')}
        </div>
        ${codeHtml('cosmos')}
        ${submitHtml('cosmos')}
      </form>`;
  }
  function hyFormHtml() {
    const f = forms.hyworld; const p = f.params;
    const on = { pano: [0], worldmirror: [0, 1], stereo: [0, 1, 2], export: [0, 1, 2, 3] }[f.mode];
    let modeFields = '';
    if (f.mode === 'pano') modeFields = `<div class="grid2">${sel('resolution', 'pano resolution', p.resolution, ['2048x1024', '4096x2048'])}${num('seed', 'seed', p.seed)}</div>`;
    else if (f.mode !== 'export') modeFields = `<div class="grid2">${num('seed', 'seed', p.seed)}</div>`;
    return `
      <header class="eng-hyworld"><span class="eng-tag">HY-World 2.0 · Tencent License.txt</span><h1>Persistent place</h1><div class="eng-bar"></div>
        <p class="lede">HY-World freezes a room into splats and meshes.</p></header>
      <form class="panel eng-hyworld" data-engine="hyworld" novalidate>
        <div class="card">
          ${segHtml('mode', HY_MODES, f.mode, 'HY-World mode')}
          <div class="pipeline" aria-label="Pipeline">${HY_STAGES.map((s, i) => `<span class="st ${on.includes(i) ? 'on' : ''}">${esc(s)}</span>${i < HY_STAGES.length - 1 ? '<span class="arr" aria-hidden="true">→</span>' : ''}`).join('')}</div>
          ${targetsHtml('hyworld', f)}
        </div>
        <div class="card">
          <div class="field"><label for="f-prompt-h">prompt / scene description</label><textarea id="f-prompt-h" data-field="prompt" rows="3" placeholder="Sunlit machine shop, concrete floor, workbench along the wall">${esc(f.prompt)}</textarea></div>
          ${modeFields}
          ${f.mode === 'pano' ? '' : `<div class="field"><span class="label">export target</span>${segHtml('export', EXPORT_TARGETS, p.export_target, 'Export target')}</div>
          ${formatSegHtml(p)}`}
          ${ingestHtml('hyworld')}
        </div>
        ${codeHtml('hyworld')}
        ${submitHtml('hyworld')}
      </form>`;
  }
  function bridgeFormHtml() {
    const f = forms.bridge; const p = f.params;
    return `
      <header class="eng-bridge"><span class="eng-tag">Bridge · Cosmos + HY-World</span><h1>Motion → place</h1><div class="eng-bar"></div>
        <p class="lede">Cosmos rollout → keyframes → HY freeze.</p></header>
      <form class="panel eng-bridge" data-engine="bridge" novalidate>
        <div class="card">
          <div class="pipeline" aria-label="Bridge pipeline"><span class="st c">cosmos rollout</span><span class="arr" aria-hidden="true">→</span><span class="st c">keyframes</span><span class="arr" aria-hidden="true">→</span><span class="st h">HY freeze</span><span class="arr" aria-hidden="true">→</span><span class="st h">export</span></div>
          ${sel('cosmosModel', 'cosmos model', f.cosmosModel, COSMOS_MODELS.filter(m => m.id !== 'cosmos3-droid-policy'), false)}
          ${targetsHtml('bridge', f)}
        </div>
        <div class="card">
          <div class="field"><label for="f-prompt-b">prompt</label><textarea id="f-prompt-b" data-field="prompt" rows="3" placeholder="Camera walks through a cluttered loading dock at dusk">${esc(f.prompt)}</textarea></div>
          <div class="grid2">${num('frames', 'rollout frames', p.frames, 'min="8" max="2048"')}${num('keyframe_stride', 'keyframe stride', p.keyframe_stride, 'min="1" max="256"')}</div>
          <div class="field"><span class="label">HY export target</span>${segHtml('export', EXPORT_TARGETS, p.export_target, 'Export target')}</div>
          ${formatSegHtml(p)}
          ${ingestHtml('bridge')}
        </div>
        ${codeHtml('bridge')}
        ${submitHtml('bridge')}
      </form>`;
  }

  function renderForm(engine) {
    const panel = $('#panel-' + engine);
    const active = document.activeElement && panel.contains(document.activeElement) ? document.activeElement : null;
    const refocus = active ? Array.from(active.attributes).filter(a => a.name.startsWith('data-') || a.name === 'id').map(a => '[' + a.name + '="' + CSS.escape(a.value) + '"]').join('') : '';
    panel.innerHTML = engine === 'cosmos' ? cosmosFormHtml() : engine === 'hyworld' ? hyFormHtml() : bridgeFormHtml();
    bindForm(engine);
    renderThumbs(engine);
    updateCode(engine);
    if (refocus) { const el = $(refocus, panel); if (el) el.focus(); }
  }
  function updateCode(engine) {
    const f = forms[engine];
    const job = buildJob(engine, 'lj_preview', null);
    const pre = $('#' + engine + '-code');
    if (pre) pre.textContent = job.code[f.lang];
  }

  function bindForm(engine) {
    const panel = $('#panel-' + engine); const form = $('form', panel); const f = forms[engine];
    form.addEventListener('submit', (e) => { e.preventDefault(); submitForm(engine); });
    form.addEventListener('input', (e) => {
      const t = e.target;
      if (t.dataset.param) f.params[t.dataset.param] = t.type === 'number' ? t.value : t.value;
      else if (t.dataset.field) f[t.dataset.field] = t.value;
      else return;
      if (t.dataset.field === 'cosmosModel') { fixTarget(engine); renderForm(engine); return; }
      updateCode(engine);
    });
    form.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.in) { addFiles(engine, t.files); t.value = ''; }
      else if (t.tagName === 'SELECT' && t.dataset.field === 'cosmosModel') { f.cosmosModel = t.value; fixTarget(engine); renderForm(engine); }
    });
    form.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b || !form.contains(b)) return;
      if (b.dataset.mode) {
        f.mode = b.dataset.mode;
        if (engine === 'cosmos') {
          if (modeModelReason(f, f.model)) f.model = f.mode === 'action' ? 'cosmos3-droid-policy' : 'cosmos3-edge-4b';
          if (f.mode === 'action' && f.model === 'cosmos3-edge-4b') f.model = 'cosmos3-droid-policy';
          fixTarget(engine);
        }
        renderForm(engine);
      } else if (b.dataset.model) {
        const why = modeModelReason(f, b.dataset.model);
        if (why) { toast(why); return; }
        f.model = b.dataset.model; fixTarget(engine); renderForm(engine);
      } else if (b.dataset.target) {
        const why = feasibility(engine, f, b.dataset.target);
        if (why) { toast(why); return; }
        f.target = b.dataset.target; renderForm(engine);
      } else if (b.dataset.export) {
        f.params.export_target = b.dataset.export;
        if (formatReason(f.params.export_target, f.params.format)) { toast(formatReason(f.params.export_target, f.params.format) + ' → switched to ply'); f.params.format = 'ply'; }
        renderForm(engine);
      } else if (b.dataset.format) {
        const why = formatReason(f.params.export_target, b.dataset.format);
        if (why) { toast(why); return; }
        f.params.format = b.dataset.format; renderForm(engine);
      }
      else if (b.dataset.lang) { f.lang = b.dataset.lang; renderForm(engine); }
      else if ('copycode' in b.dataset) { copyText($('#' + engine + '-code').textContent, f.lang === 'python' ? 'Python' : 'CLI'); }
      else if (b.dataset.pick) { $('[data-in="' + b.dataset.pick + '"]', form).click(); }
      else if (b.dataset.rm) {
        const i = Number(b.dataset.rm); const m = f.media[i];
        if (m) { URL.revokeObjectURL(m.url); f.media.splice(i, 1); renderThumbs(engine); updateCode(engine); }
      }
    });
    // Arrow-key navigation inside radiogroups
    $$('[role=radiogroup]', form).forEach(g => g.addEventListener('keydown', (e) => {
      if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
      const items = $$('[role=radio]', g); const i = items.indexOf(document.activeElement); if (i < 0) return;
      e.preventDefault();
      const d = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : -1;
      items[(i + d + items.length) % items.length].focus();
    }));
  }
  /* If the current target is infeasible for the model, move to the first feasible one (and say so). */
  function fixTarget(engine) {
    const f = forms[engine];
    if (!feasibility(engine, f)) return;
    const ok = TARGETS.find(t => !feasibility(engine, f, t.id));
    if (ok) { toast(feasibility(engine, f) + ' → switched to ' + ok.name); f.target = ok.id; }
  }

  function addFiles(engine, files) {
    const f = forms[engine];
    Array.from(files || []).forEach(file => {
      const kind = /^video\//.test(file.type) ? 'video' : 'image';
      f.media.push({ file: file, kind: kind, url: URL.createObjectURL(file) });
      if (file.size > MAX_INLINE) toast(file.name + ' > 24 MB: will be sent as metadata only');
    });
    renderThumbs(engine); updateCode(engine);
  }
  function renderThumbs(engine) {
    const box = $('#' + engine + '-thumbs'); if (!box) return;
    box.innerHTML = forms[engine].media.map((m, i) => `
      <div class="thumb">
        ${m.kind === 'video' ? `<video src="${esc(m.url)}" muted playsinline preload="metadata" aria-label="${esc(m.file.name)}"></video>` : `<img src="${esc(m.url)}" alt="${esc(m.file.name)}">`}
        <div class="t-meta ${m.file.size > MAX_INLINE ? 'big' : ''}" title="${esc(m.file.name)}">${esc(fmtBytes(m.file.size))}${m.file.size > MAX_INLINE ? ' · meta only' : ''}</div>
        <button type="button" class="t-rm" data-rm="${i}" aria-label="Remove ${esc(m.file.name)}"><span aria-hidden="true">✕</span></button>
      </div>`).join('');
  }

  async function submitForm(engine) {
    const f = forms[engine]; const form = $('#panel-' + engine + ' form');
    const msg = $('[data-submit-msg]', form); const btn = $('[data-submit]', form);
    const why = feasibility(engine, f);
    if (why) { msg.textContent = why; msg.className = 'note err-text'; return; }
    const terr = territoryReason(engine);
    if (terr) { msg.textContent = terr; msg.className = 'note err-text'; return; }
    const rr = roleReason();
    if (rr) { msg.textContent = rr; msg.className = 'note err-text'; return; }
    if (!licensesAccepted(engine)) { openLicenseSheet(engine); return; }
    if (engine === 'bridge' && !f.prompt.trim()) { msg.textContent = 'Bridge needs a prompt for the Cosmos rollout.'; msg.className = 'note err-text'; return; }
    btn.disabled = true; msg.className = 'note'; msg.textContent = 'Preparing job…';
    let warned = false;
    const data = [];
    for (const m of f.media) {
      if (m.file.size <= MAX_INLINE) { try { data.push(await readDataUrl(m.file)); } catch (e) { data.push(null); } }
      else { data.push(null); warned = true; }
    }
    if (warned) toast('Files > 24 MB sent as metadata only — copy them to the worker manually');
    const id = newJobId();
    const job = buildJob(engine, id, data);
    const record = Object.assign(stripMedia(job), { status: 'queued', progress: 0, stage: 'submitted', log: [], artifacts: [] });
    msg.textContent = 'Submitting to ' + baseUrl() + '…';
    try {
      const res = await API.submit(job);
      if (res && res.id && res.id !== id) record.id = res.id;
      record.status = (res && res.status) || 'queued';
      record.draft = false;
      upsertJob(record);
      startPolling(record.id);
      msg.textContent = 'Queued ' + record.id + '. Track it on Home.';
      toast('Job queued');
      refreshHealth();
    } catch (e) {
      if (e.status === 400 || e.status === 403) { msg.textContent = 'Worker rejected job: ' + e.message; msg.className = 'note err-text'; }
      else if (e.offline || !e.status) { offerDraft(record, job, e.message); msg.textContent = 'Worker offline.'; msg.className = 'note warn-text'; }
      else { msg.textContent = 'Submit failed: ' + e.message; msg.className = 'note err-text'; }
    } finally { btn.disabled = !!territoryReason(engine) || !!roleReason(); }
  }
  function offerDraft(record, job, reason) {
    openSheet('Worker offline', `
      <p>${esc(reason)} at <span class="mono">${esc(baseUrl())}</span>.</p>
      <p class="note">Save the job as a queued draft and send it later from its detail sheet, or download job.json and POST it from a machine that can reach the worker.</p>
      <div class="row"><button class="btn primary grow eng-cosmos" type="button" id="draftSave">Save as queued draft</button>
      <button class="btn grow" type="button" id="draftDl">Download job.json</button></div>`, (el) => {
      $('#draftSave', el).addEventListener('click', () => { record.draft = true; record.stage = 'draft'; upsertJob(record); closeSheet(); toast('Draft saved'); });
      $('#draftDl', el).addEventListener('click', () => download('job.json', stripMedia(job)));
    });
  }

  /* ================================================================
   * 9. License gate
   * ================================================================ */
  function licenseCardsHtml() {
    const a = state.license;
    return `
      <div class="card lic eng-cosmos">
        <div class="card-head"><h2>Cosmos 3 — OpenMDW 1.1</h2></div>
        <ul>
          <li><span class="yes">✓</span> Commercial use OK</li>
          <li><span class="warn-text">!</span> Notices / attribution required</li>
          <li><span class="no">✕</span> No competing public model API</li>
          <li><span class="yes">✓</span> Generated outputs are yours</li>
        </ul>
        <p class="lic-status ${a[LIC.cosmos] ? 'ok' : ''}">${a[LIC.cosmos] ? 'Accepted ' + esc(new Date(a[LIC.cosmos]).toLocaleString()) : 'Not accepted'}</p>
        <button class="btn ${a[LIC.cosmos] ? '' : 'primary'}" type="button" data-lic="${LIC.cosmos}">${a[LIC.cosmos] ? 'Revoke' : 'Accept OpenMDW 1.1'}</button>
      </div>
      <div class="card lic eng-hyworld">
        <div class="card-head"><h2>HY-World 2.0 — Tencent License.txt</h2></div>
        <ul>
          <li>Stays on Tencent's own <b>License.txt</b> (HY-World 2.0 Community License).</li>
          <li>Lattice does <b>not</b> relicense it. Read the original file shipped with the weights.</li>
          <li>Territory and usage restrictions in that file apply to you.</li>
        </ul>
        <p class="lic-status ${a[LIC.hy] ? 'ok' : ''}">${a[LIC.hy] ? 'Accepted ' + esc(new Date(a[LIC.hy]).toLocaleString()) : 'Not accepted'}</p>
        <button class="btn ${a[LIC.hy] ? '' : 'primary'}" type="button" data-lic="${LIC.hy}">${a[LIC.hy] ? 'Revoke' : 'I have read License.txt — accept'}</button>
      </div>
      <p class="note">Lattice UI and worker code: MIT. Weights keep their own licenses.</p>`;
  }
  function bindLicense(el, after) {
    $$('[data-lic]', el).forEach(b => b.addEventListener('click', () => {
      const k = b.dataset.lic;
      state.license[k] = state.license[k] ? null : new Date().toISOString();
      saveLicense();
      toast(state.license[k] ? 'Accepted ' + k : 'Revoked ' + k);
      ['cosmos', 'hyworld', 'bridge'].forEach(renderForm);
      if (after) after();
    }));
  }
  function openLicenseSheet(engine) {
    const need = licenseFor(engine).filter(k => !state.license[k]);
    const draw = (el) => {
      el.innerHTML = `<p class="note">${engine === 'bridge' ? 'Bridge needs <b>both</b> licenses.' : 'This engine needs its license accepted.'} Missing: ${esc(need.filter(k => !state.license[k]).join(' + ') || 'none')}</p>` + licenseCardsHtml() +
        (licensesAccepted(engine) ? '<button class="btn primary block eng-cosmos" type="button" id="licDone">Continue — submit job</button>' : '');
      bindLicense(el, () => draw(el));
      const d = $('#licDone', el);
      if (d) d.addEventListener('click', () => { closeSheet(); submitForm(engine); });
    };
    openSheet('License gate', '', draw);
  }

  /* ================================================================
   * 10. More: jobs, license, snippets, settings
   * ================================================================ */
  function snippets() {
    const u = baseUrl() || 'http://localhost:8787';
    const auth = ' -H "Authorization: Bearer $LATTICE_TOKEN"';
    return {
      health: 'curl ' + u + '/health',
      post: 'curl -X POST ' + u + '/jobs -H "Content-Type: application/json" \\\n  -H "X-HF-Token: $HF_TOKEN"' + auth + ' -d @job.json',
      poll: 'curl ' + u + '/jobs/$JOB_ID' + auth + '\ncurl "' + u + '/jobs?limit=8"' + auth,
      python: [
        'import os, time, requests',
        'W = os.environ.get("LATTICE_WORKER", ' + JSON.stringify(u) + ')',
        'H = {"Authorization": "Bearer " + os.environ.get("LATTICE_TOKEN", "")}',
        '',
        'def submit(job):',
        '    h = dict(H, **{"X-HF-Token": os.environ["HF_TOKEN"]})',
        '    r = requests.post(f"{W}/jobs", json=job, headers=h, timeout=120)',
        '    r.raise_for_status()',
        '    return r.json()["id"]',
        '',
        'def wait(job_id, every=1.5):',
        '    while True:',
        '        s = requests.get(f"{W}/jobs/{job_id}", headers=H, timeout=10).json()',
        '        if s["status"] in ("done", "failed", "cancelled"):',
        '            return s',
        '        time.sleep(every)',
        '',
        'print(requests.get(f"{W}/health", timeout=5).json())'
      ].join('\n')
    };
  }
  /* Audit & costs (admins): GET /audit, GET /report, GET /audit.csv. CSV is fetched with the
   * Authorization header and saved as a blob: the worker never accepts ?token= outside /runs. */
  function renderAdmin() {
    const box = $('#moreAdmin'); if (!box) return;
    const on = isAdmin();
    if (box.dataset.on === String(on)) return;
    box.dataset.on = String(on);
    if (!on) { box.innerHTML = ''; return; }
    const who = you();
    box.innerHTML = `
      <details class="card sub" id="moreAudit"><summary>Audit &amp; costs</summary>
        <div class="panel">
          <p class="note">${who ? 'Admin view for <b>' + esc(who.name) + '</b>. ' : 'This worker has no user list, so its token holder sees everything. '}Job submits and cancels, license acceptances, user changes and failed sign-ins from <span class="mono">runs/_audit/audit.jsonl</span>, plus GPU cost per user and engine from job metrics. Tokens are never logged.</p>
          <div class="grid2">
            <div class="field"><label for="a-since">costs since</label><input type="date" id="a-since"></div>
            <div class="field"><label for="a-limit">audit rows</label><select id="a-limit"><option>50</option><option selected>200</option><option>1000</option></select></div>
          </div>
          <div class="row">
            <button class="btn small primary eng-cosmos" type="button" id="auditLoad">Load</button>
            <button class="btn small" type="button" id="auditCsv" data-testid="audit-csv">Download CSV</button>
            <button class="btn small" type="button" id="auditCopy">Copy CSV</button>
          </div>
          <p class="note" id="auditMsg" role="status"></p>
          <div id="reportBox"></div>
          <div id="auditBox"></div>
        </div>
      </details>`;
    $('#moreAudit').addEventListener('toggle', (e) => { if (e.target.open && !e.target.dataset.loaded) { e.target.dataset.loaded = '1'; loadAdmin(); } });
    $('#auditLoad').addEventListener('click', loadAdmin);
    $('#auditCsv').addEventListener('click', async () => {
      const csv = await fetchAuditCsv(); if (csv == null) return;
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = 'lattice-audit.csv';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    });
    $('#auditCopy').addEventListener('click', async () => { const csv = await fetchAuditCsv(); if (csv != null) copyText(csv, 'Audit CSV'); });
  }
  async function fetchAuditCsv() {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const r = await fetch(baseUrl() + '/audit.csv', { headers: authHeaders(), cache: 'no-store', signal: ctrl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } catch (e) { toast('CSV failed: ' + (e.name === 'AbortError' ? 'timed out' : e.message)); return null; }
    finally { clearTimeout(timer); }
  }
  function fmtCost(v) { return v == null || !isFinite(Number(v)) ? '—' : '$' + Number(v).toFixed(Number(v) < 1 ? 4 : 2); }
  function fmtGpuH(v) { const n = Number(v); return !isFinite(n) ? '—' : n === 0 ? '0' : n.toFixed(n < 0.01 ? 5 : 3); }
  function reportHtml(r) {
    const row = (label, t) => `<tr><td>${label}</td><td class="num">${esc(t.jobs)}</td><td class="num">${esc(fmtGpuH(t.gpu_hours))}</td><td class="num">${esc(fmtCost(t.cost_usd))}</td><td class="num${t.failures ? ' err-text' : ''}">${esc(t.failures)}</td></tr>`;
    const users = Array.isArray(r.users) ? r.users : []; const engines = Array.isArray(r.engines) ? r.engines : [];
    return `<div class="field"><span class="label">team costs${r.since ? ' since ' + esc(new Date(r.since).toLocaleDateString()) : ' (all time)'}</span>
      <div class="tbl-wrap"><table class="data" data-testid="report-table">
        <thead><tr><th scope="col">who / engine</th><th scope="col" class="num">jobs</th><th scope="col" class="num">gpu-h</th><th scope="col" class="num">cost</th><th scope="col" class="num">failed</th></tr></thead>
        <tbody><tr><th scope="colgroup" colspan="5">by user</th></tr>${users.length ? users.map(u => row(u.user == null ? '<span class="note">(no user)</span>' : esc(u.user), u)).join('') : '<tr><td colspan="5" class="note">No jobs in this period.</td></tr>'}</tbody>
        <tbody><tr><th scope="colgroup" colspan="5">by engine</th></tr>${engines.map(e => row(esc(e.engine), e)).join('')}</tbody>
        ${r.totals ? '<tfoot>' + row('total', r.totals) + '</tfoot>' : ''}
      </table></div>
      <p class="note">${r.gpu_usd_hr == null ? 'No LATTICE_GPU_USD_HR set on the worker, so cost shows —. ' : ''}Estimated from job metrics; dry runs count 0. Not a bill.</p></div>`;
  }
  function auditHtml(entries) {
    const detail = (e) => [
      e.job_id ? 'job ' + e.job_id : '', e.license_id ? 'license ' + e.license_id : '', e.accepted_at ? 'accepted ' + e.accepted_at : '',
      e.territory ? 'territory ' + e.territory : '', e.subject ? 'user ' + e.subject : '', e.change ? e.change : '', e.role ? 'role ' + e.role : ''
    ].filter(Boolean).join(' · ');
    const rows = entries.slice().reverse().map(e => `<tr class="${e.action === 'auth.fail' ? 'auth-fail' : ''}">
      <td title="${esc(e.ts || '')}">${esc(e.ts ? new Date(e.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—')}</td><td>${esc(e.action)}</td><td>${esc(e.user == null ? '—' : e.user)}</td>
      <td class="detail">${esc(detail(e) || '—')}</td><td>${esc(e.ip == null ? '—' : e.ip)}</td></tr>`).join('');
    return `<div class="field"><span class="label">audit log · newest first (${esc(entries.length)})</span>
      <div class="tbl-wrap"><table class="data" data-testid="audit-table">
        <thead><tr><th scope="col">time</th><th scope="col">action</th><th scope="col">user</th><th scope="col">detail</th><th scope="col">ip</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="note">No audit entries yet.</td></tr>'}</tbody>
      </table></div></div>`;
  }
  async function loadAdmin() {
    const msg = $('#auditMsg'); if (!msg) return;
    msg.className = 'note'; msg.textContent = 'Loading…';
    const since = ($('#a-since') || {}).value || '';
    const limit = Number(($('#a-limit') || {}).value) || 200;
    const [rep, aud] = await Promise.allSettled([API.report(since), API.audit(limit)]);
    const rb = $('#reportBox'); const ab = $('#auditBox'); if (!rb || !ab) return;
    const errs = [];
    if (rep.status === 'fulfilled' && rep.value) rb.innerHTML = reportHtml(rep.value);
    else { rb.innerHTML = ''; errs.push('report: ' + (rep.reason ? rep.reason.message : 'no data')); }
    if (aud.status === 'fulfilled' && aud.value) ab.innerHTML = auditHtml(Array.isArray(aud.value.entries) ? aud.value.entries : []);
    else { ab.innerHTML = ''; errs.push('audit: ' + (aud.reason ? aud.reason.message : 'no data')); }
    msg.className = errs.length ? 'note err-text' : 'note';
    msg.textContent = errs.length ? 'Failed — ' + errs.join('; ') : 'Updated ' + new Date().toLocaleTimeString();
  }
  function renderMore() {
    const s = state.settings; const sn = snippets();
    const p = $('#panel-more');
    p.innerHTML = `
      <header><h1>More</h1></header>
      <details class="card sub" open id="moreJobsBox"><summary>Jobs (${state.jobs.length})</summary>
        <div class="row">
          <button class="btn small" type="button" id="jobsExport" data-testid="jobs-export">Export lattice-jobs.json</button>
          <button class="btn small" type="button" id="jobsImport" data-testid="jobs-import">Import</button>
          <button class="btn small danger" type="button" id="jobsClear">Clear</button>
          <input type="file" accept="application/json,.json" id="jobsImportIn" hidden aria-label="Import jobs file">
        </div>
        <ul class="jobs" id="moreJobs"></ul>
      </details>
      <details class="card sub" id="moreLicense"><summary>License gate</summary><div class="panel" id="licBox"></div></details>
      <details class="card sub" id="moreSnippets"><summary>Snippets</summary>
        ${Object.keys(sn).map(k => `<div class="card code-card"><div class="code-head"><span class="label mono">${esc({ health: 'curl · health', post: 'curl · POST job', poll: 'curl · poll', python: 'python client' }[k])}</span><button class="btn small" type="button" data-snip="${k}">Copy</button></div><pre class="code" tabindex="0">${esc(sn[k])}</pre></div>`).join('')}
      </details>
      <div id="moreAdmin"></div>
      <details class="card sub" id="moreSettings"><summary>Settings</summary>
        <form id="settingsForm" class="panel" novalidate>
          <div class="field"><label for="s-url">worker URL</label><input type="url" id="s-url" value="${esc(s.workerUrl)}" autocomplete="off" autocapitalize="off" spellcheck="false" inputmode="url"><p class="note err-text" id="s-mixed" ${mixedContent() ? '' : 'hidden'}>${esc(MIXED_MSG)}</p></div>
          <div class="field"><label for="s-wt">worker token (LATTICE_TOKEN)</label><input type="password" id="s-wt" value="${esc(s.workerToken)}" autocomplete="off" aria-describedby="s-wt-note">
            <p class="note" id="s-wt-note">On a multi-user worker (LATTICE_USERS) paste your personal token from <span class="mono">worker.py users add</span>; your role comes with it.</p></div>
          <div class="field"><label for="s-hf">Hugging Face token</label><input type="password" id="s-hf" value="${esc(s.hfToken)}" autocomplete="off" aria-describedby="s-hf-note">
            <p class="note" id="s-hf-note">Sent only as X-HF-Token header, never stored in jobs/exports/code.</p></div>
          <div class="field"><label for="s-territory">Your country (ISO code)</label><input type="text" id="s-territory" value="${esc(s.territory || '')}" maxlength="2" autocomplete="country" autocapitalize="characters" spellcheck="false" placeholder="e.g. US" aria-describedby="s-terr-note">
            <p class="note" id="s-terr-note">Optional. Sent as job.license.territory; HY-World 2.0's license does not apply in the EU-27, UK or South Korea.</p></div>
          <div class="grid2">
            <div class="field"><label for="s-poll">poll interval (ms)</label><input type="number" id="s-poll" min="500" max="60000" step="100" value="${esc(s.pollMs)}"></div>
            ${sel('s-target', 'default target', s.target, TARGETS, false).replace('data-field="s-target"', '')}
          </div>
          <div class="row"><button class="btn primary grow eng-cosmos" type="submit">Save</button><button class="btn grow" type="button" id="sTest">Test connection</button></div>
          <p class="note" id="sMsg" role="status"></p>
        </form>
      </details>
      <p class="note">Lattice is a control surface: no weights ship in this app and nothing runs on-device. UI &amp; worker: MIT.</p>`;
    renderJobList($('#moreJobs'), state.jobs);
    renderAdmin();
    const lb = $('#licBox'); const drawLic = () => { lb.innerHTML = licenseCardsHtml(); bindLicense(lb, drawLic); }; drawLic();
    $('#jobsExport').addEventListener('click', () => {
      download('lattice-jobs.json', { schema: 'lattice.jobs-export/1', exported: new Date().toISOString(), jobs: state.jobs.map(recordForExport) });
    });
    $('#jobsImport').addEventListener('click', () => $('#jobsImportIn').click());
    $('#jobsImportIn').addEventListener('change', async (e) => {
      const file = e.target.files[0]; e.target.value = ''; if (!file) return;
      try {
        const d = JSON.parse(await file.text());
        const list = Array.isArray(d) ? d : (d && Array.isArray(d.jobs) ? d.jobs : null);
        if (!list) throw new Error('not a lattice-jobs.json');
        let n = 0;
        list.forEach(j => { if (j && typeof j.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(j.id)) { upsertJob(recordForExport(j)); n++; } });
        toast('Imported ' + n + ' jobs'); renderMore();
      } catch (err) { toast('Import failed: ' + err.message); }
    });
    $('#jobsClear').addEventListener('click', () => {
      if (!confirm('Clear local job history? Worker runs are not deleted.')) return;
      Object.values(state.pollers).forEach(clearTimeout); state.pollers = {};
      state.jobs = []; saveJobs(); renderMore(); toast('History cleared');
    });
    $$('[data-snip]', p).forEach(b => b.addEventListener('click', () => copyText(sn[b.dataset.snip], 'Snippet')));
    const readSettings = () => {
      const url = $('#s-url').value.trim();
      state.settings.workerUrl = url;
      state.settings.workerToken = $('#s-wt').value.trim();
      state.settings.hfToken = $('#s-hf').value.trim();
      state.settings.territory = normRegion($('#s-territory').value);
      $('#s-territory').value = state.settings.territory;
      state.settings.pollMs = Math.min(60000, Math.max(500, Number($('#s-poll').value) || 1500));
      state.settings.target = $('#f-s-target').value;
      saveSettings();
    };
    $('#s-url').addEventListener('input', (e) => { $('#s-mixed').hidden = !(location.protocol === 'https:' && /^http:/i.test(e.target.value.trim())); });
    $('#settingsForm').addEventListener('submit', (e) => {
      e.preventDefault(); readSettings(); toast('Settings saved'); refreshHealth();
      ['cosmos', 'hyworld', 'bridge'].forEach(renderForm);
    });
    $('#sTest').addEventListener('click', async () => {
      readSettings(); const m = $('#sMsg'); m.className = 'note'; m.textContent = 'Testing ' + baseUrl() + '…';
      const h = await refreshHealth();
      if (h) {
        m.className = 'note';
        m.innerHTML = '<span style="color:var(--ok)">Connected</span> · ' + esc(h.service) + ' ' + esc(h.version) + (h.dry_run ? ' · dry-run' : ' · exec') + (h.auth && !state.settings.workerToken ? ' · <span class="warn-text">worker requires a token</span>' : '') + (h.you ? ' · signed in as ' + esc(h.you.name) + ' (' + esc(h.you.role) + ')' : '');
        if (h.auth && state.settings.workerToken) {
          try { await API.list(1); m.innerHTML += ' · token OK'; } catch (e) { m.innerHTML += ' · <span class="err-text">token rejected: ' + esc(e.message) + '</span>'; }
        }
        syncRemoteJobs();
      } else { m.className = 'note err-text'; m.textContent = 'Failed: ' + (state.healthErr || 'unknown'); }
      ['cosmos', 'hyworld', 'bridge'].forEach(renderForm);
    });
  }

  /* ================================================================
   * 11. Boot
   * ================================================================ */
  function boot() {
    bindTabs(); bindSheet();
    ['cosmos', 'hyworld', 'bridge'].forEach(e => { fixTargetSilently(e); renderForm(e); });
    const h = (location.hash || '').slice(1);
    selectTab(TABS.includes(h) ? h : 'home');
    refreshHealth().then(h => { if (h) syncRemoteJobs(); });
    resumePolling();
    setInterval(() => { if (!document.hidden) refreshHealth(); }, 20000);
    setInterval(() => { if (state.tab === 'home') renderJobList($('#homeJobs'), state.jobs.slice(0, 8)); }, 60000);
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => { /* optional */ }); });
    }
  }
  function fixTargetSilently(engine) {
    const f = forms[engine];
    if (feasibility(engine, f)) { const ok = TARGETS.find(t => !feasibility(engine, f, t.id)); if (ok) f.target = ok.id; }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
