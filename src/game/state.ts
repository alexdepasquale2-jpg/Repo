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
    sigil: '',
    cry: '',
    relics: [],
    lastSeen: Date.now(),
  };
}
