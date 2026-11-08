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
POST /jobs/<id>/cancel, GET /runs/<id>/<path>, GET /audit, GET /audit.csv, GET /report.

Environment:
  LATTICE_HOST (0.0.0.0)  LATTICE_PORT (8787)  LATTICE_RUNS (./runs)
  LATTICE_DRY_RUN=1  force dry run
  LATTICE_EXEC=1     allow real subprocess execution (otherwise dry run)
  LATTICE_TOKEN      optional bearer token for everything but OPTIONS and GET /health
  LATTICE_USERS      optional path to a users file (per-user tokens stored as sha256, roles
                     viewer / operator / admin); replaces LATTICE_TOKEN when set.
                     Manage it with `python3 worker.py users add|list|remove|rotate`.
  LATTICE_TRUST_PROXY=1  take the client IP for the audit log from X-Forwarded-For
  LATTICE_COSMOS_CMD / LATTICE_HY_CMD        command prefix overrides
  LATTICE_COSMOS_MODULE / LATTICE_HY_MODULE  upstream packages used to detect the engines
                     (defaults: diffusers, or cosmos_framework when LATTICE_COSMOS_BACKEND=framework;
                     hyworld2, or a checkout at LATTICE_HY_ROOT). The default engine command is the
                     bundled adapter: <sys.executable> adapters/<engine>/cli.py (see ENGINES.md).
  LATTICE_REGION     ISO 3166 alpha-2 where this worker runs (HY-World territory gate)
  LATTICE_GPU_USD_HR optional $/GPU-hour used to compute Status.metrics.cost_usd

HF tokens arrive only as the `X-HF-Token` header on POST /jobs, live in memory for
that job only, are passed to the subprocess as HF_TOKEN, and are redacted from logs.

Stdlib only, Python 3.10+.
"""
from __future__ import annotations

import argparse
import base64
import binascii
import collections
import csv
import datetime as _dt
import getpass
import hashlib
import hmac
import io
import importlib.util
import json
import mimetypes
import os
import queue
import re
import secrets
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
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
# Models tied to one mode; any model not listed runs in every cosmos mode.
MODEL_MODES = {
    "cosmos3-droid-policy": {"action"},
    "cosmos3-i2v": {"generate"},
}
LICENSE_IDS = {
    "cosmos": "OpenMDW-1.1",
    "hyworld": "Tencent-HY-World-2.0",
    "bridge": "OpenMDW-1.1+Tencent-HY-World-2.0",
}
# HY-World 2.0 license "does not apply" in the EU, UK and South Korea (preamble, §1(l), §5(c)).
EU27 = {"AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV",
        "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"}
HY_EXCLUDED = EU27 | {"GB", "KR"}
HY_ENGINES = {"hyworld", "bridge"}
COSMOS_ENGINES = {"cosmos", "bridge"}
REGION_RE = re.compile(r"^[A-Z]{2}$")

NOTICE_HY = """Tencent HY-WORLD 2.0 NOTICE
===========================
Tencent HY-WORLD 2.0 is licensed under the Tencent HY-WORLD 2.0 Community License Agreement,
Copyright \u00a9 2026 Tencent. All Rights Reserved. The trademark rights of \u201cTencent HY\u201d are
owned by Tencent or its affiliate.

This run used Tencent HY-WORLD 2.0. The governing terms are Tencent's own License.txt shipped with
the HY-WORLD 2.0 model materials (Tencent HY-WORLD 2.0 Community License Agreement and its
Acceptable Use Policy). Read that file; it controls over this summary. Lattice does not relicense it.

Key restrictions (summary, not legal advice -- see License.txt):
- Territory: the license does NOT apply in the European Union, the United Kingdom or South Korea.
  Do not use, reproduce, modify, distribute or display the Works, Outputs or results there (§5(c)).
- Outputs may not be used to improve any other AI model (other than Tencent HY-WORLD 2.0 or its
  Model Derivatives) (§5(b)). Do not use these outputs as training data for other models.
- Recipients of distributed Model Materials must receive a copy of the agreement and this notice (§3).
- Licensees whose products exceeded 1 million monthly active users must request a license from
  Tencent (§4).
