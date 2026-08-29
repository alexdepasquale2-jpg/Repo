// Cul-de-Sac-a-Doo — core game state, scene manager, wave director, combat.
// Owner: Agent A.
//
// EVERY tunable lives in CONFIG below, so balance is a one-file edit.
// EVERY placeholder color lives in PALETTE below, so art can drop in later.
// NO number is ever rendered to the screen — health and run-time are shapes.

import { rng } from '../systems/rng.js';
import { SpatialGrid, circleHit } from '../systems/collision.js';
import { Player } from '../entities/player.js';
import { EnemyPool, ENEMY_TYPES, SPAWNABLE_IDS } from '../entities/enemy.js';
import { ProjectilePool } from '../entities/projectile.js';

// ---------------------------------------------------------------------------
// CONFIG — the whole balance surface. Change numbers here, nowhere else.
// ---------------------------------------------------------------------------

export const CONFIG = {
  view: {
    width: 375,          // logical portrait pixels (canonical viewport)
    height: 812,
    maxDpr: 3,           // cap devicePixelRatio so huge-DPR phones stay fast
  },

  loop: {
    fixedHz: 60,               // fixed simulation rate
    maxFrameSeconds: 0.25,     // clamp dt on tab-restore (anti spiral-of-death)
    maxStepsPerFrame: 5,       // hard cap on catch-up steps per rAF
  },

  arena: {
    // World is a cul-de-sac: a wide rectangle the camera scrolls over.
    width: 1500,
    height: 2200,
    tileSize: 125,             // background grid (asphalt seams)
  },

  camera: {
    // Player sits slightly above centre so more of the road ahead is visible.
    offsetY: -40,
    lerp: 9.0,                 // higher = tighter follow
    lookAhead: 0.16,           // fraction of velocity added to target
  },

  player: {
    radius: 11,
    maxHp: 100,
    accel: 2600,               // px/s^2
    maxSpeed: 165,             // px/s
    friction: 0.80,            // per-60Hz-step velocity retention when idle
    invulnSeconds: 0.6,
    pickupRadius: 46,
    contactDamageMul: 1.0,
  },

  // Fallback auto-fire, used only until Agent B's WeaponSystem is attached.
  defaultWeapon: {
    cooldown: 0.30,            // seconds between volleys
    damage: 16,
    speed: 340,
    radius: 4,
    pierce: 1,                 // exercises the pierce path by default
    lifespan: 1.5,
    count: 2,                  // projectiles per volley
    spreadRad: 0.20,
    range: 340,                // targeting range; fires along facing if empty
  },

  enemy: {
    baseHp: 12,
    baseSpeed: 46,
    baseDamage: 8,
    contactCooldown: 0.55,     // per-enemy re-hit delay
    // Escalation per wave index (0-based). Deliberately gentle early.
    hpPerWave: 0.30,           // +30% of base hp per wave, linear
    hpExpo: 1.055,             // times this^wave, so late waves bite
    speedPerWave: 1.9,         // +px/s per wave
    speedCap: 118,
    damagePerWave: 1.5,
    poolCapacity: 700,
    maxAlive: 320,             // hard cap; wave director stalls above this
    separation: {
      radius: 26,
      pad: 2,
      strength: 155,           // push force vs. seek speed
      maxNeighbors: 8,         // bail after N pushes — keeps it O(n)
      steerLerp: 0.22,
    },
  },

  waves: {
    durationSec: 60,           // ~60s per wave
    // Spawn budget per wave: count = base + perWave*w, released evenly across
    // the wave via a fractional accumulator (so sub-1/sec rates still work).
    baseCount: 90,
    countPerWave: 40,
    countExpo: 1.055,
    budgetCarryMul: 1.5,       // cap on unspent budget, in multiples of a wave
    spawnRingMin: 300,         // spawn just off-screen around the player
    spawnRingMax: 400,
    // Type unlock schedule: a type is eligible once wave >= its entry.
    unlock: { sheila: 0, colonel: 1, marge: 3, dwayne: 5, newlyweds: 7, previous: 9 },
  },

  run: {
    bossAtSec: 13 * 60,        // Debt Frog arrives at 13:00 (contract: 12-15 min)
    hardEndSec: 15 * 60,       // absolute ceiling on a night
    seed: 20260829,
  },

  projectiles: {
    poolCapacity: 500,
  },

  grid: {
    cellSize: 48,              // ~2x the common enemy diameter
  },
};

