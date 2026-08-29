// Pooled projectiles. Owner: Agent A.
// Zero per-shot allocation: a fixed free list of pre-constructed instances.
// Agent B's WeaponSystem drives these through GameState.spawnProjectile(opts).

let _nextId = 1;

/**
 * Options accepted by spawnProjectile (all optional except x/y and a direction):
 * {
 *   x, y,                 // world origin
 *   dx, dy,               // direction (normalized internally); or use angle
 *   angle,                // radians, alternative to dx/dy
 *   speed = 260,          // px/sec
 *   damage = 10,
 *   radius = 4,
 *   pierce = 0,           // number of EXTRA enemies it can hit past the first
 *   lifespan = 2.0,       // seconds
 *   knockback = 0,
 *   color,                // overrides palette.projectile
 *   shape = 'dot',        // 'dot' | 'bar' | 'ring'
 *   weaponId,             // passthrough tag for B
 *   homing = 0,           // 0..1 turn strength per tick toward nearest enemy
 *   onHit                 // optional callback(enemy, projectile)
 * }
 */
export class Projectile {
  constructor() {
    this.id = 0;
    this.kind = 'projectile';
    this.x = 0; this.y = 0;
    this.prevX = 0; this.prevY = 0;
    this.vx = 0; this.vy = 0;
    this.radius = 4;
    this.damage = 10;
    this.pierce = 0;
    this.pierceLeft = 0;
    this.life = 0;
    this.maxLife = 2;
    this.alive = false;
    this.knockback = 0;
    this.color = null;
    this.shape = 'dot';
    this.weaponId = null;
    this.homing = 0;
    this.onHit = null;
    this.hitIds = new Set();   // enemy ids already hit, so pierce never double-dips
  }

  init(o) {
    this.id = _nextId++;
    this.x = o.x; this.y = o.y;
    this.prevX = o.x; this.prevY = o.y;

    let dx = o.dx, dy = o.dy;
    if (dx === undefined || dy === undefined) {
      const a = o.angle || 0;
      dx = Math.cos(a); dy = Math.sin(a);
    }
    const l = Math.hypot(dx, dy) || 1;
    const speed = o.speed === undefined ? 260 : o.speed;
    this.vx = (dx / l) * speed;
    this.vy = (dy / l) * speed;

    this.radius = o.radius === undefined ? 4 : o.radius;
    this.damage = o.damage === undefined ? 10 : o.damage;
    this.pierce = o.pierce === undefined ? 0 : o.pierce;
    this.pierceLeft = this.pierce;
    this.maxLife = o.lifespan === undefined ? 2.0 : o.lifespan;
    this.life = this.maxLife;
    this.knockback = o.knockback || 0;
    this.color = o.color || null;
    this.shape = o.shape || 'dot';
    this.weaponId = o.weaponId || null;
    this.homing = o.homing || 0;
    this.onHit = o.onHit || null;
    this.alive = true;
    this.hitIds.clear();
    return this;
  }

  snapshot() {
    this.prevX = this.x;
    this.prevY = this.y;
  }

  update(dt, findNearest) {
    if (!this.alive) return;
    this.life -= dt;
    if (this.life <= 0) { this.alive = false; return; }

    if (this.homing > 0 && findNearest) {
      const target = findNearest(this.x, this.y, 220);
      if (target) {
        const sp = Math.hypot(this.vx, this.vy) || 1;
        let tx = target.x - this.x, ty = target.y - this.y;
        const tl = Math.hypot(tx, ty) || 1;
        tx = (tx / tl) * sp; ty = (ty / tl) * sp;
        const k = Math.min(1, this.homing * dt * 8);
        this.vx += (tx - this.vx) * k;
        this.vy += (ty - this.vy) * k;
        const nl = Math.hypot(this.vx, this.vy) || 1;
        this.vx = (this.vx / nl) * sp;
        this.vy = (this.vy / nl) * sp;
      }
    }

    this.x += this.vx * dt;
    this.y += this.vy * dt;
  }

  /**
   * Register a hit. @returns {boolean} true if the projectile should expire.
   */
  registerHit(enemy) {
    this.hitIds.add(enemy.id);
    if (this.pierceLeft > 0) { this.pierceLeft--; return false; }
    this.alive = false;
    return true;
  }

  canHit(enemy) {
    return this.alive && !this.hitIds.has(enemy.id);
  }

  render(ctx, alpha, palette) {
    if (!this.alive) return;
    const x = this.prevX + (this.x - this.prevX) * alpha;
    const y = this.prevY + (this.y - this.prevY) * alpha;
    ctx.fillStyle = this.color || palette.projectile;
    if (this.shape === 'bar') {
      const a = Math.atan2(this.vy, this.vx);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(a);
      ctx.fillRect(-this.radius * 2, -this.radius * 0.5, this.radius * 4, this.radius);
      ctx.restore();
    } else if (this.shape === 'ring') {
      ctx.strokeStyle = this.color || palette.projectile;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, this.radius, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(x, y, this.radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

export class ProjectilePool {
  constructor(capacity = 400) {
    this.capacity = capacity;
    this.all = new Array(capacity);
    this.free = new Array(capacity);
    for (let i = 0; i < capacity; i++) {
      this.all[i] = new Projectile();
      this.free[i] = this.all[i];
    }
    this.active = [];
  }

  /** @returns {Projectile|null} */
  spawn(opts) {
    const p = this.free.pop();
    if (!p) return null;               // pool exhausted: drop the shot, never allocate
    p.init(opts);
    this.active.push(p);
    return p;
  }

  reap() {
    const a = this.active;
    let w = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i].alive) a[w++] = a[i];
      else this.free.push(a[i]);
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

// SELF-TEST: Load index.html and start the night.
//  1. Small bright dots stream from the player toward the nearest enemy and
//     vanish on contact or after their lifespan.
//  2. In console:
//       window.game.spawnProjectile({x: window.game.player.x, y: window.game.player.y,
//         angle: 0, speed: 200, damage: 999, pierce: 5, lifespan: 3, shape:'bar'});
//     -> one bar flies right and passes through up to 6 enemies, killing each.
//  3. window.game.projectiles.free.length + .active.length stays constant at
//     the pool capacity for the whole run (proves zero per-shot allocation).
