// T3-N01 · Enemy AI base, plus the ally and boss controllers.
// One state machine shape everywhere: idle → aggro → approach → telegraph →
// attack → recover, so six attackers read as six actors and not as a blob.
import { angleTo, clamp, dist, normalize } from '../core/math.js';
import { bandOf, inBand } from './weapons.js';
import { tryCast } from './abilities.js';
import { hasStatus } from './status.js';
import { NODE_TYPE } from './network.js';

export const AI_STATE = {
  IDLE: 'idle', AGGRO: 'aggro', APPROACH: 'approach',
  TELEGRAPH: 'telegraph', ATTACK: 'attack', RECOVER: 'recover', FLEE: 'flee',
};

export function createBrain(profile = {}) {
  return {
    state: AI_STATE.IDLE,
    timer: 0,
    aggroRadius: profile.aggroRadius ?? 280,
    leashRadius: profile.leashRadius ?? 900,
    home: null,
    reposition: { x: 0, y: 0, timer: 0 },
    hesitation: profile.hesitation ?? 0.25,
    ...profile,
  };
}

// Separation steering: without it, six rushers stack into one rusher.
function separation(self, others, radius = 46) {
  let sx = 0, sy = 0, n = 0;
  for (const o of others) {
    if (o === self || o.dead || !o.solid) continue;
    const d = dist(self.x, self.y, o.x, o.y);
    if (d > radius || d < 1e-4) continue;
    sx += (self.x - o.x) / d;
    sy += (self.y - o.y) / d;
    n++;
  }
  return n ? normalize(sx, sy) : { x: 0, y: 0 };
}

// Every AI that carries a weapon steers to its weapon's band, exactly like a
// player is asked to (F-N03). Skilled play is holding the band; the AI is
// deliberately a little worse at it than a good player.
function steerToBand(self, target, weapon, sloppiness = 0) {
  const d = dist(self.x, self.y, target.x, target.y);
  const [lo, hi] = bandOf(weapon);
  const want = (lo + hi) / 2 + sloppiness;
  const n = normalize(target.x - self.x, target.y - self.y);
  const err = d - want;
  if (Math.abs(err) < 12) {
    // Strafe when already in band, so fights are not a line of statues.
    return { x: -n.y * 0.5, y: n.x * 0.5 };
  }
  const s = clamp(err / 90, -1, 1);
  return { x: n.x * s, y: n.y * s };
}

export function updateEnemyAI(e, dt, ctx) {
  const b = e.brain;
  b.home ??= { x: e.x, y: e.y };
  if (hasStatus(e, 'stun')) { e.moveIntent = { x: 0, y: 0 }; return; }

  const player = ctx.nearestAttacker(e);
  const dToPlayer = player ? dist(e.x, e.y, player.x, player.y) : Infinity;
  const dToHome = dist(e.x, e.y, b.home.x, b.home.y);

  if (b.state === AI_STATE.IDLE) {
    e.target = null;
    if (player && dToPlayer < b.aggroRadius) {
      b.state = AI_STATE.AGGRO;
      b.timer = b.hesitation;      // a beat before committing — readable, not twitchy
    }
    e.moveIntent = { x: 0, y: 0 };
    if (dToHome > 24) {
      const n = normalize(b.home.x - e.x, b.home.y - e.y);
      e.moveIntent = { x: n.x * 0.4, y: n.y * 0.4 };
    }
    return;
  }

  // Leashing: chase forever and level design stops meaning anything.
  if (dToHome > b.leashRadius) {
    b.state = AI_STATE.IDLE;
    e.target = null;
    ctx.combat.heal(e, e.maxHp);
    return;
  }

  if (!player || player.dead) { b.state = AI_STATE.IDLE; return; }
  e.target = player;

  switch (b.state) {
    case AI_STATE.AGGRO:
      b.timer -= dt;
      e.moveIntent = { x: 0, y: 0 };
      if (b.timer <= 0) b.state = AI_STATE.APPROACH;
      break;

    case AI_STATE.APPROACH: {
      const steer = steerToBand(e, player, e.weapon, b.sloppiness ?? 10);
      const sep = separation(e, ctx.nearbyOf(e), 44);
      e.moveIntent = {
        x: steer.x + sep.x * 0.7,
        y: steer.y + sep.y * 0.7,
      };
      e.facing = angleTo(e.x, e.y, player.x, player.y);
      // The weapon system handles the actual swing once we are in band.
      break;
    }
    default:
      b.state = AI_STATE.APPROACH;
  }
}

