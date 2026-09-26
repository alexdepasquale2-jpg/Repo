#!/usr/bin/env python3
# Lattice worker -- MIT License
# Copyright (c) 2026 Lattice contributors
#
# Permission is hereby granted, free of charge, to any person obtaining a copy of
# this software and associated documentation files, to deal in the Software
# without restriction, subject to the MIT License terms (see LICENSE).
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
"""Lattice worker: the GPU-side half of the Lattice world-model IDE.

The phone (PWA) composes `lattice.job/1` jobs and POSTs them here. This worker
validates them, queues them (one at a time, FIFO), and either runs the real
pipeline as a subprocess or -- by default -- performs an honest *dry run* that
walks the real stage list and writes the command it would have run.

It never executes the client-supplied `code` field. Real execution builds its own
argv from whitelisted fields only (engine / mode / model / prompt / params / inputs).

Endpoints (see CONTRACT): GET /health, POST /jobs, GET /jobs, GET /jobs/<id>,
POST /jobs/<id>/cancel, GET /runs/<id>/<path>.

Environment:
  LATTICE_HOST (0.0.0.0)  LATTICE_PORT (8787)  LATTICE_RUNS (./runs)
  LATTICE_DRY_RUN=1  force dry run
  LATTICE_EXEC=1     allow real subprocess execution (otherwise dry run)
  LATTICE_TOKEN      optional bearer token for everything but OPTIONS and GET /health
  LATTICE_COSMOS_CMD / LATTICE_HY_CMD        command prefix overrides
  LATTICE_COSMOS_MODULE / LATTICE_HY_MODULE  engine module names for detection

HF tokens arrive only as the `X-HF-Token` header on POST /jobs, live in memory for
that job only, are passed to the subprocess as HF_TOKEN, and are redacted from logs.

Stdlib only, Python 3.10+.
"""
from __future__ import annotations

import argparse
import base64
import binascii
import datetime as _dt
import hmac
import importlib.util
import json
import mimetypes
import os
import queue
import re
import secrets
import shlex
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VERSION = "1.0.0"
SCHEMA = "lattice.job/1"
MAX_BODY = 64 * 1024 * 1024
MAX_MEDIA = 24 * 1024 * 1024
STAGE_SLEEP = 0.6
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

STAGES = {
    "cosmos": ["validate", "fetch-weights", "load", "infer", "encode"],
    "hyworld": ["validate", "pano", "worldnav", "worldstereo", "3dgs", "export"],
    "bridge": ["validate", "cosmos-rollout", "keyframes", "hy-freeze", "export"],
}
MODES = {
    "cosmos": {"reason", "generate", "action", "edge"},
    "hyworld": {"pano", "worldmirror", "stereo", "export"},
    "bridge": {"bridge"},
}
COSMOS_MODELS = ["cosmos3-edge-4b", "cosmos3-nano-16b", "cosmos3-super-64b",
                 "cosmos3-i2v", "cosmos3-droid-policy"]
HY_MODEL = "hy-world-2.0"
TARGETS = {"jetson", "rtx", "datacenter"}
FEASIBLE = {
    "cosmos3-edge-4b": {"jetson", "rtx", "datacenter"},
    "cosmos3-nano-16b": {"rtx", "datacenter"},
    "cosmos3-super-64b": {"datacenter"},
    "cosmos3-i2v": {"rtx", "datacenter"},
    "cosmos3-droid-policy": {"jetson", "rtx", "datacenter"},
    HY_MODEL: {"rtx", "datacenter"},
}
LICENSE_IDS = {
    "cosmos": "OpenMDW-1.1",
    "hyworld": "Tencent-HY-World-2.0",
    "bridge": "OpenMDW-1.1+Tencent-HY-World-2.0",
}
ENGINE_LICENSE = {"cosmos": "OpenMDW-1.1", "hyworld": "Tencent HY-World 2.0 License.txt"}

# Whitelisted params: name -> validator returning a normalized value or raising ValueError.
def _int(lo, hi):
    def f(v):
        if isinstance(v, bool) or not isinstance(v, (int, float, str)):
            raise ValueError("must be an integer")
        iv = int(float(v))
        if float(v) != iv or not lo <= iv <= hi:
            raise ValueError(f"must be an integer in [{lo}, {hi}]")
        return iv
    return f


