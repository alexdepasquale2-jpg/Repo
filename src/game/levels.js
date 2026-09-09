// TIER W · The world. Five hand-crafted levels, each introducing ONE new thing,
// with fungal presence rising measurably level to level (W-N09) so a stranger
// could put screenshots in order.
//
// Every level carries the sealed boss door (W-N11). It never opens. It is the
// strongest piece of the myth layer and it costs almost nothing.

const wall = (x, y, w, h, opts = {}) => ({ x, y, w, h, ...opts });

export const LEVELS = [
  {
    id: 1,
    name: 'The Perimeter',
    subtitle: 'Wide, quiet, and already growing something at the edges.',
    teaches: 'movement, then targeting, then a weapon, then a threat — one at a time',
    bounds: { x: 0, y: 0, w: 2200, h: 1200 },
    fungusLevel: 0.05,
    build(rng) {
      const walls = [
        wall(0, -40, 2200, 40), wall(0, 1200, 2200, 40),
        wall(-40, 0, 40, 1200), wall(2200, 0, 40, 1200),
        wall(520, 0, 40, 420), wall(520, 700, 40, 500),
        wall(1180, 260, 260, 40), wall(1180, 880, 260, 40),
        wall(1700, 380, 40, 460),
      ];
      return {
        walls,
        // P-N03 · the opening 90 seconds: a corridor, a husk, and the weapon
        // you take off it. Salvage is the core verb before a single enemy.
        playerStart: { x: 90, y: 600 },
        husks: [{ x: 320, y: 600, weapon: 'scavenged_blade', gear: [], story: 'Face toward the far door. They were leaving.' }],
        // P-N04 · first target stationary and un-missable, second moving, third a pair.
        spawns: [
          { x: 760, y: 600, type: 'dummy' },
          { x: 1000, y: 480, type: 'rusher' },
          { x: 1520, y: 560, type: 'rusher' }, { x: 1520, y: 680, type: 'rusher' },
          { x: 1960, y: 300, type: 'rusher' }, { x: 1960, y: 900, type: 'ranged' },
        ],
        exit: { x: 2110, y: 600 },
        sealedDoor: { x: 1180, y: 60, w: 90, h: 26 },
        fungusPatches: [{ x: 2050, y: 120, r: 90 }, { x: 2100, y: 1080, r: 70 }],
      };
    },
  },
  {
    id: 2,
    name: 'The Works',
    subtitle: 'Machinery, sightlines, cover. Something is growing on it now.',
    teaches: 'ranged pressure — and cauterize, against fungal terrain',
    bounds: { x: 0, y: 0, w: 2000, h: 1400 },
    fungusLevel: 0.2,
    unlocks: 'cauterize',
    build(rng) {
      const walls = [
        wall(0, -40, 2000, 40), wall(0, 1400, 2000, 40),
        wall(-40, 0, 40, 1400), wall(2000, 0, 40, 1400),
      ];
      // A grid of machine blocks: cover you will use without being told to.
      for (let i = 0; i < 5; i++) {
        for (let j = 0; j < 3; j++) {
          walls.push(wall(340 + i * 320, 260 + j * 400, 150, 130));
        }
      }
      return {
        walls,
        playerStart: { x: 100, y: 700 },
        husks: [
          { x: 620, y: 380, weapon: 'bound_repeater', gear: ['predictive_aim'], story: 'Cover on three sides. It did not matter.' },
          { x: 1500, y: 1050, weapon: null, gear: ['keen_edge'], story: 'Curled around the thing in their hands.' },
        ],
        spawns: [
          { x: 700, y: 700, type: 'ranged' }, { x: 900, y: 300, type: 'ranged' },
          { x: 1200, y: 900, type: 'rusher' }, { x: 1250, y: 1000, type: 'rusher' },
          { x: 1600, y: 400, type: 'ranged' }, { x: 1700, y: 700, type: 'tank' },
          { x: 1850, y: 1150, type: 'rusher' },
        ],
        exit: { x: 1930, y: 700 },
        sealedDoor: { x: 980, y: 60, w: 90, h: 26 },
        fungusPatches: [
          { x: 500, y: 200, r: 130 }, { x: 1400, y: 1200, r: 160 },
          { x: 1750, y: 260, r: 120 },
        ],
      };
    },
  },
  {
    id: 3,
    name: 'The Flooded Tier',
    subtitle: 'Standing water, and the growth likes it.',
    teaches: 'terrain hazard — routing decisions, not damage numbers',
    bounds: { x: 0, y: 0, w: 2000, h: 1500 },
    fungusLevel: 0.4,
    unlocks: 'hook',
    build(rng) {
      const walls = [
        wall(0, -40, 2000, 40), wall(0, 1500, 2000, 40),
        wall(-40, 0, 40, 1500), wall(2000, 0, 40, 1500),
        wall(600, 0, 40, 560), wall(600, 940, 40, 560),
        wall(1300, 300, 40, 900),
      ];
      return {
        walls,
        playerStart: { x: 100, y: 750 },
        // Hazard: slows and rots. Crossing is a choice, not a toll.
        hazards: [
          { x: 700, y: 200, w: 520, h: 380 },
          { x: 700, y: 980, w: 520, h: 420 },
          { x: 1400, y: 560, w: 520, h: 400 },
        ],
        husks: [
          { x: 900, y: 380, weapon: 'reach_glaive', gear: ['steady_hand'], story: 'Halfway across. Nothing chasing them.' },
          { x: 1600, y: 1300, weapon: null, gear: ['threat_sense'], story: 'Sitting upright, facing the way out.' },
        ],
        spawns: [
          { x: 800, y: 750, type: 'rusher' }, { x: 1000, y: 620, type: 'ranged' },
          { x: 1150, y: 900, type: 'tank' }, { x: 1500, y: 400, type: 'rusher' },
          { x: 1600, y: 1100, type: 'ranged' }, { x: 1800, y: 300, type: 'rusher' },
          { x: 1850, y: 800, type: 'tank' },
        ],
        exit: { x: 1930, y: 1400 },
        sealedDoor: { x: 60, y: 60, w: 26, h: 90 },
        fungusPatches: [
          { x: 760, y: 300, r: 180 }, { x: 1000, y: 1200, r: 200 },
          { x: 1700, y: 700, r: 190 }, { x: 300, y: 1300, r: 140 },
        ],
      };
    },
  },
  {
    id: 4,
    name: 'The Nursery',
    subtitle: 'Husks in the walls. This is the last warning.',
    teaches: 'disruptors — target priority stops being optional',
    bounds: { x: 0, y: 0, w: 1800, h: 1600 },
    fungusLevel: 0.7,
    unlocks: 'let_them_loose',
    build(rng) {
      const walls = [
        wall(0, -40, 1800, 40), wall(0, 1600, 1800, 40),
        wall(-40, 0, 40, 1600), wall(1800, 0, 40, 1600),
        wall(400, 300, 40, 500), wall(400, 1000, 40, 400),
        wall(1000, 200, 40, 420), wall(1000, 820, 40, 560),
        wall(440, 300, 260, 40), wall(760, 1360, 280, 40),
      ];
      const husks = [];
      for (let i = 0; i < 9; i++) {
        husks.push({
          x: 200 + (i % 3) * 620 + rng.range(-40, 40),
          y: 240 + Math.floor(i / 3) * 480 + rng.range(-40, 40),
          weapon: rng.pick(['scavenged_blade', 'reach_glaive', 'rot_lance', null]),
          gear: [rng.pick(['keen_edge', 'steady_hand', 'reactive_block', 'auto_retarget'])],
          story: 'Fused into the wall. Still equipped.',
        });
      }
      return {
        walls, husks,
        playerStart: { x: 100, y: 800 },
        spawns: [
          { x: 600, y: 500, type: 'disruptor' }, { x: 700, y: 900, type: 'rusher' },
          { x: 750, y: 1000, type: 'rusher' }, { x: 1200, y: 400, type: 'disruptor' },
          { x: 1250, y: 700, type: 'tank' }, { x: 1400, y: 1100, type: 'ranged' },
          { x: 1500, y: 1300, type: 'rusher' }, { x: 1600, y: 300, type: 'ranged' },
          { x: 900, y: 1450, type: 'tank' },
        ],
        exit: { x: 1730, y: 800 },
        sealedDoor: { x: 1720, y: 60, w: 26, h: 90 },
        fungusPatches: [
          { x: 500, y: 400, r: 260 }, { x: 1100, y: 1100, r: 300 },
          { x: 1500, y: 500, r: 240 }, { x: 300, y: 1300, r: 220 },
        ],
      };
    },
  },
  {
    id: 5,
    name: 'The Outer Grounds',
    subtitle: 'Open ground, and everything on it keeps coming back.',
    teaches: 'nothing new. It asks you to be ready.',
    bounds: { x: 0, y: 0, w: 3600, h: 2600 },
    fungusLevel: 0.85,
    // The one place in the run that is not a corridor. Enemies here are not a
    // fixed set to be cleared — camps refill, patrols wander, and the way down
    // stays shut until you are LEVEL_FOR_THRONE. This is where the run-up stops
    // being a tutorial and becomes a place you have to survive in.
    openWorld: true,
    build(rng) {
      const walls = [
        wall(0, -40, 3600, 40), wall(0, 2600, 3600, 40),
        wall(-40, 0, 40, 2600), wall(3600, 0, 40, 2600),
      ];
      // Scattered ruin. Enough cover to fight around, never enough to funnel.
      const ruins = [
        [430, 380, 220, 60], [520, 380, 60, 300], [980, 240, 60, 340],
        [1240, 620, 300, 60], [760, 900, 60, 300], [1500, 300, 60, 280],
        [1850, 780, 260, 60], [2260, 380, 60, 340], [2600, 620, 300, 60],
        [3020, 300, 60, 320], [2900, 980, 240, 60], [420, 1400, 60, 320],
        [700, 1700, 300, 60], [1180, 1500, 60, 300], [1500, 1900, 280, 60],
        [1980, 1400, 60, 320], [2300, 1700, 300, 60], [2760, 1500, 60, 300],
        [3080, 1850, 240, 60], [900, 2200, 300, 60], [1700, 2280, 60, 240],
        [2500, 2200, 300, 60],
      ];
      for (const [x, y, w, h] of ruins) walls.push(wall(x, y, w, h));

      // Camps hold territory. Each one refills on its own clock, so clearing a
      // camp buys you a window, not a permanent gain (the same lesson the
      // network teaches later with scars and regrowth).
      const camps = [
        { x: 700, y: 500, radius: 190, max: 4, respawn: 11, types: ['rusher', 'rusher', 'ranged'] },
        { x: 1750, y: 420, radius: 210, max: 4, respawn: 12, types: ['ranged', 'rusher', 'tank'] },
        { x: 2900, y: 700, radius: 200, max: 4, respawn: 12, types: ['rusher', 'tank', 'ranged'] },
        { x: 900, y: 1750, radius: 220, max: 5, respawn: 10, types: ['rusher', 'rusher', 'disruptor'] },
        { x: 2050, y: 1650, radius: 220, max: 5, respawn: 11, types: ['ranged', 'disruptor', 'tank'] },
        { x: 3050, y: 1950, radius: 200, max: 4, respawn: 13, types: ['tank', 'disruptor', 'rusher'] },
        { x: 1600, y: 2350, radius: 190, max: 4, respawn: 12, types: ['rusher', 'ranged', 'rusher'] },
      ];

      const husks = [];
      for (let i = 0; i < 7; i++) {
        husks.push({
          x: rng.range(300, 3300), y: rng.range(300, 2300),
          weapon: rng.pick(['reach_glaive', 'cleaver', 'bound_repeater', 'rot_lance', null]),
          gear: [rng.pick(['keen_edge', 'steady_hand', 'threat_sense', 'scavenger', 'predictive_aim', 'reactive_block'])],
          story: 'Out in the open. Whatever found them, it was not in a hurry.',
        });
      }

      return {
        walls, camps, husks,
        playerStart: { x: 160, y: 1300 },
        // Fixed patrols on top of the camps, so the ground between camps is
        // never actually empty.
        spawns: [
          { x: 1300, y: 1100, type: 'rusher' }, { x: 1450, y: 1250, type: 'ranged' },
          { x: 2400, y: 1150, type: 'tank' }, { x: 2650, y: 1350, type: 'rusher' },
          { x: 1900, y: 2050, type: 'disruptor' }, { x: 620, y: 1050, type: 'rusher' },
        ],
        // The way down. Sealed until you are ready for what is behind it.
        exit: { x: 3420, y: 1300 },
        sealedDoor: { x: 3480, y: 1240, w: 26, h: 120 },
        fungusPatches: [
          { x: 700, y: 520, r: 260 }, { x: 1780, y: 460, r: 280 },
          { x: 2920, y: 720, r: 250 }, { x: 950, y: 1780, r: 300 },
          { x: 2080, y: 1680, r: 300 }, { x: 3080, y: 1980, r: 260 },
          { x: 1620, y: 2360, r: 240 }, { x: 3300, y: 1300, r: 320 },
        ],
      };
    },
  },
  {
    id: 6,
    name: 'The Throne Room',
    subtitle: 'The door behind you closes. The chair is not locked.',
    teaches: 'nothing. It asks.',
    bounds: { x: 0, y: 0, w: 1700, h: 1400 },
    fungusLevel: 1,
    isThroneRoom: true,
    build(rng) {
      // W-N08 · built around the network: anchors, chokepoints, sightlines that
      // reward stepping off the fungus, and enough open floor for the alternate
      // exit to be conceivable.
      const walls = [
        wall(0, -40, 1700, 40), wall(0, 1400, 1700, 40),
        wall(-40, 0, 40, 1400), wall(1700, 0, 40, 1400),
        // Four pillars: line attacks are avoidable, and you can break sight.
        wall(430, 380, 90, 90), wall(1180, 380, 90, 90),
        wall(430, 930, 90, 90), wall(1180, 930, 90, 90),
        // Flanking spurs, so clearing has a shape.
        wall(760, 140, 40, 190), wall(900, 1070, 40, 190),
      ];
      const husks = [];
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        husks.push({
          x: 850 + Math.cos(a) * 470,
          y: 700 + Math.sin(a) * 400,
          weapon: rng.pick(['reach_glaive', 'cleaver', 'bound_repeater', 'rot_lance']),
          gear: [rng.pick(['auto_retarget', 'reactive_block', 'swarm_choir', 'last_resort', 'predictive_aim'])],
          story: 'They sat. This is what sitting looks like from outside.',
          // T6-N06 · the node layout is literally built on the dead.
          isAnchor: true,
        });
      }
      return {
        walls, husks,
        playerStart: { x: 850, y: 1280 },
        throne: { x: 850, y: 700 },
        spawns: [],
        exit: null,               // sealed until someone sits (T2-N15)
        sealedDoor: { x: 805, y: 60, w: 90, h: 26 },
        fungusPatches: [],
      };
    },
  },
];