// ---------------------------------------------------------------------------
// PALETTE — placeholder art. Flat colors only, one distinct hue per neighborId.
// ---------------------------------------------------------------------------

export const PALETTE = {
  skyNight: '#0b0d17',
  ground: '#171a26',
  groundAlt: '#1c2030',
  gridLine: '#232839',
  fence: '#3a4258',
  outOfBounds: '#05060b',

  player: '#f2ede3',
  playerAccent: '#ffcf5c',
  hitFlash: '#ffffff',
  projectile: '#ffe08a',
  bossAccent: '#0b0d17',

  dayGround: '#cfc7b2',
  daySky: '#e8e2d2',
  dayInk: '#4a4636',

  // One distinct flat color per canonical neighborId.
  neighbors: {
    sheila:    '#e05a7a',   // HOA pink
    colonel:   '#e8a13c',   // feed-sack amber
    frog:      '#4fbf6a',   // debt green
    marge:     '#5fb8d6',   // sprinkler blue
    dwayne:    '#8e7ad6',   // lawn-chair violet
    newlyweds: '#f0e05c',   // registry gold
    previous:  '#9aa7b8',   // faded grey
  },
};

// ---------------------------------------------------------------------------
// Null-object stubs. GameState runs standalone against these; the orchestrator
// swaps in the real modules later via attach(). Every stub is inert and silent.
// ---------------------------------------------------------------------------

const NULL_COLLABORATORS = {
  leveling: {
    addXp() { return null; },
    choose() {},
    statMultiplier() { return 1; },
  },
  weapons: {
    equip() {},
    current() { return null; },
    update() {},               // A's fallback auto-fire covers this until B lands
  },
  loot: {
    rollLoot() { return []; },
  },
  economy: {
    trust: 0, debt: 0,
    credit() {}, owe() {},
    priceFor() { return { tier: 0, affordable: false }; },
  },
  rumors: {
    spawn() {}, tick() {}, fragmentsNear() { return []; },
  },
  ui: {
    renderDay() {}, renderNight() {}, hideAll() {},
    showFragment() {}, showVendor() {}, showGiftMenu() {},
  },
  audio: {
    load() {}, sfx() {}, music() {}, stopMusic() {},
  },
  particles: {
    burst() {}, update() {}, render() {},
  },
};

// ---------------------------------------------------------------------------
// GameState
// ---------------------------------------------------------------------------

