# Lattice

Lattice is a mobile-first world-model IDE, built as a PWA. It is a **control surface**: the phone composes jobs, and a `worker.py` process on a Jetson, an RTX box or a datacenter node runs **NVIDIA Cosmos 3** (physics and action) and **Tencent HY-World 2.0** (persistent places). **Bridge** connects the two: a Cosmos rollout is cut into keyframes, and HY-World freezes those keyframes into a 3D scene.

> Cosmos invents motion. HY-World freezes a room. The phone never pretends it is the GPU.

## Architecture

```
 ┌──────────────────────┐   HTTP (JSON, lattice.job/1)   ┌───────────────────────────────┐
 │  Phone PWA           │ ─────────────────────────────▶ │  worker.py (stdlib Python)    │
 │  index.html / app.js │   POST /jobs, GET /jobs/<id>   │  Jetson │ RTX │ datacenter    │
 │  compose · capture   │ ◀───────────────────────────── │  FIFO queue, 1 job at a time  │
 │  poll · preview      │   status + /runs/<id>/<file>   └──────────────┬────────────────┘
 └──────────────────────┘                                               │ subprocess (LATTICE_EXEC=1)
                                                     ┌──────────────────┼──────────────────┐
                                                     ▼                  ▼                  ▼
                                               Cosmos 3           HY-World 2.0       Bridge
                                             (OpenMDW 1.1)     (Tencent License)  cosmos → keyframes → hy
                                                     └──────────────────┬──────────────────┘
                                                                        ▼
                                                   ./runs/<id>/ job.json status.json log.txt
                                                                inputs/ + artifacts
```

## Quick start

```bash
# On the GPU machine
python3 worker.py                      # real runs only if LATTICE_EXEC=1 and the engine is importable
LATTICE_DRY_RUN=1 python3 worker.py    # always dry run: walks the stages and writes plan.json

# Serve the PWA (from lattice-ide/)
python3 -m http.server 8080
```

Open `http://<lan-ip>:8080` on your phone and set the worker URL under **More → Settings**, for example `http://<gpu-host>:8787`.

Browsers only enable service workers (offline/install) and camera capture on **HTTPS or localhost**. For a phone on your LAN, put both ports behind HTTPS. Any of these works: `tailscale serve`, a Caddy reverse proxy with a local or ACME certificate, or an HTTPS tunnel service. If the PWA is served over HTTPS, the worker also has to be HTTPS, because browsers block mixed content.

## Worker environment

| Variable | Default | Meaning |
|---|---|---|
| `LATTICE_HOST` | `0.0.0.0` | Bind address (`--host`) |
| `LATTICE_PORT` | `8787` | Port (`--port`) |
| `LATTICE_RUNS` | `./runs` | Runs directory (`--runs`) |
| `LATTICE_DRY_RUN` | unset | `1` forces a dry run (`--dry-run`) |
| `LATTICE_EXEC` | unset | `1` allows real pipeline subprocesses. Without it, every job is a dry run. |
| `LATTICE_TOKEN` | unset | Shared secret. When set, every endpoint except `OPTIONS` and `GET /health` requires `Authorization: Bearer <token>`. `GET /runs/...` also accepts `?token=<token>` so `<video>`/`<img>` previews work |
| `LATTICE_COSMOS_CMD` / `LATTICE_HY_CMD` | built-in | Command prefix overrides for the engine CLIs |
| `LATTICE_COSMOS_MODULE` / `LATTICE_HY_MODULE` | `cosmos3` / `hyworld` | Python module names used to detect whether an engine is installed |

**Integration points:** `cosmos3` and `hyworld` are placeholder names. Lattice does not assume what the upstream Cosmos 3 and HY-World 2.0 packages, modules or CLIs are called. Set the four variables above to match what you actually installed.

A job runs as a dry run when any of these is true: `LATTICE_DRY_RUN=1` is set, `LATTICE_EXEC` is not `1`, or the engine module can't be imported. A dry run walks the real stage list, logs the command it *would* run, and writes a `plan.json` artifact.

