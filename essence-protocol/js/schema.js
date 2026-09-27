/* Essence Protocol: the content schema and the tools shared by the content editor, tools/content.js
 * and tools/verify.js. Placeholder while the data files are extracted; the full schema follows. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CONTENT_SCHEMA = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- canonical JSON layout for data/*.json: short values stay on one line, lists of words wrap
  const WIDTH = 100;
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  function inline(v) {
    if (Array.isArray(v)) return v.length ? '[' + v.map(inline).join(', ') + ']' : '[]';
    if (isObj(v)) { const ks = Object.keys(v); return ks.length ? '{ ' + ks.map(k => JSON.stringify(k) + ': ' + inline(v[k])).join(', ') + ' }' : '{}'; }
    return JSON.stringify(v);
  }
  function block(v, ind, lead) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    const one = inline(v);
    if (ind.length + lead.length + one.length <= WIDTH) return one;
    const inner = ind + '  ';
    if (Array.isArray(v)) {
      // a map grid (rows of one length) keeps one row per line so the room stays readable
      const grid = v.length >= 3 && v.every(x => typeof x === 'string' && x.length === v[0].length && x.length > 6);
      const prim = !grid && v.every(x => x === null || typeof x !== 'object') && v.every(x => typeof x !== 'string' || x.length <= 40);
      if (prim) { // fill lines with as many words as fit
        const lines = []; let cur = '';
        for (const x of v.map(inline)) {
          if (cur && inner.length + cur.length + 2 + x.length + 1 > WIDTH) { lines.push(cur + ','); cur = x; } else cur = cur ? cur + ', ' + x : x;
        }
        lines.push(cur);
        return '[\n' + lines.map(l => inner + l).join('\n') + '\n' + ind + ']';
      }
      return '[\n' + v.map(x => inner + block(x, inner, '')).join(',\n') + '\n' + ind + ']';
    }
    return '{\n' + Object.keys(v).map(k => { const key = JSON.stringify(k) + ': '; return inner + key + block(v[k], inner, key); }).join(',\n') + '\n' + ind + '}';
  }
  const format = v => block(v, '', '') + '\n';

  // data/<name>.json, in bundle order (js/data.js lists them the same way)
  const FILES = ['essences', 'combos', 'battle', 'traits', 'items', 'words', 'world', 'overrides'];

  return { FILES, format };
});
