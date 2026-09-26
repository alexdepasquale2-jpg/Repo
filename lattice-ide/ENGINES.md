# Engines: running Cosmos 3 and HY-World 2.0 for real

Lattice runs no model itself. With `LATTICE_EXEC=1` the worker starts an **engine command** for each job and passes the job's fields as arguments:

```
<LATTICE_COSMOS_CMD | LATTICE_HY_CMD> <mode> --model <lattice id> --prompt P --out RUN_DIR
    [--input FILE ...] [--input-dir DIR] [--frames N --fps N --resolution WxH --seed N
     --guidance F --steps N --export-target T --format F]
```

`adapters/` holds two CLIs that accept exactly those arguments and call the real upstream code:

| Adapter | Upstream it drives |
|---|---|
| `adapters/cosmos/cli.py` | NVIDIA Cosmos 3. Uses Diffusers `Cosmos3OmniPipeline` for generate, edge and action, and Transformers for reason. Optionally uses `cosmos_framework.scripts.inference` (Cosmos Framework). |
| `adapters/hyworld/cli.py` | The scripts in a Tencent HY-World 2.0 checkout: HY-Pano 2.0, WorldNav, WorldStereo 2.0, WorldMirror 2.0 and 3DGS training |
| `adapters/doctor.py` | A readiness report: GPUs, torch/CUDA, packages, model map, HF token (yes/no), disk, and which models fit |

The adapters use only the standard library. They import the upstream libraries only while a job runs, inside whichever interpreter you point them at. They print `PROGRESS x` lines that the worker turns into the progress bar. They write outputs into the run directory, and the worker picks those up by extension: `.mp4` is a video, `.ply` or `.spz` is a splat, `.png` is an image, and `.json` or `.txt` is data. A `<engine>_result.json` file records what ran.

**Weights and licenses.** Lattice never bundles or downloads weights on its own. The upstream libraries fetch weights from Hugging Face on the first run, using *your* account and token, after *you* have accepted each model's terms. You can also point the model map at local directories.

Sources were checked on **2026-09-26**. Anything marked *(unverified)* could not be confirmed from an upstream source. Check it before relying on it.

---

## 1. Quick setup

```sh
# 1. Install the engine(s) into their own environments (sections 2 and 3).
# 2. Check the box:
cd /opt/lattice            # the lattice-ide directory
/opt/cosmos/.venv/bin/python -m adapters.doctor      # or: python3 -m adapters.doctor --json
# 3. Point the worker at the adapters (e.g. in /etc/lattice/worker.env):
LATTICE_EXEC=1
LATTICE_COSMOS_CMD="/opt/cosmos/.venv/bin/python /opt/lattice/adapters/cosmos/cli.py"
LATTICE_HY_CMD="/opt/hyworld/env/bin/python /opt/lattice/adapters/hyworld/cli.py"
LATTICE_COSMOS_MODULE=adapters.cosmos      # see "Engine detection" below
LATTICE_HY_MODULE=adapters.hyworld
LATTICE_HY_ROOT=/opt/HY-World-2.0
LATTICE_HY_PYTHON=/opt/hyworld/env/bin/python
```

**Why the script path?** The worker starts engines with the run directory as the working directory, so the form `python -m adapters.cosmos.cli` only works if `adapters` can be imported: either `PYTHONPATH=/opt/lattice` or a pip install that ships the package. The script form (`python /opt/lattice/adapters/cosmos/cli.py`) adds its own parent directory to the import path, so it always works. Use the Python from the **engine's** environment. The two engines need different environments: HY-World pins `torch==2.7.1` and `diffusers==0.36.0`, while Cosmos 3 needs Diffusers from `main`.

**Engine detection.** Before running for real, the worker checks `importlib.util.find_spec(LATTICE_*_MODULE)` in the worker's own interpreter. If the check fails, the job runs as a dry run instead.
- If the worker runs inside the engine's environment, set this to the real upstream package: `LATTICE_COSMOS_MODULE=diffusers` (or `cosmos_framework`) and `LATTICE_HY_MODULE=hyworld2` (with `PYTHONPATH=$LATTICE_HY_ROOT`).
- If the engines live in separate environments (the usual case), set `LATTICE_COSMOS_MODULE=adapters.cosmos` and `LATTICE_HY_MODULE=adapters.hyworld`. Detection then only proves the adapter is there. If the upstream package is actually missing, the job fails with exit code 2 and an install hint, instead of quietly doing a dry run. Run `adapters.doctor` with each engine's Python to check.