| Engine | Stages |
|---|---|
| cosmos | validate → fetch-weights → load → infer → encode |
| hyworld | validate → pano → worldnav → worldstereo → 3dgs → export |
| bridge | validate → cosmos-rollout → keyframes → hy-freeze → export |

## HTTP API

CORS: `*`; headers `Content-Type, Authorization, X-HF-Token`; methods `GET, POST, OPTIONS`. Max body 64 MB.

| Method & path | Response |
|---|---|
| `GET /health` | `{ok, service, version, schema, dry_run, exec, auth, engines{cosmos,hyworld}, gpu, queue, runs_dir}` |
| `POST /jobs` | body `lattice.job/1` → `201 {id, status:"queued"}`, or `400 {error}` |
| `GET /jobs?limit=N` | `{jobs:[Status…]}`, newest first (default 8, max 200) |
| `GET /jobs/<id>` | Status, or `404 {error:"not found"}` |
| `POST /jobs/<id>/cancel` | Status |
| `GET /runs/<id>/<path>` | Raw artifact file (path-traversal safe) |

Status: `{id, status: queued|running|done|failed|cancelled, progress 0..1, stage, engine, mode, model, created, updated, dry_run, error, log[≤50], artifacts[{kind, name, url, bytes}]}`. Artifact URLs are relative to the worker.

On disk, each run lives in `./runs/<id>/`, which holds `job.json` (media replaced by `inputs/<name>` paths), `status.json`, `log.txt`, `inputs/` and the artifacts. History survives restarts. Any job that was queued or running when the worker stopped is marked `failed` with the error `worker restarted`.

## Job schema `lattice.job/1`

```json
{
  "schema": "lattice.job/1",
  "id": "lj_20260926120000_a1b2c3",
  "created": "2026-09-26T12:00:00Z",
  "engine": "bridge",
  "mode": "bridge",
  "model": "cosmos3-nano-16b+hy-world-2.0",
  "target": "rtx",
  "inputs": {
    "prompt": "A robot arm clears a cluttered kitchen counter",
    "media": [
      { "name": "counter.jpg", "type": "image/jpeg", "size": 812345, "kind": "image",
        "data": "data:image/jpeg;base64,..." }
    ],
    "params": { "frames": 121, "fps": 24, "resolution": "720p", "seed": 7,
                "guidance": 7.0, "steps": 35, "keyframe_stride": 8,
                "export_target": "unity", "format": "ply" }
  },
  "outputs": { "dir": "./runs/lj_20260926120000_a1b2c3/", "formats": ["mp4", "ply"] },
  "license": {
    "id": "OpenMDW-1.1+Tencent-HY-World-2.0",
    "accepted": true,
    "acceptedAt": "2026-09-26T11:59:00Z",
    "notices_required": true,
    "terms": ["Cosmos 3: OpenMDW 1.1, notices required, no competing public model API",
              "HY-World 2.0: Tencent License.txt applies, not relicensed"]
  },
  "code": { "python": "# generated preview, never executed by the worker", "cli": "..." }
}
```

`mode` values: cosmos `reason|generate|action|edge`, hyworld `pano|worldmirror|stereo|export`, bridge `bridge`. Media `data` is included only for files of 24 MB or less. The worker rejects a job if `license.accepted` is not `true`.

## Tabs

- **Home**: worker health, engines and GPU, and the last 8 jobs.
- **Cosmos**: Reason, Generate, Action and Edge modes. Picking a model you can't run on the selected target is blocked:

  | Model | Jetson | RTX | Datacenter |
  |---|---|---|---|
  | Edge 4B (`cosmos3-edge-4b`) | ✓ | ✓ | ✓ |
  | Nano 16B (`cosmos3-nano-16b`) | – | ✓ | ✓ |
  | Super 64B (`cosmos3-super-64b`) | – | – | ✓ |
  | I2V (`cosmos3-i2v`) | – | ✓ | ✓ |
  | DROID policy (`cosmos3-droid-policy`) | ✓ | ✓ | ✓ |
  | HY-World 2.0 (`hy-world-2.0`) | – | ✓ | ✓ |