def _float(lo, hi):
    def f(v):
        if isinstance(v, bool) or not isinstance(v, (int, float, str)):
            raise ValueError("must be a number")
        fv = float(v)
        if not lo <= fv <= hi:
            raise ValueError(f"must be in [{lo}, {hi}]")
        return fv
    return f


def _enum(*opts):
    def f(v):
        if v not in opts:
            raise ValueError("must be one of " + ", ".join(opts))
        return v
    return f


def _res(v):
    if not isinstance(v, str) or not re.fullmatch(r"[0-9]{2,5}(x[0-9]{2,5}|p)", v):
        raise ValueError("must look like 1280x704 or 720p")
    return v


PARAMS = {
    "frames": _int(1, 10000),
    "fps": _int(1, 240),
    "resolution": _res,
    "seed": _int(0, 2**32 - 1),
    "guidance": _float(0, 100),
    "steps": _int(1, 1000),
    "keyframe_stride": _int(1, 1000),
    "export_target": _enum("unity", "unreal", "isaac"),
    "format": _enum("ply", "spz", "glb", "usd"),
}

ARTIFACT_KINDS = {
    ".mp4": "video", ".webm": "video", ".mov": "video",
    ".ply": "splat", ".spz": "splat", ".splat": "splat",
    ".glb": "mesh", ".usd": "mesh", ".usdz": "mesh", ".obj": "mesh",
    ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image",
    ".json": "json", ".txt": "text",
}
HIDDEN = {"job.json", "status.json", "log.txt"}

mimetypes.add_type("model/gltf-binary", ".glb")
mimetypes.add_type("application/octet-stream", ".ply")
mimetypes.add_type("application/octet-stream", ".spz")
mimetypes.add_type("application/octet-stream", ".splat")
mimetypes.add_type("model/vnd.usdz+zip", ".usdz")
mimetypes.add_type("video/webm", ".webm")


