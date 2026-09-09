// The orchestrator. Owns the entity list, the level, the network, the boss, and
// the state machine that runs menu → level → throne → resolution → succession.
import { clamp, dist, normalize } from '../core/math.js';
import { makeRng } from '../core/rng.js';
import { createEvents } from '../core/events.js';
import { INTENT } from '../core/input.js';
import { EntityStore, createEntity, FACTION } from '../engine/entity.js';
import { SpatialGrid, collideWalls, resolveOverlaps } from '../engine/collision.js';
import { createParticles } from '../engine/particles.js';
import { createCombat, makeDamage } from './combat.js';
import { createTargeting } from './targeting.js';
import { createNetwork, NODE_TYPE } from './network.js';
import { createTelegraphs, SHAPE } from './telegraph.js';
import { createBoss, BOSS_ABILITIES, PHASE } from './boss.js';
import { updateAllyAI, updateBossAI, updateEnemyAI, createBrain } from './ai.js';
import { LEVELS, ENEMY_TYPES } from './levels.js';
import {
  createPlayer, integrateMovement, readPlayerIntent, tryStep,
  updatePlayerTimers, grantXp, collectSalvage,
} from './player.js';
import { makeWeapon, updateWeapon, inBand, bandOf, swingUptime } from './weapons.js';
import { makeAbilitySlot, tryCast, updateAbilities } from './abilities.js';
import { applyLoadout, equip, SPIRITS, totalPossession } from './spirits.js';
import { applyStatus, hasStatus, updateStatuses, speedFactor } from './status.js';
import {
  SIT_HOLD, allocate, becomeBoss, canReachThrone, computePot, createAllocation,
  createThrone, downSitter, resolveAllocation, tearDownAttacker, throneOffer,
} from './throne.js';

export const MODE = {
  TITLE: 'title',
  RUNUP: 'runup',
  SAFEROOM: 'saferoom',
  THRONE_STANDOFF: 'standoff',     // the room where somebody has to sit
  TRANSFORMATION: 'transformation',
  FIGHT: 'fight',
  MERCY: 'mercy',
  ALLOCATION: 'allocation',
  RESULT: 'result',
};

const ALLY_NAMES = ['Bram', 'Ossa', 'Vetch', 'Quill', 'Marrow', 'Tarn'];

