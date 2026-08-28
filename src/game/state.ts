export interface Relic {
  id: string;
  name: string;
  /** Which multiplier this relic feeds. */
  mod: 'damage' | 'weights' | 'idle';
  /** Additive contribution, e.g. 0.15 for +15%. */
  value: number;
}

export const SAVE_VERSION = 1;

export interface SaveState {
  version: number;

  weights: number;
  lifetimeWeights: number;
  insight: number;

  layer: number;
  deepestLayer: number;
  killsThisLayer: number;

  focusLevel: number;
  daemons: Record<string, number>;

  /** Ability ids the player has paid for. */
  unlocked: string[];

  /** Divination's answers, cached so they survive reloads before the model is back. */
  resonance: Record<string, string>;

  /**
   * Resonance's answers, per archetype, for the sigil named in `affinitySigil`.
   *
   * Persisted for the same reason as `resonance`: a model answer that cannot
   * change is worth more on disk than in a session. It means the crit mechanic
   * keeps working for enemies already seen even after the budget evicts the
   * embedding model, or across a cold launch offline.
   */
  affinities: Record<string, number>;
  /** Which sigil `affinities` was computed for; a change invalidates them all. */
  affinitySigil: string;

  sigil: string;
  cry: string;
  relics: Relic[];

  /** Epoch ms, for offline progress. */
  lastSeen: number;
}

export function initialState(): SaveState {
  return {
    version: SAVE_VERSION,
    weights: 0,
    lifetimeWeights: 0,
    insight: 0,
    layer: 1,
    deepestLayer: 1,
    killsThisLayer: 0,
    focusLevel: 0,
    daemons: {},
    unlocked: [],
    resonance: {},
    affinities: {},
    affinitySigil: '',
    sigil: '',
    cry: '',
    relics: [],
    lastSeen: Date.now(),
  };
}
