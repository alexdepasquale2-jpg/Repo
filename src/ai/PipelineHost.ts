import { PIPELINES, type PipelineId } from './registry';
import type { FromWorker, Slot, ToWorker } from './protocol';

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
  #worker: Worker;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #loads = new Map<Slot, { resolve: () => void; reject: (e: Error) => void }>();
  #nextId = 1;

  readonly slots = new Map<Slot, SlotState>();
  onChange: (() => void) | null = null;

  constructor() {
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
    this.#set(slot, { status: 'loading', progress: 0 });

    return new Promise<void>((resolve, reject) => {
      this.#loads.set(slot, { resolve, reject });
      this.#send({
        type: 'load',
        req: { slot, task: spec.task, model: spec.model, dtype: spec.dtype },
      });
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
        this.#set(msg.slot, { status: 'ready', progress: 1 });
        this.#loads.get(msg.slot)?.resolve();
        this.#loads.delete(msg.slot);
        break;

      case 'loadFailed':
        this.#set(msg.slot, { status: 'error', progress: 0, message: msg.message });
        this.#loads.get(msg.slot)?.reject(new Error(msg.message));
        this.#loads.delete(msg.slot);
        break;

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
