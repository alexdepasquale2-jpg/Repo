// Enemy entity + the seven neighbor archetypes + a pooled enemy factory.
// Owner: Agent A. Placeholder art only; distinct flat color per neighborId.

/**
 * ENEMY_TYPES is keyed by the canonical neighborId strings from
 * docs/CONTRACT.md. Every field is a MULTIPLIER or base applied on top of
 * CONFIG.enemy in game.js, so wave scaling stays in one place.
 *
 *   sheila     — Lawn Gnome Swarm: many, small, slow, chip damage
 *   colonel    — Chicken flock: fast, erratic, fragile
 *   marge      — Sprinkler Wraith: medium, steady, arcs sideways
 *   dwayne     — Sprinkler Wraith (heavier variant): slow, tanky
 *   newlyweds  — Newlywed Elite: paired, fast, hits hard
 *   previous   — The Previous Owner: haunting; drifts, phases, rare
 *   frog       — Debt Frog: BOSS. Huge, slow, lunges.
 */
export const ENEMY_TYPES = {
  sheila: {
    id: 'sheila', name: 'Lawn Gnome', shape: 'cone',
    hpMul: 0.75, speedMul: 0.80, dmgMul: 0.8, radius: 8, xp: 1, weight: 40,
  },
  colonel: {
    id: 'colonel', name: 'Chicken', shape: 'triangle',
    hpMul: 0.55, speedMul: 1.55, dmgMul: 0.7, radius: 7, xp: 1, weight: 26,
    wobble: 5.2, wobbleAmp: 90,
  },
  marge: {
    id: 'marge', name: 'Sprinkler Wraith', shape: 'diamond',
    hpMul: 1.0, speedMul: 1.05, dmgMul: 1.0, radius: 10, xp: 2, weight: 16,
    wobble: 1.6, wobbleAmp: 45,
  },
  dwayne: {
    id: 'dwayne', name: 'Sprinkler Wraith', shape: 'square',
    hpMul: 2.0, speedMul: 0.62, dmgMul: 1.5, radius: 13, xp: 3, weight: 10,
  },
  newlyweds: {
    id: 'newlyweds', name: 'The Prices', shape: 'hex',
    hpMul: 1.6, speedMul: 1.25, dmgMul: 1.4, radius: 11, xp: 4, weight: 6,
    pairs: true,
  },
  previous: {
    id: 'previous', name: 'The Previous Owner', shape: 'ghost',
    hpMul: 1.3, speedMul: 0.9, dmgMul: 1.2, radius: 12, xp: 6, weight: 2,
    ghost: true, // ignores separation; drifts through the crowd
  },
  frog: {
    id: 'frog', name: 'Debt Frog', shape: 'boss',
    hpMul: 46, speedMul: 0.55, dmgMul: 3.0, radius: 34, xp: 120, weight: 0,
    boss: true, lungeEvery: 3.4, lungeSpeed: 320,
  },
};

/** Ordered ids of the types that spawn in normal waves (frog excluded). */
export const SPAWNABLE_IDS = ['sheila', 'colonel', 'marge', 'dwayne', 'newlyweds', 'previous'];

let _nextId = 1;

export class Enemy {
  constructor() {
    // All fields declared once so the shape stays monomorphic for the JIT.
    this.id = 0;
    this.neighborId = 'sheila';
    this.kind = 'enemy';
    this.type = ENEMY_TYPES.sheila;
    this.x = 0; this.y = 0;
    this.prevX = 0; this.prevY = 0;
    this.vx = 0; this.vy = 0;
    this.radius = 8;
    this.hp = 1; this.maxHp = 1;
    this.damage = 1;
    this.speed = 40;
    this.xpValue = 1;
    this.alive = false;
    this.age = 0;
    this.hitFlash = 0;
    this.phase = 0;           // per-enemy wobble offset
    this.contactCooldown = 0;
    this.lungeTimer = 0;
    this.isBoss = false;
    this.hitBy = null;        // set of projectile ids, for pierce de-dup
  }

