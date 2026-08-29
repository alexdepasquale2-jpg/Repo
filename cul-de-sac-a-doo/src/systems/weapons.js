// src/systems/weapons.js
// ===========================================================================
// WEAPON SYSTEM — auto-fire driver for Cul-de-Sac-a-Doo.
//
// Owner: Agent B (Progression). Pure and standalone: it imports only its own
// data file, never calls Math.random(), and receives the player, the RNG and
// the projectile spawner from outside.
//
// Frozen API (docs/CONTRACT.md):
//   new WeaponSystem({ rng, stats })
//   equip(weaponId)   current()   update(dt, player, spawnProjectile)
//
// ---------------------------------------------------------------------------
// >>> THE spawnProjectile(opts) CONTRACT — READ THIS, AGENT A <<<
// ---------------------------------------------------------------------------
// Every shot this system fires is one call to the callback you pass into
// update(). One call = one projectile. We never batch. The object is freshly
// allocated per shot, so the pool may keep it or copy it, whichever it likes.
//
// GUARANTEED FIELDS — always present, always finite numbers (or the stated
// type). A pool that reads only these will work correctly for all six weapons:
//
//   x, y        Number  spawn position, world pixels (already muzzle-offset)
//   dx, dy      Number  UNIT direction vector (dx*dx + dy*dy === 1, within
//                       floating-point slop). Zero-length is never emitted;
//                       an orbit shot emits its current tangent instead.
//   speed       Number  world px/sec along (dx, dy). MAY BE ZERO for 'orbit'
//                       shots, which are positioned by the pool each frame
//                       from `orbit` rather than integrated from velocity.
//   damage      Number  damage per enemy hit, already multiplied by player stats
//   radius      Number  collision radius, world pixels
//   pierce      Number  additional enemies passed through before despawn.
//                       0 = despawn on first hit. Large values (e.g. the bat's)
//                       mean "effectively unlimited".
//   lifetime    Number  seconds before despawn regardless of hits
//   kind        String  render/behaviour tag: one of
//                       'bottle' | 'shard' | 'water' | 'dart' | 'gust' |
//                       'bat' | 'ember'  (plus evolved kinds, see evolution.js)
//
// OPTIONAL FIELDS — present only when the pattern needs them. IGNORING ANY OF
// THESE IS SAFE: the projectile still flies straight and still deals damage,
// it just loses its flavour. Implement them as you get to them.
//
//   weaponId    String  which weapon fired it (telemetry, evolution triggers)
//   pattern     String  the firing routine: 'lob'|'sweep'|'spear'|'cone'|
//                       'orbit'|'boomerang'
//   ax, ay      Number  constant acceleration, px/sec^2. Used by 'lob' to bend
//                       the throw sideways. Integrate as v += a*dt.
//   follow      String  'player' — the projectile's frame of reference moves
//                       with the player. Only 'orbit' sets this.
//   orbit       Object  { radius, angle, speed, hitInterval } — when present,
//                       position the projectile at
//                         px + cos(angle + speed*t) * radius,
//                         py + sin(angle + speed*t) * radius
//                       and allow it to re-damage the same enemy at most once
//                       per `hitInterval` seconds.
//   returnAt    Number  seconds after spawn at which the projectile reverses
//                       toward the player. Only 'boomerang' sets it.
//   returnSpeed Number  speed used on the return leg.
//   homeTo      String  'player' — on the return leg, steer toward the player's
//                       CURRENT position and despawn on arrival.
//   damageFalloff Number multiplier applied to `damage` after each pierce hit
//                       (e.g. 0.85). Absent means no falloff.
//   knockback   Number  px/sec impulse applied to the enemy on hit.
//   noise       Number  added to RunSummary.noise when this shot is fired.
//                       Only the leaf blower emits it; the loud weapon should
//                       cost you socially.
//   onExpire    Object  { count, damage, speed, radius, lifetime, kind,
//                         pierce } — when the projectile despawns by LIFETIME
//                       (not by pierce exhaustion), spawn `count` projectiles
//                       evenly around the circle at the death position with
//                       these values. Feed them back through the same pool.
//                       Only the bottle sets it. Skipping it costs the bottle
//                       its shatter, nothing more.
//
//   borrowedPattern String  set only by the evolved 'revenant' form: which base
//                       pattern this particular volley imitated.
//   ghostSourced Boolean set only by 'revenant': the shot originated from the
//                       player's trailing echo, not the player. Render it
//                       faded if you like; it is otherwise an ordinary shot.
//
// The pool owns collision, despawn and rendering. This system owns only
// "what leaves the muzzle, and when".
// ===========================================================================