"""
NOTICE_COSMOS = """NVIDIA Cosmos 3 NOTICE
======================
This run used NVIDIA Cosmos 3 model weights, made available under the OpenMDW License
(version 1.1 as stated by the model card; verify at https://openmdw.ai/license/).

- If you distribute any portion of the model materials you must retain a copy of the license and
  all copyright and other notices of origin included in the model materials.
- The license imposes no restrictions or obligations on the use, modification or sharing of
  outputs generated with the model materials.
- Offering the model as a competing public model API may be restricted; check the license and
  NVIDIA's model card before doing so.
Summary only, not legal advice. The license text governs.
"""

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

# Params each engine accepts; others are dropped so they never reach an argv.
ENGINE_PARAMS = {
    "cosmos": {"frames", "fps", "resolution", "seed", "guidance", "steps"},
    "hyworld": {"resolution", "seed", "export_target", "format"},
    "bridge": set(PARAMS),
}

ARTIFACT_KINDS = {
    ".mp4": "video", ".webm": "video", ".mov": "video",
    ".ply": "splat", ".spz": "splat", ".splat": "splat",
    ".glb": "mesh", ".usd": "mesh", ".usdz": "mesh", ".obj": "mesh",
    ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image",
    ".usda": "mesh", ".usdc": "mesh",
    ".json": "json", ".txt": "text", ".zip": "bundle",
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


def norm_region(v) -> str | None:
    """Normalize an ISO 3166 alpha-2 code (UK -> GB); None when empty."""
    if v is None or v == "":
        return None
    if not isinstance(v, str) or not REGION_RE.match(v.strip().upper()):
        raise ValueError("must be an ISO 3166 alpha-2 country code")
    v = v.strip().upper()
    return "GB" if v == "UK" else v


# Mirror of exporters.SUPPORTED, used when the package is not importable.
EXPORT_SUPPORTED = {"unity": ["ply", "spz", "glb", "usd"], "unreal": ["ply", "spz", "glb", "usd"],
                    "isaac": ["ply", "glb", "usd"]}


def export_supported() -> dict:
    mod = load_exporters()
    sup = getattr(mod, "SUPPORTED", None) if mod else None
    return sup if isinstance(sup, dict) else EXPORT_SUPPORTED


def load_exporters():
    """Import the optional exporters package lazily; None if absent."""
    here = str(Path(__file__).resolve().parent)
    if here not in sys.path:
        sys.path.insert(0, here)
    try:
        import exporters  # type: ignore
    except ImportError:
        return None
    return exporters if callable(getattr(exporters, "export", None)) else None


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
        if mode not in MODEL_MODES.get(model, MODES["cosmos"]):
            raise JobError(f"{model} only supports mode: "
                           + ", ".join(sorted(MODEL_MODES[model])))
        parts = [model]
    elif engine == "hyworld":
        if model != HY_MODEL:
            raise JobError(f'model for hyworld must be "{HY_MODEL}"')
        parts = [model]
    else:
        cm, _, hm = str(model or "").partition("+")
        if cm not in COSMOS_MODELS or hm != HY_MODEL:
            raise JobError(f'model for bridge must be "<cosmos model>+{HY_MODEL}"')
        if "generate" not in MODEL_MODES.get(cm, MODES["cosmos"]):
            raise JobError(f"{cm} cannot produce a bridge rollout (needs a generate-capable model)")
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
        if k in ENGINE_PARAMS[engine] and v is not None and v != "":
            try:
                clean[k] = PARAMS[k](v)
            except (ValueError, TypeError) as e:
                raise JobError(f"inputs.params.{k} {e}")
    tgt, fmt = clean.get("export_target"), clean.get("format")
    if tgt and fmt and fmt not in export_supported().get(tgt, []):
        raise JobError(f"{tgt} export does not support {fmt}")
    return clean


# ---------------------------------------------------------------------------
# Multi-user workspace: users file, roles, audit log
# ---------------------------------------------------------------------------
ROLES = ("viewer", "operator", "admin")
ROLE_RANK = {r: i for i, r in enumerate(ROLES)}
USER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$")
HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
AUDIT_DIR = "_audit"
AUDIT_FILE = "audit.jsonl"
AUDIT_FIELDS = ["ts", "user", "action", "job_id", "license_id", "accepted_at", "territory",
                "subject", "change", "role", "ip"]
# Identity used when LATTICE_USERS is unset: whoever passes the single-token (or open) check has full access.
FULL_ACCESS = {"name": None, "role": "admin"}


def token_sha256(tok: str) -> str:
    return hashlib.sha256(tok.encode("utf-8")).hexdigest()


def new_user_token() -> str:
    return "lt_" + secrets.token_urlsafe(32)


def _raw_users(path: Path) -> list:
    """Raw user entries of a users file (raises OSError / ValueError)."""
    doc = json.loads(Path(path).read_text("utf-8"))
    users = doc.get("users") if isinstance(doc, dict) else None
    if not isinstance(users, list):
        raise ValueError('users file must look like {"users": [...]}')
    return users


def read_users_file(path: Path) -> list:
    """Validated entries of a users file; malformed or duplicate entries are skipped."""
    out, seen = [], set()
    for u in _raw_users(path):
        if not isinstance(u, dict):
            continue
        name, role, h = u.get("name"), u.get("role"), str(u.get("token_sha256") or "").lower()
        if not isinstance(name, str) or not USER_RE.match(name) or role not in ROLES \
                or not HEX64_RE.match(h) or name in seen:
            continue
        seen.add(name)
        out.append({"name": name, "role": role, "token_sha256": h})
    return out


def write_users_file(path: Path, users: list):
    """Atomically replace the users file (mode 0600, written via a temp file + os.replace)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".lattice-users-", suffix=".tmp", dir=str(path.parent))
    try:
        if hasattr(os, "fchmod"):
            os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump({"users": users}, f, indent=2)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
        os.chmod(path, 0o600)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


class UserStore:
    """Users file loaded lazily and reloaded when it changes, so `users rotate` needs no restart.

    Tokens are never held here: only their sha256. A missing or unreadable file means no users
    (every authenticated request fails closed)."""

    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.Lock()
        self.sig = False  # never matches a real signature, so the first call loads
        self.users: list = []
        self.warned = None

    def _warn(self, msg: str):
        if msg != self.warned:
            self.warned = msg
            print("warning: " + msg, file=sys.stderr, flush=True)

    def entries(self) -> list:
        try:
            st = self.path.stat()
            sig = (st.st_ino, st.st_mtime_ns, st.st_size)
        except OSError:
            st, sig = None, None
        with self.lock:
            if sig == self.sig:
                return self.users
            self.sig = sig
            if st is None:
                self._warn(f"LATTICE_USERS file {self.path} not found; no user can sign in")
                self.users = []
            else:
                try:
                    self.users = read_users_file(self.path)
                    self.warned = None
                    if os.name == "posix" and st.st_mode & 0o077:
                        self._warn(f"LATTICE_USERS file {self.path} is readable by group/others; chmod 600 it")
                except (OSError, ValueError, UnicodeDecodeError) as e:
                    self._warn(f"cannot read LATTICE_USERS file {self.path} ({e.__class__.__name__}); "
                               "no user can sign in")
                    self.users = []
            return self.users

    def lookup(self, token: str | None) -> dict | None:
        """Constant-time match of a presented token against every stored hash."""
        if not token:
            return None
        h = token_sha256(token).encode()
        found = None
        for u in self.entries():
            if hmac.compare_digest(h, u["token_sha256"].encode()) and found is None:
                found = u
        return {"name": found["name"], "role": found["role"]} if found else None


