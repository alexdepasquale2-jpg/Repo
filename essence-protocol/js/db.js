/* Essence Protocol: the merge database client.
 * tools/bake.js pre-bakes every merge identity, one merge at a time, into db/: one shard per
 * ordered pair of mains (db/FW.json holds every Fire-led, Water-following merge) plus
 * db/index.json with the record layout. A record is an array laid out by `fields`.
 *
 * Browser: open() streams the shards in the background (the title screen is up meanwhile) and
 * resolves once every merge is readable; row() is synchronous after that.
 * Node: the database is read from disk when this module is required. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('fs'), require('path'));
  else root.MERGE_DB = factory(null, null);
})(typeof self !== 'undefined' ? self : this, function (fs, path) {
  'use strict';

  const db = { ready: false, schema: null, version: 0, count: 0, fields: [], rarity: [], shards: [], bytes: 0 };
  const rows = Object.create(null);
  let order = [];

  function take(index) {
    db.schema = index.schema; db.version = index.version; db.count = index.count;
    db.fields = index.fields; db.rarity = index.rarity || []; db.shards = index.shards;
  }
  function put(shard) { for (const k in shard.rows) rows[k] = shard.rows[k]; }
  function finish() {
    order = db.shards.flatMap(s => Object.keys(rows).filter(k => k.slice(0, 2) === s.pair));
    if (order.length !== db.count) throw new Error(`merge database is incomplete: ${order.length}/${db.count} merges`);
    db.ready = true;
  }

  let opening = null;
  // Browser: loads index.json, then every shard in parallel. onProgress(loadedShards, totalShards).
  db.open = function (opts) {
    opts = opts || {};
    if (opening) return opening;
    const base = opts.base || 'db/';
    const get = f => fetch(base + f).then(r => { if (!r.ok) throw new Error(`${base}${f}: HTTP ${r.status}`); return r.json(); });
    opening = get('index.json').then(index => {
      take(index);
      let n = 0;
      if (opts.onProgress) opts.onProgress(0, index.shards.length);
      return Promise.all(index.shards.map(s => get(s.file).then(sh => { put(sh); db.bytes += s.bytes; if (opts.onProgress) opts.onProgress(++n, index.shards.length); })));
    }).then(() => { finish(); return db; });
    opening.catch(() => { opening = null; }); // a failed load can be retried
    return opening;
  };

  db.row = key => rows[key] || null;
  db.has = key => typeof key === 'string' && key in rows;
  db.keys = () => order.slice();

  if (fs) {
    const dir = path.join(__dirname, '..', 'db');
    if (!fs.existsSync(path.join(dir, 'index.json'))) throw new Error('db/ is missing: run `node tools/bake.js`');
    const read = f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    take(read('index.json'));
    for (const s of db.shards) { put(read(s.file)); db.bytes += s.bytes; }
    finish();
  }
  return db;
});