- **HY-World**: Pano, WorldMirror, Stereo, and Export (Unity, Unreal or Isaac; `ply`, `spz`, `glb` or `usd`). The pipeline runs pano → WorldNav → WorldStereo → 3DGS/mesh. You can capture input with the phone camera (`capture="environment"`).
- **Bridge**: a Cosmos rollout is cut into keyframes, and HY-World freezes them into a persistent scene.
- **More**: job history, the license gate, Python/CLI snippets, settings, and `lattice-jobs.json` export (the export contains no tokens and no media).

## Licensing

- **Cosmos 3 weights, OpenMDW 1.1**: commercial use is allowed. Notices and attribution are required. You may not use the weights to offer a competing public model API. Generated outputs are yours.
- **HY-World 2.0, Tencent `License.txt`** (Tencent HY-World 2.0 Community License): read the original file. Its territory and usage restrictions apply. Lattice does not relicense it.
- **Lattice UI and worker**: MIT (see `LICENSE`). This covers no model weights.

## Security

- The HF token is sent only as the `X-HF-Token` header on `POST /jobs`. The worker passes it to the subprocess as `HF_TOKEN`, never stores it, never logs it, and redacts it to `hf_***` in any log line. The token is never part of job JSON, exports or generated code.
- The worker **never executes** the client's `code` field. It builds its own command line from whitelisted fields (engine, mode, model, params). Real execution also requires `LATTICE_EXEC=1`.
- If the worker is reachable from anything other than localhost, set `LATTICE_TOKEN`, and put the worker behind HTTPS on untrusted networks.

## Non-goals

- No model weights in the PWA.
- No fake on-device Super 64B, or on-device inference of any kind.
- No relicensing of Hunyuan / HY-World.

## Platform settings

| Env | Meaning |
|---|---|
| `LATTICE_REGION` | ISO 3166 alpha-2 code for where the worker runs (e.g. `US`). If it is an EU-27 country, `GB` or `KR`, HY-World and Bridge jobs are rejected with 400 "HY-World 2.0 license does not apply in <X>". |
| `LATTICE_GPU_USD_HR` | Optional $/GPU-hour; enables `metrics.cost_usd`. Dry runs bill 0. |

