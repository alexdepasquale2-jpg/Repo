/// <reference lib="webworker" />
import { pipeline, env } from '@huggingface/transformers';
import type { Backend, FromWorker, LoadRequest, Slot, ToWorker } from './protocol';

// Weights come from the Hugging Face CDN; probing for a local model directory
// only produces a spurious 404 on every launch.
env.allowLocalModels = false;

// Point ORT at the WASM binary we serve ourselves. Left unset, Transformers.js
// substitutes a jsdelivr CDN URL, which would leave the game broken offline
// even with model weights cached. prepare-assets.mjs stages the file.
//
// Only `wasm` is overridden, deliberately. Passing a directory prefix instead
// makes ORT resolve its Emscripten glue (.mjs) from that prefix too and pull it
// with a dynamic import() — but the bundler has already inlined that glue into
// this worker, so the fetch is pure downside: a static host serving .mjs as
// octet-stream (GitHub Pages does) fails the import on MIME grounds and the
// whole pipeline load dies. Naming only the binary leaves the glue inline.
//
// BASE_URL rather than '/', so a sub-path deploy still resolves.
env.backends.onnx.wasm!.wasmPaths = {
  wasm: `${import.meta.env.BASE_URL}ort/ort-wasm-simd-threaded.jsep.wasm`,
};

const post = (msg: FromWorker) => self.postMessage(msg);

type AnyPipeline = ((input: unknown, options?: unknown) => Promise<unknown>) & {
  dispose?: () => Promise<void>;
};

const loaded = new Map<Slot, AnyPipeline>();
const inFlight = new Map<Slot, Promise<void>>();

/**
 * Decide the backend BEFORE handing anything to ORT.
 *
 * `'gpu' in navigator` is not enough: Chrome exposes navigator.gpu even when
 * WebGPU is flag-gated or has no usable adapter, and asking for it anyway gets
 * an "enable-unsafe-webgpu" failure. That failure is unrecoverable in-process —
 * ORT's initWasm() is one-shot per worker, so a second attempt on WASM only
 * yields "previous call to 'initWasm()' failed". The retry has to happen in a
 * fresh worker, which the host arranges; the job here is to not need one.
 */
async function pickBackend(): Promise<Backend> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return 'wasm';

  try {
    // Only a real adapter counts. requestAdapter() resolves to null when
    // WebGPU is present but unusable, and throws outright when flag-gated.
    return (await gpu.requestAdapter()) ? 'webgpu' : 'wasm';
  } catch (err) {
    console.warn('[pipelines] WebGPU probe failed, using WASM', err);
    return 'wasm';
  }
}

async function load(req: LoadRequest): Promise<void> {
  const backend = req.backend ?? (await pickBackend());

  // Per-file byte counts, so progress reflects the whole model rather than
  // resetting each time a new file starts.
  const files = new Map<string, { loaded: number; total: number }>();

  const pipe = await pipeline(req.task as 'feature-extraction', req.model, {
    device: backend,
    dtype: req.dtype as 'q8',
    progress_callback: (p: unknown) => {
      const e = p as { status?: string; file?: string; loaded?: number; total?: number };
      if (e.status !== 'progress' || !e.total) return;
      files.set(e.file ?? '', { loaded: e.loaded ?? 0, total: e.total });

      let l = 0;
      let t = 0;
      for (const f of files.values()) {
        l += f.loaded;
        t += f.total;
      }
      post({ type: 'progress', slot: req.slot, loaded: l, total: t });
    },
  });

  loaded.set(req.slot, pipe as unknown as AnyPipeline);
  post({ type: 'loaded', slot: req.slot, backend });
}

self.addEventListener('message', (event: MessageEvent<ToWorker>) => {
  const msg = event.data;

  if (msg.type === 'load') {
    const { slot } = msg.req;
    if (loaded.has(slot)) {
      post({ type: 'loaded', slot, backend: 'cached' });
      return;
    }

    // Collapse duplicate load requests for the same slot — the UI can fire one
    // per tap while a 145 MB download is already in flight.
    let job = inFlight.get(slot);
    if (!job) {
      job = load(msg.req)
        .catch((err: unknown) => {
          post({
            type: 'loadFailed',
            slot,
            message: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => inFlight.delete(slot));
      inFlight.set(slot, job);
    }
    return;
  }

  if (msg.type === 'unload') {
    const pipe = loaded.get(msg.slot);
    loaded.delete(msg.slot);
    // dispose() releases the ORT session and its weights from the WASM heap.
    // Reported regardless of outcome — the slot is gone either way, and a
    // failed dispose must not leave the host thinking it is still resident.
    void Promise.resolve(pipe?.dispose?.())
      .catch((err: unknown) => console.warn(`[pipelines] dispose ${msg.slot} failed`, err))
      .finally(() => post({ type: 'unloaded', slot: msg.slot }));
    return;
  }

  if (msg.type === 'run') {
    const pipe = loaded.get(msg.slot);
    if (!pipe) {
      post({ type: 'failed', id: msg.id, message: `pipeline "${msg.slot}" is not loaded` });
      return;
    }

    pipe(msg.input, msg.options).then(
      (output) => {
        // Tensors do not survive structured clone; feature-extraction output
        // carries a `tolist()` that flattens it to plain arrays.
        const value =
          output && typeof (output as { tolist?: unknown }).tolist === 'function'
            ? (output as { tolist(): unknown }).tolist()
            : output;
        post({ type: 'result', id: msg.id, output: value });
      },
      (err: unknown) =>
        post({
          type: 'failed',
          id: msg.id,
          message: err instanceof Error ? err.message : String(err),
        }),
    );
  }
});
