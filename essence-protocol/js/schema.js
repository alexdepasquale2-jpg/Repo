/* Essence Protocol: the content schema, and the tools shared by the content editor (editor/),
 * tools/content.js and tools/verify.js.
 *
 *   SCHEMA          what every field in data/*.json is: its label, help text and rules
 *   validate(data)  problems as [{ level: 'error' | 'warn', path, msg }]
 *   diff / applyOps change sets: [{ op: 'set' | 'add' | 'remove', path, value, before }]
 *   format(value)   the canonical layout of a data file
 *
 * Paths name one value: `essences.subs[Em].desc`, `world.maps[lattice].things[air-a].team`,
 * `overrides[FW-Em1Li2].name`. A list item is picked by its id in brackets (a sub's code, a
 * trainer's id, a residue reaction's `F>W`); words in a word list are edited as the whole list.
 * No dependencies: loaded by the browser (global CONTENT_SCHEMA) and by Node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CONTENT_SCHEMA = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // data/<name>.json, in bundle order (js/data.js lists them the same way)
  const FILES = ['essences', 'combos', 'battle', 'traits', 'items', 'words', 'world', 'overrides'];

  // ---- vocabulary
  const AXES = ['pow', 'grd', 'mnd', 'spd', 'prc', 'hex', 'drn', 'spr', 'per', 'cha'];
  const AXIS = {
    pow: ['Force', 'Raw damage. Pushes merges toward Strike and raises power.'],
    grd: ['Guard', 'Defense. Pushes merges toward Ward and forms toward high Firewall.'],
    mnd: ['Mend', 'Healing. Pushes merges toward Mend and forms toward high HP.'],
    spd: ['Speed', 'Pushes forms toward high Clock; with Gale, merges can act first.'],
    prc: ['Precision', 'Accuracy and Coherence. At 7 or more a merge never misses.'],
    hex: ['Status', 'Status effects. Pushes merges toward Hex and raises effect chances.'],
    drn: ['Drain', 'Pushes merges toward Siphon (damage that heals the caster).'],
    spr: ['Spread', 'Pushes merges toward Barrage (several hits) and Field.'],
    per: ['Persistence', 'Lingering effects. Pushes merges toward Field and forms toward Flux.'],
    cha: ['Chaos', 'Power at a price: raises instability and lowers accuracy.'],
  };
  const STAT_KEYS = ['hp', 'atk', 'def', 'spd', 'flux', 'coh'];
  const STAT = { hp: 'HP', atk: 'Logic', def: 'Firewall', spd: 'Clock', flux: 'Flux', coh: 'Coherence' };
  const TIERS = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary'];
  const SUB_TIERS = ['No subs', 'One sub', 'Two subs', 'Three subs'];
  const FACING = ['down', 'up', 'left', 'right'];
  // Map tiles. `solid` tiles block the way; gates 1-9 open once you hold that many keys.
  // group: which shelf of the builder's palette the tile sits on.
  const TILES = {
    '.': { name: 'Floor', group: 'ground' },
    ',': { name: 'Static', group: 'ground', wild: true, help: 'Wild daemons appear here (if the zone has any).' },
    ':': { name: 'Path', group: 'ground' },
    'S': { name: 'Sand', group: 'ground' },
    '&': { name: 'Flowers', group: 'ground' },
    '=': { name: 'Bridge', group: 'ground' },
    '_': { name: 'Ice', group: 'ground', slide: true, help: 'You slide across until something stops you.' },
    '#': { name: 'Wall', group: 'wall', solid: true },
    'V': { name: 'Void', group: 'wall', solid: true },
    '|': { name: 'Fence', group: 'wall', solid: true },
    'o': { name: 'Boulder', group: 'wall', solid: true },
    '*': { name: 'Tree', group: 'wall', solid: true },
    'x': { name: 'Pillar', group: 'wall', solid: true },
    '+': { name: 'Crystal', group: 'wall', solid: true },
    'L': { name: 'Lamp', group: 'wall', solid: true },
    '~': { name: 'Water', group: 'liquid', solid: true },
    '^': { name: 'Magma', group: 'liquid', solid: true },
    'T': { name: 'Console', group: 'machine', solid: true },
    'B': { name: 'Archive shelf', group: 'machine', solid: true },
    'H': { name: 'Healing terminal', group: 'machine', solid: true, use: 'heal', help: 'Heals the party and becomes the place you wake up after a defeat.' },
    'F': { name: 'Nexus Forge', group: 'machine', solid: true, use: 'forge', help: 'Forges motes into items, and opens the Splice chamber.' },
    'R': { name: 'Rift terminal', group: 'machine', solid: true, use: 'rift', help: 'The endless Rift, open after the final boss falls.' },
  };
  for (let n = 1; n <= 9; n++) TILES[String(n)] = { name: `Gate (${n} key${n > 1 ? 's' : ''})`, group: 'gate', solid: true, keys: n, help: `Opens for a player holding ${n} key${n > 1 ? 's' : ''}.` };
  const TILE_GROUPS = [['ground', 'Ground'], ['wall', 'Walls and obstacles'], ['liquid', 'Water and magma'], ['machine', 'Machines'], ['gate', 'Key gates']];
  const tileName = ch => (TILES[ch] ? TILES[ch].name : `"${ch}"`);
  // Things stand on a map tile. People, trainers, signs, chests and blocks are in the way; warps
  // and triggers are stepped on.
  const THING_TYPES = ['person', 'trainer', 'sign', 'chest', 'warp', 'trigger', 'block'];
  const BLOCKING = new Set(['person', 'trainer', 'sign', 'chest', 'block']);
  const THING = {
    person: ['Person', 'Talks when you face them and press A. Can give a reward once, heal, or set a flag.'],
    trainer: ['Trainer', 'Battles you when they spot you (or when you talk to them). Wardens give keys.'],
    sign: ['Sign', 'Shows its text when you read it.'],
    chest: ['Chest', 'Gives its reward once.'],
    warp: ['Warp', 'Takes you to another place (a door, stairs, a portal) when you step on it.'],
    trigger: ['Trigger', 'Invisible. Runs when you step on it: says lines, gives, heals or sets a flag.'],
    block: ['Block', 'Something in the way, until its condition hides it (a gate that opens after a battle).'],
  };
  const LOOKS = { chest: ['chest', 'cache', 'orb'], warp: ['door', 'stairs', 'portal', 'pad', 'hidden'], block: ['boulder', 'crystal', 'gate', 'barrier', 'tree', 'pillar'] };
  const PARTICLES = ['data', 'wind', 'ember', 'bubble', 'dust', 'spark', 'snow', 'leaf', 'none'];
  const FLAG = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
  // Conditions: words separated by spaces or commas, all must hold. A word is a flag (set by a
  // thing's `sets`), beat:<trainer>, open:<chest>, got:<person> (their gift), keys:<n>, or won;
  // ! in front turns it around.
  function parseCond(str) {
    const out = [];
    for (const w of String(str || '').split(/[\s,]+/).filter(Boolean)) {
      const m = /^(!?)(?:(beat|open|got|keys):([A-Za-z0-9][A-Za-z0-9-]*)|(won)|([A-Za-z0-9][A-Za-z0-9-]*))$/.exec(w);
      if (!m) return null;
      if (m[2] === 'keys' && !/^[1-9]$/.test(m[3])) return null;
      out.push({ not: !!m[1], kind: m[2] || (m[4] ? 'won' : 'flag'), arg: m[3] || m[5] || '' });
    }
    return out;
  }
  function describeCond(str, nameOf) {
    const terms = parseCond(str);
    if (!terms) return 'a condition that doesn\'t parse';
    if (!terms.length) return 'always';
    const nm = id => (nameOf && nameOf(id)) || id;
    return terms.map(t => {
      const s = {
        beat: [`after you beat ${nm(t.arg)}`, `until you beat ${nm(t.arg)}`],
        open: [`after the chest ${nm(t.arg)} is opened`, `until the chest ${nm(t.arg)} is opened`],
        got: [`after ${nm(t.arg)} gave their gift`, `until ${nm(t.arg)} gives their gift`],
        keys: [`with ${t.arg} key${t.arg === '1' ? '' : 's'} or more`, `with fewer than ${t.arg} keys`],
        won: ['after the final boss falls', 'until the final boss falls'],
        flag: [`once "${t.arg}" is set`, `until "${t.arg}" is set`],
      }[t.kind];
      return s[t.not ? 1 : 0];
    }).join(' and ');
  }
  const RARITY = ['Base', 'Compound', 'Resonant', 'Trinity', 'Anomaly'];

  // ---- schema nodes
  const N = (t, label, o) => Object.assign({ t, label }, o || {});
  const text = (label, o) => N('text', label, o);
  const long = (label, o) => N('longtext', label, o);
  const int = (label, min, max, o) => N('int', label, Object.assign({ min, max }, o));
  const num = (label, min, max, o) => N('num', label, Object.assign({ min, max }, o));
  const bool = (label, o) => N('bool', label, o);
  const color = (label, o) => N('color', label, o);
  const words = (label, o) => N('words', label, o);
  const obj = (label, fields, o) => N('object', label, Object.assign({ fields }, o));
  const list = (label, item, o) => N('list', label, Object.assign({ item }, o));
  const map = (label, item, o) => N('map', label, Object.assign({ item }, o));
  const tpl = (label, vars, need, o) => N('template', label, Object.assign({ vars, need: need || [] }, o));

  const CAPWORD = /^[A-Z][A-Za-z'-]*( [A-Za-z][A-Za-z'-]*)*$/;
  const LOWER = /^[a-z]+$/;
  const ONEWORD = /^[A-Z][a-z]+$/;
  const SLUG = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

  const passive = obj('Passive', {
    name: text('Passive name', { max: 20, help: 'Shown on the daemon\'s card, e.g. "Afterburn".' }),
    desc: long('What it says it does', { max: 120, help: 'Keep it true to the mechanic below.' }),
    mechanic: N('enum', 'What it does in battle', { catalog: 'mechanics', help: 'Passives reuse the battle engine\'s mechanics. A new mechanic needs code: ask Claude Code.' }),
  }, { help: 'A daemon gets the passive of its lead sub-essence, or of its lead main when it has no subs.' });
  const effects = (label, o) => N('effects', label, o);
  const axes = (label, o) => N('axes', label, Object.assign({ min: 0, max: 9 }, o));
  const lean = (label, o) => N('lean', label, Object.assign({ min: 0, max: 5 }, o));

  const MAIN = obj('Main essence', {
    code: text('Code', { readonly: true }),
    name: text('Name', { max: 14 }),
    color: color('Color'), deep: color('Shadow color'), light: color('Highlight color'),
    beats: N('main', 'Strong against', { help: 'Merges led by this essence deal ×1.5 to daemons led by that one (and take ×0.67 back).' }),
    traits: axes('Trait pushes', { help: 'How this essence pushes every merge it is in. The lead counts fully, the second main at 60%.' }),
    base: N('stats', 'Base stats', { min: 10, max: 150, help: 'Form stats before level. Merges blend the lead (65%) and second (35%) main.' }),
    passive,
    traitNameAdjectives: words('Trait name adjectives', { min: 1, pattern: CAPWORD, help: 'Start the trait names of daemons with no sub-essences, e.g. "Blazing" Gleaner.' }),
    traitLean: lean('Trait leanings', { help: 'Which daemon traits genomes with this essence lean toward (weights).' }),
    nameRoots: words('Daemon name roots', { min: 1, pattern: /^[A-Z][a-z]*$/, help: 'The first syllable of every daemon led by this essence, e.g. Pyr.' }),
    nameMids: words('Daemon name middles', { min: 1, pattern: LOWER, help: 'Glued after the root for daemons with no subs, chosen by the second main.' }),
    bodies: words('Body descriptions', { min: 1, long: true, max: 60, help: 'The opening of a form description, e.g. "A flickering flame body".' }),
    belly: text('As the second essence', { max: 40, help: 'Added to form descriptions when this is the second main: "…with embers in its belly".' }),
    lineWords: words('Lineage words', { min: 1, pattern: ONEWORD, help: 'Lent to the names of spliced lineages, e.g. the Cinder Line.' }),
  });
  const FACET = obj('Facet', { name: text('Facet name', { max: 16 }), traits: axes('Extra trait pushes'), effect: N('effect', 'Extra effect') });
  const SUB = obj('Sub-essence', {
    code: text('Code', { pattern: /^[A-Z][a-z]$/, readonly: 'existing', help: 'Two letters, capital then lowercase. Saves and merge keys use it, so it can\'t change later.' }),
    name: text('Name', { max: 14 }),
    host: N('main', 'Binds to', { nullable: 'Any main (universal)', help: 'A sub bound to one main only attaches to that main. A universal sub attaches to either main and takes a facet from it.' }),
    desc: long('Description', { max: 140 }),
    color: color('Color', { help: 'The organ it adds to sprites, and its chips.' }),
    traits: axes('Trait pushes', { help: 'Pushes on every merge it joins (70% when bound to the second main).' }),
    effect: N('effect', 'Effect it adds', { help: 'Every merge with this sub gains this effect.' }),
    adjectives: words('Adjectives', { min: 1, pattern: CAPWORD, help: 'Spell names start with one of these, e.g. "Smoldering Inferno Lance". Universal subs use their facet names instead.' }),
    facets: N('facets', 'Facets by host', { when: x => !x.host, help: 'What this universal sub becomes on each main: its name in spells, extra pushes and an extra effect.' }),
    passive,
    traitLean: lean('Trait leanings'),
    nameSyllables: words('Name syllables', { exact: 2, pattern: LOWER, help: 'Long form (the daemon\'s only sub), then short form (one of two or three subs).' }),
    organ: text('Organ in descriptions', { max: 30, help: '"…with ember sparks".' }),
    sprite: N('enum', 'Organ on the sprite', { catalog: 'organs' }),
    eyes: bool('Tints the eyes', { help: 'The daemon\'s eyes glow in this sub\'s color.' }),
    lineWords: words('Lineage words', { min: 1, pattern: ONEWORD }),
  });
  const REACTION = obj('Pair reaction', {
    names: N('leadNames', 'Name by lead', { help: 'What the pair is called when each main leads, e.g. Scald (Fire leads) and Steam (Water leads).' }),
    volatile: bool('Volatile', { help: 'Opposites: merges are less stable and can backfire.' }),
    traits: axes('Trait pushes'),
    effects: effects('Effects'),
    line: long('Line', { max: 120, help: 'One sentence shown before every merge of this pair.' }),
  });
  const COMBO = n => obj(n === 2 ? 'Resonance' : 'Trinity', {
    id: text('Id', { pattern: SLUG, readonly: 'existing', help: 'Lowercase, used by saves and the Codex.' }),
    name: text('Name', { max: 18 }),
    subs: N('subs', 'Sub-essences', { count: n, help: n === 2 ? 'Any merge that has both subs (on any host) resonates.' : 'A merge with exactly these three subs is a Trinity.' }),
    traits: axes('Trait pushes', { max: 9 }),
    effects: effects('Effects'),
  });

  const OVERRIDE = obj('Override', {
    name: text('Spell name', { max: 40, optional: true }),
    text: long('Spell text', { max: 300, optional: true }),
    dName: text('Daemon name', { max: 24, optional: true }),
    dDesc: long('Form description', { max: 300, optional: true }),
    itemName: text('Item name', { max: 48, optional: true }),
    itemLore: long('Item lore', { max: 160, optional: true }),
    line: text('Lineage word', { pattern: ONEWORD, optional: true }),
    power: int('Power', 1, 160, { optional: true, help: 'Only on merges that already deal damage.' }),
    hits: int('Hits', 1, 6, { optional: true }),
    acc: int('Accuracy (101 never misses)', 55, 101, { optional: true }),
    flux: int('Flux cost', 3, 30, { optional: true }),
    prio: int('Priority', -1, 1, { optional: true }),
    instab: int('Instability %', 0, 65, { optional: true }),
    dStats: N('stats', 'Form base stats', { min: 20, max: 200, partial: true, optional: true }),
  });

  // ---- the world: maps of tiles, zones painted over them, and things standing on them
  const is = (...types) => t => types.includes(t.type);
  const MEMBER = obj('Daemon', { key: N('mergeKey', 'Genome'), level: int('Level', 1, 60) });
  const THEME = obj('Theme', {
    id: text('Id', { pattern: SLUG, readonly: 'existing' }),
    name: text('Name', { max: 20 }),
    floor: N('colors', 'Floor (two tones)', { count: 2 }),
    speck: color('Floor specks'), line: color('Floor circuit lines'),
    wall: color('Wall top'), face: color('Wall face'), trim: color('Wall trim (glows)'),
    static: N('colors', 'Static (dark, blades, sparkle)', { count: 3 }),
    obstacle: color('Obstacles (boulders, trees, water)'),
    accent: color('Accent (lights, operators\' outfits)'),
    sky: N('colors', 'Battle sky (top, horizon)', { count: 2 }),
    particles: N('enum', 'Floating particles', { options: PARTICLES }),
  }, { help: 'The colors a zone is drawn in, on the map and behind its battles.' });
  const ZONE = obj('Zone', {
    id: text('Id', { pattern: SLUG, readonly: 'existing' }),
    name: text('Name', { max: 24 }),
    mark: text('Map letter', { pattern: /^[A-Za-z0-9]$/, help: 'The letter that paints this zone in a map\'s zone layer. "." is the map\'s own zone.' }),
    theme: N('enum', 'Theme', { catalog: 'themes' }),
    element: N('main', 'Element', { nullable: 'None' }),
    rate: int('Encounter rate (%)', 0, 50, { help: 'Chance per step on static that a wild daemon appears. 0 turns them off.' }),
    wild: list('Wild daemons', obj('Wild daemon', {
      key: N('mergeKey', 'Genome'),
      min: int('Lowest level', 1, 60), max: int('Highest level', 1, 60),
      weight: int('How common', 1, 20, { help: 'Relative weight: 4 is four times as common as 1.' }),
    }), { idOf: w => w.key }),
  });
  const THINGDEF = obj('Thing', {
    id: text('Id', { pattern: SLUG, readonly: 'existing', help: 'Unique in the world. Saves remember beaten trainers and opened chests by it.' }),
    type: N('enum', 'Kind', { options: THING_TYPES, readonly: true }),
    x: int('Column', 0, 159), y: int('Row', 0, 159),
    name: text('Name', { max: 24, when: is('person', 'trainer') }),
    facing: N('enum', 'Facing', { options: FACING, when: is('person', 'trainer') }),
    color: color('Outfit color', { optional: true, when: is('person', 'trainer'), help: 'Leave empty for the usual look (trainers wear their zone\'s accent).' }),
    look: N('enum', 'Looks like', { options: [...new Set([].concat(...Object.values(LOOKS)))], when: is('chest', 'warp', 'block') }),
    who: text('Speaker', { max: 24, optional: true, when: is('sign', 'trigger', 'block') }),
    lines: N('lines', 'What it says', { min: 1, max: 12, maxLen: 240, when: t => t.type === 'person' || t.type === 'sign' || (t.type === 'trigger' && t.lines !== undefined) || (t.type === 'block' && t.lines !== undefined), help: '{merges} is how many merges exist, in words.' }),
    after: N('lines', 'Later they say', { max: 12, maxLen: 240, optional: true, when: is('person'), help: 'Said instead of the lines above once their gift was given (or their flag is set).' }),
    sight: int('Sight (tiles)', 0, 8, { when: is('trainer'), help: '0 means you have to talk to them.' }),
    warden: bool('Warden', { when: is('trainer') }),
    final: bool('The final boss', { when: is('trainer'), help: 'Beating them wins the game and opens the Rift.' }),
    badge: text('Key they give', { max: 24, optional: true, when: is('trainer') }),
    team: list('Team', MEMBER, { min: 1, max: 6, when: is('trainer') }),
    intro: long('Before the battle', { max: 240, when: is('trainer') }),
    outro: long('After you win', { max: 240, when: is('trainer') }),
    gives: N('reward', 'Gives', { optional: true, when: is('person', 'trainer', 'chest', 'trigger') }),
    heal: bool('Heals your daemons', { when: is('person', 'trigger') }),
    to: obj('Leads to', { map: N('enum', 'Map', { catalog: 'maps' }), x: int('Column', 0, 159), y: int('Row', 0, 159), facing: N('enum', 'Facing', { options: FACING, optional: true }) }, { when: is('warp') }),
    if: text('Only while', { optional: true, max: 200, help: 'A condition: flag, !flag, beat:<trainer>, open:<chest>, got:<person>, keys:<n>, won. All must hold.' }),
    sets: text('Sets flag', { optional: true, pattern: FLAG, help: 'A flag to set afterwards (other things can check it with "Only while").' }),
  });
  const MAP = obj('Map', {
    id: text('Id', { pattern: SLUG, readonly: 'existing' }),
    name: text('Name', { max: 30 }),
    zone: N('enum', 'Zone', { catalog: 'zones', help: 'The zone of every tile whose zone letter is ".".' }),
    tiles: N('grid', 'Tiles'),
    zones: N('zonegrid', 'Zone layer'),
    things: list('Things', THINGDEF, { id: 'id' }),
  });
  const WORLD = obj('World', {
    format: int('Format', 2, 2, { readonly: true }),
    title: text('Title', { max: 40 }),
    about: long('About', { max: 300, optional: true }),
    author: text('Made by', { max: 40, optional: true }),
    start: obj('Start', { map: N('enum', 'Map', { catalog: 'maps' }), x: int('Column', 0, 159), y: int('Row', 0, 159), facing: N('enum', 'Facing', { options: FACING }) }),
    rules: obj('Rules', { mains: N('enum', 'Main essences', { options: ['keys', 'all'], help: 'keys: Air first, one more main per key (the Composer and requests follow it). all: every main from the start.' }) }),
    starters: list('Starters', obj('Starter', {
      key: N('mergeKey', 'Genome'),
      attune: N('subs', 'Starts attuned to', { min: 1, max: 3, forKey: 'key' }),
      blurb: long('Blurb', { max: 120 }),
    }), { idOf: s => s.key, min: 1, max: 8 }),
    themes: list('Themes', THEME, { id: 'id', min: 1 }),
    zones: list('Zones', ZONE, { id: 'id', min: 1, unique: ['mark'] }),
    maps: list('Maps', MAP, { id: 'id', min: 1 }),
    merges: map('Merge edits', OVERRIDE, { keys: 'mergeKey', optional: true, help: 'This world\'s own names and numbers for single merges, on top of the baked ones.' }),
    text: obj('Game lines', {
      guide: text('Who explains the basics', { max: 24 }),
      tutorial: N('lines', 'After you pick a starter', { min: 1, max: 6, maxLen: 240, help: '{daemon} is the starter\'s name.' }),
      ending: N('lines', 'The ending', { optional: true, max: 6, maxLen: 300, help: 'Shown after the final boss. Leave empty for the usual ending.' }),
    }),
  });

  const SCHEMA = obj('Content', {
    essences: obj('Essences', {
      mains: list('Main essences', MAIN, { id: 'code', fixed: true, help: 'Fire, Water, Earth and Air. Adding a main needs code (type chart, zones, sprites): ask Claude Code.' }),
      subs: list('Sub-essences', SUB, { id: 'code', min: 1, max: 24, help: 'Each new sub adds hundreds of merges (665 bound to one main, 2,840 universal).' }),
      reactions: map('Pair reactions', REACTION, { keys: 'pairs' }),
    }),
    combos: obj('Combos', {
      resonances: list('Resonances', COMBO(2), { id: 'id', unique: ['name'] }),
      trinities: list('Trinities', COMBO(3), { id: 'id', unique: ['name'] }),
      anomalies: list('Anomalies', obj('Anomaly', {
        id: text('Id', { readonly: true }),
        desc: long('What it does', { max: 120 }),
        magnitude: int('Magnitude', 0, 100, { help: 'Only overflow (bonus power), mirror (% reflected) use it.' }),
      }), { id: 'id', fixed: true, help: 'About 1 merge in 55 is an anomaly. A new kind needs battle code: ask Claude Code.' }),
    }),
    battle: obj('Battle', {
      classes: list('Classes', obj('Class', {
        id: text('Class', { readonly: true }),
        desc: text('Description', { max: 60 }),
        signature: long('Signature', { max: 160, help: 'What every merge of this class also does. Describes battle code.' }),
        icon: text('Icon', { max: 2 }),
        nouns: words('Spell nouns', { min: 3, unique: true, pattern: CAPWORD, help: 'Spell names end with one of these, e.g. Inferno "Lance". More nouns mean fewer numbered names (II, III).' }),
      }), { id: 'id', fixed: true }),
      effects: list('Effects', obj('Effect', {
        code: text('Code', { readonly: true }),
        name: text('Name', { max: 12 }),
        color: color('Flash color', { optional: true }),
      }), { id: 'code', fixed: true, help: 'Names shown in battle and the Codex. A new effect needs battle code: ask Claude Code.' }),
      statuses: list('Statuses', obj('Status', {
        id: text('Id', { readonly: true }),
        name: text('Name', { max: 12 }),
        turns: int('Turns', 1, 9),
        immune: N('main', 'Immune lead', { nullable: 'Nobody' }),
        icon: text('Icon', { max: 2 }),
        color: color('Color'),
        text: long('Tooltip', { max: 140 }),
      }), { id: 'id', fixed: true }),
      residue: list('Residue reactions', obj('Residue reaction', {
        cast: N('main', 'Merge led by'),
        into: N('main', 'Lands in residue of'),
        name: text('Name', { max: 16 }),
        kind: N('enum', 'Effect', { catalog: 'reactionKinds' }),
      }), { idOf: r => r.cast + '>' + r.into, help: 'When a merge lands in an arena with 2+ residue of an essence, the first matching reaction fires. Each lead reacts in list order.' }),
      combo: long('Combo text', { max: 120 }),
    }),
    traits: obj('Traits', {
      traits: list('Daemon traits', obj('Trait', {
        code: text('Code', { readonly: true }),
        category: text('Kind', { readonly: true }),
        nouns: words('Name nouns', { min: 1, pattern: CAPWORD, help: 'Trait names end with one, e.g. Blazing "Gleaner".' }),
        magnitude: N('tiers', 'Strength by rarity', { of: 'int', min: 1, max: 400 }),
        epithet: text('Epithet', { max: 16, help: 'Second and third codes add "of Plenty and Silence".' }),
        does: text('What it does (in a sentence)', { max: 70, help: 'Continues "This daemon …".' }),
        effect: tpl('Effect text', ['m', 'cd'], ['m'], { help: '{m} is the strength, {cd} the cooldown in steps.' }),
        cap: int('Party cap', 1, 400, { optional: true, help: 'Utility traits add up across the party up to this.' }),
        cooldown: int('Cooldown (steps)', 10, 600, { optional: true }),
        stat: text('Stat', { readonly: true, optional: true }),
      }), { id: 'code', fixed: true, help: 'What each trait does is game code; names, numbers and text are yours. A new trait needs code: ask Claude Code.' }),
      axisLean: N('axisLean', 'Leanings by trait axis', { help: 'How each axis of a merge leans toward traits (the genome\'s strongest four become its trait affinity).' }),
      lineage: obj('Lineages', {
        nouns: N('tiers', 'Lineage nouns by rarity', { of: 'text', pattern: CAPWORD, help: 'The Cinder "Line", the Cinder "Dynasty"…' }),
        statWords: N('statText', 'What a line is known for', { help: '"The line is known for raw Logic."' }),
      }),
    }),
    items: obj('Items', {
      kinds: list('Item kinds', obj('Item kind', {
        kind: text('Kind', { readonly: true }),
        name: text('Name', { max: 14, help: 'Ends every item name of this kind, e.g. "Kindled Scald Script".' }),
        desc: text('What it is', { max: 70 }),
        lore: tpl('Lore', ['from', 'lead', 'second', 'subs'], [], { help: '{from} "Fire and Water motes", {lead} and {second} the mains, {subs} the sub-essences.' }),
      }), { id: 'kind', fixed: true }),
      qualityPrefixes: N('tiers', 'Quality prefixes', { of: 'text', allowEmpty: true, pattern: CAPWORD, help: 'Start item names by quality roll: Fine, Tempered…' }),
    }),
    words: obj('Words', {
      daemonSuffixes: N('suffixes', 'Daemon name endings', { help: 'By how many sub-essences the form has: -bit for Seeds up to -arch for Primes.' }),
      temperaments: N('axisText', 'Temperament sentences', { help: 'End every form description, chosen by the form\'s strongest trait axis.' }),
      templates: obj('Sentence templates', {
        rides: tpl('A sub on its host', ['sub', 'host', 'role'], ['sub']),
        facet: tpl('A universal sub\'s facet', ['sub', 'host', 'role', 'facet'], ['sub', 'facet']),
        resonance: tpl('A resonance', ['subs', 'name'], ['name']),
        trinity: tpl('A trinity', ['name'], ['name']),
        anomaly: tpl('An anomaly', ['desc'], ['desc']),
        unstable: text('Very unstable merges', { max: 60 }),
        formAnomaly: text('Anomaly forms', { max: 60 }),
      }, { help: 'Spell text is built from these. {role} is lead, follow or core.' }),
    }),
    world: WORLD,
    overrides: map('Hand-edited merges', OVERRIDE, { keys: 'mergeKey', help: 'Replace fields of single merges after the rules have run.' }),
  });

  // ---- paths
  function parsePath(p) {
    if (Array.isArray(p)) return p;
    const segs = [];
    const re = /([^.[\]]+)|\[([^\]]*)\]/g;
    let m;
    while ((m = re.exec(p))) segs.push(m[1] != null ? { k: m[1] } : { b: m[2] });
    return segs;
  }
  const pathString = segs => segs.map((s, i) => (s.b != null ? `[${s.b}]` : (i ? '.' : '') + s.k)).join('');
  const idOfItem = (node, item, i) => (node.idOf ? node.idOf(item) : node.id ? item[node.id] : String(i));
  function childNode(node, seg) {
    if (!node) return null;
    if (node.t === 'object') return node.fields[seg.k != null ? seg.k : seg.b] || null;
    if (node.t === 'list' || node.t === 'map') return node.item;
    if (node.t === 'suffixes' || node.t === 'lines') return null;
    return null;
  }
  // Follows a path through data (and the schema). { value, node, parent, key, index, found }
  function resolve(data, path) {
    const segs = parsePath(path);
    let cur = data, node = SCHEMA, parent = null, key = null, index = -1;
    for (const seg of segs) {
      if (cur == null || typeof cur !== 'object') return { found: false };
      parent = cur;
      if (Array.isArray(cur)) {
        const want = seg.b != null ? seg.b : seg.k;
        index = node && (node.id || node.idOf) ? cur.findIndex((x, i) => idOfItem(node, x, i) === want) : +want;
        if (!(index >= 0 && index < cur.length)) return { found: false, parent, node: childNode(node, seg), key: want, index: -1 };
        key = index; cur = cur[index];
      } else {
        key = seg.b != null ? seg.b : seg.k; index = -1;
        if (!(key in cur)) return { found: false, parent, node: childNode(node, seg), key };
        cur = cur[key];
      }
      node = childNode(node, seg);
    }
    return { found: true, value: cur, node, parent, key, index };
  }
  const getAt = (data, path) => { const r = resolve(data, path); return r.found ? r.value : undefined; };
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // ---- change sets
  // Minimal operations that turn `base` into `cur`: lists with ids and maps are compared item by
  // item (added, removed, changed field by field); everything else is set whole.
  function diff(base, cur, node, path, out) {
    node = node || SCHEMA; path = path || []; out = out || [];
    if (same(base, cur)) return out;
    const at = extra => pathString(path.concat(extra));
    if (node && node.t === 'object' && base && cur && typeof base === 'object' && typeof cur === 'object' && !Array.isArray(base)) {
      for (const k of new Set(Object.keys(base).concat(Object.keys(cur)))) {
        const f = node.fields[k];
        if (!(k in cur)) out.push({ op: 'remove', path: at({ k }), before: clone(base[k]) });
        else if (!(k in base)) out.push({ op: 'set', path: at({ k }), value: clone(cur[k]), before: null });
        else if (f) diff(base[k], cur[k], f, path.concat({ k }), out);
        else if (!same(base[k], cur[k])) out.push({ op: 'set', path: at({ k }), value: clone(cur[k]), before: clone(base[k]) });
      }
      return out;
    }
    if (node && node.t === 'list' && (node.id || node.idOf) && Array.isArray(base) && Array.isArray(cur)) {
      const ids = arr => arr.map((x, i) => idOfItem(node, x, i));
      const bi = ids(base), ci = ids(cur);
      const dup = a => new Set(a).size !== a.length;
      if (dup(bi) || dup(ci)) { out.push({ op: 'set', path: pathString(path), value: clone(cur), before: clone(base) }); return out; }
      for (let i = 0; i < base.length; i++) if (!ci.includes(bi[i])) out.push({ op: 'remove', path: at({ b: bi[i] }), before: clone(base[i]) });
      for (let i = 0; i < cur.length; i++) {
        const j = bi.indexOf(ci[i]);
        if (j < 0) out.push({ op: 'add', path: at({ b: ci[i] }), value: clone(cur[i]) });
        else diff(base[j], cur[i], node.item, path.concat({ b: ci[i] }), out);
      }
      // a pure reorder of the same items is written as the whole list
      const kept = ci.filter(x => bi.includes(x)), keptBase = bi.filter(x => ci.includes(x));
      if (!same(kept, keptBase)) {
        for (let n = out.length - 1; n >= 0; n--) if (out[n].path.startsWith(pathString(path) + '[')) out.splice(n, 1);
        out.push({ op: 'set', path: pathString(path), value: clone(cur), before: clone(base) });
      }
      return out;
    }
    if (node && node.t === 'map' && base && cur && typeof base === 'object' && typeof cur === 'object') {
      for (const k of new Set(Object.keys(base).concat(Object.keys(cur)))) {
        if (!(k in cur)) out.push({ op: 'remove', path: at({ b: k }), before: clone(base[k]) });
        else if (!(k in base)) out.push({ op: 'add', path: at({ b: k }), value: clone(cur[k]) });
        else diff(base[k], cur[k], node.item, path.concat({ b: k }), out);
      }
      return out;
    }
    out.push({ op: 'set', path: pathString(path), value: clone(cur), before: clone(base) });
    return out;
  }
  // Applies a change set to a copy of `data`. An op whose `before` no longer matches what is there
  // (someone else changed it since) is a conflict: it is skipped and reported unless opts.force.
  // Removing something that is already gone counts as done.
  function applyOps(data, ops, opts) {
    opts = opts || {};
    const out = clone(data), conflicts = [], applied = [];
    const eq = (a, b) => same(a == null ? null : a, b == null ? null : b);
    for (const op of ops) {
      const segs = parsePath(op.path || '');
      if (!segs.length) { conflicts.push({ op, why: 'it has no path' }); continue; }
      const last = segs[segs.length - 1], lastKey = last.b != null ? last.b : last.k;
      const par = segs.length > 1 ? resolve(out, segs.slice(0, -1)) : { found: true, value: out, node: SCHEMA };
      if (!par.found || !par.value || typeof par.value !== 'object') { conflicts.push({ op, why: 'the place it goes no longer exists' }); continue; }
      const container = par.value, listNode = Array.isArray(container) ? par.node : null;
      const here = resolve(out, segs), now = here.found ? here.value : undefined;
      if (op.op === 'add') {
        if (here.found) { if (eq(now, op.value)) { applied.push(op); continue; } conflicts.push({ op, why: 'something with that id already exists', now }); continue; }
        if (Array.isArray(container)) container.push(clone(op.value)); else container[lastKey] = clone(op.value);
      } else if (op.op === 'remove') {
        if (!here.found) { applied.push(op); continue; }
        if (!opts.force && op.before !== undefined && !eq(now, op.before)) { conflicts.push({ op, why: 'it changed since the edit was made', now }); continue; }
        if (Array.isArray(container)) container.splice(here.index, 1); else delete container[here.key];
      } else if (op.op === 'set') {
        if (!opts.force && op.before !== undefined && !eq(now, op.before) && !eq(now, op.value)) { conflicts.push({ op, why: 'it changed since the edit was made', now }); continue; }
        if (Array.isArray(container)) {
          if (here.found) container[here.index] = clone(op.value);
          else if (listNode && (listNode.id || listNode.idOf)) container.push(clone(op.value));
          else { const i = +lastKey; if (!(Number.isInteger(i) && i >= 0 && i <= container.length)) { conflicts.push({ op, why: 'there is no item ' + lastKey }); continue; } container[i] = clone(op.value); }
        } else container[lastKey] = clone(op.value);
      } else { conflicts.push({ op, why: 'unknown operation ' + op.op }); continue; }
      applied.push(op);
    }
    return { data: out, applied, conflicts };
  }

  // A readable name for a path: "Ember › Passive › Passive name"
  function describePath(data, path) {
    const segs = parsePath(path), parts = [];
    let node = SCHEMA, cur = data;
    for (const seg of segs) {
      const k = seg.b != null ? seg.b : seg.k;
      if (node && node.t === 'object') { const f = node.fields[k]; parts.push(f ? f.label : k); node = f; cur = cur && cur[k]; continue; }
      if (node && node.t === 'list') {
        let item = null;
        if (Array.isArray(cur)) item = cur.find((x, i) => idOfItem(node, x, i) === k) || (node.id || node.idOf ? null : cur[+k]);
        parts.push(item && (item.name || item.title) ? item.name : k);
        node = node.item; cur = item; continue;
      }
      if (node && node.t === 'map') { parts.push(k); node = node.item; cur = cur && cur[k]; continue; }
      parts.push(k); node = null; cur = cur && cur[k];
    }
    return parts.join(' › ');
  }

  // ---- validation
  // ctx (optional): { mechanics: [...], organs: [...], reactionKinds: [...] } from the engine and
  // sprites, and validKey(key) from ESSENCE (merge keys are only checked when it is given).
  function validate(data, ctx) {
    ctx = ctx || {};
    const out = [];
    const err = (path, msg) => out.push({ level: 'error', path, msg });
    const warn = (path, msg) => out.push({ level: 'warn', path, msg });
    if (!data || typeof data !== 'object') { err('', 'no data'); return out; }
    for (const f of FILES) if (!data[f] || typeof data[f] !== 'object') err(f, `data/${f}.json is missing`);
    if (out.length) return out;
    const mains = (data.essences.mains || []).map(m => m.code);
    const subs = (data.essences.subs || []).map(s => s.code);
    const effectCodes = (data.battle.effects || []).map(f => f.code);
    const traitCodes = (data.traits.traits || []).map(t => t.code);
    const W0 = data.world || {};
    const ids = list => (Array.isArray(list) ? list.map(x => x && x.id) : []);
    const catalogs = { mechanics: ctx.mechanics, organs: ctx.organs, reactionKinds: ctx.reactionKinds, maps: ids(W0.maps), themes: ids(W0.themes), zones: ids(W0.zones) };
    const subOf = code => (data.essences.subs || []).find(s => s.code === code);

    function check(node, v, path, owner) {
      const P = pathString(path);
      if (node.when && owner && !node.when(owner)) { if (v !== undefined && v !== null) warn(P, `${node.label} is not used here`); return; }
      if (v === undefined || v === null) {
        if (node.optional) return;
        if (v === null && (node.nullable || (node.t === 'main' && node.nullable))) return;
        if (node.t === 'bool') return;
        err(P, `${node.label} is missing`); return;
      }
      const isStr = typeof v === 'string', isNum = typeof v === 'number' && isFinite(v);
      switch (node.t) {
        case 'text': case 'longtext': {
          if (!isStr) return err(P, `${node.label} must be text`);
          if (!v.trim() && !node.allowEmpty) return err(P, `${node.label} is empty`);
          if (node.max && v.length > node.max) err(P, `${node.label} is too long (${v.length}/${node.max} characters)`);
          if (node.pattern && v && !node.pattern.test(v)) err(P, `${node.label} "${v}" doesn't fit the pattern (${patternHelp(node.pattern)})`);
          return;
        }
        case 'template': {
          if (!isStr || !v.trim()) return err(P, `${node.label} is empty`);
          for (const m of v.match(/\{(\w+)\}/g) || []) if (!node.vars.includes(m.slice(1, -1))) err(P, `${node.label} has an unknown placeholder ${m} (use ${node.vars.map(x => '{' + x + '}').join(', ')})`);
          for (const x of node.need) if (!v.includes('{' + x + '}')) err(P, `${node.label} must include {${x}}`);
          return;
        }
        case 'int': case 'num': {
          if (!isNum) return err(P, `${node.label} must be a number`);
          if (node.t === 'int' && !Number.isInteger(v)) err(P, `${node.label} must be a whole number`);
          if (node.min != null && v < node.min) err(P, `${node.label} must be at least ${node.min}`);
          if (node.max != null && v > node.max) err(P, `${node.label} must be at most ${node.max}`);
          return;
        }
        case 'bool': if (typeof v !== 'boolean') err(P, `${node.label} must be true or false`); return;
        case 'color': if (!isStr || !/^#[0-9a-fA-F]{6}$/.test(v)) err(P, `${node.label} must be a color like #ff6b3d`); return;
        case 'enum': {
          const opts = node.options || catalogs[node.catalog];
          if (opts && !opts.includes(v)) err(P, `${node.label}: "${v}" is not one of ${opts.join(', ')}`);
          return;
        }
        case 'main': if (!mains.includes(v)) err(P, `${node.label}: "${v}" is not a main essence`); return;
        case 'effect': if (!effectCodes.includes(v)) err(P, `${node.label}: "${v}" is not an effect`); return;
        case 'subs': {
          if (!Array.isArray(v)) return err(P, `${node.label} must be a list of sub-essences`);
          if (node.count && v.length !== node.count) err(P, `${node.label} needs exactly ${node.count} different sub-essences`);
          if (node.min && v.length < node.min) err(P, `${node.label} needs at least ${node.min}`);
          if (node.max && v.length > node.max) err(P, `${node.label} takes at most ${node.max}`);
          if (new Set(v).size !== v.length) err(P, `${node.label} lists a sub-essence twice`);
          for (const s of v) if (!subs.includes(s)) err(P, `${node.label}: "${s}" is not a sub-essence`);
          return;
        }
        case 'effects': {
          if (!Array.isArray(v)) return err(P, `${node.label} must be a list`);
          v.forEach((f, i) => {
            if (!f || !effectCodes.includes(f.effect)) err(P, `${node.label} #${i + 1}: "${f && f.effect}" is not an effect`);
            if (!f || !(typeof f.chance === 'number' && f.chance >= 1 && f.chance <= 100)) err(P, `${node.label} #${i + 1}: chance must be 1 to 100`);
          });
          if (new Set(v.map(f => f && f.effect)).size !== v.length) warn(P, `${node.label} lists an effect twice (their chances stack)`);
          return;
        }
        case 'axes': case 'lean': {
          if (!v || typeof v !== 'object' || Array.isArray(v)) return err(P, `${node.label} must be a set of weights`);
          const known = node.t === 'axes' ? AXES : traitCodes;
          for (const [k, w] of Object.entries(v)) {
            if (!known.includes(k)) err(P, `${node.label}: "${k}" is not a ${node.t === 'axes' ? 'trait axis' : 'trait'}`);
            if (typeof w !== 'number' || !isFinite(w) || w < node.min || w > node.max) err(P, `${node.label}: ${k} must be ${node.min} to ${node.max}`);
          }
          return;
        }
        case 'axisLean': {
          if (!v || typeof v !== 'object') return err(P, `${node.label} is missing`);
          for (const [ax, o] of Object.entries(v)) {
            if (!AXES.includes(ax)) err(P, `${node.label}: "${ax}" is not a trait axis`);
            for (const [k, w] of Object.entries(o || {})) {
              if (!traitCodes.includes(k)) err(P, `${node.label} ${ax}: "${k}" is not a trait`);
              if (typeof w !== 'number' || w < 0 || w > 5) err(P, `${node.label} ${ax}: ${k} must be 0 to 5`);
            }
          }
          return;
        }
        case 'stats': {
          if (!v || typeof v !== 'object') return err(P, `${node.label} must be a set of stats`);
          for (const k of Object.keys(v)) if (!STAT_KEYS.includes(k)) err(P, `${node.label}: "${k}" is not a stat`);
          for (const k of STAT_KEYS) {
            if (!(k in v)) { if (!node.partial) err(P, `${node.label}: ${STAT[k]} is missing`); continue; }
            if (typeof v[k] !== 'number' || !Number.isInteger(v[k]) || v[k] < node.min || v[k] > node.max) err(P, `${node.label}: ${STAT[k]} must be a whole number from ${node.min} to ${node.max}`);
          }
          return;
        }
        case 'statText': {
          for (const k of STAT_KEYS) if (typeof (v || {})[k] !== 'string' || !v[k].trim()) err(P, `${node.label}: ${STAT[k]} is missing`);
          return;
        }
        case 'axisText': {
          for (const k of AXES) if (typeof (v || {})[k] !== 'string' || !v[k].trim()) err(P, `${node.label}: ${AXIS[k][0]} is missing`);
          return;
        }
        case 'words': case 'lines': {
          if (!Array.isArray(v)) return err(P, `${node.label} must be a list`);
          if (node.exact && v.length !== node.exact) err(P, `${node.label} needs exactly ${node.exact}`);
          if (node.min && v.length < node.min) err(P, `${node.label} needs at least ${node.min}`);
          if (node.max && node.t === 'lines' && v.length > node.max) err(P, `${node.label} takes at most ${node.max}`);
          v.forEach((w, i) => {
            if (typeof w !== 'string' || !w.trim()) return err(P, `${node.label} #${i + 1} is empty`);
            if (node.pattern && !node.pattern.test(w)) err(P, `${node.label}: "${w}" doesn't fit the pattern (${patternHelp(node.pattern)})`);
            const mx = node.t === 'lines' ? node.maxLen : node.max;
            if (mx && w.length > mx) err(P, `${node.label} #${i + 1} is too long (${w.length}/${mx})`);
          });
          if (node.t === 'words' && new Set(v).size !== v.length) (node.unique ? err : warn)(P, `${node.label} has a repeated word`);
          return;
        }
        case 'tiers': {
          if (!Array.isArray(v) || v.length !== 5) return err(P, `${node.label} needs one value per rarity (5)`);
          v.forEach((x, i) => {
            if (node.of === 'int') { if (typeof x !== 'number' || !Number.isInteger(x) || x < node.min || x > node.max) err(P, `${node.label}: ${TIERS[i]} must be ${node.min} to ${node.max}`); }
            else if (typeof x !== 'string' || (!x.trim() && !(node.allowEmpty && i === 0))) err(P, `${node.label}: ${TIERS[i]} is empty`);
            else if (x && node.pattern && !node.pattern.test(x)) err(P, `${node.label}: "${x}" doesn't fit the pattern (${patternHelp(node.pattern)})`);
          });
          return;
        }
        case 'suffixes': {
          if (!Array.isArray(v) || v.length !== 4) return err(P, `${node.label} needs 4 lists (no subs to three subs)`);
          v.forEach((l, i) => {
            if (!Array.isArray(l) || !l.length) err(P, `${node.label}: ${SUB_TIERS[i]} needs at least one ending`);
            else l.forEach(w => { if (typeof w !== 'string' || !LOWER.test(w)) err(P, `${node.label}: "${w}" must be lowercase letters`); });
          });
          return;
        }
        case 'leadNames': {
          if (!v || typeof v !== 'object') return err(P, `${node.label} is missing`);
          const pair = path[path.length - 2] && (path[path.length - 2].b || path[path.length - 2].k);
          const need = pair ? [...new Set(pair.split(''))] : [];
          for (const m of need) if (typeof v[m] !== 'string' || !v[m].trim()) err(P, `${node.label}: the name when ${m} leads is missing`);
          for (const [m, nm] of Object.entries(v)) { if (!need.includes(m)) err(P, `${node.label}: ${m} is not in this pair`); else if (nm.length > 14) err(P, `${node.label}: "${nm}" is too long (14 characters)`); }
          return;
        }
        case 'facets': {
          if (!v || typeof v !== 'object') return err(P, `${node.label}: a universal sub needs a facet for every main`);
          for (const m of mains) { if (!v[m]) err(P, `${node.label}: the facet on ${m} is missing`); else check(FACET, v[m], path.concat({ k: m }), owner); }
          for (const m of Object.keys(v)) if (!mains.includes(m)) err(P, `${node.label}: "${m}" is not a main essence`);
          return;
        }
        case 'mergeKey': {
          if (!isStr) return err(P, `${node.label} must be a merge key like FW-Em1Li2`);
          if (ctx.validKey && !ctx.validKey(v)) err(P, `${node.label}: "${v}" is not a merge (keys look like FW-Em1Li2, subs in essence order)`);
          return;
        }
        case 'grid': case 'zonegrid': {
          if (!Array.isArray(v) || !v.length) return err(P, `${node.label} is empty`);
          const w = typeof v[0] === 'string' ? v[0].length : 0;
          if (node.t === 'grid' && (w < 4 || v.length < 4 || w > 160 || v.length > 160)) err(P, `${node.label}: a map is 4 to 160 tiles wide and high (this one is ${w} × ${v.length})`);
          const marks = new Set(['.'].concat((W0.zones || []).map(z => z && z.mark)));
          v.forEach((row, y) => {
            if (typeof row !== 'string') return err(P, `${node.label} row ${y + 1} is not text`);
            if (row.length !== w) err(P, `${node.label} row ${y + 1} is ${row.length} tiles wide, the first row is ${w}`);
            for (const ch of row) {
              if (node.t === 'grid' ? !TILES[ch] : !marks.has(ch)) { err(P, `${node.label} row ${y + 1}: "${ch}" is not ${node.t === 'grid' ? 'a tile' : 'a zone letter'}`); break; }
            }
          });
          return;
        }
        case 'colors': {
          if (!Array.isArray(v) || v.length !== node.count) return err(P, `${node.label} needs ${node.count} colors`);
          v.forEach((c, i) => { if (typeof c !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(c)) err(P, `${node.label} #${i + 1} must be a color like #ff6b3d`); });
          return;
        }
        case 'reward': {
          if (!v || typeof v !== 'object' || Array.isArray(v)) return err(P, `${node.label} must be a reward`);
          const count = (k, n) => { if (!(Number.isInteger(n) && n >= 1 && n <= 99)) err(P, `${node.label}: ${k} must be a whole number from 1 to 99`); };
          const known = ['lattices', 'cells', 'motes', 'daemon', 'item'];
          for (const k of Object.keys(v)) if (!known.includes(k)) err(P, `${node.label}: "${k}" is not something a reward can give (${known.join(', ')})`);
          if (!Object.keys(v).length) err(P, `${node.label} is empty`);
          if (v.lattices != null) count('lattices', v.lattices);
          if (v.cells != null) count('cells', v.cells);
          if (v.motes != null) {
            if (!v.motes || typeof v.motes !== 'object') err(P, `${node.label}: motes must be a set of essence counts`);
            else for (const [c, n] of Object.entries(v.motes)) { if (!mains.includes(c) && !subs.includes(c)) err(P, `${node.label}: "${c}" is not an essence`); count(c + ' motes', n); }
          }
          if (v.daemon != null) {
            if (!v.daemon || typeof v.daemon !== 'object') err(P, `${node.label}: the daemon needs a genome and a level`);
            else {
              if (ctx.validKey && !ctx.validKey(v.daemon.key)) err(P, `${node.label}: "${v.daemon.key}" is not a merge`);
              if (!(Number.isInteger(v.daemon.level) && v.daemon.level >= 1 && v.daemon.level <= 60)) err(P, `${node.label}: the daemon's level must be 1 to 60`);
            }
          }
          if (v.item != null && ctx.validKey && !ctx.validKey(v.item)) err(P, `${node.label}: the item is forged from a merge, and "${v.item}" is not one`);
          return;
        }
        case 'object': {
          if (!v || typeof v !== 'object' || Array.isArray(v)) return err(P, `${node.label} must be an object`);
          for (const [k, f] of Object.entries(node.fields)) check(f, v[k], path.concat({ k }), v);
          for (const k of Object.keys(v)) if (!node.fields[k]) warn(pathString(path.concat({ k })), `"${k}" is not a field of ${node.label} and is ignored`);
          return;
        }
        case 'list': {
          if (!Array.isArray(v)) return err(P, `${node.label} must be a list`);
          if (node.min && v.length < node.min) err(P, `${node.label} needs at least ${node.min}`);
          if (node.max && v.length > node.max) err(P, `${node.label} takes at most ${node.max}`);
          const seen = new Map();
          v.forEach((x, i) => {
            const id = idOfItem(node, x || {}, i);
            if ((node.id || node.idOf) && seen.has(id)) err(pathString(path.concat({ b: id })), `${node.label}: "${id}" appears twice`);
            seen.set(id, i);
            check(node.item, x, path.concat({ b: node.id || node.idOf ? id : String(i) }), owner);
          });
          for (const f of node.unique || []) {
            const vals = v.map(x => x && x[f]).filter(Boolean);
            const dup = vals.find((x, i) => vals.indexOf(x) !== i);
            if (dup) err(P, `${node.label}: two have the ${f} "${dup}"`);
          }
          return;
        }
        case 'map': {
          if (!v || typeof v !== 'object' || Array.isArray(v)) return err(P, `${node.label} must be an object`);
          for (const [k, x] of Object.entries(v)) {
            if (node.keys === 'mergeKey' && ctx.validKey && !ctx.validKey(k)) err(pathString(path.concat({ b: k })), `"${k}" is not a merge key`);
            check(node.item, x, path.concat({ b: k }), owner);
          }
          return;
        }
        default: warn(P, `unknown field type ${node.t}`);
      }
    }
    // cross-field rules of a world (also used on player-made worlds, see validateWorld)
    function worldRules(W) {
      const maps = new Map(W.maps.filter(m => m && m.id).map(m => [m.id, m]));
      const size = m => ({ w: ((m.tiles || [])[0] || '').length, h: (m.tiles || []).length });
      const tileOf = (m, x, y) => ((m.tiles || [])[y] || '')[x];
      const label = t => t.name || `${THING[t.type] ? THING[t.type][0] : 'Thing'} ${t.id}`;
      const all = new Map(), at = new Map();
      for (const m of W.maps) {
        if (!m || !Array.isArray(m.things) || !Array.isArray(m.tiles)) continue;
        const { w, h } = size(m);
        if (Array.isArray(m.zones) && (m.zones.length !== h || (m.zones[0] || '').length !== w)) err(`world.maps[${m.id}].zones`, `the zone layer is ${(m.zones[0] || '').length} × ${m.zones.length} but the tiles are ${w} × ${h}`);
        for (const t of m.things) {
          if (!t || !t.id) continue;
          const P = `world.maps[${m.id}].things[${t.id}]`;
          if (all.has(t.id)) err(P, `the id "${t.id}" is also used on the map ${all.get(t.id).map}`);
          else all.set(t.id, { t, map: m.id, P });
          if (!(t.x >= 0 && t.y >= 0 && t.x < w && t.y < h)) { err(P, `${label(t)} stands outside the map (${t.x},${t.y}; the map is ${w} × ${h})`); continue; }
          const T = TILES[tileOf(m, t.x, t.y)];
          if (BLOCKING.has(t.type) && t.type !== 'block' && T && T.solid) err(P, `${label(t)} stands on a ${T.name.toLowerCase()} at ${t.x},${t.y}`);
          if (t.type === 'trigger' && T && T.solid) warn(P, `this trigger sits on a ${T.name.toLowerCase()}, where nobody can step`);
          const spot = m.id + ':' + t.x + ',' + t.y;
          if (at.has(spot)) err(P, `${label(t)} shares the tile ${t.x},${t.y} with ${at.get(spot)}`);
          at.set(spot, label(t));
          if (LOOKS[t.type] && t.look != null && !LOOKS[t.type].includes(t.look)) err(P + '.look', `a ${t.type} can look like ${LOOKS[t.type].join(', ')}`);
          if (t.if != null && !parseCond(t.if)) err(P + '.if', `"${t.if}" is not a condition (use flag, !flag, beat:<trainer>, open:<chest>, got:<person>, keys:<n> or won)`);
          if (t.type === 'warp' && t.to) {
            const d = maps.get(t.to.map);
            if (d) { const s2 = size(d); if (!(t.to.x >= 0 && t.to.y >= 0 && t.to.x < s2.w && t.to.y < s2.h)) err(P + '.to', `the warp leads outside ${d.name} (${t.to.x},${t.to.y})`); }
          }
          if (t.type === 'chest' && !t.gives) err(P + '.gives', 'a chest needs something inside');
          if (t.type === 'trainer' && t.final && !t.warden) warn(P + '.final', 'the final boss should also be a Warden');
          if (t.type === 'trigger' && !t.lines && !t.gives && !t.heal && !t.sets) warn(P, 'this trigger does nothing yet: give it lines, a reward, healing or a flag');
        }
      }
      // conditions name things that exist; checked flags are set somewhere
      const setFlags = new Set([...all.values()].map(o => o.t.sets).filter(Boolean));
      for (const { t, P } of all.values()) {
        for (const c of parseCond(t.if) || []) {
          const want = { beat: 'trainer', open: 'chest', got: 'person' }[c.kind];
          if (want) {
            const o = all.get(c.arg);
            if (!o) err(P + '.if', `${c.kind}:${c.arg} names nothing in this world`);
            else if (o.t.type !== want) err(P + '.if', `${c.kind}: needs a ${want}, and ${c.arg} is a ${o.t.type}`);
            else if (c.kind === 'got' && !o.t.gives) warn(P + '.if', `${o.t.name || c.arg} has no gift, so got:${c.arg} never happens`);
          }
          if (c.kind === 'flag' && !setFlags.has(c.arg)) warn(P + '.if', `nothing sets the flag "${c.arg}"`);
        }
      }
      // the start
      const sm = W.start && maps.get(W.start.map);
      if (sm) {
        const { w, h } = size(sm), T = TILES[tileOf(sm, W.start.x, W.start.y)];
        if (!(W.start.x >= 0 && W.start.y >= 0 && W.start.x < w && W.start.y < h)) err('world.start', `the start is outside ${sm.name}`);
        else if (T && T.solid) err('world.start', `the start is on a ${T.name.toLowerCase()}`);
        else if (at.has(sm.id + ':' + W.start.x + ',' + W.start.y)) err('world.start', `the start is where ${at.get(sm.id + ':' + W.start.x + ',' + W.start.y)} stands`);
      }
      // trainers: one final boss at most, and enough keys for the gates
      const trainers = [...all.values()].filter(o => o.t.type === 'trainer').map(o => o.t);
      const finals = trainers.filter(t => t.final);
      if (finals.length > 1) err('world.maps', `only one trainer can be the final boss (now ${finals.length}: ${finals.map(t => t.name).join(', ')})`);
      const keyNames = trainers.filter(t => t.badge).map(t => t.badge);
      const dup = keyNames.find((k, i) => keyNames.indexOf(k) !== i);
      if (dup) warn('world.maps', `two trainers give the "${dup}"; a player holds it once, so it counts once`);
      let most = 0;
      for (const m of W.maps) for (const row of (m && m.tiles) || []) for (const ch of String(row)) if (TILES[ch] && TILES[ch].keys > most) most = TILES[ch].keys;
      for (const { t } of all.values()) for (const c of parseCond(t.if) || []) if (c.kind === 'keys' && !c.not && +c.arg > most) most = +c.arg;
      const giving = new Set(keyNames).size;
      if (most > giving) warn('world.maps', `something needs ${most} key${most > 1 ? 's' : ''} but only ${giving} trainer${giving === 1 ? ' gives' : 's give'} a key`);
      // wild levels, starters
      for (const z of W.zones) for (const w of (z && z.wild) || []) if (w.min > w.max) err(`world.zones[${z.id}].wild[${w.key}]`, 'the lowest level is above the highest');
      for (const s of W.starters || []) {
        const ms = typeof s.key === 'string' ? [s.key[0], s.key[1]] : [];
        for (const a of s.attune || []) { const sub = subOf(a); if (sub && sub.host && !ms.includes(sub.host)) err(`world.starters[${s.key}].attune`, `${sub.name} binds to ${sub.host}, which this genome doesn't have`); }
      }
      const seenName = new Map();
      for (const [k, o] of Object.entries(W.merges || {})) if (o && o.dName) { if (seenName.has(o.dName)) err(`world.merges[${k}].dName`, `"${o.dName}" is also the name of ${seenName.get(o.dName)}`); seenName.set(o.dName, k); }
    }
    // ctx.only = 'world': just that file (a player-made world, checked against the game's content)
    if (ctx.only) {
      check(SCHEMA.fields[ctx.only], data[ctx.only], [{ k: ctx.only }], null);
      if (ctx.only === 'world' && data.world && Array.isArray(data.world.maps) && Array.isArray(data.world.zones) && Array.isArray(data.world.themes)) worldRules(data.world);
      return out;
    }
    check(SCHEMA, data, [], null);

    // ---- rules that span fields
    const E_ = data.essences, C_ = data.combos, W_ = data.world;
    // subs: codes, hosts, facets
    for (const s of E_.subs || []) {
      if (s.host != null && !mains.includes(s.host)) err(`essences.subs[${s.code}].host`, `"${s.host}" is not a main essence`);
      if (mains.includes(s.code)) err(`essences.subs[${s.code}].code`, 'a sub-essence can\'t share a main\'s code');
    }
    // pair reactions: one per unordered pair of mains
    const pairs = [];
    for (let i = 0; i < mains.length; i++) for (let j = i; j < mains.length; j++) pairs.push(mains[i] + mains[j]);
    for (const p of pairs) if (!(E_.reactions || {})[p]) err('essences.reactions', `the reaction for ${p} is missing`);
    for (const p of Object.keys(E_.reactions || {})) if (!pairs.includes(p)) err(`essences.reactions.${p}`, `"${p}" is not a pair of mains in essence order`);
    // the type chart: every main beats another main
    for (const m of E_.mains || []) if (m.beats === m.code) err(`essences.mains[${m.code}].beats`, 'an essence can\'t be strong against itself');
    const beaten = (E_.mains || []).map(m => m.beats);
    if (new Set(beaten).size !== beaten.length) warn('essences.mains', 'two essences are strong against the same essence; the type chart is no longer a cycle');
    // resonances and trinities: unique sets that can meet in one merge
    const canMeet = set => mains.some(a => mains.some(b => set.every(x => { const s = subOf(x); return s && (!s.host || s.host === a || s.host === b); })));
    const combos = (C_.resonances || []).map(r => ['resonances', r]).concat((C_.trinities || []).map(r => ['trinities', r]));
    const setKeys = new Map();
    for (const [kind, r] of combos) {
      if (!Array.isArray(r.subs)) continue;
      const key = r.subs.slice().sort().join('+');
      if (setKeys.has(key)) err(`combos.${kind}[${r.id}].subs`, `${r.name} uses the same sub-essences as ${setKeys.get(key)}`);
      setKeys.set(key, r.name);
      if (r.subs.every(x => subs.includes(x)) && !canMeet(r.subs)) err(`combos.${kind}[${r.id}].subs`, `${r.subs.join(' + ')} can never meet in one merge (their hosts need three different mains)`);
    }
    const allNames = combos.map(([, r]) => r.name).filter(Boolean);
    const dupName = allNames.find((x, i) => allNames.indexOf(x) !== i);
    if (dupName) err('combos', `two combos are called "${dupName}"`);
    // residue: one reaction per (cast, into)
    // the world: ids, positions, links and conditions
    const W_ok = W_ && Array.isArray(W_.maps) && Array.isArray(W_.zones) && Array.isArray(W_.themes);
    if (W_ok) worldRules(W_);
    // overrides: hand-given names stay unique
    const ov = data.overrides || {};
    for (const f of ['name', 'dName']) {
      const seen = new Map();
      for (const [k, o] of Object.entries(ov)) if (o && o[f]) { if (seen.has(o[f])) err(`overrides[${k}].${f}`, `"${o[f]}" is also given to ${seen.get(o[f])}`); seen.set(o[f], k); }
    }
    return out;
  }
  // The built world (C = CONTENT.make(E)): starting from the start and walking through every warp
  // with every gate open (and every thing that has a condition gone), each trainer, person, sign,
  // chest, terminal, warp and trigger can be reached, and no warp leads into a wall.
  function checkWorld(C) {
    const out = [];
    const maps = C.MAPS || {}, st = C.START;
    if (!st || !maps[st.map]) return [{ level: 'error', path: 'world.start', msg: 'the start is not on a map of this world' }];
    const key = (m, x, y) => m + ':' + x + ',' + y;
    const blockers = new Set(), warps = new Map();
    for (const m of Object.values(maps)) for (const t of m.things) {
      if (BLOCKING.has(t.type) && !t.cond) blockers.add(key(m.id, t.x, t.y));
      if (t.type === 'warp') warps.set(key(m.id, t.x, t.y), t);
    }
    const walk = (m, x, y) => {
      const M = maps[m]; if (!M || x < 0 || y < 0 || x >= M.w || y >= M.h) return false;
      if (warps.has(key(m, x, y))) return true;
      const T = TILES[M.tiles[y][x]];
      return !!T && (!T.solid || !!T.keys) && !blockers.has(key(m, x, y));
    };
    const seen = new Set([key(st.map, st.x, st.y)]), q = [[st.map, st.x, st.y]];
    while (q.length) {
      const [m, x, y] = q.shift();
      const w = warps.get(key(m, x, y));
      if (w && w.to && maps[w.to.map]) { const id = key(w.to.map, w.to.x, w.to.y); if (!seen.has(id)) { seen.add(id); q.push([w.to.map, w.to.x, w.to.y]); } }
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy, id = key(m, nx, ny);
        if (seen.has(id) || !walk(m, nx, ny)) continue;
        seen.add(id); q.push([m, nx, ny]);
      }
    }
    const near = (m, x, y) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => seen.has(key(m, x + dx, y + dy)));
    for (const M of Object.values(maps)) {
      let any = false;
      for (const k of seen) if (k.startsWith(M.id + ':')) { any = true; break; }
      if (!any) { out.push({ level: 'warn', path: `world.maps[${M.id}]`, msg: `nothing leads to ${M.name}: add a warp to it` }); continue; }
      for (const t of M.things) {
        const P = `world.maps[${M.id}].things[${t.id}]`, nm = t.name || `the ${t.type} ${t.id}`;
        if (t.type === 'warp' || t.type === 'trigger') { if (!seen.has(key(M.id, t.x, t.y))) out.push({ level: 'error', path: P, msg: `nobody can step on ${nm} at ${t.x},${t.y}` }); }
        else if (t.type !== 'block' && !near(M.id, t.x, t.y)) out.push({ level: 'error', path: P, msg: `nobody can reach ${nm} at ${t.x},${t.y}` });
        if (t.type === 'warp' && t.to) {
          const D = maps[t.to.map];
          if (!D) out.push({ level: 'error', path: P + '.to', msg: `the warp leads to a map that doesn't exist (${t.to.map})` });
          else if (!walk(t.to.map, t.to.x, t.to.y)) out.push({ level: 'error', path: P + '.to', msg: `the warp leads into ${D.tiles[t.to.y] ? tileName(D.tiles[t.to.y][t.to.x]).toLowerCase() : 'nothing'} at ${D.name} ${t.to.x},${t.to.y}` });
        }
      }
      for (let y = 0; y < M.h; y++) for (let x = 0; x < M.w; x++) {
        const T = TILES[M.tiles[y][x]];
        if (T && T.use && !near(M.id, x, y)) out.push({ level: 'error', path: `world.maps[${M.id}].tiles`, msg: `the ${T.name.toLowerCase()} at ${M.name} ${x},${y} can't be reached` });
      }
    }
    return out;
  }
  // A world on its own (a player-made one), checked against the game's content: its issues, plus
  // (when C is its built world and nothing is broken) whether everything can be reached.
  function validateWorld(world, data, ctx, C) {
    const issues = validate(Object.assign({}, data, { world }), Object.assign({}, ctx, { only: 'world' }));
    return C && !issues.some(i => i.level === 'error') ? issues.concat(checkWorld(C)) : issues;
  }
  function patternHelp(re) {
    if (re === LOWER) return 'lowercase letters';
    if (re === ONEWORD) return 'one capitalized word';
    if (re === CAPWORD) return 'starts with a capital letter';
    if (re === SLUG) return 'letters, digits and dashes';
    return String(re);
  }

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

  // A short fingerprint of some content, so a change set can say which snapshot it was made on.
  function hashData(data) {
    const str = JSON.stringify(data);
    let a = 0x811c9dc5, b = 0x01000193 ^ str.length;
    for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); a = Math.imul(a ^ c, 0x01000193) >>> 0; b = Math.imul(b ^ c, 0x5bd1e995) >>> 0; }
    return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
  }
  const CHANGES_FORMAT = 'essence-protocol.changes/1';

  return {
    FILES, AXES, AXIS, STAT_KEYS, STAT, TIERS, SUB_TIERS, FACING, TILES, TILE_GROUPS, tileName, THING, THING_TYPES, BLOCKING, LOOKS, PARTICLES, FLAG, parseCond, describeCond, RARITY,
    WORLD_SCHEMA: WORLD, validateWorld,
    SCHEMA, parsePath, pathString, resolve, getAt, describePath, clone, same,
    diff, applyOps, validate, checkWorld, format, hashData, CHANGES_FORMAT,
  };
});