export class GameState {
  /** @param {number|string} seed */
  constructor(seed = CONFIG.run.seed) {
    this.seed = seed;
    this.rng = rng(seed);

    // Frozen-API fields
    this.phase = 'day';        // 'day' | 'night'
    this.dayTick = 0;
    this.run = this._freshRun();

    // Collaborators — always non-null so callers never branch on undefined.
    this.leveling = NULL_COLLABORATORS.leveling;
    this.weapons = NULL_COLLABORATORS.weapons;
    this.loot = NULL_COLLABORATORS.loot;
    this.economy = NULL_COLLABORATORS.economy;
    this.rumors = NULL_COLLABORATORS.rumors;
    this.ui = NULL_COLLABORATORS.ui;
    this.audio = NULL_COLLABORATORS.audio;
    this.particles = NULL_COLLABORATORS.particles;
    this._attached = {};

    // World
    this.bounds = {
      minX: 0, minY: 0,
      maxX: CONFIG.arena.width,
      maxY: CONFIG.arena.height,
    };
    this.player = new Player(CONFIG.arena.width / 2, CONFIG.arena.height / 2, CONFIG.player);
    this.enemies = new EnemyPool(CONFIG.enemy.poolCapacity);
    this.projectiles = new ProjectilePool(CONFIG.projectiles.poolCapacity);
    this.grid = new SpatialGrid(CONFIG.grid.cellSize);

    this.camera = { x: this.player.x, y: this.player.y, prevX: this.player.x, prevY: this.player.y };

    // Night timers
    this.runTime = 0;
    this.wave = 0;
    this.waveTime = 0;
    this.spawnTimer = 0;
    this.spawnBudget = 0;
    this.bossSpawned = false;
    this.boss = null;
    this.nightOver = false;
    this.lastSummary = null;

    // Fallback weapon cooldown
    this._fireCd = 0;

    // Input intent, written by main.js each frame.
    this.moveIntent = { x: 0, y: 0 };

    // Bound so it can be handed to WeaponSystem.update as a bare function.
    this.spawnProjectile = this.spawnProjectile.bind(this);
    this.findNearestEnemy = this.findNearestEnemy.bind(this);

    // Perf counters (never rendered)
    this.stats = { enemiesAlive: 0, projectilesAlive: 0 };
  }

  _freshRun() {
    return {
      kills: 0,
      damageTaken: 0,
      noise: 0,
      itemsLooted: [],
      wavesCleared: 0,
      bossDefeated: false,
      durationSec: 0,
    };
  }

  /**
   * Wire in the real modules once they exist. Any omitted key keeps its stub,
   * so partial wiring is safe and the game never crashes on a missing system.
   * @param {{leveling?,weapons?,loot?,economy?,rumors?,ui?,audio?,particles?}} c
   * @returns {GameState} this, for chaining
   */
  attach(c = {}) {
    for (const key of ['leveling', 'weapons', 'loot', 'economy', 'rumors', 'ui', 'audio', 'particles']) {
      if (c[key]) {
        this[key] = c[key];
        this._attached[key] = true;
      }
    }
    return this;
  }

  /** @returns {boolean} whether a real module (not the stub) is wired for key */
  hasCollaborator(key) {
    return !!this._attached[key];
  }

  // -------------------------------------------------------------------------
  // Phase control
  // -------------------------------------------------------------------------

  startNight() {
    this.phase = 'night';
    this.run = this._freshRun();
    this.runTime = 0;
    this.wave = 0;
    this.waveTime = 0;
    this.spawnTimer = 0;
    this.spawnBudget = this._waveBudget(0);
    this.bossSpawned = false;
    this.boss = null;
    this.nightOver = false;
    this._fireCd = 0;

    this.enemies.clear();
    this.projectiles.clear();

    this.player.x = CONFIG.arena.width / 2;
    this.player.y = CONFIG.arena.height / 2;
    this.player.prevX = this.player.x;
    this.player.prevY = this.player.y;
    this.player.vx = 0; this.player.vy = 0;
    this.player.hp = this.player.maxHp;
    this.player.alive = true;
    this.player.damageTaken = 0;
    this.player.invulnTimer = 0;

    this.camera.x = this.player.x; this.camera.y = this.player.y + CONFIG.camera.offsetY;
    this.camera.prevX = this.camera.x; this.camera.prevY = this.camera.y;

    this.audio.music('night', { fade: 1.0 });
    this.ui.hideAll();
  }

  /** @returns {object} RunSummary — consumed by C (aftermath) and D (screens) */
  endNight() {
    this.phase = 'day';
    this.nightOver = true;
    this.run.durationSec = this.runTime;
    this.run.damageTaken = this.player.damageTaken;
    this.run.wavesCleared = this.wave;
    this.enemies.clear();
    this.projectiles.clear();
    this.audio.stopMusic({ fade: 1.2 });
    this.ui.hideAll();
    const summary = {
      kills: this.run.kills,
      damageTaken: this.run.damageTaken,
      noise: this.run.noise,
      itemsLooted: this.run.itemsLooted.slice(),
      wavesCleared: this.run.wavesCleared,
      bossDefeated: this.run.bossDefeated,
      durationSec: this.run.durationSec,
    };
    this.lastSummary = summary;
    return summary;
  }

