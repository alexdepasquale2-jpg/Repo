import { PipelineHost, similarity } from '../ai/PipelineHost';
import { ELEMENTS, type Archetype } from './content';

/** Sentiment read off a battle cry. */
export interface CryReading {
  kind: 'fervour' | 'dread';
  /** 0–1 model confidence, scaled into buff strength by the caller. */
  power: number;
}

/**
 * Turns loaded pipelines into game answers.
 *
 * Everything here is memoised: the same archetype is fought hundreds of times,
 * and re-embedding its essence on every spawn would burn battery for an answer
 * that cannot change.
 */
export class Oracle {
  #host: PipelineHost;
  #elementVectors: number[][] | null = null;
  #essenceVectors = new Map<string, number[]>();
  #sigilVectors = new Map<string, number[]>();

  constructor(host: PipelineHost) {
    this.#host = host;
  }

  get host(): PipelineHost {
    return this.#host;
  }

  async #embed(texts: string[]): Promise<number[][]> {
    return this.#host.run<number[][]>('embed', texts, { pooling: 'mean', normalize: true });
  }

  async #elements(): Promise<number[][]> {
    if (!this.#elementVectors) {
      this.#elementVectors = await this.#embed(ELEMENTS.map((e) => e.description));
    }
    return this.#elementVectors;
  }

  async #essence(archetype: Archetype): Promise<number[]> {
    const cached = this.#essenceVectors.get(archetype.id);
    if (cached) return cached;

    const [vec] = await this.#embed([archetype.essence]);
    if (!vec) throw new Error(`could not embed essence for ${archetype.id}`);
    this.#essenceVectors.set(archetype.id, vec);
    return vec;
  }

  /**
   * Divination: the element whose description sits closest to the enemy's
   * essence in embedding space. The model, not a lookup table, decides this —
   * rewriting an element's prose in content.ts moves real enemies.
   */
  async resonantElement(archetype: Archetype): Promise<string> {
    const [essence, elements] = await Promise.all([this.#essence(archetype), this.#elements()]);

    let bestId = ELEMENTS[0]!.id;
    let bestScore = -Infinity;
    for (let i = 0; i < ELEMENTS.length; i++) {
      const score = similarity(essence, elements[i]!);
      if (score > bestScore) {
        bestScore = score;
        bestId = ELEMENTS[i]!.id;
      }
    }
    return bestId;
  }

  /**
   * Resonance: how close the player's bound sigil is to this enemy's nature.
   *
   * Rescaled from the band MiniLM actually uses for short phrases — raw cosine
   * for unrelated everyday text clusters near 0.05 and rarely passes 0.7, so
   * the raw value alone would barely move the crit chance.
   */
  async sigilAffinity(sigil: string, archetype: Archetype): Promise<number> {
    const key = sigil.trim().toLowerCase();
    if (!key) return 0;

    let sigilVec = this.#sigilVectors.get(key);
    if (!sigilVec) {
      const [vec] = await this.#embed([key]);
      if (!vec) return 0;
      // Bounded so a long session cannot grow this map without limit.
      if (this.#sigilVectors.size > 64) this.#sigilVectors.clear();
      this.#sigilVectors.set(key, vec);
      sigilVec = vec;
    }

    const essence = await this.#essence(archetype);
    const raw = similarity(sigilVec, essence);
    return Math.max(0, Math.min(1, (raw - 0.02) / 0.68));
  }

  /**
   * Attunement: sentiment of a battle cry.
   *
   * Both polarities are useful on purpose — a negative cry is Dread rather than
   * a wasted turn, so there is no way to type the "wrong" thing.
   */
  async readCry(text: string): Promise<CryReading> {
    const out = await this.#host.run<unknown>('sentiment', text.trim());
    const first = Array.isArray(out) ? out[0] : out;
    const { label, score } = (first ?? {}) as { label?: string; score?: number };

    return {
      kind: String(label).toUpperCase() === 'POSITIVE' ? 'fervour' : 'dread',
      power: typeof score === 'number' ? score : 0.5,
    };
  }

  /**
   * Chronicle: names a relic.
   *
   * Generation is the least predictable pipeline here, so the caller always
   * passes a fallback name — a refusal or an empty completion must not cost the
   * player their drop.
   */
  async nameRelic(archetypeName: string, layer: number, fallback: string): Promise<string> {
    const messages = [
      {
        role: 'system',
        content:
          'You name magical relics in a dark fantasy game. Reply with ONLY the name, 2 to 4 words, no quotes, no explanation.',
      },
      {
        role: 'user',
        content: `A relic taken from a ${archetypeName} on layer ${layer} of an underworld. Name it.`,
      },
    ];

    try {
      const out = await this.#host.run<unknown>('generate', messages, {
        max_new_tokens: 16,
        temperature: 0.9,
        do_sample: true,
        return_full_text: false,
      });

      const first = Array.isArray(out) ? out[0] : out;
      const raw = (first as { generated_text?: unknown })?.generated_text;

      // Chat pipelines may hand back a message array rather than a string.
      const text =
        typeof raw === 'string'
          ? raw
          : Array.isArray(raw)
            ? String((raw.at(-1) as { content?: unknown })?.content ?? '')
            : '';

      const name = text
        .split('\n')[0]
        ?.replace(/["'*_`]/g, '')
        .replace(/^\s*(name|relic)\s*:\s*/i, '')
        .trim();

      return name && name.length >= 3 && name.length <= 48 ? name : fallback;
    } catch {
      return fallback;
    }
  }
}
