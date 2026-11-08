#!/usr/bin/env python3
"""Lattice readiness report: `python3 -m adapters.doctor [--json] [--runs DIR]`.

Checks python, NVIDIA GPUs (nvidia-smi, or Jetson unified memory), torch/CUDA in each engine
interpreter, ffmpeg, upstream packages, the model map, whether an HF token is in the
environment (yes/no only), free disk in the runs dir, and which Lattice models fit this box.
Exit 0 if at least one Lattice model can run here, 1 otherwise. Stdlib only; never loads weights.
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adapters.common import AdapterError, load_model_map  # noqa: E402

PROBE = r"""
import importlib.util, json, sys
r = {"python": sys.version.split()[0], "executable": sys.executable, "modules": {}}
for m in sys.argv[1].split(","):
    try:
        r["modules"][m] = importlib.util.find_spec(m) is not None
    except (ImportError, ValueError):
        r["modules"][m] = False
try:
    import torch
    r["torch"] = torch.__version__
    r["cuda_available"] = bool(torch.cuda.is_available())
    r["torch_cuda"] = getattr(torch.version, "cuda", None)
    r["cuda_devices"] = torch.cuda.device_count() if r["cuda_available"] else 0
except Exception as e:
    r["torch"] = None
    r["cuda_available"] = False
    r["torch_error"] = e.__class__.__name__
if r["modules"].get("diffusers") and "--deep" in sys.argv:
    try:
        import diffusers
        r["diffusers_version"] = diffusers.__version__
        r["cosmos3_pipeline"] = hasattr(diffusers, "Cosmos3OmniPipeline")
    except Exception as e:
        r["cosmos3_pipeline"] = False
