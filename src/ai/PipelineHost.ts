import { PIPELINES, type PipelineId } from './registry';
import type { Backend, FromWorker, LoadRequest, Slot, ToWorker } from './protocol';

export type SlotStatus = 'absent' | 'loading' | 'ready' | 'error';

export interface SlotState {
  status: SlotStatus;
  /** 0–1 while downloading. */
  progress: number;
  message?: string;
}

/**
 * Main-thread owner of the pipeline worker.
 *
 * Inference runs off the main thread so a 135M-parameter generation on a mid
 * phone stalls the model, never the render loop or the tap handler.
 */
export class PipelineHost {
  #worker!: Worker;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #loads = new Map<Slot, { resolve: () => void; reject: (e: Error) => void }>();
  #nextId = 1;

  /** Last load request per slot, so a respawned worker can replay them. */
  #requests = new Map<Slot, LoadRequest>();

  /** Slots already retried on WASM, so a GPU failure escalates only once. */
  #retried = new Set<Slot>();

  readonly slots = new Map<Slot, SlotState>();
  /** Backend actually in use, once something has loaded. */
  backend: Backend | null = null;
  onChange: (() => void) | null = null;

  constructor() {
    this.#spawn();
  }

  #spawn(): void {
    this.#worker = new Worker(new URL('./pipelines.worker.ts', import.meta.url), {
      type: 'module',
      name: 'pipelines',
    });
    this.#worker.addEventListener('message', (e: MessageEvent<FromWorker>) => this.#handle(e.data));
    this.#worker.addEventListener('error', (e) => {
      const err = new Error(e.message || 'pipeline worker crashed');
      for (const p of this.#pending.values()) p.reject(err);
      this.#pending.clear();
      for (const [slot, l] of this.#loads) {
        this.#set(slot, { status: 'error', progress: 0, message: err.message });
        l.reject(err);
      }
      this.#loads.clear();
    });
  }

  /**
   * Discards the worker and starts a clean one.
   *
   * ORT initialises its WASM module once per worker and latches the failure, so
   * after a backend failure every further attempt in that worker reports
   * "previous call to 'initWasm()' failed" no matter which device is asked for.
   * A retry is only meaningful in a fresh worker.
   *
   * Slots that were already loaded are replayed, since terminating drops them.
   */
  #respawn(): void {
    const reload = [...this.slots]
      .filter(([, s]) => s.status === 'ready')
      .map(([slot]) => this.#requests.get(slot))
      .filter((r): r is LoadRequest => r !== undefined);

    this.#worker.terminate();
    for (const p of this.#pending.values()) p.reject(new Error('pipeline worker restarted'));
    this.#pending.clear();
    this.slots.clear();
    this.#spawn();

    for (const req of reload) {
      this.#set(req.slot, { status: 'loading', progress: 0 });
      this.#send({ type: 'load', req });
    }
  }

  state(slot: Slot): SlotState {
    return this.slots.get(slot) ?? { status: 'absent', progress: 0 };
  }

  isReady(slot: Slot): boolean {
    return this.state(slot).status === 'ready';
  }

  /** Downloads and warms a pipeline. Safe to call repeatedly. */
  load(slot: Slot, pipelineId: PipelineId): Promise<void> {
    const current = this.state(slot);
    if (current.status === 'ready') return Promise.resolve();

    const existing = this.#loads.get(slot);
    if (existing) return new Promise((resolve, reject) => {
      // Chain onto the in-flight load rather than starting a second one.
      const prev = existing;
      this.#loads.set(slot, {
        resolve: () => { prev.resolve(); resolve(); },
        reject: (e) => { prev.reject(e); reject(e); },
      });
    });

    const spec = PIPELINES[pipelineId];
    const req: LoadRequest = { slot, task: spec.task, model: spec.model, dtype: spec.dtype };

    // A slot that already fell back stays on WASM: the worker may have been
    // respawned since, and re-probing would walk into the same GPU failure.
    if (this.#retried.has(slot) || this.backend === 'wasm') req.backend = 'wasm';

    // Retrying after a failure needs a clean worker — ORT latched its init
    // error, so the existing one can only report that same error again.
    if (current.status === 'error') this.#respawn();

    this.#requests.set(slot, req);
    this.#set(slot, { status: 'loading', progress: 0 });

    return new Promise<void>((resolve, reject) => {
      this.#loads.set(slot, { resolve, reject });
      this.#send({ type: 'load', req });
    });
  }

  /** Runs a loaded pipeline. Rejects if the slot is not ready. */
  run<T>(slot: Slot, input: unknown, options?: unknown): Promise<T> {
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.#send({ type: 'run', id, slot, input, options });
    });
  }

  #send(msg: ToWorker): void {
    this.#worker.postMessage(msg);
  }

  #set(slot: Slot, state: SlotState): void {
    this.slots.set(slot, state);
    this.onChange?.();
  }

  #handle(msg: FromWorker): void {
    switch (msg.type) {
      case 'progress':
        this.#set(msg.slot, {
          status: 'loading',
          progress: msg.total > 0 ? msg.loaded / msg.total : 0,
        });
        break;

      case 'loaded':
        this.backend = msg.backend as Backend;
        this.#set(msg.slot, { status: 'ready', progress: 1 });
        this.#loads.get(msg.slot)?.resolve();
        this.#loads.delete(msg.slot);
        break;

      case 'loadFailed': {
        const req = this.#requests.get(msg.slot);

        // A GPU failure is recoverable, but only in a clean worker: ORT latches
        // its init failure, so retrying here would just report it again. Respawn
        // once per slot and pin WASM. Everything else is a real failure.
        if (req && req.backend !== 'wasm' && !this.#retried.has(msg.slot)) {
          console.warn(`[pipelines] ${msg.slot} failed on GPU, retrying on WASM`, msg.message);
          this.#retried.add(msg.slot);
          this.backend = 'wasm';

          const retry: LoadRequest = { ...req, backend: 'wasm' };
          this.#requests.set(msg.slot, retry);
          this.#respawn();
          this.#set(msg.slot, { status: 'loading', progress: 0 });
          this.#send({ type: 'load', req: retry });
          break;
        }

        this.#set(msg.slot, { status: 'error', progress: 0, message: msg.message });
        this.#loads.get(msg.slot)?.reject(new Error(msg.message));
        this.#loads.delete(msg.slot);
        break;
      }

      case 'result':
        this.#pending.get(msg.id)?.resolve(msg.output);
        this.#pending.delete(msg.id);
        break;

      case 'failed':
        this.#pending.get(msg.id)?.reject(new Error(msg.message));
        this.#pending.delete(msg.id);
        break;
    }
  }
}

/** Cosine similarity of two L2-normalised vectors. */
export function similarity(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}
