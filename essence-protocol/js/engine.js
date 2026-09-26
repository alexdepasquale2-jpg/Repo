/* Essence Protocol: daemon model and turn-based battle engine.
   Pure logic with no DOM. The browser loads it as the global ENGINE, and
   tools/verify.js requires it to run headless battles. Every merge outcome
   comes from the baked table; this file only decides how that outcome plays
   out against the live battle state (stats, residue, statuses). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./essences.js'), require('./merges.baked.js'));
  else root.ENGINE = factory(root.ESSENCE, root.MERGES);
})(typeof self !== 'undefined' ? self : this, function (E, M) {
  'use strict';

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const F = {}; M.fields.forEach((f, i) => { F[f] = i; });
  const cache = new Map();

  function rec(key) {
    let r = cache.get(key);
    if (r) return r;
    const row = M.table[key];
    if (!row) return null;
    r = { key };
    for (const f of M.fields) r[f] = row[F[f]];
    r.fx = r.fx.map(([code, chance, mag]) => ({ code, chance, mag }));
    const p = E.parseKey(key);
    r.a = p.a; r.b = p.b; r.subs = p.subs; r.tier = p.subs.length;
    r.damaging = r.power > 0;
    r.self = r.cls === 'Mend' || r.cls === 'Ward';
    cache.set(key, r);
    return r;
  }

  const PASSIVES = {
    F:  ['Kindling',    'Fire-led merges hit 25% harder below one-third HP.'],
    W:  ['Flow',        'Restores 1/20 of max HP at the end of each turn.'],
    E:  ['Bedrock',     'Takes 20% less damage from super-effective merges.'],
    A:  ['Tailwind',    'Clock +15%.'],
    Em: ['Afterburn',   'Burns it inflicts deal double damage.'],
    Pl: ['Overcharge',  'Merges hit 15% harder while Flux is above half.'],
    As: ['Smog',        'Foes\' accuracy -10%.'],
    Ti: ['Undertow',    'Barrage merges hit one extra time.'],
    Fr: ['Rime Skin',   'Attackers that hit it may be chilled (20%).'],
    Mi: ['Haze',        'Evasion +10%.'],
    St: ['Plated',      'Firewall +15%.'],
    Me: ['Keen',        'Critical hits are twice as likely.'],
    Ro: ['Anchor',      'Restores 1/16 of max HP at the end of each turn.'],
    Sp: ['Static Skin', 'Attackers that hit it may get static (15%).'],
    Ga: ['Swift',       'Clock +15%.'],
    Ec: ['Reverb',      'Damaging merges have a 20% chance to echo.'],
    Li: ['Radiance',    'Immune to Blind. Status effects on it expire faster.'],
    Vo: ['Hunger',      'Damaging hits drain 3 Flux from the target.'],
    Si: ['Adaptive',    'Deals 5% more damage for each turn on the field (max +25%).'],
    Tm: ['Foresight',   'Its merges are half as likely to destabilize.'],
  };

  const STATUS = {
    burn:    { name: 'Burned',    turns: 5, immune: 'F' },
    frozen:  { name: 'Frozen',    turns: 2, immune: 'W' },
    static:  { name: 'Static',    turns: 4, immune: 'E' },
    rooted:  { name: 'Rooted',    turns: 4, immune: 'A' },
    corrupt: { name: 'Corrupted', turns: 4, immune: null },
    dormant: { name: 'Dormant',   turns: 3, immune: null },
  };
  const FX_TO_STATUS = { burn: 'burn', freeze: 'frozen', static: 'static', root: 'rooted', corrupt: 'corrupt', lullaby: 'dormant' };

  // What happens when a merge lands in an arena already charged with residue.
  // [cast lead][residue element]
  const REACT = {
    F: { W: ['Steam Burst', 'blast'], A: ['Backdraft', 'boost'], E: ['Kiln', 'guard'] },
    W: { F: ['Quench', 'quench'], E: ['Silt', 'blind'], A: ['Downpour', 'soak'] },
    E: { W: ['Mudslide', 'chill'], F: ['Slag', 'burn'], A: ['Grounding', 'shield'] },
    A: { F: ['Flare-up', 'boost'], E: ['Dust Devil', 'blind'], W: ['Spindrift', 'veil'] },
  };

  const ATTUNE_LEVELS = [6, 10, 14, 18, 22, 26, 30, 35, 40, 45];
  const RECOMPILE_LEVELS = [12, 22, 32];
  const LEVEL_CAP = 60;

  function passiveOf(d) { return rec(d.key).dPassive; }
  function tierOf(key) { return E.parseKey(key).subs.length; }
  function levelWidth(level) { return level < 10 ? 1 : level < 22 ? 2 : 3; }
  function width(d) { return Math.max(levelWidth(d.level), tierOf(d.key)); }
  function xpFor(level) { return Math.floor(Math.pow(level, 3) * 0.9); }
  function mainsOf(key) { const p = E.parseKey(key); return p.a === p.b ? [p.a] : [p.a, p.b]; }

  function calcStats(d) {
    const b = rec(d.key).dStats, L = d.level;
    const s = {
      hp: Math.floor(2 * b[0] * L / 100) + L + 10,
      atk: Math.floor(2 * b[1] * L / 100) + 5,
      def: Math.floor(2 * b[2] * L / 100) + 5,
      spd: Math.floor(2 * b[3] * L / 100) + 5,
      flux: 16 + Math.floor(b[4] * L / 40) + Math.floor(L / 2),
      coh: Math.floor(2 * b[5] * L / 100) + 5,
    };
    if (d.prism) for (const k in s) s[k] = Math.floor(s[k] * 1.1);
    const pv = passiveOf(d);
    if (pv === 'St') s.def = Math.floor(s.def * 1.15);
    if (pv === 'A' || pv === 'Ga') s.spd = Math.floor(s.spd * 1.15);
    return s;
  }

  function eligibleSubs(key) {
    const p = E.parseKey(key);
    return E.SUB_ORDER.filter(s => E.eligible(s, p.a) || E.eligible(s, p.b));
  }

  function composableFor(d) { return E.composable(mainsOf(d.key), d.attuned, width(d)); }

  function canCompose(d, key) {
    if (!E.validKey(key)) return false;
    const p = E.parseKey(key);
    const ms = mainsOf(d.key);
    if (!ms.includes(p.a) || !ms.includes(p.b)) return false;
    if (p.subs.length > width(d)) return false;
    return p.subs.every(t => d.attuned.includes(t.s));
  }

  function mergeValue(r, maxFlux) {
    if (r.flux > maxFlux * 0.7) return -1;
    let v = 0;
    if (r.damaging) v = r.power * r.hits * Math.min(r.acc, 100) / 100 * (1 - r.instab / 180);
    for (const f of r.fx) {
      if (f.code === 'recoil') v -= f.mag * 0.6;
      else if (FX_TO_STATUS[f.code] || f.code === 'petrify') v += f.chance * 0.35;
      else if (f.code === 'heal') v += f.mag * 0.9;
      else if (f.code === 'shield') v += f.mag * 0.9;
      else v += f.chance * 0.12;
    }
    return v - r.flux * 0.8;
  }

  // Four merges a daemon would sensibly keep in memory.
  function autoMemory(d) {
    const mf = calcStats(d).flux;
    const scored = composableFor(d).map(k => ({ k, r: rec(k) })).map(x => ({ ...x, v: mergeValue(x.r, mf) })).filter(x => x.v > 0);
    scored.sort((x, y) => (y.v - x.v) || (x.k < y.k ? -1 : 1));
    const out = [];
    const take = f => { const x = scored.find(s => !out.includes(s.k) && f(s)); if (x) out.push(x.k); };
    const ms = mainsOf(d.key);
    take(s => s.r.damaging && s.r.a === ms[0]);
    take(s => s.r.damaging && s.r.a === (ms[1] || ms[0]) && !out.some(k => rec(k).a === s.r.a && rec(k).b === s.r.b));
    take(s => !s.r.damaging || s.r.cls === 'Hex');
    take(s => s.r.damaging);
    while (out.length < 4) { const x = scored.find(s => !out.includes(s.k)); if (!x) break; out.push(x.k); }
    if (!out.length) out.push(ms[0] + ms[0]);
    while (out.length < 4) out.push(null);
    return out;
  }

  let uidSeq = 1;
  function createDaemon(key, level, opts) {
    opts = opts || {};
    const rng = opts.rng || Math.random;
    const d = {
      uid: opts.uid || ('d' + Date.now().toString(36) + (uidSeq++).toString(36) + Math.floor(rng() * 1e6).toString(36)),
      key, level, xp: xpFor(level), hp: 0, attuned: E.parseKey(key).subs.map(t => t.s).filter((s, i, a) => a.indexOf(s) === i),
      memory: [null, null, null, null], nick: null,
    };
    const extra = opts.extraAttune != null ? opts.extraAttune : Math.floor(level / 10);
    const pool = eligibleSubs(key).filter(s => !d.attuned.includes(s));
    for (let i = 0; i < extra && pool.length; i++) d.attuned.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
    if (opts.attune) for (const s of opts.attune) if (!d.attuned.includes(s)) d.attuned.push(s);
    d.hp = calcStats(d).hp;
    d.memory = opts.memory ? opts.memory.slice(0, 4).concat([null, null, null, null]).slice(0, 4) : autoMemory(d);
    return d;
  }

  function recompileOptions(d) {
    const p = E.parseKey(d.key);
    const n = p.subs.length;
    if (n >= 3 || d.level < RECOMPILE_LEVELS[n]) return [];
    const out = [];
    for (const s of d.attuned) {
      for (const h of p.a === p.b ? [1] : [1, 2]) {
        const main = h === 1 ? p.a : p.b;
        if (!E.eligible(s, main)) continue;
        if (p.subs.some(t => t.s === s && t.h === h)) continue;
        const k = E.makeKey(p.a, p.b, p.subs.concat([{ s, h }]));
        if (M.table[k] && !out.includes(k)) out.push(k);
      }
    }
    return out;
  }

  function recompile(d, newKey) {
    const before = calcStats(d);
    d.key = newKey;
    for (const t of E.parseKey(newKey).subs) if (!d.attuned.includes(t.s)) d.attuned.push(t.s);
    const after = calcStats(d);
    d.hp = clamp(d.hp + (after.hp - before.hp), 1, after.hp);
  }

  // Gain XP; returns {levels:[..], attune:[levels], recompile:bool}
  function gainXp(d, amount) {
    const res = { levels: [], attune: 0, recompile: false };
    if (d.level >= LEVEL_CAP) return res;
    d.xp += amount;
    while (d.level < LEVEL_CAP && d.xp >= xpFor(d.level + 1)) {
      const before = calcStats(d);
      d.level++;
      const after = calcStats(d);
      d.hp = Math.min(after.hp, d.hp + (after.hp - before.hp));
      res.levels.push(d.level);
      if (ATTUNE_LEVELS.includes(d.level)) res.attune++;
      if (RECOMPILE_LEVELS.includes(d.level)) res.recompile = true;
    }
    return res;
  }

  function xpYield(enemy, trainer) {
    const b = rec(enemy.key).dStats.reduce((s, v) => s + v, 0) / 9;
    return Math.max(4, Math.floor(b * enemy.level / 5 * (trainer ? 1.5 : 1)));
  }

  function weights(key) {
    const p = E.parseKey(key);
    return p.a === p.b ? [[p.a, 1]] : [[p.a, 0.65], [p.b, 0.35]];
  }
  function effectiveness(mergeKey, defKey) {
    let m = 0;
    for (const [x, wx] of weights(mergeKey)) for (const [y, wy] of weights(defKey)) m += wx * wy * E.chart(x, y);
    return Math.round(m * 100) / 100;
  }

  function captureChance(target, hpNow, maxHp, lattice, hasStatus) {
    const tier = tierOf(target.key);
    let c = (1 - (2 / 3) * (hpNow / maxHp)) * (lattice.power || 1);
    if (hasStatus) c *= 1.6;
    if (lattice.main && mainsOf(target.key)[0] === lattice.main) c *= 1.5;
    c *= [1, 0.8, 0.6, 0.45][tier];
    c *= 1 + Math.max(0, 12 - target.level) / 24;
    return clamp(c, 0.03, 0.97);
  }

  // ------------------------------------------------------------------
  // Battle
  // ------------------------------------------------------------------
  const STAGES = ['atk', 'def', 'spd', 'acc', 'eva'];
  function stageMul(s) { return s >= 0 ? (2 + s) / 2 : 2 / (2 - s); }
  function accMul(s) { return s >= 0 ? (3 + s) / 3 : 3 / (3 - s); }

  function freshVolatile(d) {
    const st = calcStats(d);
    return {
      stats: st, flux: st.flux, stages: { atk: 0, def: 0, spd: 0, acc: 0, eva: 0 }, crit: 0,
      status: null, soak: 0, regen: 0, regenMag: 0, shield: 0, phase: 0, mirror: false, petrify: false,
      echo: null, delayed: [], hpHist: [d.hp, d.hp], turnsIn: 0, burnMul: 1,
    };
  }

  class Battle {
    /* opts: { player: [daemons], enemy: [daemons], wild: bool, trainer: {name, ...}, rng, discovered: Set } */
    constructor(opts) {
      this.rng = opts.rng || Math.random;
      this.wild = !!opts.wild;
      this.trainer = opts.trainer || null;
      this.discovered = opts.discovered || new Set();
      this.sides = [
        { name: 'You', team: opts.player, active: 0, v: null, isPlayer: true, participants: new Set() },
        { name: this.wild ? 'Wild' : (this.trainer && this.trainer.name) || 'Foe', team: opts.enemy, active: 0, v: null, isPlayer: false },
      ];
      this.residue = { F: 0, W: 0, E: 0, A: 0 };
      this.field = null; // {el, turns, name}
      this.turn = 0;
      this.over = false;
      this.result = null; // 'win' | 'lose' | 'run' | 'bind'
      this.needSwitch = false;
      this.events = [];
      this.rewards = { xp: [], motes: {}, bound: null };
      for (const s of this.sides) {
        s.active = s.team.findIndex(d => d.hp > 0);
        if (s.active < 0) s.active = 0;
        s.v = freshVolatile(s.team[s.active]);
      }
      this.sides[0].participants.add(this.sides[0].team[this.sides[0].active].uid);
    }

    act(i) { const s = this.sides[i]; return s.team[s.active]; }
    ev(type, data) { const e = Object.assign({ type }, data || {}); this.events.push(e); return e; }
    msg(text, extra) { return this.ev('msg', Object.assign({ text }, extra || {})); }
    label(i) { const d = this.act(i); const r = rec(d.key); const nm = d.nick || r.dName; return i === 0 ? nm : (this.wild ? 'the wild ' : 'the foe\'s ') + nm; }
    labelCap(i) { const s = this.label(i); return s[0].toUpperCase() + s.slice(1); }
    hpEv(i) { const d = this.act(i); this.ev('hp', { side: i, hp: d.hp, max: this.sides[i].v.stats.hp, shield: this.sides[i].v.shield }); }
    fluxEv(i) { const v = this.sides[i].v; this.ev('flux', { side: i, flux: v.flux, max: v.stats.flux }); }
    stateEv() { this.ev('field', { residue: Object.assign({}, this.residue), field: this.field && Object.assign({}, this.field) }); }
    statusEv(i) { const v = this.sides[i].v; this.ev('status', { side: i, status: v.status && v.status.id, stages: Object.assign({}, v.stages), soak: v.soak > 0, shield: v.shield, regen: v.regen > 0 }); }

    // ---- enemy AI ----
    chooseEnemy() {
      const d = this.act(1), v = this.sides[1].v, foe = this.act(0);
      const smart = !this.wild;
      const opts = [];
      for (const k of d.memory) {
        if (!k) continue;
        const r = rec(k);
        if (!r || r.flux > v.flux) continue;
        if (this.rt && !isAttack(k) && (this.rt[1].cds[k] || 0) > 0) continue;
        let s = 0;
        if (r.damaging) {
          s = r.power * r.hits * Math.min(r.acc, 100) / 100 * effectiveness(k, foe.key) * (1 - r.instab / 150);
          if (smart && (r.fx.some(f => f.code === 'recoil')) && d.hp < v.stats.hp * 0.3) s *= 0.5;
        }
        const hpFrac = d.hp / v.stats.hp;
        for (const f of r.fx) {
          if (f.code === 'heal') s += hpFrac < 0.5 ? f.mag * 2.2 : hpFrac < 0.8 ? f.mag * 0.5 : -20;
          else if (f.code === 'shield') s += v.shield > 0 ? -10 : f.mag * (hpFrac > 0.4 ? 1.4 : 0.6);
          else if (FX_TO_STATUS[f.code]) s += this.sides[0].v.status ? 0 : f.chance * 0.5;
          else if (['guard', 'overclock', 'haste', 'veil', 'focus'].includes(f.code)) s += Math.max(0, 3 - v.stages[f.code === 'guard' ? 'def' : f.code === 'overclock' ? 'atk' : f.code === 'haste' ? 'spd' : f.code === 'veil' ? 'eva' : 'acc']) * f.chance * 0.08;
        }
        if (r.cls === 'Field' && this.field && this.field.el === r.a) s *= 0.4;
        s *= smart ? 0.9 + this.rng() * 0.2 : 0.6 + this.rng() * 0.8;
        opts.push({ k, s });
      }
      const minCost = Math.min(...d.memory.filter(Boolean).map(k => rec(k).flux));
      if (!opts.length || (v.flux < minCost)) return { type: 'defrag' };
      opts.sort((a, b) => b.s - a.s);
      if (opts[0].s <= 0 && v.flux < v.stats.flux * 0.5) return { type: 'defrag' };
      return { type: 'merge', key: opts[0].k };
    }

    speedOf(i) {
      const v = this.sides[i].v;
      let s = v.stats.spd * stageMul(v.stages.spd);
      if (v.status && v.status.id === 'static') s *= 0.75;
      return s;
    }

    // Run one full turn with the player's action.
    turnWith(pAction) {
      this.events = [];
      if (this.over || this.needSwitch) return this.events;
      this.turn++;
      const eAction = this.chooseEnemy();
      const acts = [{ i: 0, a: pAction }, { i: 1, a: eAction }];
      const pri = x => {
        if (x.a.type !== 'merge') return 10;
        const r = rec(x.a.key);
        return r.prio;
      };
      acts.sort((x, y) => (pri(y) - pri(x)) || (this.speedOf(y.i) - this.speedOf(x.i)) || (this.rng() < 0.5 ? -1 : 1));
      for (const x of acts) {
        if (this.over) break;
        if (this.act(x.i).hp <= 0) continue;
        this.perform(x.i, x.a);
        if (this.checkFaints()) break;
      }
      if (!this.over) this.endOfTurn();
      this.checkFaints();
      return this.events;
    }

    perform(i, a) {
      if (a.type === 'merge') return this.doMerge(i, a.key);
      if (a.type === 'defrag') return this.doDefrag(i);
      if (a.type === 'switch') return this.doSwitch(i, a.idx);
      if (a.type === 'run') return this.doRun(i);
      if (a.type === 'item') return this.doItem(i, a.item);
      if (a.type === 'bind') return this.doBind(i, a.item);
    }

    doDefrag(i) {
      const v = this.sides[i].v;
      const gain = Math.ceil(v.stats.flux * 0.45);
      v.flux = Math.min(v.stats.flux, v.flux + gain);
      if (v.status && v.status.id === 'corrupt') { v.status.turns = Math.max(1, v.status.turns - 2); }
      this.msg(`${this.labelCap(i)} defragments and recovers Flux.`, { side: i, anim: 'defrag' });
      this.fluxEv(i);
    }

    doRun(i) {
      const v = this.sides[i].v;
      if (!this.wild) { this.msg('You can\'t disconnect from an Operator duel!'); return; }
      if (v.status && v.status.id === 'rooted') { this.msg(`${this.labelCap(i)} is rooted in place!`); return; }
      const ch = clamp(0.5 + (this.speedOf(0) - this.speedOf(1)) / (this.speedOf(1) * 2 + 1), 0.25, 0.95);
      if (this.rng() < ch) { this.msg('Disconnected safely.'); this.over = true; this.result = 'run'; }
      else this.msg('Couldn\'t disconnect!');
    }

    doSwitch(i, idx) {
      const s = this.sides[i];
      const v = s.v;
      if (v && v.status && v.status.id === 'rooted' && this.act(i).hp > 0) { this.msg(`${this.labelCap(i)} is rooted and can't be recalled!`); return; }
      const out = this.act(i);
      if (out.hp > 0) this.msg(i === 0 ? `${out.nick || rec(out.key).dName}, return!` : `${s.name} recalls ${rec(out.key).dName}.`);
      s.active = idx;
      s.v = freshVolatile(this.act(i));
      if (i === 0) s.participants.add(this.act(0).uid);
      this.ev('switch', { side: i, key: this.act(i).key, uid: this.act(i).uid });
      this.msg(i === 0 ? `Go, ${this.label(0)}!` : `${s.name} deploys ${rec(this.act(i).key).dName}!`);
      this.hpEv(i); this.fluxEv(i); this.statusEv(i);
    }

    // Replacement after a faint (outside turn order).
    forceSwitch(idx) {
      this.events = [];
      this.needSwitch = false;
      this.doSwitch(0, idx);
      return this.events;
    }

    doItem(i, item) {
      const d = this.act(i), v = this.sides[i].v;
      if (item.kind === 'patch') {
        const amt = Math.ceil(v.stats.hp * item.mag / 100);
        d.hp = Math.min(v.stats.hp, d.hp + amt);
        if (item.cleanse) { v.status = null; }
        this.msg(`${item.name} restores ${this.label(i)}.`, { side: i, anim: 'heal' });
        this.hpEv(i); this.statusEv(i);
      } else if (item.kind === 'ward') {
        v.shield = Math.min(Math.ceil(v.stats.hp * 0.6), v.shield + Math.ceil(v.stats.hp * item.mag / 100));
        this.msg(`${item.name} wraps ${this.label(i)} in a shield.`, { side: i, anim: 'shield' });
        this.hpEv(i); this.statusEv(i);
      } else if (item.kind === 'catalyst') {
        this.residue[item.main] = Math.min(6, this.residue[item.main] + 3);
        this.field = { el: item.main, turns: 5 };
        this.msg(`${item.name} saturates the arena with ${E.MAIN[item.main].name}.`, { anim: 'field', el: item.main });
        this.stateEv();
      } else if (item.kind === 'cell') {
        v.flux = v.stats.flux;
        this.msg(`${this.labelCap(i)}'s Flux is fully restored.`); this.fluxEv(i);
      }
    }

    doBind(i, lattice) {
      if (!this.wild) { this.msg('You can\'t bind an Operator\'s daemon!'); return; }
      const t = this.act(1), v = this.sides[1].v;
      const ch = captureChance(t, t.hp, v.stats.hp, lattice, !!v.status);
      this.msg(`You cast a ${lattice.name}!`, { anim: 'bind' });
      const shakes = [0, 1, 2].map(() => this.rng());
      const per = Math.pow(ch, 1 / 3);
      let n = 0;
      while (n < 3 && shakes[n] < per) n++;
      for (let k = 0; k < Math.min(n, 3); k++) this.ev('shake', { n: k + 1 });
      if (n >= 3) {
        this.msg(`${rec(t.key).dName} was bound!`, { anim: 'bound' });
        this.over = true; this.result = 'bind'; this.rewards.bound = t;
      } else {
        this.ev('unbind');
        this.msg(['It broke free instantly!', 'So close... it slipped the lattice.', 'Almost! The lattice cracked.'][Math.min(n, 2)]);
      }
    }

    skipCheck(i) {
      const v = this.sides[i].v;
      if (v.petrify) { v.petrify = false; this.msg(`${this.labelCap(i)} is petrified and can't move!`); return true; }
      if (!v.status) return false;
      const id = v.status.id;
      if (id === 'frozen') { this.msg(`${this.labelCap(i)} is frozen solid!`, { side: i, anim: 'frozen' }); return true; }
      if (id === 'dormant') { this.msg(`${this.labelCap(i)} is dormant...`); return true; }
      if (id === 'static' && this.rng() < 0.25) { this.msg(`${this.labelCap(i)} locks up with static!`, { side: i, anim: 'static' }); return true; }
      return false;
    }

    discover(i, key) {
      const isNew = !this.discovered.has(key);
      this.discovered.add(key);
      if (isNew) this.ev('discover', { key, by: i });
    }

    instabilityOf(i, r) {
      const v = this.sides[i].v, d = this.act(i);
      let x = r.instab;
      if (v.status && v.status.id === 'corrupt') x += 15;
      x *= clamp(1.3 - v.stats.coh / 120, 0.5, 1.2);
      if (passiveOf(d) === 'Tm') x *= 0.5;
      return clamp(x, 0, 80) / 100;
    }

    mutate(r) {
      const p = E.parseKey(r.key);
      const cands = [];
      if (p.a !== p.b) cands.push(E.makeKey(p.b, p.a, p.subs.map(t => ({ s: t.s, h: 3 - t.h }))));
      for (let j = 0; j < p.subs.length; j++) cands.push(E.makeKey(p.a, p.b, p.subs.filter((_, k) => k !== j)));
      for (let j = 0; j < p.subs.length; j++) {
        if (p.a === p.b) continue;
        const flip = p.subs.map((t, k) => k === j ? { s: t.s, h: 3 - t.h } : t);
        const k2 = E.makeKey(p.a, p.b, flip);
        if (E.validKey(k2)) cands.push(k2);
      }
      const ok = cands.filter(k => M.table[k]);
      if (!ok.length) return null;
      return rec(ok[Math.floor(this.rng() * ok.length)]);
    }

    doMerge(i, key) {
      const s = this.sides[i], d = this.act(i), v = s.v;
      const j = 1 - i, tgt = this.act(j), tv = this.sides[j].v;
      let r = rec(key);
      if (!r) return;
      if (this.skipCheck(i)) return;
      if (r.flux > v.flux) { this.msg(`${this.labelCap(i)} doesn't have enough Flux!`); return; }
      v.flux -= r.flux;
      this.fluxEv(i);
      this.discover(i, r.key);
      this.msg(`${this.labelCap(i)} merges ${r.name}!`, { side: i, anim: 'cast', key: r.key });

      let powMul = 1;
      // Instability: backfire or mutation.
      if (this.rng() < this.instabilityOf(i, r)) {
        const mut = this.rng() < 0.5 ? this.mutate(r) : null;
        if (mut) {
          r = mut;
          this.msg(`The merge destabilizes and mutates into ${r.name}!`, { anim: 'glitch', side: i, key: r.key });
          this.discover(i, r.key);
        } else {
          const dmg = Math.max(1, Math.floor(v.stats.hp / 8));
          d.hp = Math.max(0, d.hp - dmg);
          this.msg(`The merge destabilizes and backfires on ${this.label(i)}!`, { anim: 'glitch', side: i });
          this.hpEv(i);
          powMul *= 0.6;
          if (d.hp <= 0) return;
        }
      }

      // Residue reaction.
      const lead = r.a;
      const extra = { boost: 1, flatBlast: 0, statusBonus: null };
      const rx = REACT[lead];
      for (const el of Object.keys(rx)) {
        if (this.residue[el] >= 2) {
          const [nm, kind] = rx[el];
          this.residue[el] -= 2;
          this.msg(`${nm}! The ${E.MAIN[lead].name} merge reacts with ${E.MAIN[el].name} residue.`, { anim: 'react', el: lead, el2: el });
          if (kind === 'blast') extra.flatBlast = Math.ceil(tv.stats.hp / 10);
          else if (kind === 'boost') extra.boost = 1.3;
          else if (kind === 'guard') this.stage(i, 'def', 1, true);
          else if (kind === 'quench') { if (v.status && v.status.id === 'burn') v.status = null; this.heal(i, Math.ceil(v.stats.hp / 10), true); }
          else if (kind === 'blind') this.stage(j, 'acc', -1);
          else if (kind === 'chill') this.stage(j, 'spd', -1);
          else if (kind === 'soak') { tv.soak = 3; }
          else if (kind === 'burn') extra.statusBonus = 'burn';
          else if (kind === 'shield') v.shield += Math.ceil(v.stats.hp / 10);
          else if (kind === 'veil') this.stage(i, 'eva', 1, true);
          break;
        }
      }
      const same = this.residue[lead];
      powMul *= (1 + Math.min(same, 5) * 0.06) * extra.boost;
      if (this.field && this.field.el === lead) powMul *= 1.3;
      if (r.fx.some(f => f.code === 'overflow')) powMul *= 1 + v.flux / v.stats.flux;

      // Lay down residue.
      const addRes = (el, n) => { this.residue[el] = Math.min(6, this.residue[el] + n); };
      if (r.cls === 'Field') {
        addRes(r.a, 3); if (r.b !== r.a) addRes(r.b, 2);
        this.field = { el: r.a, turns: 5 };
        this.msg(`The arena is saturated with ${E.MAIN[r.a].name}!`, { anim: 'field', el: r.a });
      } else {
        addRes(r.a, 1);
        if (r.b !== r.a && this.rng() < 0.5) addRes(r.b, 1);
      }

      // Self-targeted merges.
      if (r.self) {
        this.applyFx(i, j, r, 0, true);
        this.stateEv();
        return;
      }

      // Hit check.
      if (tv.phase > 0) { this.msg(`${this.labelCap(j)} is phased out. The merge passes through!`); this.stateEv(); return; }
      if (r.acc <= 100) {
        let acc = r.acc / 100 * accMul(v.stages.acc) / accMul(tv.stages.eva);
        if (passiveOf(tgt) === 'Mi') acc *= 0.9;
        if (passiveOf(tgt) === 'As') acc *= 0.9;
        if (this.rng() > acc) { this.msg(`${this.labelCap(j)} evades the merge!`, { side: j, anim: 'miss' }); this.stateEv(); return; }
      }

      let dealt = 0;
      if (r.damaging) {
        let hits = r.hits;
        if (r.cls === 'Barrage' && passiveOf(d) === 'Ti') hits++;
        let crits = 0;
        const eff = effectiveness(r.key, tgt.key);
        for (let h = 0; h < hits && tgt.hp > 0; h++) {
          const out = this.damage(i, j, r, powMul, eff);
          dealt += out.dmg; if (out.crit) crits++;
        }
        if (hits > 1) this.msg(`Hit ${hits} times!`);
        if (crits) this.msg(crits > 1 ? `${crits} critical hits!` : 'A critical hit!');
        if (eff >= 1.2) this.msg('It\'s super effective!');
        else if (eff <= 0.83) this.msg('It\'s not very effective...');
        if (extra.flatBlast && tgt.hp > 0) { this.dealRaw(j, extra.flatBlast); this.msg(`Scalding steam engulfs ${this.label(j)}!`); }
        if (passiveOf(d) === 'Vo' && dealt > 0) { tv.flux = Math.max(0, tv.flux - 3); this.fluxEv(j); }
        if (dealt > 0 && tgt.hp > 0) {
          const tp = passiveOf(tgt);
          if (tp === 'Fr' && this.rng() < 0.2) { this.stage(i, 'spd', -1); this.msg(`${this.labelCap(j)}'s rime skin chills the attacker.`); }
          if (tp === 'Sp' && this.rng() < 0.15) this.setStatus(i, 'static', j);
        }
        if (tgt.hp > 0 && tv.status) {
          if (tv.status.id === 'dormant') { tv.status = null; this.msg(`${this.labelCap(j)} jolts awake!`); this.statusEv(j); }
          else if (tv.status.id === 'frozen' && r.a === 'F') { tv.status = null; this.msg(`${this.labelCap(j)} thaws out!`); this.statusEv(j); }
        }
      }
      if (extra.statusBonus && tgt.hp > 0 && this.rng() < 0.5) this.setStatus(j, extra.statusBonus, i);
      this.applyFx(i, j, r, dealt, false);
      if (dealt > 0 && passiveOf(d) === 'Ec' && !v.echo && this.rng() < 0.2) v.echo = { dmg: Math.ceil(dealt * 0.5), name: r.name };
      this.stateEv();
    }

    damage(i, j, r, powMul, eff) {
      const d = this.act(i), v = this.sides[i].v, t = this.act(j), tv = this.sides[j].v;
      const pierce = r.fx.some(f => f.code === 'pierce');
      let critStage = v.crit + (r.fx.some(f => f.code === 'crit') ? 1 : 0);
      let critCh = [1 / 16, 1 / 8, 1 / 4, 1 / 2][clamp(critStage, 0, 3)];
      if (passiveOf(d) === 'Me') critCh *= 2;
      const crit = this.rng() < critCh;
      let atkSt = v.stages.atk, defSt = tv.stages.def;
      if (crit) { atkSt = Math.max(0, atkSt); defSt = Math.min(0, defSt); }
      if (pierce) defSt = Math.min(0, defSt);
      const atk = v.stats.atk * stageMul(atkSt);
      const def = tv.stats.def * stageMul(defSt);
      let base = ((2 * d.level / 5 + 2) * r.power * atk / def) / 50 + 2;
      let m = eff * powMul * (0.85 + this.rng() * 0.15);
      if (crit) m *= 1.5;
      if (v.status && v.status.id === 'burn') m *= 0.85;
      if (tv.soak > 0) { if (r.a === 'F') m *= 0.6; else if (r.a === 'A') m *= 1.3; }
      const pv = passiveOf(d);
      if (pv === 'F' && r.a === 'F' && d.hp < v.stats.hp / 3) m *= 1.25;
      if (pv === 'Pl' && v.flux > v.stats.flux / 2) m *= 1.15;
      if (pv === 'Si') m *= 1 + Math.min(5, v.turnsIn) * 0.05;
      if (passiveOf(t) === 'E' && eff >= 1.2) m *= 0.8;
      let dmg = Math.max(1, Math.floor(base * m));
      this.dealDamage(j, dmg, pierce, i, crit);
      return { dmg, crit };
    }

    dealDamage(j, dmg, pierce, from, crit) {
      const t = this.act(j), tv = this.sides[j].v;
      let rest = dmg;
      if (tv.shield > 0 && !pierce) {
        const ab = Math.min(tv.shield, rest);
        tv.shield -= ab; rest -= ab;
        if (ab > 0) this.ev('absorb', { side: j, amount: ab });
      }
      t.hp = Math.max(0, t.hp - rest);
      this.ev('hit', { side: j, amount: dmg, crit: !!crit });
      this.hpEv(j);
      if (tv.mirror && from != null && rest > 0) {
        tv.mirror = false;
        const back = Math.ceil(rest / 2);
        this.msg(`${this.labelCap(j)}'s mirror reflects the damage!`);
        this.dealRaw(from, back);
      }
    }

    dealRaw(j, dmg) {
      const t = this.act(j);
      t.hp = Math.max(0, t.hp - dmg);
      this.ev('hit', { side: j, amount: dmg });
      this.hpEv(j);
    }

    heal(i, amt, quiet) {
      const d = this.act(i), v = this.sides[i].v;
      const before = d.hp;
      d.hp = Math.min(v.stats.hp, d.hp + Math.max(0, Math.floor(amt)));
      if (d.hp > before) { this.ev('healed', { side: i, amount: d.hp - before }); this.hpEv(i); if (!quiet) this.msg(`${this.labelCap(i)} restores ${d.hp - before} HP.`); }
    }

    stage(i, stat, delta, quiet) {
      const v = this.sides[i].v;
      const before = v.stages[stat];
      v.stages[stat] = clamp(before + delta, -3, 3);
      const names = { atk: 'Logic', def: 'Firewall', spd: 'Clock', acc: 'Accuracy', eva: 'Evasion' };
      if (v.stages[stat] === before) { if (!quiet) this.msg(`${this.labelCap(i)}'s ${names[stat]} won't go any ${delta > 0 ? 'higher' : 'lower'}.`); }
      else this.msg(`${this.labelCap(i)}'s ${names[stat]} ${delta > 0 ? 'rose' : 'fell'}!`, { side: i, anim: delta > 0 ? 'buff' : 'debuff' });
      this.statusEv(i);
    }

    setStatus(j, id, from) {
      const t = this.act(j), tv = this.sides[j].v;
      if (t.hp <= 0) return false;
      if (tv.status) return false;
      const S = STATUS[id];
      if (S.immune && mainsOf(t.key)[0] === S.immune) return false;
      let turns = S.turns;
      if (id === 'frozen') turns = 1 + Math.floor(this.rng() * 2);
      if (passiveOf(t) === 'Li') turns = Math.max(1, turns - 2);
      tv.status = { id, turns };
      if (id === 'burn' && from != null && passiveOf(this.act(from)) === 'Em') tv.burnMul = 2; else tv.burnMul = 1;
      const txt = { burn: 'is burned!', frozen: 'is frozen solid!', static: 'is locked up with static!', rooted: 'is rooted in place!', corrupt: 'is corrupted!', dormant: 'falls dormant...' }[id];
      this.msg(`${this.labelCap(j)} ${txt}`, { side: j, anim: id });
      this.statusEv(j);
      return true;
    }

    applyFx(i, j, r, dealt, selfOnly) {
      const d = this.act(i), v = this.sides[i].v, t = this.act(j), tv = this.sides[j].v;
      for (const f of r.fx) {
        const self = E.SELF_FX.has(f.code) || f.code === 'recoil' || f.code === 'drain' || f.code === 'echo' || f.code === 'delay';
        if (selfOnly && !self) continue;
        if (!self && t.hp <= 0) continue;
        let ch = f.chance / 100;
        if (f.code === 'freeze' && tv.soak > 0) ch *= 2;
        if (this.rng() >= ch) continue;
        switch (f.code) {
          case 'burn': case 'freeze': case 'static': case 'root': case 'corrupt': case 'lullaby':
            this.setStatus(j, FX_TO_STATUS[f.code], i); break;
          case 'petrify':
            if (!tv.petrify) { tv.petrify = true; this.msg(`${this.labelCap(j)} is petrified!`, { side: j, anim: 'petrify' }); tv.stages.def = clamp(tv.stages.def + 1, -3, 3); this.statusEv(j); }
            break;
          case 'soak': if (!tv.soak) { tv.soak = 3; this.msg(`${this.labelCap(j)} is soaked!`, { side: j, anim: 'soak' }); this.statusEv(j); } break;
          case 'blind': if (passiveOf(t) !== 'Li') this.stage(j, 'acc', -1, true); break;
          case 'chill': this.stage(j, 'spd', -1, true); break;
          case 'weaken': this.stage(j, 'atk', -1, true); break;
          case 'expose': this.stage(j, 'def', -1, true); break;
          case 'wash': {
            let any = tv.shield > 0;
            for (const k of STAGES) if (tv.stages[k] > 0) { tv.stages[k] = 0; any = true; }
            tv.shield = 0;
            if (any) { this.msg(`The tide washes away ${this.label(j)}'s boosts!`); this.statusEv(j); this.hpEv(j); }
            break;
          }
          case 'drain': if (dealt > 0) { this.heal(i, dealt * f.mag / 100, true); this.msg(`${this.labelCap(i)} siphons energy.`); } break;
          case 'recoil': if (dealt > 0) { this.dealRaw(i, Math.ceil(dealt * f.mag / 100)); this.msg(`${this.labelCap(i)} is hurt by the backlash!`); } break;
          case 'echo': if (dealt > 0 && !v.echo) v.echo = { dmg: Math.ceil(dealt * f.mag / 100), name: r.name }; break;
          case 'delay': if (dealt > 0) { v.delayed.push({ turns: 2, dmg: Math.ceil(dealt * f.mag / 100), name: r.name }); this.msg(`Part of the merge is delayed in time...`); } break;
          case 'heal': this.heal(i, v.stats.hp * f.mag / 100); break;
          case 'cleanse': {
            let any = !!v.status;
            v.status = null;
            for (const k of STAGES) if (v.stages[k] < 0) { v.stages[k] = 0; any = true; }
            if (any) this.msg(`${this.labelCap(i)} is cleansed!`, { side: i, anim: 'heal' });
            this.statusEv(i); break;
          }
          case 'shield': {
            const add = Math.ceil(v.stats.hp * f.mag / 100);
            v.shield = Math.min(Math.ceil(v.stats.hp * 0.6), v.shield + add);
            this.msg(`${this.labelCap(i)} raises a shield!`, { side: i, anim: 'shield' });
            this.hpEv(i); this.statusEv(i); break;
          }
          case 'guard': this.stage(i, 'def', 1); break;
          case 'overclock': this.stage(i, 'atk', 1); break;
          case 'haste': this.stage(i, 'spd', 1); break;
          case 'veil': this.stage(i, 'eva', 1); break;
          case 'focus': this.stage(i, 'acc', 1, true); v.crit = Math.min(2, v.crit + 1); this.msg(`${this.labelCap(i)} focuses.`); break;
          case 'regen': if (!v.regen) { v.regen = 5; v.regenMag = f.mag || 6; this.msg(`${this.labelCap(i)} begins regenerating.`); this.statusEv(i); } break;
          case 'mirror': v.mirror = true; this.msg(`${this.labelCap(i)} becomes mirrored.`); break;
          case 'phase': v.phase = 2; this.msg(`${this.labelCap(i)} phases out of sync!`, { side: i, anim: 'phase' }); break;
          case 'swap': { const x = v.stages; v.stages = tv.stages; tv.stages = x; this.msg('Stat changes are swapped!'); this.statusEv(i); this.statusEv(j); break; }
          case 'invert': { for (const k of STAGES) tv.stages[k] = -tv.stages[k]; this.msg(`${this.labelCap(j)}'s stat changes are inverted!`); this.statusEv(j); break; }
          case 'overwrite': { for (const k of STAGES) if (tv.stages[k] > v.stages[k]) v.stages[k] = tv.stages[k]; this.msg(`${this.labelCap(i)} overwrites itself with the foe's boosts!`); this.statusEv(i); break; }
          case 'nullify': {
            for (const k of Object.keys(this.residue)) this.residue[k] = 0;
            this.field = null;
            for (const s of this.sides) for (const k of STAGES) s.v.stages[k] = 0;
            this.msg('The whole field is nullified!', { anim: 'glitch' });
            this.statusEv(0); this.statusEv(1); break;
          }
          case 'rewind': {
            const back = v.hpHist[0];
            if (back > d.hp) { const amt = back - d.hp; this.heal(i, amt, true); this.msg(`${this.labelCap(i)} rewinds to an earlier state!`); }
            break;
          }
          default: break; // pierce/crit/overflow/fork handled elsewhere
        }
      }
    }

    endOfTurn() {
      for (const i of [0, 1]) this.sideEnd(i, true);
      this.fieldEnd();
    }

    // Periodic effects for one side: a turn end in turn-based play, a pulse in real time.
    sideEnd(i, regenFlux) {
      {
        const s = this.sides[i], d = this.act(i), v = s.v;
        if (d.hp <= 0) return;
        v.turnsIn++;
        if (v.phase > 0) v.phase--;
        if (v.echo) {
          const e = v.echo; v.echo = null;
          const j = 1 - i;
          if (this.act(j).hp > 0) { this.msg(`${e.name} echoes!`, { anim: 'echo', side: i }); this.dealDamage(j, e.dmg, false, null); }
        }
        v.delayed = v.delayed.filter(x => {
          x.turns--;
          if (x.turns > 0) return true;
          const j = 1 - i;
          if (this.act(j).hp > 0) { this.msg(`The delayed part of ${x.name} arrives!`, { anim: 'delay', side: i }); this.dealDamage(j, x.dmg, false, null); }
          return false;
        });
        if (v.status) {
          const st = v.status;
          if (st.id === 'burn') { this.dealRaw(i, Math.max(1, Math.floor(v.stats.hp / 16 * v.burnMul))); this.msg(`${this.labelCap(i)} is hurt by its burn.`); }
          if (st.id === 'rooted') {
            const amt = Math.max(1, Math.floor(v.stats.hp / 16));
            this.dealRaw(i, amt); this.heal(1 - i, amt, true);
            this.msg(`Roots drain ${this.label(i)}.`);
          }
          if (st.id === 'corrupt') { v.flux = Math.max(0, v.flux - 3); this.fluxEv(i); }
          if (d.hp > 0) {
            st.turns--;
            if (st.turns <= 0) {
              v.status = null;
              const txt = { burn: 'is no longer burning.', frozen: 'thaws out.', static: 'discharges the static.', rooted: 'tears free of the roots.', corrupt: 'purges the corruption.', dormant: 'wakes up.' }[st.id];
              this.msg(`${this.labelCap(i)} ${txt}`);
            }
            this.statusEv(i);
          }
        }
        if (d.hp <= 0) return;
        if (v.soak > 0) { v.soak--; if (!v.soak) this.statusEv(i); }
        if (v.regen > 0) { v.regen--; this.heal(i, v.stats.hp * v.regenMag / 100, true); if (!v.regen) this.statusEv(i); }
        const pv = passiveOf(d);
        if (pv === 'W') this.heal(i, v.stats.hp / 20, true);
        if (pv === 'Ro') this.heal(i, v.stats.hp / 16, true);
        if (regenFlux) {
          const regen = 2 + Math.round(v.stats.flux * 0.08);
          v.flux = Math.min(v.stats.flux, v.flux + regen);
          this.fluxEv(i);
        }
        v.hpHist.push(d.hp); if (v.hpHist.length > 2) v.hpHist.shift();
      }
    }

    fieldEnd() {
      if (this.field) { this.field.turns--; if (this.field.turns <= 0) { this.msg(`The ${E.MAIN[this.field.el].name} field dissipates.`); this.field = null; } }
      if (this.turn % 3 === 0) for (const k of Object.keys(this.residue)) this.residue[k] = Math.max(0, this.residue[k] - 1);
      this.stateEv();
    }

    // ---- real-time mode ------------------------------------------------
    // Attacks go through a global cooldown (GCD) whose length depends on
    // Clock and the merge's weight. Actives (Hex/Ward/Mend/Field) fire
    // instantly off the GCD and have their own cooldown. Statuses, regen,
    // echoes and delayed hits tick on a 2-second pulse per side.
    startRealtime() {
      this.rt = [{ gcd: 0.6, cds: {}, pulse: PULSE, queued: null, starved: false }, { gcd: 1.4, cds: {}, pulse: PULSE * 1.5, queued: null }];
      this.fieldPulse = PULSE;
    }
    gcdFor(i, r) {
      let g = 2.4 * 100 / (100 + 1.5 * this.speedOf(i));
      if (r) { g *= 1 + r.flux / 80; if (r.prio > 0) g *= 0.75; if (r.prio < 0) g *= 1.25; }
      return clamp(g, 0.8, 3.2);
    }
    run(fn) {
      this.events = [];
      if (this.over || this.needSwitch) return this.events;
      fn();
      this.checkFaints();
      return this.events;
    }
    // Advance the clock; returns the events that happened.
    tick(dt) {
      this.events = [];
      if (this.over || this.needSwitch || !this.rt) return this.events;
      for (const i of [0, 1]) {
        const rt = this.rt[i], v = this.sides[i].v;
        rt.gcd -= dt;
        for (const k in rt.cds) { rt.cds[k] -= dt; if (rt.cds[k] <= 0) delete rt.cds[k]; }
        const before = Math.floor(v.flux);
        v.flux = Math.min(v.stats.flux, v.flux + (2 + v.stats.flux * 0.08) / PULSE * dt);
        if (Math.floor(v.flux) !== before) this.fluxEv(i);
        rt.pulse -= dt;
        if (rt.pulse <= 0) { rt.pulse += PULSE; this.sideEnd(i, false); if (this.checkFaints()) return this.events; }
      }
      this.fieldPulse -= dt;
      if (this.fieldPulse <= 0) { this.fieldPulse += PULSE; this.turn++; this.fieldEnd(); }
      // player: fire the queued attack whenever the GCD is ready
      const p = this.rt[0];
      if (p.gcd <= 0 && p.queued) {
        const r = rec(p.queued);
        if (r.flux <= this.sides[0].v.flux) { p.starved = false; this.doMerge(0, p.queued); p.gcd = this.gcdFor(0, r); if (this.checkFaints()) return this.events; }
        else p.starved = true;
      }
      // enemy
      const e = this.rt[1];
      if (!this.over && e.gcd <= 0) {
        const a = this.chooseEnemy();
        if (a.type === 'merge') {
          const r = rec(a.key);
          this.doMerge(1, a.key);
          if (!isAttack(a.key)) { e.cds[a.key] = cooldownFor(r); e.gcd = 0.9; } else e.gcd = this.gcdFor(1, r);
        } else { this.doDefrag(1); e.gcd = 1.8; }
        this.checkFaints();
      }
      return this.events;
    }
    // Player actions that don't wait for the GCD. Return events, or null if not ready.
    useActive(key) {
      const rt = this.rt[0], r = rec(key);
      if (!r || rt.cds[key] > 0 || r.flux > this.sides[0].v.flux) return null;
      rt.cds[key] = cooldownFor(r);
      return this.run(() => this.doMerge(0, key));
    }
    useUtility(action) {
      const rt = this.rt[0];
      const cdKey = action.type === 'item' ? 'item' : action.type;
      if (rt.cds[cdKey] > 0) return null;
      if ((action.type === 'bind' || action.type === 'run' || action.type === 'switch') && rt.gcd > 0) return null;
      const ev = this.run(() => this.perform(0, action));
      rt.cds[cdKey] = UTIL_CD[cdKey] || 0;
      if (action.type !== 'defrag' && action.type !== 'item') rt.gcd = Math.max(rt.gcd, action.type === 'bind' ? 2 : 1.2);
      return ev;
    }

    // Returns true if something fainted (the turn should stop).
    checkFaints() {
      let any = false;
      const e = this.act(1), p = this.act(0);
      if (e.hp <= 0 && !this.sides[1].fainted) {
        any = true;
        this.sides[1].fainted = true;
        this.msg(`${this.labelCap(1)} is deallocated!`, { side: 1, anim: 'faint' });
        this.ev('faint', { side: 1 });
        this.awardXp(e);
        this.collectMotes(e);
        const next = this.sides[1].team.findIndex(d => d.hp > 0);
        if (next >= 0) {
          this.sides[1].fainted = false;
          this.doSwitch(1, next);
        } else { this.over = true; this.result = 'win'; }
      }
      if (p.hp <= 0 && !this.over) {
        any = true;
        this.msg(`${this.label(0)} is deallocated!`, { side: 0, anim: 'faint' });
        this.ev('faint', { side: 0 });
        this.sides[0].participants.delete(p.uid);
        if (this.sides[0].team.some(d => d.hp > 0)) this.needSwitch = true;
        else { this.over = true; this.result = 'lose'; }
      }
      return any;
    }

    // Participants split the full yield; everyone else still standing gets half (XP share).
    awardXp(enemy) {
      const team = this.sides[0].team;
      const alive = team.filter(d => d.hp > 0);
      if (!alive.length) return;
      const parts = alive.filter(d => this.sides[0].participants.has(d.uid));
      const total = xpYield(enemy, !this.wild);
      for (const d of alive) {
        const joined = parts.includes(d);
        const each = joined ? Math.max(1, Math.floor(total / Math.max(1, parts.length))) : Math.max(1, Math.floor(total * 0.5));
        const res = gainXp(d, each);
        if (joined) this.msg(`${d.nick || rec(d.key).dName} gains ${each} XP.`);
        for (const L of res.levels) this.msg(`${d.nick || rec(d.key).dName} grew to level ${L}!`, { anim: 'levelup' });
        if (res.levels.length && d === this.act(0)) {
          const s = this.sides[0];
          const old = s.v.stats;
          s.v.stats = calcStats(d);
          s.v.flux = Math.min(s.v.stats.flux, s.v.flux + (s.v.stats.flux - old.flux));
          this.hpEv(0); this.fluxEv(0);
        }
        this.ev('xp', { uid: d.uid, amount: each, attune: res.attune, recompile: res.recompile, levels: res.levels });
      }
    }

    collectMotes(enemy) {
      const p = E.parseKey(enemy.key);
      const m = this.rewards.motes;
      const add = (k, n) => { m[k] = (m[k] || 0) + n; };
      const mult = this.wild ? 1 : 2;
      add(p.a, 2 * mult);
      add(p.b, 1 * mult);
      for (const t of p.subs) add(t.s, 1 * mult);
      if (this.rng() < 0.3) { const pool = eligibleSubs(enemy.key); add(pool[Math.floor(this.rng() * pool.length)], 1); }
    }
  }

  const PULSE = 2;
  const UTIL_CD = { defrag: 14, item: 6, switch: 4, bind: 0, run: 0 };
  function isAttack(key) { const r = rec(key); return r.cls === 'Strike' || r.cls === 'Barrage' || r.cls === 'Siphon'; }
  function cooldownFor(r) { return Math.round(5 + r.flux * 0.7); }

  function describeFx(f) {
    const nm = E.EFFECTS[f.code] || f.code;
    if (['pierce', 'crit', 'fork', 'overflow'].includes(f.code)) return nm;
    if (f.code === 'heal' || f.code === 'shield') return `${nm} ${f.mag}%`;
    if (f.code === 'drain' || f.code === 'recoil' || f.code === 'echo' || f.code === 'delay') return `${nm} ${f.mag}%` + (f.chance < 100 ? ` (${f.chance}%)` : '');
    if (f.code === 'regen') return `Regen ${f.mag}%/turn` + (f.chance < 100 ? ` (${f.chance}%)` : '');
    return f.chance >= 100 ? nm : `${nm} ${f.chance}%`;
  }

  return {
    rec, PASSIVES, STATUS, REACT, ATTUNE_LEVELS, RECOMPILE_LEVELS, LEVEL_CAP,
    calcStats, levelWidth, width, xpFor, tierOf, mainsOf, eligibleSubs, composableFor, canCompose, autoMemory,
    isAttack, cooldownFor, UTIL_CD, PULSE,
    createDaemon, recompileOptions, recompile, gainXp, xpYield, effectiveness, captureChance, Battle, describeFx, passiveOf,
  };
});
