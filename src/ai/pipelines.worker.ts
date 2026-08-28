/// <reference lib="webworker" />
import { pipeline, env } from '@huggingface/transformers';
import type { FromWorker, LoadRequest, Slot, ToWorker } from './protocol';

// Weights come from the Hugging Face CDN; probing for a local model directory
// only produces a spurious 404 on every launch.
env.allowLocalModels = false;

// Serve the ORT runtime from our own origin. The default is a jsdelivr CDN,
// which would leave the game broken offline even with weights cached.
// `scripts/prepare-assets.mjs` stages these files into public/ort/.
// BASE_URL rather than '/', so a sub-path deploy (GitHub Pages) still resolves.
env.backends.onnx.wasm!.wasmPaths = `${import.meta.env.BASE_URL}ort/`;

const post = (msg: FromWorker) => self.postMessage(msg);

type AnyPipeline = (input: unknown, options?: unknown) => Promise<unknown>;

const loaded = new Map<Slot, AnyPipeline>();
const inFlight = new Map<Slot, Promise<void>>();

/**
 * WebGPU is far faster where it works, but Android WebView and older Chrome
 * expose adapters that fail on first use — so a WebGPU failure falls through
 * to WASM instead of failing the unlock.
 */
async function load(req: LoadRequest): Promise<void> {
  const backends = 'gpu' in navigator ? ['webgpu', 'wasm'] : ['wasm'];
  let lastError: unknown;

  for (const backend of backends) {
    // Per-file byte counts, so progress reflects the whole model rather than
    // resetting each time a new file starts.
    const files = new Map<string, { loaded: number; total: number }>();

    try {
      const pipe = await pipeline(req.task as 'feature-extraction', req.model, {
        device: backend as 'webgpu' | 'wasm',
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
      return;
    } catch (err) {
      lastError = err;
      console.warn(`[pipelines] ${req.slot}: ${backend} backend unavailable`, err);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
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