def append_audit(runs: Path, rec: dict):
    """Append one JSON line to runs/_audit/audit.jsonl (dir 0700, file 0600). Never pass tokens here."""
    d = Path(runs) / AUDIT_DIR
    d.mkdir(mode=0o700, exist_ok=True)
    fd = os.open(str(d / AUDIT_FILE), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    with os.fdopen(fd, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, separators=(",", ":")) + "\n")


def audit_record(user, action: str, ip=None, **extra) -> dict:
    rec = {"ts": now_iso(), "user": user, "action": action}
    rec.update({k: v for k, v in extra.items() if v is not None})
    rec["ip"] = ip
    return rec


def parse_iso(v: str) -> _dt.datetime:
    """Parse an ISO 8601 date or datetime ('Z' allowed); naive values are taken as UTC."""
    s = str(v).strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
        s += "T00:00:00"
    if s.endswith(("Z", "z")):
        s = s[:-1] + "+00:00"
    d = _dt.datetime.fromisoformat(s)
    return d if d.tzinfo else d.replace(tzinfo=_dt.timezone.utc)


def csv_cell(v) -> str:
    s = "" if v is None else str(v)
    return "'" + s if s[:1] in ("=", "+", "-", "@", "\t", "\r") else s  # spreadsheet formula injection


def users_cli(argv) -> int:
    """`python3 worker.py users add|list|remove|rotate` -- manage the LATTICE_USERS file."""
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--file", default=os.environ.get("LATTICE_USERS") or None,
                        help="users file (default: $LATTICE_USERS)")
    common.add_argument("--runs", default=os.environ.get("LATTICE_RUNS", "./runs"),
                        help="runs dir whose _audit/audit.jsonl records the change (default: $LATTICE_RUNS or ./runs)")
    ap = argparse.ArgumentParser(prog="worker.py users", description="Manage Lattice worker users (tokens are "
                                 "stored only as sha256; a new token is printed once).")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("add", parents=[common], help="add a user and print its token once")
    p.add_argument("name")
    p.add_argument("--role", choices=ROLES, default="viewer")
    sub.add_parser("list", parents=[common], help="list users and roles (no hashes)")
    sub.add_parser("remove", parents=[common], help="remove a user").add_argument("name")
    sub.add_parser("rotate", parents=[common], help="issue a new token; the old one stops working").add_argument("name")
    a = ap.parse_args(argv)
    if not a.file:
        print("error: set LATTICE_USERS or pass --file", file=sys.stderr)
        return 2
    path = Path(a.file)
    try:
        users = _raw_users(path) if path.exists() else []
    except (OSError, ValueError, UnicodeDecodeError) as e:
        print(f"error: cannot read {path}: {e}", file=sys.stderr)
        return 1
    idx = {u.get("name"): i for i, u in enumerate(users) if isinstance(u, dict)}
    if a.cmd == "list":
        if not users:
            print("(no users)")
        for u in users:
            if isinstance(u, dict):
                print(f"{u.get('name')}\t{u.get('role')}\tcreated {u.get('created') or '-'}"
                      + (f"\trotated {u['rotated']}" if u.get("rotated") else ""))
        return 0
    name = a.name
    if a.cmd == "add":
        if not USER_RE.match(name):
            print("error: name must be 1-64 chars of letters, digits, . _ @ - (starting with a letter or digit)",
                  file=sys.stderr)
            return 2
        if name in idx:
            print(f"error: user {name} already exists (use rotate for a new token)", file=sys.stderr)
            return 1
        token = new_user_token()
        users.append({"name": name, "role": a.role, "token_sha256": token_sha256(token), "created": now_iso()})
        role = a.role
    else:
        if name not in idx:
            print(f"error: no user named {name}", file=sys.stderr)
            return 1
        role = users[idx[name]].get("role")
        token = None
        if a.cmd == "remove":
            users.pop(idx[name])
        else:
            token = new_user_token()
            users[idx[name]] = dict(users[idx[name]], token_sha256=token_sha256(token), rotated=now_iso())
    write_users_file(path, users)
    runs = Path(a.runs)
    if runs.is_dir():
        try:
            who = getpass.getuser()
        except (OSError, KeyError, ImportError):
            who = "unknown"
        try:
            append_audit(runs, audit_record("cli:" + who, "users.change", None, subject=name, change=a.cmd, role=role))
        except OSError as e:
            print(f"warning: could not write audit log: {e}", file=sys.stderr)
    else:
        print(f"note: runs dir {runs} not found; change not recorded in the audit log (pass --runs)", file=sys.stderr)
    if a.cmd == "remove":
        print(f"user {name} removed")
    else:
        print(f"user {name} {'added' if a.cmd == 'add' else 'rotated'} (role {role})")
        print("token (shown once; store it now, it cannot be recovered):")
        print(token)
    return 0


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
        self.stages: list = []  # per-stage metrics records
        self.cur = None
        self.t0 = time.time()