print(json.dumps(r))
"""

COSMOS_MODULES = ["diffusers", "transformers", "cosmos_guardrail", "cosmos_framework", "PIL"]
HY_MODULES = ["hyworld2", "gsplat", "open3d", "PIL"]


def gpus() -> dict:
    exe = shutil.which("nvidia-smi")
    info = {"nvidia_smi": bool(exe), "gpus": [], "driver": None, "jetson": Path("/etc/nv_tegra_release").exists()}
    if exe:
        try:
            out = subprocess.run([exe, "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"],
                                 capture_output=True, text=True, timeout=15)
            for ln in out.stdout.splitlines():
                parts = [p.strip() for p in ln.split(",")]
                if len(parts) >= 2 and parts[0]:
                    try:
                        mem = int(float(parts[1]))
                    except ValueError:
                        mem = None  # "[N/A]" on unified-memory parts
                    info["gpus"].append({"name": parts[0], "memory_mib": mem,
                                         "memory_gib": round(mem / 1024, 1) if mem else None})
                    info["driver"] = parts[2] if len(parts) > 2 else None
        except (OSError, subprocess.SubprocessError) as e:
            info["error"] = e.__class__.__name__
    if info["jetson"] or any(g["memory_mib"] is None for g in info["gpus"]):
        try:  # Jetson / GB10: GPU shares system memory
            for ln in Path("/proc/meminfo").read_text().splitlines():
                if ln.startswith("MemTotal:"):
                    gib = round(int(ln.split()[1]) / 1024 / 1024, 1)
                    info["unified_memory_gib"] = gib
                    if not info["gpus"]:
                        info["gpus"].append({"name": "Jetson (integrated)", "memory_mib": None, "memory_gib": gib})
                    for g in info["gpus"]:
                        if g["memory_gib"] is None:
                            g["memory_gib"] = gib
                            g["unified"] = True
        except OSError:
            pass
    return info


def probe(py: str, modules: list, extra_path: list | None = None) -> dict:
    env = dict(os.environ)
    if extra_path:
        env["PYTHONPATH"] = os.pathsep.join([*extra_path, *filter(None, [env.get("PYTHONPATH")])])
    try:
        out = subprocess.run([py, "-c", PROBE, ",".join(modules), "--deep"], capture_output=True, text=True,
                             timeout=180, env=env)
        if out.returncode == 0 and out.stdout.strip():
            return json.loads(out.stdout.strip().splitlines()[-1])
        return {"executable": py, "error": (out.stderr.strip().splitlines() or ["probe failed"])[-1][:200]}
    except FileNotFoundError:
        return {"executable": py, "error": "interpreter not found"}
    except (OSError, subprocess.SubprocessError, ValueError) as e:
        return {"executable": py, "error": e.__class__.__name__}


def cmd_python(var: str) -> str:
    """Interpreter an engine command would use: first word of LATTICE_*_CMD if it looks like python."""
    cmd = os.environ.get(var) or ""
    first = cmd.split()[0] if cmd.split() else ""
    return first if "python" in os.path.basename(first) else sys.executable


def feasibility(entry: dict, gpu_list: list, engine_ready: bool, cuda: bool) -> dict:
    vram = [g["memory_gib"] for g in gpu_list if g.get("memory_gib")]
    best = max(vram) if vram else 0
    total = sum(vram)
    need = entry.get("min_vram_gib")
    off = entry.get("min_vram_offload_gib")
    r = {"min_vram_gib": need, "vram_source": entry.get("vram_source"), "engine_ready": engine_ready}
    if not vram:
        r.update(status="no-gpu", fits=False)
    elif need is None or best >= need:
        r.update(status="fits", fits=True)
    elif len(vram) > 1 and total >= need:
        r.update(status="multi-gpu", fits=True, note="needs multi-GPU (LATTICE_COSMOS_BACKEND=framework, LATTICE_COSMOS_NPROC)")
    elif off and best >= off:
        r.update(status="fits-with-offload", fits=True, note="set LATTICE_COSMOS_OFFLOAD=model (unverified in Diffusers)")
    else:
        r.update(status="too-small", fits=False)
    if entry.get("worldgen_min_gpus"):
        r["worldgen_ok"] = len(vram) >= entry["worldgen_min_gpus"]
        r["worldgen_note"] = (f"stereo/export (world generation) recommends >= {entry['worldgen_min_gpus']} GPUs; "
                              "pano/worldmirror run on one")
    r["can_run"] = bool(r["fits"] and engine_ready and cuda)
    return r


def report(runs: str) -> dict:
    g = gpus()
    cos_py = cmd_python("LATTICE_COSMOS_CMD")
    hy_py = os.environ.get("LATTICE_HY_PYTHON") or cmd_python("LATTICE_HY_CMD")
    hy_root = os.environ.get("LATTICE_HY_ROOT")
    cos = probe(cos_py, COSMOS_MODULES)
    hy = probe(hy_py, HY_MODULES, [hy_root] if hy_root else None)
    hy_root_ok = bool(hy_root and (Path(hy_root) / "hyworld2").is_dir()) or bool(hy.get("modules", {}).get("hyworld2"))
    cos_ready = bool(cos.get("cosmos3_pipeline") or cos.get("modules", {}).get("cosmos_framework"))
    reason_ready = bool(cos.get("modules", {}).get("transformers"))
    hy_ready = hy_root_ok and bool(hy.get("torch"))
    try:
        mm, mm_path = load_model_map()
        map_info = {"file": mm_path, "error": None,
                    "models": {k: ({"repo": v.get("repo"), "engine": v.get("engine")} if v else None) for k, v in mm.items()}}
    except AdapterError as e:
        mm, map_info = {}, {"file": os.environ.get("LATTICE_MODEL_MAP"), "error": e.msg, "models": {}}
    models = {}
    for mid, entry in mm.items():
        if not entry or not entry.get("repo"):
            models[mid] = {"status": "unmapped", "fits": False, "can_run": False,
                           "hint": f'set models.{mid}.repo in LATTICE_MODEL_MAP'}
            continue
        is_hy = entry.get("engine") == "hyworld"
        ready = hy_ready if is_hy else (cos_ready or reason_ready)
        cuda = bool((hy if is_hy else cos).get("cuda_available"))
        models[mid] = {"repo": entry["repo"], **feasibility(entry, g["gpus"], ready, cuda)}
    rp = Path(runs).expanduser()
    probe_dir = rp
    while not probe_dir.exists() and probe_dir.parent != probe_dir:
        probe_dir = probe_dir.parent
    try:
        du = shutil.disk_usage(probe_dir)
        disk = {"path": str(rp), "checked": str(probe_dir), "free_gib": round(du.free / 2**30, 1),
                "total_gib": round(du.total / 2**30, 1), "exists": rp.exists()}
    except OSError as e:
        disk = {"path": str(rp), "error": e.__class__.__name__}
    hf_cache = Path(os.environ.get("HF_HOME") or Path.home() / ".cache" / "huggingface")
    r = {
        "schema": "lattice.doctor/1",
        "python": {"version": platform.python_version(), "executable": sys.executable,
                   "ok": sys.version_info >= (3, 10)},
        "platform": platform.platform(),
        "gpu": g,
        "ffmpeg": shutil.which("ffmpeg"),
        "cosmos": {"interpreter": cos, "ready": cos_ready, "reasoner_ready": reason_ready,
                   "backend": os.environ.get("LATTICE_COSMOS_BACKEND") or "diffusers",
                   "detect_module": os.environ.get("LATTICE_COSMOS_MODULE") or "cosmos3 (worker default placeholder)"},
        "hyworld": {"interpreter": hy, "ready": hy_ready, "root": hy_root, "root_ok": hy_root_ok,
                    "llm_server": bool(os.environ.get("LATTICE_HY_LLM_ADDR")),
                    "detect_module": os.environ.get("LATTICE_HY_MODULE") or "hyworld (worker default placeholder)"},
        "model_map": map_info,
        "hf_token_in_env": bool(os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")),
        "hf_cached_login": (hf_cache / "token").exists(),
        "disk": disk,
        "models": models,
    }
    r["can_run"] = any(m.get("can_run") for m in models.values())
    return r


def text(r: dict) -> str:
    yn = lambda b: "yes" if b else "no"  # noqa: E731
    L = ["Lattice doctor", "", f"python      {r['python']['version']} ({r['python']['executable']})"
         + ("" if r["python"]["ok"] else "  <- needs >= 3.10")]
    g = r["gpu"]
    if g["gpus"]:
        for i, x in enumerate(g["gpus"]):
            L.append(f"gpu[{i}]      {x['name']}  {x['memory_gib']} GiB" + (" (unified)" if x.get("unified") else ""))
    else:
        L.append("gpu         none found (nvidia-smi " + ("present" if g["nvidia_smi"] else "missing") + ")")
    L.append(f"ffmpeg      {r['ffmpeg'] or 'missing (bridge keyframes fall back to passing the video)'}")
    for name in ("cosmos", "hyworld"):
        e = r[name]
        it = e["interpreter"]
        mods = ", ".join(f"{k}={'ok' if v else '-'}" for k, v in (it.get("modules") or {}).items())
        L.append(f"{name:<11} ready={yn(e['ready'])}  python={it.get('executable')}  torch={it.get('torch')} "
                 f"cuda={yn(it.get('cuda_available'))}" + (f"  error={it['error']}" if it.get("error") else ""))
        if mods:
            L.append(f"{'':<11} {mods}")
    L.append(f"{'':<11} hy root={r['hyworld']['root'] or '(unset: LATTICE_HY_ROOT)'}  "
             f"vLLM for WorldNav={'set' if r['hyworld']['llm_server'] else 'unset (LATTICE_HY_LLM_ADDR)'}")
    mm = r["model_map"]
    L.append(f"model map   {mm['file'] or 'built-in defaults'}" + (f"  ERROR: {mm['error']}" if mm["error"] else ""))
    L.append(f"hf token    in env: {yn(r['hf_token_in_env'])}; cached login: {yn(r['hf_cached_login'])} "
             "(the worker passes only the job's X-HF-Token)")
    d = r["disk"]
    L.append(f"runs disk   {d.get('free_gib', '?')} GiB free at {d.get('checked', d['path'])}")
    L += ["", "model                  repo                                  need GiB  status              can run"]
    for mid, m in r["models"].items():
        L.append(f"{mid:<22} {str(m.get('repo')):<37} {str(m.get('min_vram_gib', '-')):>8}  "
                 f"{m.get('status', ''):<18}  {yn(m.get('can_run'))}")
    L += ["", "RESULT: " + ("something can run here" if r["can_run"] else "nothing can run here yet (see ENGINES.md)")]
    return "\n".join(L)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="adapters.doctor", description=__doc__.splitlines()[0])
    ap.add_argument("--json", action="store_true", help="print JSON")
    ap.add_argument("--runs", default=os.environ.get("LATTICE_RUNS", "./runs"))
    a = ap.parse_args(argv)
    r = report(a.runs)
    print(json.dumps(r, indent=2) if a.json else text(r))
    return 0 if r["can_run"] else 1


if __name__ == "__main__":
    sys.exit(main())
