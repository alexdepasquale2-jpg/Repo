"""Shared helpers for the Lattice engine adapters (stdlib only)."""
from __future__ import annotations

import argparse
import copy
import json
import os
import re
import shlex
import struct
import subprocess
import sys
import time
from pathlib import Path

# ---------------------------------------------------------------------------
# Exit codes (documented in ENGINES.md; the worker shows "exited with code N")
# ---------------------------------------------------------------------------
EXIT_OK = 0
EXIT_UPSTREAM = 1      # upstream ran and failed
EXIT_NOT_INSTALLED = 2  # upstream package / checkout missing
EXIT_NO_GPU = 3        # CUDA not available
EXIT_OOM = 4           # out of GPU memory
EXIT_USAGE = 5         # bad arguments, bad model map, missing input or config

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
VIDEO_EXT = {".mp4", ".webm", ".mov", ".avi", ".mkv"}

OOM_PATTERNS = re.compile(r"(CUDA out of memory|OutOfMemoryError|CUBLAS_STATUS_ALLOC_FAILED|"
                          r"out of memory|NCCL.*unhandled cuda error.*memory)", re.I)
TQDM_RE = re.compile(r"(\d+)/(\d+)\s*\[")


class AdapterError(Exception):
    def __init__(self, code: int, msg: str, hint: str | None = None):
        super().__init__(msg)
        self.code = code
        self.msg = msg
        self.hint = hint


# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------
def _secrets() -> list:
    return [v for k in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN") if (v := os.environ.get(k)) and len(v) >= 4]


def redact(text: str) -> str:
    """Remove any Hugging Face token value from text before it is printed."""
    text = str(text)
    for s in _secrets():
        text = text.replace(s, "hf_***")
    return re.sub(r"hf_[A-Za-z0-9]{20,}", "hf_***", text)


def say(msg: str):
    print(redact(msg), flush=True)


class Progress:
    """Prints monotonic "PROGRESS x" lines (0..1) that the worker maps onto the stage bar."""

    def __init__(self, stages: list[tuple[str, float]], out=None):
        # stages: [(name, weight)]; progress within a stage is interpolated
        total = sum(w for _, w in stages) or 1.0
        self.spans = {}
        acc = 0.0
        for name, w in stages:
            self.spans[name] = (acc / total, (acc + w) / total)
            acc += w
        self.last = 0.0
        self.out = out or sys.stdout

    def emit(self, f: float):
        f = max(self.last, min(1.0, float(f)))
        if f > self.last or f == 0.0:
            self.last = f
            print(f"PROGRESS {f:.3f}", file=self.out, flush=True)

    def stage(self, name: str, frac: float = 0.0, announce: bool = True):
        a, b = self.spans.get(name, (self.last, self.last))
        if announce and frac == 0.0:
            print(f"stage {name}", file=self.out, flush=True)
        self.emit(a + (b - a) * max(0.0, min(1.0, frac)))

    def done(self):
        self.emit(1.0)


# ---------------------------------------------------------------------------
# CLI parsing (exactly what worker.py passes, plus adapter-only --plan)
# ---------------------------------------------------------------------------
class _Parser(argparse.ArgumentParser):
    def error(self, message):  # argparse would exit 2, which means "not installed" here
        raise AdapterError(EXIT_USAGE, f"bad arguments: {message}")


def build_parser(prog: str, modes: list[str]) -> argparse.ArgumentParser:
    p = _Parser(prog=prog, description="Lattice engine adapter (see ENGINES.md)")
    p.add_argument("mode", choices=modes)
    p.add_argument("--model", required=True, help="Lattice model id, e.g. cosmos3-nano-16b")
    p.add_argument("--prompt", default="")
    p.add_argument("--out", required=True, help="output directory (the job's run dir)")
    p.add_argument("--input", action="append", default=[], help="input media file (repeatable)")
    p.add_argument("--input-dir", default=None, help="directory of input frames/media")
    p.add_argument("--frames", type=int)
    p.add_argument("--fps", type=int)
    p.add_argument("--resolution")
    p.add_argument("--seed", type=int)
    p.add_argument("--guidance", type=float)
    p.add_argument("--steps", type=int)
    p.add_argument("--export-target", dest="export_target")
    p.add_argument("--format")
    p.add_argument("--keyframe-stride", dest="keyframe_stride", type=int)
    p.add_argument("--plan", action="store_true",
                   help="print the resolved plan as JSON and exit without running anything")
    return p


RES_TIERS = {  # tier -> (width, height) at 16:9 per the Cosmos 3 model reference
    "720p": (1280, 720), "480p": (832, 480), "256p": (320, 192),
}


def parse_resolution(res: str | None):
    """'1280x720' -> (1280, 720); '480p' -> (832, 480); None -> None."""
    if not res:
        return None
    m = re.fullmatch(r"(\d{2,5})x(\d{2,5})", res)
    if m:
        return int(m.group(1)), int(m.group(2))
    if res in RES_TIERS:
        return RES_TIERS[res]
    m = re.fullmatch(r"(\d{2,5})p", res)
    if m:
        h = int(m.group(1))
        return int(round(h * 16 / 9 / 16) * 16), h
    raise AdapterError(EXIT_USAGE, f"resolution {res!r} must look like 1280x720 or 480p")


def media_inputs(args) -> tuple[list[Path], list[Path]]:
    """Split --input files and --input-dir contents into (images, videos), sorted."""
    files = [Path(f) for f in args.input]
    if args.input_dir:
        d = Path(args.input_dir)
        if not d.is_dir():
            raise AdapterError(EXIT_USAGE, f"--input-dir {d} is not a directory")
        files += sorted(p for p in d.iterdir() if p.is_file())
    for f in files:
        if not f.exists():
            raise AdapterError(EXIT_USAGE, f"input file not found: {f}")
    imgs = [f for f in files if f.suffix.lower() in IMAGE_EXT]
    vids = [f for f in files if f.suffix.lower() in VIDEO_EXT]
    return imgs, vids


def image_size(path: Path):
    """(width, height) of a PNG / JPEG / WebP file using only the header; None if unknown."""
    try:
        with open(path, "rb") as f:
            head = f.read(32)
            if head[:8] == b"\x89PNG\r\n\x1a\n":
                return struct.unpack(">II", head[16:24])
            if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
                f.seek(12)
                chunk = f.read(4)
                data = f.read(26)
                if chunk == b"VP8 ":
                    w, h = struct.unpack("<HH", data[14:18])
                    return w & 0x3FFF, h & 0x3FFF
                if chunk == b"VP8L":
                    b = data[5:9]
                    w = 1 + (((b[1] & 0x3F) << 8) | b[0])
                    h = 1 + (((b[3] & 0xF) << 10) | (b[2] << 2) | ((b[1] & 0xC0) >> 6))
                    return w, h
                if chunk == b"VP8X":
                    w = 1 + int.from_bytes(data[8:11], "little")
                    h = 1 + int.from_bytes(data[11:14], "little")
                    return w, h
                return None
            if head[:2] == b"\xff\xd8":
                f.seek(2)
                while True:
                    marker = f.read(2)
                    if len(marker) < 2 or marker[0] != 0xFF:
                        return None
                    if marker[1] in (0xD8, 0x01) or 0xD0 <= marker[1] <= 0xD7:
                        continue
                    ln = struct.unpack(">H", f.read(2))[0]
                    if marker[1] in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                        f.read(1)
                        h, w = struct.unpack(">HH", f.read(4))
                        return w, h
                    f.seek(ln - 2, 1)
    except (OSError, struct.error):
        return None
    return None


# ---------------------------------------------------------------------------
# Model map: Lattice ids -> verified upstream checkpoints (overridable)
# ---------------------------------------------------------------------------
# Sources (checked 2026-09-26):
#   github.com/NVIDIA/cosmos @77ef192 README.md, docs/reference/models.md,
#     cookbooks/cosmos3/generator/{audiovisual,action}, cookbooks/cosmos3/nim/support-matrix.md
#   github.com/Tencent-Hunyuan/HY-World-2.0 @df9988e README.md, DOCUMENTATION.md, hyworld2/**
# min_vram_gib: smallest single-GPU memory at which the default (no-offload, BF16) path is
# expected to fit. "verified" values come from NVIDIA's NIM support matrix (a different runtime
# than Diffusers, so treat them as guidance); "estimate" values are ours.
DEFAULT_MODEL_MAP = {
    "cosmos3-edge-4b": {
        "engine": "cosmos", "repo": "nvidia/Cosmos3-Edge", "framework_checkpoint": "Cosmos3-Edge",
        "reasoner_class": "AutoModelForImageTextToText",
        # Edge settings from cookbooks/cosmos3/generator/audiovisual/README.md (Diffusers section)
        "defaults": {"width": 832, "height": 480, "frames": 121, "fps": 24, "steps": 20,
                     "guidance": 5.0, "flow_shift": 8.0},
        "limits": {"heights": [192, 480], "frames": [50, 150]},
        "min_vram_gib": 24, "vram_source": "estimate (unverified; NVIDIA lists Jetson AGX Orin/Thor and RTX Pro 6000)",
    },
    "cosmos3-nano-16b": {
        "engine": "cosmos", "repo": "nvidia/Cosmos3-Nano", "framework_checkpoint": "Cosmos3-Nano",
        "reasoner_class": "Cosmos3OmniForConditionalGeneration",
        "defaults": {"width": 1280, "height": 720, "frames": 189, "fps": 24, "steps": 35,
                     "guidance": 6.0, "flow_shift": 10.0},
        "limits": {"heights": [192, 480, 720], "frames": [5, 300]},
        "min_vram_gib": 58, "min_vram_offload_gib": 31, "reasoner_vram_gib": 23.1,
        "vram_source": "NIM support matrix: nano BF16 resident 58 GiB, layer offload 31 GiB; reasoner 23.1 GiB",
    },
    "cosmos3-super-64b": {
        "engine": "cosmos", "repo": "nvidia/Cosmos3-Super", "framework_checkpoint": "Cosmos3-Super",
        "reasoner_class": "Cosmos3OmniForConditionalGeneration",
        "defaults": {"width": 1280, "height": 720, "frames": 189, "fps": 24, "steps": 35,
                     "guidance": 6.0, "flow_shift": 10.0},
        "limits": {"heights": [192, 480, 720], "frames": [5, 300]},
        "min_vram_gib": 150, "min_vram_offload_gib": 42, "reasoner_vram_gib": 135,
        "vram_source": "NIM support matrix: super BF16 resident 150 GiB, layer offload 42 GiB; reasoner TP1 135 GiB",
    },
    # Lattice "I2V" = Cosmos3-Nano run image->video (Nano supports i2v per the model reference).
    # For the Super post-trained I2V example set repo to nvidia/Cosmos3-Super-Image2Video, or
    # nvidia/Cosmos3-Super-Image2Video-4Step with "distilled": true.
    "cosmos3-i2v": {
        "engine": "cosmos", "repo": "nvidia/Cosmos3-Nano", "framework_checkpoint": "Cosmos3-Nano",
        "require_image": True,
        "defaults": {"width": 1280, "height": 720, "frames": 189, "fps": 24, "steps": 35,
                     "guidance": 6.0, "flow_shift": 10.0},
        "limits": {"heights": [192, 480, 720], "frames": [5, 300]},
        "min_vram_gib": 58, "min_vram_offload_gib": 31,
        "vram_source": "same as Cosmos3-Nano (NIM support matrix)",
    },
    # Policy settings from cookbooks/cosmos3/generator/action/run_policy_with_diffusers.ipynb.
    # nvidia/Cosmos3-Edge-Policy-DROID also exists but NVIDIA documents it only through the
    # cosmos_framework policy server, so it is not the default here.
    "cosmos3-droid-policy": {
        "engine": "cosmos", "repo": "nvidia/Cosmos3-Nano-Policy-DROID",
        "action": {"mode": "policy", "domain_name": "droid_lerobot", "chunk_size": 16,
                   "resolution_tier": 480, "view_point": "concat_view", "fps": 15,
                   "concat_size": [640, 540]},
        "defaults": {"steps": 30, "guidance": 1.0, "flow_shift": 5.0, "fps": 15},
        "min_vram_gib": 58, "vram_source": "estimate: Nano-based (README: runs on RTX Pro 6000)",
    },
    "hy-world-2.0": {
        "engine": "hyworld", "repo": "tencent/HY-World-2.0",
        "worldmirror_subfolder": "HY-WorldMirror-2.0",
        "pano_backend": "qwen",  # "qwen" (Qwen-Image-Edit-2509 + HY-Pano-2.0 LoRA) or "hunyuan-image-3"
        "pano_base": "Qwen/Qwen-Image-Edit-2509", "pano_subfolder": "HY-Pano-2.0",
        "worldstereo_model_type": "worldstereo-memory-dmd",
        "min_vram_gib": 24, "worldgen_min_gpus": 4,
        "vram_source": ("WorldMirror 2.0 ~1.2B params, 12-24 GB per third-party guide (unverified); "
                        "world generation: >=4 GPUs recommended, tested on 8x H20 (upstream README)"),
    },
}


def load_model_map() -> tuple[dict, str | None]:
    """Default map merged with the JSON file named by $LATTICE_MODEL_MAP (entry-level merge).

    File format: {"models": {"<lattice id>": {<fields to override>} | null}} (the "models"
    wrapper is optional). A null entry removes the mapping.
    """
    m = copy.deepcopy(DEFAULT_MODEL_MAP)
    path = os.environ.get("LATTICE_MODEL_MAP") or None
    if not path:
        return m, None
    try:
        data = json.loads(Path(path).read_text("utf-8"))
    except FileNotFoundError:
        raise AdapterError(EXIT_USAGE, f"LATTICE_MODEL_MAP file not found: {path}")
    except (OSError, ValueError) as e:
        raise AdapterError(EXIT_USAGE, f"LATTICE_MODEL_MAP {path} is not valid JSON: {e}")
    if not isinstance(data, dict):
        raise AdapterError(EXIT_USAGE, f"LATTICE_MODEL_MAP {path} must hold a JSON object")
    models = data.get("models", data)
    if not isinstance(models, dict):
        raise AdapterError(EXIT_USAGE, f'LATTICE_MODEL_MAP {path}: "models" must be an object')
    for k, v in models.items():
        if v is None:
            m[k] = None
        elif isinstance(v, dict):
            base = m.get(k) or {}
            merged = {**base, **v}
            for sub in ("defaults", "action", "limits"):
                if isinstance(base.get(sub), dict) and isinstance(v.get(sub), dict):
                    merged[sub] = {**base[sub], **v[sub]}
            m[k] = merged
        else:
            raise AdapterError(EXIT_USAGE, f"LATTICE_MODEL_MAP {path}: entry {k!r} must be an object or null")
    return m, path


def resolve_model(model_id: str, engine: str) -> dict:
    m, path = load_model_map()
    entry = m.get(model_id)
    where = f"LATTICE_MODEL_MAP ({path})" if path else "a JSON file named by LATTICE_MODEL_MAP"
    if not entry or not entry.get("repo"):
        raise AdapterError(
            EXIT_USAGE, f"no upstream checkpoint mapped for Lattice model {model_id!r}",
            f'add {{"models": {{"{model_id}": {{"repo": "<hf repo id or local path>"}}}}}} to {where}')
    if entry.get("engine", engine) != engine:
        raise AdapterError(EXIT_USAGE, f"model {model_id!r} belongs to engine {entry.get('engine')!r}, not {engine!r}")
    return {"id": model_id, **entry}


# ---------------------------------------------------------------------------
# Errors / subprocess
# ---------------------------------------------------------------------------
def is_oom(text: str) -> bool:
    return bool(OOM_PATTERNS.search(text or ""))


def oom_error(model_id: str, detail: str = "") -> AdapterError:
    return AdapterError(
        EXIT_OOM, "out of GPU memory" + (f" ({detail})" if detail else ""),
        f"try a smaller model (e.g. cosmos3-edge-4b), fewer frames or a lower resolution, "
        f"LATTICE_COSMOS_OFFLOAD=model, or run {model_id} on the datacenter target")


def child_env(extra: dict | None = None, pythonpath: list | None = None) -> dict:
    env = dict(os.environ)
    env["PYTHONUNBUFFERED"] = "1"
    if pythonpath:
        env["PYTHONPATH"] = os.pathsep.join([*map(str, pythonpath), *filter(None, [env.get("PYTHONPATH")])])
    env.update(extra or {})
    return env


def run_stream(argv: list, *, cwd=None, env=None, prog: Progress | None = None, stage: str | None = None,
               model_id: str = "", label: str | None = None) -> int:
    """Run an upstream command, echo its output (redacted), map tqdm "i/n [" to stage progress,
    and turn failures into AdapterError with the right exit code."""
    label = label or os.path.basename(str(argv[0]))
    say("run: " + shlex.join([str(a) for a in argv]))
    try:
        proc = subprocess.Popen([str(a) for a in argv], cwd=str(cwd) if cwd else None, env=env,
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    except FileNotFoundError:
        raise AdapterError(EXIT_NOT_INSTALLED, f"cannot start {label}: {argv[0]} not found",
                           "check the interpreter / torchrun path in ENGINES.md")
    except OSError as e:
        raise AdapterError(EXIT_UPSTREAM, f"cannot start {label}: {e.strerror or e}")
    oom = False
    missing = None
    tail = []
    buf = b""
    last_echo = 0.0
    try:
        while True:
            chunk = proc.stdout.read1(4096) if hasattr(proc.stdout, "read1") else proc.stdout.read(4096)
            if not chunk:
                break
            buf += chunk
            parts = re.split(rb"[\r\n]", buf)
            buf = parts.pop()
            for raw in parts:
                line = raw.decode("utf-8", "replace").rstrip()
                if not line:
                    continue
                m = TQDM_RE.search(line)
                if m and prog and stage and int(m.group(2)) > 0:
                    prog.stage(stage, int(m.group(1)) / int(m.group(2)), announce=False)
                    if time.time() - last_echo < 5:  # keep the job log readable
                        continue
                    last_echo = time.time()
                if is_oom(line):
                    oom = True
                mm = re.search(r"No module named '([^']+)'", line)
                if mm:
                    missing = mm.group(1)
                tail = (tail + [line])[-3:]
                say(line)
        if buf.strip():
            say(buf.decode("utf-8", "replace"))
        rc = proc.wait()
    except BaseException:
        proc.kill()
        raise
    if rc != 0:
        if oom:
            raise oom_error(model_id, f"{label} exit {rc}")
        if missing:
            raise AdapterError(EXIT_NOT_INSTALLED, f"{label}: python module {missing!r} is not installed",
                               "install the upstream requirements (see ENGINES.md)")
        raise AdapterError(EXIT_UPSTREAM, f"{label} exited with code {rc}" + (f": {tail[-1][:200]}" if tail else ""))
    return rc


def run_main(fn, argv=None) -> int:
    """Wrap an adapter main(): print a single clear error line and return the exit code."""
    try:
        return fn(sys.argv[1:] if argv is None else list(argv)) or 0
    except AdapterError as e:
        print(redact(f"error: {e.msg}"), file=sys.stderr, flush=True)
        if e.hint:
            print(redact(f"hint: {e.hint}"), file=sys.stderr, flush=True)
        return e.code
    except KeyboardInterrupt:
        print("error: interrupted", file=sys.stderr, flush=True)
        return 130
    except MemoryError:
        print("error: out of host memory", file=sys.stderr, flush=True)
        return EXIT_OOM
    except Exception as e:  # noqa: BLE001 -- classify upstream exceptions
        text = f"{e.__class__.__name__}: {e}"
        if is_oom(text):
            err = oom_error(os.environ.get("LATTICE_ADAPTER_MODEL", ""), text[:160])
            print(redact(f"error: {err.msg}"), file=sys.stderr, flush=True)
            print(redact(f"hint: {err.hint}"), file=sys.stderr, flush=True)
            return EXIT_OOM
        import traceback
        print(redact(traceback.format_exc()), file=sys.stderr, flush=True)
        print(redact(f"error: upstream failed: {text[:300]}"), file=sys.stderr, flush=True)
        return EXIT_UPSTREAM


def write_json(path: Path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=2, default=str) + "\n", "utf-8")
    os.replace(tmp, path)
