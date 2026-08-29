// src/data/passives.js
// ---------------------------------------------------------------------------
// The "vices" — passive mods offered on level-up. PURE DATA. No imports.
//
// Owner: Agent B (Progression).
//
// HARD RULE: `name` and `desc` are player-facing and contain NO DIGITS and no
// numeric words of any kind. A vice is described by what it feels like, never
// by what it does arithmetically. The player infers the maths from play.
//
// PassiveDef shape:
// {
//   id:       String                  unique key
//   name:     String                  display name (no digits)
//   desc:     String                  display description (no digits)
//   rarity:   0|1|2|3                 0 common .. 3 rare; drives offer weighting
//   maxRank:  Number                  how many times it can be taken
//   mods:     { [stat]: Number }      PER RANK multiplier; ranks compound
//                                     (rank r applies mods[stat] ** r)
//   flags:    String[]                behaviour switches read by other systems
//   vice:     Boolean                 true if it carries a real downside
// }
//
// STATS (all default to a multiplier of one; Agent A applies them):
//   damage         outgoing projectile damage
//   fireRate       volleys per second (higher = faster)
//   spread         volley arc width (higher = sloppier aim)
//   projectileSize projectile collision radius
//   projectileSpeed
//   pierce         enemies passed through
//   moveSpeed      player movement
//   maxHp
//   armor          incoming damage taken (LOWER is better)
//   pickupRadius
//   xpGain
//   luck           loot rarity roll bias
//   noise          how loud the run reads to the neighbours (LOWER is quieter)
//   regen          passive health regeneration
//   cooldown       ability recharge time (LOWER is better)
//   critChance
//   critDamage
//   knockback
//
// FLAGS consumed elsewhere:
//   'playDead'      grants a periodic invulnerability window on damage
//   'hoard'         items linger far longer before despawning
//   'curtain'       reveals off-screen threats to the UI layer
//   'thorns'        reflects a share of contact damage
//   'lastCall'      big damage spike while below a low health fraction
//   'shatterHeal'   rare heal on kill
//   'sleepwalk'     movement continues briefly after input stops
//   'echo'          a share of volleys fire a second, weaker time
//   'debtSpiral'    converts leftover Debt into damage between waves
//   'hauntStack'    Previous-Owner attunement; gates the strangest evolution
// ---------------------------------------------------------------------------