  // -------------------------------------------------------------------------
  // Update — fixed step, dt in SECONDS
  // -------------------------------------------------------------------------

  update(dt) {
    if (this.phase === 'night') this._updateNight(dt);
    else this._updateDay(dt);
  }

  _updateDay(dt) {
    this.dayTick += dt;
    // Placeholder day scene. Agents C and D build the real hub; A only keeps
    // the phase alive so the scene manager has something to switch to.
    this.rumors.tick();
  }

  _updateNight(dt) {
    if (this.nightOver) return;

    this.runTime += dt;
    this.waveTime += dt;

    // --- snapshots for interpolated render
    this.player.snapshot();
    this.camera.prevX = this.camera.x;
    this.camera.prevY = this.camera.y;
    const ea = this.enemies.active;
    for (let i = 0; i < ea.length; i++) ea[i].snapshot();
    const pa = this.projectiles.active;
    for (let i = 0; i < pa.length; i++) pa[i].snapshot();

    // --- stat multipliers from B's Leveling (1 with the stub)
    const st = this.player.stats;
    st.speed = this.leveling.statMultiplier('speed');
    st.damage = this.leveling.statMultiplier('damage');
    st.fireRate = this.leveling.statMultiplier('fireRate');
    st.area = this.leveling.statMultiplier('area');
    st.health = this.leveling.statMultiplier('health');
    st.pickupRadius = this.leveling.statMultiplier('pickupRadius');

    // --- player
    this.player.update(dt, this.moveIntent, this.bounds);
    this._updateCamera(dt);

    // --- wave director
    this._updateWaves(dt);

    // --- rebuild broad-phase over living enemies
    this.grid.clear();
    for (let i = 0; i < ea.length; i++) {
      if (ea[i].alive) this.grid.insert(ea[i]);
    }

    // --- enemies steer + separate
    const sep = CONFIG.enemy.separation;
    for (let i = 0; i < ea.length; i++) ea[i].update(dt, this.player, this.grid, sep);

    // --- weapons: B's system if attached, otherwise A's fallback auto-fire
    if (this.hasCollaborator('weapons')) {
      this.weapons.update(dt, this.player, this.spawnProjectile);
    } else {
      this._fallbackAutoFire(dt);
    }

    // --- projectiles
    for (let i = 0; i < pa.length; i++) pa[i].update(dt, this.findNearestEnemy);

    // --- collisions
    this._projectileHits();
    this._contactDamage(dt);

    // --- reap dead, award xp/loot
    this.enemies.reap((e) => this._onEnemyDeath(e));
    this.projectiles.reap();

    this.particles.update(dt);

    this.stats.enemiesAlive = ea.length;
    this.stats.projectilesAlive = pa.length;

    // --- end conditions
    if (!this.player.alive) {
      this.endNight();
    } else if (this.run.bossDefeated || this.runTime >= CONFIG.run.hardEndSec) {
      this.endNight();
    }
  }

  _updateCamera(dt) {
    const p = this.player;
    const tx = p.x + p.vx * CONFIG.camera.lookAhead;
    const ty = p.y + p.vy * CONFIG.camera.lookAhead + CONFIG.camera.offsetY;
    const k = Math.min(1, CONFIG.camera.lerp * dt);
    this.camera.x += (tx - this.camera.x) * k;
    this.camera.y += (ty - this.camera.y) * k;
  }

  // -------------------------------------------------------------------------
  // Waves
  // -------------------------------------------------------------------------

  _waveBudget(w) {
    return Math.round((CONFIG.waves.baseCount + CONFIG.waves.countPerWave * w) *
      Math.pow(CONFIG.waves.countExpo, w));
  }