  /** (Re)initialise a pooled instance. */
  init(neighborId, x, y, hp, speed, damage, rand) {
    const t = ENEMY_TYPES[neighborId] || ENEMY_TYPES.sheila;
    this.id = _nextId++;
    this.neighborId = neighborId;
    this.type = t;
    this.x = x; this.y = y;
    this.prevX = x; this.prevY = y;
    this.vx = 0; this.vy = 0;
    this.radius = t.radius;
    this.maxHp = hp;
    this.hp = hp;
    this.damage = damage;
    this.speed = speed;
    this.xpValue = t.xp;
    this.alive = true;
    this.age = 0;
    this.hitFlash = 0;
    this.phase = rand ? rand() * Math.PI * 2 : 0;
    this.contactCooldown = 0;
    this.lungeTimer = t.lungeEvery || 0;
    this.isBoss = !!t.boss;
    if (this.hitBy) this.hitBy.clear(); else this.hitBy = new Set();
    return this;
  }

  snapshot() {
    this.prevX = this.x;
    this.prevY = this.y;
  }

  /**
   * Steering toward the player + soft separation from neighbours.
   * @param {number} dt seconds
   * @param {Player} player
   * @param {SpatialGrid} grid enemy-only grid, already populated this tick
   * @param {object} sep CONFIG.enemy.separation
   */
  update(dt, player, grid, sep) {
    if (!this.alive) return;
    this.age += dt;
    if (this.hitFlash > 0) this.hitFlash -= dt;
    if (this.contactCooldown > 0) this.contactCooldown -= dt;

    let dx = player.x - this.x;
    let dy = player.y - this.y;
    const dist = Math.hypot(dx, dy) || 1;
    dx /= dist; dy /= dist;

    const t = this.type;

    // Lateral wobble: chickens jitter, wraiths arc.
    if (t.wobble) {
      const w = Math.sin(this.age * t.wobble + this.phase) * t.wobbleAmp;
      const px = -dy, py = dx;         // perpendicular to the seek direction
      dx += px * (w / 900);
      dy += py * (w / 900);
      const l = Math.hypot(dx, dy) || 1;
      dx /= l; dy /= l;
    }

    let sx = 0, sy = 0;
    if (!t.ghost) {
      // Soft separation — sample only nearby cells so this stays O(n * k).
      const r = sep.radius + this.radius;
      const near = grid.queryNear(this.x, this.y, r);
      let n = 0;
      for (let i = 0; i < near.length; i++) {
        const o = near[i];
        if (o === this || !o.alive) continue;
        const ox = this.x - o.x;
        const oy = this.y - o.y;
        const d2 = ox * ox + oy * oy;
        const minD = this.radius + o.radius + sep.pad;
        if (d2 > 0.0001 && d2 < minD * minD) {
          const d = Math.sqrt(d2);
          const push = (minD - d) / minD;
          sx += (ox / d) * push;
          sy += (oy / d) * push;
          if (++n >= sep.maxNeighbors) break;
        }
      }
    }

    let speed = this.speed;

    // Boss lunge: periodic burst of speed straight at the player.
    if (t.boss) {
      this.lungeTimer -= dt;
      if (this.lungeTimer <= 0) this.lungeTimer = t.lungeEvery;
      const inLunge = this.lungeTimer > t.lungeEvery - 0.55;
      if (inLunge) speed = t.lungeSpeed;
    }

    // Desired velocity = seek + separation weight.
    const desiredX = dx * speed + sx * sep.strength;
    const desiredY = dy * speed + sy * sep.strength;

    // Steer toward desired rather than snapping — gives mass/inertia.
    const steer = Math.min(1, sep.steerLerp * dt * 60);
    this.vx += (desiredX - this.vx) * steer;
    this.vy += (desiredY - this.vy) * steer;

    this.x += this.vx * dt;
    this.y += this.vy * dt;
  }

  /** @returns {boolean} true if this damage killed it */
  takeDamage(amount) {
    if (!this.alive) return false;
    this.hp -= amount;
    this.hitFlash = 0.08;
    if (this.hp <= 0) {
      this.alive = false;
      return true;
    }
    return false;
  }

