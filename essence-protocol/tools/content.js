#!/usr/bin/env node
/* Essence Protocol: read and change the game's content from the command line.
 *
 * Everything the game shows (essences, spells and daemons, combos, battle text, traits, items,
 * words, the world) lives in data/*.json. This tool reads and edits those files with the same
 * schema, validation and change sets as the content editor (editor/), re-bakes the merge
 * database after a change and says which merges changed. Paths name one value, e.g.
 * essences.subs[Em].desc, world.trainers[air-a].team, overrides[FW-Em1Li2].name.
 *
 *   node tools/content.js                        what's in the game, and these commands
 *   node tools/content.js list <what>            subs, mains, resonances, trainers, ... (list alone shows all)
 *   node tools/content.js get <path>             print a value as JSON
 *   node tools/content.js set <path> <value>     set a value (JSON, or plain text for a string)
 *   node tools/content.js add <list> <item>      add an item (JSON) to a list, e.g. combos.resonances
 *   node tools/content.js remove <path>          remove an item, e.g. world.npcs[poet]
 *   node tools/content.js merge <key>            a baked merge: spell, daemon, item, and why
 *   node tools/content.js find <text>            search spells, daemons, items and content
 *   node tools/content.js check                  validate data/ (schema, references, map)
 *   node tools/content.js preview [changes.json] what a change set (or data/ as it is) changes in db/
 *   node tools/content.js apply <changes.json>   apply a change set from the content editor (an export, or
 *                                                the hosted editor's draft documents saved as a JSON list)
 *   node tools/content.js format                 rewrite data/*.json in the canonical layout
 *
 * Flags: --dry (show, don't write)  --no-bake (skip the re-bake)  --force (apply stale edits)
 *        --json (machine-readable output for list, get, merge, find, check, preview)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const SC = require('../js/schema.js');
const DATA = require('../data');
const { bakeFiles, ROOT } = require('./bake.js');

const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => a.startsWith('--')));
const args = argv.filter(a => !a.startsWith('--'));
const DRY = flags.has('--dry'), JSON_OUT = flags.has('--json');
process.stdout.on('error', e => { if (e.code === 'EPIPE') process.exit(0); throw e; }); // e.g. piped into head
const out = s => process.stdout.write(s + '\n');
const fail = s => { process.stderr.write(s + '\n'); process.exit(1); };

// ---- modules for some data (throws if the data can't be built at all)
function modules(data) {
  const E = require('../js/essences.js').make(data);
  const D = require('../js/designs.js').make(E);
  const B = require('../js/baker.js').make(E, D, SC);
  const C = require('../js/content.js').make(E);
  return { E, D, B, C };
}
const ENG = require('../js/engine.js');
const ORGANS = Object.keys(require('../js/sprites.js').SPRITES.ORGANS);
function issuesFor(data) {
  let mods = null;
  try { mods = modules(data); } catch (e) { /* reported below */ }
  const ctx = { mechanics: Object.keys(ENG.MECHANICS), organs: ORGANS, reactionKinds: Object.keys(ENG.REACTION_KINDS), validKey: mods ? mods.E.validKey : null };
  const issues = SC.validate(data, ctx);
  if (mods && !issues.some(i => i.level === 'error')) issues.push(...SC.checkWorld(mods.C));
  else if (!mods && !issues.some(i => i.level === 'error')) issues.push({ level: 'error', path: '', msg: 'the content can\'t be loaded by the game' });
  return issues;
}
function printIssues(issues) {
  for (const i of issues) out(`${i.level === 'error' ? 'error' : 'warn '}  ${i.path || '(data)'}  ${i.msg}`);
}

