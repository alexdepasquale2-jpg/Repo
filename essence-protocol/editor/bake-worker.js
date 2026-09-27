/* Essence Protocol content editor: bakes content off the main thread with the game's own baker.
 *   { id, type: 'bake',  data } -> { id, type: 'done', fields, keys, rows }   (progress messages meanwhile)
 *   { id, type: 'files', data } -> { id, type: 'done', files }               (db/ shards, index, js/data.js) */
'use strict';
// The modules build a default copy from self.EP_DATA when they load, so they load with the
// first content that arrives; later content goes through make().
let loaded = false;
function baker(data) {
  if (!loaded) { self.EP_DATA = data; importScripts('../js/schema.js', '../js/essences.js', '../js/designs.js', '../js/baker.js'); loaded = true; }
  const E = self.ESSENCE.make(data), D = self.DESIGNS.make(E);
  return self.BAKER.make(E, D, self.CONTENT_SCHEMA);
}
async function sha16(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

self.onmessage = async e => {
  const { id, type, data } = e.data;
  try {
    const B = baker(data);
    const shards = B.bakeAll((done, total) => self.postMessage({ id, type: 'progress', done, total }));
    if (type === 'bake') {
      const keys = [], rows = {};
      for (const sh of Object.values(shards)) for (const [k, r] of Object.entries(sh)) { keys.push(k); rows[k] = r; }
      self.postMessage({ id, type: 'done', fields: B.FIELDS, keys, rows });
    } else if (type === 'files') {
      const { files, index } = B.renderAll(shards);
      const shas = {};
      for (const s of index.shards) shas[s.pair] = await sha16(files['db/' + s.pair + '.json']);
      files['db/index.json'] = B.renderIndex(index, p => shas[p]);
      self.postMessage({ id, type: 'done', files });
    } else throw new Error('unknown request ' + type);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