// The way into the throne room does not open on a body count. It opens when you
// are strong enough that sitting down is a real decision rather than a mistake
// you were always going to make.
export const LEVEL_FOR_THRONE = 5;

// T4-N04 · elites are modifier-based, not bespoke. Adding one is a data change.
export const ELITE = {
  namePrefix: 'Ripened ',
  hp: 2.3,
  damage: 1.45,
  speed: 1.08,
  radiusBonus: 4,
  xp: 2.6,
  salvage: 2.8,
  color: '#d08a4a',
};

export const ENEMY_TYPES = {
  // T4-N02 · each archetype punishes a different mistake.
  dummy:     { name: 'Rooted Thing', hp: 60,  weapon: 'scavenged_blade', speed: 0,   xp: 8, salvage: 6,  color: '#7c6f5a', radius: 15, aggroRadius: 0 },
  rusher:    { name: 'Crawler',      hp: 74,  weapon: 'scavenged_blade', speed: 205, xp: 12, salvage: 9,  color: '#a8523f', radius: 13 },
  ranged:    { name: 'Spitter',      hp: 58,  weapon: 'rot_lance',       speed: 150, xp: 14, salvage: 11, color: '#6d8a4a', radius: 12 },
  tank:      { name: 'Bulwark',      hp: 210, weapon: 'cleaver',         speed: 118, xp: 22, salvage: 18, color: '#5c6470', radius: 19, mass: 2.4 },
  disruptor: { name: 'Chanter',      hp: 92,  weapon: 'rot_lance',       speed: 168, xp: 26, salvage: 22, color: '#9a6cb0', radius: 14, disruptor: true },
};
