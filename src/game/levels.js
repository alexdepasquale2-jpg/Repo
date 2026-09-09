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

export const ENEMY_TYPES = {
  // T4-N02 · each archetype punishes a different mistake.
  dummy:     { name: 'Rooted Thing', hp: 60,  weapon: 'scavenged_blade', speed: 0,   xp: 12, salvage: 6,  color: '#7c6f5a', radius: 15, aggroRadius: 0 },
  rusher:    { name: 'Crawler',      hp: 74,  weapon: 'scavenged_blade', speed: 205, xp: 18, salvage: 9,  color: '#a8523f', radius: 13 },
  ranged:    { name: 'Spitter',      hp: 58,  weapon: 'rot_lance',       speed: 150, xp: 22, salvage: 11, color: '#6d8a4a', radius: 12 },
  tank:      { name: 'Bulwark',      hp: 210, weapon: 'cleaver',         speed: 118, xp: 34, salvage: 18, color: '#5c6470', radius: 19, mass: 2.4 },
  disruptor: { name: 'Chanter',      hp: 92,  weapon: 'rot_lance',       speed: 168, xp: 40, salvage: 22, color: '#9a6cb0', radius: 14, disruptor: true },
};
