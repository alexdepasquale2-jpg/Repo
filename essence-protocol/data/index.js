/* Node entry for the content data: require('../data').data is every data/*.json file by name.
 * The browser gets the same object as self.EP_DATA from js/data.js, which tools/bake.js generates. */
'use strict';
const fs = require('fs');
const path = require('path');

const { FILES } = require('../js/schema.js');
function load(dir) {
  dir = dir || __dirname;
  const data = {};
  for (const f of FILES) data[f] = JSON.parse(fs.readFileSync(path.join(dir, f + '.json'), 'utf8'));
  return data;
}

module.exports = { FILES, load, data: load() };
