// TIER A · Ability framework. Abilities are data: cost, cooldown, targeting mode,
// effect hook, telegraph shape. Attacker abilities and boss abilities share this
// system — one framework, two users (A-N01).
import { dist, normalize } from '../core/math.js';
import { makeDamage } from './combat.js';
import { applyStatus, clearStatuses } from './status.js';

export const TARGETING = {
  SELF: 'self',
  TARGET: 'target',
  GROUND_UNDER_TARGET: 'groundUnderTarget',
  NEAREST_NODE: 'nearestNode',
};

export const ABILITIES = {
  // A-N05 · taught in level 2 against fungal terrain; becomes the node-denial
  // tool in the throne fight. The run-up teaches the throne fight's tools
  // without revealing what they are for.
  cauterize: {
    name: 'Cauterize', key: 1, cooldown: 9, targeting: TARGETING.NEAREST_NODE,
    telegraph: { shape: 'ring', radius: 90, fill: 0.35 },
    desc: 'Burn fungal ground. It cannot be fired from while it burns.',
    run(ctx, caster) {
      const nodes = ctx.network?.nodesNear(caster.x, caster.y, 150) ?? [];
      if (!nodes.length) {
        ctx.scorchGround(caster.x, caster.y, 90, 6);
        return true;
      }
      for (const n of nodes) {
        ctx.network.damageNode(n, 26, caster);
        ctx.network.burnNode(n, 6);       // blinds and disarms — one action, two payoffs
      }
      ctx.particles.burst(caster.x, caster.y, 26, { color: '#ee8b3d', speed: 210, life: 0.5 });
      return true;
    },
  },

  // A-N06 · usable offensively and socially. Drag someone off the network — or onto it.
  hook: {
    name: 'Hook', key: 2, cooldown: 11, targeting: TARGETING.TARGET,
    telegraph: { shape: 'thread', fill: 0.2 },
    desc: 'Yank a target toward you. Works on allies. That is the point.',
    run(ctx, caster) {
      const t = caster.target ?? ctx.nearestAny(caster, 340);
      if (!t || t.dead || t.immovable) return false;
      const n = normalize(caster.x - t.x, caster.y - t.y);
      const pull = Math.min(220, dist(caster.x, caster.y, t.x, t.y) - caster.radius - t.radius);
      t.knockVx += n.x * pull * 5;
      t.knockVy += n.y * pull * 5;
      applyStatus(t, 'slow', { duration: 0.8, magnitude: 0.4, source: caster });
      ctx.particles.burst(t.x, t.y, 14, { color: '#c96a9c', speed: 150, life: 0.4 });
      return true;
    },
  },

  // A-N07 · the attacker-side mirror of overgrowth. Same bargain, smaller stakes.
  // Built before the boss's version so the echo lands.
  let_them_loose: {
    name: 'Let Them Loose', key: 3, cooldown: 26, targeting: TARGETING.SELF,
    telegraph: null,
    desc: 'Every spirit runs at once. Then they are slow to answer.',
    run(ctx, caster) {
      applyStatus(caster, 'hastened', { duration: 6, magnitude: 1, source: caster });
      caster.looseUntil = 6;
      caster.loosePenalty = 5;   // the debt comes due after
      ctx.particles.burst(caster.x, caster.y, 30, { color: '#f7e08a', speed: 180, life: 0.7, glow: true });
      return true;
    },
  },

  // A-N09 · the counter to spore taint — which means it also hides evidence (T2-N27).
  purge: {
    name: 'Purge', key: 4, cooldown: 14, targeting: TARGETING.SELF,
    telegraph: null,
    desc: 'Clear what is on you. Including what proves where you have been.',
    run(ctx, caster) {
      const n = clearStatuses(caster, { onlyHarmful: true });
      applyStatus(caster, 'immune', { duration: 1.6, magnitude: 1, source: caster });
      ctx.particles.burst(caster.x, caster.y, 20, { color: '#f4f1e8', speed: 130, life: 0.5 });
      ctx.events.emit('purged', { caster, cleared: n });
      return true;
    },
  },

  // T2-N11 · the answer to the idle-timer AOE. Long cooldown: you cannot cover
  // everything, so you choose what to eat.
  spore_filter: {
    name: 'Spore Filter', key: 3, cooldown: 30, targeting: TARGETING.SELF,
    telegraph: null,
    desc: 'A short ward. One pulse, survived. Not two.',
    run(ctx, caster) {
      applyStatus(caster, 'immune', { duration: 2.2, magnitude: 1, source: caster });
      return true;
    },
  },

  // T2-N11 · short-cooldown break for the drain link.
  cut_tether: {
    name: 'Cut Tether', key: 4, cooldown: 6, targeting: TARGETING.SELF,
    telegraph: null,
    desc: 'Sever the drain. Short cooldown, single purpose.',
    run(ctx, caster) {
      const had = caster.statuses.some((s) => s.type === 'tether');
      caster.statuses = caster.statuses.filter((s) => s.type !== 'tether');
      if (had) ctx.particles.burst(caster.x, caster.y, 12, { color: '#c96a9c', speed: 200, life: 0.35 });
      return had;
    },
  },

  // A-N08 · pure utility in the run-up, pure social weapon in the throne room.
  mark: {
    name: 'Mark', key: 2, cooldown: 4, targeting: TARGETING.TARGET,
    telegraph: null,
    desc: 'Everyone sees what you picked. Including whether you were right.',
    run(ctx, caster) {
      const t = caster.target;
      if (!t || t.dead) return false;
      ctx.setFocusMark(t, caster);
      return true;
    },
  },
};

export function makeAbilitySlot(id) {
  return { id, def: ABILITIES[id], cooldown: 0, uses: 0 };
}

export function updateAbilities(actor, dt) {
  for (const slot of actor.abilities ?? []) {
    if (slot.cooldown > 0) slot.cooldown = Math.max(0, slot.cooldown - dt);
  }
  // A-N07 debt window.
  if (actor.looseUntil > 0) {
    actor.looseUntil -= dt;
    if (actor.looseUntil <= 0 && actor.loosePenalty > 0) {
      // All cooldowns stall while the spirits go quiet.
      for (const slot of actor.abilities ?? []) slot.cooldown += actor.loosePenalty;
      actor.loosePenalty = 0;
    }
  }
}

export function tryCast(actor, index, ctx) {
  const slot = actor.abilities?.[index];
  if (!slot || slot.cooldown > 0) return false;
  if (actor.actionLocked || actor.dead) return false;
  const ok = slot.def.run(ctx, actor);
  if (ok) {
    slot.cooldown = slot.def.cooldown;
    slot.uses++;
    ctx.events.emit('ability-cast', { actor, ability: slot.def });
  }
  return ok;
}

// A-N11 · "does anyone still have a spore filter?" answerable without asking.
export function readiness(actor, abilityId) {
  const slot = actor.abilities?.find((s) => s.id === abilityId);
  if (!slot) return null;
  return { ready: slot.cooldown <= 0, remaining: slot.cooldown, total: slot.def.cooldown };
}
