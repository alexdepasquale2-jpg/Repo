// TIER 2 · The throne boss. The body is consumed (D2) — the sitter becomes the
// entity at the throne, and the throne is the root.
//
// The closed loop this file exists to serve:
//   the boss MUST attack (idle timer) → attacking OPENS him (root window)
//   → not attacking kills everyone including the room. No safe state for anyone.
import { TAU, clamp, dist, lerp } from '../core/math.js';
import { makeDamage } from './combat.js';
import { applyStatus, hasStatus } from './status.js';
import { NODE_TYPE, NODE_DEFS } from './network.js';
import { SHAPE } from './telegraph.js';

export const PHASE = { FULL: 1, CONTESTED: 2, COLLAPSING: 3 };

// T2-N18 · three competing sinks. Every attack is growth you did not buy.
export const BOSS_ABILITIES = {
  line: {
    name: 'Lash', cost: 14, cooldown: 3.4, windup: 1.15,
    desc: 'Fires along a branch. Punishes corridors.',
  },
  bloom: {
    name: 'Bloom', cost: 22, cooldown: 6.0, windup: 1.7,
    desc: 'Delayed burst at a node. Punishes clustering.',
  },
  tether: {
    name: 'Tether', cost: 12, cooldown: 8.0, windup: 0.9,
    desc: 'Drains one attacker until distance or a node breaks it.',
  },
};

const IDLE_LIMIT = 22;
const IDLE_LIMIT_FIRST_TIME = 44;   // T3-N08 · double length for a first-time boss only
const ROOT_WINDOW = 2.4;
const FEINT_WINDOW = 0.55;          // the feint is cheap, not free

