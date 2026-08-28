/**
 * The pipeline tech tree.
 *
 * Every AI-backed ability names a real Transformers.js pipeline. Download size
 * is part of the game economy: a heavier model is a bigger unlock, so the cost
 * curve below is deliberately correlated with `approxMB`.
 *
 * Nothing here gates the core loop — see `abilities.ts` for how each ability
 * degrades when its model is absent.
 */

export interface PipelineSpec {
  task: string;
  model: string;
  /** Quantisation. q8 keeps mobile downloads and memory sane. */
  dtype: string;
  /** Rough download footprint, surfaced in the UI before the player commits. */
  approxMB: number;
}

export const PIPELINES = {
  /**
   * One embedding model backs both Resonance and Divination — the second
   * ability is free to load once the first is paid for, which makes for a
   * satisfying beat in the tree.
   */
  embed: {
    task: 'feature-extraction',
    model: 'Xenova/all-MiniLM-L6-v2',
    dtype: 'q8',
    approxMB: 25,
  },

  sentiment: {
    task: 'text-classification',
    model: 'Xenova/distilbert-base-uncased-finetuned-sst-2-english',
    dtype: 'q8',
    approxMB: 67,
  },

  generate: {
    task: 'text-generation',
    model: 'HuggingFaceTB/SmolLM2-135M-Instruct',
    dtype: 'q8',
    approxMB: 145,
  },
} as const satisfies Record<string, PipelineSpec>;

export type PipelineId = keyof typeof PIPELINES;