// ── Ally attackers (the other 4-6 people in the room) ─────────────────────
// They fight the level with you and, in the throne room, they clear nodes,
// punish windows, argue about the chair, and sometimes shoot each other.
export function updateAllyAI(a, dt, ctx) {
  const b = a.brain;
  if (hasStatus(a, 'stun')) { a.moveIntent = { x: 0, y: 0 }; return; }

  b.retargetTimer = (b.retargetTimer ?? 0) - dt;
  b.decisionTimer = (b.decisionTimer ?? 0) - dt;

  const bossFight = ctx.throneFightActive();

  if (bossFight) {
    const boss = ctx.boss;

    // Wounded attackers break off onto clean floor. Stepping off the network is
    // how you leave the boss's sight (T2-N14), so retreating is a real move and
    // not just running away — the room thins out instead of feeding him kills.
    if (a.hp < a.maxHp * 0.3) b.fleeing = 3.5;
    if (b.fleeing > 0) {
      b.fleeing -= dt;
      a.target = null;
      const away = normalize(a.x - boss.entity.x, a.y - boss.entity.y);
      const node = ctx.network.covers(a.x, a.y, 40);
      const off = node ? normalize(a.x - node.x, a.y - node.y) : away;
      a.moveIntent = { x: away.x * 0.5 + off.x * 0.7, y: away.y * 0.5 + off.y * 0.7 };
      if (hasStatus(a, 'tether')) castByName(a, 'cut_tether', ctx);
      return;
    }
    // Roles emerge from the fight state rather than being assigned — this is
    // the T2-N21 exit gate: clearers and window-punishers, unprompted.
    const armor = boss.currentArmor();
    const windowOpen = boss.rootWindow > 0;
    const wantWindow = b.role === 'punisher' || armor < 0.35;

    if (windowOpen && wantWindow) {
      a.target = boss.entity;
      const steer = steerToBand(a, boss.entity, a.weapon, 0);
      a.moveIntent = steer;
    } else {
      // Clear nodes. Prefer whatever the group has focused (A-N08 mark), then
      // the node type this ally believes matters most.
      let node = ctx.focusMark?.node ?? null;
      if (!node || node.dead) node = pickNodeFor(b.role, ctx);
      if (node) {
        b.nodeTarget = node;
        const d = dist(a.x, a.y, node.x, node.y);
        const n = normalize(node.x - a.x, node.y - a.y);
        a.moveIntent = d > 70 ? { x: n.x, y: n.y } : { x: -n.y * 0.4, y: n.x * 0.4 };
        a.facing = angleTo(a.x, a.y, node.x, node.y);
        if (d < 96) ctx.network.damageNode(node, 5.5 * dt * (a.damageScale ?? 1), a);
      } else {
        a.target = boss.entity;
        a.moveIntent = steerToBand(a, boss.entity, a.weapon, 0);
      }
    }

    // Counterplay: allies use the right tool for the right shape, and waste it
    // on feints sometimes, which is the T2-N24 exit gate working.
    if (b.decisionTimer <= 0) {
      b.decisionTimer = 0.4;
      const incoming = ctx.incomingTelegraphFor(a);
      if (incoming?.tag === 'idle-pulse' || incoming?.tag === 'collapse') {
        // Nothing outruns the root pulse. Ward it or eat it.
        castByName(a, 'spore_filter', ctx);
      } else if (hasStatus(a, 'tether')) {
        castByName(a, 'cut_tether', ctx);
      } else if (incoming && (incoming.tag === 'bloom' || incoming.tag === 'line')) {
        // Walk out of the shape. Reading the telegraph is the counter; standing
        // in it and healing through is not one.
        const n = normalize(a.x - incoming.x, a.y - incoming.y);
        a.moveIntent = { x: n.x, y: n.y };
        b.decisionTimer = 0.15;
      } else if (b.nodeTarget && !b.nodeTarget.dead && dist(a.x, a.y, b.nodeTarget.x, b.nodeTarget.y) < 150) {
        castByName(a, 'cauterize', ctx);
      }
    }

    // T2-N26 · attacker-vs-attacker. An ally the boss has marked draws
    // suspicion; an ally who has been spared draws more.
    if (ctx.friendlyFire && b.decisionTimer <= 0.05 && ctx.rng.chance(0.02)) {
      const suspect = ctx.boss.marked ?? ctx.boss.spared;
      if (suspect && suspect !== a && !suspect.dead && b.trust < 0.3) {
        a.target = suspect;
      }
    }
    return;
  }

  // Run-up behavior: stay near the player, fight what is close.
  const anchor = ctx.player;
  if (b.retargetTimer <= 0) {
    b.retargetTimer = 0.5;
    a.target = ctx.nearestHostile(a, 420) ?? null;
  }
  if (a.target && !a.target.dead) {
    const steer = steerToBand(a, a.target, a.weapon, 0);
    const sep = separation(a, ctx.nearbyOf(a), 48);
    a.moveIntent = { x: steer.x + sep.x * 0.6, y: steer.y + sep.y * 0.6 };
    a.facing = angleTo(a.x, a.y, a.target.x, a.target.y);
  } else if (anchor) {
    const d = dist(a.x, a.y, anchor.x, anchor.y);
    const n = normalize(anchor.x - a.x, anchor.y - a.y);
    a.moveIntent = d > 130 ? { x: n.x, y: n.y } : { x: 0, y: 0 };
  }
}

