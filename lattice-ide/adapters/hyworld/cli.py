#!/usr/bin/env python3
"""Lattice -> Tencent HY-World 2.0 adapter.

    python3 -m adapters.hyworld.cli <pano|worldmirror|stereo|export> --model hy-world-2.0 --prompt P --out DIR
        [--input F ...] [--input-dir D] [--resolution WxH --seed N --export-target T --format F]
    python3 /path/to/lattice-ide/adapters/hyworld/cli.py ...      (same, runnable as a script)

Drives the scripts of a HY-World 2.0 checkout (github.com/Tencent-Hunyuan/HY-World-2.0) as
subprocesses, exactly as its README / DOCUMENTATION.md / hyworld2/worldgen/README.md show:

  pano        image -> 360 panorama (HY-Pano 2.0; hyworld2/panogen/pipeline_with_qwen_image.py or pipeline.py)
  worldmirror images / video -> 3DGS + point cloud (python -m hyworld2.worldrecon.pipeline)
  stereo      image/panorama -> pano -> WorldNav (traj_generate, traj_render) -> WorldStereo 2.0 (video_gen)
  export      stereo + gen_gs_data + world_gs_trainer -> scene.ply / scene.spz / scene_mesh.ply

Env: LATTICE_HY_ROOT (checkout; else derived from an importable `hyworld2`), LATTICE_HY_PYTHON
(interpreter of the HY env; default this python), LATTICE_HY_PANO_PYTHON (HY-Pano env; default
LATTICE_HY_PYTHON), LATTICE_HY_NPROC (GPUs for torchrun stages; default: all visible),
LATTICE_HY_LLM_ADDR / LATTICE_HY_LLM_PORT / LATTICE_HY_LLM_NAME (vLLM server with a VLM, required by
WorldNav), LATTICE_HY_KEEP_WORK=1 (keep intermediates), LATTICE_HY_SAVE_MAPS=1 (worldmirror depth/normal
PNGs), LATTICE_MODEL_MAP, HF_TOKEN (env only; never printed).
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

if __package__ in (None, ""):  # running as a script: make `adapters` importable
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from adapters.common import (  # noqa: E402
    EXIT_NO_GPU, EXIT_NOT_INSTALLED, EXIT_UPSTREAM, EXIT_USAGE, AdapterError, Progress, build_parser,
    child_env, image_size, media_inputs, parse_resolution, resolve_model, run_main, run_stream, say, write_json,
)

MODES = ["pano", "worldmirror", "stereo", "export"]
INSTALL_HINT = ("clone https://github.com/Tencent-Hunyuan/HY-World-2.0, follow its README 'Install Requirements' "
                "(conda env, requirements.txt, gsplat_maskgaussian, flash-attn; worldgen: requirements_git.txt + navmesh), "
                "then set LATTICE_HY_ROOT=<checkout> and LATTICE_HY_PYTHON=<that env's python>")
LLM_DEFAULT_NAME = "Qwen/Qwen3-VL-8B-Instruct"  # example model in hyworld2/worldgen/README.md
PANO_HI3_INSTRUCTION = "Expand this image to a 360-degree equirectangular panorama."  # README example wording
# world_gs_trainer max_steps per GPU count, from hyworld2/worldgen/README.md stage 5
GS_STEPS = {8: 1500, 4: 2000, 2: 4000, 1: 8000}


def hy_root() -> Path:
    r = os.environ.get("LATTICE_HY_ROOT")
    if r:
        p = Path(r).expanduser()
        if not (p / "hyworld2").is_dir():
            raise AdapterError(EXIT_NOT_INSTALLED, f"LATTICE_HY_ROOT={p} has no hyworld2/ package", INSTALL_HINT)
        return p
    try:
        spec = importlib.util.find_spec("hyworld2")
    except (ImportError, ValueError):
        spec = None
    if spec and spec.submodule_search_locations:
        return Path(list(spec.submodule_search_locations)[0]).resolve().parent
    raise AdapterError(EXIT_NOT_INSTALLED, "HY-World 2.0 checkout not found (set LATTICE_HY_ROOT)", INSTALL_HINT)


def visible_gpus() -> int:
    exe = shutil.which("nvidia-smi")
    if not exe:
        return 0
    try:
        out = subprocess.run([exe, "--query-gpu=name", "--format=csv,noheader"], capture_output=True, text=True, timeout=10)
        n = len([ln for ln in out.stdout.splitlines() if ln.strip()])
    except (OSError, subprocess.SubprocessError):
        return 0
    cvd = os.environ.get("CUDA_VISIBLE_DEVICES")
    if cvd not in (None, ""):
        n = min(n, len([x for x in cvd.split(",") if x.strip()])) if n else len(cvd.split(","))
    return n


def nproc() -> int:
    v = os.environ.get("LATTICE_HY_NPROC")
    if v:
        try:
            return max(1, int(v))
        except ValueError:
            raise AdapterError(EXIT_USAGE, "LATTICE_HY_NPROC must be an integer")
    return max(1, visible_gpus())


def is_panorama(path: Path) -> bool:
    wh = image_size(path)
    return bool(wh and wh[1] and 1.9 <= wh[0] / wh[1] <= 2.1)


def torchrun(py: str, n: int, script: list) -> list:
    if n <= 1:
        return [py, *script]
    return [py, "-m", "torch.distributed.run", f"--nproc_per_node={n}", *script]


# ---------------------------------------------------------------------------
# Translation (pure; `--plan` prints this)
# ---------------------------------------------------------------------------
def make_plan(args, entry: dict, root: Path) -> dict:
    mode = args.mode
    out = Path(args.out).resolve()
    py = os.environ.get("LATTICE_HY_PYTHON") or sys.executable
    pano_py = os.environ.get("LATTICE_HY_PANO_PYTHON") or py
    n = nproc()
    seed = args.seed if args.seed is not None else 42
    imgs, vids = media_inputs(args)
    wg = root / "hyworld2" / "worldgen"
    pg = root / "hyworld2" / "panogen"
    pp = [str(root)]
    work = out / "hy_work"
    scene = work / "scene"
    steps = []
    finals = []
    plan = {"schema": "lattice.adapter-plan/1", "engine": "hyworld", "mode": mode, "model": entry["id"],
            "repo": entry["repo"], "hy_root": str(root), "python": py, "nproc": n, "seed": seed,
            "images": [str(p) for p in imgs], "videos": [str(p) for p in vids],
            "export_target": args.export_target, "format": args.format, "work": str(work), "warnings": []}

    def pano_step(src: Path, dest: Path):
        backend = entry.get("pano_backend", "qwen")
        wh = parse_resolution(args.resolution)
        if backend == "qwen":
            argv = [pano_py, str(pg / "pipeline_with_qwen_image.py"), "--image", str(src), "--prompt", args.prompt or "",
                    "--seed", str(seed), "--save", str(dest),
                    "--pretrained-model-name-or-path", entry.get("pano_base", "Qwen/Qwen-Image-Edit-2509"),
                    "--lora-path", entry["repo"], "--lora-subfolder", entry.get("pano_subfolder", "HY-Pano-2.0")]
        elif backend == "hunyuan-image-3":
            prompt = f"{PANO_HI3_INSTRUCTION} {args.prompt}".strip() if args.prompt else None
            argv = [pano_py, str(pg / "pipeline.py"), "--image", str(src), "--seed", str(seed), "--save", str(dest),
                    "--pretrained-model-name-or-path", entry["repo"],
                    "--subfolder", entry.get("pano_subfolder", "HY-Pano-2.0")] + (["--prompt", prompt] if prompt else [])
        else:
            raise AdapterError(EXIT_USAGE, f"pano_backend {backend!r} must be qwen or hunyuan-image-3",
                               f"fix models.{entry['id']}.pano_backend in LATTICE_MODEL_MAP")
        if wh:
            argv += ["--width", str(wh[0]), "--height", str(wh[1])]
        return {"stage": "pano", "label": f"HY-Pano 2.0 ({backend})", "argv": argv, "cwd": str(pg), "pythonpath": pp}

    def need_image(what: str) -> Path:
        if not imgs:
            raise AdapterError(EXIT_USAGE, f"{what} needs an input image: HY-Pano 2.0's released code is image -> "
                                           "panorama only (text-only prompts are not supported upstream)",
                               "attach a photo (or run Cosmos generate --frames 1 first and use its image)")
        if len(imgs) > 1:
            plan["warnings"].append(f"{len(imgs)} images given; using {imgs[0].name}")
        return imgs[0]

    if mode == "pano":
        src = need_image("pano")
        steps.append(pano_step(src, out / "panorama.png"))
        finals = ["panorama.png"]
    elif mode == "worldmirror":
        if vids and not imgs:
            input_path = vids[0]
            stage_inputs = []
            if len(vids) > 1:
                plan["warnings"].append(f"{len(vids)} videos given; using {vids[0].name}")
        elif imgs:
            input_path = work / "inputs"
            stage_inputs = [str(p) for p in imgs]
            if vids:
                plan["warnings"].append("images and videos given; using the images")
        else:
            raise AdapterError(EXIT_USAGE, "worldmirror needs input images (multi-view) or a video")
        mw_out = out / "worldmirror"
        script = ["-m", "hyworld2.worldrecon.pipeline", "--input_path", str(input_path),
                  "--strict_output_path", str(mw_out), "--pretrained_model_name_or_path", entry["repo"],
                  "--subfolder", entry.get("worldmirror_subfolder", "HY-WorldMirror-2.0"), "--no_interactive"]
        if os.environ.get("LATTICE_HY_SAVE_MAPS") != "1":
            script += ["--no_save_depth", "--no_save_normal"]
        use_n = n if (stage_inputs and len(stage_inputs) >= n) else 1  # upstream: images >= GPUs
        if use_n > 1:
            script += ["--use_fsdp", "--enable_bf16"]
        steps.append({"stage": "3dgs", "label": "WorldMirror 2.0", "argv": torchrun(py, use_n, script),
                      "cwd": str(root), "pythonpath": pp, "stage_inputs": stage_inputs})
        finals = ["worldmirror/"]
    else:  # stereo / export: full world generation
        addr = os.environ.get("LATTICE_HY_LLM_ADDR")
        if not addr:
            raise AdapterError(EXIT_USAGE, f"{mode} needs a vLLM server hosting a VLM for WorldNav trajectory planning",
                               "start one (e.g. `vllm serve Qwen/Qwen3-VL-8B-Instruct --port 8000`) and set "
                               "LATTICE_HY_LLM_ADDR (and LATTICE_HY_LLM_PORT, LATTICE_HY_LLM_NAME)")
        llm = ["--llm_addr", addr, "--llm_port", os.environ.get("LATTICE_HY_LLM_PORT") or "8000",
               "--llm_name", os.environ.get("LATTICE_HY_LLM_NAME") or LLM_DEFAULT_NAME]
        src = need_image(mode)
        if is_panorama(src):
            steps.append({"stage": "pano", "label": "use input panorama",
                          "argv": [py, "-c", "import sys; from PIL import Image; "
                                             "Image.open(sys.argv[1]).convert('RGB').save(sys.argv[2])",
                                   str(src), str(scene / "panorama.png")], "cwd": str(root), "pythonpath": pp})
        else:
            steps.append(pano_step(src, scene / "panorama.png"))
        seed_a = ["--seed", str(seed)]
        steps.append({"stage": "worldnav", "label": "WorldNav traj_generate", "cwd": str(wg), "pythonpath": [*pp, str(wg)],
                      "argv": [py, "traj_generate.py", "--target_path", str(scene), *llm, "--apply_nav_traj",
                               "--apply_up_route", "--apply_recon_iteration", "--force_vlm", *seed_a]})
        steps.append({"stage": "worldnav", "label": "WorldNav traj_render", "cwd": str(wg), "pythonpath": [*pp, str(wg)],
                      "argv": torchrun(py, n, ["traj_render.py", "--target_path", str(scene), *llm, *seed_a])})
        mt = entry.get("worldstereo_model_type", "worldstereo-memory-dmd")
        steps.append({"stage": "worldstereo", "label": "WorldStereo 2.0 video_gen", "cwd": str(wg),
                      "pythonpath": [*pp, str(wg)],
                      "argv": torchrun(py, n, ["video_gen.py", "--target_path", str(scene), "--model_type", mt, *seed_a]
                                       + (["--fsdp"] if n > 1 else []))})
        plan["worldstereo_model_type"] = mt
        if mode == "stereo":
            finals = ["panorama.png", "stereo/"]
        else:
            steps.append({"stage": "3dgs", "label": "gen_gs_data", "cwd": str(wg), "pythonpath": [*pp, str(wg)],
                          "argv": torchrun(py, n, ["gen_gs_data.py", "--root_path", str(scene), "--result_name", mt,
                                                   "--save_normal", "--split_sky"])})
            key = max([k for k in GS_STEPS if k <= n] or [1])
            ms = GS_STEPS[key]
            f = ms / 1500  # README: scale max_steps and strategy steps together when using fewer GPUs
            sc = lambda v: str(max(1, int(round(v * f))))  # noqa: E731
            gs_out = work / "gs_result"
            steps.append({"stage": "3dgs", "label": "world_gs_trainer", "cwd": str(wg), "pythonpath": [*pp, str(wg)],
                          "argv": [py, "-m", "world_gs_trainer", "default", "--data_dir", str(scene / "gs_data"),
                                   "--result_dir", str(gs_out), "--max_steps", str(ms), "--save_steps", str(ms),
                                   "--eval_steps", str(ms), "--ply_steps", str(ms), "--save_ply", "--convert_to_spz",
                                   "--disable_video", "--use_scale_regularization", "--antialiased", "--depth_loss",
                                   "--normal_loss", "--sky_depth_from_pcd", "--use_mask_gaussian",
                                   "--mask_export_stochastic", "--no-mask-export-anchor-protection",
                                   "--use_anchor_protection", "--export_mesh",
                                   "--strategy.refine-start-iter", sc(150), "--strategy.refine-stop-iter", sc(750),
                                   "--strategy.refine-every", sc(100), "--strategy.refine-scale2d-stop-iter", sc(750),
                                   "--strategy.reset-every", "99990", "--strategy.grow-grad2d", "0.0001",
                                   "--strategy.prune-scale3d", "0.1"]})
            plan["gs_max_steps"] = ms
            finals = ["panorama.png", "scene.ply", "scene.spz", "scene_mesh.ply"]
    plan["steps"] = steps
    plan["outputs"] = finals
    return plan


# ---------------------------------------------------------------------------
# Execution
# ---------------------------------------------------------------------------
def check_env(plan: dict):
    """Interpreter has torch with CUDA (exit 2 / 3 otherwise)."""
    code = ("import sys\ntry:\n import torch\nexcept ImportError:\n sys.exit(12)\n"
            "sys.exit(0 if torch.cuda.is_available() else 13)")
    pys = {plan["python"]} | {s["argv"][0] for s in plan["steps"] if s.get("label", "").startswith("HY-Pano")}
    for py in sorted(pys):
        try:
            rc = subprocess.run([py, "-c", code], capture_output=True, timeout=120,
                                env=child_env(pythonpath=[plan["hy_root"]])).returncode
        except FileNotFoundError:
            raise AdapterError(EXIT_NOT_INSTALLED, f"HY-World interpreter not found: {py}", INSTALL_HINT)
        except subprocess.TimeoutExpired:
            raise AdapterError(EXIT_NOT_INSTALLED, f"{py} did not start within 120 s", INSTALL_HINT)
        if rc == 12:
            raise AdapterError(EXIT_NOT_INSTALLED, f"PyTorch is not installed for {py}", INSTALL_HINT)
        if rc == 13:
            raise AdapterError(EXIT_NO_GPU, f"CUDA is not available to PyTorch in {py}",
                               "check `nvidia-smi`; HY-World 2.0 needs NVIDIA GPUs (CUDA 12.8 recommended upstream)")
        if rc != 0:
            raise AdapterError(EXIT_NOT_INSTALLED, f"{py} failed to import torch (exit {rc})", INSTALL_HINT)


def stage_weights(plan) -> list:
    w = {"pano": 0.15, "worldnav": 0.2, "worldstereo": 0.35, "3dgs": 0.3}
    seen = []
    for s in plan["steps"]:
        if s["stage"] not in seen:
            seen.append(s["stage"])
    return [(s, w.get(s, 0.2)) for s in seen] + [("export", 0.03)]


def finalize(plan, out: Path) -> list:
    work = Path(plan["work"])
    scene = work / "scene"
    produced = []
    mode = plan["mode"]
    if mode in ("stereo", "export") and (scene / "panorama.png").exists():
        shutil.copy2(scene / "panorama.png", out / "panorama.png")
        produced.append(out / "panorama.png")
    if mode == "stereo":
        sd = out / "stereo"
        sd.mkdir(exist_ok=True)
        mt = plan.get("worldstereo_model_type", "worldstereo-memory-dmd")
        for v in sorted((scene / "render_results").rglob(f"{mt}_result.mp4")):
            rel = v.relative_to(scene / "render_results").parent.as_posix().replace("/", "_")
            dst = sd / f"{rel}.mp4"
            shutil.copy2(v, dst)
            produced.append(dst)
        if not any(p.suffix == ".mp4" for p in produced):
            raise AdapterError(EXIT_UPSTREAM, "WorldStereo produced no keyframe videos")
    if mode == "export":
        ply_dir = work / "gs_result" / "ply"

        def last(pattern):
            c = sorted(ply_dir.glob(pattern), key=lambda p: int(re.sub(r"\D", "", p.stem) or 0))
            return c[-1] if c else None
        pairs = [(last("point_cloud_*.ply"), "scene.ply"), (last("point_cloud_*.spz"), "scene.spz"),
                 ((ply_dir / "fuse_simplified.ply") if (ply_dir / "fuse_simplified.ply").exists()
                  else (ply_dir / "fuse_post.ply"), "scene_mesh.ply")]
        for src, name in pairs:
            if src and src.exists():
                shutil.copy2(src, out / name)
                produced.append(out / name)
        if not (out / "scene.ply").exists():
            raise AdapterError(EXIT_UPSTREAM, f"3DGS training produced no point_cloud_*.ply under {ply_dir}")
    if mode == "worldmirror":
        mw = out / "worldmirror"
        produced += sorted(p for p in mw.rglob("*") if p.suffix.lower() in (".ply", ".json", ".mp4"))
        if not (mw / "gaussians.ply").exists() and not (mw / "points.ply").exists():
            raise AdapterError(EXIT_UPSTREAM, f"WorldMirror wrote no gaussians.ply / points.ply under {mw}")
    if mode == "pano":
        if not (out / "panorama.png").exists():
            raise AdapterError(EXIT_UPSTREAM, "HY-Pano wrote no panorama.png")
        produced.append(out / "panorama.png")
    if os.environ.get("LATTICE_HY_KEEP_WORK") != "1" and work.exists():
        shutil.rmtree(work, ignore_errors=True)
    return produced


def main(argv) -> int:
    args = build_parser("adapters.hyworld.cli", MODES).parse_args(argv)
    os.environ["LATTICE_ADAPTER_MODEL"] = args.model
    entry = resolve_model(args.model, "hyworld")
    out = Path(args.out).resolve()
    root = hy_root() if not args.plan else (hy_root_or_placeholder())
    plan = make_plan(args, entry, root)
    if args.plan:
        print(json.dumps(plan, indent=2))
        return 0
    out.mkdir(parents=True, exist_ok=True)
    for w in plan["warnings"]:
        say(f"warning: {w}")
    prog = Progress(stage_weights(plan))
    prog.emit(0.0)
    say(f"hyworld {plan['mode']} with {plan['model']} ({plan['repo']}), {plan['nproc']} GPU(s), root {plan['hy_root']}")
    say("license: Tencent HY-World 2.0 Community License (not valid in the EU, UK or South Korea)")
    check_env(plan)
    t0 = time.time()
    for s in plan["steps"]:
        prog.stage(s["stage"])
        for f in s.get("stage_inputs") or []:
            d = Path(plan["work"]) / "inputs"
            d.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, d / Path(f).name)
        if plan["mode"] in ("stereo", "export"):
            Path(plan["work"], "scene").mkdir(parents=True, exist_ok=True)
        run_stream(s["argv"], cwd=s["cwd"], env=child_env(pythonpath=s.get("pythonpath")), prog=prog,
                   stage=s["stage"], model_id=plan["model"], label=s["label"])
    prog.stage("export")
    outputs = finalize(plan, out)
    write_json(out / "hyworld_result.json", {
        "schema": "lattice.adapter-result/1", "engine": "hyworld",
        "license": "Tencent HY-World 2.0 Community License (License.txt); outputs may not be used to improve other AI models",
        "plan": {k: v for k, v in plan.items() if k != "steps"},
        "stages": [{"stage": s["stage"], "label": s["label"]} for s in plan["steps"]],
        "wall_s": round(time.time() - t0, 2),
        "outputs": [p.relative_to(out).as_posix() for p in outputs if p.is_relative_to(out)]})
    prog.done()
    say("hyworld done")
    return 0


def hy_root_or_placeholder() -> Path:
    try:
        return hy_root()
    except AdapterError:
        return Path(os.environ.get("LATTICE_HY_ROOT") or "<LATTICE_HY_ROOT>")


def cli(argv=None) -> int:
    return run_main(main, argv)


if __name__ == "__main__":
    sys.exit(cli())