import { WEAPONS_BY_ID, DEFAULT_WEAPON_ID } from '../data/weapons.js';

const TAU = Math.PI * 2;

/** Resolve the player's aim direction defensively — Agent A's shape may vary. */
export function readAim(player) {
  if (!player) return { x: 1, y: 0 };
  if (typeof player.aimAngle === 'number') {
    return { x: Math.cos(player.aimAngle), y: Math.sin(player.aimAngle) };
  }
  const cands = [
    player.aim,
    (typeof player.aimX === 'number') ? { x: player.aimX, y: player.aimY } : null,
    (typeof player.facingX === 'number') ? { x: player.facingX, y: player.facingY } : null,
    (typeof player.vx === 'number') ? { x: player.vx, y: player.vy } : null
  ];
  for (const c of cands) {
    if (!c) continue;
    const len = Math.hypot(c.x || 0, c.y || 0);
    if (len > 1e-6) return { x: c.x / len, y: c.y / len };
  }
  return { x: 0, y: -1 }; // portrait default: straight up the street
}

function angleOf(v) { return Math.atan2(v.y, v.x); }

export class WeaponSystem {
  /**
   * @param {{ rng?: ()=>number,
   *           stats?: (statName:string)=>number,
   *           weaponId?: string }} [opts]
   *   rng   — injected uniform [0,1). Required for reproducible runs.
   *   stats — usually `leveling.statMultiplier.bind(leveling)`. Defaults to
   *           a neutral provider so the system works with no progression.
   */
  constructor(opts = {}) {
    this.rng = opts.rng || (() => 0.5);
    this.stats = opts.stats || (() => 1);
    /** @type {Map<string, object>} weaponId -> per-weapon runtime state */
    this.state = new Map();
    this.equipped = null;
    this.shotsFired = 0;
    this.equip(opts.weaponId || DEFAULT_WEAPON_ID);
  }

  /** Swap the active weapon. Returns the def, or null if the id is unknown. */
  equip(weaponId) {
    const def = WEAPONS_BY_ID[weaponId] || this._extra?.get(weaponId);
    if (!def) return null;
    this.equipped = def;
    if (!this.state.has(def.id)) {
      this.state.set(def.id, {
        cd: 0,           // seconds until the next volley
        sweepAngle: 0,   // sweep: current offset within the arc
        sweepDir: 1,
        flip: 1,         // lob: alternating drift sign
        orbitPhase: 0,   // orbit: ring rotation carried between volleys
        queue: [],       // boomerang: staggered pending shots
        t: 0
      });
    }
    return def;
  }

  /**
   * Register an evolved weapon definition at runtime (see evolution.js).
   * Keeps src/data/weapons.js as the only place base tuning lives.
   */
  register(def) {
    if (!this._extra) this._extra = new Map();
    this._extra.set(def.id, def);
    return def;
  }

  /** @returns {object|null} the equipped WeaponDef. */
  current() {
    return this.equipped;
  }

  /** Effective, stat-modified copy of the equipped def. */
  effective() {
    const d = this.equipped;
    if (!d) return null;
    const s = this.stats;
    return {
      cooldown: Math.max(0.02, d.cooldown / Math.max(0.05, s('fireRate'))),
      count: d.count,
      spread: d.spread * s('spread'),
      damage: d.damage * s('damage'),
      speed: d.speed * s('projectileSpeed'),
      radius: d.radius * s('projectileSize'),
      pierce: Math.round(d.pierce * s('pierce')),
      lifetime: d.lifetime,
      kind: d.kind,
      extra: d.extra || {}
    };
  }

  /**
   * Advance the weapon clock and auto-fire.
   * @param {number} dt seconds
   * @param {{x:number,y:number}} player
   * @param {(opts:object)=>void} spawnProjectile see the contract block above
   */
  update(dt, player, spawnProjectile) {
    const def = this.equipped;
    if (!def || typeof spawnProjectile !== 'function') return;
    const st = this.state.get(def.id);
    const e = this.effective();
    st.t += dt;

    // Boomerang volleys leave the barrel one at a time.
    if (st.queue.length) {
      for (let i = st.queue.length - 1; i >= 0; i--) {
        st.queue[i].at -= dt;
        if (st.queue[i].at <= 0) {
          const q = st.queue.splice(i, 1)[0];
          this._emit(spawnProjectile, q.opts, player);
        }
      }
    }

    st.cd -= dt;
    let guard = 0;
    while (st.cd <= 0 && guard++ < 16) {
      st.cd += e.cooldown;
      this._fire(def, e, st, player, spawnProjectile);
    }
    if (st.cd < 0) st.cd = 0;
  }

