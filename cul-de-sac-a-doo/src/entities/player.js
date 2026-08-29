// Player entity. Owner: Agent A.
// Placeholder art only: flat shapes. No numbers ever drawn.
// Tuning lives in CONFIG (src/game/game.js) and is injected, never imported,
// to keep this module free of circular dependencies.

let _nextId = 1;

export class Player {
  /**
   * @param {number} x world x
   * @param {number} y world y
   * @param {object} cfg CONFIG.player slice from game.js
   */
  constructor(x, y, cfg) {
    this.id = `player_${_nextId++}`;
    this.neighborId = null;         // the player is not a neighbor
    this.kind = 'player';

    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;

    this.radius = cfg.radius;
    this.maxHp = cfg.maxHp;
    this.hp = cfg.maxHp;
    this.alive = true;

    this.cfg = cfg;

    // Movement feel
    this.accel = cfg.accel;
    this.maxSpeed = cfg.maxSpeed;
    this.friction = cfg.friction;

    // Facing, used to aim the default auto-fire when no enemy is near.
    this.facingX = 0;
    this.facingY = -1;

    // Combat bookkeeping (read by weapons/leveling via GameState)
    this.invulnTimer = 0;
    this.hitFlash = 0;
    this.damageTaken = 0;

    // Interpolation snapshot for smooth render between fixed steps.
    this.prevX = x;
    this.prevY = y;

    // Stat multipliers, refreshed each tick from Leveling (defaults to 1).
    this.stats = { speed: 1, damage: 1, fireRate: 1, area: 1, health: 1, pickupRadius: 1 };
    this.pickupRadius = cfg.pickupRadius;
  }

  snapshot() {
    this.prevX = this.x;
    this.prevY = this.y;
  }

  /**
   * @param {number} dt seconds (fixed step)
   * @param {{x:number,y:number}} move normalized-ish input vector, -1..1 each axis
   * @param {{minX:number,minY:number,maxX:number,maxY:number}} bounds arena
   */
  update(dt, move, bounds) {
    if (!this.alive) return;

    const speedMul = this.stats.speed;
    let mx = move.x;
    let my = move.y;
    const len = Math.hypot(mx, my);
    if (len > 1) { mx /= len; my /= len; }

    if (len > 0.001) {
      this.vx += mx * this.accel * speedMul * dt;
      this.vy += my * this.accel * speedMul * dt;
      this.facingX = mx / (len || 1);
      this.facingY = my / (len || 1);
    } else {
      // Exponential deceleration -> snappy stop without a hard cut.
      const damp = Math.pow(this.friction, dt * 60);
      this.vx *= damp;
      this.vy *= damp;
      if (Math.abs(this.vx) < 1) this.vx = 0;
      if (Math.abs(this.vy) < 1) this.vy = 0;
    }

    // Clamp to max speed
    const sp = Math.hypot(this.vx, this.vy);
    const cap = this.maxSpeed * speedMul;
    if (sp > cap) {
      this.vx = (this.vx / sp) * cap;
      this.vy = (this.vy / sp) * cap;
    }

    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // Arena clamp
    if (this.x < bounds.minX + this.radius) { this.x = bounds.minX + this.radius; this.vx = 0; }
    if (this.x > bounds.maxX - this.radius) { this.x = bounds.maxX - this.radius; this.vx = 0; }
    if (this.y < bounds.minY + this.radius) { this.y = bounds.minY + this.radius; this.vy = 0; }
    if (this.y > bounds.maxY - this.radius) { this.y = bounds.maxY - this.radius; this.vy = 0; }

    if (this.invulnTimer > 0) this.invulnTimer -= dt;
    if (this.hitFlash > 0) this.hitFlash -= dt;
  }

  /** @returns {boolean} true if the hit actually landed (not i-framed) */
  takeDamage(amount) {
    if (!this.alive || this.invulnTimer > 0) return false;
    this.hp -= amount;
    this.damageTaken += amount;
    this.invulnTimer = this.cfg.invulnSeconds;
    this.hitFlash = 0.18;
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
    }
    return true;
  }

  heal(amount) {
    this.hp = Math.min(this.maxHp * this.stats.health, this.hp + amount);
  }

  /** 0..1, used by D's UI to draw an unlabeled shape. Never a number on screen. */
  healthFraction() {
    const max = this.maxHp * this.stats.health;
    return max > 0 ? Math.max(0, Math.min(1, this.hp / max)) : 0;
  }

  /** @param {CanvasRenderingContext2D} ctx  @param {number} alpha interpolation 0..1 */
  render(ctx, alpha, palette) {
    const rx = this.prevX + (this.x - this.prevX) * alpha;
    const ry = this.prevY + (this.y - this.prevY) * alpha;

    // Ground shadow — a flat ellipse, sells grounding without art.
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = '#000000';
    ctx.beginPath();
    ctx.ellipse(rx, ry + this.radius * 0.85, this.radius * 0.9, this.radius * 0.35, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // Body
    ctx.fillStyle = this.hitFlash > 0 ? palette.hitFlash : palette.player;
    ctx.beginPath();
    ctx.arc(rx, ry, this.radius, 0, Math.PI * 2);
    ctx.fill();

    // Facing nub — a small square offset along the facing vector.
    ctx.fillStyle = palette.playerAccent;
    const nx = rx + this.facingX * this.radius * 0.75;
    const ny = ry + this.facingY * this.radius * 0.75;
    ctx.fillRect(nx - 2.5, ny - 2.5, 5, 5);

    // I-frame ring (shape only, no numerals)
    if (this.invulnTimer > 0) {
      ctx.strokeStyle = palette.playerAccent;
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(rx, ry, this.radius + 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
}

// SELF-TEST: Load index.html and press WASD / arrow keys.
//  1. The pale disc accelerates smoothly rather than snapping to full speed,
//     and coasts to a stop over ~0.2s when keys are released.
//  2. Walk into any arena edge: the disc stops flush against the boundary and
//     the dark out-of-bounds region never scrolls past the fence line.
//  3. Stand still in a crowd — the disc flashes and grows a ring for ~0.6s per
//     hit and cannot be hit again while the ring is up.
//  4. In console: window.game.player.healthFraction() drops toward 0; when it
//     reaches 0, alive === false and the run ends. No numbers appear on canvas.