### Environment variables used by the adapters

| Variable | Default | Meaning |
|---|---|---|
| `LATTICE_MODEL_MAP` | built-in | JSON file overriding the Lattice id → checkpoint map (section 4) |
| `LATTICE_COSMOS_BACKEND` | `diffusers` | `diffusers`, or `framework` (runs `torchrun -m cosmos_framework.scripts.inference`; generate/edge only) |
| `LATTICE_COSMOS_GUARDRAILS` | `1` | `0` disables NVIDIA's guardrail (`enable_safety_checker=False` / `--no-guardrails`) |
| `LATTICE_COSMOS_OFFLOAD` | `none` | `model` or `sequential`: calls Diffusers `enable_model_cpu_offload()` / `enable_sequential_cpu_offload()` *(unverified for Cosmos3OmniPipeline)* |
| `LATTICE_COSMOS_NEGATIVE_PROMPT` | unset | Negative prompt for video tasks |
| `LATTICE_COSMOS_MAX_NEW_TOKENS` | `1024` | Reason mode generation length |
| `LATTICE_COSMOS_NPROC` / `LATTICE_COSMOS_FRAMEWORK_DIR` | `1` / unset | Framework backend: number of GPUs and checkout working directory |
| `LATTICE_HY_ROOT` | from an importable `hyworld2` | HY-World 2.0 checkout |
| `LATTICE_HY_PYTHON` / `LATTICE_HY_PANO_PYTHON` | adapter's Python | Interpreter(s) for the HY scripts. HY-Pano documents its own environment. |
| `LATTICE_HY_NPROC` | all visible GPUs | GPUs for the `torchrun` stages |
| `LATTICE_HY_LLM_ADDR` / `_PORT` / `_NAME` | – / `8000` / `Qwen/Qwen3-VL-8B-Instruct` | vLLM server that WorldNav needs (stereo/export modes) |
| `LATTICE_HY_KEEP_WORK` / `LATTICE_HY_SAVE_MAPS` | `0` / `0` | Keep `hy_work/` intermediates / keep WorldMirror depth and normal PNGs |

The worker hands each engine `HF_TOKEN` and `HUGGING_FACE_HUB_TOKEN` only when the job came with an `X-HF-Token` header. The adapters pass the token to `from_pretrained(..., token=...)`, never print it, and redact it from any error text. If jobs are sent without a token, the weights must already be in the Hugging Face cache of the user the worker runs as. To fill the cache, run `hf auth login` followed by a first manual run or `hf download`.

---

## 2. NVIDIA Cosmos 3

**What it is.** Cosmos 3 (released May 2026) is NVIDIA's family of "omnimodal" world models. One Mixture-of-Transformers architecture acts as both a **Reasoner** (text/vision → text) and a **Generator** (text/image/video/action → video, sound and actions). It comes in three base sizes, plus post-trained example checkpoints.

**Verified sources**
- https://github.com/NVIDIA/cosmos, main @ `77ef1929` (2026-09-23): `README.md`, `docs/reference/models.md`, `cookbooks/cosmos3/README.md` (environment setup), `cookbooks/cosmos3/generator/audiovisual/README.md` and `run_with_diffusers.ipynb`, `cookbooks/cosmos3/generator/action/README.md` and `run_policy_with_diffusers.ipynb`, `cookbooks/cosmos3/reasoner/README.md`, `cookbooks/cosmos3/nim/support-matrix.md`, `inference_benchmarks.md`
- https://github.com/NVIDIA/cosmos-framework, HEAD `cf5d68c0`: `README.md` (inference entry point `cosmos_framework.scripts.inference`)
- Hugging Face collection https://huggingface.co/collections/nvidia/cosmos3. This was linked from the repos above; the Hugging Face pages themselves could not be fetched from the research sandbox.

### Lattice id → checkpoint (built-in map)

