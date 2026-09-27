/* Essence Protocol content editor: the content sections. Essences (and pair reactions), combos,
 * battle, traits, words and names, and the world (map and rooms, zones, trainers, people,
 * starters, game lines). */
(function () {
  'use strict';
  const App = window.EDITOR, S = App.S, SC = App.SC, esc = App.esc, fmt = App.fmt, plural = App.plural, F = App.F;
  const V = App.views, head = (...a) => App.head(...a), bar = (...a) => App.bar(...a);
  const tabs = (base, list, on) => `<div class="tabs">${list.map(([id, label]) => `<button class="tab${id === on ? ' on' : ''}" data-go="${base}/${id}">${esc(label)}</button>`).join('')}</div>`;
  const idFrom = (name, taken) => { let b = String(name || 'new').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'new', id = b, n = 2; while (taken.includes(id)) id = b + '-' + n++; return id; };
  const E = () => App.mods().E;
  const countWith = test => S.keys.reduce((n, k) => n + (test(k) ? 1 : 0), 0);
  const subsOf = k => (k.length > 3 ? k.slice(3).match(/.{3}/g).map(t => t.slice(0, 2)) : []);

  // ================================================================ essences
  function essenceCard(x, isMain) {
    const ch = App.isChanged(`essences.${isMain ? 'mains' : 'subs'}[${x.code}]`) || !SC.resolve(S.base, `essences.subs[${x.code}]`).found && !isMain;
    const bad = App.issuesAt(`essences.${isMain ? 'mains' : 'subs'}[${x.code}]`).some(i => i.level === 'error');
    const eff = S.cur.battle.effects.find(f => f.code === x.effect);
    return `<button class="ecard${bad ? ' bad' : ''}" data-go="essences/${x.code}" style="--c:${esc(x.color)}">${ch ? '<span class="chg"></span>' : ''}<div class="top"><span class="sw">${esc(x.code)}</span><div><div class="nm">${esc(x.name)}</div><div class="d">${isMain ? `main · strong against ${esc(App.essName(x.beats))}` : x.host ? `binds to ${esc(App.essName(x.host))}` : 'universal'}</div></div></div>
      <div class="d">${isMain ? '' : `adds ${esc(eff ? eff.name : x.effect)} · `}passive <b>${esc(x.passive.name)}</b></div></button>`;
  }
  function samples(code, isMain) {
    const out = [];
    for (const k of S.keys) {
      if (isMain ? (k[0] === code && subsOf(k).length <= 1) : (subsOf(k).length === 1 && subsOf(k)[0] === code)) out.push(k);
      if (out.length >= 8) break;
    }
    return out;
  }
  V.essences = {
    render(args) {
      if (args[0] === 'pair') return pairView(args[1]);
      if (args[0] === 'new') return newSubView();
      if (args[0]) return essenceView(args[0]);
      const d = S.cur.essences;
      const cycle = (() => { const seen = [], start = d.mains[0].code; let c = start; for (let i = 0; i < d.mains.length + 1 && c && !seen.includes(c); i++) { seen.push(c); c = (d.mains.find(m => m.code === c) || {}).beats; } return seen.map(App.essName).join(' → ') + (c === start ? ' → ' + App.essName(start) : ''); })();
      return `<div class="page">${head('Essences', 'Four main essences and the sub-essences that bind to them. Every merge is built from these, so a change here reaches every spell, daemon and item that has the essence.')}
        <div class="card"><h3>Main essences</h3><p class="sub">Strong against: ${esc(cycle)}.</p><div class="cards">${d.mains.map(m => essenceCard(m, true)).join('')}</div></div>
        <div class="card"><div class="row spread"><h3>Sub-essences</h3><button class="btn" data-go="essences/new">+ New sub-essence</button></div><p class="sub">Bound subs attach to one main; universal subs attach to either and take a facet from it.</p><div class="cards">${d.subs.map(s => essenceCard(s, false)).join('')}</div></div>
        <div class="card"><h3>Pair reactions</h3><p class="sub">What two mains become when they merge, named by which one leads.</p><div class="cards">${Object.entries(d.reactions).map(([pid, r]) => `<button class="ecard" data-go="essences/pair/${pid}">${App.isChanged('essences.reactions.' + pid) ? '<span class="chg"></span>' : ''}<div class="nm">${esc(Object.values(r.names).join(' / '))}</div><div class="d">${[...new Set(pid.split(''))].map(c => App.essChip(c)).join(' ')}${r.volatile ? ' · <span class="t-F">volatile</span>' : ''}</div><div class="d">${esc(r.line)}</div></button>`).join('')}</div></div></div>`;
    },
  };
  function essenceView(code) {
    const d = S.cur.essences, isMain = !!d.mains.find(m => m.code === code), x = isMain ? d.mains.find(m => m.code === code) : d.subs.find(s => s.code === code);
    if (!x) return `<div class="page"><div class="empty">No essence "${esc(code)}". <a href="#essences">Back to essences</a></div></div>`;
    const P = `essences.${isMain ? 'mains' : 'subs'}[${code}]`, f = n => F.field(P + '.' + n);
    const isNew = !isMain && !SC.resolve(S.base, P).found;
    const n = countWith(k => isMain ? k[0] === code || k[1] === code : subsOf(k).includes(code));
    const sm = samples(code, isMain);
    const adjUse = !isMain ? App.wordUsage(x.adjectives, 'name', 'start') : null;
    return `<div class="page">
      <div class="dhead"><a class="btn small" href="#essences">← Essences</a><span class="ecard" style="--c:${esc(x.color)};padding:0;border:0;background:none"><span class="sw" style="width:44px;height:44px;font-size:15px">${esc(code)}</span></span><div><h1>${esc(x.name)}</h1><div class="dim">${isMain ? 'Main essence' : x.host ? 'Sub-essence bound to ' + esc(App.essName(x.host)) : 'Universal sub-essence'} · in ${plural(n, 'merge')} <a href="#spells" data-filter-sub="${isMain ? '' : esc(code)}" data-filter-lead="${isMain ? esc(code) : ''}">see them</a></div></div></div>
      ${isNew ? '<div class="note warn">New sub-essence. It adds merges to the game; everything about it is data, but check its sprite and passive below.</div>' : ''}
      <div class="card"><h3>How it looks</h3><div class="row">${sm.map(k => { const r = App.rec(k); return `<a href="#daemons/${esc(k)}" style="text-align:center;text-decoration:none;color:inherit">${App.sprite(k, 64)}<div class="dim" style="font-size:12px">${esc(r ? r.dName : k)}</div></a>`; }).join('') || '<span class="dim">Baking…</span>'}</div></div>
      <div class="grid g2">
        <div class="card"><h3>Identity</h3><div class="form">${f('name')}${isMain ? '' : f('code')}${isMain ? '' : f('host')}${isMain ? '' : f('desc')}${f('color')}${isMain ? f('light') + f('deep') : ''}</div></div>
        <div class="card"><h3>In battle</h3><div class="form">${isMain ? f('beats') : f('effect')}${f('passive.name')}${f('passive.desc')}${f('passive.mechanic')}${isMain ? f('base') : ''}</div></div>
      </div>
      <div class="card"><h3>Trait pushes</h3><p class="sub">${esc(SC.SCHEMA.fields.essences.fields[isMain ? 'mains' : 'subs'].item.fields.traits.help)}</p>${F.field(P + '.traits', { label: ' ', help: '' })}</div>
      ${!isMain && !x.host ? `<div class="card"><h3>Facets</h3><p class="sub">What ${esc(x.name)} becomes on each main: the word it lends to spell names, extra pushes, an extra effect.</p>${F.field(P + '.facets', { label: ' ', help: '' })}</div>` : ''}
      <div class="card"><h3>Words and names</h3><div class="form">
        ${isMain ? f('traitNameAdjectives') : F.field(P + '.adjectives', { usage: adjUse })}
        ${isMain ? f('nameRoots') + f('nameMids') : f('nameSyllables')}
        ${isMain ? f('bodies') + f('belly') : f('organ') + f('sprite') + f('eyes')}
        ${f('lineWords')}
      </div></div>
      <div class="card"><h3>Trait leanings</h3>${F.field(P + '.traitLean', { label: ' ' })}</div>
      ${isNew ? `<div><button class="btn danger" data-remove-sub="${esc(code)}">Remove this new sub-essence</button></div>` : ''}
    </div>`;
  }
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-remove-sub]');
    if (b) { const code = b.dataset.removeSub; App.remove(`essences.subs[${code}]`); App.go('essences'); return; }
    const a = e.target.closest('[data-filter-sub], [data-filter-lead]');
    if (a && (a.dataset.filterSub != null || a.dataset.filterLead != null)) { App.setMergeFilter({ sub: a.dataset.filterSub || '', lead: a.dataset.filterLead || '' }); }
  });
  function pairView(pid) {
    const r = S.cur.essences.reactions[pid];
    if (!r) return `<div class="page"><div class="empty">No pair "${esc(pid)}".</div></div>`;
    const P = 'essences.reactions.' + pid;
    return `<div class="page"><div class="dhead"><a class="btn small" href="#essences">← Essences</a><div><h1>${esc(Object.values(r.names).join(' / '))}</h1><div class="dim">What ${[...new Set(pid.split(''))].map(App.essName).join(' and ')} become together · in ${plural(countWith(k => [k[0] + k[1], k[1] + k[0]].includes(pid)), 'merge')}</div></div></div>
      <div class="card"><div class="form">${F.field(P + '.names')}${F.field(P + '.line')}${F.field(P + '.volatile')}${F.field(P + '.effects')}${F.field(P + '.traits')}</div></div></div>`;
  }
  function newSubView() {
    const d = S.cur.essences;
    const taken = d.subs.map(s => s.code).concat(d.mains.map(m => m.code));
    return `<div class="page">${head('New sub-essence', 'A new sub-essence is pure data: its passive reuses one of the battle mechanics and its sprite organ reuses one of the shapes. It adds a lot of merges, so the database (and the game\'s download) grows.')}
      <div class="card"><div class="form" id="ns">
        <div class="grid g2"><label class="fld"><span class="lab">Name</span><input type="text" id="nsName" placeholder="e.g. Poison" maxlength="14"></label>
        <label class="fld"><span class="lab">Code</span><input type="text" id="nsCode" class="mono" placeholder="Po" maxlength="2"><span class="help">Two letters, capital then lowercase. Taken: ${esc(taken.join(' '))}</span></label></div>
        <label class="fld"><span class="lab">Binds to</span><select id="nsHost"><option value="">Any main (universal)</option>${d.mains.map(m => `<option value="${m.code}">${esc(m.name)} only</option>`).join('')}</select></label>
        <div class="note" id="nsImpact"></div>
        <div class="row"><button class="btn pri" id="nsGo">Create it</button><a class="btn" href="#essences">Cancel</a></div>
      </div></div></div>`;
  }
  const NS = { done: false };
  V.essences.after = function (el, args) {
    if (args[0] !== 'new') return;
    const d = S.cur.essences;
    const imp = () => {
      const host = el.querySelector('#nsHost').value || null;
      const C = (n, k) => { let r = 1; for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1); return r; };
      const total = extra => { let t = 0; for (const a of d.mains) for (const b of d.mains) { const sl = m => d.subs.filter(x => !x.host || x.host === m.code).length + (extra ? ((extra.host === null || extra.host === m.code) ? 1 : 0) : 0); const n = a === b ? sl(a) : sl(a) + sl(b); for (let k = 0; k <= 3; k++) t += C(n, k); } return t; };
      const before = total(null), after = total({ host });
      el.querySelector('#nsImpact').innerHTML = `Adds <b>${fmt(after - before)}</b> merges (${fmt(before)} → ${fmt(after)}), about ${(after / before * 3.3).toFixed(1)} MB of database instead of 3.3 MB.`;
    };
    el.querySelector('#nsHost').onchange = imp; imp();
    el.querySelector('#nsName').oninput = e => { const c = el.querySelector('#nsCode'); if (!c.dataset.touched) { const w = e.target.value.replace(/[^A-Za-z]/g, ''); c.value = w ? w[0].toUpperCase() + (w[1] || 'x').toLowerCase() : ''; } };
    el.querySelector('#nsCode').oninput = e => { e.target.dataset.touched = '1'; };
    el.querySelector('#nsGo').onclick = () => {
      const name = el.querySelector('#nsName').value.trim(), code = el.querySelector('#nsCode').value.trim(), host = el.querySelector('#nsHost').value || null;
      const clean = name.replace(/[^A-Za-z]/g, '');
      if (!clean) return App.toast('Give it a name (letters).', 'bad');
      if (!/^[A-Z][a-z]$/.test(code)) return App.toast('The code is two letters: a capital, then lowercase.', 'bad');
      if (d.subs.some(s => s.code === code) || d.mains.some(m => m.code === code)) return App.toast(`${code} is taken.`, 'bad');
      const word = clean[0].toUpperCase() + clean.slice(1).toLowerCase(), low = clean.toLowerCase();
      const like = d.subs.find(s => (s.host || null) === host) || d.subs[0];
      const item = {
        code, name: name.slice(0, 14), host, desc: `A new essence: ${name}.`, color: '#b0e05a', traits: { hex: 1, pow: 1 }, effect: like.effect, adjectives: [word],
      };
      if (!host) item.facets = Object.fromEntries(d.mains.map(m => [m.code, { name: (m.name + word).slice(0, 16), traits: {}, effect: like.effect }]));
      Object.assign(item, { passive: { name: (word + ' Skin').slice(0, 20), desc: window.ENGINE.MECHANICS.keen, mechanic: 'keen' }, traitLean: {}, nameSyllables: [low.slice(0, 4) || low, low.slice(0, 2) || low], organ: `a ${low} core`, sprite: 'core', lineWords: [word] });
      if (App.add('essences.subs', code, item)) App.go('essences/' + code);
    };
  };

  // ================================================================ combos
  V.combos = {
    render(args) {
      const tab = ['resonances', 'trinities', 'anomalies'].includes(args[0]) ? args[0] : 'resonances';
      const id = args[1];
      const d = S.cur.combos;
      const t = tabs('combos', [['resonances', `Resonances (${d.resonances.length})`], ['trinities', `Trinities (${d.trinities.length})`], ['anomalies', `Anomalies (${d.anomalies.length})`]], tab);
      let body;
      if (tab === 'anomalies') body = anomaliesView();
      else if (id) body = comboView(tab, id);
      else body = comboList(tab);
      return `<div class="page">${head('Combos', 'Two sub-essences that meet in one merge resonate; three specific ones form a Trinity; and a few merges are anomalies, glitches with their own effect. Each one reshapes every merge it applies to.')}${t}${body}</div>`;
    },
  };
  function affected(kind, subs) {
    if (!subs || !subs.length) return 0;
    return countWith(k => { const ss = subsOf(k); return subs.every(s => ss.includes(s)) && (kind !== 'trinities' || ss.length === 3); });
  }
  function comboList(kind) {
    const list = S.cur.combos[kind], st = App.stats();
    return `<div class="row spread"><p class="dim">${kind === 'resonances' ? 'Any merge with both subs, on any host, resonates.' : 'A merge with exactly these three subs is a Trinity (the rarest named merges).'}</p><button class="btn pri" id="addCombo" data-kind="${kind}">+ New ${kind === 'resonances' ? 'resonance' : 'trinity'}</button></div>
      <div class="tablewrap"><table class="t"><thead><tr><th>Name</th><th>Sub-essences</th><th>Effects</th><th class="num">Merges</th></tr></thead><tbody>${list.map(r => { const ch = App.isChanged(`combos.${kind}[${r.id}]`) || !SC.resolve(S.base, `combos.${kind}[${r.id}]`).found; const bad = App.issuesAt(`combos.${kind}[${r.id}]`).some(i => i.level === 'error'); return `<tr class="click" data-go="combos/${kind}/${esc(r.id)}"><td><b>${esc(r.name)}</b>${ch ? ' <span class="pill acc">changed</span>' : ''}${bad ? ' <span class="pill bad">problem</span>' : ''}</td><td>${r.subs.map(s => App.essChip(s)).join(' + ')}</td><td>${r.effects.map(f => esc(App.fxText([f.effect, f.chance, 0]))).join(', ') || '<span class="dim">none</span>'}</td><td class="num">${fmt(st.tags[r.name] || 0)}</td></tr>`; }).join('')}</tbody></table></div>`;
  }
  function freeSets(n) {
    const subs = S.cur.essences.subs, used = new Set(S.cur.combos.resonances.concat(S.cur.combos.trinities).map(r => r.subs.slice().sort().join('+')));
    const mains = S.cur.essences.mains.map(m => m.code);
    const canMeet = set => mains.some(a => mains.some(b => set.every(c => { const s = subs.find(x => x.code === c); return !s.host || s.host === a || s.host === b; })));
    const out = [], codes = subs.map(s => s.code);
    const rec = (start, cur) => { if (cur.length === n) { if (!used.has(cur.slice().sort().join('+')) && canMeet(cur)) out.push(cur.slice()); return; } for (let i = start; i < codes.length; i++) { cur.push(codes[i]); rec(i + 1, cur); cur.pop(); } };
    rec(0, []);
    return out;
  }
  function comboView(kind, id) {
    const list = S.cur.combos[kind], r = list.find(x => x.id === id);
    if (!r) return `<div class="empty">No ${kind === 'resonances' ? 'resonance' : 'trinity'} "${esc(id)}".</div>`;
    const P = `combos.${kind}[${id}]`;
    const isNew = !SC.resolve(S.base, P).found;
    const n = affected(kind, r.subs);
    const free = freeSets(kind === 'resonances' ? 2 : 3);
    const need = kind === 'resonances' ? 2 : 3;
    const sugg = r.subs.length < need ? free.filter(set => r.subs.every(s => set.includes(s))).slice(0, 24) : [];
    return `<div class="dhead"><a class="btn small" href="#combos/${kind}">← All ${kind}</a><div><h2>${esc(r.name)}</h2><div class="dim">${r.subs.length === need ? `${plural(n, 'merge')} have ${r.subs.map(App.essName).join(' and ')}` : `Pick ${need} sub-essences`}${isNew ? ' · new' : ''}</div></div></div>
      <div class="card"><div class="form">${F.field(P + '.name')}${F.field(P + '.id')}${F.field(P + '.subs')}
        ${sugg.length ? `<div class="fld"><span class="lab">Sets nobody uses yet</span><div class="chips">${sugg.map(set => `<button type="button" class="chip" data-useset="${esc(set.join(','))}" data-path="${esc(P + '.subs')}">${set.map(App.essName).join(' + ')}</button>`).join('')}</div><span class="help">${fmt(free.length)} free ${need === 2 ? 'pairs' : 'sets of three'} in all.</span></div>` : ''}
        ${F.field(P + '.effects')}${F.field(P + '.traits')}</div></div>
      <div class="row"><button class="btn danger" data-del-combo="${esc(P)}" data-kind="${kind}">Delete ${esc(r.name)}</button></div>`;
  }
  function anomaliesView() {
    const st = App.stats();
    return `<p class="dim">About one merge in 55 is an anomaly; which kind comes from its key. The kinds are battle code; their text and numbers are yours. A new kind needs code, so ask Claude Code on the Claude Code page.</p>
      <div class="cards">${S.cur.combos.anomalies.map(a => `<div class="card"><h3>∆${esc(a.id)} <span class="dim" style="font-weight:400;font-size:13px">${plural(st.anomalies[a.id] || 0, 'merge')}</span></h3><div class="form">${F.field(`combos.anomalies[${a.id}].desc`)}${F.field(`combos.anomalies[${a.id}].magnitude`)}</div></div>`).join('')}</div>`;
  }
  document.addEventListener('click', async e => {
    const add = e.target.closest('#addCombo');
    if (add) {
      const kind = add.dataset.kind, one = kind === 'resonances' ? 'resonance' : 'trinity';
      const card = App.modal(`<h2>New ${one}</h2><label class="fld"><span class="lab">Name</span><input type="text" id="comboName" maxlength="18" placeholder="${kind === 'resonances' ? 'e.g. Whiteout' : 'e.g. Tidal Engine'}"></label><p class="dim">Next you pick its ${kind === 'resonances' ? 'two' : 'three'} sub-essences, effects and pushes.</p><div class="row"><button class="btn pri" id="comboGo">Create</button><button class="btn" data-close>Cancel</button></div>`);
      const go = () => {
        const name = card.querySelector('#comboName').value.trim();
        if (!name) return App.toast('Give it a name.', 'bad');
        const list = S.cur.combos[kind], id = idFrom(name, list.map(x => x.id));
        App.closeModal();
        if (App.add('combos.' + kind, id, { id, name, subs: [], traits: {}, effects: [] })) App.go(`combos/${kind}/${id}`);
      };
      card.querySelector('#comboGo').onclick = go;
      card.querySelector('#comboName').onkeydown = e2 => { if (e2.key === 'Enter') go(); };
      return;
    }
    const use = e.target.closest('[data-useset]');
    if (use) { App.set(use.dataset.path, use.dataset.useset.split(',')); return; }
    const del = e.target.closest('[data-del-combo]');
    if (del && await App.confirm('Delete this combo?', 'Every merge with these sub-essences loses it and is baked again without it.', 'Delete', true)) { App.remove(del.dataset.delCombo); App.go('combos/' + del.dataset.kind); }
  });

  // ================================================================ battle
  V.battle = {
    bakeAware: true,
    render(args) {
      const tab = ['classes', 'effects', 'statuses', 'residue', 'combo'].includes(args[0]) ? args[0] : 'classes';
      const t = tabs('battle', [['classes', 'Classes'], ['effects', 'Effects'], ['statuses', 'Statuses'], ['residue', 'Residue reactions'], ['combo', 'Combo']], tab);
      const st = App.stats();
      let body = '';
      if (tab === 'classes') body = S.cur.battle.classes.filter(c => !args[1] || c.id === args[1]).map(c => { const P = `battle.classes[${c.id}]`; const u = App.wordUsage(c.nouns, 'name', 'end'); return `<div class="card" id="cls-${esc(c.id)}"><h3>${esc(c.icon)} ${esc(c.id)} <span class="dim" style="font-weight:400;font-size:13px">${plural(st.cls[c.id] || 0, 'spell')}${st.numbered[c.id] ? ` · ${st.numbered[c.id]} numbered names` : ''}</span></h3><div class="form">${F.field(P + '.desc')}${F.field(P + '.signature')}${F.field(P + '.icon')}${F.field(P + '.nouns', { usage: u, help: 'The number on each word is how many spells end with it. ' + SC.SCHEMA.fields.battle.fields.classes.item.fields.nouns.help })}</div></div>`; }).join('') + (args[1] ? `<a class="btn small" href="#battle/classes">All classes</a>` : '');
      if (tab === 'effects') body = `<p class="dim">Effect names as battle and the Codex show them. What each effect does is battle code; add one to an essence or combo to use it.</p><div class="tablewrap"><table class="t"><thead><tr><th>Code</th><th>Name</th><th>Flash color</th><th class="num">Merges</th></tr></thead><tbody>${S.cur.battle.effects.map(f => { const P = `battle.effects[${f.code}]`; return `<tr><td><span class="key">${esc(f.code)}</span></td><td style="min-width:160px">${F.widget(F.node(P + '.name'), f.name, P + '.name', false, {})}</td><td>${f.color ? F.widget(F.node(P + '.color'), f.color, P + '.color', false, {}) : '<span class="dim">—</span>'}</td><td class="num">${st.fx[f.code] ? fmt(st.fx[f.code]) : '<span class="pill warn">unused</span>'}</td></tr>`; }).join('')}</tbody></table></div>`;
      if (tab === 'statuses') body = `<div class="cards">${S.cur.battle.statuses.map(s => { const P = `battle.statuses[${s.id}]`; return `<div class="card"><h3>${esc(s.icon)} ${esc(s.name)}</h3><div class="form">${F.field(P + '.name')}<div class="grid g2">${F.field(P + '.turns')}${F.field(P + '.immune')}</div><div class="grid g2">${F.field(P + '.icon')}${F.field(P + '.color')}</div>${F.field(P + '.text')}</div></div>`; }).join('')}</div>`;
      if (tab === 'residue') {
        const mains = S.cur.essences.mains, res = S.cur.battle.residue;
        body = `<p class="dim">A merge leaves residue of its lead essence. When a merge lands in an arena with 2 or more residue of another essence, the reaction for that pair fires. Empty squares have no reaction yet.</p>
          <div class="grid16"><div class="h"><span class="dim">Lead ↓ · into →</span></div>${mains.map(m => `<div class="h">${App.essChip(m.code)}</div>`).join('')}
          ${mains.map(a => `<div class="h">${App.essChip(a.code)}</div>` + mains.map(b => { const r = res.find(x => x.cast === a.code && x.into === b.code); const ch = r && (App.isChanged(`battle.residue[${a.code}>${b.code}]`) || !SC.resolve(S.base, `battle.residue[${a.code}>${b.code}]`).found); return `<button class="cell" data-cell="${a.code}>${b.code}" style="background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:8px">${r ? `<b>${esc(r.name)}</b>${ch ? ' <span class="pill acc">changed</span>' : ''}<div class="dim">${esc(r.kind)}</div>` : '<span class="dim">+ add</span>'}</button>`; }).join('')).join('')}</div>`;
      }
      if (tab === 'combo') body = `<div class="card">${F.field('battle.combo')}</div>`;
      return `<div class="page">${head('Battle', 'Classes, effect names, statuses and residue reactions. What they do in battle is the engine\'s code; their names, text and numbers are here.')}${t}${body}</div>`;
    },
  };
  document.addEventListener('click', e => {
    const c = e.target.closest('[data-cell]');
    if (!c) return;
    const [cast, into] = c.dataset.cell.split('>'), P = `battle.residue[${cast}>${into}]`, r = S.cur.battle.residue.find(x => x.cast === cast && x.into === into);
    const kinds = window.ENGINE.REACTION_KINDS;
    const card = App.modal(`<h2>${esc(App.essName(cast))} merge into ${esc(App.essName(into))} residue</h2>
      <label class="fld"><span class="lab">Name</span><input type="text" id="rxName" value="${esc(r ? r.name : '')}" maxlength="16" placeholder="e.g. Flashover"></label>
      <label class="fld"><span class="lab">Effect</span><select id="rxKind">${Object.entries(kinds).map(([k, d]) => `<option value="${k}"${r && r.kind === k ? ' selected' : ''}>${esc(k)}: ${esc(d)}</option>`).join('')}</select></label>
      <div class="row"><button class="btn pri" id="rxSave">${r ? 'Save' : 'Add reaction'}</button>${r ? '<button class="btn danger" id="rxDel">Remove</button>' : ''}<button class="btn" data-close>Cancel</button></div>`);
    card.querySelector('#rxSave').onclick = () => {
      const name = card.querySelector('#rxName').value.trim(), kind = card.querySelector('#rxKind').value;
      if (!name) return App.toast('Give the reaction a name.', 'bad');
      App.closeModal();
      if (r) App.set(P, { cast, into, name, kind }); else App.add('battle.residue', cast + '>' + into, { cast, into, name, kind });
    };
    const del = card.querySelector('#rxDel'); if (del) del.onclick = () => { App.closeModal(); App.remove(P); };
  });

  // ================================================================ traits
  V.traits = {
    bakeAware: true,
    render(args) {
      const tab = args[0] === 'leanings' || args[0] === 'lineage' ? args[0] : 'list';
      const code = tab === 'list' ? args[0] : null;
      const t = tabs('traits', [['list', 'Traits'], ['leanings', 'Leanings'], ['lineage', 'Lineages']], code ? 'list' : tab);
      const st = App.stats();
      let body = '';
      if (tab === 'leanings') body = `<p class="dim">Each genome leans toward four traits: the axes of its merge (below) and its essences (on each essence's page) add up. A daemon's trait is picked from its genome's leanings by its seed.</p><div class="cards">${SC.AXES.map(a => `<div class="card"><h3>${esc(SC.AXIS[a][0])}</h3><p class="sub">${esc(SC.AXIS[a][1])}</p>${F.field('traits.axisLean.' + a, { node: { t: 'lean', label: ' ', min: 0, max: 5 } })}</div>`).join('')}</div>`;
      else if (tab === 'lineage') body = `<div class="card"><div class="form">${F.field('traits.lineage.nouns')}${F.field('traits.lineage.statWords')}</div></div><p class="dim">Lineage words (the Cinder Line) belong to each essence: see Words and names.</p>`;
      else if (code) {
        const tr = S.cur.traits.traits.find(x => x.code === code);
        if (!tr) body = `<div class="empty">No trait "${esc(code)}".</div>`;
        else {
          const P = `traits.traits[${code}]`;
          const preview = v => SC.TIERS.map((n, i) => `${n}: ${String(v || '').replace(/\{m\}/g, tr.magnitude[i]).replace(/\{cd\}/g, tr.cooldown || '')}`).join(' · ');
          body = `<div class="dhead"><a class="btn small" href="#traits">← Traits</a><div><h2>${esc(tr.nouns[0])} <span class="dim" style="font-size:15px">(${esc(code)}, ${esc(tr.category)})</span></h2><div class="dim">The strongest leaning of ${plural(st.leadTrait[code] || 0, 'genome')}.</div></div></div>
            <div class="card"><div class="form">${F.field(P + '.nouns')}${F.field(P + '.epithet')}${F.field(P + '.does')}${F.field(P + '.effect', { preview })}${F.field(P + '.magnitude')}${tr.cap != null ? F.field(P + '.cap') : ''}${tr.cooldown != null ? F.field(P + '.cooldown') : ''}</div></div>`;
        }
      } else {
        const groups = [['utility', 'Utility: help on the road'], ['passive', 'Passive: a stat bonus in battle'], ['active', 'Active: used from the menu']];
        body = groups.map(([g, label]) => `<div class="card"><h3>${esc(label)}</h3><div class="cards">${S.cur.traits.traits.filter(x => x.category === g).map(x => `<button class="ecard" data-go="traits/${x.code}">${App.isChanged(`traits.traits[${x.code}]`) ? '<span class="chg"></span>' : ''}<div class="nm">${esc(x.nouns.join(' / '))}</div><div class="d">${esc(x.code)} · ${esc(x.does)}</div><div class="d">leads ${plural(st.leadTrait[x.code] || 0, 'genome')}</div></button>`).join('')}</div></div>`).join('');
      }
      return `<div class="page">${head('Traits', 'Every daemon has its own trait, picked by its seed from what its genome leans toward. What a trait does is game code; its names, text and strength are here.')}${t}${body}</div>`;
    },
  };

  // ================================================================ words and names
  V.words = {
    bakeAware: true,
    render(args) {
      const tab = ['nouns', 'names', 'forms', 'items', 'templates'].includes(args[0]) ? args[0] : 'nouns';
      const t = tabs('words', [['nouns', 'Spell nouns'], ['names', 'Daemon and lineage names'], ['forms', 'Form descriptions'], ['items', 'Items'], ['templates', 'Spell text']], tab);
      const st = App.stats(), d = S.cur;
      let body = '';
      if (tab === 'nouns') body = `<p class="dim">Spell names end with a noun from the spell's class. When a pair of essences runs out of nouns, names repeat with a numeral: ${fmt(st.numberedAll)} spells have one now.</p>` + d.battle.classes.map(c => { const u = App.wordUsage(c.nouns, 'name', 'end'); return `<div class="card"><h3>${esc(c.icon + ' ' + c.id)} <span class="dim" style="font-weight:400;font-size:13px">${plural(st.cls[c.id] || 0, 'spell')}${st.numbered[c.id] ? `, ${st.numbered[c.id]} numbered` : ''}</span></h3>${F.field(`battle.classes[${c.id}].nouns`, { label: ' ', help: 'The number on each word is how many spells end with it.', usage: u })}</div>`; }).join('');
      if (tab === 'names') body = `<p class="dim">A daemon's name is a root from its lead main, then a middle (the second main, or its sub-essences' syllables), then an ending by how many subs it has. ${st.fallback ? `${plural(st.fallback, 'daemon')} ran out of combinations and got a number.` : 'Every daemon has a unique name.'}</p>
        <div class="card"><h3>By main essence</h3><div class="grid g2">${d.essences.mains.map(m => `<div class="stack"><h4>${App.essChip(m.code)}</h4>${F.field(`essences.mains[${m.code}].nameRoots`)}${F.field(`essences.mains[${m.code}].nameMids`)}${F.field(`essences.mains[${m.code}].lineWords`)}</div>`).join('')}</div></div>
        <div class="card"><h3>By sub-essence</h3><div class="grid g2">${d.essences.subs.map(s => `<div class="stack"><h4>${App.essChip(s.code)}</h4>${F.field(`essences.subs[${s.code}].nameSyllables`, { help: 'long, then short' })}${F.field(`essences.subs[${s.code}].lineWords`, { help: '' })}</div>`).join('')}</div></div>
        <div class="card"><h3>Name endings</h3>${F.field('words.daemonSuffixes', { label: ' ' })}</div>
        <div class="card"><h3>Lineage nouns</h3>${F.field('traits.lineage.nouns', { label: ' ' })}</div>`;
      if (tab === 'forms') body = `<p class="dim">A form description is a body line from the lead main, then "with" the second main's belly and each sub's organ, then a temperament from the strongest trait axis. ${fmt(st.descs.size)} different descriptions for ${fmt(st.total)} daemons.</p>
        <div class="card"><h3>Bodies and bellies</h3><div class="grid g2">${d.essences.mains.map(m => `<div class="stack"><h4>${App.essChip(m.code)}</h4>${F.field(`essences.mains[${m.code}].bodies`)}${F.field(`essences.mains[${m.code}].belly`)}</div>`).join('')}</div></div>
        <div class="card"><h3>Organs</h3><div class="grid g2">${d.essences.subs.map(s => F.field(`essences.subs[${s.code}].organ`, { label: s.name, help: '' })).join('')}</div></div>
        <div class="card"><h3>Temperaments</h3>${F.field('words.temperaments', { label: ' ' })}</div>`;
      if (tab === 'items') {
        const sample = { from: 'Fire and Water motes', lead: 'Fire', second: 'Water', subs: 'Ember or Light' };
        const fill = v => String(v || '').replace(/\{(\w+)\}/g, (m, k) => sample[k] || m);
        body = `<p class="dim">An item's name is a quality prefix, then the spell's first words, then the kind's name: "Tempered Kindled Scald Script". ${fmt(st.items.size)} different item names in all.</p>
          <div class="card"><h3>Quality prefixes</h3>${F.field('items.qualityPrefixes', { label: ' ' })}</div>
          ${d.items.kinds.map(k => { const P = `items.kinds[${k.kind}]`; return `<div class="card"><h3>${esc(k.name)} <span class="dim" style="font-weight:400;font-size:13px">${esc(k.kind)}</span></h3><div class="form"><div class="grid g2">${F.field(P + '.name')}${F.field(P + '.desc')}</div>${F.field(P + '.lore', { preview: fill })}</div></div>`; }).join('')}`;
      }
      if (tab === 'templates') {
        const sample = { sub: 'Ember', host: 'Fire', role: 'lead', facet: 'Prismatic', subs: 'Spark and Tide', name: 'Conduction', desc: 'Reflects half of the next hit back at the attacker.' };
        const fill = v => String(v || '').replace(/\{(\w+)\}/g, (m, k) => sample[k] || m);
        body = `<p class="dim">Spell text is built from these sentences, one per sub-essence and combo in the merge.</p><div class="card"><div class="form">${Object.keys(d.words.templates).map(k => F.field('words.templates.' + k, { preview: fill })).join('')}</div></div>`;
      }
      return `<div class="page">${head('Words and names', 'Every name and sentence the baker writes comes from these lists. Adding words gives more variety; each list shows how busy it is.')}${t}${body}</div>`;
    },
  };

  // ================================================================ world
  const TCOL = { '#': '#27304a', '.': '#3b4768', ',': '#2c7d6b', '~': '#1f5f99', '^': '#b4522a', o: '#6b5a45', '*': '#2f6b3a', x: '#6a3fbf', H: '#5dff9a', F: '#ffb13d', R: '#b48cff', '2': '#ffd23d', '3': '#ffd23d', '4': '#ffd23d', '5': '#ffd23d' };
  const W_ = { room: null, brush: '.', placing: null };
  V.world = {
    render(args) {
      const tab = ['map', 'zones', 'trainers', 'people', 'starters', 'lines'].includes(args[0]) ? args[0] : 'map';
      const t = tabs('world', [['map', 'Map'], ['zones', 'Zones'], ['trainers', 'Trainers'], ['people', 'People'], ['starters', 'Starters'], ['lines', 'Game lines']], tab);
      let body = '';
      if (tab === 'map') body = mapView(args[1]);
      if (tab === 'zones') body = args[1] ? zoneView(args[1]) : zoneList();
      if (tab === 'trainers') body = args[1] ? trainerView(args[1]) : trainerList();
      if (tab === 'people') body = args[1] ? personView(args[1]) : personList();
      if (tab === 'starters') body = args[1] ? starterView(args[1]) : starterList();
      if (tab === 'lines') body = `<div class="card">${F.field('world.text.tutorial')}</div>`;
      return `<div class="page">${head('World', 'The map, its zones and wild daemons, the trainers and people in it, and the starters you pick from.')}${t}${body}</div>`;
    },
    after(el, args) {
      if ((args[0] || 'map') === 'map') drawMaps(el);
      if (args[0] === 'people' && args[1]) drawMaps(el);
    },
  };
  // --- map and rooms
  function mapView(zone) {
    const rooms = S.cur.world.rooms;
    if (zone && rooms.find(r => r.zone === zone)) W_.room = zone;
    const room = rooms.find(r => r.zone === W_.room);
    const trainers = room ? S.cur.world.trainers.filter(x => x.zone === room.zone) : [];
    const letters = trainers.map(x => x.slot);
    const free = 'defghijklmnpqrstuvwyz'.split('').find(c => !(room && room.rows.join('').includes(c)) && !letters.includes(c));
    return `<p class="dim">Tap a room to edit it. Trainers stand on their slot letter; people stand where their row and column say.${W_.placing ? ' <b>Tap the map where the person should stand.</b>' : ''}</p>
      <div class="mapwrap"><canvas id="worldMap" data-kind="world"></canvas></div>
      ${room ? `<div class="card"><div class="row spread"><h3>${esc((S.cur.world.zones.find(z => z.id === room.zone) || { name: room.zone }).name)} room</h3><span class="dim">${room.rows[0].length} × ${room.rows.length} tiles at ${room.x},${room.y}</span></div>
        <div class="palette" style="margin:8px 0">${Object.entries(SC.TILES).map(([ch, [label]]) => `<button class="tilebtn${W_.brush === ch ? ' on' : ''}" data-brush="${esc(ch)}" title="${esc(label)}"><span class="tv" style="background:${TCOL[ch]}">${ch === '.' || ch === '#' ? '' : esc(ch)}</span>${esc(label.split(' (')[0])}</button>`).join('')}
        ${trainers.map(x => `<button class="tilebtn${W_.brush === x.slot ? ' on' : ''}" data-brush="${esc(x.slot)}"><span class="tv" style="background:#ff5470">${esc(x.slot)}</span>${esc(x.name)}</button>`).join('')}</div>
        <div class="mapwrap" style="background:var(--sunk)"><canvas id="roomMap" data-kind="room"></canvas></div>
        <div class="row" style="margin-top:8px"><span class="dim">Paint by tapping or dragging. A trainer's letter moves them.</span>${free ? `<button class="btn small" data-new-trainer="${esc(room.zone)}" data-slot="${free}">+ New trainer in this room</button>` : ''}</div>
        <span class="err" data-err="world.rooms[${esc(room.zone)}].rows"></span></div>` : ''}`;
  }
  function drawMaps(el) {
    const m = App.mods(); if (!m.C) return;
    let map; try { map = m.C.buildMap(); } catch (e) { const c = el.querySelector('#worldMap'); if (c) c.insertAdjacentHTML('afterend', `<div class="note bad">${esc(e.message)}</div>`); return; }
    const wm = el.querySelector('#worldMap');
    if (wm) {
      const u = Math.max(6, Math.min(14, Math.floor((el.querySelector('.mapwrap').clientWidth - 4) / map.w)));
      wm.width = map.w * u; wm.height = map.h * u;
      const g = wm.getContext('2d');
      for (let y = 0; y < map.h; y++) for (let x = 0; x < map.w; x++) { const ch = map.tiles[y][x]; g.fillStyle = TCOL[ch] || '#3b4768'; g.fillRect(x * u, y * u, u, u); }
      g.strokeStyle = 'rgba(255,255,255,.08)';
      for (const r of S.cur.world.rooms) { g.lineWidth = r.zone === W_.room ? 3 : 1; g.strokeStyle = r.zone === W_.room ? '#46f3ff' : 'rgba(255,255,255,.25)'; g.strokeRect(r.x * u + .5, r.y * u + .5, r.rows[0].length * u - 1, r.rows.length * u - 1); }
      for (const n of map.npcs) { g.fillStyle = n.kind === 'folk' ? '#46f3ff' : n.kind === 'warden' ? '#ffd23d' : '#ff5470'; g.beginPath(); g.arc(n.x * u + u / 2, n.y * u + u / 2, u * 0.42, 0, 7); g.fill(); }
      g.fillStyle = '#fff'; g.fillRect(map.spawn.x * u + u * .3, map.spawn.y * u + u * .3, u * .4, u * .4);
      wm.onclick = e => {
        const b = wm.getBoundingClientRect(), x = Math.floor((e.clientX - b.left) / b.width * map.w), y = Math.floor((e.clientY - b.top) / b.height * map.h);
        if (W_.placing) { const id = W_.placing; W_.placing = null; App.batch([{ op: 'set', path: `world.npcs[${id}].x`, value: x }, { op: 'set', path: `world.npcs[${id}].y`, value: y }]); return; }
        const z = map.zone[y] && map.zone[y][x];
        if (z && S.cur.world.rooms.find(r => r.zone === z)) { W_.room = z; App.go('world/map/' + z); }
      };
    }
    const rm = el.querySelector('#roomMap');
    const room = S.cur.world.rooms.find(r => r.zone === W_.room);
    if (rm && room) {
      const rows = room.rows.map(r => r.split('')), u = Math.max(14, Math.min(30, Math.floor((el.querySelector('#roomMap').parentElement.clientWidth - 4) / rows[0].length)));
      rm.width = rows[0].length * u; rm.height = rows.length * u;
      const g = rm.getContext('2d');
      const paint = () => {
        for (let y = 0; y < rows.length; y++) for (let x = 0; x < rows[0].length; x++) {
          const ch = rows[y][x], slot = SC.isSlotChar(ch);
          g.fillStyle = slot ? TCOL['.'] : (TCOL[ch] || '#3b4768'); g.fillRect(x * u, y * u, u, u);
          g.strokeStyle = 'rgba(0,0,0,.25)'; g.strokeRect(x * u + .5, y * u + .5, u - 1, u - 1);
          if (slot) { g.fillStyle = '#ff5470'; g.beginPath(); g.arc(x * u + u / 2, y * u + u / 2, u * .4, 0, 7); g.fill(); g.fillStyle = '#fff'; g.font = `bold ${Math.round(u * .5)}px ui-monospace, monospace`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(ch, x * u + u / 2, y * u + u / 2 + 1); }
          else if (ch !== '.' && ch !== '#' && ch !== ',') { g.fillStyle = 'rgba(255,255,255,.85)'; g.font = `bold ${Math.round(u * .45)}px ui-monospace, monospace`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(ch, x * u + u / 2, y * u + u / 2 + 1); }
        }
      };
      paint();
      let down = false, dirty = false;
      const at = e => { const b = rm.getBoundingClientRect(); return [Math.floor((e.clientX - b.left) / b.width * rows[0].length), Math.floor((e.clientY - b.top) / b.height * rows.length)]; };
      const put = e => {
        const [x, y] = at(e); if (x < 0 || y < 0 || y >= rows.length || x >= rows[0].length) return;
        const brush = W_.brush;
        if (rows[y][x] === brush) return;
        if (SC.isSlotChar(brush)) for (const r of rows) for (let i = 0; i < r.length; i++) if (r[i] === brush) r[i] = '.'; // a trainer stands in one place
        rows[y][x] = brush; dirty = true; paint();
      };
      rm.onpointerdown = e => { down = true; rm.setPointerCapture(e.pointerId); put(e); };
      rm.onpointermove = e => { if (down) put(e); };
      rm.onpointerup = rm.onpointercancel = () => { down = false; if (dirty) { dirty = false; App.set(`world.rooms[${room.zone}].rows`, rows.map(r => r.join(''))); } };
    }
  }
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-brush]');
    if (b) { W_.brush = b.dataset.brush; document.querySelectorAll('[data-brush]').forEach(x => x.classList.toggle('on', x === b)); return; }
    const nt = e.target.closest('[data-new-trainer]');
    if (nt) {
      const zone = nt.dataset.newTrainer, slot = nt.dataset.slot, ids = S.cur.world.trainers.map(x => x.id);
      const id = idFrom(zone + '-' + slot, ids);
      const room = S.cur.world.rooms.find(r => r.zone === zone);
      // stand them on the first open floor tile
      const rows = room.rows.map(r => r.split(''));
      let placed = false;
      for (let y = 1; y < rows.length - 1 && !placed; y++) for (let x = 1; x < rows[0].length - 1 && !placed; x++) if (rows[y][x] === '.' && rows[y - 1][x] === '.' && rows[y + 1][x] === '.') { rows[y][x] = slot; placed = true; }
      const z = S.cur.world.zones.find(q => q.id === zone), key = z && z.wild[0] ? z.wild[0].key : S.cur.world.starters[0].key;
      const trainer = { id, zone, slot, name: 'Operator New', facing: 'down', sight: 3, team: [{ key, level: z && z.wild[0] ? z.wild[0].max + 1 : 5 }], intro: 'Let\'s see what your daemons can do.', outro: 'Well fought.' };
      if (App.batch([{ op: 'add', path: `world.trainers[${id}]`, value: trainer }, { op: 'set', path: `world.rooms[${zone}].rows`, value: rows.map(r => r.join('')) }])) App.go('world/trainers/' + id);
    }
  });
  // --- zones
  function zoneList() {
    return `<div class="cards">${S.cur.world.zones.map(z => `<button class="ecard" data-go="world/zones/${z.id}">${App.isChanged(`world.zones[${z.id}]`) ? '<span class="chg"></span>' : ''}<div class="nm">${esc(z.name)}</div><div class="d">${z.element ? App.essChip(z.element) + ' · ' : ''}${plural(z.wild.length, 'wild daemon')} · levels ${Math.min(...z.wild.map(w => w.min))}-${Math.max(...z.wild.map(w => w.max))}</div><div class="row tight">${z.wild.slice(0, 8).map(w => App.sprite(w.key, 32)).join('')}</div></button>`).join('')}</div><p class="dim" style="margin-top:8px">A new zone needs map space and a gate: ask Claude Code.</p>`;
  }
  function zoneView(id) {
    const z = S.cur.world.zones.find(x => x.id === id);
    if (!z) return `<div class="empty">No zone "${esc(id)}".</div>`;
    const P = `world.zones[${id}]`, tot = z.wild.reduce((a, w) => a + w.weight, 0);
    return `<div class="dhead"><a class="btn small" href="#world/zones">← Zones</a><h2>${esc(z.name)}</h2><button class="btn small" data-go="world/map/${esc(id)}">Show on the map</button></div>
      <div class="card"><div class="grid g2">${F.field(P + '.name')}${F.field(P + '.element')}</div></div>
      <div class="card"><h3>Wild daemons</h3><p class="sub">Walking in static here meets one of these. 7% of wild daemons show up as rogue builds with an extra sub-essence.</p>
        <div class="tablewrap"><table class="t"><thead><tr><th>Genome</th><th>Lowest</th><th>Highest</th><th>How common</th><th></th></tr></thead><tbody>${z.wild.map((w, i) => { const WP = `${P}.wild[${w.key}]`; return `<tr><td>${F.widget(F.node(WP + '.key') || { t: 'mergeKey' }, w.key, WP + '.key', false, {})}</td><td style="width:90px">${F.widget({ t: 'int', min: 1, max: 60 }, w.min, WP + '.min', false, {})}</td><td style="width:90px">${F.widget({ t: 'int', min: 1, max: 60 }, w.max, WP + '.max', false, {})}</td><td style="width:120px">${F.widget({ t: 'int', min: 1, max: 20 }, w.weight, WP + '.weight', false, {})}<div class="dim" style="font-size:11px">${Math.round(w.weight / tot * 100)}%</div></td><td><button class="btn small ghost" data-del-wild="${esc(WP)}" aria-label="Remove">✕</button></td></tr>`; }).join('')}</tbody></table></div>
        <div class="row" style="margin-top:8px"><button class="btn" data-add-wild="${esc(id)}">+ Add a wild daemon</button></div><span class="err" data-err="${esc(P)}.wild"></span></div>`;
  }
  document.addEventListener('click', e => {
    const d = e.target.closest('[data-del-wild]'); if (d) { App.remove(d.dataset.delWild); return; }
    const a = e.target.closest('[data-add-wild]');
    if (a) {
      const z = S.cur.world.zones.find(x => x.id === a.dataset.addWild);
      App.pickKey(z.wild[0] && z.wild[0].key, key => { if (z.wild.some(w => w.key === key)) return App.toast('That genome is already in this zone.', 'bad'); const last = z.wild[z.wild.length - 1] || { min: 5, max: 8 }; App.add(`world.zones[${z.id}].wild`, key, { key, min: last.min, max: last.max, weight: 1 }); });
    }
  });
  // --- trainers
  function trainerList() {
    const rooms = S.cur.world.rooms.map(r => r.zone);
    return rooms.map(z => { const list = S.cur.world.trainers.filter(t => t.zone === z); const zone = S.cur.world.zones.find(x => x.id === z); return `<div class="card"><div class="row spread"><h3>${esc(zone ? zone.name : z === 'core' ? 'The Core' : z)}</h3><button class="btn small" data-go="world/map/${esc(z)}">Room</button></div><div class="cards">${list.map(t => `<button class="ecard" data-go="world/trainers/${esc(t.id)}">${App.isChanged(`world.trainers[${t.id}]`) || !SC.resolve(S.base, `world.trainers[${t.id}]`).found ? '<span class="chg"></span>' : ''}<div class="nm">${esc(t.name)}</div><div class="d">${t.final ? 'Final boss' : t.warden ? 'Warden' : 'Operator'} · slot ${esc(t.slot)} · ${plural(t.team.length, 'daemon')}</div><div class="row tight">${t.team.map(m => App.sprite(m.key, 32)).join('')}</div></button>`).join('') || '<span class="dim">No trainers.</span>'}</div></div>`; }).join('');
  }
  function trainerView(id) {
    const t = S.cur.world.trainers.find(x => x.id === id);
    if (!t) return `<div class="empty">No trainer "${esc(id)}".</div>`;
    const P = `world.trainers[${id}]`, f = n => F.field(P + '.' + n);
    const f2 = n => F.field(P + '.' + n, n === 'id' ? { readonly: true } : undefined);
    return `<div class="dhead"><a class="btn small" href="#world/trainers">← Trainers</a><div><h2>${esc(t.name)}</h2><div class="dim">${t.final ? 'Final boss' : t.warden ? 'Warden' : 'Operator'} in the ${esc(t.zone)} room, slot ${esc(t.slot)}</div></div><button class="btn small" data-go="world/map/${esc(t.zone)}">Place on the map</button></div>
      <div class="grid g2"><div class="card"><div class="form">${f('name')}${f2('id')}<div class="grid g2">${f('zone')}${f('slot')}</div><div class="grid g2">${f('facing')}${f('sight')}</div><div class="grid g2">${f('warden')}${f('final')}</div>${f('badge')}</div></div>
      <div class="card"><h3>Team</h3>${teamEditor(P + '.team', t.team)}</div></div>
      <div class="card"><div class="form">${f('intro')}${f('outro')}</div></div>
      <div class="row"><button class="btn danger" data-del-trainer="${esc(id)}">Remove ${esc(t.name)}</button></div>`;
  }
  function teamEditor(path, team) {
    return `<div class="stack" data-team="${esc(path)}">${team.map((m, i) => `<div class="row" style="flex-wrap:nowrap">${App.sprite(m.key, 32)}<div style="min-width:0;flex:1"><div class="t">${esc((App.rec(m.key) || { dName: m.key }).dName)}</div><span class="key">${esc(m.key)}</span></div><label class="dim" style="font-size:12px">Lv <input type="number" min="1" max="60" value="${m.level}" data-team-level="${i}" style="width:70px"></label><button class="btn small" data-team-pick="${i}">Change</button><button class="btn small ghost" data-team-del="${i}" aria-label="Remove">✕</button></div>`).join('')}
      ${team.length < 6 ? '<div><button class="btn small" data-team-add>+ Add a daemon</button></div>' : ''}<span class="err" data-err="${esc(path)}"></span></div>`;
  }
  document.addEventListener('click', async e => {
    const host = e.target.closest('[data-team]');
    if (host) {
      const path = host.dataset.team, team = SC.clone(App.get(path));
      const pick = e.target.closest('[data-team-pick]'), del = e.target.closest('[data-team-del]'), add = e.target.closest('[data-team-add]');
      if (pick) App.pickKey(team[+pick.dataset.teamPick].key, key => { team[+pick.dataset.teamPick].key = key; App.set(path, team); });
      if (del) { team.splice(+del.dataset.teamDel, 1); App.set(path, team); }
      if (add) App.pickKey(team[team.length - 1] && team[team.length - 1].key, key => { team.push({ key, level: team.length ? team[team.length - 1].level : 5 }); App.set(path, team); });
      return;
    }
    const dt = e.target.closest('[data-del-trainer]');
    if (dt) {
      const t = S.cur.world.trainers.find(x => x.id === dt.dataset.delTrainer);
      if (!(await App.confirm(`Remove ${t.name}?`, 'Their slot in the room becomes floor again.', 'Remove', true))) return;
      const room = S.cur.world.rooms.find(r => r.zone === t.zone);
      const ops = [{ op: 'remove', path: `world.trainers[${t.id}]` }];
      if (room) ops.push({ op: 'set', path: `world.rooms[${room.zone}].rows`, value: room.rows.map(r => r.split(t.slot).join('.')) });
      if (App.batch(ops)) App.go('world/trainers');
    }
  });
  document.addEventListener('change', e => {
    const lv = e.target.closest('[data-team-level]');
    if (!lv) return;
    const host = lv.closest('[data-team]'), team = SC.clone(App.get(host.dataset.team));
    team[+lv.dataset.teamLevel].level = Math.max(1, Math.min(60, Math.round(Number(lv.value) || 1)));
    App.set(host.dataset.team, team);
  });
  // --- people
  function personList() {
    return `<div class="row spread"><p class="dim">People stand in the world and say their lines when you talk to them.</p><button class="btn pri" id="addPerson">+ New person</button></div>
      <div class="cards">${S.cur.world.npcs.map(n => `<button class="ecard" data-go="world/people/${esc(n.id)}">${App.isChanged(`world.npcs[${n.id}]`) || !SC.resolve(S.base, `world.npcs[${n.id}]`).found ? '<span class="chg"></span>' : ''}<div class="nm">${esc(n.name)}</div><div class="d">at ${n.x},${n.y} · ${plural(n.lines.length, 'line')}</div><div class="d">${esc(n.lines[0] || '')}</div></button>`).join('')}</div>`;
  }
  function personView(id) {
    const n = S.cur.world.npcs.find(x => x.id === id);
    if (!n) return `<div class="empty">No person "${esc(id)}".</div>`;
    const P = `world.npcs[${id}]`, f = k => F.field(P + '.' + k);
    return `<div class="dhead"><a class="btn small" href="#world/people">← People</a><h2>${esc(n.name)}</h2></div>
      <div class="grid g2"><div class="card"><div class="form">${f('name')}${F.field(P + '.id', { readonly: true })}<div class="grid g3">${f('x')}${f('y')}${f('facing')}</div><div><button class="btn" data-place="${esc(id)}">${W_.placing === id ? 'Tap the map…' : 'Place on the map'}</button></div></div></div>
      <div class="card"><h3>Where</h3><div class="mapwrap"><canvas id="worldMap"></canvas></div></div></div>
      <div class="card">${f('lines')}</div>
      <div class="row"><button class="btn danger" data-del-person="${esc(id)}">Remove ${esc(n.name)}</button></div>`;
  }
  document.addEventListener('click', async e => {
    if (e.target.closest('#addPerson')) {
      const ids = S.cur.world.npcs.map(x => x.id), id = idFrom('person', ids);
      const m = App.mods(), map = m.C.buildMap(), taken = new Set(map.npcs.map(q => q.x + ',' + q.y));
      let spot = { x: 25, y: 26 };
      outer: for (let y = 19; y < 27; y++) for (let x = 24; x < 35; x++) if (map.tiles[y][x] === '.' && !taken.has(x + ',' + y) && !(x === map.spawn.x && y === map.spawn.y)) { spot = { x, y }; break outer; }
      if (App.add('world.npcs', id, { id, name: 'New Person', x: spot.x, y: spot.y, facing: 'down', lines: ['Hello there.'] })) App.go('world/people/' + id);
      return;
    }
    const pl = e.target.closest('[data-place]');
    if (pl) { W_.placing = pl.dataset.place; App.toast('Tap the map where they should stand.'); App.rerender(); return; }
    const del = e.target.closest('[data-del-person]');
    if (del && await App.confirm('Remove this person?', 'Their lines go with them.', 'Remove', true)) { App.remove(`world.npcs[${del.dataset.delPerson}]`); App.go('world/people'); }
  });
  // --- starters
  function starterList() {
    return `<div class="row spread"><p class="dim">The daemons a new game offers. Each starts at level 5, attuned to its sub-essences.</p><button class="btn pri" id="addStarter">+ New starter</button></div>
      <div class="cards">${S.cur.world.starters.map(s => { const r = App.rec(s.key); return `<button class="ecard" data-go="world/starters/${esc(s.key)}"><div class="top">${App.sprite(s.key, 64)}<div><div class="nm">${esc(r ? r.dName : s.key)}</div><div class="d">${esc(s.key)} · attuned to ${s.attune.map(App.essName).join(', ')}</div></div></div><div class="d">${esc(s.blurb)}</div></button>`; }).join('')}</div>`;
  }
  function starterView(key) {
    const s = S.cur.world.starters.find(x => x.key === key);
    if (!s) return `<div class="empty">No starter "${esc(key)}".</div>`;
    const P = `world.starters[${key}]`;
    return `<div class="dhead"><a class="btn small" href="#world/starters">← Starters</a>${App.sprite(key, 64)}<h2>${esc((App.rec(key) || { dName: key }).dName)}</h2></div>
      <div class="card"><div class="form">${F.field(P + '.key')}${F.field(P + '.attune')}${F.field(P + '.blurb')}</div></div>
      <div class="row"><button class="btn danger" data-del-starter="${esc(key)}"${S.cur.world.starters.length <= 1 ? ' disabled' : ''}>Remove this starter</button></div>`;
  }
  document.addEventListener('click', e => {
    if (e.target.closest('#addStarter')) App.pickKey('AA', key => { if (S.cur.world.starters.some(s => s.key === key)) return App.toast('That genome is already a starter.', 'bad'); const sub = S.cur.essences.subs.find(x => !x.host || x.host === key[0]); if (App.add('world.starters', key, { key, attune: [sub.code], blurb: 'A new kernel.' })) App.go('world/starters/' + key); });
    const d = e.target.closest('[data-del-starter]'); if (d) { App.remove(`world.starters[${d.dataset.delStarter}]`); App.go('world/starters'); }
  });
  // a starter's genome is its id, so changing it moves the page
  App.onChange(() => {
    if (App.route.name !== 'world' || App.route.args[0] !== 'starters' || !App.route.args[1] || S.cur.world.starters.find(s => s.key === App.route.args[1])) return;
    const fresh = S.cur.world.starters.find(s => !S.base.world.starters.some(b => b.key === s.key));
    App.go('world/starters' + (fresh ? '/' + fresh.key : ''));
  });
})();