class Worker:
    def __init__(self, runs_dir: Path, force_dry: bool):
        self.runs = runs_dir.resolve()
        self.runs.mkdir(parents=True, exist_ok=True)
        self.force_dry = force_dry
        self.exec = env_on("LATTICE_EXEC")
        self.token = os.environ.get("LATTICE_TOKEN", "") or ""
        up = (os.environ.get("LATTICE_USERS") or "").strip()
        self.users: UserStore | None = UserStore(up) if up else None
        if self.users and self.token:
            print("warning: LATTICE_USERS is set, so LATTICE_TOKEN is ignored", file=sys.stderr)
        self.trust_proxy = env_on("LATTICE_TRUST_PROXY")
        self.lock = threading.RLock()
        self.audit_lock = threading.Lock()
        self.jobs: dict[str, Job] = {}
        self.q: "queue.Queue[str]" = queue.Queue()
        backend = (os.environ.get("LATTICE_COSMOS_BACKEND") or "diffusers").strip().lower()
        self.cosmos_mod = os.environ.get("LATTICE_COSMOS_MODULE") or (
            "cosmos_framework" if backend == "framework" else "diffusers")
        self.hy_mod = os.environ.get("LATTICE_HY_MODULE") or "hyworld2"
        self.gpu = detect_gpu()
        self.gpu_count = gpu_count() if self.gpu else 0
        try:
            self.region = norm_region(os.environ.get("LATTICE_REGION"))
        except ValueError:
            print("warning: LATTICE_REGION is not an ISO alpha-2 code; treating as unset", file=sys.stderr)
            self.region = None
        try:
            self.usd_hr = float(os.environ["LATTICE_GPU_USD_HR"]) if os.environ.get("LATTICE_GPU_USD_HR") else None
        except ValueError:
            self.usd_hr = None
        self._reload()
        threading.Thread(target=self._loop, name="lattice-runner", daemon=True).start()

    # -- engines -----------------------------------------------------------
    @staticmethod
    def _installed(mod: str) -> bool:
        try:
            return importlib.util.find_spec(mod) is not None
        except (ImportError, ValueError):
            return False

    @staticmethod
    def _hy_checkout() -> bool:
        # HY-World usually lives in its own Python env; a checkout at LATTICE_HY_ROOT counts as installed.
        root = os.environ.get("LATTICE_HY_ROOT")
        return bool(root) and (Path(root) / "hyworld2").is_dir()

    def engines(self) -> dict:
        return {"cosmos": {"installed": self._installed(self.cosmos_mod), "license": ENGINE_LICENSE["cosmos"]},
                "hyworld": {"installed": self._installed(self.hy_mod) or self._hy_checkout(),
                            "license": ENGINE_LICENSE["hyworld"]}}

    def global_dry(self) -> bool:
        return self.force_dry or not self.exec

    def job_dry(self, engine: str) -> bool:
        if self.global_dry():
            return True
        e = self.engines()
        need = ["cosmos", "hyworld"] if engine == "bridge" else [engine]
        return not all(e[n]["installed"] for n in need)

    def auth_mode(self) -> str:
        return "users" if self.users is not None else "token" if self.token else "open"

    def health(self) -> dict:
        return {"ok": True, "service": "lattice-worker", "version": VERSION, "schema": SCHEMA,
                "dry_run": self.global_dry(), "exec": self.exec and not self.force_dry,
                "auth": self.auth_mode() != "open", "auth_mode": self.auth_mode(),
                "engines": self.engines(), "gpu": self.gpu,
                "queue": self.q.qsize(), "runs_dir": str(self.runs),
                "region": self.region, "hy_territory_ok": self.region not in HY_EXCLUDED,
                "gpu_usd_hr": self.usd_hr}

    # -- audit / report ----------------------------------------------------
    def audit(self, user, action: str, ip=None, **extra):
        """Append an audit line. Callers pass names, ids and codes only -- never tokens."""
        try:
            with self.audit_lock:
                append_audit(self.runs, audit_record(user, action, ip, **extra))
        except OSError as e:
            print(f"warning: audit log write failed: {e.__class__.__name__}", file=sys.stderr)

    def read_audit(self, limit: int | None = None) -> list:
        path = self.runs / AUDIT_DIR / AUDIT_FILE
        out = collections.deque(maxlen=limit) if limit else []
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                for line in f:
                    try:
                        rec = json.loads(line)
                    except ValueError:
                        continue
                    if isinstance(rec, dict):
                        out.append(rec)
        except OSError:
            pass
        return list(out)

    def report(self, since: _dt.datetime | None) -> dict:
        """Per-user and per-engine totals (jobs, gpu_hours, cost_usd, failures) from job metrics."""
        with self.lock:
            sts = [json.loads(json.dumps(j.status)) for j in self.jobs.values()]
        users, engines = {}, {}

        def blank():
            return {"jobs": 0, "gpu_hours": 0.0, "cost_usd": None, "failures": 0}

        def add(t, st):
            m = st.get("metrics") if isinstance(st.get("metrics"), dict) else {}
            t["jobs"] += 1
            t["failures"] += 1 if st.get("status") == "failed" else 0
            t["gpu_hours"] = round(t["gpu_hours"] + float(m.get("gpu_hours") or 0), 6)
            if m.get("cost_usd") is not None:
                t["cost_usd"] = round((t["cost_usd"] or 0.0) + float(m["cost_usd"]), 6)

        total = blank()
        for st in sts:
            if since is not None:
                try:
                    if parse_iso(st.get("created") or "") < since:
                        continue
                except ValueError:
                    continue
            add(users.setdefault(st.get("submitted_by"), blank()), st)
            add(engines.setdefault(st.get("engine") or "?", blank()), st)
            add(total, st)
        return {"schema": "lattice.report/1", "generated": now_iso(),
                "since": since.isoformat().replace("+00:00", "Z") if since else None,
                "gpu_usd_hr": self.usd_hr,
                "users": [dict(user=k, **v) for k, v in sorted(users.items(), key=lambda kv: (kv[0] is None, kv[0] or ""))],
                "engines": [dict(engine=k, **v) for k, v in sorted(engines.items())],
                "totals": total,
                "note": "gpu_hours and cost_usd come from each job's metrics; dry runs count 0. Not a bill."}

    def territory_check(self, job: dict):
        if job.get("engine") not in HY_ENGINES:
            return
        try:
            user = norm_region((job.get("license") or {}).get("territory"))
        except ValueError as e:
            raise JobError(f"license.territory {e}")
        for where in (self.region, user):
            if where in HY_EXCLUDED:
                raise JobError(f"HY-World 2.0 license does not apply in {where}")

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
    def submit(self, job: dict, hf_token: str | None, user: str | None = None, ip: str | None = None) -> dict:
        params = validate_job(job)
        self.territory_check(job)
        jid = job.get("id")
        if not isinstance(jid, str) or not ID_RE.match(jid) or jid.startswith("_"):
            jid = None  # "_"-prefixed names are reserved (runs/_audit)
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
                  "log": [], "artifacts": [], "metrics": None, "submitted_by": user}
        j = Job(status, run_dir, stored, params, hf_token or None)
        with self.lock:
            self.jobs[jid] = j
            self._save(j)
        lic = stored.get("license") or {}
        try:
            terr = norm_region(lic.get("territory"))
        except ValueError:
            terr = None
        acc = lic.get("acceptedAt") if isinstance(lic.get("acceptedAt"), str) else None
        self.audit(user, "job.submit", ip, job_id=jid)
        self.audit(user, "license.accept", ip, job_id=jid, license_id=str(lic.get("id")),
                   accepted_at=acc[:64] if acc else None, territory=terr)
        self.log(j, f"queued {engine}/{stored['mode']} model={stored['model']} target={stored.get('target', 'rtx')}"
                    f" dry_run={dry} hf_token={'provided' if hf_token else 'none'}")
        self.q.put(jid)
        return {"id": jid, "status": "queued"}

    def list(self, limit: int, mine: bool = False, user: str | None = None) -> list:
        with self.lock:
            items = sorted(self.jobs.values(), key=lambda j: (j.status.get("created", ""), j.status["id"]),
                           reverse=True)
            if mine:
                items = [j for j in items if j.status.get("submitted_by") == user]
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
                    self._kill(j.proc)
            return json.loads(json.dumps(j.status))

    # -- runner ------------------------------------------------------------
    def _loop(self):
        while True:
            jid = self.q.get()
            j = self.jobs.get(jid)
            if not j or j.status["status"] != "queued" or j.cancel.is_set():
                continue
            j.stages = []
            j.t0 = time.time()
            try:
                self.update(j, status="running", stage=STAGES[j.job["engine"]][0])
                self._notices(j)
                if j.status["dry_run"]:
                    self._dry(j)
                else:
                    self._real(j)
                if j.cancel.is_set():
                    self.update(j, status="cancelled", stage="cancelled")
                    self.log(j, "cancelled")
                else:
                    self._finish_metrics(j)
                    self._collect(j)
                    self.update(j, status="done", stage="done", progress=1.0)
                    self.log(j, "done")
            except Exception as e:  # noqa: BLE001 -- surface any failure on the job
                if j.cancel.is_set():
                    self.update(j, status="cancelled", stage="cancelled")
                    self.log(j, "cancelled")
                else:
                    msg = self.redact(j, str(e)) or e.__class__.__name__
                    self.log(j, f"failed: {msg}")
                    # Record metrics and artifacts before the terminal status, so a
                    # poller never sees "failed" without them.
                    self._finish_metrics(j)
                    self._collect(j)
                    self.update(j, status="failed", error=msg)
            finally:
                self._stage_end(j)
                j.hf_token = None
                j.proc = None

    # -- notices / metrics / export -----------------------------------------
    def _notices(self, j: Job):
        eng = j.job["engine"]
        if eng in HY_ENGINES:
            (j.run_dir / "NOTICE-HY-World.txt").write_text(NOTICE_HY, "utf-8")
        if eng in COSMOS_ENGINES:
            (j.run_dir / "NOTICE-Cosmos.txt").write_text(NOTICE_COSMOS, "utf-8")

    def _stage_begin(self, j: Job, stage: str):
        self._stage_end(j)
        rec = {"stage": stage, "started": now_iso(), "ended": None, "wall_s": None,
               "gpu_name": self.gpu["name"] if self.gpu else None, "gpu_count": self.gpu_count,
               "peak_vram_mb": None, "exit_code": None}
        j.cur = (rec, time.time(), VramPoller() if self.gpu and not j.status.get("dry_run") else None)
        j.stages.append(rec)

    def _stage_end(self, j: Job, exit_code: int | None = None):
        cur = getattr(j, "cur", None)
        if not cur:
            return
        rec, t, poller = cur
        j.cur = None
        rec["ended"] = now_iso()
        rec["wall_s"] = round(time.time() - t, 3)
        if poller:
            rec["peak_vram_mb"] = poller.stop()
        if exit_code is not None:
            rec["exit_code"] = exit_code
        elif rec["exit_code"] is None and j.status.get("dry_run"):
            rec["exit_code"] = 0

    def _finish_metrics(self, j: Job):
        self._stage_end(j)
        wall = round(time.time() - getattr(j, "t0", time.time()), 3)
        # A dry run uses no GPU, so it bills nothing (keeps batch totals honest).
        if j.status.get("dry_run"):
            gpu_h = 0.0
        else:
            gpu_h = sum((s["wall_s"] or 0) * max(1, s["gpu_count"] or 0) for s in j.stages) / 3600.0
        cost = round(gpu_h * self.usd_hr, 6) if self.usd_hr is not None and not j.status.get("dry_run") else None
        m = {"wall_s": wall, "gpu_hours": round(gpu_h, 6), "cost_usd": cost,
             "gpu_usd_hr": self.usd_hr, "stages": j.stages}
        doc = {"schema": "lattice.metrics/1", "id": j.status["id"], "engine": j.job.get("engine"),
               "model": j.job.get("model"), "target": j.job.get("target", "rtx"),
               "dry_run": j.status.get("dry_run"), **m,
               "note": "cost_usd = gpu_hours x LATTICE_GPU_USD_HR; gpu_hours counts max(1, gpu_count) per stage; dry runs bill 0."}
        try:
            (j.run_dir / "metrics.json").write_text(json.dumps(doc, indent=2), "utf-8")
        except OSError:
            pass
        self.update(j, metrics=m)

    def _export(self, j: Job, placeholder: bool):
        target = j.params.get("export_target")
        if not target or j.job["engine"] not in HY_ENGINES:
            return
        fmt = j.params.get("format", "ply")
        mod = load_exporters()
        if mod is None:
            self.log(j, f"export_target={target}: exporters package not installed; skipping bundle")
            return
        if placeholder:
            ph = j.run_dir / "placeholder"
            ph.mkdir(exist_ok=True)
            f = ph / "placeholder-dry-run-scene.ply"
            f.write_text("ply\nformat ascii 1.0\ncomment LATTICE DRY-RUN PLACEHOLDER - not a real scene\n"
                         "element vertex 3\nproperty float x\nproperty float y\nproperty float z\n"
                         "end_header\n0 0 0\n1 0 0\n0 1 0\n", "utf-8")
            scene = [f]
        else:
            scene = sorted(p for p in j.run_dir.rglob("*")
                           if p.is_file() and p.suffix.lower() in (".ply", ".spz", ".splat", ".glb", ".usd",
                                                                    ".usda", ".usdc", ".usdz")
                           and not p.relative_to(j.run_dir).as_posix().startswith(("inputs/", "export/")))
        if not scene:
            self.log(j, "export: no splat/mesh files produced; skipping bundle")
            return
        try:
            out = mod.export(j.run_dir, target, fmt, scene_files=scene, log=lambda s: self.log(j, "export: " + str(s)))
            self.log(j, f"export {target}/{fmt}: {len(out or [])} file(s)")
        except ValueError as e:
            self.log(j, f"export {target}/{fmt} rejected: {e}")

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
        py = sys.executable or "python3"  # a bare "python" is often missing on GPU hosts
        # Default to the bundled adapters by path: engines run with the run dir as cwd, so -m would miss them.
        here = Path(__file__).resolve().parent
        cprefix = shlex.split(os.environ.get("LATTICE_COSMOS_CMD") or "") or [py, str(here / "adapters" / "cosmos" / "cli.py")]
        hprefix = shlex.split(os.environ.get("LATTICE_HY_CMD") or "") or [py, str(here / "adapters" / "hyworld" / "cli.py")]
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
            self._stage_begin(j, stage)
            self.log(j, f"stage {stage}")
            for s, argv in cmds:
                if s == stage:
                    self.log(j, "would run: " + shlex.join(argv) + (" (env HF_TOKEN=$HF_TOKEN)" if j.hf_token else ""))
            end = time.time() + STAGE_SLEEP
            while time.time() < end:
                if j.cancel.wait(0.05):
                    return
            if stage == "export":
                self._export(j, placeholder=True)
        self._stage_end(j)
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

    @staticmethod
    def _kill(proc: subprocess.Popen, grace: float = 5.0):
        """SIGTERM the subprocess's whole process group, SIGKILL it after `grace` seconds."""
        if proc.poll() is not None:
            return

        def sig(kill: bool):
            try:
                if os.name == "posix":  # started with start_new_session, so pgid == pid
                    os.killpg(proc.pid, signal.SIGKILL if kill else signal.SIGTERM)
                else:
                    proc.kill() if kill else proc.terminate()
            except OSError:
                pass

        def later():
            try:
                proc.wait(grace)
            except subprocess.TimeoutExpired:
                sig(True)

        sig(False)
        threading.Thread(target=later, daemon=True).start()

    def _run(self, j: Job, argv: list, p0: float, p1: float, cwd: Path | None = None):
        if j.cancel.is_set():
            return None
        env = dict(os.environ)
        for k in ("LATTICE_TOKEN", "HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"):
            env.pop(k, None)  # never leak the worker secret; the HF token comes from the job only
        if j.hf_token:
            env["HF_TOKEN"] = j.hf_token
            env["HUGGING_FACE_HUB_TOKEN"] = j.hf_token
        env["PYTHONUNBUFFERED"] = "1"  # stream PROGRESS lines instead of block-buffering them
        self.log(j, "run: " + shlex.join(argv))
        try:
            proc = subprocess.Popen(argv, cwd=str(cwd or j.run_dir), env=env, stdin=subprocess.DEVNULL,
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                    errors="replace", bufsize=1, start_new_session=(os.name == "posix"))
        except OSError as e:
            cur = getattr(j, "cur", None)
            if cur:
                cur[0]["exit_code"] = 127
            raise RuntimeError(f"cannot start {os.path.basename(argv[0])}: {e.strerror or e.__class__.__name__}")
        with self.lock:
            j.proc = proc
            if j.cancel.is_set():  # cancel arrived between the check above and Popen
                self._kill(proc)
        tail = []
        for line in proc.stdout:
            m = re.match(r"^\s*PROGRESS\s+([0-9]*\.?[0-9]+)\s*(%?)", line)
            if m:
                try:
                    f = float(m.group(1)) / (100.0 if m.group(2) else 1.0)
                    f = max(0.0, min(1.0, f))
                    self.update(j, progress=round(p0 + (p1 - p0) * f, 3))
                    continue
                except ValueError:
                    pass
            if line.strip():
                tail = (tail + [line.strip()])[-1:]
            self.log(j, line)
        rc = proc.wait()
        proc.stdout.close()
        cur = getattr(j, "cur", None)
        if cur:
            cur[0]["exit_code"] = rc
        if j.cancel.is_set():
            return rc
        if rc != 0:
            last = f": {tail[-1][:200]}" if tail else ""
            raise RuntimeError(self.redact(j, f"{os.path.basename(argv[0])} exited with code {rc}{last}"))
        return rc

    def _real(self, j: Job):
        eng = j.job["engine"]
        cmds = dict(self.commands(j))
        self.update(j, stage="validate", progress=0.02)
        self.log(j, "executing pipeline (client code field ignored; argv built from whitelisted fields)")
        self._stage_begin(j, "validate")
        self._stage_end(j, 0)
        if eng != "bridge":
            stage = "infer" if eng == "cosmos" else "pano"
            self.update(j, stage=stage)
            self._stage_begin(j, stage)
            self._run(j, cmds[stage], 0.05, 0.95)
            if j.cancel.is_set():
                return
            self.update(j, stage=STAGES[eng][-1])
            self._stage_begin(j, STAGES[eng][-1])
            if eng == "hyworld" and j.job["mode"] == "export":
                self._export(j, placeholder=False)
            self._stage_end(j, 0)
            return
        (j.run_dir / "rollout").mkdir(exist_ok=True)
        kf = j.run_dir / "keyframes"
        kf.mkdir(exist_ok=True)
        self.update(j, stage="cosmos-rollout")
        self._stage_begin(j, "cosmos-rollout")
        self._run(j, cmds["cosmos-rollout"], 0.05, 0.5)
        if j.cancel.is_set():
            return
        self.update(j, stage="keyframes", progress=0.5)
        self._stage_begin(j, "keyframes")
        vids = sorted(p for p in (j.run_dir / "rollout").rglob("*") if p.suffix.lower() in (".mp4", ".webm"))
        if not vids:
            raise RuntimeError("cosmos rollout produced no video")
        ff = shutil.which("ffmpeg")
        ok = False
        if ff:
            argv = list(cmds["keyframes"])
            argv[0], argv[3] = ff, str(vids[0])
            try:
                self._run(j, argv, 0.5, 0.6)
                ok = any(kf.glob("*.png"))
            except RuntimeError as e:
                self.log(j, f"keyframe extraction failed ({e})")
            if j.cancel.is_set():
                return
        else:
            self.log(j, "ffmpeg not found")
        if not ok:
            self.log(j, "passing rollout video to HY-World directly")
            shutil.copy(vids[0], kf / vids[0].name)
        self._stage_end(j, 0)
        self.update(j, stage="hy-freeze", progress=0.6)
        self._stage_begin(j, "hy-freeze")
        self._run(j, cmds["hy-freeze"], 0.6, 0.95)
        if j.cancel.is_set():
            return
        self.update(j, stage="export")
        self._stage_begin(j, "export")
        self._export(j, placeholder=False)
        self._stage_end(j, 0)

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


