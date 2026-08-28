# Latent Depths

An idle/incremental ARPG for Android, built as an installable HTML5 PWA, where
the ability tree **is** a set of real Transformers.js pipelines. Every unlock
downloads a model that then runs on the device and does actual work in the
combat maths — not flavour text over a random number.

You descend through Layers, tapping and letting Daemons grind for you. The
interesting part is what the models buy you.

## The pipelines

| Ability | Pipeline | Model | What it actually does |
|---|---|---|---|
| **Divination** | `feature-extraction` | all-MiniLM-L6-v2 (~25 MB) | Embeds each enemy's essence text and each element's description, and takes the closest pair. That element becomes the enemy's resonant element — striking with it deals 2.5x damage. |
| **Resonance** | `feature-extraction` | *(shares the above)* | You bind a sigil phrase. Cosine similarity between your phrase and the enemy's essence sets your crit chance, up to 60%. |
| **Attunement** | `text-classification` | distilbert-sst-2 (~67 MB) | Reads the sentiment of a battle cry you type. Positive → Fervour, a damage buff scaled by model confidence. Negative → Dread, a max-HP burn. Neither polarity is a wasted turn. |
| **Chronicle** | `text-generation` | SmolLM2-135M-Instruct (~145 MB) | Names boss relics on the spot; the relic rolls a permanent modifier. |

Two design rules hold this together:

**The prose is the game data.** Element descriptions and enemy essences in
`src/game/content.ts` are embedded verbatim. Rewording an element genuinely
moves which enemies it matches — there is no lookup table behind it.

**Nothing gates the core loop.** The game is fully playable with zero models
loaded; abilities *add* systems rather than unhiding them. Before Divination
there is no elemental system at all, rather than a hidden one. That keeps the
first launch instant, survives a failed or offline download, and means the whole
simulation is testable without the network.

Download size is part of the economy — a heavier model is a more expensive
unlock, deliberately.

## Living inside a phone's limits

Three models resident is ~240 MB, on a device that may have 2 GB and will kill
a large background tab without warning. The pipeline layer is budgeted:

- **Memory budget** sized from `navigator.deviceMemory` (40–400 MB of resident
  weight). Loading evicts least-recently-used pipelines to fit.
- **Idle unload** after five minutes unused, and immediately on backgrounding —
  when an idle game spends most of its life.
- **Metered connections** get an explicit confirmation before anything over
  50 MB, and `Save-Data` is honoured as the request it is.
- **No eager preloading.** Owned pipelines warm on demand, and only silently
  when they are small and the connection is cheap.

What keeps this from degrading the game is that **the cached answer outlives the
model**. Divination's resonant elements and Resonance's affinities are written
into the save, so an evicted model costs nothing for enemies already measured —
only a genuinely new archetype needs it back, and reloading is a session rebuild
rather than a download because the weights stay in Cache Storage. A `run()` on
an evicted slot reloads transparently.

The upshot: a returning player usually needs no model at all, and the elemental
and crit systems keep working offline, cold, and under memory pressure.

## Running it

```bash
npm install
npm run dev        # http://localhost:5173, --host so a phone on your LAN can reach it
npm run build      # typecheck + production build into dist/
npm run preview    # serve the built app
npm run smoke      # Playwright pass over the built app (see Testing)
```

`npm run assets` runs automatically before `dev` and `build`. It generates the
PWA icons and stages the onnxruntime-web WASM runtime into `public/ort/`. Both
outputs are derived and gitignored.

## Deploying: the one thing that will bite you

**Your host must send these two headers**, or onnxruntime-web silently drops to
a single WASM thread and inference gets several times slower:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```

`credentialless` rather than `require-corp` — the stricter value would block the
cross-origin model weights coming from the Hugging Face CDN. `vite.config.ts`
sets both for `dev` and `preview`; production hosting is on you.

Also note the app fetches model weights from `huggingface.co` on first unlock.
Behind a restrictive egress policy those downloads fail — the game keeps running,
and the Pipelines tab shows the ability as offline.

### Android packaging

Currently a PWA: installable from Chrome via add-to-homescreen, `display:
standalone`, offline after first load. To ship an APK to Play, wrap it with
Bubblewrap or a Capacitor shell — no code changes needed, but the wrapper's
WebView still has to serve those two headers.

## Layout

```
src/
  ai/
    registry.ts          the pipeline tech tree: task, model id, dtype, size
    pipelines.worker.ts  generic host — loads any task on demand, WebGPU→WASM
    PipelineHost.ts      main-thread client, per-slot load state and progress
  game/
    content.ts           elements, enemies, daemons, abilities, cost curves
    Game.ts              simulation. No DOM, no model calls.
    Oracle.ts            turns loaded pipelines into game answers, memoised
    save.ts, state.ts    localStorage persistence and offline credit
  ui/CombatView.ts       procedural canvas combat
  engine/                rAF loop, DPR-capped canvas sizing
```

`Game` deliberately takes AI answers as plain inputs (`sigilAffinity`, a
resonance map) rather than calling models itself, which is why it is testable
standalone. `main.ts` is the only place the two halves meet.

Inference runs in a Web Worker throughout — a 135M-parameter generation on a mid
phone must stall the model, never the render loop or the tap handler.

## Testing

`npm run smoke` drives a built copy in mobile-emulated Chromium and asserts the
model-free path: spawning, tapping, the economy, tab navigation, unlock
gating, persistence across reload, and that unlocking Divination is what
introduces the elemental system. Start `npm run preview` first, or pass a URL.

`npm run verify:ort` proves onnxruntime-web actually initialises and runs, using
a 76-byte hand-built ONNX model (one Identity node) instead of a real one. That
covers the setup which has broken in practice — `wasmPaths` resolution, the
WebGPU-vs-WASM decision, and whether the threaded build survives without
`SharedArrayBuffer` — none of which needs the Hugging Face CDN.

Run it against a server with the isolation headers stripped to reproduce
GitHub Pages exactly:

```bash
NO_COI=1 npx vite --port 5174
npm run verify:ort http://localhost:5174/verify/ort.html
```

Downloading real weights is still **not** covered; it needs the Hugging Face
CDN, which CI and sandboxes often cannot reach. The smoke test treats a failed
download as the expected offline path, which is precisely the behaviour worth
pinning.

Adding a unit suite over `Game` and the cost curves in `numbers.ts` is the
obvious next step; balance regressions in an incremental game are exactly the
kind that fail silently.

## Adding an ability

1. Add a `PipelineSpec` to `PIPELINES` in `src/ai/registry.ts`.
2. Add an `AbilitySpec` to `ABILITIES` in `src/game/content.ts` — name, price,
   and one line on what it mechanically does.
3. Add a method to `Oracle` that turns its output into a game answer, and
   memoise anything that cannot change between calls.
4. Consume it in `Game` as a plain input, so the simulation stays model-free.

The worker is generic over Transformers.js tasks, so nothing there needs to
change.
