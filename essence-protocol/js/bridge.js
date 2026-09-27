/* Essence Protocol: FriedrichBridge client and live baking.
 *
 * tools/bake.js bakes every merge offline into merges.baked.js. While the game
 * runs, FriedrichBridge bakes again, live: a local model designs each
 * technique, daemon form, forged item, splice lineage and daemon trait, and
 * the bridge saves every design in its SQLite database, so the same request
 * always returns the same design. The baked lattice is the fallback while the
 * bridge is unreachable, and a persistent outbox makes sure everything the
 * player merges, forges, binds or splices reaches the database once it is back.
 *
 * Every request is a two-item bridge merge. Ids never contain "+":
 *   technique  ep.t.lead.F.Em      + ep.t.follow.W.Li     lead/follow is part of the id because
 *   form       ep.f.lead.F.Em      + ep.f.follow.W.Li     the bridge treats A+B as B+A, and here
 *   item       ep.i.patch.lead.F   + ep.i.patch.follow.W  Fire-led Scald is not Water-led Steam
 *   lineage    ep.b.FW-Em1         + ep.b.EA              a splice: unordered, ".twin" if equal
 *   trait      ep.d.FW-Em1         + ep.s.7f3a91c2        one individual daemon (genome + seed)
 * Every context carries a SEED and a %RARITY% modulator. The game rolls how
 * rare a design is from its seed and from what the merge is made of; that
 * roll sets the design's scope and power budget, and the model designs within
 * it. abilityFrom, offspringFrom and traitFrom are pure, deterministic
 * mappings from a design to mechanics.
 *
 * Requests go to "/bridge", the same-origin proxy in tools/serve.py, which
 * adds the API key server side. A direct URL + key can also be set in
 * System > FriedrichBridge (kept in this browser only). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./essences.js'));
  else root.BRIDGE = factory(root.ESSENCE);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  const ID_RE = /^[A-Za-z0-9_.:\-]{1,128}$/;
  const CACHE_KEY = 'ep-bridge-cache-v1';
  const CONF_KEY = 'ep-bridge-conf';
  const OUTBOX_KEY = 'ep-bridge-outbox-v1';
  const TIMEOUT_MS = 180000; // longer than the bridge's merge_timeout (150 s), which includes queue time
  const BACKOFF = [2000, 5000, 10000];
  const RETRY_MS = 60000;

  const lc = x => String(x || '').toLowerCase();
  // Word-prefix matching ("burning" matches "burn"; "barrage" does not match "rage").
  const tokens = text => text.split(/[^a-z0-9-]+/).filter(Boolean);
  const hasWord = (toks, words) => words.some(w => toks.some(t => t.startsWith(w)));
  function statOf(stats, keys) { let v = 0; for (const [k, n] of Object.entries(stats || {})) if (typeof n === 'number' && isFinite(n) && keys.some(w => lc(k).includes(w))) v += Math.max(0, n); return v; }
  const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ---- seeds and the %RARITY% modulator (pure) ----
  const RARITY_NAMES = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
  const RARITY_CUTS = [40, 15, 5, 1]; // a roll at or below 40% is uncommon, 15% rare, 5% epic, 1% legendary
  function hash32(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
  const seedOf = str => hash32('ep|' + str).toString(16).padStart(8, '0');
  const unit = (seed, salt) => (hash32(seed + '|' + salt) + 0.5) / 4294967296;
  // `boost` (0 to 0.9) is how strongly the makeup of the merge favors rare outcomes.
  // `pct` is the share of designs at least this rare, so lower is rarer (2.7% is about 1 in 37).
  function modulate(seed, boost) {
    const b = clampN(boost || 0, 0, 0.9);
    const pct = Math.max(0.01, Math.round(unit(seed, 'rarity') * 10000 * (1 - 0.75 * b)) / 100);
    let tier = 0;
    while (tier < 4 && pct <= RARITY_CUTS[tier]) tier++;
    return { seed, boost: Math.round(b * 100) / 100, pct, tier, rarity: RARITY_NAMES[tier], odds: Math.max(1, Math.round(100 / pct)) };
  }
  // The modulator for one design. `info`: tech and items use the baked rarity (0-4); traits use
  // the daemon's generation, its parents' trait tier and whether it is prismatic.
  function modFor(kind, key, info) {
    info = info || {};
    if (kind === 'breed') {
      const [x, y] = key.split('~');
      return modulate(seedOf('breed:' + key), 0.06 * (E.parseKey(x).subs.length + E.parseKey(y).subs.length));
    }
    if (kind === 'trait') {
      const [k, seed] = key.split('@');
      return modulate(seed, 0.08 * E.parseKey(k).subs.length + 0.1 * Math.min(3, info.gen || 0) + 0.06 * (info.parentTier || 0) + (info.prism ? 0.2 : 0));
    }
    const p = E.parseKey(key), n = p.subs.length;
    let boost = 0.12 * n;
    if (kind === 'tech') boost = 0.1 * n + 0.08 * (info.rarity || 0) + (E.REACTION[E.pairId(p.a, p.b)].volatile ? 0.05 : 0);
    else if (itemType(kind)) boost = 0.08 * n + 0.06 * (info.rarity || 0);
    return modulate(seedOf(kind + ':' + key), boost);
  }
  const rarityText = mod => `${mod.pct}% (${mod.rarity}, about 1 in ${mod.odds})`;
  function fill(tpl, vars) { return tpl.replace(/%([A-Z]+)%/g, (m, k) => (vars[k] != null ? String(vars[k]) : m)); }

  // ---- request mapping (pure, testable in Node) ----
  const ITEM_TYPES = {
    patch: ['Patch', 'a consumable that restores a daemon\'s HP'],
    ward: ['Module', 'a battle item that raises a shield'],
    lattice: ['Lattice', 'a lattice for binding wild daemons'],
    catalyst: ['Catalyst', 'a battle item that floods the arena with an essence field'],
    script: ['Script', 'a script that attunes a daemon to a new sub-essence'],
    cell: ['Flux Cell', 'a battle item that refills Flux'],
  };
  function itemType(kind) { return typeof kind === 'string' && kind.startsWith('item.') && ITEM_TYPES[kind.slice(5)] ? kind.slice(5) : null; }
  const isKind = kind => kind === 'tech' || kind === 'form' || kind === 'breed' || kind === 'trait' || !!itemType(kind);
  const TIER_WORDS = ['Seed', 'Build', 'Release', 'Prime'];
  const TECH_SCOPE = ['at most 2 effects and modest power', 'at most 3 effects and solid power', 'at most 4 effects and high power',
    'at most 5 effects and very high power with a real drawback', 'at most 6 effects and extreme power with a real drawback'];
  const ITEM_SCOPE = ['a plain, practical item', 'a well-made item', 'a finely made rare item', 'an epic relic', 'a legendary artifact'];
  const STRENGTH = ['minor', 'modest', 'strong', 'major', 'mythic'];
  const PROMPT = {
    tech: 'Essence Protocol, a creature RPG where daemons (artificial minds) merge essences into combat techniques. ' +
      'Design the TECHNIQUE created by merging these. %REACTION% Name it in 2 to 4 words and describe what it does when cast in one or two sentences. ' +
      'In tags, include exactly one type from [%TYPES%] and any effects from [%EFFECTS%]. ' +
      'Use stats attack (damage), defense (shielding/healing strength), special (effect strength) and speed. ' +
      'SEED %SEED% (use it to vary the concept). RARITY %RARITY%: set "rarity" to "%TIER%" and design it with %SCOPE%. ' +
      'For reference, the lattice\'s own reading is a %CLASS% with effects: %FX%.',
    form: 'Essence Protocol, a creature RPG where the creatures are daemons: artificial minds made of essence. ' +
      'Name and describe the DAEMON whose genome is %A% leading %B%. ' +
      'It is a %STAGE%-tier form with base stats %STATS% (hp, logic, firewall, clock, flux, coherence). ' +
      'The name should be one invented word of 2 to 4 syllables, like a creature species. ' +
      'SEED %SEED% (use it to vary the concept). RARITY %RARITY%: set "rarity" to "%TIER%"; rarer forms should feel more mythic.',
    item: 'Essence Protocol, a creature RPG where daemons are made of essences. At the Nexus Forge, motes of %A% and %B% are merged into an ITEM: ' +
      'a %LABEL%, %WHAT%. It is forged from the technique "%TECH%" (a %CLASS%), so its name should echo it. ' +
      'Name it in 2 to 4 words ending with "%LABEL%" and describe it in one or two sentences. Tags: its essences and what it does. ' +
      'SEED %SEED%. RARITY %RARITY%: set "rarity" to "%TIER%"; it is %SCOPE%.',
    breed: 'Essence Protocol, a creature RPG where daemons (artificial minds made of essence) can be spliced. ' +
      'Design the LINEAGE born from splicing [%A%] with [%B%]. Name the lineage in 1 to 3 words and describe its offspring in one or two sentences. ' +
      'In tags, list the essences the offspring inherits, most dominant first, using only these exact names: %POOL%. ' +
      'The first main essence you list leads its genome and the second follows. ' +
      'Use stats hp, attack, defense, speed, flux and special for what the lineage is strong in. ' +
      'SEED %SEED%. RARITY %RARITY%: set "rarity" to "%TIER%"; the offspring inherits %SCOPE%.',
    trait: 'Essence Protocol, a creature RPG. Design the SIGNATURE TRAIT of one individual daemon: %DAEMON%. %ANCESTRY% ' +
      'A trait is what makes this daemon special beyond its species. Choose %SCOPE% from this list and put their exact words in tags: ' +
      'out-of-combat utilities while it is in the party (forage: more motes from battles; tutor: more XP; binder: better bind odds; smith: free forging; ' +
      'nurture: faster kernels; mender: heals the party while walking; fortune: prismatic odds; archive: motes from new discoveries; lure: more wild encounters; shroud: fewer), ' +
      'battle passives (logic, firewall, clock, vitality, capacity, coherence: stat bonuses) or out-of-combat actives used from the menu ' +
      '(pulse: heal the party; warp: return to the last terminal; repel: no wild encounters for a while; hasten: speed up kernels; transmute: turn motes into its essence). ' +
      'Pick what fits its genome and ancestry: evolve the ancestors\' traits, keep what fits and mutate the rest. In stats, give each chosen trait word a weight. ' +
      'Name the trait in 2 to 4 words and describe it in one or two sentences. SEED %SEED%. RARITY %RARITY%: set "rarity" to "%TIER%".',
  };

  function side(p, role, main, subs) {
    const names = subs.map(s => E.SUB[s].name);
    return {
      id: ['ep', role === 'lead' ? 'lead' : 'follow', main].concat(subs).join('.'),
      name: E.MAIN[main].name + (names.length ? ' (' + names.join(', ') + ')' : ''),
      element: E.MAIN[main].name.toLowerCase(),
      role,
      essences: [E.MAIN[main].name].concat(names),
    };
  }
  function genomeText(k) {
    const p = E.parseKey(k);
    const mains = p.a === p.b ? 'pure ' + E.MAIN[p.a].name : E.MAIN[p.a].name + ' leading ' + E.MAIN[p.b].name;
    return mains + (p.subs.length ? ', with ' + p.subs.map(t => E.SUB[t.s].name + ' on ' + E.MAIN[E.hostMain(p, t.h)].name).join(', ') : '');
  }
  function genomeEssences(k) {
    const p = E.parseKey(k);
    return (p.a === p.b ? [p.a] : [p.a, p.b]).map(m => E.MAIN[m].name).concat(p.subs.map(t => E.SUB[t.s].name));
  }

  // `rec` is the game's record for the merge (ENG.rec); for 'breed' it carries the parents' form
  // names, and for 'trait' the daemon's name, generation, prism flag and ancestry.
  function request(key, kind, rec) {
    rec = rec || {};
    if (kind === 'breed') return breedRequest(key, rec);
    if (kind === 'trait') return traitRequest(key, rec);
    const p = E.parseKey(key);
    const onA = p.subs.filter(t => t.h === 1).map(t => t.s);
    const onB = p.subs.filter(t => t.h === 2).map(t => t.s);
    const a = side(p, 'lead', p.a, onA), b = side(p, 'follow', p.b, onB);
    const item = itemType(kind);
    const pre = item ? 'ep.i.' + item + '.' : kind === 'form' ? 'ep.f.' : 'ep.t.';
    a.id = pre + a.id.slice(3); b.id = pre + b.id.slice(3);
    const base = rec.baked ? Object.assign({}, rec, rec.baked) : rec; // the lattice's own reading
    const mod = modFor(kind, key, base);
    const vars = { A: a.name, B: b.name, SEED: mod.seed, RARITY: rarityText(mod), TIER: mod.rarity };
    let context;
    if (kind === 'form') context = fill(PROMPT.form, Object.assign(vars, { STAGE: TIER_WORDS[p.subs.length], STATS: JSON.stringify(base.dStats || []) }));
    else if (item) context = fill(PROMPT.item, Object.assign(vars, { LABEL: ITEM_TYPES[item][0], WHAT: ITEM_TYPES[item][1], TECH: rec.name || '', CLASS: base.cls || '', SCOPE: ITEM_SCOPE[mod.tier] }));
    else {
      const rx = E.REACTION[E.pairId(p.a, p.b)];
      context = fill(PROMPT.tech, Object.assign(vars, {
        REACTION: `The two mains react as "${rx.names[p.a]}"${rx.volatile ? ' (volatile, so risky and powerful)' : ''}.`,
        TYPES: TYPES.join(', '), EFFECTS: EFFECT_WORDS.join(', '), SCOPE: TECH_SCOPE[mod.tier],
        CLASS: base.cls, FX: (base.fx || []).map(f => f.code).join(', ') || 'none',
      }));
    }
    return { a, b, context: context.slice(0, 4000) };
  }

  // Splicing: an unordered pair of parent genomes, so it needs no roles. Equal genomes get
  // ".twin" on one side so the two ids stay distinct.
  function breedKey(x, y) { return [x, y].sort().join('~'); }
  function breedRequest(pair, rec) {
    const [x, y] = pair.split('~');
    const names = rec.names || [];
    const parent = (k, i, id) => ({ id, name: (names[i] ? String(names[i]).slice(0, 60) + ': ' : '') + genomeText(k), genome: k, essences: genomeEssences(k) });
    const a = parent(x, 0, 'ep.b.' + x), b = parent(y, 1, 'ep.b.' + y + (x === y ? '.twin' : ''));
    const o = spliceOptions(pair), mod = modFor('breed', pair);
    const n = INHERIT[mod.tier];
    const context = fill(PROMPT.breed, {
      A: a.name, B: b.name, POOL: o.mains.map(m => E.MAIN[m].name).concat(o.subs.map(s => E.SUB[s].name)).join(', '),
      SEED: mod.seed, RARITY: rarityText(mod), TIER: mod.rarity, SCOPE: `${n} sub-essence${n > 1 ? 's' : ''} and a +${PEDIGREE[mod.tier]}% stat pedigree`,
    });
    return { a, b, context: context.slice(0, 4000) };
  }

  // Traits: one recipe per individual daemon, keyed by its genome and its seed. A recompile
  // changes the genome and so asks for an evolved trait; the seed (and the rarity roll) stay.
  function traitKey(genome, seed) { return genome + '@' + seed; }
  function traitRequest(tkey, rec) {
    const [k, seed] = tkey.split('@');
    const anc = (rec.ancestry || []).slice(0, 3);
    const a = { id: 'ep.d.' + k, name: (rec.name ? String(rec.name).slice(0, 60) + ': ' : '') + genomeText(k), genome: k, essences: genomeEssences(k) };
    const b = { id: 'ep.s.' + seed, name: 'Seed ' + seed, generation: rec.gen || 0, ancestry: anc.map(t => t.name) };
    const mod = modFor('trait', tkey, rec);
    const n = TRAIT_SCOPE[mod.tier];
    const context = fill(PROMPT.trait, {
      DAEMON: `${rec.name || 'a daemon'}, a ${TIER_WORDS[E.parseKey(k).subs.length]}-tier daemon (${genomeText(k)}), generation ${rec.gen || 0}${rec.prism ? ', prismatic' : ''}`,
      ANCESTRY: anc.length ? 'Its ancestry: ' + anc.map(t => `"${t.name}" (${(t.codes || []).join(', ')})`).join('; ') + '.' : 'It has no recorded ancestry.',
      SCOPE: `${n} trait word${n > 1 ? 's' : ''} at ${STRENGTH[mod.tier]} strength`,
      SEED: seed, RARITY: rarityText(mod), TIER: mod.rarity,
    });
    return { a, b, context: context.slice(0, 4000) };
  }

  // ---- bridge item -> ability mechanics (pure, deterministic) ----
  const TYPES = ['strike', 'barrage', 'siphon', 'hex', 'ward', 'mend', 'field'];
  const CLASS_OF = { strike: 'Strike', barrage: 'Barrage', siphon: 'Siphon', hex: 'Hex', ward: 'Ward', mend: 'Mend', field: 'Field' };
  const CLASS_WORDS = {
    Strike: ['strike', 'blade', 'sword', 'lance', 'slash', 'spear', 'fang', 'punch', 'smash', 'hammer', 'bolt', 'edge', 'cleave', 'impale'],
    Barrage: ['barrage', 'volley', 'swarm', 'rain', 'hail', 'shards', 'flurry', 'salvo', 'scatter', 'multi', 'storm', 'torrent'],
    Siphon: ['siphon', 'drain', 'leech', 'vampir', 'absorb', 'devour', 'steal', 'feast'],
    Hex: ['hex', 'curse', 'poison', 'venom', 'stun', 'slow', 'fear', 'bind', 'snare', 'toxic', 'jinx', 'debuff'],
    Ward: ['ward', 'shield', 'barrier', 'armor', 'armour', 'guard', 'wall', 'aegis', 'protect', 'deflect'],
    Mend: ['mend', 'heal', 'restore', 'regen', 'cure', 'repair', 'renew', 'soothe', 'recover'],
    Field: ['field', 'aura', 'zone', 'domain', 'weather', 'terrain', 'realm', 'area', 'surround'],
  };
  const EFFECT_MAP = {
    burn: ['burn', 'fire', 'flame', 'blaze', 'ember', 'scorch', 'magma', 'lava', 'inferno'],
    freeze: ['freeze', 'frozen', 'ice', 'frost', 'glacial', 'cryo'],
    chill: ['chill', 'cold', 'slow', 'sluggish'],
    static: ['static', 'shock', 'lightning', 'spark', 'thunder', 'electric', 'paraly', 'stun'],
    root: ['root', 'vine', 'entangle', 'thorn', 'snare', 'bind'],
    corrupt: ['corrupt', 'poison', 'venom', 'void', 'shadow', 'toxic', 'decay', 'rot'],
    lullaby: ['sleep', 'dream', 'lullaby', 'dormant', 'trance'],
    blind: ['blind', 'smoke', 'ash', 'dazzle', 'glare', 'fog'],
    soak: ['soak', 'wet', 'drench', 'water', 'tide', 'flood'],
    petrify: ['petrify', 'stone', 'fossil', 'calcify'],
    pierce: ['pierce', 'piercing', 'penetrat', 'armor-break', 'sunder'],
    crit: ['crit', 'precise', 'sharp', 'lethal', 'keen', 'assassin'],
    echo: ['echo', 'resonat', 'reverb', 'sound', 'repeat'],
    delay: ['delay', 'time', 'delayed', 'temporal', 'chrono'],
    drain: ['drain', 'leech', 'lifesteal', 'vampir', 'siphon'],
    heal: ['heal', 'restore', 'mend', 'cure'],
    shield: ['shield', 'barrier', 'ward', 'protect'],
    guard: ['guard', 'fortify', 'harden', 'armor'],
    overclock: ['overclock', 'empower', 'strength', 'rage', 'boost'],
    haste: ['haste', 'speed', 'swift', 'quick', 'wind', 'gale'],
    veil: ['veil', 'evasion', 'mist', 'invisible', 'phase'],
    regen: ['regen', 'regenerat', 'renew', 'bloom'],
    wash: ['wash', 'dispel', 'cleanse-foe', 'purge-foe'],
    cleanse: ['cleanse', 'purify', 'purge'],
    priority: ['priority', 'first-strike', 'instant', 'quickdraw'],
  };
  const EFFECT_WORDS = Object.keys(EFFECT_MAP).concat(['recoil']);
  const SELF = new Set(['heal', 'cleanse', 'shield', 'guard', 'overclock', 'haste', 'veil', 'regen']);
  const RARITY_TIER = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4 };

  // Turns a bridge item into the ability mechanics the engine understands.
  // `baked` is the lattice record for the same merge; its element typing and
  // anything the item doesn't speak to are kept. `mod` (modFor('tech', ...))
  // decides the rarity tier and how many effects fit; without it the item's
  // own rarity is used.
  function abilityFrom(entry, baked, mod) {
    const tags = (entry.tags || []).map(lc);
    const text = tokens([lc(entry.name), lc(entry.description)].concat(tags).join(' '));
    const tier = mod ? mod.tier : RARITY_TIER[lc(entry.rarity)] != null ? RARITY_TIER[lc(entry.rarity)] : 1;
    // class: an explicit type tag wins, then keywords in name/description/tags, then the lattice's own class
    let cls = null;
    for (const t of tags) if (CLASS_OF[t]) { cls = CLASS_OF[t]; break; }
    if (!cls) {
      let best = 0;
      for (const [c, words] of Object.entries(CLASS_WORDS)) { const n = words.filter(w => text.some(t => t.startsWith(w))).length; if (n > best) { best = n; cls = c; } }
    }
    cls = cls || baked.cls;
    const atk = statOf(entry.stats, ['attack', 'atk', 'power', 'damage', 'offen', 'strength', 'magic', 'might']);
    const def = statOf(entry.stats, ['defen', 'def', 'armor', 'armour', 'guard', 'resist', 'toughness', 'heal']);
    const spc = statOf(entry.stats, ['special', 'spell', 'effect', 'mana', 'intellig', 'wisdom', 'control']);
    const spd = statOf(entry.stats, ['speed', 'agility', 'haste', 'quick']);
    const total = atk + def + spc + spd || 1;
    const aS = atk / total, dS = def / total, sS = spc / total, vS = spd / total;
    const damaging = !['Ward', 'Mend'].includes(cls);
    const base = [60, 75, 90, 108, 130][tier];
    let power = 0, hits = 1;
    if (damaging) {
      power = base * (0.6 + aS * 1.1);
      if (cls === 'Barrage') { hits = clampN(2 + Math.floor(tier / 2) + (vS > 0.25 ? 1 : 0), 2, 5); power = power * 1.15 / hits; }
      else if (cls === 'Siphon') power *= 0.85;
      else if (cls === 'Hex') power *= 0.4;
      else if (cls === 'Field') power *= 0.5;
      power = clampN(Math.round(power / 5) * 5, 15, 160);
    }
    const acc = ['Ward', 'Mend'].includes(cls) ? 101 : clampN(Math.round((96 - tier * 3 + vS * 10) / 5) * 5, 60, 100);
    const flux = clampN(Math.round(4 + tier * 3 + (damaging ? power * hits / 30 : 4) + ((baked.subs || []).length)), 3, 30);
    const instab = clampN(Math.round(3 + tier * 5 + (baked.instab || 0) * 0.3 - vS * 10), 0, 60);
    const prio = hasWord(text, EFFECT_MAP.priority) || vS > 0.4 ? 1 : (aS > 0.6 && vS < 0.05 ? -1 : 0);
    // effects: every effect word the item uses, with strength from rarity and its special stat
    const fx = [];
    const chance = clampN(Math.round(25 + tier * 10 + sS * 40 + (cls === 'Hex' ? 25 : 0)), 10, 100);
    for (const [code, words] of Object.entries(EFFECT_MAP)) {
      if (code === 'priority') continue;
      if (!hasWord(text, words)) continue;
      if (!damaging && !SELF.has(code)) continue;
      if (['pierce', 'crit'].includes(code)) fx.push({ code, chance: 100, mag: 1 });
      else if (code === 'drain') fx.push({ code, chance: 100, mag: clampN(Math.round(35 + tier * 8 + dS * 20), 30, 85) });
      else if (code === 'heal') fx.push({ code, chance: 100, mag: clampN(Math.round(20 + tier * 8 + dS * 30), 15, 75) });
      else if (code === 'shield') fx.push({ code, chance: 100, mag: clampN(Math.round(15 + tier * 6 + dS * 30), 12, 60) });
      else if (code === 'regen') fx.push({ code, chance: 100, mag: 5 + tier });
      else if (code === 'delay' || code === 'echo') fx.push({ code, chance: chance, mag: 50 + tier * 5 });
      else fx.push({ code, chance: SELF.has(code) ? clampN(chance + 20, 10, 100) : chance, mag: 0 });
    }
    // every class keeps its core so a sparse item still does something
    const has = c => fx.some(f => f.code === c);
    if (cls === 'Siphon' && !has('drain')) fx.push({ code: 'drain', chance: 100, mag: clampN(Math.round(35 + tier * 8), 30, 85) });
    if (cls === 'Mend' && !has('heal')) fx.push({ code: 'heal', chance: 100, mag: clampN(Math.round(25 + tier * 8 + dS * 30), 15, 75) });
    if (cls === 'Ward' && !has('shield')) fx.push({ code: 'shield', chance: 100, mag: clampN(Math.round(18 + tier * 6 + dS * 30), 12, 60) });
    if (cls === 'Hex' && !fx.some(f => !SELF.has(f.code) && !['pierce', 'crit', 'drain', 'delay', 'echo'].includes(f.code))) fx.push({ code: (baked.fx.find(f => ['burn', 'freeze', 'static', 'root', 'corrupt', 'blind', 'chill', 'soak'].includes(f.code)) || { code: 'chill' }).code, chance: clampN(chance + 20, 10, 100), mag: 0 });
    if (tier >= 3 && damaging && (baked.fx || []).some(f => f.code === 'recoil')) fx.push({ code: 'recoil', chance: 100, mag: 15 });
    fx.sort((x, y) => y.chance - x.chance || (x.code < y.code ? -1 : 1));
    return { cls, power, hits, acc, flux, instab, prio, fx: fx.slice(0, mod ? Math.min(7, 2 + mod.tier) : 7), tier };
  }

  // ---- splice lineage -> offspring (pure, deterministic, symmetric in the parents) ----
  const MAIN_WORD = {}; for (const m of E.MAINS) MAIN_WORD[E.MAIN[m].name.toLowerCase()] = m;
  const SUB_WORD = {}; for (const s of E.SUB_ORDER) SUB_WORD[E.SUB[s].name.toLowerCase()] = s;
  const PEDIGREE = [4, 6, 8, 11, 15]; // total % stat bonus by lineage rarity
  const INHERIT = [1, 1, 2, 2, 3]; // sub-essences inherited as attunements by lineage rarity
  const PED_KEYS = {
    hp: ['hp', 'health', 'vital', 'life', 'endur', 'constitution'],
    atk: ['attack', 'atk', 'power', 'damage', 'offen', 'strength', 'might', 'logic'],
    def: ['defen', 'def', 'armor', 'armour', 'guard', 'resist', 'tough', 'firewall'],
    spd: ['speed', 'agility', 'haste', 'quick', 'clock'],
    flux: ['flux', 'energy', 'mana', 'stamina'],
    coh: ['special', 'spell', 'effect', 'intellig', 'wisdom', 'control', 'focus', 'coheren', 'magic'],
  };
  // What a pair of parents can pass on, in the lattice's own order of preference (which parent
  // leads is fixed per pair by hash).
  function spliceOptions(pair) {
    const [x, y] = pair.split('~');
    const ps = hash32('lead|' + pair) & 1 ? [E.parseKey(y), E.parseKey(x)] : [E.parseKey(x), E.parseKey(y)];
    const mains = [...new Set([ps[0].a, ps[1].a, ps[0].b, ps[1].b])];
    const subs = [];
    for (let i = 0; i < 3; i++) for (const q of ps) if (q.subs[i] && !subs.includes(q.subs[i].s)) subs.push(q.subs[i].s);
    return { mains, subs };
  }
  // The offspring boots as a Seed-tier genome of the parents' main essences and inherits some of
  // their sub-essences as attunements. With a design, the essences it names (tags first) decide
  // which main leads and which subs carry on, and its stats give a pedigree. Without one
  // (entry null) the lattice's pick is used and there is no pedigree.
  function offspringFrom(entry, pair, mod) {
    const o = spliceOptions(pair);
    const named = [];
    if (entry) for (const src of [(entry.tags || []).join(' '), entry.name, entry.description]) for (const w of lc(src).split(/[^a-z]+/)) { const c = MAIN_WORD[w] || SUB_WORD[w]; if (c && !named.includes(c)) named.push(c); }
    const nm = named.filter(c => o.mains.includes(c));
    const lead = nm[0] || o.mains[0];
    const follow = nm.find(c => c !== lead) || o.mains.find(c => c !== lead) || lead;
    const tier = entry ? (mod ? mod.tier : 1) : -1;
    const want = tier >= 0 ? INHERIT[tier] : 1;
    const fits = s => o.subs.includes(s) && (E.eligible(s, lead) || E.eligible(s, follow));
    const attune = [];
    for (const s of named.filter(c => E.SUB[c]).concat(o.subs)) if (attune.length < want && fits(s) && !attune.includes(s)) attune.push(s);
    let pedigree = null;
    if (tier >= 0) {
      const total = PEDIGREE[tier], w = {};
      let W = 0;
      for (const [k, words] of Object.entries(PED_KEYS)) { w[k] = statOf(entry.stats, words); W += w[k]; }
      pedigree = {};
      if (W > 0) for (const k of Object.keys(PED_KEYS)) { const n = Math.min(15, Math.round(total * w[k] / W)); if (n > 0) pedigree[k] = n; }
      if (!Object.keys(pedigree).length) pedigree = { hp: Math.ceil(total / 2), coh: Math.floor(total / 2) };
    }
    return { key: E.makeKey(lead, follow, []), lead, follow, attune, pedigree, tier };
  }

  // ---- daemon traits (pure, deterministic) ----
  // code: [category, words the design may use, magnitude by rarity tier]
  const TRAITS = {
    // out of combat, while the daemon is in the party (percent unless noted)
    forage: ['utility', ['forage', 'gather', 'harvest', 'scaveng', 'collect', 'loot', 'mote'], [10, 15, 22, 30, 40]],
    tutor: ['utility', ['tutor', 'teach', 'mentor', 'learn', 'train', 'study', 'xp', 'experience', 'wisdom'], [5, 8, 12, 16, 22]],
    binder: ['utility', ['binder', 'bind', 'capture', 'tame', 'tether', 'leash', 'charm', 'lattice'], [5, 8, 12, 16, 22]],
    smith: ['utility', ['smith', 'forge', 'craft', 'anvil', 'artisan', 'refine', 'temper'], [8, 12, 18, 25, 35]],
    nurture: ['utility', ['nurture', 'incubat', 'kernel', 'nest', 'brood', 'cradle', 'compile', 'splice', 'hatch'], [10, 15, 22, 30, 40]],
    mender: ['utility', ['mender', 'tend', 'soothe', 'medic', 'nurse', 'recuperat'], [2, 3, 4, 6, 8]], // % HP every 25 steps
    fortune: ['utility', ['fortune', 'luck', 'prism', 'shimmer', 'fate', 'omen', 'serendip'], [20, 35, 50, 75, 100]],
    archive: ['utility', ['archive', 'record', 'codex', 'scholar', 'lore', 'knowledge', 'discover', 'catalog'], [10, 15, 22, 30, 40]],
    lure: ['utility', ['lure', 'bait', 'attract', 'beckon', 'summon', 'hunt'], [10, 15, 20, 25, 30]],
    shroud: ['utility', ['shroud', 'stealth', 'hide', 'sneak', 'hush', 'quiet', 'camouflag'], [10, 15, 20, 25, 30]],
    // in battle, always on (percent stat bonus)
    logic: ['passive', ['logic', 'attack', 'strength', 'might', 'fury', 'offens', 'power'], [4, 6, 8, 11, 15]],
    firewall: ['passive', ['firewall', 'defens', 'armor', 'armour', 'shell', 'bulwark', 'fortress', 'sturdy'], [4, 6, 8, 11, 15]],
    clock: ['passive', ['clock', 'speed', 'swift', 'agil', 'quick', 'fast', 'dash', 'nimble'], [4, 6, 8, 11, 15]],
    vitality: ['passive', ['vital', 'health', 'hp', 'endur', 'hardy', 'robust', 'stamina', 'life'], [4, 6, 8, 11, 15]],
    capacity: ['passive', ['capacity', 'flux', 'energy', 'reservoir', 'battery', 'mana'], [4, 6, 8, 11, 15]],
    coherence: ['passive', ['coheren', 'focus', 'clarity', 'resolve', 'calm', 'mind', 'will'], [4, 6, 8, 11, 15]],
    // out-of-combat actives, used from the Party menu
    pulse: ['active', ['pulse', 'rally', 'restore', 'revive', 'renew', 'refresh'], [20, 30, 40, 55, 75]], // % party HP
    warp: ['active', ['warp', 'teleport', 'recall', 'return', 'blink', 'portal', 'homing'], [400, 320, 250, 180, 120]], // its own cooldown in steps
    repel: ['active', ['repel', 'deter', 'scare', 'banish', 'silence'], [30, 45, 60, 80, 110]], // steps without wild encounters
    hasten: ['active', ['hasten', 'accelerat', 'quicken', 'catalyz', 'overdrive'], [10, 15, 22, 30, 45]], // kernel steps
    transmute: ['active', ['transmut', 'alchem', 'convert', 'distill', 'transform', 'refactor'], [5, 4, 4, 3, 2]], // motes in per mote out
  };
  const TRAIT_SCOPE = [1, 1, 2, 2, 3]; // trait effects by rarity tier
  const ACTIVE_CD = { pulse: 150, repel: 200, hasten: 180, transmute: 60 }; // steps (warp's magnitude is its cooldown)
  const PASSIVE_STAT = { logic: 'atk', firewall: 'def', clock: 'spd', vitality: 'hp', capacity: 'flux', coherence: 'coh' };
  // Turns a trait design into effects. Exact trait words in tags come first, then stats keyed by
  // trait words (weights), then trait words anywhere in the text. `ancestry` (trait codes from
  // the parents or the previous form) fills any room the design leaves, so traits carry on.
  function traitFrom(entry, mod, ancestry) {
    const tier = mod.tier, n = TRAIT_SCOPE[tier];
    const tags = (entry.tags || []).map(lc);
    const weight = {};
    const add = (c, v) => { weight[c] = (weight[c] || 0) + v; };
    tags.forEach((t, i) => { const c = t.replace(/[^a-z]/g, ''); if (TRAITS[c]) add(c, Math.max(20, 40 - i)); });
    for (const [k, v] of Object.entries(entry.stats || {})) { const c = lc(k).replace(/[^a-z]/g, ''); if (TRAITS[c] && typeof v === 'number' && isFinite(v) && v > 0) add(c, Math.min(60, v)); }
    const text = tokens([lc(entry.name), lc(entry.description)].concat(tags).join(' '));
    for (const [c, t] of Object.entries(TRAITS)) if (!weight[c] && hasWord(text, t[1])) add(c, 3);
    (ancestry || []).forEach((c, i) => { if (TRAITS[c]) add(c, Math.max(0.5, 2 - i * 0.25)); });
    let codes = Object.keys(weight).sort((x, y) => weight[y] - weight[x] || (x < y ? -1 : 1)).slice(0, n);
    if (!codes.length) { const all = Object.keys(TRAITS); codes = [all[hash32(mod.seed + '|trait') % all.length]]; weight[codes[0]] = 1; }
    const W = codes.reduce((s, c) => s + weight[c], 0);
    const fx = codes.map(c => {
      const t = TRAITS[c];
      const f = codes.length === 1 ? 1 : clampN(0.25 + weight[c] / W * codes.length * 0.5, 0.4, 1);
      let mag = t[2][tier];
      if (c === 'warp') mag = Math.round(mag / f / 10) * 10; // sharing the trait makes the cooldown longer
      else if (c === 'transmute') mag = Math.max(2, Math.round(mag / f));
      else mag = Math.max(1, Math.round(mag * f));
      return { code: c, cat: t[0], mag };
    });
    const stats = {};
    for (const f of fx) if (f.cat === 'passive') stats[PASSIVE_STAT[f.code]] = f.mag;
    return { name: String(entry.name || '').slice(0, 48), desc: String(entry.description || '').slice(0, 400), tier, rarity: RARITY_NAMES[tier], pct: mod.pct, odds: mod.odds, fx, stats };
  }
  const PASSIVE_NAME = { logic: 'Logic', firewall: 'Firewall', clock: 'Clock', vitality: 'HP', capacity: 'Flux', coherence: 'Coherence' };
  function describeTrait(f) {
    const m = f.mag;
    switch (f.code) {
      case 'forage': return `Each mote from a battle has a ${m}% chance to double`;
      case 'tutor': return `+${m}% XP for the whole party`;
      case 'binder': return `+${m}% bind chance`;
      case 'smith': return `${m}% chance a forge costs no motes`;
      case 'nurture': return `Kernels compile ${m}% faster`;
      case 'mender': return `Heals the party ${m}% HP every 25 steps`;
      case 'fortune': return `Prismatic daemons are ${m}% more likely`;
      case 'archive': return `${m}% chance a new merge also gives a mote of its lead essence`;
      case 'lure': return `${m}% more wild encounters`;
      case 'shroud': return `${m}% fewer wild encounters`;
      case 'pulse': return `Heal the party ${m}% HP (every ${ACTIVE_CD.pulse} steps)`;
      case 'warp': return `Return to the last terminal (every ${m} steps)`;
      case 'repel': return `No wild encounters for ${m} steps (every ${ACTIVE_CD.repel} steps)`;
      case 'hasten': return `Compiling kernels advance ${m} steps (every ${ACTIVE_CD.hasten} steps)`;
      case 'transmute': return `Turn ${m} motes of your most plentiful essence into 1 of its lead essence (every ${ACTIVE_CD.transmute} steps)`;
      default: return PASSIVE_NAME[f.code] ? `+${m}% ${PASSIVE_NAME[f.code]} in battle` : '';
    }
  }

  function validIds(req) { return ID_RE.test(req.a.id) && ID_RE.test(req.b.id); }

  // ---- browser client ----
  let conf = { url: '/bridge', key: '' };
  let status = { state: 'unknown', detail: '' }; // unknown | online | offline | error
  let cache = {};
  let outbox = {}; // cacheKey -> 1: designs the player needs that the database has not saved yet
  let resolveRec = null; // set by the game: (key, kind) -> record, null (not now) or false (drop it)
  let retryTimer = null;
  const inflight = new Map();
  const queue = [];
  let busy = false;
  const listeners = [];
  const failed = new Set();
  let strikes = 0; // merges in a row that used up their retries

  function ls(get, k, v) { try { if (get) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } return null; }
  function loadLocal() {
    try { conf = Object.assign(conf, JSON.parse(ls(true, CONF_KEY) || '{}')); } catch (e) { /* keep defaults */ }
    try { cache = JSON.parse(ls(true, CACHE_KEY) || '{}') || {}; } catch (e) { cache = {}; }
    try { outbox = JSON.parse(ls(true, OUTBOX_KEY) || '{}') || {}; } catch (e) { outbox = {}; }
  }
  function saveCache() { ls(false, CACHE_KEY, JSON.stringify(cache)); }
  function saveOutbox() { ls(false, OUTBOX_KEY, JSON.stringify(outbox)); }
  function unbox(ck) { if (outbox[ck]) { delete outbox[ck]; saveOutbox(); } }
  function setConf(c) { conf = Object.assign(conf, c); ls(false, CONF_KEY, JSON.stringify(conf)); status = { state: 'unknown', detail: '' }; failed.clear(); strikes = 0; emit(); }
  function emit(ev) { for (const f of listeners) try { f(ev || { type: 'status', status }); } catch (e) { /* listener error */ } }
  function on(f) { listeners.push(f); }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const OFFLINE = 'FriedrichBridge is not running. Start it with start_bridge.bat.';

  async function call(path, opts) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    const headers = { 'Content-Type': 'application/json' };
    if (conf.key) headers['X-API-Key'] = conf.key;
    try {
      const res = await fetch(conf.url.replace(/\/$/, '') + path, Object.assign({ headers, signal: ctl.signal }, opts || {}));
      let body = null;
      try { body = await res.json(); } catch (e) { body = null; }
      return { status: res.status, body };
    } catch (e) {
      // a client-side timeout means the bridge is slow, not down: treat it like a retryable 504
      if (e.name === 'AbortError') return { status: 504, body: { detail: 'timed out', retryable: true } };
      return { status: 0, body: { detail: 'connection refused' }, network: true };
    } finally { clearTimeout(timer); }
  }

  async function health() {
    const r = await call('/health', { method: 'GET' });
    if (r.status === 200) status = { state: 'online', detail: '' };
    else if (r.network || (r.body && r.body.bridge_down)) status = { state: 'offline', detail: OFFLINE, retry: true };
    else if (r.status === 401) status = { state: 'error', detail: 'The bridge rejected the API key (401).' };
    else status = { state: 'error', detail: `Bridge health check failed (${r.status}).` };
    emit();
    if (status.state === 'online') flush(); else scheduleRetry();
    return status;
  }

  // Handles every outcome in the bridge contract.
  async function doMerge(job) {
    for (let attempt = 0; attempt <= BACKOFF.length; attempt++) {
      const r = await call('/merge', { method: 'POST', body: JSON.stringify(job.req) });
      if (r.status === 200 && r.body && r.body.item) {
        status = { state: 'online', detail: '' }; strikes = 0;
        return { ok: true, item: r.body.item, cached: !!r.body.cached, bridgeKey: r.body.key };
      }
      const b = r.body || {};
      if (r.network || b.bridge_down) { status = { state: 'offline', detail: OFFLINE, retry: true }; return { ok: false, stop: true }; }
      if (r.status === 401) { status = { state: 'error', detail: 'The bridge rejected the API key (401). Check FRIEDRICH_BRIDGE_KEY.' }; console.error('[bridge] 401', b); return { ok: false, stop: true }; }
      if (r.status === 404) { status = { state: 'error', detail: 'The configured Ollama model is not installed (404): ' + String(b.detail || '') }; console.error('[bridge] 404', b); return { ok: false, stop: true }; }
      if (r.status === 403) { status = { state: 'error', detail: 'The game proxy refused the request (403): ' + String(b.detail || '') }; console.error('[bridge] 403', b); return { ok: false, stop: true }; }
      if (r.status === 422 && Array.isArray(b.detail)) { console.error('[bridge] malformed request (game bug)', job.req, b.detail); return { ok: false, malformed: true }; }
      if (r.status === 422) return { ok: false, modelFailed: true };
      if ([502, 503, 504].includes(r.status) && b.retryable !== false && attempt < BACKOFF.length) { await sleep(BACKOFF[attempt]); continue; }
      // retries used up: this merge is "try again later" (not retried this session). Only a second
      // merge in a row failing this way marks the backend unavailable and drops the queue.
      if (++strikes >= 2) { status = { state: 'error', detail: `The AI backend is unavailable (${r.status}). Try again later.`, retry: true }; return { ok: false, later: true, stop: true }; }
      return { ok: false, later: true };
    }
    return { ok: false };
  }

  // Highest priority first, oldest first within a priority.
  function nextJob() { let bi = 0; for (let i = 1; i < queue.length; i++) if (queue[i].pri > queue[bi].pri) bi = i; return queue.splice(bi, 1)[0]; }
  async function pump() {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const job = nextJob();
      const res = await doMerge(job);
      if (res.ok) {
        const it = res.item;
        // unknown fields (e.g. added later through merge_schema) are kept in the cache
        const entry = { ...it, name: String(it.name || '').slice(0, 48), description: String(it.description || '').slice(0, 400), rarity: it.rarity || '', tags: Array.isArray(it.tags) ? it.tags.slice(0, 12) : [], stats: it.stats || {}, id: it.id, at: Date.now() };
        if (entry.name) { cache[job.cacheKey] = entry; saveCache(); }
        unbox(job.cacheKey); // the database has it now
        job.resolve(entry.name ? entry : null);
        emit({ type: 'flavor', kind: job.kind, key: job.key, entry, fresh: !res.cached });
      } else {
        if (res.modelFailed || res.later) failed.add(job.cacheKey); // stays in the outbox for next session
        if (res.malformed) unbox(job.cacheKey); // a game bug: asking again can't help
        job.resolve(null);
      }
      inflight.delete(job.cacheKey);
      emit();
      if (res.stop) { // bridge down or misconfigured: drop the rest of the queue for now (the outbox keeps it)
        while (queue.length) { const j = queue.shift(); inflight.delete(j.cacheKey); j.resolve(null); }
        scheduleRetry();
      }
    }
    busy = false;
  }

  // Ask the bridge, and so its database, for a design. Resolves with the cached entry, a fresh
  // one, or null. opts.pri: 2 = just happened in play (default), 1 = backlog, 0 = bulk design.
  // Unless opts.record is false, the request stays in the outbox, across sessions, until the
  // database has saved it.
  function flavor(key, kind, rec, opts) {
    opts = opts || {};
    const cacheKey = kind + ':' + key, pri = opts.pri == null ? 2 : opts.pri;
    if (cache[cacheKey]) { unbox(cacheKey); return Promise.resolve(cache[cacheKey]); }
    if (opts.record !== false && !outbox[cacheKey]) { outbox[cacheKey] = 1; saveOutbox(); }
    if (inflight.has(cacheKey)) { const j = queue.find(q => q.cacheKey === cacheKey); if (j && pri > j.pri) j.pri = pri; return inflight.get(cacheKey); }
    if (status.state === 'offline' || status.state === 'error' || failed.has(cacheKey)) { scheduleRetry(); return Promise.resolve(null); }
    const req = request(key, kind, rec);
    if (!validIds(req)) { console.error('[bridge] invalid ids', req); unbox(cacheKey); return Promise.resolve(null); }
    const pr = new Promise(resolve => queue.push({ key, kind, cacheKey, req, resolve, pri }));
    inflight.set(cacheKey, pr);
    pump();
    return pr;
  }

  // Replays the outbox: everything the player needs that the database hasn't saved yet.
  function flush() {
    if (!resolveRec) return 0;
    let n = 0, dirty = false;
    for (const ck of Object.keys(outbox)) {
      if (cache[ck]) { delete outbox[ck]; dirty = true; continue; }
      if (failed.has(ck) || inflight.has(ck)) continue;
      const i = ck.indexOf(':'), kind = ck.slice(0, i), key = ck.slice(i + 1);
      const rec = isKind(kind) ? resolveRec(key, kind) : false;
      if (rec === false) { delete outbox[ck]; dirty = true; continue; }
      if (rec) { flavor(key, kind, rec, { pri: 1 }); n++; }
    }
    if (dirty) saveOutbox();
    return n;
  }
  // While the bridge is down (or its model backend is), check again every minute if anything waits.
  function scheduleRetry() {
    if (typeof window === 'undefined' || retryTimer || !status.retry) return;
    if (!Object.keys(outbox).some(ck => !failed.has(ck))) return;
    retryTimer = setTimeout(() => { retryTimer = null; health(); }, RETRY_MS);
  }
  function init(o) { resolveRec = (o && o.rec) || null; }

  function cached(key, kind) { return cache[kind + ':' + key] || null; }
  function allCached() { return cache; }
  function clearCache() { cache = {}; saveCache(); emit(); }
  function pending() { return queue.length + (busy ? 1 : 0); }
  function waiting() { return Object.keys(outbox); }
  function inFlight(key, kind) { return inflight.has(kind + ':' + key); }
  function hasFailed(key, kind) { return failed.has(kind + ':' + key); }
  async function recipes(limit) { const r = await call('/merge/recipes?limit=' + (limit || 50), { method: 'GET' }); return r.status === 200 ? r.body : null; }

  if (typeof window !== 'undefined') loadLocal();

  return {
    // pure mapping
    request, validIds, ID_RE, abilityFrom, offspringFrom, spliceOptions, traitFrom, describeTrait,
    modFor, modulate, seedOf, hash32, breedKey, traitKey, isKind, itemType,
    TYPES, EFFECT_WORDS, ITEM_TYPES, TRAITS, TRAIT_SCOPE, ACTIVE_CD, PEDIGREE, INHERIT, RARITY_NAMES,
    // client
    init, load: loadLocal, health, flavor, flush, cached, allCached, clearCache, pending, waiting, inFlight, hasFailed, recipes, on, setConf,
    get conf() { return Object.assign({}, conf); }, get status() { return status; },
  };
});
