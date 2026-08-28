/**
 * Message contract between the main thread and the pipeline worker.
 *
 * The worker is generic over Transformers.js tasks: abilities declare which
 * pipeline they need in `registry.ts` and the worker loads it on demand. That
 * keeps adding a new AI-backed ability to a registry entry plus an effect,
 * rather than a new worker each time.
 */

/** Identifies one loaded pipeline. Matches the ability id that owns it. */
export type Slot = string;

export interface LoadRequest {
  slot: Slot;
  task: string;
  model: string;
  dtype: string;
}

export type ToWorker =
  | { type: 'load'; req: LoadRequest }
  | { type: 'run'; id: number; slot: Slot; input: unknown; options?: unknown };

export type FromWorker =
  /** Weight download progress for one slot, aggregated across its files. */
  | { type: 'progress'; slot: Slot; loaded: number; total: number }
  | { type: 'loaded'; slot: Slot; backend: string }
  | { type: 'loadFailed'; slot: Slot; message: string }
  | { type: 'result'; id: number; output: unknown }
  | { type: 'failed'; id: number; message: string };