| Lattice id | Checkpoint | Notes |
|---|---|---|
| `cosmos3-edge-4b` | `nvidia/Cosmos3-Edge` | 4B. Validated for 256p/480p and 50–150 frames only. Diffusers defaults are 832×480, 121 frames, 20 steps, guidance 5.0, flow_shift 8.0. Reason mode uses `AutoModelForImageTextToText`, which needs Transformers from `main`. |
| `cosmos3-nano-16b` | `nvidia/Cosmos3-Nano` | 16B. Defaults are 1280×720, 189 frames, 24 fps, 35 steps, guidance 6.0, flow_shift 10.0. Reason mode uses `Cosmos3OmniForConditionalGeneration` (Transformers ≥ 5.11). |
| `cosmos3-super-64b` | `nvidia/Cosmos3-Super` | 64B. Same defaults as Nano. |
| `cosmos3-i2v` | `nvidia/Cosmos3-Nano`, run image→video | This is **Lattice's own interpretation**: Nano does i2v, and a job without an image is rejected. NVIDIA's post-trained `nvidia/Cosmos3-Super-Image2Video(-4Step)` can be used by override. For `-4Step`, also set `"distilled": true`. |
| `cosmos3-droid-policy` | `nvidia/Cosmos3-Nano-Policy-DROID` | Policy mode with settings from NVIDIA's notebook: `domain_name=droid_lerobot`, `chunk_size=16`, `resolution_tier=480`, `view_point=concat_view`, 15 fps, 30 steps, guidance 1.0, flow_shift 5.0. `nvidia/Cosmos3-Edge-Policy-DROID` exists, but NVIDIA documents it only through the `cosmos_framework.scripts.action_policy_server_robolab` server, so it is not the default. |

### What each Lattice mode does

| Mode | Upstream call | Output files |
|---|---|---|
| `generate` | `Cosmos3OmniPipeline(...)`. With no media it is text→video; with an image, image→video; with a video, video→video (`condition_frame_indexes_vision=[0,1]`); `--frames 1` gives text→image. | `rollout.mp4` (or `image.png`), `cosmos_result.json` |
| `edge` | Same as `generate`, but clamped to the Edge envelope (≤ 832×480, ≤ 121 frames) | same |
| `action` | `Cosmos3OmniPipeline(action=CosmosActionCondition(mode="policy", ...))`. The input is one pre-composited frame, or three images (wrist, exterior 1, exterior 2) that the adapter tiles onto a 640×540 canvas the way NVIDIA's notebook does. Forward and inverse dynamics need raw action trajectories that Lattice jobs don't carry, so they are rejected. | `rollout.mp4`, `actions.json` (model-normalized space), `policy_input.png` |
| `reason` | Transformers `AutoProcessor` with `apply_chat_template`, then `generate` (image/video blocks; video sampled at 2 fps) | `reasoning.json`, `reasoning.txt` |

A prompt that starts with `{` is treated as NVIDIA's structured JSON prompt, and the call adds `add_resolution_template=False, add_duration_template=False`, as the cookbooks do. Plain-text prompts use the pipeline defaults, like NVIDIA's quickstart. Parameters outside the documented envelope still run, but log a `warning:` line. The documented envelope is 256p/480p/720p, 5–300 frames (Edge 50–150), and 10/16/24/30 fps. Progress is reported per denoising step when the pipeline accepts `callback_on_step_end`; otherwise per stage (load, infer, encode).

### Install