  render(ctx, alpha, palette) {
    if (!this.alive) return;
    const x = this.prevX + (this.x - this.prevX) * alpha;
    const y = this.prevY + (this.y - this.prevY) * alpha;
    const r = this.radius;
    const color = this.hitFlash > 0 ? palette.hitFlash : (palette.neighbors[this.neighborId] || '#888');

    if (this.type.ghost) ctx.globalAlpha = 0.55;
    ctx.fillStyle = color;

    switch (this.type.shape) {
      case 'square':
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
        break;
      case 'triangle':
        ctx.beginPath();
        ctx.moveTo(x, y - r);
        ctx.lineTo(x + r, y + r * 0.8);
        ctx.lineTo(x - r, y + r * 0.8);
        ctx.closePath();
        ctx.fill();
        break;
      case 'diamond':
        ctx.beginPath();
        ctx.moveTo(x, y - r); ctx.lineTo(x + r, y);
        ctx.lineTo(x, y + r); ctx.lineTo(x - r, y);
        ctx.closePath();
        ctx.fill();
        break;
      case 'cone': // gnome: circle body + a hat triangle
        ctx.beginPath();
        ctx.arc(x, y + r * 0.25, r * 0.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(x, y - r * 1.25);
        ctx.lineTo(x + r * 0.7, y - r * 0.15);
        ctx.lineTo(x - r * 0.7, y - r * 0.15);
        ctx.closePath();
        ctx.fill();
        break;
      case 'hex':
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = (Math.PI / 3) * i - Math.PI / 6;
          const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
        break;
      case 'ghost':
        ctx.beginPath();
        ctx.arc(x, y - r * 0.2, r * 0.85, Math.PI, 0);
        ctx.lineTo(x + r * 0.85, y + r * 0.8);
        ctx.lineTo(x, y + r * 0.35);
        ctx.lineTo(x - r * 0.85, y + r * 0.8);
        ctx.closePath();
        ctx.fill();
        break;
      case 'boss': {
        ctx.beginPath();
        ctx.ellipse(x, y, r, r * 0.82, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = palette.bossAccent;
        ctx.beginPath();
        ctx.arc(x - r * 0.4, y - r * 0.45, r * 0.24, 0, Math.PI * 2);
        ctx.arc(x + r * 0.4, y - r * 0.45, r * 0.24, 0, Math.PI * 2);
        ctx.fill();
        // Unlabeled health arc — a shape, never a numeral.
        const frac = Math.max(0, this.hp / this.maxHp);
        ctx.strokeStyle = palette.bossAccent;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(x, y, r + 8, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
        ctx.stroke();
        break;
      }
      default:
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

/** Fixed-capacity pool. No per-spawn allocation after warm-up. */
export class EnemyPool {
  constructor(capacity = 600) {
    this.capacity = capacity;
    this.all = new Array(capacity);
    this.free = new Array(capacity);
    for (let i = 0; i < capacity; i++) {
      this.all[i] = new Enemy();
      this.free[i] = this.all[i];
    }
    this.active = [];
  }

  /** @returns {Enemy|null} null when the pool is exhausted (hard cap = safety) */
  spawn(neighborId, x, y, hp, speed, damage, rand) {
    const e = this.free.pop();
    if (!e) return null;
    e.init(neighborId, x, y, hp, speed, damage, rand);
    this.active.push(e);
    return e;
  }

  /** Compact the active list, returning dead instances to the free list. */
  reap(onDeath) {
    const a = this.active;
    let w = 0;
    for (let i = 0; i < a.length; i++) {
      const e = a[i];
      if (e.alive) {
        a[w++] = e;
      } else {
        if (onDeath) onDeath(e);
        this.free.push(e);
      }
    }
    a.length = w;
  }

  clear() {
    for (let i = 0; i < this.active.length; i++) {
      this.active[i].alive = false;
      this.free.push(this.active[i]);
    }
    this.active.length = 0;
  }
}

// SELF-TEST: Load index.html, let the night run.
//  1. Shapes of several distinct colors converge on the player from every edge.
//  2. They do NOT stack into a single pixel: a dense clump stays visibly spread
//     out (soft separation). Set CONFIG.enemy.separation.strength = 0 and
//     reload to see the difference.
//  3. In console: window.game.enemies.active.length rises through a wave and
//     falls as they die; window.game.enemies.free.length + active.length always
//     equals the pool capacity (no leaks).
//  4. Around 12-15 minutes a large frog-colored ellipse appears with an
//     unlabeled ring around it that shrinks as it is damaged.
