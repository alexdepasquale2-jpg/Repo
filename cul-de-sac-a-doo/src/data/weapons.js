// src/data/weapons.js
// ---------------------------------------------------------------------------
// Weapon balance data for Cul-de-Sac-a-Doo. PURE DATA. No logic, no imports.
//
// Owner: Agent B (Progression).
// All tuning numbers live here. src/systems/weapons.js consumes them.
//
// IMPORTANT: every player-facing string (`name`, `blurb`) contains NO DIGITS.
// The game renders no numbers, ever.
//
// WeaponDef shape:
// {
//   id:         String            unique key
//   name:       String            display name (no digits)
//   blurb:      String            flavour line (no digits)
//   pattern:    String            one of the PATTERNS below; picks the firing routine
//   cooldown:   Number            seconds between volleys
//   count:      Number            projectiles per volley
//   spread:     Number            total arc of the volley, radians
//   damage:     Number            per-projectile damage
//   speed:      Number            world px/sec
//   radius:     Number            projectile collision radius, px
//   pierce:     Number            enemies passed through before expiring
//   lifetime:   Number            seconds before the projectile despawns
//   kind:       String            render/behaviour tag handed to Agent A's pool
//   extra:      Object            pattern-specific tuning (see PATTERNS)
// }
//
// PATTERNS (each is a genuinely different firing routine, see weapons.js):
//   'lob'       – arcing throw toward nearest-aim, gravity-ish drift, shatters on expiry
//   'sweep'     – fast whip that rotates its aim back and forth across a cone each shot
//   'spear'     – slow, heavy, high-pierce single shot along the aim vector
//   'cone'      – continuous wide spray of short-lived, randomly-jittered puffs
//   'orbit'     – projectiles pinned in a rotating ring around the player (no travel)
//   'boomerang' – outbound shots that reverse and return to the player mid-flight
// ---------------------------------------------------------------------------

export const PATTERNS = ['lob', 'sweep', 'spear', 'cone', 'orbit', 'boomerang'];

export const WEAPONS = [
  {
    id: 'bottle',
    name: 'Thrown Bottle',
    pattern: 'lob',
    blurb: 'It was empty anyway. Mostly empty. Empty enough.',
    cooldown: 0.85,
    count: 1,
    spread: 0.18,
    damage: 14,
    speed: 240,
    radius: 7,
    pierce: 0,
    lifetime: 0.62,
    kind: 'bottle',
    extra: {
      // arc: sideways drift added per second, alternating sign per throw
      drift: 130,
      // shards spawned when the bottle expires
      shardCount: 4,
      shardDamage: 6,
      shardSpeed: 190,
      shardLifetime: 0.3,
      shardRadius: 4
    }
  },
  {
    id: 'hose',
    name: 'Hose Whip',
    pattern: 'sweep',
    blurb: 'Still hooked to the spigot. That has never stopped anyone.',
    cooldown: 0.16,
    count: 1,
    spread: 1.5, // the full arc the whip sweeps across, shot by shot
    damage: 5,
    speed: 430,
    radius: 6,
    pierce: 2,
    lifetime: 0.26,
    kind: 'water',
    extra: {
      // radians the aim advances each shot; sign flips at the arc edges
      step: 0.3
    }
  },
  {
    id: 'lawndart',
    name: 'Lawn Dart',
    pattern: 'spear',
    blurb: 'Banned for a reason. Kept for the same reason.',
    cooldown: 1.5,
    count: 1,
    spread: 0,
    damage: 46,
    speed: 300,
    radius: 9,
    pierce: 6,
    lifetime: 1.4,
    kind: 'dart',
    extra: {
      // damage retained per enemy pierced
      falloff: 0.85
    }
  },
  {
    id: 'leafblower',
    name: 'Leaf Blower',
    pattern: 'cone',
    blurb: 'Loud enough that the neighbours will remember it.',
    cooldown: 0.07,
    count: 3,
    spread: 1.05,
    damage: 2.4,
    speed: 320,
    radius: 8,
    pierce: 3,
    lifetime: 0.22,
    kind: 'gust',
    extra: {
      jitter: 0.22,   // extra random angle per puff, radians
      speedJitter: 90,
      knockback: 140, // px/sec shove applied by Agent A on hit
      noise: 2.2      // noise added to the run summary per volley
    }
  },
  {
    id: 'mailbox',
    name: 'Mailbox Bat',
    pattern: 'orbit',
    blurb: 'Torn off its post. The post did not survive either.',
    cooldown: 2.4,
    count: 2,
    spread: 0,
    damage: 20,
    speed: 0,
    radius: 15,
    pierce: 99,
    lifetime: 1.6,
    kind: 'bat',
    extra: {
      orbitRadius: 62,
      orbitSpeed: 5.2, // radians/sec
      hitInterval: 0.35
    }
  },
  {
    id: 'romancandle',
    name: 'Roman Candle',
    pattern: 'boomerang',
    blurb: 'Left over from a holiday nobody around here celebrates properly.',
    cooldown: 1.15,
    count: 3,
    spread: 0.7,
    damage: 11,
    speed: 350,
    radius: 7,
    pierce: 2,
    lifetime: 1.5,
    kind: 'ember',
    extra: {
      // fraction of lifetime spent flying out before the return leg
      turnAt: 0.45,
      returnSpeed: 420,
      // seconds between each of the volley's shots leaving the barrel
      stagger: 0.09
    }
  }
];

export const WEAPONS_BY_ID = Object.fromEntries(WEAPONS.map((w) => [w.id, w]));

export const DEFAULT_WEAPON_ID = 'bottle';

// SELF-TEST:
//   node -e "import('./src/data/weapons.js').then(m=>{
//     console.log(m.WEAPONS.length === 6, new Set(m.WEAPONS.map(w=>w.pattern)).size === 6);
//     console.log(m.WEAPONS.every(w=>!/[0-9]/.test(w.name + w.blurb)));
//   })"
//   Expect: true true / true. Six weapons, six distinct patterns, no digits in
//   any display string.