def now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def env_on(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


def sanitize_name(name: str, fallback: str) -> str:
    base = os.path.basename(str(name or "").replace("\\", "/"))
    base = re.sub(r"[^A-Za-z0-9._-]", "_", base).lstrip(".")[:96]
    return base or fallback


class JobError(Exception):
    pass


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------
def validate_job(job) -> dict:
    """Validate a lattice.job/1 body; returns normalized params. Raises JobError."""
    if not isinstance(job, dict):
        raise JobError("body must be a JSON object")
    if job.get("schema") != SCHEMA:
        raise JobError(f'schema must be "{SCHEMA}"')
    engine = job.get("engine")
    if engine not in MODES:
        raise JobError("engine must be one of cosmos, hyworld, bridge")
    mode = job.get("mode")
    if mode not in MODES[engine]:
        raise JobError(f"mode for {engine} must be one of " + ", ".join(sorted(MODES[engine])))
    model = job.get("model")
    if engine == "cosmos":
        if model not in COSMOS_MODELS:
            raise JobError("model for cosmos must be one of " + ", ".join(COSMOS_MODELS))
        parts = [model]
    elif engine == "hyworld":
        if model != HY_MODEL:
            raise JobError(f'model for hyworld must be "{HY_MODEL}"')
        parts = [model]
    else:
        cm, _, hm = str(model or "").partition("+")
        if cm not in COSMOS_MODELS or hm != HY_MODEL:
            raise JobError(f'model for bridge must be "<cosmos model>+{HY_MODEL}"')
        parts = [cm, hm]
    target = job.get("target", "rtx")
    if target not in TARGETS:
        raise JobError("target must be one of jetson, rtx, datacenter")
    for p in parts:
        if target not in FEASIBLE[p]:
            raise JobError(f"{p} cannot run on {target}; supported targets: "
                           + ", ".join(sorted(FEASIBLE[p])))
    lic = job.get("license")
    if not isinstance(lic, dict) or lic.get("accepted") is not True:
        raise JobError("license.accepted must be true")
    if lic.get("id") != LICENSE_IDS[engine]:
        raise JobError(f'license.id for {engine} must be "{LICENSE_IDS[engine]}"')
    inputs = job.get("inputs", {})
    if inputs is None:
        inputs = {}
    if not isinstance(inputs, dict):
        raise JobError("inputs must be an object")
    prompt = inputs.get("prompt", "")
    if not isinstance(prompt, str) or len(prompt) > 20000:
        raise JobError("inputs.prompt must be a string (<= 20000 chars)")
    media = inputs.get("media", [])
    if media is None:
        media = []
    if not isinstance(media, list) or len(media) > 64 or not all(isinstance(m, dict) for m in media):
        raise JobError("inputs.media must be a list of objects")
    params = inputs.get("params", {}) or {}
    if not isinstance(params, dict):
        raise JobError("inputs.params must be an object")
    clean = {}
    for k, v in params.items():
        if k in PARAMS and v is not None and v != "":
            try:
                clean[k] = PARAMS[k](v)
            except (ValueError, TypeError) as e:
                raise JobError(f"inputs.params.{k} {e}")
    return clean


# ---------------------------------------------------------------------------
# Worker state
# ---------------------------------------------------------------------------
class Job:
    def __init__(self, status: dict, run_dir: Path, job: dict | None = None,
                 params: dict | None = None, hf_token: str | None = None):
        self.status = status
        self.run_dir = run_dir
        self.job = job or {}
        self.params = params or {}
        self.hf_token = hf_token  # memory only; cleared when the job finishes
        self.cancel = threading.Event()
        self.proc: subprocess.Popen | None = None


class Worker:
    def __init__(self, runs_dir: Path, force_dry: bool):
        self.runs = runs_dir.resolve()
        self.runs.mkdir(parents=True, exist_ok=True)
        self.force_dry = force_dry
        self.exec = env_on("LATTICE_EXEC")
        self.token = os.environ.get("LATTICE_TOKEN", "") or ""
        self.lock = threading.RLock()
        self.jobs: dict[str, Job] = {}
        self.q: "queue.Queue[str]" = queue.Queue()
        self.cosmos_mod = os.environ.get("LATTICE_COSMOS_MODULE") or "cosmos3"
        self.hy_mod = os.environ.get("LATTICE_HY_MODULE") or "hyworld"
        self.gpu = detect_gpu()
        self._reload()
        threading.Thread(target=self._loop, name="lattice-runner", daemon=True).start()

    # -- engines -----------------------------------------------------------
    @staticmethod
    def _installed(mod: str) -> bool:
        try:
            return importlib.util.find_spec(mod) is not None
        except (ImportError, ValueError):
            return False

    def engines(self) -> dict:
        return {"cosmos": {"installed": self._installed(self.cosmos_mod), "license": ENGINE_LICENSE["cosmos"]},
                "hyworld": {"installed": self._installed(self.hy_mod), "license": ENGINE_LICENSE["hyworld"]}}

    def global_dry(self) -> bool:
        return self.force_dry or not self.exec

    def job_dry(self, engine: str) -> bool:
        if self.global_dry():
            return True
        e = self.engines()
        need = ["cosmos", "hyworld"] if engine == "bridge" else [engine]
        return not all(e[n]["installed"] for n in need)

    def health(self) -> dict:
        return {"ok": True, "service": "lattice-worker", "version": VERSION, "schema": SCHEMA,
                "dry_run": self.global_dry(), "exec": self.exec and not self.force_dry,
                "auth": bool(self.token), "engines": self.engines(), "gpu": self.gpu,
                "queue": self.q.qsize(), "runs_dir": str(self.runs)}

    # -- persistence -------------------------------------------------------
    def _reload(self):
        for sp in sorted(self.runs.glob("*/status.json")):
            try:
                st = json.loads(sp.read_text("utf-8"))
                if not isinstance(st, dict) or not ID_RE.match(str(st.get("id", ""))):
                    continue
                if st.get("status") in ("queued", "running"):
                    st["status"] = "failed"
                    st["error"] = "worker restarted"
                    st["updated"] = now_iso()
                    sp.write_text(json.dumps(st, indent=2), "utf-8")
                self.jobs[st["id"]] = Job(st, sp.parent)
            except (OSError, ValueError):
                continue

    def _save(self, j: Job):
        tmp = j.run_dir / "status.json.tmp"
        tmp.write_text(json.dumps(j.status, indent=2), "utf-8")
        os.replace(tmp, j.run_dir / "status.json")

    def redact(self, j: Job, line: str) -> str:
        if j.hf_token:
            line = line.replace(j.hf_token, "hf_***")
        if self.token:
            line = line.replace(self.token, "***")
        return re.sub(r"hf_[A-Za-z0-9]{8,}", "hf_***", line)

    def log(self, j: Job, line: str):
        line = self.redact(j, line.rstrip("\r\n"))
        stamp = time.strftime("%H:%M:%S")
        with self.lock:
            j.status["log"] = (j.status.get("log", []) + [f"[{stamp}] {line}"])[-50:]
            j.status["updated"] = now_iso()
            try:
                with open(j.run_dir / "log.txt", "a", encoding="utf-8") as f:
                    f.write(f"[{stamp}] {line}\n")
            except OSError:
                pass
            self._save(j)

    def update(self, j: Job, **kw):
        with self.lock:
            j.status.update(kw)
            j.status["updated"] = now_iso()
            self._save(j)

    # -- API ops -----------------------------------------------------------
    def submit(self, job: dict, hf_token: str | None) -> dict:
        params = validate_job(job)
        jid = job.get("id")
        if not isinstance(jid, str) or not ID_RE.match(jid):
            jid = None
        with self.lock:
            if jid is None or jid in self.jobs or (self.runs / jid).exists():
                jid = "lj_" + time.strftime("%Y%m%d%H%M%S", time.gmtime()) + "_" + secrets.token_hex(3)
            run_dir = self.runs / jid
            (run_dir / "inputs").mkdir(parents=True, exist_ok=True)
        stored = json.loads(json.dumps(job))
        stored["id"] = jid
        stored["outputs"] = dict(stored.get("outputs") or {}, dir=f"./runs/{jid}/")
        inputs = stored.setdefault("inputs", {}) or {}
        stored["inputs"] = inputs
        media_out = []
        used = set()
        try:
            for i, m in enumerate(inputs.get("media") or []):
                m = dict(m)
                name = sanitize_name(m.get("name"), f"input_{i}")
                stem, ext = os.path.splitext(name)
                n = 1
                while name in used:
                    name = f"{stem}_{n}{ext}"
                    n += 1
                used.add(name)
                data = m.pop("data", None)
                if isinstance(data, str) and data:
                    mt = re.match(r"^data:([^;,]*)(;[^,]*)?,", data)
                    if not mt or "base64" not in (mt.group(2) or ""):
                        raise JobError(f"media[{i}].data must be a base64 data: URL")
                    try:
                        raw = base64.b64decode(data[mt.end():], validate=False)
                    except (binascii.Error, ValueError):
                        raise JobError(f"media[{i}].data is not valid base64")
                    if len(raw) > MAX_MEDIA:
                        raise JobError(f"media[{i}] exceeds 24 MB")
                    (run_dir / "inputs" / name).write_bytes(raw)
                    m["path"] = f"inputs/{name}"
                    m["size"] = len(raw)
                else:
                    m["path"] = None  # metadata only; file was not uploaded
                m["name"] = name
                media_out.append(m)
        except JobError:
            shutil.rmtree(run_dir, ignore_errors=True)
            raise
        inputs["media"] = media_out
        (run_dir / "job.json").write_text(json.dumps(stored, indent=2), "utf-8")
        engine = stored["engine"]
        dry = self.job_dry(engine)
        ts = now_iso()
        status = {"id": jid, "status": "queued", "progress": 0.0, "stage": "queued",
                  "engine": engine, "mode": stored["mode"], "model": stored["model"],
                  "created": ts, "updated": ts, "dry_run": dry, "error": None,
                  "log": [], "artifacts": []}
        j = Job(status, run_dir, stored, params, hf_token or None)
        with self.lock:
            self.jobs[jid] = j
            self._save(j)
        self.log(j, f"queued {engine}/{stored['mode']} model={stored['model']} target={stored.get('target', 'rtx')}"
                    f" dry_run={dry} hf_token={'provided' if hf_token else 'none'}")
        self.q.put(jid)
        return {"id": jid, "status": "queued"}

    def list(self, limit: int) -> list:
        with self.lock:
            items = sorted(self.jobs.values(), key=lambda j: (j.status.get("created", ""), j.status["id"]),
                           reverse=True)
            return [json.loads(json.dumps(j.status)) for j in items[:limit]]

    def get(self, jid: str) -> dict | None:
        with self.lock:
            j = self.jobs.get(jid)
            return json.loads(json.dumps(j.status)) if j else None

    def cancel(self, jid: str) -> dict | None:
        with self.lock:
            j = self.jobs.get(jid)
            if not j:
                return None
            st = j.status["status"]
            if st == "queued":
                j.cancel.set()
                j.hf_token = None
                self.update(j, status="cancelled", stage="cancelled")
                self.log(j, "cancelled while queued")
            elif st == "running":
                j.cancel.set()
                self.log(j, "cancel requested")
                if j.proc and j.proc.poll() is None:
                    try:
                        j.proc.terminate()
                    except OSError:
                        pass
            return json.loads(json.dumps(j.status))

    # -- runner ------------------------------------------------------------
    def _loop(self):
        while True:
            jid = self.q.get()
            j = self.jobs.get(jid)
            if not j or j.status["status"] != "queued" or j.cancel.is_set():
                continue
            try:
                self.update(j, status="running", stage=STAGES[j.job["engine"]][0])
                if j.status["dry_run"]:
                    self._dry(j)
                else:
                    self._real(j)
                if j.cancel.is_set():
                    self.update(j, status="cancelled", stage="cancelled")
                    self.log(j, "cancelled")
                else:
                    self._collect(j)
                    self.update(j, status="done", stage="done", progress=1.0)
                    self.log(j, "done")
            except Exception as e:  # noqa: BLE001 -- surface any failure on the job
                if j.cancel.is_set():
                    self.update(j, status="cancelled", stage="cancelled")
                    self.log(j, "cancelled")
                else:
                    msg = self.redact(j, str(e)) or e.__class__.__name__
                    self.update(j, status="failed", error=msg)
                    self.log(j, f"failed: {msg}")
                    self._collect(j)
            finally:
                j.hf_token = None
                j.proc = None

    # argv builders use whitelisted fields only; the client `code` field is ignored.
    def _inputs(self, j: Job) -> list:
        out = []
        for m in j.job.get("inputs", {}).get("media", []):
            if m.get("path"):
                out += ["--input", str(j.run_dir / m["path"])]
        return out

    def _params(self, j: Job, keys=None) -> list:
        out = []
        for k, v in j.params.items():
            if keys is None or k in keys:
                out += ["--" + k.replace("_", "-"), str(v)]
        return out

    def commands(self, j: Job) -> list:
        """Return [(stage, argv)] for the job's real pipeline."""
        eng, mode, model = j.job["engine"], j.job["mode"], j.job["model"]
        prompt = j.job.get("inputs", {}).get("prompt", "") or ""
        rd = str(j.run_dir)
        cprefix = shlex.split(os.environ.get("LATTICE_COSMOS_CMD") or "python -m cosmos3.cli")
        hprefix = shlex.split(os.environ.get("LATTICE_HY_CMD") or "python -m hyworld.cli")
        if eng == "cosmos":
            return [("infer", [*cprefix, mode, "--model", model, "--prompt", prompt, "--out", rd,
                               *self._inputs(j), *self._params(j)])]
        if eng == "hyworld":
            return [("pano", [*hprefix, mode, "--model", model, "--prompt", prompt, "--out", rd,
                              *self._inputs(j), *self._params(j)])]
        cm = model.split("+")[0]
        stride = str(j.params.get("keyframe_stride", 8))
        cosmos_keys = {"frames", "fps", "resolution", "seed", "guidance", "steps"}
        hy_keys = {"seed", "export_target", "format"}
        return [
            ("cosmos-rollout", [*cprefix, "generate", "--model", cm, "--prompt", prompt,
                                "--out", str(j.run_dir / "rollout"), *self._inputs(j),
                                *self._params(j, cosmos_keys)]),
            ("keyframes", ["ffmpeg", "-y", "-i", str(j.run_dir / "rollout" / "*.mp4"),
                           "-vf", f"select=not(mod(n\\,{stride}))", "-vsync", "vfr",
                           str(j.run_dir / "keyframes" / "kf_%04d.png")]),
            ("hy-freeze", [*hprefix, "worldmirror", "--model", HY_MODEL, "--prompt", prompt,
                           "--out", rd, "--input-dir", str(j.run_dir / "keyframes"),
                           *self._params(j, hy_keys)]),
        ]

    def _dry(self, j: Job):
        eng = j.job["engine"]
        stages = STAGES[eng]
        cmds = self.commands(j)
        self.log(j, "DRY RUN: engine not executed (set LATTICE_EXEC=1 with the engine installed to run for real)")
        for i, stage in enumerate(stages):
            if j.cancel.is_set():
                return
            self.update(j, stage=stage, progress=round(i / len(stages), 3))
            self.log(j, f"stage {stage}")
            for s, argv in cmds:
                if s == stage:
                    self.log(j, "would run: " + shlex.join(argv) + (" (env HF_TOKEN=$HF_TOKEN)" if j.hf_token else ""))
            end = time.time() + STAGE_SLEEP
            while time.time() < end:
                if j.cancel.wait(0.05):
                    return
        plan = {"schema": "lattice.plan/1", "id": j.status["id"], "dry_run": True,
                "engine": eng, "mode": j.job["mode"], "model": j.job["model"],
                "target": j.job.get("target", "rtx"), "stages": stages,
                "params": j.params,
                "commands": [{"stage": s, "argv": a, "shell": shlex.join(a)} for s, a in cmds],
                "env": {"HF_TOKEN": "$HF_TOKEN" if j.hf_token else None},
                "note": "Dry run. Nothing was executed. The client-supplied code field is never executed."}
        (j.run_dir / "plan.json").write_text(json.dumps(plan, indent=2), "utf-8")
        lines = [f"Lattice dry-run plan for {j.status['id']}",
                 f"engine={eng} mode={j.job['mode']} model={j.job['model']} target={plan['target']}",
                 "", "Stages: " + " -> ".join(stages), "", "Commands that would run:"]
        lines += [f"  [{s}] {shlex.join(a)}" for s, a in cmds]
        lines += ["", "HF_TOKEN is passed via environment only and is never written to disk."]
        (j.run_dir / "plan.txt").write_text("\n".join(lines) + "\n", "utf-8")

    def _run(self, j: Job, argv: list, p0: float, p1: float, cwd: Path | None = None):
        env = dict(os.environ)
        env.pop("LATTICE_TOKEN", None)
        if j.hf_token:
            env["HF_TOKEN"] = j.hf_token
        self.log(j, "run: " + shlex.join(argv))
        j.proc = subprocess.Popen(argv, cwd=str(cwd or j.run_dir), env=env, stdin=subprocess.DEVNULL,
                                  stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                  errors="replace", bufsize=1)
        for line in j.proc.stdout:
            m = re.match(r"^\s*PROGRESS\s+([0-9.]+)", line)
            if m:
                try:
                    f = max(0.0, min(1.0, float(m.group(1))))
                    self.update(j, progress=round(p0 + (p1 - p0) * f, 3))
                    continue
                except ValueError:
                    pass
            self.log(j, line)
        rc = j.proc.wait()
        if j.cancel.is_set():
            return
        if rc != 0:
            raise RuntimeError(f"{argv[0]} exited with code {rc}")

    def _real(self, j: Job):
        eng = j.job["engine"]
        cmds = dict(self.commands(j))
        self.update(j, stage="validate", progress=0.02)
        self.log(j, "executing pipeline (client code field ignored; argv built from whitelisted fields)")
        if eng != "bridge":
            stage = "infer" if eng == "cosmos" else "pano"
            self.update(j, stage=stage)
            self._run(j, cmds[stage], 0.05, 0.95)
            self.update(j, stage=STAGES[eng][-1])
            return
        (j.run_dir / "rollout").mkdir(exist_ok=True)
        kf = j.run_dir / "keyframes"
        kf.mkdir(exist_ok=True)
        self.update(j, stage="cosmos-rollout")
        self._run(j, cmds["cosmos-rollout"], 0.05, 0.5)
        if j.cancel.is_set():
            return
        self.update(j, stage="keyframes", progress=0.5)
        vids = sorted(p for p in (j.run_dir / "rollout").rglob("*") if p.suffix.lower() in (".mp4", ".webm"))
        if not vids:
            raise RuntimeError("cosmos rollout produced no video")
        if shutil.which("ffmpeg"):
            argv = list(cmds["keyframes"])
            argv[3] = str(vids[0])
            self._run(j, argv, 0.5, 0.6)
        else:
            self.log(j, "ffmpeg not found; passing rollout video to HY-World directly")
            shutil.copy(vids[0], kf / vids[0].name)
        if j.cancel.is_set():
            return
        self.update(j, stage="hy-freeze", progress=0.6)
        self._run(j, cmds["hy-freeze"], 0.6, 0.95)
        self.update(j, stage="export")

    def _collect(self, j: Job):
        arts = []
        base = j.run_dir
        for p in sorted(base.rglob("*")):
            if not p.is_file():
                continue
            rel = p.relative_to(base).as_posix()
            if rel in HIDDEN or rel.startswith("inputs/") or rel.endswith(".tmp"):
                continue
            kind = ARTIFACT_KINDS.get(p.suffix.lower())
            if not kind:
                continue
            arts.append({"kind": kind, "name": rel,
                         "url": f"/runs/{j.status['id']}/" + urllib.parse.quote(rel),
                         "bytes": p.stat().st_size})
        self.update(j, artifacts=arts)


def detect_gpu():
    exe = shutil.which("nvidia-smi")
    if not exe:
        return None
    try:
        out = subprocess.run([exe, "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=5).stdout.strip().splitlines()
        name, mem = [s.strip() for s in out[0].split(",")[:2]]
        return {"name": name, "memory_mb": int(float(mem))}
    except (OSError, subprocess.SubprocessError, IndexError, ValueError):
        return None


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "lattice-worker/" + VERSION
    protocol_version = "HTTP/1.1"
    worker: Worker = None  # set in main

    def log_message(self, fmt, *args):  # never log headers or tokens
        path = self.path.split("?", 1)[0] if isinstance(self.path, str) else "-"
        code = args[1] if len(args) > 1 else "-"
        sys.stderr.write(f"{self.address_string()} {self.command} {path} {code}\n")

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-HF-Token")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges")
        self.send_header("Access-Control-Max-Age", "600")

    def _json(self, code: int, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _authed(self, query_token: str | None = None) -> bool:
        tok = self.worker.token
        if not tok:
            return True
        got = self.headers.get("Authorization", "")
        if got.startswith("Bearer ") and hmac.compare_digest(got[7:].strip().encode(), tok.encode()):
            return True
        # ?token= is accepted only for GET /runs (media elements cannot send headers).
        if query_token is not None and hmac.compare_digest(query_token.encode(), tok.encode()):
            return True
        self._json(401, {"error": "unauthorized"})
        return False

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        u = urllib.parse.urlsplit(self.path)
        path = u.path.rstrip("/") or "/"
        if path == "/health":
            return self._json(200, self.worker.health())
        qtok = None
        if u.path.startswith("/runs/"):
            qtok = urllib.parse.parse_qs(u.query).get("token", [None])[0]
        if not self._authed(qtok):
            return
        if path == "/jobs":
            qs = urllib.parse.parse_qs(u.query)
            try:
                limit = int(qs.get("limit", ["8"])[0])
            except ValueError:
                limit = 8
            return self._json(200, {"jobs": self.worker.list(max(1, min(200, limit)))})
        m = re.fullmatch(r"/jobs/([A-Za-z0-9_-]{1,64})", path)
        if m:
            st = self.worker.get(m.group(1))
            return self._json(200, st) if st else self._json(404, {"error": "not found"})
        if u.path.startswith("/runs/"):
            return self._serve_run(urllib.parse.unquote(u.path[len("/runs/"):]))
        return self._json(404, {"error": "not found"})

    do_HEAD = do_GET

    def do_POST(self):
        path = urllib.parse.urlsplit(self.path).path.rstrip("/")
        if not self._authed():
            self._drain()
            return
        if path == "/jobs":
            try:
                n = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                n = -1
            if n < 0 or n > MAX_BODY:
                self.close_connection = True
                return self._json(413 if n > MAX_BODY else 400, {"error": "body too large (max 64 MB)" if n > 0 else "bad Content-Length"})
            raw = self.rfile.read(n)
            try:
                job = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                return self._json(400, {"error": "body must be valid JSON"})
            hf = (self.headers.get("X-HF-Token") or "").strip() or None
            try:
                res = self.worker.submit(job, hf)
            except JobError as e:
                return self._json(400, {"error": str(e)})
            finally:
                hf = None
            return self._json(201, res)
        self._drain()
        m = re.fullmatch(r"/jobs/([A-Za-z0-9_-]{1,64})/cancel", path)
        if m:
            st = self.worker.cancel(m.group(1))
            return self._json(200, st) if st else self._json(404, {"error": "not found"})
        return self._json(404, {"error": "not found"})

    def _drain(self):
        try:
            n = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            n = 0
        if 0 < n <= MAX_BODY:
            self.rfile.read(n)
        elif n > MAX_BODY:
            self.close_connection = True

    def _serve_run(self, rel: str):
        parts = rel.split("/", 1)
        if len(parts) != 2 or not ID_RE.match(parts[0]) or not parts[1]:
            return self._json(404, {"error": "not found"})
        root = (self.worker.runs / parts[0]).resolve()
        target = (root / parts[1]).resolve()
        try:
            target.relative_to(root)
        except ValueError:
            return self._json(404, {"error": "not found"})
        if not root.is_dir() or root.parent != self.worker.runs or not target.is_file():
            return self._json(404, {"error": "not found"})
        size = target.stat().st_size
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype == "application/json":
            ctype += "; charset=utf-8"
        start, end, code = 0, size - 1, 200
        rng = self.headers.get("Range")
        if rng and size > 0:
            mr = re.fullmatch(r"bytes=(\d*)-(\d*)", rng.strip())
            if mr and (mr.group(1) or mr.group(2)):
                if mr.group(1):
                    start = int(mr.group(1))
                    end = min(int(mr.group(2)), size - 1) if mr.group(2) else size - 1
                else:
                    start = max(0, size - int(mr.group(2)))
                if start > end or start >= size:
                    self.send_response(416)
                    self._cors()
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                code = 206
        length = max(0, end - start + 1)
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        self.send_header("X-Content-Type-Options", "nosniff")
        if code == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(target, "rb") as f:
            f.seek(start)
            left = length
            while left > 0:
                chunk = f.read(min(65536, left))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    return
                left -= len(chunk)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Lattice worker (control-surface backend)")
    ap.add_argument("--host", default=os.environ.get("LATTICE_HOST", "0.0.0.0"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("LATTICE_PORT", "8787")))
    ap.add_argument("--runs", default=os.environ.get("LATTICE_RUNS", "./runs"))
    ap.add_argument("--dry-run", action="store_true", default=env_on("LATTICE_DRY_RUN"))
    a = ap.parse_args(argv)
    worker = Worker(Path(a.runs), a.dry_run)
    Handler.worker = worker
    httpd = ThreadingHTTPServer((a.host, a.port), Handler)
    httpd.daemon_threads = True
    h = worker.health()
    shown = "localhost" if a.host in ("0.0.0.0", "") else a.host
    print(f"Lattice worker {VERSION} listening on http://{shown}:{a.port} (bind {a.host})", flush=True)
    print(f"  mode: {'DRY RUN' if h['dry_run'] else 'EXEC'}  (LATTICE_EXEC={'1' if worker.exec else '0'}, "
          f"forced dry-run={'yes' if a.dry_run else 'no'})", flush=True)
    print(f"  engines: cosmos={'installed' if h['engines']['cosmos']['installed'] else 'missing'} "
          f"hyworld={'installed' if h['engines']['hyworld']['installed'] else 'missing'}", flush=True)
    print(f"  runs dir: {worker.runs}", flush=True)
    print(f"  auth: {'on (Bearer token required)' if worker.token else 'off'}", flush=True)
    print(f"  gpu: {h['gpu']['name'] if h['gpu'] else 'none detected'}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("shutting down", flush=True)
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
