#!/usr/bin/env python3
"""Lattice -> NVIDIA Cosmos 3 adapter.

    python3 -m adapters.cosmos.cli <reason|generate|action|edge> --model <lattice id> --prompt P --out DIR
        [--input F ...] [--input-dir D] [--frames N --fps N --resolution WxH --seed N --guidance F --steps N]
    python3 /path/to/lattice-ide/adapters/cosmos/cli.py ...      (same, runnable as a script)

Backends (all documented upstream in github.com/NVIDIA/cosmos cookbooks/cosmos3):
  generate / edge : Diffusers `Cosmos3OmniPipeline` (text->video, image->video, video->video,
                    text->image when --frames 1). LATTICE_COSMOS_BACKEND=framework runs
                    `torchrun -m cosmos_framework.scripts.inference` instead.
  action          : Diffusers `Cosmos3OmniPipeline` + `CosmosActionCondition(mode="policy")`
                    (Cosmos3-Nano-Policy-DROID); writes rollout.mp4 + actions.json.
  reason          : Transformers `Cosmos3OmniForConditionalGeneration` (Nano/Super) or
                    `AutoModelForImageTextToText` (Edge); writes reasoning.json + reasoning.txt.

Env: LATTICE_MODEL_MAP (JSON overrides), LATTICE_COSMOS_BACKEND (diffusers|framework),
LATTICE_COSMOS_GUARDRAILS (1 default; 0 disables NVIDIA's guardrail), LATTICE_COSMOS_OFFLOAD
(none|model|sequential), LATTICE_COSMOS_NEGATIVE_PROMPT, LATTICE_COSMOS_MAX_NEW_TOKENS (reason, 1024),
LATTICE_COSMOS_NPROC (framework GPUs, 1), LATTICE_COSMOS_FRAMEWORK_DIR (framework checkout cwd),
HF_TOKEN (read from env only; never printed).
"""
from __future__ import annotations

import importlib.util
import inspect
import json
import os
import sys
import time
from pathlib import Path

if __package__ in (None, ""):  # running as a script: make `adapters` importable
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from adapters.common import (  # noqa: E402
    EXIT_NO_GPU, EXIT_NOT_INSTALLED, EXIT_USAGE, AdapterError, Progress, build_parser, child_env,
    media_inputs, parse_resolution, resolve_model, run_main, run_stream, say, write_json,
)

MODES = ["reason", "generate", "action", "edge"]
EDGE_FALLBACK = {"width": 832, "height": 480, "frames": 121}  # Edge-friendly envelope for "edge" mode
DIFFUSERS_HINT = ('install the Diffusers backend (NVIDIA cookbooks/cosmos3/README.md#diffusers): '
                  'uv pip install --torch-backend=auto "diffusers @ git+https://github.com/huggingface/diffusers.git" '
                  "accelerate av cosmos_guardrail huggingface_hub imageio imageio-ffmpeg torch torchvision transformers")
TRANSFORMERS_HINT = ('install the Transformers backend (cookbooks/cosmos3/README.md#transformers): '
                     'uv pip install --torch-backend=auto accelerate av pillow "transformers>=5.11.0" torch torchvision '
                     '(Cosmos3-Edge needs transformers from git main)')
FRAMEWORK_HINT = ("clone https://github.com/NVIDIA/cosmos-framework and `uv sync --all-extras --group=cu130-train`, "
                  "then run the adapter with that venv's python")
ASPECTS = {"16,9": 16 / 9, "4,3": 4 / 3, "1,1": 1.0, "3,4": 3 / 4, "9,16": 9 / 16}