  _eligibleTypes(w) {
    const out = [];
    for (const id of SPAWNABLE_IDS) {
      if (w >= (CONFIG.waves.unlock[id] ?? 0)) out.push(id);
    }
    return out;
  }

  _pickType(w) {
    const ids = this._eligibleTypes(w);
    let total = 0;
    for (let i = 0; i < ids.length; i++) total += ENEMY_TYPES[ids[i]].weight;
    let r = this.rng() * total;
    for (let i = 0; i < ids.length; i++) {
      r -= ENEMY_TYPES[ids[i]].weight;
      if (r <= 0) return ids[i];
    }
    return ids[0];
  }

  _updateWaves(dt) {
    // Boss at a fixed run timer, once.
    if (!this.bossSpawned && this.runTime >= CONFIG.run.bossAtSec) {
      this.bossSpawned = true;
      this.boss = this._spawnAt('frog', 260);
      this.audio.sfx('boss_arrive');
    }

    if (this.waveTime >= CONFIG.waves.durationSec) {
      this.waveTime -= CONFIG.waves.durationSec;
      this.wave++;
      this.run.wavesCleared = this.wave;
      this.spawnBudget += this._waveBudget(this.wave);
      // Never bank an unbounded backlog: an enemy-cap stall must not turn into
      // a dump of hundreds the moment the cap clears.
      const cap = this._waveBudget(this.wave) * CONFIG.waves.budgetCarryMul;
      if (this.spawnBudget > cap) this.spawnBudget = cap;
      this.audio.sfx('wave');
    }

    // Release the current wave's budget evenly across its duration. A
    // fractional accumulator lets rates below 1/sec work without bunching.
    this.spawnTimer += dt * (this._waveBudget(this.wave) / CONFIG.waves.durationSec);
    let n = Math.floor(this.spawnTimer);
    if (n <= 0) return;
    this.spawnTimer -= n;

    if (this.spawnBudget <= 0) return;
    if (this.enemies.active.length >= CONFIG.enemy.maxAlive) return;
    n = Math.min(n, this.spawnBudget, CONFIG.enemy.maxAlive - this.enemies.active.length);

    for (let i = 0; i < n; i++) {
      const id = this._pickType(this.wave);
      const e = this._spawnAt(id);
      if (!e) break;
      this.spawnBudget--;
      // Newlyweds arrive as a couple.
      if (ENEMY_TYPES[id].pairs && this.spawnBudget > 0 &&
          this.enemies.active.length < CONFIG.enemy.maxAlive) {
        const m = this._spawnAt(id);
        if (m) {
          m.x = e.x + 14; m.y = e.y + 14; m.prevX = m.x; m.prevY = m.y;
          this.spawnBudget--;
        }
      }
    }
  }

  /** Spawn one enemy in an off-screen ring around the player. */
  _spawnAt(neighborId, forcedDist) {
    const t = ENEMY_TYPES[neighborId];
    if (!t) return null;
    const a = this.rng.angle();
    const d = forcedDist !== undefined
      ? forcedDist
      : this.rng.range(CONFIG.waves.spawnRingMin, CONFIG.waves.spawnRingMax);
    let x = this.player.x + Math.cos(a) * d;
    let y = this.player.y + Math.sin(a) * d;
    // Keep spawns inside the arena so nothing is stranded outside the fence.
    x = Math.max(this.bounds.minX + t.radius + 2, Math.min(this.bounds.maxX - t.radius - 2, x));
    y = Math.max(this.bounds.minY + t.radius + 2, Math.min(this.bounds.maxY - t.radius - 2, y));

    const w = this.wave;
    const c = CONFIG.enemy;
    const hp = (c.baseHp * (1 + c.hpPerWave * w) * Math.pow(c.hpExpo, w)) * t.hpMul;
    const speed = Math.min(c.speedCap, c.baseSpeed + c.speedPerWave * w) * t.speedMul;
    const dmg = (c.baseDamage + c.damagePerWave * w) * t.dmgMul;
    return this.enemies.spawn(neighborId, x, y, hp, speed, dmg, this.rng);
  }

