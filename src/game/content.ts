import type { PipelineId } from '../ai/registry';

/* --------------------------------------------------------------- elements -- */

/**
 * Elements exist as *text*, because Divination decides which one an enemy
 * resonates with by embedding these descriptions and the enemy's essence and
 * taking the closest pair. The prose is the game data — rewording an element
 * genuinely changes which enemies it matches.
 */
export interface Element {
  id: string;
  name: string;
  glyph: string;
  color: string;
  /** Embedded verbatim by Divination. */
  description: string;
}

export const ELEMENTS: readonly Element[] = [
  {
    id: 'ember',
    name: 'Ember',
    glyph: '✦',
    color: '#ff8c42',
    description: 'fire, heat, burning flame, smoke, ash and cinders, scorching light',
  },
  {
    id: 'frost',
    name: 'Frost',
    glyph: '❋',
    color: '#7ec8ff',
    description: 'ice, bitter cold, freezing snow, frost and glaciers, winter stillness',
  },
  {
    id: 'static',
    name: 'Static',
    glyph: '⌁',
    color: '#ffd166',
    description: 'lightning, electricity, thunder and sparks, crackling current, charge',
  },
  {
    id: 'void',
    name: 'Void',
    glyph: '◈',
    color: '#b58cff',
    description: 'darkness, shadow and emptiness, silence, decay, the space between stars',
  },
  {
    id: 'bloom',
    name: 'Bloom',
    glyph: '❀',
    color: '#5fdc9a',
    description: 'plants and vines, green growth, forest and root, living flesh, healing',
  },
];

export const ELEMENT_BY_ID = new Map(ELEMENTS.map((e) => [e.id, e]));

/** Damage multiplier for striking an enemy with the element it resonates with. */
export const RESONANCE_MULTIPLIER = 2.5;

/* ---------------------------------------------------------------- enemies -- */

export interface Archetype {
  id: string;
  name: string;
  /** Embedded by Resonance and Divination. Flavour text that is also game data. */
  essence: string;
}

/**
 * Archetypes cycle as the player descends. `essence` is written to sit clearly
 * inside one element's semantic neighbourhood, so Divination's answer feels
 * earned rather than arbitrary.
 */
export const ARCHETYPES: readonly Archetype[] = [
  { id: 'cinder-wraith', name: 'Cinder Wraith', essence: 'a burning spirit wreathed in flame, trailing smoke and glowing ash' },
  { id: 'rime-hound', name: 'Rime Hound', essence: 'a beast of frozen ice and snow, breathing bitter cold and winter air' },
  { id: 'arc-sentinel', name: 'Arc Sentinel', essence: 'a construct crackling with lightning and electric current, sparking thunder' },
  { id: 'null-shade', name: 'Null Shade', essence: 'a hollow shadow of pure darkness and empty silence, devouring light' },
  { id: 'thorn-warden', name: 'Thorn Warden', essence: 'a guardian of tangled vines and green roots, overgrown with living leaves' },
  { id: 'slag-colossus', name: 'Slag Colossus', essence: 'a molten giant of magma and furnace heat, cracked with scorching fire' },
  { id: 'glacier-maw', name: 'Glacier Maw', essence: 'a vast frozen jaw of glacial ice, chilling and numb with deep frost' },
  { id: 'storm-herald', name: 'Storm Herald', essence: 'a howling figure of storm and static charge, wreathed in lightning bolts' },
  { id: 'entropy-priest', name: 'Entropy Priest', essence: 'a decaying figure of rot and void, whispering from the empty dark' },
  { id: 'spore-titan', name: 'Spore Titan', essence: 'a swollen mass of fungus and blooming growth, sprouting roots and flesh' },
];

/** Boss layers land every `BOSS_INTERVAL` layers. */
export const BOSS_INTERVAL = 5;

export function isBossLayer(layer: number): boolean {
  return layer % BOSS_INTERVAL === 0;
}

export function archetypeFor(layer: number): Archetype {
  return ARCHETYPES[(layer - 1) % ARCHETYPES.length]!;
}

/** Enemies per layer. Bosses are a single, much tougher fight. */
export function killsToClear(layer: number): number {
  return isBossLayer(layer) ? 1 : 8;
}

