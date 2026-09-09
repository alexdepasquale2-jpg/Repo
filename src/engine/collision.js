// T0-N04 · Collision + uniform-grid broad phase.
// Exit gate: 200 colliding entities at stable frame time.
import { clamp, dist } from '../core/math.js';

export class SpatialGrid {
  constructor(cellSize = 96) {
    this.cellSize = cellSize;
    this.cells = new Map();
  }
  _key(cx, cy) { return cx * 73856093 ^ cy * 19349663; }
  clear() { this.cells.clear(); }

  insert(e) {
    const s = this.cellSize;
    const minX = Math.floor((e.x - e.radius) / s);
    const maxX = Math.floor((e.x + e.radius) / s);
    const minY = Math.floor((e.y - e.radius) / s);
    const maxY = Math.floor((e.y + e.radius) / s);
    for (let cy = minY; cy <= maxY; cy++) {
      for (let cx = minX; cx <= maxX; cx++) {
        const k = this._key(cx, cy);
        let bucket = this.cells.get(k);
        if (!bucket) this.cells.set(k, (bucket = []));
        bucket.push(e);
      }
    }
  }

  rebuild(entities) {
    this.clear();
    for (const e of entities) if (!e.dead && e.solid) this.insert(e);
  }

  // Everything whose cell overlaps the query circle. May contain duplicates
  // across cells, so results are de-duped before returning.
  query(x, y, radius, out = []) {
    out.length = 0;
    const s = this.cellSize;
    const minX = Math.floor((x - radius) / s);
    const maxX = Math.floor((x + radius) / s);
    const minY = Math.floor((y - radius) / s);
    const maxY = Math.floor((y + radius) / s);
    const seen = new Set();
    for (let cy = minY; cy <= maxY; cy++) {
      for (let cx = minX; cx <= maxX; cx++) {
        const bucket = this.cells.get(this._key(cx, cy));
        if (!bucket) continue;
        for (const e of bucket) {
          if (seen.has(e.id)) continue;
          seen.add(e.id);
          out.push(e);
        }
      }
    }
    return out;
  }
}

// Circle-vs-circle separation. Heavier entities are pushed less — this is the
// whole of the "mass" model, and it is deliberately not a physics solver.
export function resolveOverlaps(entities, grid, iterations = 2) {
  const near = [];
  for (let iter = 0; iter < iterations; iter++) {
    grid.rebuild(entities);
    for (const a of entities) {
      if (a.dead || !a.solid || a.immovable) continue;
      grid.query(a.x, a.y, a.radius * 2, near);
      for (const b of near) {
        if (b === a || b.dead || !b.solid) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const rsum = a.radius + b.radius;
        let d2 = dx * dx + dy * dy;
        if (d2 >= rsum * rsum) continue;
        let d = Math.sqrt(d2);
        let nx, ny;
        if (d < 1e-5) {
          // Perfectly stacked: shove apart on a stable axis rather than at random,
          // so the sim stays deterministic.
          nx = (a.id % 2) ? 1 : 0;
          ny = (a.id % 2) ? 0 : 1;
          d = 0.001;
        } else {
          nx = dx / d; ny = dy / d;
        }
        const overlap = rsum - d;
        const aMass = a.immovable ? Infinity : a.mass;
        const bMass = b.immovable ? Infinity : b.mass;
        const total = (aMass === Infinity ? 0 : 1 / aMass) + (bMass === Infinity ? 0 : 1 / bMass);
        if (total <= 0) continue;
        const aShare = (aMass === Infinity ? 0 : (1 / aMass) / total);
        const bShare = (bMass === Infinity ? 0 : (1 / bMass) / total);
        a.x -= nx * overlap * aShare;
        a.y -= ny * overlap * aShare;
        if (!b.immovable) {
          b.x += nx * overlap * bShare;
          b.y += ny * overlap * bShare;
        }
      }
    }
  }
}

// Walls are AABBs. Push the circle out along its shallowest axis of penetration.
export function collideWalls(e, walls) {
  for (const w of walls) {
    const nx = clamp(e.x, w.x, w.x + w.w);
    const ny = clamp(e.y, w.y, w.y + w.h);
    const dx = e.x - nx, dy = e.y - ny;
    const d2 = dx * dx + dy * dy;
    if (d2 > e.radius * e.radius) continue;

    if (d2 > 1e-6) {
      const d = Math.sqrt(d2);
      const push = e.radius - d;
      e.x += (dx / d) * push;
      e.y += (dy / d) * push;
      // Kill only the velocity component going into the wall, so sliding works.
      const vn = e.vx * (dx / d) + e.vy * (dy / d);
      if (vn < 0) { e.vx -= vn * (dx / d); e.vy -= vn * (dy / d); }
    } else {
      // Center is inside the box — eject along the nearest face.
      const toLeft = e.x - w.x, toRight = w.x + w.w - e.x;
      const toTop = e.y - w.y, toBottom = w.y + w.h - e.y;
      const m = Math.min(toLeft, toRight, toTop, toBottom);
      if (m === toLeft) { e.x = w.x - e.radius; e.vx = Math.min(e.vx, 0); }
      else if (m === toRight) { e.x = w.x + w.w + e.radius; e.vx = Math.max(e.vx, 0); }
      else if (m === toTop) { e.y = w.y - e.radius; e.vy = Math.min(e.vy, 0); }
      else { e.y = w.y + w.h + e.radius; e.vy = Math.max(e.vy, 0); }
    }
  }
}

// Line of sight against walls, sampled. Used by targeting (T1-N02) and by boss
// vision (T2-N14) — the boss sees through the network, not through stone.
export function hasLineOfSight(ax, ay, bx, by, walls, step = 16) {
  const d = dist(ax, ay, bx, by);
  const steps = Math.max(1, Math.ceil(d / step));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const px = ax + (bx - ax) * t;
    const py = ay + (by - ay) * t;
    for (const w of walls) {
      if (w.seeThrough) continue;
      if (px >= w.x && px <= w.x + w.w && py >= w.y && py <= w.y + w.h) return false;
    }
  }
  return true;
}
