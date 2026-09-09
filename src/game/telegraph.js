// T7-N09 · Telegraph visual language. One grammar, established in level 1, never violated.
//   SHAPE encodes type   — line = swept beam, ring = bloom, thread = tether
//   FILL  encodes timing — the shape fills toward impact; position in the fill IS the countdown
//   INTENSITY encodes severity
// Never colour alone. Colour is redundant reinforcement only, which locks in
// T7-N04 rather than retrofitting it.
import { dist, distToSegment } from '../core/math.js';

export const SHAPE = { LINE: 'line', RING: 'ring', THREAD: 'thread' };

export function createTelegraphs() {
  const list = [];

  function add(t) {
    const tel = {
      shape: t.shape,
      x: t.x, y: t.y,
      x2: t.x2 ?? t.x, y2: t.y2 ?? t.y,
      radius: t.radius ?? 60,
      width: t.width ?? 34,
      duration: t.duration ?? 1.2,
      elapsed: 0,
      severity: t.severity ?? 1,
      source: t.source ?? null,
      onResolve: t.onResolve ?? null,
      // T2-N24 · feints use the same shapes but stall the fill. Reading a feint is
      // possible if you are watching closely — that is the whole skill.
      feint: false,
      cancelled: false,
      resolved: false,
      followTarget: t.followTarget ?? null,
      tag: t.tag ?? '',
    };
    list.push(tel);
    return tel;
  }

  function update(dt, resolve) {
    for (let i = list.length - 1; i >= 0; i--) {
      const t = list[i];
      if (t.cancelled) {
        // Stalled fill fades instead of snapping out, so the feint is readable
        // after the fact too.
        t.fade = (t.fade ?? 0.25) - dt;
        if (t.fade <= 0) list.splice(i, 1);
        continue;
      }
      if (t.followTarget && !t.followTarget.dead) {
        t.x2 = t.followTarget.x; t.y2 = t.followTarget.y;
      }
      t.elapsed += dt;
      if (t.elapsed >= t.duration && !t.resolved) {
        t.resolved = true;
        resolve?.(t);
        t.onResolve?.(t);
        list.splice(i, 1);
      }
    }
  }

  const progress = (t) => Math.min(1, t.elapsed / t.duration);

  function hits(t, entity) {
    if (t.shape === SHAPE.RING) {
      return dist(entity.x, entity.y, t.x, t.y) <= t.radius + entity.radius;
    }
    if (t.shape === SHAPE.LINE) {
      return distToSegment(entity.x, entity.y, t.x, t.y, t.x2, t.y2) <= t.width / 2 + entity.radius;
    }
    return false;   // threads apply on cast, not on resolve
  }

  return {
    list, add, update, progress, hits,
    cancel(t) { t.cancelled = true; t.feint = true; },
    clear() { list.length = 0; },
  };
}