  _emit(spawnProjectile, opts, player) {
    // Orbit shots ride the player's frame; re-anchor at emit time.
    this.shotsFired++;
    spawnProjectile(opts);
  }

  _base(def, e, player, angle, overrides) {
    const px = player && typeof player.x === 'number' ? player.x : 0;
    const py = player && typeof player.y === 'number' ? player.y : 0;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const muzzle = 10;
    return Object.assign({
      x: px + dx * muzzle,
      y: py + dy * muzzle,
      dx, dy,
      speed: e.speed,
      damage: e.damage,
      radius: e.radius,
      pierce: e.pierce,
      lifetime: e.lifetime,
      kind: e.kind,
      weaponId: def.id,
      pattern: def.pattern
    }, overrides || {});
  }

  _fire(def, e, st, player, spawn) {
    const aim = angleOf(readAim(player));
    const ex = e.extra;
    const kb = this.stats('knockback');

    switch (def.pattern) {

      // --- lob: arcing throw that bends sideways, shatters at end of life ---
      case 'lob': {
        st.flip *= -1;
        const n = Math.max(1, e.count);
        for (let i = 0; i < n; i++) {
          const off = n === 1 ? 0 : (i / (n - 1) - 0.5) * e.spread;
          const a = aim + off + (this.rng() - 0.5) * e.spread * 0.4;
          const drift = (ex.drift || 0) * st.flip;
          // acceleration perpendicular to travel = the visible arc
          const opts = this._base(def, e, player, a, {
            ax: -Math.sin(a) * drift,
            ay: Math.cos(a) * drift,
            knockback: 40 * kb,
            onExpire: ex.shardCount ? {
              count: ex.shardCount,
              damage: (ex.shardDamage || 0) * this.stats('damage'),
              speed: ex.shardSpeed || 180,
              radius: (ex.shardRadius || 4) * this.stats('projectileSize'),
              lifetime: ex.shardLifetime || 0.3,
              pierce: 0,
              kind: 'shard'
            } : undefined
          });
          this._emit(spawn, opts, player);
        }
        break;
      }

      // --- sweep: the aim walks across a cone, shot by shot, then reverses ---
      // extra.wrap = true makes the walk continuous instead of bouncing, which
      // turns the weapon into a never-resetting rotary sprinkler.
      case 'sweep': {
        const half = e.spread / 2;
        st.sweepAngle += (ex.step || 0.3) * st.sweepDir;
        if (ex.wrap) {
          st.sweepAngle = ((st.sweepAngle + Math.PI) % TAU + TAU) % TAU - Math.PI;
        } else {
          if (st.sweepAngle > half) { st.sweepAngle = half; st.sweepDir = -1; }
          if (st.sweepAngle < -half) { st.sweepAngle = -half; st.sweepDir = 1; }
        }
        const a = aim + st.sweepAngle;
        this._emit(spawn, this._base(def, e, player, a, {
          knockback: 25 * kb
        }), player);
        break;
      }

      // --- spear: one slow, heavy, deeply piercing shot ---------------------
      case 'spear': {
        const a = aim + (this.rng() - 0.5) * e.spread;
        this._emit(spawn, this._base(def, e, player, a, {
          damageFalloff: ex.falloff === undefined ? 1 : ex.falloff,
          knockback: 90 * kb
        }), player);
        break;
      }

      // --- cone: a continuous, jittery, short-range wall of air -------------
      case 'cone': {
        const n = Math.max(1, e.count);
        for (let i = 0; i < n; i++) {
          const off = n === 1 ? 0 : (i / (n - 1) - 0.5) * e.spread;
          const a = aim + off + (this.rng() - 0.5) * (ex.jitter || 0);
          const sp = e.speed + (this.rng() - 0.5) * (ex.speedJitter || 0);
          this._emit(spawn, this._base(def, e, player, a, {
            speed: Math.max(20, sp),
            knockback: (ex.knockback || 0) * kb,
            noise: i === 0 ? (ex.noise || 0) * this.stats('noise') : undefined
          }), player);
        }
        break;
      }

      // --- orbit: a ring of swung objects pinned to the player --------------
      case 'orbit': {
        const n = Math.max(1, e.count);
        const spd = ex.orbitSpeed || 4;
        for (let i = 0; i < n; i++) {
          // extra.counterRotate splits the ring into two rings turning against
          // each other, so gaps never line up.
          const inner = ex.counterRotate && (i % 2 === 1);
          const ringR = (ex.orbitRadius || 50) * (inner ? (ex.innerScale || 0.55) : 1);
          const phase = st.orbitPhase + (i / n) * TAU;
          // tangent direction, so a pool that ignores `orbit` still sees motion
          const a = phase + Math.PI / 2;
          this._emit(spawn, this._base(def, e, player, a, {
            x: (player?.x || 0) + Math.cos(phase) * ringR,
            y: (player?.y || 0) + Math.sin(phase) * ringR,
            speed: 0,
            follow: 'player',
            knockback: 160 * kb,
            orbit: {
              radius: ringR * this.stats('projectileSize'),
              angle: phase,
              speed: inner ? -spd : spd,
              hitInterval: ex.hitInterval || 0.35
            }
          }), player);
        }
        st.orbitPhase = (st.orbitPhase + 1.1) % TAU;
        break;
      }

      // --- boomerang: staggered shots that turn around and come home --------
      case 'boomerang': {
        const n = Math.max(1, e.count);
        for (let i = 0; i < n; i++) {
          const off = n === 1 ? 0 : (i / (n - 1) - 0.5) * e.spread;
          const a = aim + off;
          const opts = this._base(def, e, player, a, {
            returnAt: e.lifetime * (ex.turnAt === undefined ? 0.45 : ex.turnAt),
            returnSpeed: ex.returnSpeed || e.speed,
            homeTo: 'player',
            knockback: 50 * kb
          });
          const delay = i * (ex.stagger || 0);
          if (delay > 0) st.queue.push({ at: delay, opts });
          else this._emit(spawn, opts, player);
        }
        break;
      }

      // --- revenant: the Previous Owner's form. Only evolution.js makes one.
      // It borrows a DIFFERENT base pattern every volley, in order, and it
      // fires from where you were standing a moment ago rather than from you.
      // Nothing else in the game does either of those things.
      case 'revenant': {
        const cycle = ex.cycle && ex.cycle.length
          ? ex.cycle
          : ['lob', 'sweep', 'spear', 'cone', 'orbit', 'boomerang'];
        const borrowed = cycle[st.revIndex = ((st.revIndex || 0) + 1) % cycle.length];
        // Ghost muzzle: a trailing echo of the player, if Agent A provides one.
        const ghost = (player && player.trail && player.trail.length)
          ? player.trail[0]
          : { x: (player?.x || 0), y: (player?.y || 0) };
        const proxyPlayer = {
          x: ghost.x, y: ghost.y,
          aimAngle: aim + Math.PI * (ex.lookBack ? 1 : 0)
        };
        const proxyDef = Object.assign({}, def, { pattern: borrowed });
        const proxyExtra = Object.assign({}, ex, ex.perPattern?.[borrowed] || {});
        const proxyE = Object.assign({}, e, { extra: proxyExtra });
        this._fire(proxyDef, proxyE, st, proxyPlayer, (opts) => {
          opts.kind = def.kind;
          opts.weaponId = def.id;
          opts.pattern = 'revenant';
          opts.borrowedPattern = borrowed;
          opts.ghostSourced = true;
          spawn(opts);
        });
        break;
      }

      default: {
        this._emit(spawn, this._base(def, e, player, aim, {}), player);
      }
    }
  }
}

// SELF-TEST:
//   const shots = [];
//   const ws = new WeaponSystem({ rng: seeded(1) });
//   ws.equip('leafblower');
//   for (let i = 0; i < 600; i++) ws.update(1/60, {x:100,y:100,aimAngle:0},
//                                            o => shots.push(o));
//   Expect: shots.length ≈ 10 seconds / cooldown * count, every shot has a unit
//   (dx,dy), and `noise` appears on exactly one puff per volley.
//   Repeat per weapon and compare the signature
//     { rate, avgCount, angleSpread, kinds, hasOrbit, hasReturnAt, hasAx }
//   — all six must differ. Fire with a zero-vector aim and confirm readAim()
//   falls back to straight up rather than emitting a NaN direction.