Jobs may carry `license.territory` (the requesting user's country); the same EU/GB/KR rule applies. The gate only acts when a region or territory is given.

`GET /health` also reports `region`, `hy_territory_ok` and `gpu_usd_hr`. Each finished job has `metrics` in its Status and a `metrics.json` artifact: `wall_s`, `gpu_hours`, `cost_usd`, and per-stage `{stage, started, ended, wall_s, gpu_name, gpu_count, peak_vram_mb, exit_code}` (peak VRAM via `nvidia-smi` when present).

Runs using HY-World get `NOTICE-HY-World.txt`; Cosmos runs get `NOTICE-Cosmos.txt`. See `DEPLOY.md` for private deployment (requires counsel sign-off before selling) and `NOTICE` for third-party terms.

## Engine export bundles

Set `params.export_target` (`unity` | `unreal` | `isaac`) and `params.format` (`ply` | `spz` | `glb` | `usd`) on a HY-World `export` job or a Bridge job. The worker writes `runs/<id>/export/<target>/` and a `<target>-bundle.zip` artifact (kind `bundle`). Isaac does not take `spz` (400). Each bundle contains:

- `lattice-export.json` (`lattice.export/1`): files, splat point count and bounds, coordinate conversion, units, source run, required plugins and manual steps.
- The run's `NOTICE-*.txt` files.
- **Unity:** `Assets/Lattice/<run>/` + `Editor/LatticeImporter.cs` (flips X for left-handed axes, adds MeshColliders). Splats need a 3DGS package such as aras-p/UnityGaussianSplatting (not bundled).
- **Unreal:** `Content/Lattice/<run>/` + `import_lattice.py` (Y-up to Z-up, ×100 cm, collision on). Splats need a 3DGS plugin.
- **Isaac Sim:** `stage.usda` (Z-up, metersPerUnit 1, physics scene, collidable ground, mesh payload) + `isaac_load.py`. Splat PLYs are included with conversion steps.

Dry runs export a clearly marked placeholder scene. The importer scripts have not yet been run inside the engines.

## Batch datasets (`batch.py`)

Sweep prompts × seeds through a worker into a dataset:

    python3 batch.py examples/sweep-droid.json --worker http://jetson:8787 \
        [--token $LATTICE_TOKEN] [--hf-token-env HF_TOKEN] [--out dataset/] [--limit N] [--dry]

Each (prompt, seed) pair becomes one `lattice.job/1` job. Artifacts land in `dataset/<name>/<job_id>/`, with `dataset/<name>/manifest.json` (`lattice.dataset/1`: items, per-item metrics, totals) and `NOTICE-Cosmos.txt`. The manifest is saved after every item, so Ctrl-C is safe; re-run the same command to resume. `--dry` prints the plan and posts nothing.

**Cosmos only.** HY-World and Bridge sweeps are refused: the HY-World 2.0 license §5(b) forbids using its Outputs to improve other AI models.

## App: metrics, bundles and territory

- Job detail shows wall time, GPU-hours and cost ("not billed (dry run)" for dry runs, "no rate set" without `LATTICE_GPU_USD_HR`), plus a per-stage table.
- Export bundles appear as a card with size and a download link.
- More → Settings → "Your country (ISO code)" is optional and sent as `license.territory`. If it or the worker's `LATTICE_REGION` is in the EU-27, GB or KR, HY-World and Bridge submits are disabled; Cosmos is unaffected.
- The format picker only offers formats the export target supports (Isaac: ply, glb, usd).

## Real execution path

With `LATTICE_EXEC=1` and an engine installed, the default engine command is `<this python> -m <LATTICE_*_MODULE>.cli` (override with `LATTICE_COSMOS_CMD` / `LATTICE_HY_CMD`).

- Engines get `HF_TOKEN` / `HUGGING_FACE_HUB_TOKEN` only from the job's `X-HF-Token`, never from the server's environment.
- Progress streams from `PROGRESS 0.5` or `PROGRESS 50%` lines.
- Cancel sends SIGTERM to the engine's process group, then SIGKILL after 5 s.
- Bridge keyframes: if ffmpeg is missing or fails, the rollout video goes to HY-World directly.
- Failures read `<program> exited with code N: <last output line>`, with tokens redacted.

`tests/test_exec.py` covers this path without a GPU using `tests/fake_engine.py`. To try it by hand:

    LATTICE_EXEC=1 LATTICE_COSMOS_MODULE=json LATTICE_HY_MODULE=json \
    LATTICE_COSMOS_CMD="python3 tests/fake_engine.py cosmos" \
    LATTICE_HY_CMD="python3 tests/fake_engine.py hy" python3 worker.py

## Tests

- Unit and integration (worker, exporters, batch, real-exec path): `cd lattice-ide && python3 -m unittest discover -s tests -v`
- Browser end-to-end (Playwright, Chromium): `cd lattice-ide/tests/e2e && npm ci && npx playwright install chromium && npm test`. It starts the PWA and a dry-run worker on free ports and covers cancel, offline draft → send, export/import (no tokens or media data), photo/video upload, the license and territory gates, Super 64B feasibility and the mixed-content warning. Set `PW_CHROMIUM_PATH` to use a preinstalled Chromium.
- CI (`.github/workflows/ci.yml`) runs the unit tests on Python 3.10 and 3.12, `node --check`, manifest/icon checks and the browser suite on every push and pull request.

## Files

| File | Purpose |
|---|---|
| `index.html`, `styles.css`, `app.js` | PWA UI |
| `sw.js` | Service worker (app shell cache; never touches worker API traffic) |
| `manifest.json`, `icon.svg` | Install metadata and icon |
| `worker.py` | GPU-side job runner (Python 3.10+, stdlib only) |
| `exporters/` | Unity / Unreal / Isaac export bundles |
| `batch.py`, `examples/` | Cosmos dataset sweeps |
| `tests/` | Worker, exporter and batch tests (stdlib unittest) |
| `DEPLOY.md`, `NOTICE` | Private deployment runbook, third-party notices |
| `README.md`, `LICENSE` | Docs, and MIT license with a third-party model notice |