// ---- the committed database, as records
function readDb() {
  const dir = path.join(ROOT, 'db'), index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  const rows = {};
  for (const s of index.shards) Object.assign(rows, JSON.parse(fs.readFileSync(path.join(dir, s.file), 'utf8')).rows);
  return { fields: index.fields, rows };
}
function rowsOf(files) {
  const rows = {};
  for (const [f, text] of Object.entries(files)) if (/^db\/[A-Z]{2}\.json$/.test(f)) Object.assign(rows, JSON.parse(text).rows);
  return rows;
}
// merge-by-merge differences between two sets of records
function compare(before, after, fields) {
  const changed = [], added = [], removed = [], byField = {};
  for (const k of Object.keys(after)) {
    if (!before[k]) { added.push(k); continue; }
    const fs_ = fields.filter((f, i) => JSON.stringify(before[k][i]) !== JSON.stringify(after[k][i]));
    if (fs_.length) { changed.push({ key: k, fields: fs_ }); for (const f of fs_) byField[f] = (byField[f] || 0) + 1; }
  }
  for (const k of Object.keys(before)) if (!after[k]) removed.push(k);
  return { changed, added, removed, byField };
}
function printCompare(cmp, before, after, fields) {
  const n = cmp.changed.length + cmp.added.length + cmp.removed.length;
  if (!n) { out('No merge changes.'); return; }
  out(`${cmp.changed.length} merges change${cmp.added.length ? `, ${cmp.added.length} are new` : ''}${cmp.removed.length ? `, ${cmp.removed.length} are gone` : ''}.`);
  const fieldsLine = Object.entries(cmp.byField).sort((a, b) => b[1] - a[1]).map(([f, c]) => `${f} ${c}`).join(', ');
  if (fieldsLine) out('Fields: ' + fieldsLine);
  const ni = fields.indexOf('name'), di = fields.indexOf('dName');
  for (const c of cmp.changed.slice(0, 12)) {
    const b = before[c.key], a = after[c.key];
    const bits = [];
    if (c.fields.includes('name')) bits.push(`spell ${b[ni]} -> ${a[ni]}`);
    if (c.fields.includes('dName')) bits.push(`daemon ${b[di]} -> ${a[di]}`);
    const rest = c.fields.filter(f => f !== 'name' && f !== 'dName');
    if (rest.length) bits.push(rest.join(', '));
    out(`  ${c.key.padEnd(14)} ${bits.join('; ')}`);
  }
  if (cmp.changed.length > 12) out(`  … and ${cmp.changed.length - 12} more`);
  for (const k of cmp.added.slice(0, 6)) out(`  + ${k.padEnd(12)} ${after[k][ni]} / ${after[k][di]}`);
  if (cmp.added.length > 6) out(`  + … and ${cmp.added.length - 6} more new merges`);
}

// ---- writing
function writeData(data, before) {
  const written = [];
  for (const f of SC.FILES) {
    const text = SC.format(data[f]), p = path.join(ROOT, 'data', f + '.json');
    if (before && SC.same(before[f], data[f]) && fs.readFileSync(p, 'utf8') === text) continue;
    if (!DRY) fs.writeFileSync(p, text);
    written.push('data/' + f + '.json');
  }
  return written;
}
// Saves new content: validate, write data/, re-bake db/ and js/data.js, report merge changes.
function commit(data, before, label) {
  const issues = issuesFor(data), errors = issues.filter(i => i.level === 'error');
  if (errors.length) { printIssues(errors); fail(`\nNothing was written: ${errors.length} problem${errors.length > 1 ? 's' : ''} to fix first.`); }
  printIssues(issues.filter(i => i.level === 'warn'));
  const written = writeData(data, before);
  out(`${DRY ? 'Would write' : 'Wrote'} ${written.length ? written.join(', ') : 'nothing (no change)'}${label ? ' · ' + label : ''}`);
  if (flags.has('--no-bake')) { out('Skipped the bake: run node tools/bake.js before committing.'); return; }
  const files = bakeFiles(data), db = readDb(), after = rowsOf(files);
  printCompare(compare(db.rows, after, db.fields), db.rows, after, db.fields);
  if (!DRY) { for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(ROOT, f), text); out('Baked db/ and js/data.js.'); }
}