export function enemyHp(layer: number): number {
  const base = 12 * 1.19 ** (layer - 1);
  return isBossLayer(layer) ? base * 9 : base;
}

export function enemyReward(layer: number): number {
  const base = 3 * 1.16 ** (layer - 1);
  return isBossLayer(layer) ? base * 12 : base;
}

/** Seconds allowed to fell a boss before being pushed back a layer. */
export const BOSS_TIMER = 30;

/* ---------------------------------------------------------------- daemons -- */

export interface DaemonSpec {
  id: string;
  name: string;
  blurb: string;
  baseCost: number;
  costGrowth: number;
  /** Damage per second per copy, before multipliers. */
  baseDps: number;
}

export const DAEMONS: readonly DaemonSpec[] = [
  { id: 'wisp', name: 'Gradient Wisp', blurb: 'Drifts downhill, nibbling at loss.', baseCost: 15, costGrowth: 1.12, baseDps: 1 },
  { id: 'hound', name: 'Tensor Hound', blurb: 'Chases anything with a shape.', baseCost: 220, costGrowth: 1.13, baseDps: 9 },
  { id: 'head', name: 'Attention Head', blurb: 'Only ever looks at what matters.', baseCost: 3_400, costGrowth: 1.14, baseDps: 68 },
  { id: 'golem', name: 'Residual Golem', blurb: 'Never forgets what it was given.', baseCost: 52_000, costGrowth: 1.15, baseDps: 520 },
  { id: 'seraph', name: 'Latent Seraph', blurb: 'Sings in a space you cannot picture.', baseCost: 800_000, costGrowth: 1.16, baseDps: 4_200 },
  { id: 'titan', name: 'Optimizer Titan', blurb: 'Descends. Converges. Repeats.', baseCost: 13_000_000, costGrowth: 1.17, baseDps: 36_000 },
];

/* -------------------------------------------------------------- abilities -- */

export interface AbilitySpec {
  id: string;
  name: string;
  /** Which pipeline this ability loads. Several abilities may share one. */
  pipeline: PipelineId;
  /** Weights price to unlock. Correlated with the model's download size. */
  cost: number;
  /** What it does mechanically, in one line. */
  effect: string;
  /** In-fiction description. */
  flavor: string;
}

export const ABILITIES: readonly AbilitySpec[] = [
  {
    id: 'divination',
    name: 'Divination',
    pipeline: 'embed',
    cost: 5_000,
    effect: `Reads each enemy's resonant element. Striking with it deals ${RESONANCE_MULTIPLIER}x damage.`,
    flavor: 'You learn to read a thing by the shape of the space around it.',
  },
  {
    id: 'resonance',
    name: 'Resonance',
    pipeline: 'embed',
    cost: 40_000,
    effect: 'Bind a sigil phrase. The closer its meaning to the enemy, the higher your crit chance.',
    flavor: 'Name a thing precisely enough and it opens for you.',
  },
  {
    id: 'attunement',
    name: 'Attunement',
    pipeline: 'sentiment',
    cost: 250_000,
    effect: 'Shout a battle cry. Its sentiment becomes a timed buff — Fervour or Dread.',
    flavor: 'The depths do not care what you say, only how you mean it.',
  },
  {
    id: 'chronicle',
    name: 'Chronicle',
    pipeline: 'generate',
    cost: 2_000_000,
    effect: 'Bosses drop relics, each named on the spot and rolling a permanent modifier.',
    flavor: 'Something down here is writing all of this down.',
  },
];

export const ABILITY_BY_ID = new Map(ABILITIES.map((a) => [a.id, a]));

/* -------------------------------------------------------------- upgrades --- */

export const FOCUS = { baseCost: 10, costGrowth: 1.13, damagePerLevel: 1 };

/** Insight (prestige currency) multiplies all damage. */
export function insightMultiplier(insight: number): number {
  return 1 + insight * 0.25;
}

/**
 * Insight granted for retiring a run. Sub-linear in depth so a deep run is
 * worth more but never trivialises the next one.
 */
export function insightFor(deepestLayer: number): number {
  if (deepestLayer < 10) return 0;
  return Math.floor((deepestLayer - 5) ** 0.75 / 2);
}