def gpu_count() -> int:
    exe = shutil.which("nvidia-smi")
    if not exe:
        return 0
    try:
        out = subprocess.run([exe, "--query-gpu=name", "--format=csv,noheader"],
                             capture_output=True, text=True, timeout=5).stdout
        return len([ln for ln in out.splitlines() if ln.strip()])
    except (OSError, subprocess.SubprocessError):
        return 0


class VramPoller:
    """Polls nvidia-smi once a second; stop() returns peak total used MiB (or None)."""

    def __init__(self, interval: float = 1.0):
        self.exe = shutil.which("nvidia-smi")
        self.peak = None
        self.ev = threading.Event()
        self.interval = interval
        if self.exe:
            self.t = threading.Thread(target=self._loop, daemon=True)
            self.t.start()

    def _loop(self):
        while True:
            try:
                out = subprocess.run([self.exe, "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
                                     capture_output=True, text=True, timeout=5).stdout
                used = sum(int(float(x)) for x in out.split() if x.strip())
                self.peak = used if self.peak is None else max(self.peak, used)
            except (OSError, subprocess.SubprocessError, ValueError):
                pass
            if self.ev.wait(self.interval):
                return

    def stop(self):
        self.ev.set()
        return self.peak


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

    def _ip(self) -> str | None:
        if self.worker.trust_proxy:
            fwd = (self.headers.get("X-Forwarded-For") or "").split(",")[0].strip()
            if fwd and len(fwd) <= 64 and re.fullmatch(r"[0-9A-Fa-f:.]+", fwd):
                return fwd
        try:
            return str(self.client_address[0])
        except (AttributeError, IndexError, TypeError):
            return None

    def _identify(self, query_token: str | None = None) -> dict | None:
        """The caller's identity {"name", "role"}, or None when authentication fails. Sends nothing."""
        w = self.worker
        got = self.headers.get("Authorization", "")
        bearer = got[7:].strip() if got.startswith("Bearer ") else None
        if w.users is not None:
            # ?token= is accepted only for GET /runs (media elements cannot send headers); hash-compared.
            return w.users.lookup(bearer) or (w.users.lookup(query_token) if query_token else None)
        tok = w.token
        if not tok:
            return FULL_ACCESS
        if bearer is not None and hmac.compare_digest(bearer.encode(), tok.encode()):
            return FULL_ACCESS
        if query_token is not None and hmac.compare_digest(query_token.encode(), tok.encode()):
            return FULL_ACCESS
        return None

    def _authed(self, query_token: str | None = None) -> dict | None:
        who = self._identify(query_token)
        if who is None:
            self.worker.audit(None, "auth.fail", self._ip())
            self._json(401, {"error": "unauthorized"})
        return who

    def _allowed(self, who: dict, role: str, what: str) -> bool:
        if ROLE_RANK.get(who.get("role"), -1) >= ROLE_RANK[role]:
            return True
        self._json(403, {"error": f"forbidden: the {who.get('role')} role cannot {what}"})
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
            h = self.worker.health()
            if self.worker.users is not None:
                who = self._identify()
                if who:
                    h["you"] = {"name": who["name"], "role": who["role"]}
            return self._json(200, h)
        qtok = None
        if u.path.startswith("/runs/"):
            qtok = urllib.parse.parse_qs(u.query).get("token", [None])[0]
        who = self._authed(qtok)
        if not who:
            return
        qs = urllib.parse.parse_qs(u.query)
        if path == "/jobs":
            try:
                limit = int(qs.get("limit", ["8"])[0])
            except ValueError:
                limit = 8
            mine = qs.get("mine", ["0"])[0].lower() in ("1", "true", "yes")
            return self._json(200, {"jobs": self.worker.list(max(1, min(200, limit)), mine, who["name"])})
        if path in ("/audit", "/audit.csv", "/report"):
            if not self._allowed(who, "admin", "read the audit log or cost report"):
                return
            if path == "/report":
                since = qs.get("since", [""])[0].strip()
                try:
                    since_dt = parse_iso(since) if since else None
                except ValueError:
                    return self._json(400, {"error": "since must be an ISO 8601 date or datetime"})
                return self._json(200, self.worker.report(since_dt))
            try:
                limit = int(qs.get("limit", ["200" if path == "/audit" else "0"])[0])
            except ValueError:
                limit = 200
            limit = max(0, min(100000, limit))
            entries = self.worker.read_audit(limit or None)
            if path == "/audit":
                return self._json(200, {"entries": entries, "count": len(entries)})
            return self._csv(entries)
        m = re.fullmatch(r"/jobs/([A-Za-z0-9_-]{1,64})", path)
        if m:
            st = self.worker.get(m.group(1))
            return self._json(200, st) if st else self._json(404, {"error": "not found"})
        if u.path.startswith("/runs/"):
            return self._serve_run(urllib.parse.unquote(u.path[len("/runs/"):]))
        return self._json(404, {"error": "not found"})

    do_HEAD = do_GET

    def _csv(self, entries: list):
        buf = io.StringIO()
        wr = csv.writer(buf, lineterminator="\r\n")
        wr.writerow(AUDIT_FIELDS)
        for e in entries:
            wr.writerow([csv_cell(e.get(k)) for k in AUDIT_FIELDS])
        body = buf.getvalue().encode("utf-8")
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "text/csv; charset=utf-8")
        self.send_header("Content-Disposition", 'attachment; filename="lattice-audit.csv"')
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_POST(self):
        path = urllib.parse.urlsplit(self.path).path.rstrip("/")
        who = self._authed()
        if not who:
            self._drain()
            return
        if path == "/jobs":
            if ROLE_RANK.get(who.get("role"), -1) < ROLE_RANK["operator"]:
                self._drain()
                return self._allowed(who, "operator", "submit jobs")
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
                res = self.worker.submit(job, hf, user=who["name"], ip=self._ip())
            except JobError as e:
                return self._json(400, {"error": str(e)})
            finally:
                hf = None
            return self._json(201, res)
        self._drain()
        m = re.fullmatch(r"/jobs/([A-Za-z0-9_-]{1,64})/cancel", path)
        if m:
            if not self._allowed(who, "operator", "cancel jobs"):
                return
            cur = self.worker.get(m.group(1))
            if not cur:
                return self._json(404, {"error": "not found"})
            if who["role"] != "admin" and cur.get("submitted_by") != who["name"]:
                return self._json(403, {"error": "forbidden: operators can only cancel their own jobs"})
            st = self.worker.cancel(m.group(1))
            if st:
                self.worker.audit(who["name"], "job.cancel", self._ip(), job_id=st["id"])
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
        # "_"-prefixed dirs (runs/_audit) are private to the worker, never served.
        if len(parts) != 2 or not ID_RE.match(parts[0]) or parts[0].startswith("_") or not parts[1]:
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
    argv = sys.argv[1:] if argv is None else list(argv)
    if argv[:1] == ["users"]:
        return users_cli(argv[1:])
    ap = argparse.ArgumentParser(description="Lattice worker (control-surface backend)",
                                 epilog="User management: python3 worker.py users {add,list,remove,rotate} --help")
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
    if worker.users is not None:
        print(f"  auth: users file {worker.users.path} ({len(worker.users.entries())} users; roles viewer/operator/admin)",
              flush=True)
    else:
        print(f"  auth: {'on (Bearer token required)' if worker.token else 'off'}", flush=True)
    print(f"  gpu: {h['gpu']['name'] if h['gpu'] else 'none detected'}", flush=True)
    print(f"  region: {worker.region or 'unset'}  hy_territory_ok={h['hy_territory_ok']}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("shutting down", flush=True)
    finally:
        httpd.server_close()


if __name__ == "__main__":
    sys.exit(main())