// ---- values from the command line: JSON if it parses, otherwise plain text
function parseValue(s) {
  if (s == null) fail('Give a value.');
  try { return JSON.parse(s); } catch (e) { return s; }
}

const LISTS = {
  mains: ['essences.mains', x => `${x.code}  ${x.name}  beats ${x.beats}  passive ${x.passive.name}`],
  subs: ['essences.subs', x => `${x.code}  ${x.name.padEnd(8)} ${x.host ? 'on ' + x.host : 'universal'}  ${x.effect}  passive ${x.passive.name}`],
  reactions: ['essences.reactions', (x, k) => `${k}  ${Object.entries(x.names).map(([m, n]) => `${n} (${m} leads)`).join(', ')}${x.volatile ? '  volatile' : ''}`],
  resonances: ['combos.resonances', x => `${x.id.padEnd(12)} ${x.name.padEnd(16)} ${x.subs.join(' + ')}`],
  trinities: ['combos.trinities', x => `${x.id.padEnd(15)} ${x.name.padEnd(17)} ${x.subs.join(' + ')}`],
  anomalies: ['combos.anomalies', x => `${x.id.padEnd(10)} ${x.desc}`],
  classes: ['battle.classes', x => `${x.id.padEnd(8)} ${x.icon} ${x.nouns.length} nouns  ${x.desc}`],
  effects: ['battle.effects', x => `${x.code.padEnd(10)} ${x.name}`],
  statuses: ['battle.statuses', x => `${x.id.padEnd(8)} ${x.icon} ${x.name} (${x.turns} turns)`],
  residue: ['battle.residue', x => `${x.cast}>${x.into}  ${x.name.padEnd(12)} ${x.kind}`],
  traits: ['traits.traits', x => `${x.code.padEnd(10)} ${x.category.padEnd(8)} ${x.nouns.join(', ')}`],
  items: ['items.kinds', x => `${x.kind.padEnd(9)} ${x.name}: ${x.desc}`],
  zones: ['world.zones', x => `${x.id.padEnd(7)} ${x.name.padEnd(15)} ${x.wild.length} wild daemons`],
  trainers: ['world.trainers', x => `${x.id.padEnd(8)} ${x.name.padEnd(18)} ${x.zone}/${x.slot}  team ${x.team.map(m => m.key + ':' + m.level).join(' ')}`],
  npcs: ['world.npcs', x => `${x.id.padEnd(8)} ${x.name.padEnd(16)} at ${x.x},${x.y}  ${x.lines.length} lines`],
  starters: ['world.starters', x => `${x.key.padEnd(6)} attuned to ${x.attune.join(', ')}  ${x.blurb}`],
  rooms: ['world.rooms', x => `${x.zone.padEnd(6)} at ${x.x},${x.y}  ${x.rows[0].length}x${x.rows.length}`],
  overrides: ['overrides', (x, k) => `${k.padEnd(14)} ${Object.keys(x).join(', ')}`],
};
LISTS.people = LISTS.npcs;

