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

## Files

| File | Purpose |
|---|---|
| `index.html`, `styles.css`, `app.js` | PWA UI |
| `sw.js` | Service worker (app shell cache; never touches worker API traffic) |
| `manifest.json`, `icon.svg` | Install metadata and icon |
| `worker.py` | GPU-side job runner (Python 3.10+, stdlib only) |
| `README.md`, `LICENSE` | Docs, and MIT license with a third-party model notice |
