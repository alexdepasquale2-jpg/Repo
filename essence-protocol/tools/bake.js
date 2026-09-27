#!/usr/bin/env node
/* Essence Protocol: bakes the merge database from the content in data/.
 *
 * The rules and every word live in data/*.json (edit them by hand, with tools/content.js, or in
 * the content editor at editor/). js/baker.js turns them into one record per merge identity,
 * one merge at a time; this script writes the records to db/ (one shard per ordered pair of
 * mains, one merge per line, plus db/index.json) and the browser bundle of data/ to js/data.js.
 *
 *   node tools/bake.js          write db/ and js/data.js
 *   node tools/bake.js --check  exit 1 (and name the stale merges) if db/ or js/data.js is stale
 *
 * Deterministic: the same data always produces the same bytes.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const SC = require('../js/schema.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'db');

// A baker for any content (the committed data/ by default).
function build(data) {
  const E = require('../js/essences.js').make(data || require('../data').load());
  const D = require('../js/designs.js').make(E);
  return require('../js/baker.js').make(E, D, SC);
}
const sha = text => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
// Every generated file for some content, by path relative to essence-protocol/.
function bakeFiles(data, baker) {
  const B = baker || build(data);
  const { files, index } = B.renderAll(B.bakeAll());
  files['db/index.json'] = B.renderIndex(index, pair => sha(files['db/' + pair + '.json']));
  return files;
}
// Files on disk that differ from a fresh bake: [{ file, merges: [keys that changed] }]
function staleFiles(files) {
  const norm = t => t.replace(/\r\n/g, '\n'); // a Windows checkout with core.autocrlf has CRLF
  const stale = [];
  for (const [f, text] of Object.entries(files)) {
    const p = path.join(ROOT, f), cur = fs.existsSync(p) ? norm(fs.readFileSync(p, 'utf8')) : '';
    if (cur === text) continue;
    if (!f.startsWith('db/') || f === 'db/index.json') { stale.push({ file: f, merges: [] }); continue; }
    const have = new Set(cur.split('\n'));
    const merges = text.split('\n').filter(l => l.startsWith('"') && !have.has(l)).map(l => l.slice(1, l.indexOf('"', 1)));
    stale.push({ file: f, merges });
  }
  return stale;
}

module.exports = { build, bakeFiles, staleFiles, sha, OUT, ROOT };

if (require.main === module) {
  const files = bakeFiles();
  if (process.argv.includes('--check')) {
    const stale = staleFiles(files);
    if (stale.length) {
      const list = stale.map(s => s.file + (s.merges.length ? ` (${s.merges.slice(0, 5).join(', ')}${s.merges.length > 5 ? ` and ${s.merges.length - 5} more` : ''})` : ''));
      console.error('the merge database is stale: run `node tools/bake.js`\n  ' + list.join('\n  '));
      process.exit(1);
    }
    console.log('the merge database and js/data.js are up to date');
  } else {
    fs.mkdirSync(OUT, { recursive: true });
    let bytes = 0;
    for (const [f, text] of Object.entries(files)) { fs.writeFileSync(path.join(ROOT, f), text); bytes += Buffer.byteLength(text); }
    const idx = JSON.parse(files['db/index.json']);
    console.log(`baked ${idx.count} merges, one record each, into db/ (${idx.shards.length} shards) and js/data.js (${(bytes / 1024).toFixed(0)} KB)`);
  }
}