export const PASSIVES = [
  // ---- rarity 0: common, mostly clean upgrades -----------------------------
  {
    id: 'steadier_hands',
    name: 'Steadier Hands',
    desc: 'Steadier hands than yesterday. Not steady. Steadier.',
    rarity: 0, maxRank: 5, vice: false,
    mods: { spread: 0.86, damage: 1.04 }, flags: []
  },
  {
    id: 'second_wind',
    name: 'Second Wind',
    desc: 'You have found the part of the evening where standing up is easier.',
    rarity: 0, maxRank: 5, vice: false,
    mods: { maxHp: 1.12, regen: 1.2 }, flags: []
  },
  {
    id: 'porch_light',
    name: 'Porch Light',
    desc: 'Something is on out there, and things come to it.',
    rarity: 0, maxRank: 4, vice: false,
    mods: { pickupRadius: 1.3, xpGain: 1.06 }, flags: []
  },
  {
    id: 'restless_legs',
    name: 'Restless Legs',
    desc: 'Sitting still has stopped being an option.',
    rarity: 0, maxRank: 5, vice: false,
    mods: { moveSpeed: 1.08 }, flags: []
  },
  {
    id: 'spite',
    name: 'Spite',
    desc: 'A small, warm engine that runs on other people.',
    rarity: 0, maxRank: 5, vice: false,
    mods: { damage: 1.08 }, flags: []
  },
  {
    id: 'twitchy_trigger',
    name: 'Twitchy Trigger',
    desc: 'You keep going before you have decided to.',
    rarity: 0, maxRank: 5, vice: true,
    mods: { fireRate: 1.11, spread: 1.09 }, flags: []
  },
  {
    id: 'garage_clutter',
    name: 'Garage Clutter',
    desc: 'Everything you throw is heavier than it looks.',
    rarity: 0, maxRank: 4, vice: true,
    mods: { projectileSize: 1.14, projectileSpeed: 0.93 }, flags: []
  },

  // ---- rarity 1: uncommon, sharper tradeoffs -------------------------------
  {
    id: 'day_drinking',
    name: 'Day Drinking',
    desc: 'Everything hits harder, including the ground when it comes up.',
    rarity: 1, maxRank: 4, vice: true,
    mods: { damage: 1.22, spread: 1.28, moveSpeed: 0.96 }, flags: []
  },
  {
    id: 'hoarding',
    name: 'Hoarding',
    desc: 'Nothing on this lawn is garbage. Nothing has ever been garbage.',
    rarity: 1, maxRank: 3, vice: true,
    mods: { luck: 1.18, moveSpeed: 0.95 }, flags: ['hoard']
  },
  {
    id: 'curtain_twitching',
    name: 'Curtain Twitching',
    desc: 'You see them coming long before they arrive. You also never rest.',
    rarity: 1, maxRank: 3, vice: true,
    mods: { pickupRadius: 1.15, regen: 0.8 }, flags: ['curtain']
  },
  {
    id: 'thick_skin',
    name: 'Thick Skin',
    desc: 'Years of being talked about have left a callus.',
    rarity: 1, maxRank: 4, vice: false,
    mods: { armor: 0.9 }, flags: []
  },
  {
    id: 'grudge_ledger',
    name: 'Grudge Ledger',
    desc: 'You remember every slight, and the memory sharpens the swing.',
    rarity: 1, maxRank: 4, vice: false,
    mods: { critChance: 1.25, critDamage: 1.08 }, flags: []
  },
  {
    id: 'quiet_shoes',
    name: 'Quiet Shoes',
    desc: 'The street sleeps through you. You get less credit for the work.',
    rarity: 1, maxRank: 3, vice: true,
    mods: { noise: 0.7, xpGain: 0.94 }, flags: []
  },
  {
    id: 'loud_neighbour',
    name: 'Loud Neighbour',
    desc: 'Let them hear it. Let them all hear it.',
    rarity: 1, maxRank: 3, vice: true,
    mods: { noise: 1.45, damage: 1.14, xpGain: 1.1 }, flags: []
  },
  {
    id: 'lawn_chemicals',
    name: 'Lawn Chemicals',
    desc: 'The grass has never looked better. You have never felt worse.',
    rarity: 1, maxRank: 4, vice: true,
    mods: { damage: 1.16, maxHp: 0.94 }, flags: []
  },
  {
    id: 'borrowed_tools',
    name: 'Borrowed Tools',
    desc: 'They were going to lend them eventually.',
    rarity: 1, maxRank: 3, vice: true,
    mods: { fireRate: 1.15, luck: 0.92 }, flags: []
  },
  {
    id: 'sleepwalking',
    name: 'Sleepwalking',
    desc: 'You keep drifting after you have stopped meaning to.',
    rarity: 1, maxRank: 3, vice: true,
    mods: { moveSpeed: 1.14, armor: 1.06 }, flags: ['sleepwalk']
  },
  {
    id: 'pettiness',
    name: 'Pettiness',
    desc: 'Small things, thrown often, in an ungenerous arc.',
    rarity: 1, maxRank: 4, vice: true,
    mods: { fireRate: 1.18, damage: 0.93, projectileSize: 0.92 }, flags: []
  },

  // ---- rarity 2: strong, defining ------------------------------------------
  {
    id: 'playing_dead',
    name: 'Playing Dead',
    desc: 'An old trick. Go limp and let the evening pass over you.',
    rarity: 2, maxRank: 3, vice: false,
    mods: { cooldown: 0.85 }, flags: ['playDead']
  },
  {
    id: 'last_call',
    name: 'Last Call',
    desc: 'Whatever is left in the glass goes down all at once.',
    rarity: 2, maxRank: 3, vice: true,
    mods: { damage: 1.1, maxHp: 0.9 }, flags: ['lastCall']
  },
  {
    id: 'bad_wiring',
    name: 'Bad Wiring',
    desc: 'The whole house flickers when you swing. So do you.',
    rarity: 2, maxRank: 3, vice: true,
    mods: { fireRate: 1.2, armor: 1.12 }, flags: ['echo']
  },
  {
    id: 'chain_link',
    name: 'Chain Link',
    desc: 'Whatever leans on the fence gets the fence back.',
    rarity: 2, maxRank: 3, vice: false,
    mods: { armor: 0.95, knockback: 1.2 }, flags: ['thorns']
  },
  {
    id: 'trash_day_instinct',
    name: 'Trash Day Instinct',
    desc: 'You know exactly when to drag it all to the curb.',
    rarity: 2, maxRank: 3, vice: false,
    mods: { luck: 1.28, pickupRadius: 1.2 }, flags: []
  },
  {
    id: 'gutter_ball',
    name: 'Gutter Ball',
    desc: 'It goes through. It keeps going through. It does not aim.',
    rarity: 2, maxRank: 3, vice: true,
    mods: { pierce: 1.5, spread: 1.22 }, flags: []
  },
  {
    id: 'possum_metabolism',
    name: 'Possum Metabolism',
    desc: 'You mend on garbage and bad sleep, and you mend fast.',
    rarity: 2, maxRank: 3, vice: false,
    mods: { regen: 1.6 }, flags: ['shatterHeal']
  },

  // ---- rarity 3: rare, strange ---------------------------------------------
  {
    id: 'debt_spiral',
    name: 'Debt Spiral',
    desc: 'What you owe is heavy, and heavy things swing well.',
    rarity: 3, maxRank: 2, vice: true,
    mods: { damage: 1.3, luck: 0.85 }, flags: ['debtSpiral']
  },
  {
    id: 'previous_tenancy',
    name: 'Previous Tenancy',
    desc: 'The house remembers a different shape standing where you stand.',
    rarity: 3, maxRank: 3, vice: true,
    mods: { damage: 1.12, maxHp: 0.95, noise: 0.8 }, flags: ['hauntStack']
  },
  {
    id: 'unopened_mail',
    name: 'Unopened Mail',
    desc: 'It stacks up. It stops meaning anything. It gets very hard to move.',
    rarity: 3, maxRank: 2, vice: true,
    mods: { maxHp: 1.35, moveSpeed: 0.88, pickupRadius: 1.2 }, flags: []
  },
  {
    id: 'hoa_violation',
    name: 'Standing Violation',
    desc: 'There is a notice on your door and it has made you fearless.',
    rarity: 3, maxRank: 2, vice: true,
    mods: { damage: 1.25, fireRate: 1.15, noise: 1.5, armor: 1.1 }, flags: []
  }
];

export const PASSIVES_BY_ID = Object.fromEntries(PASSIVES.map((p) => [p.id, p]));

// Offer weighting by rarity tier. Index = rarity.
export const RARITY_WEIGHTS = [100, 52, 22, 7];

// Rarity weight drift per player level — rarer vices get likelier late.
export const RARITY_LEVEL_DRIFT = [-0.9, 0.15, 0.5, 0.32];

// SELF-TEST:
//   node -e "import('./src/data/passives.js').then(m=>{
//     console.log(m.PASSIVES.length >= 22);
//     console.log(m.PASSIVES.every(p=>!/[0-9]/.test(p.name + p.desc)));
//     console.log(new Set(m.PASSIVES.map(p=>p.id)).size === m.PASSIVES.length);
//     console.log(m.PASSIVES.filter(p=>p.vice).length >= 8);
//   })"
//   Expect four `true` lines: enough vices, zero digits in display strings,
//   unique ids, and a real share carrying downsides.