Prerequisites (from NVIDIA): Linux; an NVIDIA GPU (Ampere, Hopper or Blackwell); `uv`, `git` and `git-lfs`; Hugging Face access to the gated Cosmos 3 repos **and** to the gated guardrail repo [`nvidia/Cosmos-1.0-Guardrail`](https://huggingface.co/nvidia/Cosmos-1.0-Guardrail). The guardrail is on by default for generation.

**RTX workstation or datacenter (Diffusers backend, used for generate/edge/action):**
```sh
uv venv /opt/cosmos/.venv --python 3.13 --seed --managed-python && . /opt/cosmos/.venv/bin/activate
uv pip install --torch-backend=cu130 \
  "diffusers @ git+https://github.com/huggingface/diffusers.git" \
  accelerate av cosmos_guardrail huggingface_hub imageio imageio-ffmpeg torch torchvision transformers
#   use --torch-backend=cu128 on a CUDA 12.x driver
```
**Reason mode:** install `"transformers>=5.11.0"` (Nano/Super). Cosmos3-Edge needs `transformers @ git+https://github.com/huggingface/transformers.git`.
**Multi-GPU / Super (Cosmos Framework backend):**
```sh
git clone https://github.com/NVIDIA/cosmos-framework.git /opt/cosmos-framework && cd /opt/cosmos-framework
GIT_LFS_SKIP_SMUDGE=1 uv sync --all-extras --group=cu130-train     # or cu128-train
apt-get install -y --no-install-recommends curl ffmpeg git-lfs libgl1 libglib2.0-0 libx11-dev libxcb1 tree wget
# LATTICE_COSMOS_CMD="/opt/cosmos-framework/.venv/bin/python /opt/lattice/adapters/cosmos/cli.py"
# LATTICE_COSMOS_BACKEND=framework LATTICE_COSMOS_NPROC=4 LATTICE_COSMOS_FRAMEWORK_DIR=/opt/cosmos-framework
```
Inside NVIDIA's NGC PyTorch container, clear `LD_LIBRARY_PATH` after activating the virtual environment (NVIDIA FAQ).
**Jetson (AGX Orin / Thor):** NVIDIA lists Cosmos3-Edge for Jetson AGX Orin/Thor and benchmarks the Edge Reasoner with plain Transformers on Jetson AGX Thor. A Jetson install recipe for the Diffusers generator is *(unverified)*. Use JetPack's CUDA-enabled PyTorch, install the same Python packages, and start with `reason` / `edge` on `cosmos3-edge-4b`. Run `adapters.doctor` first: on Jetson it reads unified memory from `/proc/meminfo`.

**Serving alternatives** (not wired into Lattice): vLLM / vLLM-Omni, TensorRT-LLM, SGLang, and the NVIDIA NIM containers `nvcr.io/nim/nvidia/cosmos3-generator` and `cosmos3-reasoner` (NGC key). They expose OpenAI-compatible HTTP APIs. An HTTP adapter would be a small follow-up.

### Weights and license

- Weights download on first use from the repos above into `~/.cache/huggingface`, or into `$HF_HOME`. They need a Hugging Face account that has accepted each gated repo's terms. Nano plus CUDA dependencies take "tens of GiB" (NVIDIA). Lattice never ships them.
- **License: OpenMDW-1.1** ("Source code and models are released under OpenMDW-1.1", NVIDIA/cosmos README; text at https://openmdw.ai/license/1-1/). Summary, not legal advice: commercial use is allowed, notices must be kept, and outputs are unrestricted. Runs get `NOTICE-Cosmos.txt`.
- The guardrail repo `nvidia/Cosmos-1.0-Guardrail` is gated and has its own access conditions. Its exact license text is *(unverified)*: read it on Hugging Face.

### Memory (single GPU, BF16)

| Model | Generator | Reasoner | Source |
|---|---|---|---|
| Edge 4B | ~24 GiB *(estimate, unverified)* | Benchmarked on Jetson Thor T2000 16 GB and RTX PRO 4500 32 GB | NVIDIA `inference_benchmarks.md` (Reasoner); generator estimate is ours |
| Nano 16B / I2V | 58 GiB resident; 31 GiB with layer offload | 23.1 GiB | NVIDIA NIM support matrix* |
| Super 64B | 150 GiB resident (multi-GPU); 93 GiB with model offload; 42 GiB with layer offload | 135 GiB TP1 / 73 GiB TP2 | NVIDIA NIM support matrix* |
| Nano-Policy-DROID | ~Nano *(estimate)*; NVIDIA: "runs on RTX Pro 6000" | – | NVIDIA README |

\* The NIM figures are for NVIDIA's NIM runtime. Plain Diffusers may differ. Lattice's feasibility rules (Super needs a datacenter; Nano needs RTX or a datacenter) agree with these numbers.

### First real Cosmos job

1. `python -m adapters.doctor` using the Cosmos environment's Python. `cosmos3-edge-4b` should show `can run: yes`.
2. Warm the cache: `HF_TOKEN=hf_... /opt/cosmos/.venv/bin/python /opt/lattice/adapters/cosmos/cli.py generate --model cosmos3-edge-4b --prompt "A mobile robot navigates a warehouse aisle" --out /tmp/c1 --frames 121 --resolution 832x480 --seed 0`. This writes `/tmp/c1/rollout.mp4`. Add `--plan` first to see the resolved call without running anything.
3. Start the worker with `LATTICE_EXEC=1` and the variables from section 1. On the phone, open Cosmos → Generate, pick Edge 4B, and send the job. The worker log shows `stage load` / `stage infer`, and the job ends with a `rollout.mp4` video artifact.

---

## 3. Tencent HY-World 2.0

**What it is.** HY-World 2.0 is a multimodal *3D* world model. **World generation** turns text or a single image into a navigable 3DGS or mesh world in four stages: HY-Pano 2.0 panorama → WorldNav trajectory planning → WorldStereo 2.0 world expansion → WorldMirror 2.0 and 3DGS composition. **World reconstruction** turns multi-view images or a video into 3DGS, a point cloud, depth, normals and cameras, using WorldMirror 2.0 in one forward pass.

**Verified sources**
- https://github.com/Tencent-Hunyuan/HY-World-2.0, main @ `df9988eb` (2026-08-13): `README.md`, `DOCUMENTATION.md`, `License.txt`, `hyworld2/panogen/README.md` and `pipeline*.py` argparse, `hyworld2/worldgen/README.md` and the script argparse, `hyworld2/worldrecon/pipeline.py` argparse
- Weights: `tencent/HY-World-2.0` (subfolders `HY-WorldMirror-2.0` and `HY-Pano-2.0`) and `hanshanxue/WorldStereo` (WorldStereo 2.0; the code downloads it automatically). HY-Pano's lighter backend loads `Qwen/Qwen-Image-Edit-2509` plus the HY-Pano LoRA; its license (Qwen's) is separate and *(unverified here)*.
- Release timeline (README): WorldMirror 2.0 on 2026-04-16, HY-Pano 2.0 on 2026-05-11, world generation code and WorldStereo 2.0 on 2026-05-18, and HY World 2.1 as a product update in July 2026. No open 2.1 weights were found.

### What each Lattice mode does

| Mode | Upstream (run in `LATTICE_HY_ROOT`) | Output files |
|---|---|---|
| `pano` | `hyworld2/panogen/pipeline_with_qwen_image.py --image ... --prompt ... --seed ... --save panorama.png`. Set `"pano_backend": "hunyuan-image-3"` to use `pipeline.py` (the full HunyuanImage-3 backend, ~80B). **Needs an input image**: the released code is image→panorama only. | `panorama.png` |
| `worldmirror` | `python -m hyworld2.worldrecon.pipeline --input_path <images or video> --strict_output_path worldmirror --no_interactive`. With N > 1 GPUs and at least N images, it runs under `torchrun` with `--use_fsdp --enable_bf16`. | `worldmirror/gaussians.ply`, `points.ply`, `camera_params.json` |
| `stereo` | pano (skipped if the input is already about 2:1) → `traj_generate.py` → `traj_render.py` → `video_gen.py` (`worldstereo-memory-dmd`) | `panorama.png`, `stereo/*.mp4` keyframe videos |
| `export` | stereo, then `gen_gs_data.py --save_normal --split_sky`, then `python -m world_gs_trainer default ... --save_ply --convert_to_spz --export_mesh`, with the README's flags | `scene.ply` (3DGS), `scene.spz`, `scene_mesh.ply` (TSDF mesh). If `export_target` is set, the worker then builds the Unity/Unreal/Isaac bundle. |
| Bridge `hy-freeze` | `worldmirror` on the Cosmos keyframes, or on the rollout video if ffmpeg is missing | same as `worldmirror` |

The upstream README gives `world_gs_trainer` training steps per GPU count: 8 GPUs → 1500, 4 → 2000, 2 → 4000, 1 → 8000. It says to "increase max_steps and strategy steps proportionally". The adapter scales the refine-start, refine-stop, refine-every and refine-scale2d-stop iterations by the same factor; that scaling is our reading of that sentence. Intermediate files live in `RUN_DIR/hy_work/` and are deleted at the end unless `LATTICE_HY_KEEP_WORK=1`. Progress is reported per stage, and within a stage it comes from the upstream `tqdm` bars.

### Install (from the upstream README; CUDA 12.8 and Python 3.11+ recommended)

```sh
git clone https://github.com/Tencent-Hunyuan/HY-World-2.0 /opt/HY-World-2.0 && cd /opt/HY-World-2.0
conda create -n hyworld2 python=3.11.15 && conda activate hyworld2
pip install -r requirements.txt
(cd hyworld2/worldgen/third_party/gsplat_maskgaussian && pip install -e . --no-build-isolation)
pip install flash-attn --no-build-isolation          # or FlashAttention-3 on Hopper (see README)
# world generation (stereo/export) extras:
pip install --no-build-isolation -r requirements_git.txt
git submodule update --init --recursive
(cd hyworld2/worldgen/third_party/navmesh && pip install . --no-build-isolation)
# HY-Pano 2.0 documents its own env (python 3.10, torch 2.7.1) in hyworld2/panogen/README.md;
# point LATTICE_HY_PANO_PYTHON at it if you keep it separate.
```
WorldNav (stereo/export) also needs a **vLLM server hosting a VLM**. For example, the upstream README uses `vllm serve Qwen/Qwen3-VL-8B-Instruct --port 8000 --trust-remote-code --max-model-len 32768`. Set `LATTICE_HY_LLM_ADDR`, `LATTICE_HY_LLM_PORT` and `LATTICE_HY_LLM_NAME` to match.

- **RTX:** `pano` and `worldmirror` run on one GPU. Full world generation (stereo/export) is documented as "≥4 GPUs recommended (tested with 8× H20)". A single card can try it with `LATTICE_HY_NPROC=1` (8000 training steps), but that setup is *(unverified)*.
- **Datacenter:** use the multi-GPU path. `LATTICE_HY_NPROC` defaults to the number of visible GPUs; use `CUDA_VISIBLE_DEVICES` to pick them.
- **Jetson:** not supported by Lattice (the feasibility rules exclude HY-World on Jetson). Upstream documents no Jetson path.

### Weights and license

- Weights download from Hugging Face on first run. Local paths also work: set `repo`, `pano_base` and so on in the model map. Lattice never ships them.
- **License: Tencent HY-World 2.0 Community License Agreement** (`License.txt`, release date April 15, 2026). Lattice does not relicense it. Key terms (summary, not legal advice):
  - The license **does not apply in the European Union, the United Kingdom or South Korea**. The Works, the Output and the results may not be used or displayed outside the Territory (§5(c)).
  - Outputs may not be used to improve any other AI model (§5(b)).
  - Anyone you pass it on to must get the license and the NOTICE (§3).
  - Over 1M monthly active users requires a license from Tencent (§4).
  - The worker's `LATTICE_REGION` / `license.territory` gate and `NOTICE-HY-World.txt` enforce Lattice's side of this.

### Memory

| Stage | Parameters | Memory | Source |
|---|---|---|---|
| WorldMirror 2.0 | ~1.2B | ~12–24 GB on one GPU *(unverified: third-party guide docs.clore.ai; upstream issue #2 asking about VRAM had no answer)* | README (params) |
| HY-Pano 2.0 (Qwen backend) | base Qwen-Image-Edit-2509 + ~425M LoRA | *(unverified)* | README |
| HY-Pano 2.0 (HunyuanImage-3) | ~80B | multi-GPU class *(unverified)* | README |
| WorldStereo 2.0 | ~17B | ≥4 GPUs recommended; tested on 8× H20 (96 GB each) | worldgen README |

### First real HY-World job

1. Run `LATTICE_HY_ROOT=/opt/HY-World-2.0 /opt/hyworld/env/bin/python -m adapters.doctor`. It should report `hyworld ready=yes cuda=yes`.
2. Run `.../python /opt/lattice/adapters/hyworld/cli.py worldmirror --model hy-world-2.0 --out /tmp/h1 --input-dir /opt/HY-World-2.0/examples/worldrecon/realistic/Desk`. This writes `/tmp/h1/worldmirror/gaussians.ply`.
3. On the phone, open HY-World → WorldMirror, attach 2 or more photos, and send. Or open HY-World → Export with a single photo (needs the vLLM server) and an export target, which gets you the scene plus a Unity/Unreal/Isaac bundle.

---

## 4. Model map overrides

Each Lattice id maps to a checkpoint through a built-in table (`adapters/common.py`, `DEFAULT_MODEL_MAP`). To override it, point `LATTICE_MODEL_MAP` at a JSON file. Entries are merged field by field, with `defaults`, `action` and `limits` merged one level deeper. `null` removes an entry, and a job for a removed or unknown id then fails fast (exit 5), naming the key to set.

```json
{"models": {
  "cosmos3-nano-16b":  {"repo": "/models/Cosmos3-Nano", "defaults": {"steps": 20}},
  "cosmos3-i2v":       {"repo": "nvidia/Cosmos3-Super-Image2Video-4Step", "distilled": true, "min_vram_gib": 150},
  "cosmos3-droid-policy": {"repo": "/models/my-droid-finetune"},
  "hy-world-2.0":      {"pano_backend": "hunyuan-image-3", "repo": "/models/HY-World-2.0"}
}}
```
Fields: `repo` (Hugging Face id or local path), `framework_checkpoint`, `reasoner_class`, `distilled`, `require_image`, `defaults{width,height,frames,fps,steps,guidance,flow_shift}`, `limits`, `action{mode,domain_name,chunk_size,resolution_tier,view_point,fps,concat_size}`, `min_vram_gib` (used by doctor), and for HY-World `worldmirror_subfolder`, `pano_backend`, `pano_base`, `pano_subfolder`, `worldstereo_model_type`.

---

## 5. Troubleshooting by exit code

When an engine fails, the job shows `... exited with code N: <last line>`, and the full log is in `runs/<id>/log.txt`.

| Code | Meaning | What to do |
|---|---|---|
| 1 | The upstream code ran and failed | Read the traceback in the job log. Common causes: a gated repo not accepted (`401`/`403` → accept the terms on Hugging Face and send the job with an HF token, or fill the cache), no disk space, or a bad input file. |
| 2 | Upstream not installed | The `hint:` line gives the install command. Check that `LATTICE_*_CMD` uses the engine environment's Python and that `LATTICE_HY_ROOT` is correct. `diffusers` without `Cosmos3OmniPipeline` means you need Diffusers from `main`. |
| 3 | No CUDA GPU | `nvidia-smi` must work for the worker's user. Also check for a CPU-only torch build (`python -c 'import torch; print(torch.cuda.is_available())'`), and for containers started without `--gpus all` / the NVIDIA runtime. |
| 4 | Out of GPU memory | Use a smaller model (Edge 4B), fewer frames or lower resolution, try `LATTICE_COSMOS_OFFLOAD=model`, use the multi-GPU framework backend, or run on the datacenter target. For HY world generation, use more GPUs. |
| 5 | Bad arguments or configuration | Missing input image (i2v, pano, policy), no vLLM server for WorldNav, an unmapped model, or a broken `LATTICE_MODEL_MAP`. The message names the variable or key to set. |
| 127 | Worker could not start the command | Fix the `LATTICE_*_CMD` path. |

If `python -m adapters.doctor` (add `--json` for machines) exits 0, at least one Lattice model can run on this box. It exits 1 otherwise.

## 6. Tests

`tests/test_adapters.py` runs without a GPU. Fake `torch` and `diffusers` packages and a fake HY-World checkout are generated into a temp directory. The tests cover argument parsing, parameter translation for every mode, model-map overrides, exit codes 2, 3, 4 and 5, the progress-line format, `doctor --json`, and the worker end to end (`LATTICE_EXEC=1` → adapter → fake upstream → `rollout.mp4` / `gaussians.ply` artifacts and a Bridge bundle). They do **not** prove that the real upstream calls work; only a GPU run can do that. On first contact with a real GPU box, run step 2 of each walkthrough by hand.