function pickNodeFor(role, ctx) {
  const living = ctx.network.living.filter((n) => !n.isRoot);
  if (!living.length) return null;
  const want = role === 'starver' ? NODE_TYPE.SPORE
    : role === 'disarmer' ? NODE_TYPE.LASH
    : NODE_TYPE.PULSE;
  const preferred = living.filter((n) => n.type === want);
  const pool = preferred.length ? preferred : living;
  // Nearest of the preferred type — proximity still beats dogma.
  return pool.reduce((a, b) => (b.hp < a.hp ? b : a));
}

function castByName(actor, id, ctx) {
  const i = actor.abilities?.findIndex((s) => s.id === id);
  if (i === undefined || i < 0) return false;
  return tryCast(actor, i, ctx.abilityCtx);
}

// ── Boss AI (used when an ally takes the chair instead of the player) ─────
// It plays the intended line: cycle all three shapes, grow between attacks,
// feint occasionally, and never spam one button.
export function updateBossAI(boss, dt, ctx) {
  const b = boss.ai ??= { timer: 0, lastAbility: null, feintPlanned: false, rotation: ['line', 'tether', 'bloom'], rotIdx: 0 };
  b.timer -= dt;

  if (boss.casting) {
    // Decide whether this was ever going to be real.
    if (b.feintPlanned && boss.casting.timer < boss.casting.timer * 0.4 + 0.15) {
      boss.feint();
      b.feintPlanned = false;
    }
    return;
  }

  if (b.timer > 0) return;
  b.timer = 0.35;

  const attackers = ctx.world.attackers().filter((a) => !a.dead);
  if (!attackers.length) return;

  // Panic: the comeback is deliberate, never automatic.
  if (boss.network.count <= 4 && !boss.bloomCollapseUsed && attackers.length > 1) {
    if (ctx.rng.chance(0.35)) { boss.bloomCollapse(); return; }
  }

  // Spend on growth when the network is thin — an all-attacks boss runs a
  // shrinking network and loses (T2-N18).
  const thin = boss.network.count < boss.network.peakNodes * 0.55;
  if (thin && boss.cooldowns.grow <= 0 && boss.biomass > 30) {
    const type = boss.network.typeCount(NODE_TYPE.SPORE) < 3 ? NODE_TYPE.SPORE
      : boss.network.typeCount(NODE_TYPE.LASH) < 2 ? NODE_TYPE.LASH : NODE_TYPE.PULSE;
    if (boss.grow(type)) return;
  }

  // Do not expose the root when the room is already on top of you — wake a husk.
  const closeIn = attackers.filter((a) => dist(a.x, a.y, boss.entity.x, boss.entity.y) < 190).length;
  if (closeIn >= 2 && boss.cooldowns.husk <= 0 && boss.biomass > 65) {
    if (boss.wakeHusk()) return;
  }

  // Cycle the shapes rather than spamming: a spam boss visibly underperforms.
  for (let i = 0; i < b.rotation.length; i++) {
    const id = b.rotation[(b.rotIdx + i) % b.rotation.length];
    if (boss.cooldowns[id] > 0) continue;
    if (boss.biomass < boss.costOf(id) && boss.overgrowth > 80) continue;
    boss.selectNearest(attackers[0].x, attackers[0].y);
    b.feintPlanned = ctx.rng.chance(0.18);   // bait a cooldown now and then
    if (boss.beginCast(id, { target: ctx.rng.pick(attackers) })) {
      b.rotIdx = (b.rotIdx + i + 1) % b.rotation.length;
      return;
    }
  }

  // Social play costs nothing and works when he is broke (T2-N30).
  if (!boss.marked && ctx.rng.chance(0.02)) boss.mark(ctx.rng.pick(attackers));
  if (!boss.spared && boss.network.count < 8 && ctx.rng.chance(0.03)) {
    boss.spare(ctx.rng.pick(attackers));
  }
}