function overview(data) {
  const db = readDb(), rows = Object.values(db.rows), fi = f => db.fields.indexOf(f);
  const count = (f, arr) => { const m = {}; for (const r of arr) m[r[fi(f)]] = (m[r[fi(f)]] || 0) + 1; return m; };
  out(`Essence Protocol content (data/): ${data.essences.mains.length} mains, ${data.essences.subs.length} sub-essences, ${data.combos.resonances.length} resonances, ${data.combos.trinities.length} trinities, ${data.combos.anomalies.length} anomaly kinds`);
  out(`Merges (each is a spell, a daemon form and an item): ${rows.length.toLocaleString('en-US')}`);
  out('  by class: ' + Object.entries(count('cls', rows)).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '));
  out('  by rarity: ' + Object.entries(count('rarity', rows)).map(([k, v]) => `${SC.RARITY[k]} ${v}`).join(', '));
  out(`World: ${data.world.zones.length} zones, ${data.world.trainers.length} trainers, ${data.world.npcs.length} people, ${data.world.starters.length} starters · Overrides: ${Object.keys(data.overrides).length}`);
  out('\nCommands: list, get, set, add, remove, merge, find, check, preview, apply, format (see the top of tools/content.js).');
}

function main() {
  const cmd = args[0];
  const data = DATA.load();
  if (!cmd || cmd === 'help') return overview(data);

  if (cmd === 'list') {
    const what = args[1];
    if (!what) { out('Lists: ' + Object.keys(LISTS).join(', ')); return; }
    const L = LISTS[what];
    if (!L) fail(`Unknown list "${what}". Lists: ${Object.keys(LISTS).join(', ')}`);
    const v = SC.getAt(data, L[0]);
    if (JSON_OUT) return out(JSON.stringify(v, null, 1));
    if (Array.isArray(v)) v.forEach(x => out(L[1](x))); else for (const [k, x] of Object.entries(v)) out(L[1](x, k));
    if (!(Array.isArray(v) ? v.length : Object.keys(v).length)) out('(none)');
    return;
  }
  if (cmd === 'get') {
    const p = args[1] || '';
    const r = p ? SC.resolve(data, p) : { found: true, value: data };
    if (!r.found) fail(`Nothing at ${p}.`);
    out(JSON_OUT ? JSON.stringify(r.value) : SC.format(r.value).trimEnd());
    return;
  }
  if (cmd === 'set' || cmd === 'add' || cmd === 'remove') {
    const p = args[1];
    if (!p) fail(`Usage: node tools/content.js ${cmd} <path>${cmd === 'remove' ? '' : ' <value>'}`);
    let op;
    if (cmd === 'set') {
      const value = parseValue(args.slice(2).join(' ') || undefined);
      op = { op: 'set', path: p, value, before: SC.getAt(data, p) };
    } else if (cmd === 'add') {
      const item = parseValue(args.slice(2).join(' ') || undefined);
      const r = SC.resolve(data, p);
      if (!r.found) fail(`Nothing at ${p}.`);
      const node = r.node || {};
      const id = Array.isArray(r.value) ? (node.idOf ? node.idOf(item) : node.id ? item[node.id] : null) : null;
      if (Array.isArray(r.value) && id == null) { op = { op: 'set', path: p, value: r.value.concat([item]), before: r.value }; }
      else if (Array.isArray(r.value)) op = { op: 'add', path: `${p}[${id}]`, value: item };
      else { const k = args[2]; const v = parseValue(args.slice(3).join(' ') || undefined); op = { op: 'add', path: `${p}[${k}]`, value: v }; }
    } else {
      const r = SC.resolve(data, p);
      if (!r.found) fail(`Nothing at ${p}.`);
      op = { op: 'remove', path: p, before: r.value };
    }
    const res = SC.applyOps(data, [op], { force: true });
    if (res.conflicts.length) fail(`Couldn't ${cmd} ${p}: ${res.conflicts[0].why}.`);
    commit(res.data, data, `${cmd} ${SC.describePath(res.data, p) || p}`);
    return;
  }
  if (cmd === 'merge') {
    const key = args[1];
    const { E, B } = modules(data);
    if (!key || !E.validKey(key)) fail('Usage: node tools/content.js merge <key>, e.g. FW-Em1Li2');
    const db = readDb(), row = db.rows[key], r = {};
    db.fields.forEach((f, i) => { r[f] = row[i]; });
    const why = B.explain(key);
    if (JSON_OUT) return out(JSON.stringify({ record: r, why }, null, 1));
    const stat = SC.STAT_KEYS.map((k, i) => `${SC.STAT[k]} ${r.dStats[i]}`).join(', ');
    out(`${key}  ·  ${SC.RARITY[r.rarity]}${r.tags.length ? ' · ' + r.tags.join(', ') : ''}${r.anomaly ? ' · anomaly ' + r.anomaly : ''}`);
    out(`Spell   ${r.name}  (${r.cls}${r.power ? `, power ${r.power}${r.hits > 1 ? '×' + r.hits : ''}` : ''}, accuracy ${r.acc === 101 ? 'never misses' : r.acc}, Flux ${r.flux}, instability ${r.instab}%${r.prio ? ', priority ' + r.prio : ''})`);
    out(`        effects: ${r.fx.map(([c, ch, m]) => `${c} ${ch}%${m ? ' (' + m + ')' : ''}`).join(', ') || 'none'}`);
    if (r.text) out(`        "${r.text}"`);
    out(`Daemon  ${r.dName}  (${stat}; passive from ${r.dPassive})`);
    out(`        "${r.dDesc}"`);
    out(`Item    ${r.item[1]}  (${r.item[0]}, ${SC.TIERS[r.item[3]]}, rolled ${r.item[4]}%)  "${r.item[2]}"`);
    out(`Lineage word ${r.line} · trait leanings ${r.aff.map(([c, w]) => c + ' ' + w).join(', ')}`);
    out(`\nWhy: ${why.pair.name} (${why.pair.id}${why.pair.volatile ? ', volatile' : ''})` + (why.subs.length ? ' with ' + why.subs.map(s => `${s.name} on ${s.host}${s.facet ? ' → ' + s.facet : ''}`).join(', ') : ''));
    if (why.resonances.length || why.trinity) out(`     ${why.trinity ? 'Trinity ' + why.trinity + '. ' : ''}${why.resonances.length ? 'Resonances: ' + why.resonances.join(', ') : ''}`);
    if (why.anomaly) out(`     Anomaly ${why.anomaly.id}: ${why.anomaly.desc}`);
    out('     Trait pushes: ' + Object.entries(why.traits).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${SC.AXIS[k][0]} ${v}`).join(', '));
    out('     Class race: ' + why.classes.map(([c, v]) => `${c} ${v}`).join(', '));
    if (data.overrides[key]) out('     Hand-edited: ' + Object.keys(data.overrides[key]).join(', '));
    return;
  }
  if (cmd === 'find') {
    const q = args.slice(1).join(' ').toLowerCase();
    if (!q) fail('Usage: node tools/content.js find <text>');
    const db = readDb(), fi = f => db.fields.indexOf(f), hits = [], found = [];
    for (const [k, r] of Object.entries(db.rows)) {
      for (const [f, label] of [['name', 'spell'], ['dName', 'daemon']]) if (String(r[fi(f)]).toLowerCase().includes(q)) hits.push(`${k.padEnd(14)} ${label.padEnd(7)} ${r[fi(f)]}`);
      if (r[fi('item')][1].toLowerCase().includes(q)) hits.push(`${k.padEnd(14)} item    ${r[fi('item')][1]}`);
    }
    // content: any string value in data/ that matches, with its path
    (function walk(v, p) {
      if (typeof v === 'string') { if (v.toLowerCase().includes(q)) found.push(`${p.padEnd(40)} ${v.length > 70 ? v.slice(0, 67) + '…' : v}`); return; }
      if (Array.isArray(v)) { const r = SC.resolve(data, p); const node = r.node || {}; v.forEach((x, i) => walk(x, `${p}[${node.idOf ? node.idOf(x) : node.id ? x[node.id] : i}]`)); return; }
      if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, p ? (p === 'overrides' || /reactions$/.test(p) ? `${p}[${k}]` : `${p}.${k}`) : k);
    })(data, '');
    hits.unshift(...found); // content first, then merges
    if (JSON_OUT) return out(JSON.stringify(hits));
    hits.slice(0, 40).forEach(h => out(h));
    out(hits.length ? (hits.length > 40 ? `… ${hits.length} matches in all` : `${hits.length} matches`) : 'No matches.');
    return;
  }
  if (cmd === 'check') {
    const issues = issuesFor(data);
    if (JSON_OUT) { out(JSON.stringify(issues)); process.exitCode = issues.some(i => i.level === 'error') ? 1 : 0; return; }
    printIssues(issues);
    const errors = issues.filter(i => i.level === 'error').length;
    out(errors ? `${errors} error${errors > 1 ? 's' : ''}.` : `data/ is valid${issues.length ? ` (${issues.length} warning${issues.length > 1 ? 's' : ''})` : ''}.`);
    process.exitCode = errors ? 1 : 0;
    return;
  }
  if (cmd === 'preview' || cmd === 'apply') {
    let next = data, changes = null;
    if (args[1]) {
      changes = JSON.parse(fs.readFileSync(args[1], 'utf8'));
      // a change set ({ ops }), or the hosted editor's draft documents as a list (in `seq` order)
      let ops = Array.isArray(changes) ? changes : changes.ops;
      if (Array.isArray(ops)) ops = ops.map(o => (o && o.data && !o.op ? o.data : o)).slice().sort((a, b) => (a.seq || 0) - (b.seq || 0));
      if (!Array.isArray(ops)) fail(`${args[1]} is not a change set (expected { "ops": [...] }).`);
      if (changes.base && changes.base !== SC.hashData(data)) out('Note: these edits were made on an older copy of the content; each one is checked against what is here now.');
      const res = SC.applyOps(data, ops, { force: flags.has('--force') });
      for (const c of res.conflicts) out(`conflict  ${c.op.op} ${c.op.path}: ${c.why}${c.now !== undefined ? ` (now ${JSON.stringify(c.now).slice(0, 80)})` : ''}`);
      out(`${res.applied.length} of ${ops.length} edits apply${res.conflicts.length ? `, ${res.conflicts.length} conflict${res.conflicts.length > 1 ? 's' : ''} (use --force to apply them anyway)` : ''}.`);
      if (Array.isArray(changes.requests) && changes.requests.length) { out('\nRequests that come with it (not applied, they need work):'); changes.requests.forEach(r => out('  - ' + (r.text || r))); out(''); }
      next = res.data;
    } else if (cmd === 'apply') fail('Usage: node tools/content.js apply <changes.json> [--dry] [--force]');
    if (cmd === 'apply') return commit(next, data, `applied ${args[1]}`);
    const issues = issuesFor(next);
    printIssues(issues);
    if (issues.some(i => i.level === 'error')) fail('Fix these before the change can be baked.');
    const files = bakeFiles(next), db = readDb(), after = rowsOf(files), cmp = compare(db.rows, after, db.fields);
    if (JSON_OUT) return out(JSON.stringify(cmp));
    printCompare(cmp, db.rows, after, db.fields);
    const stale = Object.entries(files).filter(([f, t]) => !fs.existsSync(path.join(ROOT, f)) || fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n') !== t).map(([f]) => f);
    if (!args[1]) out(stale.length ? `db/ is stale for data/ as it is now (${stale.length} files): run node tools/bake.js` : 'db/ matches data/.');
    return;
  }
  if (cmd === 'format') {
    const written = SC.FILES.filter(f => fs.readFileSync(path.join(ROOT, 'data', f + '.json'), 'utf8') !== SC.format(data[f]));
    if (!DRY) for (const f of written) fs.writeFileSync(path.join(ROOT, 'data', f + '.json'), SC.format(data[f]));
    out(`${DRY ? 'Would rewrite' : 'Rewrote'} ${written.length} data files in the canonical layout.`);
    return;
  }
  fail(`Unknown command "${cmd}". Run node tools/content.js for the list.`);
}

main();
