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

export type Backend = 'webgpu' | 'wasm';

export interface LoadRequest {
  slot: Slot;
  task: string;
  model: string;
  dtype: string;
  /**
   * Pin the ORT backend. Left unset the worker probes for a real WebGPU
   * adapter; set to 'wasm' by the host when retrying after a GPU failure.
   */
  backend?: Backend;
}

export type ToWorker =
  | { type: 'load'; req: LoadRequest }
  | { type: 'run'; id: number; slot: Slot; input: unknown; options?: unknown }
  /** Release a pipeline's session and weights. Used for budget eviction. */
  | { type: 'unload'; slot: Slot };

export type FromWorker =
  /** Weight download progress for one slot, aggregated across its files. */
  | { type: 'progress'; slot: Slot; loaded: number; total: number }
  | { type: 'loaded'; slot: Slot; backend: string }
  | { type: 'loadFailed'; slot: Slot; message: string }
  | { type: 'unloaded'; slot: Slot }
  | { type: 'result'; id: number; output: unknown }
  | { type: 'failed'; id: number; message: string };