export function createBoss({ entity, network, throne, world, isPlayerControlled, firstTime }) {
  const boss = {
    entity,                 // the seated body, at the throne, immovable
    network, throne, world,
    isPlayerControlled,
    firstTime,

    biomass: 40,
    overgrowth: 0,          // T2-N19 · 0..100
    idleTimer: firstTime ? IDLE_LIMIT_FIRST_TIME : IDLE_LIMIT,
    idleLimit: firstTime ? IDLE_LIMIT_FIRST_TIME : IDLE_LIMIT,
    idleWarned: false,

    rootWindow: 0,          // T2-N20 · seconds of exposure remaining
    selectedIndex: 0,
    selectedNode: null,
    selectCooldown: 0,

    cooldowns: { line: 0, bloom: 0, tether: 0, grow: 0, husk: 0 },
    growType: NODE_TYPE.SPORE,

    casting: null,          // {id, timer, node, target, telegraph}
    phase: PHASE.FULL,
    bloomCollapseUsed: false,

    // T2-N30 · social tools. The boss cannot move or speak; his play runs
    // through the network.
    marked: null,           // a halo only the OTHERS can see
    spared: null,           // visibly withholding attacks reads as collusion
    whisperCooldown: 0,
    lastWhisper: null,

    stats: { attacks: 0, feints: 0, nodesGrown: 0, husksWoken: 0, biomassSpent: 0, damageDealt: 0 },
  };

  // ── selection (T2-N13) ────────────────────────────────────────────────────
  // Node selection reuses the attacker's tab cadence and stickiness deliberately,
  // so switching roles does not feel like switching games (T0-N07).
  function selectableNodes() {
    return network.living
      .filter((n) => n.burning <= 0)
      .sort((a, b) => a.id - b.id);
  }

  boss.cycleNode = (dir = 1) => {
    const list = selectableNodes();
    if (!list.length) { boss.selectedNode = null; return null; }
    // T2-N19 · at high overgrowth, selection turns sluggish. You are being
    // outvoted about where to look.
    if (boss.selectCooldown > 0) return boss.selectedNode;
    boss.selectCooldown = lerp(0, 0.45, boss.overgrowth / 100);

    const idx = boss.selectedNode ? list.indexOf(boss.selectedNode) : -1;
    boss.selectedNode = idx === -1 ? list[0] : list[(idx + dir + list.length) % list.length];
    return boss.selectedNode;
  };

  boss.selectNearest = (x, y) => {
    const n = network.nearestNode(x, y, { excludeBurning: true });
    if (n) boss.selectedNode = n;
    return n;
  };

  // ── economy (T2-N18 / T2-N19) ─────────────────────────────────────────────
  function costOf(id) {
    const base = BOSS_ABILITIES[id]?.cost ?? 0;
    // Overgrowth makes everything cheaper and stronger. That is the bargain.
    return Math.round(base * lerp(1, 0.55, boss.overgrowth / 100));
  }
  boss.costOf = costOf;

  function powerScale() { return lerp(1, 1.7, boss.overgrowth / 100); }
  boss.powerScale = powerScale;

  function spend(amount) {
    boss.stats.biomassSpent += amount;
    boss.biomass -= amount;
    if (boss.biomass < 0) {
      // Spending into debt does not fail — it lets the fungus take more of you.
      boss.overgrowth = clamp(boss.overgrowth + -boss.biomass * 0.9, 0, 100);
      boss.biomass = 0;
      world.events.emit('overgrowth', { boss, value: boss.overgrowth });
    }
  }

  boss.canAfford = (id) => boss.biomass >= costOf(id) || boss.overgrowth < 100;

  // ── the root window (T2-N20) ──────────────────────────────────────────────
  function openRoot(duration) {
    boss.rootWindow = Math.max(boss.rootWindow, duration);
    world.events.emit('root-window', { boss, duration });
  }

  // T2-N21 · Outside the window the root is simply shut — standing and DPSing
  // the throne accomplishes nothing, whatever the network looks like. Inside the
  // window, armor is the network: full network means the opening is worth almost
  // nothing, stripped bare means it is lethal.
  // Killing the boss therefore requires punishing attacks AND having cleared
  // first, which is what splits the room into node-clearers and window-punishers.
  const SHUT_ARMOR = 0.99;
  boss.currentArmor = () => (boss.rootWindow > 0 ? network.rootArmor() : SHUT_ARMOR);

  // ── casting ───────────────────────────────────────────────────────────────
  function attackersInRoom() {
    return world.attackers().filter((a) => !a.dead);
  }

  boss.beginCast = (id, opts = {}) => {
    if (boss.casting || boss.cooldowns[id] > 0) return false;
    const node = boss.selectedNode ?? network.nearestNode(entity.x, entity.y, { excludeBurning: true });
    if (!node) return false;
    const cost = costOf(id);
    if (boss.biomass < cost && boss.overgrowth >= 100) return false;

    const def = BOSS_ABILITIES[id];
    let tel;
    if (id === 'line') {
      // Fires along a branch: from the node, outward through the network.
      const nb = network.neighbours(node);
      const away = nb.length ? nb[Math.floor(world.rng.next() * nb.length)] : null;
      const a = away ? Math.atan2(away.y - node.y, away.x - node.x) : world.rng.range(0, TAU);
      const reach = 460 * powerScale();
      tel = world.telegraphs.add({
        shape: SHAPE.LINE, x: node.x, y: node.y,
        x2: node.x + Math.cos(a) * reach, y2: node.y + Math.sin(a) * reach,
        width: 44, duration: def.windup, severity: 1, source: entity, tag: 'line',
      });
    } else if (id === 'bloom') {
      const victim = opts.target ?? pickClusteredTarget();
      const cx = victim ? victim.x : node.x;
      const cy = victim ? victim.y : node.y;
      tel = world.telegraphs.add({
        shape: SHAPE.RING, x: cx, y: cy, radius: 120 * powerScale(),
        duration: def.windup, severity: 1.4, source: entity, tag: 'bloom',
      });
    } else if (id === 'tether') {
      const victim = opts.target ?? pickTetherTarget();
      if (!victim) return false;
      tel = world.telegraphs.add({
        shape: SHAPE.THREAD, x: node.x, y: node.y, x2: victim.x, y2: victim.y,
        duration: def.windup, severity: 0.8, source: entity,
        followTarget: victim, tag: 'tether',
      });
      tel.victim = victim;
    }

    boss.casting = { id, timer: def.windup, node, telegraph: tel, committed: true };
    // The root exposes briefly on wind-up, before commitment. Feinting is cheap,
    // not free (T2-N24).
    openRoot(FEINT_WINDOW);
    return true;
  };

  // T2-N24 · cancel for a fraction of the biomass. Baits attacker cooldowns.
  boss.feint = () => {
    if (!boss.casting) return false;
    const { id, telegraph } = boss.casting;
    world.telegraphs.cancel(telegraph);
    spend(Math.round(costOf(id) * 0.25));
    boss.cooldowns[id] = BOSS_ABILITIES[id].cooldown * 0.4;
    boss.casting = null;
    boss.stats.feints++;
    // CONSTRAINT: a feint must NOT reset the idle timer, or the boss stalls
    // forever on fakes. Only committed attacks count.
    world.events.emit('boss-feint', { boss, id });
    return true;
  };

  function pickClusteredTarget() {
    const list = attackersInRoom().filter((a) => a !== boss.spared);
    let best = null, bestScore = -1;
    for (const a of list) {
      const near = list.filter((b) => dist(a.x, a.y, b.x, b.y) < 140).length;
      if (near > bestScore) { bestScore = near; best = a; }
    }
    return best;
  }

  function pickTetherTarget() {
    const list = attackersInRoom().filter((a) => a !== boss.spared && !hasStatus(a, 'tether'));
    if (!list.length) return null;
    // The strongest one — so the others hesitate to help.
    return list.reduce((a, b) => (b.hp > a.hp ? b : a));
  }

  function resolveCast() {
    const c = boss.casting;
    if (!c) return;
    const cost = costOf(c.id);
    spend(cost);
    boss.cooldowns[c.id] = BOSS_ABILITIES[c.id].cooldown;
    boss.stats.attacks++;

    // A committed attack resets the idle timer and travels out from the root,
    // which is exactly when the root is open.
    boss.idleTimer = boss.idleLimit;
    boss.idleWarned = false;
    openRoot(ROOT_WINDOW);

    if (c.id === 'tether' && c.telegraph?.victim && !c.telegraph.victim.dead) {
      applyStatus(c.telegraph.victim, 'tether', {
        duration: 8, magnitude: 3.5 * powerScale(), source: entity,
      });
    }
    boss.casting = null;
    world.events.emit('boss-attack', { boss, id: c.id });
  }

  // ── the idle pulse (T2-N06, v4 revision) ──────────────────────────────────
  // The boss takes NO damage from it, so to keep the loop intact the pulse fires
  // FROM THE ROOT and exposes the window like any other ability. He can stall,
  // and stalling is genuinely strong — but every pulse is a window.
  function idlePulse() {
    const pulseNodes = network.typeCount(NODE_TYPE.PULSE);
    const damage = 26 + pulseNodes * 4;
    world.telegraphs.add({
      shape: SHAPE.RING, x: throne.x, y: throne.y,
      radius: 9999, duration: 1.5, severity: 2, source: entity, tag: 'idle-pulse',
      onResolve: () => {
        for (const a of attackersInRoom()) {
          world.combat.applyDamage(a, makeDamage(damage, { source: entity, type: 'spore', knockback: 60 }));
        }
        world.camera.addShake(0.9);
      },
    });
    boss.idleTimer = boss.idleLimit;
    boss.idleWarned = false;
    openRoot(ROOT_WINDOW);   // stalling still thins him
    world.events.emit('idle-pulse', { boss });
  }

  // ── phases (T2-N22), keyed off network state, not boss HP ────────────────
  function updatePhase() {
    const ratio = network.peakNodes > 0 ? network.count / network.peakNodes : 0;
    const before = boss.phase;
    // Because phases key off node count, a boss playing well DELAYS his own
    // phase 3 — skill extends the fight rather than skipping to the ending.
    boss.phase = ratio > 0.6 ? PHASE.FULL : ratio > 0.25 ? PHASE.CONTESTED : PHASE.COLLAPSING;
    if (boss.phase !== before) world.events.emit('phase-change', { boss, phase: boss.phase });
  }

  // ── T2-N23 · comeback: bloom collapse ────────────────────────────────────
  boss.bloomCollapse = () => {
    if (boss.bloomCollapseUsed || network.count > 5) return false;
    boss.bloomCollapseUsed = true;
    // Deliberately long and counterable — a comeback must never invalidate good play.
    world.telegraphs.add({
      shape: SHAPE.RING, x: throne.x, y: throne.y, radius: 9999,
      duration: 4.0, severity: 3, source: entity, tag: 'collapse',
      onResolve: () => {
        for (const a of attackersInRoom()) {
          world.combat.applyDamage(a, makeDamage(95, { source: entity, type: 'spore', knockback: 220 }));
        }
        // Consume everything, reseed small. Wins if it lands, ends it if it does not.
        for (const n of [...network.living]) if (!n.isRoot) network.killNode(n, entity);
        network.seed(throne.x, throne.y);
        boss.biomass = 30;
        world.camera.addShake(1.4);
        world.events.emit('bloom-collapse', { boss });
      },
    });
    openRoot(4.0);   // four seconds of open root is what it costs to try
    return true;
  };

  // ── T2-N14 · boss vision, server-filtered ────────────────────────────────
  // Hidden attackers are removed from what the boss's client is ever told, not
  // drawn-and-hidden. Fog you can read out of memory is not fog.
  function updateVision() {
    const narrow = boss.overgrowth > 55;   // overgrowth narrows sight to network-only
    for (const a of world.attackers()) {
      a.hiddenFrom ??= new Set();
      const onNet = network.covers(a.x, a.y, narrow ? 0 : 70);
      if (onNet) {
        a.hiddenFrom.delete(entity.id);
        a.lastKnown = { x: a.x, y: a.y, age: 0 };
      } else {
        a.hiddenFrom.add(entity.id);
        if (a.lastKnown) a.lastKnown.age += 1 / 60;
      }
    }
  }

  // ── social tools (T2-N30) ────────────────────────────────────────────────
  boss.mark = (attacker) => {
    boss.marked = attacker;   // a halo only the others can see
    world.events.emit('boss-mark', { boss, attacker });
  };
  boss.spare = (attacker) => {
    // Costs no biomass, which matters when he is broke. The group does the work.
    boss.spared = attacker;
    world.events.emit('boss-spare', { boss, attacker });
  };
  boss.whisper = (attacker, line) => {
    if (boss.whisperCooldown > 0) return false;
    boss.whisperCooldown = 12;
    boss.lastWhisper = { to: attacker, line, life: 6 };
    world.events.emit('boss-whisper', { boss, attacker, line });
    return true;
  };

  // ── T2-N16 · husk reactivation ───────────────────────────────────────────
  // Resets the idle timer but costs DOUBLE biomass: the escape valve when he
  // does not want to expose the root, priced so he cannot live on it.
  boss.wakeHusk = () => {
    if (boss.cooldowns.husk > 0) return false;
    const husk = world.nearestSleepingHusk(throne.x, throne.y);
    if (!husk) return false;
    const cost = 30 * 2;
    if (boss.biomass < cost && boss.overgrowth >= 100) return false;
    spend(cost);
    boss.cooldowns.husk = 10;
    boss.idleTimer = boss.idleLimit;    // it satisfies the timer...
    boss.idleWarned = false;
    // ...but staying safe thins his own armor, because he paid nodes for it.
    world.wakeHusk(husk);               // slow and telegraphed, so it can be contested
    boss.stats.husksWoken++;
    return true;
  };

  boss.grow = (type = boss.growType) => {
    if (boss.cooldowns.grow > 0) return false;
    const cost = NODE_DEFS[type].cost;
    if (boss.biomass < cost && boss.overgrowth >= 100) return false;
    const n = network.tryGrow(type, world.attackers());
    if (!n) return false;
    spend(cost);
    boss.cooldowns.grow = 1.6 / NODE_DEFS[type].growth;
    boss.stats.nodesGrown++;
    return true;
  };

  // ── tick ──────────────────────────────────────────────────────────────────
  boss.update = (dt) => {
    if (entity.dead) return;

    boss.biomass = Math.min(220, boss.biomass + network.income() * dt);
    for (const k in boss.cooldowns) boss.cooldowns[k] = Math.max(0, boss.cooldowns[k] - dt);
    if (boss.selectCooldown > 0) boss.selectCooldown -= dt;
    if (boss.whisperCooldown > 0) boss.whisperCooldown -= dt;
    if (boss.lastWhisper) { boss.lastWhisper.life -= dt; if (boss.lastWhisper.life <= 0) boss.lastWhisper = null; }
    if (boss.rootWindow > 0) boss.rootWindow -= dt;

    // Selected node can die under you; fall back rather than freezing input.
    if (boss.selectedNode?.dead) boss.selectedNode = null;
    if (!boss.selectedNode) boss.selectedNode = selectableNodes()[0] ?? null;

    if (boss.casting) {
      boss.casting.timer -= dt;
      if (boss.casting.timer <= 0) resolveCast();
    }

    boss.idleTimer -= dt;
    if (boss.idleTimer <= 6 && !boss.idleWarned) {
      boss.idleWarned = true;
      world.events.emit('idle-warning', { boss });   // explicit and unmissable
    }
    if (boss.idleTimer <= 0) idlePulse();

    // Tether drain resolves here so it is one authority, not per-attacker code.
    for (const a of world.attackers()) {
      for (const s of a.statuses) {
        if (s.type !== 'tether') continue;
        if (dist(a.x, a.y, entity.x, entity.y) > 520) { s.duration = 0; continue; }
        world.combat.applyDamage(a, makeDamage(s.magnitude * dt, {
          source: entity, type: 'spore', silent: true,
        }));
        boss.entityHealShare = (boss.entityHealShare ?? 0) + s.magnitude * dt * 0.4;
      }
    }
    if (boss.entityHealShare > 1) {
      world.combat.heal(entity, boss.entityHealShare);
      boss.entityHealShare = 0;
    }

    // T2-N19 at maximum: the boss stops choosing targets and the network attacks
    // on its own. Losing as boss should feel like being used up, not out-damaged.
    if (boss.overgrowth >= 92) {
      boss.autoFireTimer = (boss.autoFireTimer ?? 0) - dt;
      if (boss.autoFireTimer <= 0 && !boss.casting) {
        boss.autoFireTimer = 2.2;
        boss.selectedNode = world.rng.pick(selectableNodes()) ?? boss.selectedNode;
        boss.beginCast(world.rng.pick(['line', 'bloom', 'tether']));
      }
    }

    updateVision();
    updatePhase();

    entity.armor = boss.currentArmor();
  };

  return boss;
}