export function createWorld({ camera, seed = Date.now() }) {
  const events = createEvents();
  const rng = makeRng(seed >>> 0);
  const particles = createParticles();
  const combat = createCombat({ particles, camera, events });
  const telegraphs = createTelegraphs();
  const grid = new SpatialGrid(96);

  const world = {
    events, rng, particles, combat, telegraphs, camera, grid,
    mode: MODE.TITLE,
    entities: new EntityStore(),
    walls: [],
    hazards: [],
    fungusPatches: [],
    drops: [],
    projectiles: [],
    husks: [],
    bounds: { x: 0, y: 0, w: 1000, h: 1000 },

    levelIndex: 0,
    level: null,
    levelData: null,
    exit: null,
    sealedDoor: null,

    player: null,
    allies: [],
    network: null,
    throne: null,
    boss: null,
    bossEntity: null,
    friendlyFire: false,
    focusMark: null,

    successions: 0,
    survivors: [],
    escapeTimer: 0,          // T2-N29 · hold the network at zero
    escapeAchieved: false,
    firstTimeBoss: true,

    transformTimer: 0,
    transformBeats: [],
    standoffTimer: 0,
    allocation: null,
    mercy: null,
    result: null,
    log: [],
    stats: { timeToFirstDeath: null, elapsed: 0, nodeKills: 0, windowHits: 0, successionsRun: 0 },
  };

  const targeting = createTargeting(world.walls);

  // ── logging (the match record players argue over afterwards) ─────────────
  function say(text, tone = 'info') {
    world.log.push({ text, tone, life: 9 });
    if (world.log.length > 9) world.log.shift();
  }
  world.say = say;

  // ── helpers the AI and abilities are handed ─────────────────────────────
  world.attackers = () => world.entities.list.filter(
    (e) => !e.dead && e.faction === FACTION.PLAYER && e.kind === 'attacker' && !e.spectating,
  );
  world.hostiles = () => world.entities.list.filter((e) => !e.dead && e.faction === FACTION.HOSTILE);
  world.throneFightActive = () => world.mode === MODE.FIGHT;

  world.nearestAttacker = (from) => {
    let best = null, bd = Infinity;
    for (const a of world.attackers()) {
      const d = dist(from.x, from.y, a.x, a.y);
      if (d < bd) { bd = d; best = a; }
    }
    return best;
  };
  world.nearestHostile = (from, range = Infinity) => {
    let best = null, bd = range;
    for (const e of world.entities.list) {
      if (e.dead || e === from) continue;
      if (e.faction !== FACTION.HOSTILE && e.faction !== FACTION.THRONE) continue;
      const d = dist(from.x, from.y, e.x, e.y);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  };
  world.nearestAny = (from, range) => {
    let best = null, bd = range;
    for (const e of world.entities.list) {
      if (e.dead || e === from || !e.targetable) continue;
      const d = dist(from.x, from.y, e.x, e.y);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  };
  const nearBuf = [];
  world.nearbyOf = (e) => grid.query(e.x, e.y, 90, nearBuf);

  world.nearestSleepingHusk = (x, y) => {
    let best = null, bd = Infinity;
    for (const h of world.husks) {
      if (h.woken || h.destroyed) continue;
      const d = dist(x, y, h.x, h.y);
      if (d < bd) { bd = d; best = h; }
    }
    return best;
  };

  world.incomingTelegraphFor = (entity) => {
    for (const t of telegraphs.list) {
      if (t.cancelled) continue;
      if (t.tag === 'idle-pulse' || t.tag === 'collapse') return t;
      if (telegraphs.hits(t, entity)) return t;
    }
    return null;
  };

  world.setFocusMark = (target, by) => {
    world.focusMark = { node: null, entity: target, by, life: 8 };
    if (target.kind === 'node') world.focusMark.node = target;
    events.emit('focus-mark', world.focusMark);
  };

  world.scorchGround = (x, y, r, duration) => {
    particles.burst(x, y, 20, { color: '#ee8b3d', speed: 160, life: 0.5 });
    for (const p of world.fungusPatches) {
      if (dist(p.x, p.y, x, y) < r + p.r) p.burned = duration;
    }
  };

  world.spawnProjectile = (opts) => {
    world.projectiles.push({
      x: opts.x, y: opts.y, vx: opts.vx, vy: opts.vy,
      damage: opts.damage, owner: opts.owner, knockback: opts.knockback ?? 0,
      homing: opts.homing ?? null, onHit: opts.onHit ?? null,
      color: opts.color ?? '#d8cfa8', life: 2.2, radius: 4,
    });
  };

  // Melee sweep: everything hostile inside the arc, nearest first.
  world.meleeSweep = (owner, reach, arc) => {
    const found = grid.query(owner.x, owner.y, reach + 30, nearBuf).filter((e) => {
      if (e === owner || e.dead || !e.targetable) return false;
      if (!isHostileTo(owner, e)) return false;
      const d = dist(owner.x, owner.y, e.x, e.y);
      if (d > reach + e.radius) return false;
      const a = Math.atan2(e.y - owner.y, e.x - owner.x);
      let delta = Math.abs(((a - owner.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      return delta <= arc / 2;
    });
    found.sort((a, b) => dist(owner.x, owner.y, a.x, a.y) - dist(owner.x, owner.y, b.x, b.y));
    return found;
  };

  function isHostileTo(a, b) {
    if (a.faction === b.faction) return world.friendlyFire && a.faction === FACTION.PLAYER;
    if (a.faction === FACTION.NEUTRAL || b.faction === FACTION.NEUTRAL) return false;
    return true;
  }

  world.applyDamage = (t, packet) => combat.applyDamage(t, packet);

  const abilityCtx = {
    events, particles, combat, rng,
    get network() { return world.network; },
    scorchGround: world.scorchGround,
    nearestAny: world.nearestAny,
    setFocusMark: world.setFocusMark,
  };
  world.abilityCtx = abilityCtx;

  const aiCtx = {
    world, events, rng, combat, abilityCtx,
    get network() { return world.network; },
    get boss() { return world.boss; },
    get player() { return world.player; },
    get focusMark() { return world.focusMark; },
    get friendlyFire() { return world.friendlyFire; },
    nearestAttacker: world.nearestAttacker,
    nearestHostile: world.nearestHostile,
    nearbyOf: world.nearbyOf,
    throneFightActive: world.throneFightActive,
    incomingTelegraphFor: world.incomingTelegraphFor,
  };

  const weaponCtx = {
    events,
    spawnProjectile: world.spawnProjectile,
    meleeSweep: world.meleeSweep,
    applyDamage: world.applyDamage,
  };

  // ── level loading ────────────────────────────────────────────────────────
  function loadLevel(index) {
    const def = LEVELS[index];
    world.level = def;
    world.levelIndex = index;
    const data = def.build(rng);
    world.levelData = data;

    world.entities.clear();
    world.projectiles.length = 0;
    world.drops.length = 0;
    world.husks.length = 0;
    world.walls.length = 0;
    world.hazards = data.hazards ?? [];
    world.fungusPatches = (data.fungusPatches ?? []).map((p) => ({ ...p }));
    for (const w of data.walls) world.walls.push(w);
    targeting.walls = world.walls;
    world.bounds = def.bounds;
    world.exit = data.exit;
    world.sealedDoor = data.sealedDoor;
    telegraphs.clear();
    particles.clear();
    world.focusMark = null;

    camera.setBounds(def.bounds);

    // Player persists across levels; only position resets.
    if (!world.player) {
      world.player = createPlayer(data.playerStart.x, data.playerStart.y, { name: 'You' });
    } else {
      world.player.x = data.playerStart.x;
      world.player.y = data.playerStart.y;
      world.player.dead = false;
      world.player.spectating = false;
      world.player.solid = true;
      world.player.targetable = true;
      world.player.hp = world.player.maxHp;
      world.player.statuses.length = 0;
    }
    world.entities.add(world.player);
    camera.snapTo(world.player.x, world.player.y);

    // Allies exist from level 1 so the social layer has something to work with
    // by the time it matters (T2-N32: below four players it is a damage race).
    if (!world.allies.length) {
      for (let i = 0; i < 5; i++) world.allies.push(makeAlly(ALLY_NAMES[i], i));
    }
    world.allies.forEach((a, i) => {
      if (a.permanentlyGone) return;
      a.x = data.playerStart.x + Math.cos(i) * 70;
      a.y = data.playerStart.y + Math.sin(i) * 70;
      a.dead = false;
      a.spectating = false;
      a.solid = true;
      a.targetable = true;
      a.hp = a.maxHp;
      a.statuses.length = 0;
      world.entities.add(a);
    });

    for (const s of data.spawns) spawnEnemy(s);
    for (const h of data.husks) addHusk(h);

    if (def.isThroneRoom) {
      world.throne = createThrone(data.throne.x, data.throne.y);
      world.entities.add(world.throne);
      world.network = createNetwork({
        bounds: def.bounds, walls: world.walls, rng, particles, events,
      });
      world.mode = MODE.THRONE_STANDOFF;
      world.standoffTimer = 26;   // hesitating costs you the choice (T2-N15)
      say(throneOffer(world).line, 'grave');
    } else {
      world.mode = MODE.RUNUP;
      say(`${def.name} — ${def.subtitle}`, 'grave');
    }
    events.emit('level-loaded', { level: def });
  }
  world.loadLevel = loadLevel;

  function makeAlly(name, i) {
    const a = createPlayer(0, 0, { name, isLocal: false });
    a.kind = 'attacker';
    a.isPlayerControlled = false;
    a.brain = createBrain({
      role: ['starver', 'disarmer', 'softener', 'punisher', 'punisher'][i % 5],
      trust: 0.4 + rng.next() * 0.5,
    });
    a.trust = a.brain.trust;
    a.weapon = makeWeapon(['reach_glaive', 'cleaver', 'bound_repeater', 'scavenged_blade', 'rot_lance'][i % 5]);
    a.abilities = [makeAbilitySlot('cauterize'), makeAbilitySlot('spore_filter'), makeAbilitySlot('cut_tether')];
    a.color = ['#7fa7c9', '#c9a77f', '#a7c97f', '#c97fa7', '#9f9fc9'][i % 5];
    equip(a.loadout, ['keen_edge', 'steady_hand', 'threat_sense', 'auto_retarget', 'reactive_block'][i % 5]);
    applyLoadout(a, a.loadout);
    return a;
  }

  function spawnEnemy(s) {
    const def = ENEMY_TYPES[s.type];
    const e = createEntity({
      kind: 'enemy',
      name: def.name,
      x: s.x, y: s.y,
      radius: def.radius,
      faction: FACTION.HOSTILE,
      hp: def.hp, maxHp: def.hp,
      mass: def.mass ?? 1,
      maxSpeed: def.speed,
    });
    e.weapon = makeWeapon(def.weapon);
    e.brain = createBrain({ aggroRadius: def.aggroRadius ?? 300, sloppiness: rng.range(-14, 22) });
    e.color = def.color;
    e.xpValue = def.xp;
    e.salvageValue = def.salvage;
    e.disruptor = def.disruptor ?? false;
    e.abilities = [];
    e.moveIntent = { x: 0, y: 0 };
    world.entities.add(e);
    return e;
  }

  // T6-N06 · previous sitters as remains. Set dressing on approach, evidence in
  // hindsight, and the anchor points the network grows from.
  function addHusk(h) {
    const husk = {
      x: h.x, y: h.y,
      weapon: h.weapon, gear: h.gear ?? [],
      story: h.story ?? '',
      hp: 60, maxHp: 60,
      woken: false, destroyed: false, looted: false,
      wakeProgress: 0,
      isAnchor: h.isAnchor ?? false,
      entity: null,
    };
    world.husks.push(husk);
    return husk;
  }
  world.addHusk = addHusk;

  // T2-N16 · slow and telegraphed, so it can be contested.
  world.wakeHusk = (husk) => {
    husk.waking = 2.2;
    say('Something in the wall stirs.', 'grave');
    events.emit('husk-waking', { husk });
  };

  function finishWakingHusk(husk) {
    husk.woken = true;
    husk.waking = 0;
    const e = createEntity({
      kind: 'husk',
      name: 'Woken Husk',
      x: husk.x, y: husk.y,
      radius: 16,
      faction: FACTION.THRONE,
      hp: 190, maxHp: 190,
      mass: 2.2,
      maxSpeed: 96,     // slow, high-HP minion using the loadout it died with
    });
    e.weapon = makeWeapon(husk.weapon ?? 'scavenged_blade');
    e.brain = createBrain({ aggroRadius: 900, leashRadius: 4000 });
    e.color = '#8a7f6a';
    e.huskRef = husk;
    e.moveIntent = { x: 0, y: 0 };
    e.abilities = [];
    husk.entity = e;
    world.entities.add(e);
  }

  // T2-N17 · destroying a husk drops the gear it died with. Already-woken ones
  // yield more, so denying the boss and claiming loot pull in the same direction.
  world.breakHusk = (husk, breaker) => {
    if (husk.destroyed) return;
    husk.destroyed = true;
    const bonus = husk.woken ? 2 : 1;
    if (husk.weapon) world.drops.push({ x: husk.x, y: husk.y, kind: 'weapon', weapon: husk.weapon, amount: 0 });
    for (const g of husk.gear) world.drops.push({ x: husk.x + rng.range(-20, 20), y: husk.y + rng.range(-20, 20), kind: 'spirit', spirit: g, amount: 0 });
    world.drops.push({ x: husk.x, y: husk.y, kind: 'salvage', amount: 25 * bonus });
    particles.burst(husk.x, husk.y, 26, { color: '#c9b98a', speed: 150, life: 0.6 });
    if (husk.entity && !husk.entity.dead) combat.kill(husk.entity, breaker);
    events.emit('husk-broken', { husk, breaker });
  };

  // ── the standoff: someone has to sit ────────────────────────────────────
  function updateStandoff(dt) {
    world.standoffTimer -= dt;
    const p = world.player;
    const nearThrone = canReachThrone(p, world.throne);

    if (nearThrone && !p.dead) {
      if (worldInput.isHeld(INTENT.INTERACT)) {
        world.throne.sitProgress += dt;
        camera.targetZoom = 1 + world.throne.sitProgress * 0.06;
        if (world.throne.sitProgress >= SIT_HOLD) beginTransformation(p);
      } else {
        world.throne.sitProgress = Math.max(0, world.throne.sitProgress - dt * 2);
        camera.targetZoom = 1;
      }
    } else {
      world.throne.sitProgress = Math.max(0, world.throne.sitProgress - dt * 2);
    }

    // Allies drift toward the chair, arguing. Whoever is least trusted holds back.
    const living = world.allies.filter((a) => !a.dead && !a.permanentlyGone && !a.spectating);
    for (const a of living) {
      const d = dist(a.x, a.y, world.throne.x, world.throne.y);
      const eager = a.brain.trust < 0.55 && !a.pledged;
      const want = eager ? 60 : 210;
      const n = normalize(world.throne.x - a.x, world.throne.y - a.y);
      a.moveIntent = d > want ? { x: n.x * 0.6, y: n.y * 0.6 } : { x: -n.y * 0.25, y: n.x * 0.25 };
    }

    if (world.standoffTimer <= 0 && world.mode === MODE.THRONE_STANDOFF) {
      // Hesitating costs you the choice — an ally takes the chair.
      const candidates = living.filter((a) => !a.pledged);
      const sitter = candidates.length ? candidates.reduce((a, b) => (b.brain.trust < a.brain.trust ? b : a)) : living[0];
      if (sitter) {
        say(`${sitter.name} stops waiting for you.`, 'grave');
        beginTransformation(sitter);
      }
    }
  }

  // ── T2-N03 · the transformation, which also carries onboarding (T3-N08) ──
  function beginTransformation(sitter) {
    world.mode = MODE.TRANSFORMATION;
    world.transformTimer = 4.2;
    world.throne.occupant = sitter;
    world.throne.sitProgress = SIT_HOLD;

    const snapshot = tearDownAttacker(sitter);
    becomeBoss(sitter, world.throne, snapshot);
    world.bossEntity = sitter;

    const root = world.network.seed(world.throne.x, world.throne.y);
    // The node layout is literally built on the dead (T6-N06).
    for (const h of world.husks) {
      if (h.isAnchor && !h.destroyed) world.network.addNode(h.x, h.y, rng.pick(Object.values(NODE_TYPE)), root);
    }
    world.network.peakNodes = world.network.count;

    world.boss = createBoss({
      entity: sitter,
      network: world.network,
      throne: world.throne,
      world,
      isPlayerControlled: sitter === world.player,
      firstTime: world.firstTimeBoss && sitter === world.player,
    });
    world.boss.cruelty = 0;

    // Onboarding happens INSIDE the transformation, not before it.
    world.transformBeats = sitter === world.player ? [
      { at: 3.4, text: 'You can see through it.', hint: 'The network is your eyes as well as your reach.' },
      { at: 2.4, text: 'Fire from here.', hint: `${worldInput.keyFor(INTENT.TARGET_NEXT)} moves your gaze between nodes.` },
      { at: 1.4, text: 'This is what you spend.', hint: 'Living nodes make biomass. Attacks eat it.' },
      { at: 0.5, text: 'Do not go quiet.', hint: 'If you stop attacking, the room is punished — and so is your armour.' },
    ] : [
      { at: 3.0, text: `${sitter.name} sits down.`, hint: 'They looked like they had decided a while ago.' },
      { at: 1.2, text: 'The door does not open.', hint: '' },
    ];

    world.friendlyFire = true;         // T2-N26 · the throne is a prize
    camera.targetZoom = sitter === world.player ? 0.72 : 1.05;
    camera.addShake(0.8);
    events.emit('transformation', { sitter });
  }

  function updateTransformation(dt) {
    world.transformTimer -= dt;
    for (const b of world.transformBeats) {
      if (!b.shown && world.transformTimer <= b.at) {
        b.shown = true;
        say(b.text, 'boss');
        if (b.hint) say(b.hint, 'hint');
      }
    }
    particles.burst(world.throne.x, world.throne.y, 4, {
      color: '#7ea34f', speed: 220, life: 0.9, spread: Math.PI * 2,
    });
    if (world.transformTimer <= 0) {
      world.mode = MODE.FIGHT;
      if (world.boss.isPlayerControlled) world.firstTimeBoss = false;
      world.stats.successionsRun++;
      say('It is not going to let anyone leave.', 'grave');
      events.emit('fight-start', { boss: world.boss });
    }
  }

  // ── the fight ────────────────────────────────────────────────────────────
  function updateFight(dt) {
    const boss = world.boss;
    world.network.update(dt);
    boss.update(dt);
    if (!boss.isPlayerControlled) updateBossAI(boss, dt, aiCtx);

    // T2-N07 · anti-turtle. Fungal ground denies the floor, and clean ground is
    // where the boss cannot see you — so kiting forever is not free either.
    for (const a of world.attackers()) {
      const node = world.network.covers(a.x, a.y, 0);
      if (node) {
        applyStatus(a, 'taint', { duration: 12, magnitude: 1, source: boss.entity });
        applyStatus(a, 'slow', { duration: 0.4, magnitude: 0.22, source: boss.entity });
        a.taintExposure = (a.taintExposure ?? 0) + dt;
      }
    }

    // T2-N29 · the alternate exit. Clear the network to zero and HOLD it there.
    // It is achievable and most groups will not manage it.
    const nonRoot = world.network.living.filter((n) => !n.isRoot).length;
    if (nonRoot === 0) {
      world.escapeTimer += dt;
      if (world.escapeTimer > 14 && !world.escapeAchieved) {
        world.escapeAchieved = true;
        endFight('escaped');
      }
    } else {
      world.escapeTimer = Math.max(0, world.escapeTimer - dt * 1.6);
    }

    // Resolution (T2-N08).
    if (boss.entity.hp <= 0 && !boss.entity.downed) {
      downSitter(boss.entity);
      endFight('boss-down');
      return;
    }
    if (!world.attackers().length) endFight('boss-wins');
  }

  function endFight(reason) {
    const boss = world.boss;
    if (reason === 'escaped') {
      world.mode = MODE.RESULT;
      world.result = {
        kind: 'escaped',
        title: 'You starved it.',
        body: 'Nobody had to sit. Every run before this one was avoidable.',
      };
      return;
    }
    if (reason === 'boss-wins') {
      world.mode = MODE.RESULT;
      // Attackers keep only what they salvaged mid-fight. No allocation happens.
      world.result = {
        kind: 'boss-wins',
        title: 'The room goes quiet.',
        body: 'No allocation. Everyone keeps only what they broke a husk for.',
        bossWon: true,
      };
      events.emit('fight-end', { reason });
      return;
    }

    // Boss down: the attackers choose. This is the only path to being paid.
    world.mode = MODE.MERCY;
    const survivors = world.attackers();
    world.mercy = {
      sitter: boss.entity,
      survivors,
      timer: 20,
      // The boss must think about mercy WHILE fighting. Cruelty is earned by
      // what he actually did, not by a hidden roll.
      cruelty: boss.cruelty ?? 0,
      playerDecides: world.player && !world.player.dead && !world.player.spectating,
      decided: null,
    };
    for (const n of [...world.network.living]) if (!n.isRoot) world.network.killNode(n, null);
    telegraphs.clear();
    say('The fungus lets go. Whoever that is, they are dying on the floor.', 'grave');
    events.emit('fight-end', { reason });
  }

  // ── mercy (D4) ───────────────────────────────────────────────────────────
  function updateMercy(dt) {
    const m = world.mercy;
    m.timer -= dt;
    m.sitter.bleedOut -= dt;

    if (m.playerDecides) {
      if (worldInput.wasPressed(INTENT.CONFIRM)) return decideMercy(true);
      if (worldInput.wasPressed(INTENT.CANCEL)) return decideMercy(false);
    } else if (m.timer <= 6 && !m.decided) {
      // Allies weigh money against grudge. Mercy is not moral here — it is the
      // only way anyone gets paid, and they know it.
      const spare = m.cruelty < 55;
      return decideMercy(spare, true);
    }
    if (m.timer <= 0 || m.sitter.bleedOut <= 0) decideMercy(false, !m.playerDecides);
  }

  function decideMercy(spare, byAllies = false) {
    const m = world.mercy;
    m.decided = spare ? 'spare' : 'kill';
    const sitter = m.sitter;

    if (!spare) {
      // Killing severs the throne's hold with nobody to release it. Nobody gets
      // paid. It is pure spite, and it is available.
      combat.kill(sitter, null);
      sitter.permanentlyGone = true;
      world.mode = MODE.RESULT;
      world.result = {
        kind: 'killed',
        title: byAllies ? 'They finish it without asking you.' : 'You finish it.',
        body: 'The hold is severed with nobody left to release it. Nobody gets paid.',
      };
      events.emit('mercy', { spared: false, sitter });
      return;
    }

    // Spared: they live, they allocate, and they have just been at the mercy of
    // people who spent ten minutes trying to kill them.
    sitter.downed = false;
    sitter.faction = FACTION.PLAYER;
    sitter.kind = 'attacker';
    sitter.immovable = false;
    sitter.armor = 0;
    const snap = sitter.wasAttacker;
    sitter.weapon = snap.weapon;
    sitter.offhand = snap.offhand;
    sitter.abilities = snap.abilities;
    sitter.loadout = snap.loadout;
    sitter.maxHp = snap.maxHp;
    sitter.hp = Math.round(snap.maxHp * 0.25);
    sitter.radius = snap.radius;
    sitter.mass = snap.mass;
    applyLoadout(sitter, sitter.loadout);

    const claimants = [...world.attackers(), sitter];
    world.allocation = createAllocation({
      pot: computePot(sitter, world.attackers()),
      claimants,
      allocator: sitter,              // a spared sitter can allocate themselves a share
      timeLimit: 30,
    });
    world.mode = MODE.ALLOCATION;
    say(`${sitter.name} lives. ${sitter.name} decides who gets paid.`, 'grave');
    events.emit('mercy', { spared: true, sitter });
  }

  // ── T2-N34 · allocation ──────────────────────────────────────────────────
  function updateAllocation(dt) {
    const alloc = world.allocation;
    alloc.timer -= dt;
    const playerAllocates = alloc.allocator === world.player;

    if (playerAllocates) {
      if (worldInput.wasPressed(INTENT.TARGET_NEXT)) {
        alloc.cursor = (alloc.cursor + 1) % alloc.claimants.length;
      }
      if (worldInput.wasPressed(INTENT.ABILITY_1)) {
        allocate(alloc, alloc.claimants[alloc.cursor].id, Math.round(alloc.pot * 0.1));
      }
      if (worldInput.wasPressed(INTENT.ABILITY_2)) {
        allocate(alloc, alloc.claimants[alloc.cursor].id, Math.round(alloc.pot * 0.25));
      }
      if (worldInput.wasPressed(INTENT.ABILITY_3)) {
        allocate(alloc, alloc.claimants[alloc.cursor].id, -Math.round(alloc.pot * 0.1));
      }
      if (worldInput.wasPressed(INTENT.CONFIRM) || alloc.timer <= 0) finishAllocation();
    } else if (alloc.timer <= 24) {
      // An AI allocator pays themselves first, then whoever did not betray them.
      const self = alloc.allocator;
      allocate(alloc, self.id, Math.round(alloc.pot * 0.45));
      const others = alloc.claimants.filter((c) => c !== self);
      const share = Math.floor(alloc.remaining / Math.max(1, others.length));
      for (const o of others) allocate(alloc, o.id, share);
      finishAllocation();
    }
  }

  function finishAllocation() {
    const alloc = world.allocation;
    const outcome = resolveAllocation(alloc);
    world.lastPayout = outcome;

    // G-N16 · the shard comes off a defeated boss. Carrying it means arriving at
    // the next throne already partly claimed.
    if (world.player && !world.player.dead) {
      world.drops.push({ x: world.player.x + 40, y: world.player.y, kind: 'spirit', spirit: 'throne_shard', amount: 0 });
    }

    world.successions++;
    // T2-N28 · killing the boss empties the chair; it does not clear the room.
    const remaining = world.attackers().filter((a) => !a.permanentlyGone);
    if (remaining.length <= 1 || world.successions >= 3) {
      world.mode = MODE.RESULT;
      world.result = {
        kind: 'succession-end',
        title: remaining.length <= 1 ? 'One left, and a chair.' : 'The room lets you stop.',
        body: `${world.successions} succession${world.successions === 1 ? '' : 's'}. ${remaining.length} still standing.`,
        payout: outcome,
      };
      return;
    }

    // Reset for the next sitting: same power, fewer hands.
    world.boss = null;
    world.bossEntity = null;
    world.throne.occupant = null;
    world.throne.sitProgress = 0;
    world.network.reset();
    world.escapeTimer = 0;
    world.friendlyFire = false;
    telegraphs.clear();
    world.mode = MODE.THRONE_STANDOFF;
    // Each successive fight is shorter and nastier.
    world.standoffTimer = Math.max(10, 26 - world.successions * 7);
    camera.targetZoom = 1;
    say('The chair is empty again. Everyone has now seen what it is worth.', 'grave');
  }

  // ── run-up progression ───────────────────────────────────────────────────
  function updateRunup(dt) {
    const remaining = world.hostiles().length;
    if (remaining === 0 && world.exit && !world.exitOpen) {
      world.exitOpen = true;
      say('The way on is clear.', 'info');
    }
    if (world.exitOpen && world.player && dist(world.player.x, world.player.y, world.exit.x, world.exit.y) < 60) {
      world.exitOpen = false;
      // W-N10 · a room with no combat in it, where the group talks before going in.
      world.mode = MODE.SAFEROOM;
      world.player.bankedSalvage += world.player.salvage;
      world.player.salvage = 0;
      say('Bank it. Nothing follows you in here.', 'info');
    }
  }

  // ── per-entity tick ──────────────────────────────────────────────────────
  function updateEntities(dt) {
    const list = world.entities.list;

    for (const e of list) {
      if (e.dead) { if (e.corpseTimer !== Infinity) e.corpseTimer -= dt; continue; }
      updateStatuses(e, dt, (target, amount, opts) =>
        combat.applyDamage(target, makeDamage(amount, { ...opts, silent: true })));
      updateAbilities(e, dt);
      updatePlayerTimers(e, dt);

      if (e.kind === 'enemy') updateEnemyAI(e, dt, aiCtx);
      else if (e.kind === 'husk') updateEnemyAI(e, dt, aiCtx);
      else if (e.kind === 'attacker' && !e.isPlayerControlled) updateAllyAI(e, dt, aiCtx);

      if (!e.immovable) integrateMovement(e, dt);

      // Targeting upkeep for anything that can hold a lock.
      if (e.weapon && e.kind !== 'boss') {
        targeting.validate(e, { friendlyFire: world.friendlyFire });
        if (e.autoRetarget && !e.isPlayerControlled) {
          targeting.autoRetarget(e, list, { friendlyFire: world.friendlyFire });
        }
        if (!e.target && !e.isPlayerControlled) {
          targeting.acquire(e, list, { friendlyFire: world.friendlyFire });
        }
        updateWeapon(e, e.weapon, dt, weaponCtx);
      }

      // Hazards (W-N06): terrain that changes routing, not a damage tick you ignore.
      for (const h of world.hazards) {
        if (e.x > h.x && e.x < h.x + h.w && e.y > h.y && e.y < h.y + h.h) {
          applyStatus(e, 'slow', { duration: 0.3, magnitude: 0.45 });
          if (e.faction === FACTION.PLAYER) applyStatus(e, 'rot', { duration: 1.2, magnitude: 2 });
        }
      }

      collideWalls(e, world.walls);
      e.x = clamp(e.x, world.bounds.x + e.radius, world.bounds.x + world.bounds.w - e.radius);
      e.y = clamp(e.y, world.bounds.y + e.radius, world.bounds.y + world.bounds.h - e.radius);
    }

    resolveOverlaps(list, grid, 1);
    world.entities.sweep();
  }

  function updateProjectiles(dt) {
    for (let i = world.projectiles.length - 1; i >= 0; i--) {
      const p = world.projectiles[i];
      p.life -= dt;
      if (p.life <= 0) { world.projectiles.splice(i, 1); continue; }
      // G-N07 · predictive aim is the spirit steering the shot, not the player.
      if (p.homing && !p.homing.dead) {
        const n = normalize(p.homing.x - p.x, p.homing.y - p.y);
        const speed = Math.hypot(p.vx, p.vy);
        // Steer, then renormalize once — computing each axis separately would
        // feed the already-steered vx back into vy.
        const steered = normalize(p.vx + n.x * speed * 3.2 * dt, p.vy + n.y * speed * 3.2 * dt);
        p.vx = steered.x * speed;
        p.vy = steered.y * speed;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      let consumed = false;
      for (const w of world.walls) {
        if (p.x > w.x && p.x < w.x + w.w && p.y > w.y && p.y < w.y + w.h) { consumed = true; break; }
      }
      if (!consumed) {
        for (const e of grid.query(p.x, p.y, 24, nearBuf)) {
          if (e.dead || e === p.owner || !e.targetable) continue;
          if (!isHostileTo(p.owner, e)) continue;
          if (dist(p.x, p.y, e.x, e.y) > e.radius + p.radius) continue;
          combat.applyDamage(e, makeDamage(p.damage, { source: p.owner, knockback: p.knockback }));
          p.onHit?.(e);
          consumed = true;
          break;
        }
      }
      if (consumed) {
        particles.burst(p.x, p.y, 5, { color: p.color, speed: 80, life: 0.25 });
        world.projectiles.splice(i, 1);
      }
    }
  }

  function updateHusks(dt) {
    for (const h of world.husks) {
      if (h.waking > 0) {
        h.waking -= dt;
        particles.burst(h.x, h.y, 2, { color: '#8fbf5a', speed: 40, life: 0.5 });
        if (h.waking <= 0) finishWakingHusk(h);
      }
    }
  }

  // ── player input, in whichever role they currently hold ───────────────────
  let worldInput = null;
  world.bindInput = (input) => { worldInput = input; };

  function handleAttackerInput(dt) {
    const p = world.player;
    if (!p || p.dead || p.spectating) return;
    readPlayerIntent(p, worldInput);

    if (worldInput.wasPressed(INTENT.TARGET_NEXT)) {
      targeting.cycle(p, world.entities.list, 1, { friendlyFire: world.friendlyFire });
    }
    if (worldInput.wasPressed(INTENT.TARGET_PREV)) {
      targeting.cycle(p, world.entities.list, -1, { friendlyFire: world.friendlyFire });
    }
    if (worldInput.wasPressed(INTENT.STEP)) tryStep(p);
    for (let i = 0; i < 4; i++) {
      if (worldInput.wasPressed([INTENT.ABILITY_1, INTENT.ABILITY_2, INTENT.ABILITY_3, INTENT.ABILITY_4][i])) {
        tryCast(p, i, abilityCtx);
      }
    }
    // G-N06 · your lock moves on its own once the spirit is loud enough.
    if (p.autoRetarget && p.spiritTookTarget <= 0) {
      targeting.autoRetarget(p, world.entities.list, { friendlyFire: world.friendlyFire });
    }
    targeting.validate(p, { friendlyFire: world.friendlyFire });
    updateWeapon(p, p.weapon, dt, weaponCtx);

    // One interact key, one action per press: break the husk you are stood on,
    // otherwise take the thing at your feet. Holding it must never loop.
    if (worldInput.wasPressed(INTENT.INTERACT) && world.mode !== MODE.THRONE_STANDOFF) {
      const h = world.husks.find((x) => !x.destroyed && dist(p.x, p.y, x.x, x.y) < 56);
      if (h) world.breakHusk(h, p);
      else pickUpDrops(p);
    }
    // Attacking a node you are stood next to, if that is what your lock means.
    if (world.network && world.mode === MODE.FIGHT) {
      const node = world.network.nearestNode(p.x, p.y);
      if (node && dist(p.x, p.y, node.x, node.y) < 90 && p.weapon.phase === 'active') {
        world.network.damageNode(node, 6, p);
      }
    }
    collectSalvage(p, world.drops, events);
  }

  // Exactly one item per call, nearest first, so a press is never ambiguous.
  function pickUpDrops(p) {
    const near = world.drops
      .map((d, i) => ({ d, i, dist: dist(p.x, p.y, d.x, d.y) }))
      .filter((c) => c.d.kind !== 'salvage' && c.dist <= 44)
      .sort((a, b) => a.dist - b.dist);
    if (!near.length) return;
    for (const { d, i } of [near[0]]) {
      if (d.kind === 'weapon') {
        // P-N09 · two weapons. Every pickup is a replacement decision.
        const old = p.weapon;
        p.weapon = makeWeapon(d.weapon);
        world.drops.splice(i, 1);
        // Drop the old one clear of your own pickup radius, or the swap loops.
        world.drops.push({ x: p.x, y: p.y + 58, kind: 'weapon', weapon: old.id, amount: 0 });
        say(`Took ${p.weapon.def.name}. Left ${old.def.name}.`, 'info');
      } else if (d.kind === 'spirit') {
        const res = equip(p.loadout, d.spirit);
        if (res.ok) {
          applyLoadout(p, p.loadout);
          world.drops.splice(i, 1);
          say(`${SPIRITS[d.spirit].name} settles into your gear.`, 'info');
        } else {
          say(`No room: ${res.reason}.`, 'warn');
        }
      }
    }
  }

  // T2-N13 · boss camera + control scheme. The boss targets SPACE; attackers
  // target THINGS. Same tab key, same cadence, so the role feels native.
  function handleBossInput(dt) {
    const boss = world.boss;
    if (!boss?.isPlayerControlled || boss.entity.dead) return;

    if (worldInput.wasPressed(INTENT.TARGET_NEXT)) boss.cycleNode(1);
    if (worldInput.wasPressed(INTENT.TARGET_PREV)) boss.cycleNode(-1);

    const target = world.nearestAttacker(boss.selectedNode ?? boss.entity);
    if (worldInput.wasPressed(INTENT.ABILITY_1)) boss.beginCast('line');
    if (worldInput.wasPressed(INTENT.ABILITY_2)) boss.beginCast('bloom', { target });
    if (worldInput.wasPressed(INTENT.ABILITY_3)) boss.beginCast('tether', { target });
    if (worldInput.wasPressed(INTENT.ABILITY_4)) boss.grow(boss.growType);
    if (worldInput.wasPressed(INTENT.INTERACT)) boss.wakeHusk();
    if (worldInput.wasPressed(INTENT.STEP)) {
      if (boss.casting) boss.feint();
      else boss.bloomCollapse();
    }
    if (worldInput.wasPressed(INTENT.PING)) {
      // Social play: mark someone, or if they are already marked, spare them.
      if (target) {
        if (boss.marked === target) { boss.spare(target); say(`You stop attacking ${target.name}. Let them explain that.`, 'boss'); }
        else { boss.mark(target); say(`${target.name} is wearing your halo now.`, 'boss'); }
      }
    }
    if (worldInput.wasPressed(INTENT.CANCEL)) {
      // Cycle what growth spends on, so network shape is strategic.
      const types = Object.values(NODE_TYPE);
      boss.growType = types[(types.indexOf(boss.growType) + 1) % types.length];
    }
    camera.follow(boss.selectedNode?.x ?? boss.entity.x, boss.selectedNode?.y ?? boss.entity.y, dt);
  }

  // ── cruelty bookkeeping, which decides whether he gets spared ────────────
  events.on('boss-feint', () => { if (world.boss) world.boss.cruelty += 3; });
  events.on('boss-mark', () => { if (world.boss) world.boss.cruelty += 9; });
  events.on('boss-spare', () => { if (world.boss) world.boss.cruelty -= 6; });
  events.on('idle-pulse', () => { if (world.boss) world.boss.cruelty += 5; });
  events.on('death', ({ entity, killer }) => {
    if (entity.faction === FACTION.PLAYER && killer && killer === world.bossEntity) {
      if (world.boss) world.boss.cruelty += 14;
    }
    onDeath(entity, killer);
  });
  events.on('node-killed', () => { world.stats.nodeKills++; });
  events.on('damage', ({ target, packet }) => {
    if (target === world.bossEntity && world.boss?.rootWindow > 0) world.stats.windowHits++;
  });

  // T2-N31 · death changes your role, it does not remove you.
  function onDeath(entity, killer) {
    if (world.stats.timeToFirstDeath === null) world.stats.timeToFirstDeath = world.stats.elapsed;

    if (entity.faction === FACTION.PLAYER && entity.kind === 'attacker') {
      // Dead attackers become husks on the floor, feeding reactivation and salvage.
      const husk = addHusk({
        x: entity.x, y: entity.y,
        weapon: entity.weapon?.id ?? null,
        gear: [...(entity.loadout?.equipped ?? [])],
        story: `${entity.name}. This run.`,
      });
      husk.wasPlayerCorpse = entity;
      entity.spectating = true;
      entity.persistent = true;
      if (entity === world.player) {
        say('You are on the floor. You can still see the network the way it does.', 'grave');
      } else {
        say(`${entity.name} is down.`, 'warn');
      }
    }

    if (entity.kind === 'enemy') {
      const p = world.player;
      if (p) grantXp(p, entity.xpValue ?? 10, events);
      world.drops.push({ x: entity.x, y: entity.y, kind: 'salvage', amount: entity.salvageValue ?? 5 });
    }
  }

  // ── main tick ────────────────────────────────────────────────────────────
  world.update = (dt) => {
    // Hitstop freezes the simulation, not the renderer. F-N02.
    if (combat.isFrozen()) { combat.update(dt); particles.update(dt); return; }

    world.stats.elapsed += dt;
    combat.update(dt);
    particles.update(dt);
    grid.rebuild(world.entities.list);

    for (const l of world.log) l.life -= dt;
    while (world.log.length && world.log[0].life <= 0) world.log.shift();
    if (world.focusMark) {
      world.focusMark.life -= dt;
      if (world.focusMark.life <= 0) world.focusMark = null;
    }

    const playerIsBoss = world.boss?.isPlayerControlled;

    switch (world.mode) {
      case MODE.RUNUP:
        handleAttackerInput(dt);
        updateEntities(dt);
        updateProjectiles(dt);
        updateHusks(dt);
        updateRunup(dt);
        break;

      case MODE.SAFEROOM:
        handleAttackerInput(dt);
        updateEntities(dt);
        break;

      case MODE.THRONE_STANDOFF:
        handleAttackerInput(dt);
        updateStandoff(dt);
        updateEntities(dt);
        updateProjectiles(dt);
        updateHusks(dt);
        break;

      case MODE.TRANSFORMATION:
        updateTransformation(dt);
        updateEntities(dt);
        break;

      case MODE.FIGHT:
        if (playerIsBoss) handleBossInput(dt);
        else handleAttackerInput(dt);
        updateEntities(dt);
        updateProjectiles(dt);
        updateHusks(dt);
        telegraphs.update(dt, resolveTelegraph);
        updateFight(dt);
        break;

      case MODE.MERCY:
        updateEntities(dt);
        updateMercy(dt);
        break;

      case MODE.ALLOCATION:
        updateAllocation(dt);
        break;

      default:
        break;
    }

    // Camera: the boss watches the room; everyone else watches themselves.
    if (!playerIsBoss || world.mode !== MODE.FIGHT) {
      const p = world.player;
      if (p) {
        const t = p.target && !p.target.dead ? p.target : null;
        camera.follow(p.x, p.y, dt, { lookAtX: t?.x ?? null, lookAtY: t?.y ?? null });
      }
    }
    camera.targetZoom = playerIsBoss && world.mode === MODE.FIGHT ? 0.62
      : world.mode === MODE.TRANSFORMATION ? camera.targetZoom
      : 1;

    worldInput?.endTick();
  };

  function resolveTelegraph(t) {
    if (t.tag === 'idle-pulse' || t.tag === 'collapse') return;   // handled in onResolve
    const boss = world.boss;
    const power = boss?.powerScale() ?? 1;
    if (t.shape === SHAPE.LINE) {
      for (const a of world.attackers()) {
        if (telegraphs.hits(t, a)) {
          combat.applyDamage(a, makeDamage(24 * power, { source: t.source, knockback: 140, type: 'spore' }));
        }
      }
      particles.burst(t.x2, t.y2, 18, { color: '#9fd06a', speed: 200, life: 0.5 });
    } else if (t.shape === SHAPE.RING) {
      for (const a of world.attackers()) {
        if (telegraphs.hits(t, a)) {
          combat.applyDamage(a, makeDamage(36 * power, { source: t.source, knockback: 190, type: 'spore' }));
        }
      }
      particles.burst(t.x, t.y, 30, { color: '#7ea34f', speed: 240, life: 0.6 });
      camera.addShake(0.4);
    }
  }

  world.start = () => {
    world.levelIndex = 0;
    world.player = null;
    world.allies = [];
    world.successions = 0;
    world.stats.elapsed = 0;
    loadLevel(0);
  };

  world.advanceLevel = () => {
    if (world.levelIndex + 1 < LEVELS.length) {
      const next = LEVELS[world.levelIndex + 1];
      // A-N02 · one new ability per level, introduced BEFORE the level that needs it.
      const already = world.player?.abilities.some((s) => s.id === next.unlocks);
      if (next.unlocks && world.player && !already) {
        world.player.abilities.push(makeAbilitySlot(next.unlocks));
        events.emit('ability-unlocked', { id: next.unlocks });
      }
      loadLevel(world.levelIndex + 1);
    }
  };

  world.targeting = targeting;
  return world;
}