def env_flag(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    return default if v in (None, "") else v.strip().lower() not in ("0", "false", "no", "off")


# ---------------------------------------------------------------------------
# Translation (pure; `--plan` prints this)
# ---------------------------------------------------------------------------
def make_plan(args, entry: dict) -> dict:
    mode = args.mode
    backend = (os.environ.get("LATTICE_COSMOS_BACKEND") or "diffusers").strip().lower()
    if backend not in ("diffusers", "framework"):
        raise AdapterError(EXIT_USAGE, f"LATTICE_COSMOS_BACKEND={backend!r} must be diffusers or framework")
    imgs, vids = media_inputs(args)
    d = dict(entry.get("defaults") or {})
    warnings = []
    plan = {"schema": "lattice.adapter-plan/1", "engine": "cosmos", "mode": mode, "model": entry["id"],
            "repo": entry["repo"], "backend": backend, "distilled": bool(entry.get("distilled")),
            "guardrails": env_flag("LATTICE_COSMOS_GUARDRAILS", True),
            "offload": (os.environ.get("LATTICE_COSMOS_OFFLOAD") or "none").strip().lower(),
            "images": [str(p) for p in imgs], "videos": [str(p) for p in vids], "warnings": warnings}
    seed = args.seed if args.seed is not None else 0

    if mode == "reason":
        if not entry.get("reasoner_class"):
            raise AdapterError(EXIT_USAGE, f"model {entry['id']!r} has no reasoner",
                               f'set models.{entry["id"]}.reasoner_class in LATTICE_MODEL_MAP, or use cosmos3-nano-16b')
        if not args.prompt and not imgs and not vids:
            raise AdapterError(EXIT_USAGE, "reason mode needs a --prompt and/or an input image or video")
        plan.update(task="reason", backend="transformers", reasoner_class=entry["reasoner_class"],
                    max_new_tokens=int(os.environ.get("LATTICE_COSMOS_MAX_NEW_TOKENS") or 1024),
                    video_fps=2, outputs=["reasoning.json", "reasoning.txt"])
        return plan

    if mode == "action":
        act = entry.get("action")
        if not act:
            raise AdapterError(EXIT_USAGE, f"model {entry['id']!r} has no action/policy configuration",
                               f'use cosmos3-droid-policy, or set models.{entry["id"]}.action '
                               '({"mode":"policy","domain_name":...,"chunk_size":...,"resolution_tier":...,'
                               '"view_point":...}) in LATTICE_MODEL_MAP')
        if act.get("mode", "policy") != "policy":
            raise AdapterError(EXIT_USAGE, f"action mode {act.get('mode')!r} needs raw action trajectories, "
                                           "which Lattice jobs do not carry; only mode=policy is supported")
        if not imgs and not vids:
            raise AdapterError(EXIT_USAGE, "action (policy) mode needs a start frame: one pre-composited "
                                           "image, three camera images (wrist, exterior 1, exterior 2) or a video")
        if backend == "framework":
            warnings.append("framework backend does not run one-shot policy jobs (it serves a policy server); using diffusers")
        fps = args.fps or act.get("fps") or d.get("fps", 15)
        plan.update(task="policy", backend="diffusers", action=dict(act), fps=fps,
                    steps=args.steps or d.get("steps", 30),
                    guidance=args.guidance if args.guidance is not None else d.get("guidance", 1.0),
                    flow_shift=d.get("flow_shift", 5.0), seed=seed, outputs=["rollout.mp4", "actions.json"])
        if args.frames:
            warnings.append(f"--frames ignored: policy frame count is chunk_size+1 = {act.get('chunk_size', 16) + 1}")
        return plan

    # generate / edge
    if mode == "edge":
        for k, v in EDGE_FALLBACK.items():
            d.setdefault(k, v)
        if entry.get("framework_checkpoint") != "Cosmos3-Edge":
            d.update({k: min(d.get(k, v), v) for k, v in EDGE_FALLBACK.items()})
    if entry.get("require_image") and not imgs:
        raise AdapterError(EXIT_USAGE, f"{entry['id']} is image-to-video: attach an input image")
    frames = args.frames or d.get("frames", 121)
    if imgs:
        task = "image2video"
    elif vids:
        task = "video2video"
    elif frames == 1:
        task = "text2image"
    else:
        task = "text2video"
    wh = parse_resolution(args.resolution) or (d.get("width", 1280), d.get("height", 720))
    lim = entry.get("limits") or {}
    if lim.get("heights") and wh[1] not in lim["heights"]:
        warnings.append(f"height {wh[1]} is outside the validated tiers {lim['heights']} for {entry['id']}")
    if lim.get("frames") and task != "text2image" and not lim["frames"][0] <= frames <= lim["frames"][1]:
        warnings.append(f"frames {frames} is outside the validated range {lim['frames']} for {entry['id']}")
    fps = args.fps or d.get("fps", 24)
    if fps not in (10, 16, 24, 30):
        warnings.append(f"fps {fps} is not one of the documented 10/16/24/30")
    plan.update(task=task, width=wh[0], height=wh[1], frames=1 if task == "text2image" else frames, fps=fps,
                steps=args.steps or d.get("steps", 35),
                guidance=args.guidance if args.guidance is not None else d.get("guidance", 6.0),
                flow_shift=d.get("flow_shift", 10.0), seed=seed,
                negative_prompt=os.environ.get("LATTICE_COSMOS_NEGATIVE_PROMPT") or None,
                json_prompt=args.prompt.strip().startswith("{"),
                outputs=["image.png" if task == "text2image" else "rollout.mp4"])
    if entry.get("distilled"):
        plan["steps"] = plan["guidance"] = plan["flow_shift"] = None  # baked into the 4-step checkpoint
        if backend == "framework":
            raise AdapterError(EXIT_USAGE, "distilled checkpoints are wired for the diffusers backend only here")
    if backend == "framework":
        if task == "video2video":
            raise AdapterError(EXIT_USAGE, "video2video via the framework backend is not wired; use diffusers")
        if not entry.get("framework_checkpoint"):
            raise AdapterError(EXIT_USAGE, f"no framework checkpoint for {entry['id']}",
                               f"set models.{entry['id']}.framework_checkpoint in LATTICE_MODEL_MAP")
        plan["framework"] = framework_payload(plan, args.prompt, entry)
    return plan


def framework_payload(plan: dict, prompt: str, entry: dict) -> dict:
    """Payload for cosmos_framework.scripts.inference (keys from NVIDIA's audiovisual cookbook)."""
    w, h = plan["width"], plan["height"]
    ratio = w / h
    aspect = min(ASPECTS, key=lambda k: abs(ASPECTS[k] - ratio))
    tier = "720" if h >= 720 else "480" if h >= 480 else "256"
    if aspect in ("3,4", "9,16"):
        tier = "720" if w >= 720 else "480" if w >= 480 else "256"
    p = {"model_mode": plan["task"], "name": "rollout", "prompt": prompt,
         "negative_prompt": plan.get("negative_prompt") or "", "enable_sound": False,
         "num_steps": plan["steps"], "guidance": plan["guidance"], "shift": plan["flow_shift"],
         "fps": plan["fps"], "num_frames": plan["frames"], "resolution": tier, "aspect_ratio": aspect,
         "seed": plan["seed"]}
    if plan["task"] == "image2video":
        p["vision_path"] = plan["images"][0]
    return {"payload": p, "checkpoint": entry["framework_checkpoint"],
            "nproc": int(os.environ.get("LATTICE_COSMOS_NPROC") or 1)}


# ---------------------------------------------------------------------------
# Upstream imports / GPU checks
# ---------------------------------------------------------------------------
def import_torch():
    try:
        import torch  # noqa: PLC0415
    except ImportError:
        raise AdapterError(EXIT_NOT_INSTALLED, f"PyTorch is not installed for {sys.executable}", DIFFUSERS_HINT)
    return torch


def require_cuda(torch):
    try:
        ok = bool(torch.cuda.is_available())
    except Exception:  # noqa: BLE001
        ok = False
    if not ok:
        raise AdapterError(EXIT_NO_GPU, "CUDA is not available to PyTorch (no NVIDIA GPU visible, driver missing, "
                                        "or a CPU-only torch build)",
                           "check `nvidia-smi` and `python -c 'import torch; print(torch.cuda.is_available())'`; "
                           "Cosmos 3 needs an NVIDIA GPU (Ampere or newer)")


def import_diffusers(need: str):
    try:
        import diffusers  # noqa: PLC0415
    except ImportError:
        raise AdapterError(EXIT_NOT_INSTALLED, "diffusers is not installed", DIFFUSERS_HINT)
    if not hasattr(diffusers, need):
        raise AdapterError(EXIT_NOT_INSTALLED, f"this diffusers build has no {need} (Cosmos 3 support is on diffusers main)",
                           DIFFUSERS_HINT)
    return diffusers


def token_kw() -> dict:
    tok = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    return {"token": tok} if tok else {}


# ---------------------------------------------------------------------------
# Execution
# ---------------------------------------------------------------------------
def load_omni(plan: dict, torch, diffusers):
    kw = {"torch_dtype": torch.bfloat16, **token_kw()}
    if plan["guardrails"]:
        kw.update(safety_checker=None, enable_safety_checker=True)  # as in NVIDIA's notebooks
    else:
        kw["enable_safety_checker"] = False
    say(f"loading {plan['repo']} (diffusers Cosmos3OmniPipeline, bf16, guardrails {'on' if plan['guardrails'] else 'off'})")
    pipe = diffusers.Cosmos3OmniPipeline.from_pretrained(plan["repo"], **kw)
    place(pipe, plan)
    if plan.get("flow_shift") is not None:
        from diffusers.schedulers.scheduling_unipc_multistep import UniPCMultistepScheduler  # noqa: PLC0415
        extra = {"use_karras_sigmas": False} if plan["task"] == "policy" else {}
        pipe.scheduler = UniPCMultistepScheduler.from_config(pipe.scheduler.config, flow_shift=plan["flow_shift"], **extra)
    return pipe


def place(pipe, plan):
    off = plan["offload"]
    if off == "model" and hasattr(pipe, "enable_model_cpu_offload"):
        say("offload: enable_model_cpu_offload()")
        pipe.enable_model_cpu_offload()
    elif off == "sequential" and hasattr(pipe, "enable_sequential_cpu_offload"):
        say("offload: enable_sequential_cpu_offload()")
        pipe.enable_sequential_cpu_offload()
    else:
        pipe.to("cuda")


def step_callback(pipe, prog: Progress, steps):
    try:
        params = inspect.signature(pipe.__call__).parameters
    except (TypeError, ValueError):
        return {}
    if "callback_on_step_end" not in params or not steps:
        return {}

    def cb(_pipe, i, _t, kwargs):
        prog.stage("infer", (i + 1) / steps, announce=False)
        return kwargs
    return {"callback_on_step_end": cb}


def run_generate(plan, prompt, out: Path, prog: Progress, torch, diffusers):
    from diffusers.utils import export_to_video, load_image, load_video  # noqa: PLC0415
    prog.stage("load")
    if plan["distilled"]:
        cls = getattr(diffusers, "Cosmos3DistilledModularPipeline", None)
        if cls is None:
            raise AdapterError(EXIT_NOT_INSTALLED, "this diffusers build has no Cosmos3DistilledModularPipeline", DIFFUSERS_HINT)
        pipe = cls.from_pretrained(plan["repo"], **token_kw())
        pipe.load_components(torch_dtype=torch.bfloat16)
        if plan["guardrails"] and hasattr(pipe, "enable_safety_checker"):
            pipe.enable_safety_checker()
        place(pipe, plan)
    else:
        pipe = load_omni(plan, torch, diffusers)
    prog.stage("infer")
    gen = torch.Generator(device="cuda").manual_seed(plan["seed"])
    task = plan["task"]
    image = load_image(plan["images"][0]) if task == "image2video" else None
    video = load_video(plan["videos"][0]) if task == "video2video" else None
    common = {"prompt": prompt, "num_frames": plan["frames"], "height": plan["height"], "width": plan["width"],
              "generator": gen}
    if plan["json_prompt"]:
        common.update(add_resolution_template=False, add_duration_template=False)
    t0 = time.time()
    if plan["distilled"]:
        kw = {**common, "output": "videos", "add_resolution_template": False, "add_duration_template": False}
        if image is not None:
            kw.update(image=image, fps=plan["fps"])
        frames_out = pipe(**kw)
        result_video = frames_out
    else:
        kw = {**common, "num_inference_steps": plan["steps"], "guidance_scale": plan["guidance"],
              **step_callback(pipe, prog, plan["steps"])}
        if task == "text2image":
            kw["negative_prompt"] = ""
        else:
            kw.update(fps=plan["fps"], enable_sound=False)
            if plan.get("negative_prompt"):
                kw["negative_prompt"] = plan["negative_prompt"]
            if image is not None:
                kw["image"] = image
            if video is not None:
                kw.update(video=video, condition_frame_indexes_vision=[0, 1], condition_video_keep="first")
        result_video = pipe(**kw).video
    say(f"generated in {time.time() - t0:.1f}s")
    prog.stage("encode")
    if task == "text2image":
        path = out / "image.png"
        result_video[0].save(path)
    else:
        path = out / "rollout.mp4"
        export_to_video(result_video, str(path), fps=plan["fps"], macro_block_size=1)
    say(f"wrote {path.name}")
    return [path]


def policy_frame(plan):
    from PIL import Image, ImageOps  # noqa: PLC0415 -- pulled in by diffusers
    from diffusers.utils import load_video  # noqa: PLC0415
    imgs = plan["images"]
    if len(imgs) >= 3:  # compose wrist / exterior 1 / exterior 2 like NVIDIA's policy notebook
        width, height = plan["action"].get("concat_size", [640, 540])
        top = height // 2
        canvas = Image.new("RGB", (width, height))
        tiles = [(imgs[0], (width, top), (0, 0)), (imgs[1], (width // 2, height - top), (0, top)),
                 (imgs[2], (width // 2, height - top), (width // 2, top))]
        for p, size, pos in tiles:
            canvas.paste(ImageOps.fit(Image.open(p).convert("RGB"), size, method=Image.Resampling.BICUBIC), pos)
        return canvas
    if imgs:
        return Image.open(imgs[0]).convert("RGB")
    return load_video(plan["videos"][0])[0]


def run_policy(plan, prompt, out: Path, prog: Progress, torch, diffusers):
    from diffusers.utils import export_to_video  # noqa: PLC0415
    if not hasattr(diffusers, "CosmosActionCondition"):
        raise AdapterError(EXIT_NOT_INSTALLED, "this diffusers build has no CosmosActionCondition", DIFFUSERS_HINT)
    prog.stage("load")
    pipe = load_omni(plan, torch, diffusers)
    image = policy_frame(plan)
    image.save(out / "policy_input.png")
    prog.stage("infer")
    a = plan["action"]
    cond = diffusers.CosmosActionCondition(mode="policy", chunk_size=a["chunk_size"], domain_name=a["domain_name"],
                                           resolution_tier=a["resolution_tier"], image=image,
                                           view_point=a["view_point"])
    t0 = time.time()
    result = pipe(prompt=prompt, action=cond, fps=plan["fps"], num_inference_steps=plan["steps"],
                  guidance_scale=plan["guidance"], use_system_prompt=False,
                  generator=torch.Generator(device="cuda").manual_seed(plan["seed"]),
                  **step_callback(pipe, prog, plan["steps"]))
    say(f"generated in {time.time() - t0:.1f}s")
    prog.stage("encode")
    paths = [out / "rollout.mp4"]
    export_to_video(result.video, str(paths[0]), fps=plan["fps"], macro_block_size=1)
    act = getattr(result, "action", None)
    if act is not None:
        vals = act[0].tolist() if hasattr(act[0], "tolist") else list(act[0])
        write_json(out / "actions.json", {"schema": "lattice.actions/1", "space": "model-normalized",
                                          "domain": a["domain_name"], "chunk_size": a["chunk_size"],
                                          "actions": vals})
        paths.append(out / "actions.json")
    return paths


def run_reason(plan, prompt, out: Path, prog: Progress, torch):
    try:
        import transformers  # noqa: PLC0415
    except ImportError:
        raise AdapterError(EXIT_NOT_INSTALLED, "transformers is not installed", TRANSFORMERS_HINT)
    cls = getattr(transformers, plan["reasoner_class"], None)
    if cls is None or not hasattr(transformers, "AutoProcessor"):
        raise AdapterError(EXIT_NOT_INSTALLED, f"this transformers build has no {plan['reasoner_class']}", TRANSFORMERS_HINT)
    prog.stage("load")
    say(f"loading {plan['repo']} reasoner ({plan['reasoner_class']}, bf16)")
    processor = transformers.AutoProcessor.from_pretrained(plan["repo"], **token_kw())
    model = cls.from_pretrained(plan["repo"], dtype=torch.bfloat16, device_map="auto", **token_kw())
    prog.stage("infer")
    content = [{"type": "image", "path": p} for p in plan["images"]]
    content += [{"type": "video", "path": p} for p in plan["videos"]]
    content.append({"type": "text", "text": prompt or "Describe what happens in detail."})
    extra = {"fps": plan["video_fps"]} if plan["videos"] else {}
    inputs = processor.apply_chat_template([{"role": "user", "content": content}], tokenize=True,
                                           add_generation_prompt=True, return_dict=True, return_tensors="pt",
                                           **extra).to(model.device, torch.bfloat16)
    t0 = time.time()
    ids = model.generate(**inputs, do_sample=False, max_new_tokens=plan["max_new_tokens"])
    trimmed = [o[len(i):] for i, o in zip(inputs.input_ids, ids)]
    text = processor.batch_decode(trimmed, skip_special_tokens=True, clean_up_tokenization_spaces=False)[0]
    say(f"reasoned in {time.time() - t0:.1f}s")
    prog.stage("encode")
    write_json(out / "reasoning.json", {"schema": "lattice.reasoning/1", "model": plan["model"], "repo": plan["repo"],
                                        "prompt": prompt, "answer": text})
    (out / "reasoning.txt").write_text(text + "\n", "utf-8")
    return [out / "reasoning.json", out / "reasoning.txt"]


def run_framework(plan, out: Path, prog: Progress):
    if importlib.util.find_spec("cosmos_framework") is None:
        raise AdapterError(EXIT_NOT_INSTALLED, f"cosmos_framework is not importable from {sys.executable}", FRAMEWORK_HINT)
    fw = plan["framework"]
    payload = out / "cosmos_payload.json"
    write_json(payload, fw["payload"])
    odir = out / "framework"
    argv = [sys.executable, "-m", "torch.distributed.run", f"--nproc-per-node={fw['nproc']}",
            "-m", "cosmos_framework.scripts.inference",
            f"--parallelism-preset={'throughput' if fw['nproc'] > 1 else 'latency'}",
            "-i", str(payload), "-o", str(odir), "--checkpoint-path", fw["checkpoint"], f"--seed={plan['seed']}"]
    if not plan["guardrails"]:
        argv.append("--no-guardrails")
    prog.stage("load")
    run_stream(argv, cwd=os.environ.get("LATTICE_COSMOS_FRAMEWORK_DIR") or None, env=child_env(), prog=prog,
               stage="infer", model_id=plan["model"], label="cosmos_framework.scripts.inference")
    prog.stage("encode")
    return sorted(p for p in odir.rglob("*") if p.suffix.lower() in (".mp4", ".png", ".jpg"))


def main(argv) -> int:
    args = build_parser("adapters.cosmos.cli", MODES).parse_args(argv)
    os.environ["LATTICE_ADAPTER_MODEL"] = args.model
    entry = resolve_model(args.model, "cosmos")
    out = Path(args.out)
    plan = make_plan(args, entry)
    if args.plan:
        print(json.dumps(plan, indent=2))
        return 0
    out.mkdir(parents=True, exist_ok=True)
    for w in plan["warnings"]:
        say(f"warning: {w}")
    prog = Progress([("load", 0.25), ("infer", 0.65), ("encode", 0.10)])
    prog.emit(0.0)
    t0 = time.time()
    say(f"cosmos {plan['task']} with {plan['model']} -> {plan['repo']} ({plan['backend']})")
    if plan["backend"] == "framework":
        outputs = run_framework(plan, out, prog)
    else:
        torch = import_torch()
        if plan["task"] == "reason":
            require_cuda(torch)
            outputs = run_reason(plan, args.prompt, out, prog, torch)
        else:
            diffusers = import_diffusers("Cosmos3OmniPipeline")
            require_cuda(torch)
            fn = run_policy if plan["task"] == "policy" else run_generate
            outputs = fn(plan, args.prompt, out, prog, torch, diffusers)
    write_json(out / "cosmos_result.json", {
        "schema": "lattice.adapter-result/1", "engine": "cosmos", "license": "OpenMDW-1.1",
        "plan": {k: v for k, v in plan.items() if k != "framework"}, "wall_s": round(time.time() - t0, 2),
        "outputs": [p.relative_to(out).as_posix() if p.is_relative_to(out) else str(p) for p in outputs]})
    prog.done()
    say("cosmos done")
    return 0


def cli(argv=None) -> int:
    return run_main(main, argv)


if __name__ == "__main__":
    sys.exit(cli())
