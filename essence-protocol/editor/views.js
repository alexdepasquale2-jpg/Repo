/* Essence Protocol content editor: the dashboard, the merge browser (spells, daemons, items),
 * hand edits, sprites and colors, changes, and working with Claude Code. */
(function () {
  'use strict';
  const App = window.EDITOR, S = App.S, SC = App.SC, esc = App.esc, fmt = App.fmt, plural = App.plural, F = App.F;
  const V = App.views;
  const ICON = () => Object.fromEntries(S.cur.battle.classes.map(c => [c.id, c.icon]));
  const fxName = code => { const f = S.cur.battle.effects.find(x => x.code === code); return f ? f.name : code; };
  const SELF = new Set(['heal', 'cleanse', 'shield', 'guard', 'overclock', 'haste', 'focus', 'veil', 'regen', 'mirror', 'rewind', 'phase', 'overwrite']);
  function fxText([code, chance, mag]) {
    const nm = fxName(code);
    if (['pierce', 'crit', 'fork', 'overflow'].includes(code)) return nm;
    if (code === 'heal' || code === 'shield') return `${nm} ${mag}%`;
    if (['drain', 'recoil', 'echo', 'delay'].includes(code)) return `${nm} ${mag}%` + (chance < 100 ? ` (${chance}%)` : '');
    if (code === 'regen') return `Regen ${mag}%/turn` + (chance < 100 ? ` (${chance}%)` : '');
    return chance >= 100 ? nm : `${nm} ${chance}%`;
  }
  App.fxText = fxText;
  const head = (title, desc, actions) => `<div class="pagehead"><div><h1>${esc(title)}</h1>${desc ? `<p>${desc}</p>` : ''}</div>${actions ? `<div class="row">${actions}</div>` : ''}</div>`;
  App.head = head;
  const bar = (label, v, max, text, c) => `<div class="bar"><span class="dim">${esc(label)}</span><span class="tr"><i style="width:${Math.max(0, Math.min(100, v / max * 100))}%;${c ? `--c:${c}` : ''}"></i></span><b>${esc(text != null ? text : fmt(v))}</b></div>`;
  App.bar = bar;

  // ---------------------------------------------------------------- statistics over the baked merges
  let statsCache = null;
  function stats() {
    if (statsCache && statsCache.rows === S.curRows && statsCache.v === S.version) return statsCache.s;
    const f = n => S.fields.indexOf(n), I = { name: f('name'), cls: f('cls'), rarity: f('rarity'), fx: f('fx'), dName: f('dName'), dDesc: f('dDesc'), item: f('item'), aff: f('aff'), tags: f('tags'), anomaly: f('anomaly') };
    const s = { total: 0, cls: {}, rarity: [0, 0, 0, 0, 0], numbered: {}, numberedAll: 0, fallback: 0, descs: new Map(), items: new Map(), fx: {}, leadTrait: {}, anomalies: {}, tags: {} };
    for (const k of S.keys) {
      const r = S.curRows[k]; if (!r) continue;
      s.total++;
      s.cls[r[I.cls]] = (s.cls[r[I.cls]] || 0) + 1;
      s.rarity[r[I.rarity]]++;
      if (/ (II|III|IV|V|VI)$/.test(r[I.name])) { s.numbered[r[I.cls]] = (s.numbered[r[I.cls]] || 0) + 1; s.numberedAll++; }
      if (/-\d+$/.test(r[I.dName])) s.fallback++;
      s.descs.set(r[I.dDesc], (s.descs.get(r[I.dDesc]) || 0) + 1);
      s.items.set(r[I.item][1], (s.items.get(r[I.item][1]) || 0) + 1);
      for (const x of r[I.fx]) s.fx[x[0]] = (s.fx[x[0]] || 0) + 1;
      if (r[I.aff][0]) s.leadTrait[r[I.aff][0][0]] = (s.leadTrait[r[I.aff][0][0]] || 0) + 1;
      if (r[I.anomaly]) s.anomalies[r[I.anomaly]] = (s.anomalies[r[I.anomaly]] || 0) + 1;
      for (const t of r[I.tags]) s.tags[t] = (s.tags[t] || 0) + 1;
    }
    statsCache = { rows: S.curRows, v: S.version, s };
    return s;
  }
  App.stats = stats;
  // how many merges use each word of a pool (spell nouns, adjectives...)
  App.wordUsage = function (list, fieldName, how) {
    const i = S.fields.indexOf(fieldName), u = {};
    for (const w of list) u[w] = 0;
    for (const k of S.keys) {
      const r = S.curRows[k]; if (!r) continue;
      const text = String(r[i]);
      for (const w of list) if (how === 'end' ? new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( (II|III|IV|V|VI))?$`).test(text) : text.includes(w)) u[w]++;
    }
    return u;
  };

  // ---------------------------------------------------------------- dashboard
  V.dashboard = {
    bakeAware: true,
    render() {
      const st = stats(), d = S.cur;
      const ICO = ICON();
      const maxCls = Math.max(...Object.values(st.cls));
      const modeCard = {
        local: `Edits save straight into the game's files in this repo (data/, db/ and js/data.js). Commit them with git, or ask Claude Code to.`,
        hosted: `Edits are kept as a draft in this page, on every device you open it on. When you're done, ask Claude Code to apply them: it writes them into the game, re-bakes and pushes.`,
        offline: `This copy can't write the game's files. Your draft stays in this browser. Export it as a change set, or copy it for Claude Code.`,
      }[S.mode];
      const thin = [];
      if (st.numberedAll) thin.push([`${fmt(st.numberedAll)} spell names needed a numeral (II, III…)`, 'Each class has a list of spell nouns; when they run out, names repeat with numbers. Add nouns to the busiest classes.', 'words/nouns', Object.entries(st.numbered).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(', ')]);
      if (st.fallback) thin.push([`${plural(st.fallback, 'daemon name')} ran out of syllables`, 'These got names like "Magstalueon-1". More name roots or sub syllables fix them.', 'words/names', '']);
      const distinctDesc = st.descs.size;
      if (distinctDesc < st.total) thin.push([`${fmt(distinctDesc)} different form descriptions for ${fmt(st.total)} daemons`, `Up to ${Math.max(...st.descs.values())} daemons share one. More body lines, organ phrases or temperaments help.`, 'words/forms', '']);
      const topItem = [...st.items.entries()].sort((a, b) => b[1] - a[1])[0];
      if (topItem && topItem[1] > 5) thin.push([`${fmt(st.items.size)} different item names`, `"${topItem[0]}" names ${topItem[1]} different items. Item names come from the spell's first word and the item kind.`, 'words/items', '']);
      const unused = d.battle.effects.filter(f => !st.fx[f.code] && f.code !== 'priority').map(f => f.name);
      if (unused.length) thin.push([`${plural(unused.length, 'effect')} nothing uses`, `${unused.join(', ')} work in battle, but no essence or combo adds them.`, 'essences', '']);
      const quietSubs = d.essences.subs.filter(x => d.combos.resonances.filter(r => r.subs.includes(x.code)).length <= 1).map(x => x.name);
      if (quietSubs.length) thin.push([`${plural(quietSubs.length, 'sub-essence')} in one resonance or none`, quietSubs.join(', ') + '.', 'combos/resonances', '']);
      const neverLead = d.traits.traits.filter(t => !st.leadTrait[t.code]).map(t => t.code);
      if (neverLead.length) thin.push([`${plural(neverLead.length, 'trait')} never lead a genome`, `${neverLead.join(', ')} only show up as second picks, so they're rare. Raise their leanings.`, 'traits', '']);
      const wild = new Set(d.world.zones.flatMap(z => z.wild.map(w => w.key)));
      const things = [].concat(...d.world.maps.map(m => m.things)), trainers = things.filter(t => t.type === 'trainer'), people = things.filter(t => t.type === 'person');
      thin.push([`${plural(wild.size, 'genome')} appear in the wild; ${plural(people.length, 'person', 'people')} live in the world`, 'Everything else only turns up by composing, splicing or in the Rift.', 'world/zones', '']);
      return `<div class="page">
        ${head('Essence Protocol content', `Everything the game shows comes from here: ${fmt(st.total)} merges (each one a spell, a daemon form and an item) baked from ${d.essences.mains.length} main and ${d.essences.subs.length} sub-essences, plus the world around them.`, `<button class="btn" data-go="changes">Review changes (${fmt(S.ops.length)})</button>`)}
        <div class="note acc">${esc(modeCard)}</div>
        <div class="tiles">
          <button class="tile" data-go="spells"><span class="k">Spells, daemons, items</span><span class="v">${fmt(st.total)}</span><span class="s">one of each per merge</span></button>
          <button class="tile" data-go="essences"><span class="k">Essences</span><span class="v">${d.essences.mains.length} + ${d.essences.subs.length}</span><span class="s">mains + sub-essences</span></button>
          <button class="tile" data-go="combos"><span class="k">Combos</span><span class="v">${d.combos.resonances.length} · ${d.combos.trinities.length}</span><span class="s">resonances · trinities</span></button>
          <button class="tile" data-go="world/maps"><span class="k">World</span><span class="v">${d.world.maps.length}</span><span class="s">${plural(d.world.maps.length, 'map')} · ${plural(things.length, 'thing')}</span></button>
          <button class="tile" data-go="world/trainers"><span class="k">Trainers</span><span class="v">${trainers.length}</span><span class="s">${trainers.filter(t => t.warden).length} wardens · ${plural(people.length, 'person', 'people')}</span></button>
          <button class="tile" data-go="overrides"><span class="k">Hand edits</span><span class="v">${Object.keys(d.overrides).length}</span><span class="s">merges edited by hand</span></button>
        </div>
        <div class="grid g2">
          <div class="card"><h3>Spells by class</h3><div class="bars">${Object.entries(st.cls).sort((a, b) => b[1] - a[1]).map(([c, n]) => bar(`${ICO[c] || ''} ${c}`, n, maxCls, fmt(n))).join('')}</div></div>
          <div class="card"><h3>Merges by rarity</h3><div class="bars">${st.rarity.map((n, i) => bar(SC.RARITY[i], n, Math.max(...st.rarity), fmt(n), `var(--r${i})`)).join('')}</div><p class="dim" style="margin-top:8px;font-size:12px">Base: no sub-essences. Compound: subs. Resonant: two subs resonate. Trinity: three subs align. Anomaly: a glitch in the lattice.</p></div>
        </div>
        <div class="grid g2">
          <div class="card"><h3>Health</h3>${S.errors || S.warns ? `<div class="stack">${S.issues.slice(0, 6).map(issueHTML).join('')}${S.issues.length > 6 ? `<button class="btn small" data-go="changes">See all ${fmt(S.issues.length)}</button>` : ''}</div>` : '<p class="dim">No problems. Everything validates and the map is reachable.</p>'}</div>
          <div class="card"><h3>Where more content would show most</h3><div class="stack">${thin.map(([t, d2, go, extra]) => `<button class="issue" data-go="${go}" style="grid-template-columns:1fr"><span><b>${esc(t)}</b><div class="dim">${esc(d2)}${extra ? ' ' + esc(extra) + '.' : ''}</div></span></button>`).join('')}</div></div>
        </div>
      </div>`;
    },
  };
  function issueHTML(i) {
    return `<button class="issue ${i.level}" data-goto-path="${esc(i.path)}"><span class="lv">${i.level === 'error' ? '✕' : '!'}</span><span>${esc(i.msg)}<div class="p">${esc(SC.describePath(S.cur, i.path) || i.path)}</div></span></button>`;
  }
  App.issueHTML = issueHTML;

  // where a path lives in the editor
  App.routeFor = function (path) {
    let m;
    if ((m = path.match(/^essences\.(mains|subs)\[([^\]]+)\]/))) return 'essences/' + m[2];
    if ((m = path.match(/^essences\.reactions[.[]([A-Z]{2})/))) return 'essences/pair/' + m[1];
    if ((m = path.match(/^combos\.(resonances|trinities|anomalies)\[([^\]]+)\]/))) return `combos/${m[1]}/${m[2]}`;
    if ((m = path.match(/^combos\.(resonances|trinities|anomalies)/))) return `combos/${m[1]}`;
    if ((m = path.match(/^battle\.classes\[([^\]]+)\]/))) return 'battle/classes/' + m[1];
    if ((m = path.match(/^battle\.statuses\[([^\]]+)\]/))) return 'battle/statuses/' + m[1];
    if ((m = path.match(/^battle\.(\w+)/))) return 'battle/' + m[1];
    if ((m = path.match(/^traits\.traits\[([^\]]+)\]/))) return 'traits/' + m[1];
    if (path.startsWith('traits.')) return 'traits/' + (path.startsWith('traits.lineage') ? 'lineage' : 'leanings');
    if (path.startsWith('items.')) return 'words/items';
    if (path.startsWith('words.daemonSuffixes')) return 'words/names';
    if (path.startsWith('words.temperaments')) return 'words/forms';
    if (path.startsWith('words.')) return 'words/templates';
    if ((m = path.match(/^world\.(zones|trainers|npcs|starters|rooms)\[([^\]]+)\]/))) return `world/${m[1] === 'npcs' ? 'people' : m[1] === 'rooms' ? 'map' : m[1]}/${m[2]}`;
    if ((m = path.match(/^world\.(\w+)/))) return 'world/' + (m[1] === 'npcs' ? 'people' : m[1] === 'text' ? 'lines' : m[1]);
    if ((m = path.match(/^overrides\[([^\]]+)\]/))) return 'spells/' + m[1];
    return 'changes';
  };
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-goto-path]');
    if (!b) return;
    const path = b.dataset.gotoPath;
    App.go(App.routeFor(path));
    setTimeout(() => { const f = [...document.querySelectorAll('[data-f]')].filter(x => path === x.dataset.f || path.startsWith(x.dataset.f + '.') || path.startsWith(x.dataset.f + '[')).sort((a, c) => c.dataset.f.length - a.dataset.f.length)[0]; if (f) { f.scrollIntoView({ block: 'center' }); f.classList.add('flash'); } }, 80);
  });

  // ---------------------------------------------------------------- the merge browser
  const MB = { q: '', lead: '', second: '', cls: '', rarity: '', sub: '', only: '', sort: 'key' };
  App.setMergeFilter = f => { Object.assign(MB, { q: '', lead: '', second: '', cls: '', rarity: '', sub: '', only: '' }, f); };
  let listCache = null;
  function filtered(kind) {
    const sig = JSON.stringify(MB) + kind + S.version + (S.curRows === S.baseRows) + S.keys.length + S.bake.state;
    if (listCache && listCache.sig === sig) return listCache.keys;
    const f = n => S.fields.indexOf(n), iName = f('name'), iD = f('dName'), iItem = f('item'), iCls = f('cls'), iR = f('rarity'), iP = f('power'), iH = f('hits'), iFl = f('flux'), iSt = f('dStats'), iIn = f('instab');
    const q = MB.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const out = [];
    for (const k of S.keys) {
      const r = S.curRows[k]; if (!r) continue;
      if (MB.lead && k[0] !== MB.lead) continue;
      if (MB.second && k[1] !== MB.second) continue;
      if (MB.cls && r[iCls] !== MB.cls) continue;
      if (MB.rarity !== '' && r[iR] !== +MB.rarity) continue;
      if (MB.sub && !k.slice(3).match(new RegExp(MB.sub + '[12]'))) continue;
      if (MB.only === 'changed' && !S.changed.has(k)) continue;
      if (MB.only === 'edited' && !S.cur.overrides[k]) continue;
      if (q.length) { const text = (k + ' ' + r[iName] + ' ' + r[iD] + ' ' + r[iItem][1]).toLowerCase(); if (!q.every(w => text.includes(w))) continue; }
      out.push(k);
    }
    const by = {
      name: k => (kind === 'daemons' ? S.curRows[k][iD] : kind === 'items' ? S.curRows[k][iItem][1] : S.curRows[k][iName]),
      power: k => -(S.curRows[k][iP] * S.curRows[k][iH]), flux: k => S.curRows[k][iFl], rarity: k => -S.curRows[k][iR], instab: k => -S.curRows[k][iIn],
      stats: k => -S.curRows[k][iSt].reduce((a, b) => a + b, 0), tier: k => -S.curRows[k][iItem][3],
    }[MB.sort];
    if (by) { const cache = new Map(out.map(k => [k, by(k)])); out.sort((a, b) => { const x = cache.get(a), y = cache.get(b); return x < y ? -1 : x > y ? 1 : 0; }); }
    listCache = { sig, keys: out };
    return out;
  }
  const ROWH = 58;
  function rowHTML(kind, k, i, sel) {
    const r = App.rec(k); if (!r) return '';
    const ICO = ICON();
    const chg = S.changed.has(k) ? '<span class="chg" title="Your edits change this merge"></span>' : '';
    let t, s, e;
    if (kind === 'daemons') { t = r.dName; s = `${SC.STAT_KEYS.map((x, j) => r.dStats[j]).reduce((a, b) => a + b, 0)} total stats · ${passiveName(r.dPassive)}`; e = `<span class="key">${esc(k)}</span>`; }
    else if (kind === 'items') { t = r.item[1]; s = `${kindName(r.item[0])} · ${r.item[2]}`; e = App.tier(r.item[3]); }
    else { t = r.name; s = `${ICO[r.cls] || ''} ${r.cls}${r.power ? ` · power ${r.power}${r.hits > 1 ? '×' + r.hits : ''}` : ''} · Flux ${r.flux}`; e = App.rar(r.rarity); }
    return `<button class="item${k === sel ? ' on' : ''}" style="top:${i * ROWH}px" data-key="${esc(k)}">${App.sprite(k, 32)}<span style="min-width:0"><div class="t">${esc(t)}</div><div class="s">${esc(s)}</div></span><span class="e">${e}${chg}</span></button>`;
  }
  const passiveName = code => { const x = S.cur.essences.mains.find(m => m.code === code) || S.cur.essences.subs.find(m => m.code === code); return x ? x.passive.name : code; };
  const kindName = k => { const x = S.cur.items.kinds.find(i => i.kind === k); return x ? x.name : k; };
  App.passiveName = passiveName; App.kindName = kindName;

  function browser(kind) {
    const title = { spells: 'Spells', daemons: 'Daemons', items: 'Items' }[kind];
    const blurb = {
      spells: 'Every merge is a spell. Its name, class, numbers and effects come from the essences and combos in it; open one to see why, or to edit it by hand.',
      daemons: 'Every merge is also a daemon form: a name, six base stats, a passive and a description. The sprite is drawn from the genome.',
      items: 'At the Nexus Forge every merge becomes an item. The class decides the kind; the name, lore and a quality roll are baked per merge.',
    }[kind];
    return {
      bakeAware: false,
      render(args) {
        const sel = args[0] && S.curRows && S.curRows[args[0]] ? args[0] : null;
        const E = App.mods().E;
        const mains = S.cur.essences.mains, subs = S.cur.essences.subs, classes = S.cur.battle.classes;
        const sorts = kind === 'daemons' ? [['key', 'Genome order'], ['name', 'Name'], ['stats', 'Total stats']] : kind === 'items' ? [['key', 'Genome order'], ['name', 'Name'], ['tier', 'Quality']] : [['key', 'Genome order'], ['name', 'Name'], ['power', 'Power'], ['flux', 'Flux cost'], ['instab', 'Instability'], ['rarity', 'Rarity']];
        return `<div class="page${sel ? ' hasdetail' : ''}" style="max-width:1400px">
          ${head(title, esc(blurb))}
          <div class="split${sel ? ' showdetail' : ''}" id="mb">
            <div class="listpane">
              <div class="filters">
                <input type="search" id="mbq" placeholder="Filter by name or key…" value="${esc(MB.q)}" aria-label="Filter">
                <div class="row"><select id="mbLead" aria-label="Lead essence"><option value="">Any lead</option>${mains.map(m => `<option value="${m.code}"${MB.lead === m.code ? ' selected' : ''}>${esc(m.name)} leads</option>`).join('')}</select>
                <select id="mbSecond" aria-label="Second essence"><option value="">Any second</option>${mains.map(m => `<option value="${m.code}"${MB.second === m.code ? ' selected' : ''}>${esc(m.name)} second</option>`).join('')}</select></div>
                <div class="row"><select id="mbSub" aria-label="Sub-essence"><option value="">Any sub-essence</option>${subs.map(s => `<option value="${s.code}"${MB.sub === s.code ? ' selected' : ''}>has ${esc(s.name)}</option>`).join('')}</select>
                <select id="mbCls" aria-label="Class"><option value="">Any class</option>${classes.map(c => `<option value="${c.id}"${MB.cls === c.id ? ' selected' : ''}>${esc(c.icon + ' ' + c.id)}</option>`).join('')}</select></div>
                <div class="row"><select id="mbRar" aria-label="Rarity"><option value="">Any rarity</option>${SC.RARITY.map((r, i) => `<option value="${i}"${MB.rarity === String(i) ? ' selected' : ''}>${r}</option>`).join('')}</select>
                <select id="mbSort" aria-label="Sort">${sorts.map(([v, l]) => `<option value="${v}"${MB.sort === v ? ' selected' : ''}>Sort: ${l}</option>`).join('')}</select></div>
                <div class="seg" role="group" aria-label="Show"><button data-only=""${!MB.only ? ' class="on"' : ''}>All</button><button data-only="changed"${MB.only === 'changed' ? ' class="on"' : ''}>Changed by edits${S.changed.size ? ` (${fmt(S.changed.size)})` : ''}</button><button data-only="edited"${MB.only === 'edited' ? ' class="on"' : ''}>Hand-edited</button></div>
              </div>
              <div class="listmeta"><span id="mbCount"></span>${E ? '' : '<span class="bad">content error</span>'}</div>
              <div class="vlist" id="mbList"><div class="spacer" id="mbSpacer"></div></div>
            </div>
            <div class="detail" id="mbDetail">${sel ? App.mergeDetail(sel, kind) : '<div class="empty">Pick one from the list.</div>'}</div>
          </div></div>`;
      },
      after(el, args) {
        const sel = args[0];
        const list = el.querySelector('#mbList'), spacer = el.querySelector('#mbSpacer');
        let keys = filtered(kind);
        const draw = () => {
          const top = list.scrollTop, h = list.clientHeight || 600;
          const from = Math.max(0, Math.floor(top / ROWH) - 6), to = Math.min(keys.length, Math.ceil((top + h) / ROWH) + 6);
          spacer.style.height = keys.length * ROWH + 'px';
          let html = '';
          for (let i = from; i < to; i++) html += rowHTML(kind, keys[i], i, sel);
          spacer.innerHTML = html;
          App.paintSprites(spacer);
          el.querySelector('#mbCount').textContent = `${fmt(keys.length)} of ${fmt(S.keys.length)}`;
        };
        list.addEventListener('scroll', () => requestAnimationFrame(draw), { passive: true });
        list.addEventListener('click', e => { const b = e.target.closest('.item'); if (b) App.go(kind + '/' + b.dataset.key); });
        const refilter = () => { keys = filtered(kind); list.scrollTop = 0; draw(); };
        el.querySelector('#mbq').addEventListener('input', App.debounce(e => { MB.q = e.target.value; refilter(); }, 150));
        for (const [id, k] of [['#mbLead', 'lead'], ['#mbSecond', 'second'], ['#mbSub', 'sub'], ['#mbCls', 'cls'], ['#mbRar', 'rarity'], ['#mbSort', 'sort']]) el.querySelector(id).addEventListener('change', e => { MB[k] = e.target.value; refilter(); });
        el.querySelectorAll('[data-only]').forEach(b => b.addEventListener('click', () => { MB.only = b.dataset.only; el.querySelectorAll('[data-only]').forEach(x => x.classList.toggle('on', x === b)); refilter(); }));
        // keep the picked merge in view
        if (sel) { const i = keys.indexOf(sel); if (i >= 0) list.scrollTop = Math.max(0, i * ROWH - 120); }
        draw();
        const back = el.querySelector('[data-back]'); if (back) back.onclick = () => App.go(kind);
      },
      refresh(el, args) {
        const d = el.querySelector('#mbDetail');
        if (args[0] && d && !d.contains(document.activeElement)) { d.innerHTML = App.mergeDetail(args[0], kind); App.showIssues(d); }
        const list = el.querySelector('#mbList'); if (list) list.dispatchEvent(new Event('scroll'));
      },
    };
  }
  V.spells = browser('spells'); V.daemons = browser('daemons'); V.items = browser('items');

  // ---- one merge, everything about it
  const OVR = SC.SCHEMA.fields.overrides.item.fields;
  App.mergeDetail = function (key, kind) {
    const r = App.rec(key), b = App.rec(key, 'base');
    if (!r) return '<div class="empty">This merge doesn\'t exist in the edited content.</div>';
    const m = App.mods(), ICO = ICON();
    const why = m.B ? m.B.explain(key) : null;
    const ch = S.changed.get(key);
    const cls = S.cur.battle.classes.find(c => c.id === r.cls);
    const was = (f, show) => (b && ch && ch.includes(f) ? `<span class="was">${esc(show ? show(b[f]) : b[f])}</span>` : '');
    const statMax = 200;
    const used = usedIn(key);
    const spell = `<div class="card"><h3>Spell</h3>
      <div class="row" style="margin-bottom:8px"><span style="font-size:18px;font-family:var(--display);font-weight:600">${was('name')}${esc(r.name)}</span></div>
      <dl class="kv"><dt>Class</dt><dd>${esc((ICO[r.cls] || '') + ' ' + r.cls)}${was('cls')} · <span class="dim">${esc(cls ? cls.signature : '')}</span></dd>
      <dt>Power</dt><dd class="num">${r.power ? `${was('power')}${r.power}${r.hits > 1 ? ' × ' + r.hits + ' hits' : ''}` : 'none (not an attack)'}</dd>
      <dt>Accuracy</dt><dd class="num">${was('acc')}${r.acc === 101 ? 'never misses' : r.acc + '%'}</dd>
      <dt>Flux cost</dt><dd class="num">${was('flux')}${r.flux}</dd>
      <dt>Instability</dt><dd class="num">${was('instab')}${r.instab}%</dd>
      ${r.prio ? `<dt>Priority</dt><dd>${r.prio > 0 ? 'acts first' : 'acts last'}</dd>` : ''}
      <dt>Effects</dt><dd><div class="chips">${r.fx.map(f => `<span class="chip${SELF.has(f[0]) ? ' on' : ''}">${esc(fxText(f))}</span>`).join('') || '<span class="dim">none</span>'}</div></dd></dl>
      ${r.text ? `<p style="margin-top:10px">${esc(r.text)}</p>` : ''}</div>`;
    const daemon = `<div class="card"><h3>Daemon form</h3>
      <div class="row" style="margin-bottom:8px"><span style="font-size:18px;font-family:var(--display);font-weight:600">${was('dName')}${esc(r.dName)}</span></div>
      <div class="bars">${SC.STAT_KEYS.map((k, i) => bar(SC.STAT[k], r.dStats[i], statMax, (b && ch && ch.includes('dStats') && b.dStats[i] !== r.dStats[i] ? b.dStats[i] + ' → ' : '') + r.dStats[i])).join('')}</div>
      <dl class="kv" style="margin-top:10px"><dt>Passive</dt><dd><b>${esc(passiveName(r.dPassive))}</b> <span class="dim">from ${esc(App.essName(r.dPassive))}</span></dd>
      <dt>Description</dt><dd>${was('dDesc')}${esc(r.dDesc)}</dd>
      <dt>Lineage word</dt><dd>${esc(r.line)}</dd>
      <dt>Trait leanings</dt><dd>${r.aff.map(([c, w]) => `${esc(c)} <span class="dim">${w}</span>`).join(', ')}</dd></dl></div>`;
    const item = `<div class="card"><h3>Forged item</h3>
      <div class="row" style="margin-bottom:8px"><span style="font-size:18px;font-family:var(--display);font-weight:600">${b && ch && ch.includes('item') && b.item[1] !== r.item[1] ? `<span class="was">${esc(b.item[1])}</span>` : ''}${esc(r.item[1])}</span>${App.tier(r.item[3])}</div>
      <dl class="kv"><dt>Kind</dt><dd>${esc(kindName(r.item[0]))}</dd><dt>Lore</dt><dd>${esc(r.item[2])}</dd><dt>Quality roll</dt><dd class="num">${r.item[4]}% (1 in ${fmt(Math.max(1, Math.round(100 / r.item[4])))})</dd></dl></div>`;
    const whyCard = why ? `<div class="card"><h3>Why it came out this way</h3>
      <dl class="kv"><dt>Pair</dt><dd><b>${esc(why.pair.name)}</b> <span class="dim">(${esc(App.essName(why.lead))} leads${why.pure ? ', pure' : ', ' + esc(App.essName(why.follow)) + ' second'}${why.pair.volatile ? ', volatile' : ''})</span> <button class="btn small ghost" data-go="essences/pair/${why.pair.id}">Edit</button></dd>
      ${why.subs.length ? `<dt>Sub-essences</dt><dd>${why.subs.map(s => `${App.essChip(s.code)} on ${esc(App.essName(s.host))}${s.facet ? ` → <b>${esc(s.facet)}</b>` : ''} <span class="dim">"${esc(s.word)}"</span>`).join('<br>')}</dd>` : ''}
      ${why.resonances.length ? `<dt>Resonances</dt><dd>${why.resonances.map(esc).join(', ')}</dd>` : ''}
      ${why.trinity ? `<dt>Trinity</dt><dd>${esc(why.trinity)}</dd>` : ''}
      ${why.anomaly ? `<dt>Anomaly</dt><dd><b>∆${esc(why.anomaly.id)}</b>: ${esc(why.anomaly.desc)}</dd>` : ''}</dl>
      <div class="grid g2" style="margin-top:12px"><div><h4 style="margin-bottom:6px">Trait pushes</h4><div class="bars">${Object.entries(why.traits).sort((a, c) => c[1] - a[1]).map(([k, v]) => bar(SC.AXIS[k][0], v, Math.max(...Object.values(why.traits)), v)).join('')}</div></div>
      <div><h4 style="margin-bottom:6px">Class race</h4><div class="bars">${why.classes.map(([c, v]) => bar(c + (c === why.cls ? ' ✓' : ''), Math.max(0, v), Math.max(1, why.classes[0][1]), v, c === why.cls ? 'var(--acc)' : 'var(--line2)')).join('')}</div></div></div></div>` : '';
    const ov = S.cur.overrides[key] || {};
    const oPath = f => `overrides[${key}].${f}`;
    const ovField = f => F.field(oPath(f), { node: OVR[f] });
    const hand = `<div class="card" id="hand"><h3>Edit this merge by hand</h3><p class="sub">Replaces what the rules made, for this merge only. Leave a field empty to keep the generated value. Numbers stay within what the game accepts.</p>
      <div class="form"><div class="grid g2">${ovField('name')}${ovField('dName')}</div>${ovField('text')}${ovField('dDesc')}<div class="grid g2">${ovField('itemName')}${ovField('line')}</div>${ovField('itemLore')}
      <div class="grid g3">${r.power || ov.power ? ovField('power') : ''}${r.power || ov.hits ? ovField('hits') : ''}${ovField('acc')}${ovField('flux')}${ovField('instab')}${ovField('prio')}</div>${ovField('dStats')}
      ${Object.keys(ov).length ? `<div><button class="btn danger small" data-clear-override="${esc(key)}">Remove every hand edit on this merge</button></div>` : ''}</div></div>`;
    const usedCard = used.length ? `<div class="card"><h3>Used in the world</h3><div class="stack">${used.map(u => `<button class="issue" data-go="${u.go}" style="grid-template-columns:1fr"><span>${esc(u.text)}</span></button>`).join('')}</div></div>` : '';
    const changedNote = ch ? `<div class="note acc">Your edits change this merge: ${esc(ch.join(', '))}.</div>` : '';
    const order = kind === 'daemons' ? [daemon, spell, item] : kind === 'items' ? [item, spell, daemon] : [spell, daemon, item];
    return `<div class="dhead"><button class="btn small back" data-back>← List</button>${App.sprite(key, 96)}<div style="min-width:0"><h2>${esc(kind === 'items' ? r.item[1] : kind === 'daemons' ? r.dName : r.name)}</h2><div class="row" style="margin-top:4px">${App.rar(r.rarity)}${r.tags.map(t => `<span class="pill">${esc(t)}</span>`).join('')}${r.anomaly ? `<span class="pill acc">∆${esc(r.anomaly)}</span>` : ''}<span class="key">${esc(key)}</span></div><div style="margin-top:6px">${App.genome(key)}</div></div></div>
      ${changedNote}${order.join('')}${whyCard}${usedCard}${hand}`;
  };
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-clear-override]');
    if (b) App.remove(`overrides[${b.dataset.clearOverride}]`);
    const back = e.target.closest('[data-back]');
    if (back && App.route && ['spells', 'daemons', 'items'].includes(App.route.name)) App.go(App.route.name);
  });
  function usedIn(key) {
    const w = S.cur.world, out = [];
    for (const s of w.starters) if (s.key === key) out.push({ text: 'A starter', go: 'world/starters/' + key });
    for (const z of w.zones) for (const x of z.wild) if (x.key === key) out.push({ text: `Wild in ${z.name} (levels ${x.min}-${x.max})`, go: 'world/zones/' + z.id });
    for (const m of w.maps) for (const t of m.things) {
      if (t.type === 'trainer') for (const x of t.team) if (x.key === key) out.push({ text: `${t.name}'s team (level ${x.level})`, go: 'world/trainers/' + t.id });
      if (t.gives && t.gives.daemon && t.gives.daemon.key === key) out.push({ text: `Given by ${t.name || t.id} (level ${t.gives.daemon.level})`, go: 'world/things/' + t.id });
      if (t.gives && t.gives.item === key) out.push({ text: `Forged item from ${t.name || t.id}`, go: 'world/things/' + t.id });
    }
    return out;
  }
  App.usedIn = usedIn;

  // ---------------------------------------------------------------- hand edits
  V.overrides = {
    bakeAware: true,
    render() {
      const ov = S.cur.overrides, keys = Object.keys(ov);
      return `<div class="page">${head('Hand edits', 'Merges you changed by hand after the rules ran: a better name for a spell, a custom description, tuned numbers. Open any spell, daemon or item and use "Edit this merge by hand" to add one.')}
        ${keys.length ? `<div class="tablewrap"><table class="t"><thead><tr><th></th><th>Merge</th><th>Changed</th><th>Now</th></tr></thead><tbody>${keys.map(k => { const r = App.rec(k); return `<tr class="click" data-go="spells/${esc(k)}"><td>${App.sprite(k, 32)}</td><td><span class="key">${esc(k)}</span></td><td>${Object.keys(ov[k]).map(esc).join(', ')}</td><td>${r ? esc(r.name + ' · ' + r.dName) : ''}</td></tr>`; }).join('')}</tbody></table></div>` : '<div class="empty">No hand edits yet.</div>'}</div>`;
    },
  };

  // ---------------------------------------------------------------- sprites and colors
  const AS = { lead: '', sub: '', page: 0 };
  V.assets = {
    render() {
      const d = S.cur.essences;
      return `<div class="page">${head('Sprites and colors', 'Daemon sprites are drawn from each genome: the lead main sets the body, the second main the belly, and every sub-essence adds an organ in its color. Change a color or an organ here and every sprite that has it redraws.')}
        <div class="card"><h3>Essence colors</h3><div class="cards">${d.mains.map(m => `<div class="ecard" style="--c:${esc(m.color)}"><div class="top"><span class="sw">${esc(m.code)}</span><span class="nm">${esc(m.name)}</span></div>${F.field(`essences.mains[${m.code}].color`)}${F.field(`essences.mains[${m.code}].light`)}${F.field(`essences.mains[${m.code}].deep`)}</div>`).join('')}
          ${d.subs.map(s => `<div class="ecard" style="--c:${esc(s.color)}"><div class="top"><span class="sw">${esc(s.code)}</span><span class="nm">${esc(s.name)}</span></div>${F.field(`essences.subs[${s.code}].color`)}${F.field(`essences.subs[${s.code}].sprite`)}${F.field(`essences.subs[${s.code}].eyes`)}</div>`).join('')}</div></div>
        <div class="card"><div class="row spread"><h3>Every daemon</h3><div class="row"><select id="asLead" aria-label="Lead"><option value="">Any lead</option>${d.mains.map(m => `<option value="${m.code}"${AS.lead === m.code ? ' selected' : ''}>${esc(m.name)} leads</option>`).join('')}</select><select id="asSub" aria-label="Sub"><option value="">Any sub</option>${d.subs.map(s => `<option value="${s.code}"${AS.sub === s.code ? ' selected' : ''}>has ${esc(s.name)}</option>`).join('')}</select></div></div>
        <div id="gallery" class="cards" style="grid-template-columns:repeat(auto-fill,minmax(96px,1fr))"></div><div class="row" style="justify-content:center;margin-top:10px"><button class="btn" id="asMore">Show more</button></div></div>
        <div class="card"><h3>App icons</h3><div class="row">${['icon.svg', 'icons/icon-192.png', 'icons/maskable-512.png'].map(f => `<figure style="margin:0;text-align:center"><img src="${App.ROOT}${f}" alt="" width="72" height="72" style="border-radius:14px;background:var(--sunk)"><figcaption class="dim" style="font-size:12px">${esc(f)}</figcaption></figure>`).join('')}</div><p class="dim" style="margin-top:8px">Icons are image files; to change them, ask Claude Code or replace the files in icons/.</p></div></div>`;
    },
    after(el) {
      const gal = el.querySelector('#gallery');
      const keys = () => S.keys.filter(k => (!AS.lead || k[0] === AS.lead) && (!AS.sub || new RegExp(AS.sub + '[12]').test(k.slice(3))));
      let shown = 0;
      const more = () => {
        const ks = keys(), next = ks.slice(shown, shown + 120);
        gal.insertAdjacentHTML('beforeend', next.map(k => { const r = App.rec(k); return `<button class="ecard" data-go="daemons/${esc(k)}" style="justify-items:center;padding:8px">${App.sprite(k, 64)}<span class="d" style="text-align:center">${esc(r ? r.dName : k)}</span></button>`; }).join(''));
        shown += next.length;
        el.querySelector('#asMore').hidden = shown >= ks.length;
        App.paintSprites(gal);
      };
      el.querySelector('#asMore').onclick = more;
      for (const [id, k] of [['#asLead', 'lead'], ['#asSub', 'sub']]) el.querySelector(id).onchange = e => { AS[k] = e.target.value; gal.innerHTML = ''; shown = 0; more(); };
      more();
    },
  };

  // ---------------------------------------------------------------- changes
  const short = v => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s == null ? '—' : s.length > 140 ? s.slice(0, 137) + '…' : s; };
  // a change in words people read: added and removed words, changed fields, or before → after
  function valsHTML(op) {
    const a = op.before, b = op.value;
    const strs = x => Array.isArray(x) && x.every(y => typeof y === 'string');
    if (op.op === 'set' && strs(a) && strs(b)) {
      const plus = b.filter(x => !a.includes(x)), minus = a.filter(x => !b.includes(x));
      if (plus.length + minus.length) return (plus.length ? `<span class="add">+ ${plus.map(esc).join(', ')}</span> ` : '') + (minus.length ? `<span class="del">− ${minus.map(esc).join(', ')}</span>` : '');
      return '<span class="dim">reordered</span>';
    }
    if (op.op === 'set' && a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a)) {
      const keys = [...new Set(Object.keys(a).concat(Object.keys(b)))].filter(k => !SC.same(a[k], b[k]));
      return keys.map(k => `${esc(k)}: <span class="was">${esc(short(a[k]))}</span> <span class="now">${esc(short(b[k]))}</span>`).join('; ');
    }
    if (op.op === 'set') return `<span class="was">${esc(short(a))}</span> <span class="now">${esc(short(b))}</span>`;
    if (op.op === 'add') return `<span class="now">${esc(b && b.name ? b.name + (b.subs ? ' · ' + b.subs.map(App.essName).join(' + ') : '') : short(b))}</span>`;
    return `<span class="was">${esc(a && a.name ? a.name : short(a))}</span>`;
  }
  function opHTML(op) {
    const label = SC.describePath(op.op === 'remove' ? S.base : S.cur, op.path) || op.path;
    const vals = valsHTML(op);
    return `<div class="op"><span class="kind ${op.op}">${op.op === 'set' ? 'edit' : op.op}</span><div style="min-width:0"><div class="what"><a href="#${esc(App.routeFor(op.path))}" data-goto-path="${esc(op.path)}">${esc(label)}</a></div><div class="vals">${vals}</div></div><button class="btn small ghost" data-revert="${esc(op.path)}" title="Undo this change">Revert</button></div>`;
  }
  V.changes = {
    bakeAware: true,
    render() {
      const ops = S.ops, st = S.changed;
      const byField = {};
      for (const fs of st.values()) for (const f of fs) byField[f] = (byField[f] || 0) + 1;
      const actions = {
        local: `<button class="btn pri" id="saveBtn"${!ops.length || S.errors ? ' disabled' : ''}>Save to the game files</button>${S.node ? '<button class="btn" id="checkBtn">Run the full checks</button>' : ''}`,
        hosted: `<button class="btn pri" id="claudeBtn"${!ops.length ? ' disabled' : ''}>Copy the request for Claude Code</button>`,
        offline: `<button class="btn pri" id="claudeBtn"${!ops.length ? ' disabled' : ''}>Copy for Claude Code</button>`,
      }[S.mode];
      const where = {
        local: 'Saving writes data/*.json, re-bakes db/ and js/data.js, and the game picks it up on reload. Nothing is committed; use git (or ask Claude Code) for that.',
        hosted: 'Your draft is saved in this page for you and Claude Code. To put it in the game, tell Claude Code: "Apply my Essence Protocol editor changes". It reads the draft, applies it with tools/content.js, re-bakes, checks and pushes.',
        offline: 'This copy can\'t write files and has no shared draft. Copy the change set for Claude Code, or export it and run node tools/content.js apply <file> in the repo.',
      }[S.mode];
      return `<div class="page">${head('Changes', `${plural(ops.length, 'edit')} to the content${st.size ? `, changing ${plural(st.size, 'merge')}` : ''}.`, actions + `<button class="btn" id="exportBtn"${!ops.length ? ' disabled' : ''}>Export</button><label class="btn" for="importFile">Import</label><input type="file" id="importFile" accept=".json,application/json" hidden><button class="btn danger" id="discardBtn"${!ops.length ? ' disabled' : ''}>Discard all</button>`)}
        <div class="note ${S.mode === 'offline' ? 'warn' : 'acc'}">${esc(where)}</div>
        ${S.applied ? `<div class="note">Claude Code last applied a draft on ${esc(new Date(S.applied.at).toLocaleString())}${S.applied.commit ? ` (commit ${esc(S.applied.commit)})` : ''}${S.applied.summary ? `: ${esc(S.applied.summary)}` : ''}.</div>` : ''}
        ${S.issues.length ? `<div class="card"><h3>Problems (${fmt(S.errors)} to fix${S.warns ? `, ${fmt(S.warns)} warnings` : ''})</h3><div class="stack">${S.issues.map(issueHTML).join('')}</div></div>` : ''}
        <div class="card" style="padding:0"><div style="padding:14px 16px 6px"><h3>Edits</h3></div>${ops.length ? ops.map(opHTML).join('') : '<div class="empty" style="margin:12px">Nothing yet. Edit anything and it shows up here.</div>'}</div>
        <div class="card"><h3>What it does to the merges</h3>${S.bake.state === 'running' ? '<p class="dim">Baking…</p>' : st.size ? `<p class="dim">${plural(st.size, 'merge')} change: ${Object.entries(byField).sort((a, b) => b[1] - a[1]).map(([f, n]) => `${esc(fieldLabel(f))} ${fmt(n)}`).join(', ')}.</p><div class="tablewrap" style="margin-top:10px;max-height:480px;overflow:auto"><table class="t"><thead><tr><th></th><th>Merge</th><th>Before</th><th>After</th></tr></thead><tbody>${[...st.keys()].slice(0, 300).map(k => { const a = App.rec(k, 'base'), b = App.rec(k); return `<tr class="click" data-go="spells/${esc(k)}"><td>${App.sprite(k, 32)}</td><td><span class="key">${esc(k)}</span><div class="dim" style="font-size:12px">${esc(st.get(k).map(fieldLabel).join(', '))}</div></td><td>${a ? esc(a.name) + '<div class="dim">' + esc(a.dName) + '</div>' : '<span class="dim">new</span>'}</td><td>${b ? esc(b.name) + '<div class="dim">' + esc(b.dName) + '</div>' : '<span class="dim">gone</span>'}</td></tr>`; }).join('')}</tbody></table></div>${st.size > 300 ? `<p class="dim">… and ${fmt(st.size - 300)} more. The spell list can show only the changed ones.</p>` : ''}` : '<p class="dim">No merge changes.</p>'}</div>
        <div id="checkOut"></div></div>`;
    },
    after(el) {
      const on = (id, fn) => { const b = el.querySelector(id); if (b) b.onclick = fn; };
      on('#saveBtn', async () => { const b = el.querySelector('#saveBtn'); b.disabled = true; b.textContent = 'Saving…'; await App.saveToFiles(); });
      on('#checkBtn', async () => {
        const out = el.querySelector('#checkOut'); out.innerHTML = '<div class="card"><p class="dim">Running the checks (bake, content, verify)…</p></div>';
        try { const r = await App.api('POST', 'check'); out.innerHTML = `<div class="card"><h3>${r.ok ? 'All checks passed' : 'A check failed'}</h3><pre class="mono" style="white-space:pre-wrap;font-size:12px;max-height:360px;overflow:auto">${esc(r.output)}</pre></div>`; }
        catch (e) { out.innerHTML = `<div class="note bad">${esc(e.message)}</div>`; }
      });
      on('#claudeBtn', () => App.copy(S.mode === 'hosted' ? 'Apply my Essence Protocol editor changes.' : App.claudePrompt(), 'the request for Claude Code'));
      on('#exportBtn', () => App.download(`essence-changes-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(App.changeSet(), null, 1)));
      on('#discardBtn', async () => { if (await App.confirm('Discard every change?', `This throws away ${plural(S.ops.length, 'edit')}. You can undo it right after.`, 'Discard all', true)) App.discard(); });
      const file = el.querySelector('#importFile');
      if (file) file.onchange = () => { const f = file.files[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => App.importChanges(String(rd.result)); rd.readAsText(f); };
    },
  };
  const FIELD_LABEL = { name: 'spell name', cls: 'class', power: 'power', acc: 'accuracy', flux: 'Flux cost', prio: 'priority', hits: 'hits', instab: 'instability', fx: 'effects', rarity: 'rarity', tags: 'combos', text: 'spell text', dName: 'daemon name', dStats: 'stats', dPassive: 'passive', anomaly: 'anomaly', dDesc: 'description', item: 'item', line: 'lineage word', aff: 'trait leanings', new: 'new merge', gone: 'removed' };
  const fieldLabel = f => FIELD_LABEL[f] || f;
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-revert]');
    if (!b) return;
    const op = S.ops.find(o => o.path === b.dataset.revert);
    if (!op) return;
    if (op.op === 'add') App.remove(op.path); else App.reset(op.path);
  });

  // ---------------------------------------------------------------- Claude Code
  V.claude = {
    render() {
      const open = S.requests.filter(r => r.status !== 'done');
      const cmds = [
        ['What\'s in the game', 'node essence-protocol/tools/content.js'],
        ['List something', 'node essence-protocol/tools/content.js list subs'],
        ['Look at one merge and why', 'node essence-protocol/tools/content.js merge FW-Em1Li2'],
        ['Change a value', 'node essence-protocol/tools/content.js set "essences.subs[Mi].desc" "A shroud that hides the caster."'],
        ['Check everything', 'node essence-protocol/tools/content.js check'],
        ['Apply a change set from this editor', 'node essence-protocol/tools/content.js apply changes.json'],
        ['Open this editor locally', 'python essence-protocol/tools/serve.py   (then open /editor/)'],
      ];
      return `<div class="page">${head('Claude Code', 'This editor and Claude Code work on the same files: the game\'s content is plain JSON in essence-protocol/data/, checked by the same schema and baked by the same code. Anything you can do here, Claude Code can do from the command line, and the other way round.')}
        <div class="grid g2">
          <div class="card"><h3>Hand your edits to Claude Code</h3><div class="stack">
            ${S.mode === 'hosted' ? '<p>Your draft is saved in this page. In a Claude Code session on this repo, say:</p><div class="note acc"><b>Apply my Essence Protocol editor changes.</b></div><p class="dim">Claude reads the draft and your requests from this page, applies them with tools/content.js, re-bakes, runs the checks, commits and pushes, then clears the draft.</p>'
              : S.mode === 'local' ? '<p>You\'re editing the repo files directly: after you save, Claude Code sees your edits as changed files (git diff), and can commit, check or build on them.</p>'
              : '<p>Copy your change set and paste it to Claude Code; it applies it with tools/content.js.</p>'}
            <div class="row"><button class="btn pri" id="copyPrompt"${!S.ops.length && !open.length ? ' disabled' : ''}>Copy ${S.mode === 'hosted' ? 'the request' : 'change set and request'}</button><span class="dim">${plural(S.ops.length, 'edit')}, ${plural(open.length, 'request')}</span></div></div></div>
          <div class="card"><h3>Ask for something the editor can't do</h3><p class="sub">New effects, statuses, anomaly kinds, trait types, zones, a fifth main essence, new sprite shapes: these need new code. Describe what you want; it goes to Claude Code with your edits.</p>
            <textarea id="reqText" rows="3" placeholder="e.g. Add a Poison sub-essence bound to Water, with a passive that makes burns spread."></textarea>
            <div class="row" style="margin-top:8px"><button class="btn" id="addReq">Add request</button></div></div>
        </div>
        <div class="card"><h3>Requests (${fmt(open.length)} open)</h3>${S.requests.length ? `<div class="stack">${S.requests.slice().reverse().map(r => `<div class="op" style="grid-template-columns:1fr auto;border:1px solid var(--line);border-radius:9px"><div><div>${esc(r.text)}</div><div class="vals">${esc(new Date(r.at).toLocaleString())} · ${r.status === 'done' ? 'done' : 'open'}${r.reply ? ' · ' + esc(r.reply) : ''}</div></div><div class="row tight"><button class="btn small" data-req-done="${esc(r.id)}">${r.status === 'done' ? 'Reopen' : 'Mark done'}</button><button class="btn small ghost" data-req-del="${esc(r.id)}" aria-label="Delete">✕</button></div></div>`).join('')}</div>` : '<p class="dim">No requests.</p>'}</div>
        <div class="card"><h3>Commands</h3><div class="stack">${cmds.map(([t, c]) => `<div class="row spread" style="flex-wrap:nowrap;gap:12px"><div style="min-width:0"><div class="dim" style="font-size:12px">${esc(t)}</div><code style="overflow-wrap:anywhere">${esc(c)}</code></div><button class="btn small" data-copy="${esc(c)}">Copy</button></div>`).join('')}</div>
          <p class="dim" style="margin-top:10px">Files: data/essences.json, combos.json, battle.json, traits.json, items.json, words.json, world.json, overrides.json. After editing them by hand, run node tools/bake.js.</p></div></div>`;
    },
    after(el) {
      el.querySelector('#copyPrompt').onclick = () => App.copy(S.mode === 'hosted' ? 'Apply my Essence Protocol editor changes.' : App.claudePrompt(), 'the request');
      el.querySelector('#addReq').onclick = () => { const t = el.querySelector('#reqText'); App.addRequest(t.value); };
      el.addEventListener('click', e => {
        const c = e.target.closest('[data-copy]'); if (c) App.copy(c.dataset.copy, 'the command');
        const d = e.target.closest('[data-req-done]'); if (d) { const r = S.requests.find(x => x.id === d.dataset.reqDone); r.status = r.status === 'done' ? 'open' : 'done'; App.saveRequests(); App.rerender(); App.renderNav(); }
        const x = e.target.closest('[data-req-del]'); if (x) { S.requests = S.requests.filter(r => r.id !== x.dataset.reqDel); App.saveRequests(); App.rerender(); App.renderNav(); }
      });
    },
  };
})();
