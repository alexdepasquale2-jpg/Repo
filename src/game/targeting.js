// T1-N02 · Targeting system (tab-target). The spine of the game.
// Exit gate: Tab in a crowd of 8 gives a predictable, non-random order.
//
// Order is by a stable score, never by array order, so the cycle is the same
// every time you press it from the same position.
import { angleDelta, angleTo, dist } from '../core/math.js';
import { hasLineOfSight } from '../engine/collision.js';
import { areHostile } from '../engine/entity.js';

export const MAX_TARGET_RANGE = 620;
// Sticky: once locked, the target has to get 35% further than the range before
// it drops, so a target does not slip away mid-swing.
const STICKY_SLACK = 1.35;

export function candidatesFor(actor, entities, walls, opts = {}) {
  const {
    range = MAX_TARGET_RANGE,
    requireLos = true,
    friendlyFire = false,
    filter = null,
  } = opts;

  const out = [];
  for (const e of entities) {
    if (e === actor || e.dead || !e.targetable) continue;
    if (e.hiddenFrom?.has(actor.id)) continue;
    if (!areHostile(actor, e, { friendlyFire })) continue;
    if (filter && !filter(e)) continue;
    const d = dist(actor.x, actor.y, e.x, e.y);
    if (d > range) continue;
    if (requireLos && !hasLineOfSight(actor.x, actor.y, e.x, e.y, walls)) continue;
    out.push({ e, d });
  }

  // Sort by distance, then by angle off facing, then by id. The id tiebreak is
  // what makes the order deterministic rather than "whatever the array said".
  out.sort((a, b) => {
    if (Math.abs(a.d - b.d) > 4) return a.d - b.d;
    const aa = Math.abs(angleDelta(actor.facing, angleTo(actor.x, actor.y, a.e.x, a.e.y)));
    const ba = Math.abs(angleDelta(actor.facing, angleTo(actor.x, actor.y, b.e.x, b.e.y)));
    if (Math.abs(aa - ba) > 0.12) return aa - ba;
    return a.e.id - b.e.id;
  });
  return out.map((c) => c.e);
}

export function createTargeting(walls) {
  return {
    walls,

    cycle(actor, entities, dir = 1, opts = {}) {
      const list = candidatesFor(actor, entities, this.walls, opts);
      if (!list.length) { actor.target = null; return null; }
      const idx = actor.target ? list.indexOf(actor.target) : -1;
      const next = idx === -1
        ? list[0]
        : list[(idx + dir + list.length) % list.length];
      actor.target = next;
      actor.targetAcquiredAt = 0;   // drives the F-N04 lock-on "click"
      return next;
    },

    // Auto-break: dead, out of sticky range, or line of sight lost for a moment.
    validate(actor, opts = {}) {
      const t = actor.target;
      if (!t) return null;
      const { range = MAX_TARGET_RANGE, requireLos = true, friendlyFire = false } = opts;
      if (t.dead || !t.targetable || !areHostile(actor, t, { friendlyFire })) { actor.target = null; return null; }
      if (t.hiddenFrom?.has(actor.id)) { actor.target = null; return null; }
      if (dist(actor.x, actor.y, t.x, t.y) > range * STICKY_SLACK) { actor.target = null; return null; }
      if (requireLos && !hasLineOfSight(actor.x, actor.y, t.x, t.y, this.walls)) {
        actor.losLostFor = (actor.losLostFor ?? 0) + 1;
        // Half a second of grace, so a pillar passing between you does not drop the lock.
        if (actor.losLostFor > 30) { actor.target = null; actor.losLostFor = 0; return null; }
      } else {
        actor.losLostFor = 0;
      }
      return actor.target;
    },

    // Acquire the nearest valid target if we have none. Used by allies and by
    // auto-retarget spirits (G-N06).
    acquire(actor, entities, opts = {}) {
      if (actor.target) return actor.target;
      const list = candidatesFor(actor, entities, this.walls, opts);
      actor.target = list[0] ?? null;
      if (actor.target) actor.targetAcquiredAt = 0;
      return actor.target;
    },

    // G-N06 · auto-retarget: switch to the lowest-health thing in range. This is
    // the first time the game takes a decision away from the player.
    autoRetarget(actor, entities, opts = {}) {
      const list = candidatesFor(actor, entities, this.walls, opts);
      if (!list.length) return actor.target;
      let best = list[0];
      for (const e of list) if (e.hp < best.hp) best = e;
      if (best !== actor.target) {
        actor.target = best;
        actor.targetAcquiredAt = 0;
        actor.spiritTookTarget = 0.6;   // the flicker the player eventually notices
      }
      return best;
    },
  };
}