  // -------------------------------------------------------------------------
  // Combat
  // -------------------------------------------------------------------------

  /**
   * FROZEN SIGNATURE for Agent B's WeaponSystem.
   * @param {object} opts see src/entities/projectile.js for the full field list.
   * @returns {Projectile|null} null only when the pool is saturated.
   */
  spawnProjectile(opts) {
    if (opts.damage !== undefined) {
      // Apply the player's damage multiplier centrally so B never has to.
      opts = Object.assign({}, opts, { damage: opts.damage * this.player.stats.damage });
    }
    const p = this.projectiles.spawn(opts);
    if (p) this.run.noise += 0.05;
    return p;
  }

  /** Nearest living enemy within r, or null. Used for targeting and homing. */
  findNearestEnemy(x, y, r) {
    const a = this.enemies.active;
    let best = null;
    let bestD2 = r * r;
    for (let i = 0; i < a.length; i++) {
      const e = a[i];
      if (!e.alive) continue;
      const dx = e.x - x, dy = e.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; best = e; }
    }
    return best;
  }

  _fallbackAutoFire(dt) {
    const w = CONFIG.defaultWeapon;
    this._fireCd -= dt * this.player.stats.fireRate;
    if (this._fireCd > 0) return;
    this._fireCd = w.cooldown;

    const p = this.player;
    const target = this.findNearestEnemy(p.x, p.y, w.range);
    let ax, ay;
    if (target) {
      ax = target.x - p.x; ay = target.y - p.y;
    } else {
      ax = p.facingX; ay = p.facingY;
    }
    const base = Math.atan2(ay, ax);
    for (let i = 0; i < w.count; i++) {
      const off = (i - (w.count - 1) / 2) * w.spreadRad;
      this.spawnProjectile({
        x: p.x, y: p.y, angle: base + off,
        speed: w.speed, damage: w.damage, radius: w.radius,
        pierce: w.pierce, lifespan: w.lifespan, weaponId: 'default',
      });
    }
    this.audio.sfx('shoot');
  }

  _projectileHits() {
    const pa = this.projectiles.active;
    for (let i = 0; i < pa.length; i++) {
      const p = pa[i];
      if (!p.alive) continue;
      const near = this.grid.queryNear(p.x, p.y, p.radius + 20);
      for (let j = 0; j < near.length; j++) {
        const e = near[j];
        if (!e.alive || !p.canHit(e)) continue;
        if (!circleHit(p, e)) continue;

        const killed = e.takeDamage(p.damage);
        if (p.knockback > 0) {
          const dx = e.x - p.x, dy = e.y - p.y;
          const l = Math.hypot(dx, dy) || 1;
          e.vx += (dx / l) * p.knockback;
          e.vy += (dy / l) * p.knockback;
        }
        if (p.onHit) p.onHit(e, p);
        this.particles.burst(e.x, e.y, killed ? 'death' : 'hit');
        if (killed) this.audio.sfx('kill');
        if (p.registerHit(e)) break;    // expired on this hit
      }
    }
  }

  _contactDamage(dt) {
    const p = this.player;
    if (!p.alive) return;
    const near = this.grid.queryNear(p.x, p.y, p.radius + 40);
    for (let i = 0; i < near.length; i++) {
      const e = near[i];
      if (!e.alive || e.contactCooldown > 0) continue;
      if (!circleHit(p, e)) continue;
      e.contactCooldown = CONFIG.enemy.contactCooldown;
      if (p.takeDamage(e.damage * CONFIG.player.contactDamageMul)) {
        this.particles.burst(p.x, p.y, 'playerHit');
        this.audio.sfx('hurt');
      }
    }
  }

  _onEnemyDeath(e) {
    this.run.kills++;
    this.run.noise += e.isBoss ? 8 : 0.35;
    if (e.isBoss) {
      this.run.bossDefeated = true;
      this.boss = null;
    }
    const lvl = this.leveling.addXp(e.xpValue);
    if (lvl && lvl.choices) {
      // B/D own the level-up choice UI; A just forwards it.
      this.ui.renderNight(this);
    }
    const items = this.loot.rollLoot ? this.loot.rollLoot(this.wave, e.neighborId, this.rng) : [];
    if (items && items.length) {
      for (let i = 0; i < items.length; i++) this.run.itemsLooted.push(items[i]);
    }
  }

  // -------------------------------------------------------------------------
  // Render — background -> entities -> particles -> UI overlay
  // -------------------------------------------------------------------------

  /**
   * @param {CanvasRenderingContext2D} ctx already scaled to logical units
   * @param {number} alpha 0..1 interpolation between fixed steps
   */
  render(ctx, alpha) {
    const W = CONFIG.view.width, H = CONFIG.view.height;
    if (this.phase === 'night') this._renderNight(ctx, alpha, W, H);
    else this._renderDay(ctx, W, H);
  }

  _renderDay(ctx, W, H) {
    ctx.fillStyle = PALETTE.daySky;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = PALETTE.dayGround;
    ctx.fillRect(0, H * 0.42, W, H * 0.58);

    // Placeholder houses — flat rectangles + roof triangles, one per neighbor.
    const ids = ['sheila', 'colonel', 'marge', 'dwayne', 'newlyweds', 'previous', 'frog'];
    for (let i = 0; i < ids.length; i++) {
      const col = i % 3, row = Math.floor(i / 3);
      const x = 26 + col * 112, y = H * 0.46 + row * 150;
      ctx.fillStyle = PALETTE.neighbors[ids[i]];
      ctx.fillRect(x, y, 86, 74);
      ctx.beginPath();
      ctx.moveTo(x - 8, y);
      ctx.lineTo(x + 43, y - 30);
      ctx.lineTo(x + 94, y);
      ctx.closePath();
      ctx.fill();
    }

    // The one permitted piece of text: prose, no numbers. (Agents C/D replace
    // this whole scene with the real hub.)
    ctx.fillStyle = PALETTE.dayInk;
    ctx.font = '15px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('the street is quiet', W / 2, H * 0.2);
    ctx.font = '12px ui-monospace, Menlo, monospace';
    ctx.fillText('someone has moved their sprinkler', W / 2, H * 0.2 + 24);
    ctx.textAlign = 'left';
  }

  _renderNight(ctx, alpha, W, H) {
    const cx = this.camera.prevX + (this.camera.x - this.camera.prevX) * alpha;
    const cy = this.camera.prevY + (this.camera.y - this.camera.prevY) * alpha;
    const ox = Math.round(W / 2 - cx);
    const oy = Math.round(H / 2 - cy);

    // ---- 1. background
    ctx.fillStyle = PALETTE.outOfBounds;
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.translate(ox, oy);

    ctx.fillStyle = PALETTE.ground;
    ctx.fillRect(0, 0, CONFIG.arena.width, CONFIG.arena.height);

    // Asphalt grid — only the cells actually on screen.
    const ts = CONFIG.arena.tileSize;
    const x0 = Math.max(0, Math.floor((cx - W / 2) / ts));
    const x1 = Math.min(Math.ceil(CONFIG.arena.width / ts), Math.ceil((cx + W / 2) / ts) + 1);
    const y0 = Math.max(0, Math.floor((cy - H / 2) / ts));
    const y1 = Math.min(Math.ceil(CONFIG.arena.height / ts), Math.ceil((cy + H / 2) / ts) + 1);
    ctx.fillStyle = PALETTE.groundAlt;
    for (let gx = x0; gx < x1; gx++) {
      for (let gy = y0; gy < y1; gy++) {
        if (((gx + gy) & 1) === 0) ctx.fillRect(gx * ts, gy * ts, ts, ts);
      }
    }
    ctx.strokeStyle = PALETTE.gridLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let gx = x0; gx < x1; gx++) { ctx.moveTo(gx * ts, y0 * ts); ctx.lineTo(gx * ts, y1 * ts); }
    for (let gy = y0; gy < y1; gy++) { ctx.moveTo(x0 * ts, gy * ts); ctx.lineTo(x1 * ts, gy * ts); }
    ctx.stroke();

    // Fence line = arena bounds
    ctx.strokeStyle = PALETTE.fence;
    ctx.lineWidth = 4;
    ctx.strokeRect(0, 0, CONFIG.arena.width, CONFIG.arena.height);

    // ---- 2. entities
    const pa = this.projectiles.active;
    const ea = this.enemies.active;
    for (let i = 0; i < ea.length; i++) ea[i].render(ctx, alpha, PALETTE);
    this.player.render(ctx, alpha, PALETTE);
    for (let i = 0; i < pa.length; i++) pa[i].render(ctx, alpha, PALETTE);

    // ---- 3. particles (D's system; stub is a no-op)
    this.particles.render(ctx);

    ctx.restore();

    // ---- 4. UI overlay drawn by A: shapes only, never numerals.
    this._renderHud(ctx, W, H);
  }

  /**
   * Minimal canvas HUD. STRICTLY non-numeric:
   *  - health is an unlabeled bar whose WIDTH is the only signal
   *  - run progress is an unlabeled arc in the corner
   *  - boss presence is a wide unlabeled bar at the top
   * Agent D's UIManager renders the real HUD in the DOM on top of this.
   */
  _renderHud(ctx, W, H) {
    const hf = this.player.healthFraction();
    const bw = W - 48, bh = 6, bx = 24, by = H - 26;
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = PALETTE.fence;
    ctx.fillRect(bx, by, bw, bh);
    ctx.globalAlpha = 1;
    ctx.fillStyle = hf > 0.3 ? PALETTE.player : PALETTE.neighbors.sheila;
    ctx.fillRect(bx, by, bw * hf, bh);

    // Run progress arc, top-right. No ticks, no labels.
    const prog = Math.min(1, this.runTime / CONFIG.run.bossAtSec);
    ctx.strokeStyle = PALETTE.fence;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(W - 24, 24, 10, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = PALETTE.playerAccent;
    ctx.beginPath();
    ctx.arc(W - 24, 24, 10, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * prog);
    ctx.stroke();

    if (this.boss && this.boss.alive) {
      const f = Math.max(0, this.boss.hp / this.boss.maxHp);
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = PALETTE.fence;
      ctx.fillRect(24, 16, W - 88, 5);
      ctx.globalAlpha = 1;
      ctx.fillStyle = PALETTE.neighbors.frog;
      ctx.fillRect(24, 16, (W - 88) * f, 5);
    }
  }
}

// SELF-TEST: serve the folder (`python3 -m http.server 8000`) and open it at a
// 375x812 viewport.
//  1. Console is clean on load; window.game exists.
//  2. window.game.startNight() -> shapes stream in from off-screen and converge.
//  3. WASD/arrows move the pale disc; the world scrolls under it; the fence
//     rectangle stops the camera drifting past the arena content.
//  4. Bright dots auto-fire at the nearest enemy and delete it on contact.
//     window.game.run.kills climbs.
//  5. Balance: window.game.runTime = 770 -> within ~10s a large green ellipse
//     (Debt Frog) arrives with an unlabeled ring. Killing it ends the night and
//     endNight() returns a RunSummary with bossDefeated === true.
//  6. Non-numeric check: nothing on the canvas is a digit. The only text is the
//     day-phase prose lines.
//  7. Attach check: window.game.attach({ particles: { burst(){}, update(){}, render(){} } })
//     replaces only that system; the rest keep their stubs.
