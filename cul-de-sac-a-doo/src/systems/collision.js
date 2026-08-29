// Broad-phase + narrow-phase collision. Owner: Agent A.
// Frozen API per docs/CONTRACT.md:
//   export function circleHit(a, b) -> bool
//   export class SpatialGrid { insert(e); queryNear(x, y, r) }

/**
 * Narrow phase. Both args are entity-shaped: { x, y, radius }.
 * Squared-distance compare — no sqrt.
 */
export function circleHit(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const r = (a.radius || 0) + (b.radius || 0);
  return dx * dx + dy * dy <= r * r;
}

/** Circle-vs-point, handy for click/tap targeting. */
export function pointInCircle(px, py, c) {
  const dx = px - c.x;
  const dy = py - c.y;
  return dx * dx + dy * dy <= c.radius * c.radius;
}

/**
 * Uniform spatial hash grid. Rebuilt every fixed tick (clear -> insert all).
 * Buckets are stored in a Map keyed by a packed cell string; each bucket is a
 * plain array reused across frames to keep GC pressure near zero.
 *
 * Designed to hold 300+ entities at 60Hz. Cell size should be roughly
 * 2x the largest common entity diameter so queryNear touches few cells.
 */
export class SpatialGrid {
  constructor(cellSize = 64) {
    this.cellSize = cellSize;
    this.cells = new Map();     // key -> array of entities
    this._live = [];            // keys touched this frame, for cheap clear()
    this._results = [];         // reused output buffer for queryNear
  }

  _key(cx, cy) {
    // Pack signed cell coords into one number key (fast Map lookup, no strings).
    return ((cx + 32768) << 16) | (cy + 32768);
  }

  clear() {
    for (let i = 0; i < this._live.length; i++) {
      const arr = this.cells.get(this._live[i]);
      if (arr) arr.length = 0;
    }
    this._live.length = 0;
  }

  /** Insert an entity ({x, y, radius}). Entity is stored by reference. */
  insert(e) {
    const cs = this.cellSize;
    const cx = Math.floor(e.x / cs);
    const cy = Math.floor(e.y / cs);
    const k = this._key(cx, cy);
    let arr = this.cells.get(k);
    if (arr === undefined) {
      arr = [];
      this.cells.set(k, arr);
    }
    if (arr.length === 0) this._live.push(k);
    arr.push(e);
  }

  /**
   * All entities whose cell overlaps the circle (x, y, r).
   * Broad phase only — caller still narrow-phases with circleHit.
   * Returns a REUSED array: consume it before the next queryNear call.
   */
  queryNear(x, y, r) {
    const out = this._results;
    out.length = 0;
    const cs = this.cellSize;
    const minX = Math.floor((x - r) / cs);
    const maxX = Math.floor((x + r) / cs);
    const minY = Math.floor((y - r) / cs);
    const maxY = Math.floor((y + r) / cs);
    for (let cx = minX; cx <= maxX; cx++) {
      for (let cy = minY; cy <= maxY; cy++) {
        const arr = this.cells.get(this._key(cx, cy));
        if (arr === undefined) continue;
        for (let i = 0; i < arr.length; i++) out.push(arr[i]);
      }
    }
    return out;
  }

  /** Like queryNear but copies into a caller-owned array (safe to hold). */
  queryNearCopy(x, y, r) {
    return this.queryNear(x, y, r).slice();
  }
}

// SELF-TEST: In devtools console:
//   import('./src/systems/collision.js').then(m => {
//     console.log(m.circleHit({x:0,y:0,radius:5},{x:8,y:0,radius:5}));  // true
//     console.log(m.circleHit({x:0,y:0,radius:5},{x:11,y:0,radius:5})); // false
//     const g = new m.SpatialGrid(64);
//     for (let i=0;i<300;i++) g.insert({x:i*3, y:(i*7)%500, radius:6, i});
//     console.log(g.queryNear(150,150,40).length);  // small subset, not 300
//     g.clear(); console.log(g.queryNear(150,150,40).length); // 0
//   });
// In game: window.game.grid holds the live grid each tick.
