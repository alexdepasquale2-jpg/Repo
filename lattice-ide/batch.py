#!/usr/bin/env python3
# Lattice batch -- MIT License
# Copyright (c) 2026 Lattice contributors
#
# Permission is hereby granted, free of charge, to any person obtaining a copy of
# this software and associated documentation files (the "Software"), to deal in
# the Software without restriction, including without limitation the rights to
# use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
# of the Software, and to permit persons to whom the Software is furnished to do
# so, subject to the following conditions: The above copyright notice and this
# permission notice shall be included in all copies or substantial portions of
# the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
"""Lattice batch: sweep prompts x seeds through a Lattice worker into a dataset.

    python3 batch.py sweep.json --worker http://localhost:8787 [--token T]
        [--hf-token-env HF_TOKEN] [--out dataset/] [--limit N] [--dry]

sweep.json: {"name", "engine":"cosmos", "mode":"generate"|"action", "model",
"target", "prompts":[...], "seeds":[...], "params":{...}, "license":{"accepted":true}}

Every (prompt, seed) pair becomes one lattice.job/1 job. All jobs are submitted
up front (the worker runs them FIFO), then polled; artifacts are downloaded to
<out>/<name>/<job id>/ and <out>/<name>/manifest.json (lattice.dataset/1) is
rewritten atomically after every item, so Ctrl-C / crashes leave a resumable
manifest: re-running skips items already "done".

Cosmos only. HY-World (engine hyworld / bridge) is refused: the Tencent
HY-World 2.0 Community License, section 5(b), forbids using Outputs to improve
any other AI model, which is what a training dataset is for.

The Hugging Face token is read from an environment variable and sent only as
the X-HF-Token header on POST /jobs; it is never written to disk or printed.
Stdlib only (urllib, argparse, json).
"""
from __future__ import annotations

import argparse
import datetime as _dt
import itertools
import json
import os
import secrets
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

SCHEMA = "lattice.dataset/1"
LICENSE_ID = "OpenMDW-1.1"
COSMOS_NOTICE = ("NVIDIA Cosmos 3 model weights are licensed under the OpenMDW License 1.1. "
                 "Generated outputs are not restricted by that license. Keep the license and "
                 "notices when redistributing weights; do not offer a competing public model API.")
HY_REFUSAL = ("batch.py refuses engine '{engine}': it runs HY-World 2.0, whose Tencent HY-World 2.0 "
              "Community License section 5(b) forbids using Outputs to improve any other AI model. "
              "Datasets built by batch.py are meant for training, so only engine 'cosmos' "
              "(OpenMDW-1.1, outputs unrestricted) is allowed.")
COSMOS_MODES = {"generate", "action"}
TERMINAL = {"done", "failed", "cancelled"}
RETRIES = 3


class BatchError(Exception):
    pass


def now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def new_id() -> str:
    return "lj_" + _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%d%H%M%S") + "_" + secrets.token_hex(3)


def load_sweep(path: Path) -> dict:
    try:
        sw = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise BatchError(f"cannot read sweep {path}: {e}")
    if not isinstance(sw, dict):
        raise BatchError("sweep must be a JSON object")
    engine = sw.get("engine", "cosmos")
    if engine in ("hyworld", "bridge"):
        raise BatchError(HY_REFUSAL.format(engine=engine))
    if engine != "cosmos":
        raise BatchError(f"unsupported engine {engine!r}; only 'cosmos' is allowed")
    if sw.get("mode") not in COSMOS_MODES:
        raise BatchError(f"mode must be one of {sorted(COSMOS_MODES)}")
    name = str(sw.get("name") or "")
    if not name or not all(c.isalnum() or c in "-_." for c in name) or name.startswith("."):
        raise BatchError("name must be non-empty [A-Za-z0-9._-]")
    for k in ("model", "target"):
        if not isinstance(sw.get(k), str) or not sw[k]:
            raise BatchError(f"missing {k}")
    prompts, seeds = sw.get("prompts"), sw.get("seeds")
    if not isinstance(prompts, list) or not prompts or not all(isinstance(p, str) for p in prompts):
        raise BatchError("prompts must be a non-empty list of strings")
    if not isinstance(seeds, list) or not seeds or not all(isinstance(s, int) and not isinstance(s, bool) for s in seeds):
        raise BatchError("seeds must be a non-empty list of ints")
    if not isinstance(sw.get("params", {}), dict):
        raise BatchError("params must be an object")
    if (sw.get("license") or {}).get("accepted") is not True:
        raise BatchError('license.accepted must be true (you must accept OpenMDW-1.1)')
    sw["engine"] = engine
    return sw


def plan(sw: dict) -> list[tuple[str, int]]:
    return list(itertools.product(sw["prompts"], sw["seeds"]))


def build_job(sw: dict, prompt: str, seed: int, jid: str) -> dict:
    params = dict(sw.get("params") or {})
    params["seed"] = seed
    return {
        "schema": "lattice.job/1", "id": jid, "created": now_iso(),
        "engine": "cosmos", "mode": sw["mode"], "model": sw["model"], "target": sw["target"],
        "inputs": {"prompt": prompt, "media": [], "params": params},
        "outputs": {"dir": f"./runs/{jid}/", "formats": []},
        "license": {"id": LICENSE_ID, "accepted": True, "acceptedAt": now_iso(),
                    "notices_required": True,
                    "terms": ["Commercial use OK", "Keep license and notices",
                              "No competing public model API", "Outputs unrestricted"]},
        "code": {"python": "", "cli": "batch.py"},
    }


class Client:
    def __init__(self, base: str, token: str = "", hf_token: str = "", sleep=time.sleep):
        self.base = base.rstrip("/")
        self.token, self._hf, self.sleep = token, hf_token, sleep

    def _req(self, method, path, body=None, hf=False, raw=False):
        headers = {}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        if hf and self._hf:
            headers["X-HF-Token"] = self._hf
        url = self.base + path
        for attempt in range(RETRIES + 1):
            try:
                with urllib.request.urlopen(urllib.request.Request(url, data, headers, method=method), timeout=60) as r:
                    payload = r.read()
                return payload if raw else json.loads(payload or b"{}")
            except urllib.error.HTTPError as e:
                try:
                    msg = json.loads(e.read()).get("error")
                except Exception:  # noqa: BLE001
                    msg = None
                raise BatchError(f"{method} {path}: HTTP {e.code} {msg or e.reason}")
            except (urllib.error.URLError, ConnectionError, TimeoutError, OSError) as e:
                if attempt >= RETRIES:
                    raise BatchError(f"{method} {path}: cannot reach worker ({e})")
                self.sleep(0.5 * 2 ** attempt)

    def submit(self, job):
        return self._req("POST", "/jobs", job, hf=True)

    def status(self, jid):
        return self._req("GET", "/jobs/" + urllib.parse.quote(jid))

    def fetch(self, url):
        return self._req("GET", url if url.startswith("/") else "/" + url, raw=True)


def write_manifest(path: Path, man: dict):
    tot = {"ok": 0, "failed": 0, "wall_s": 0.0, "cost_usd": None}
    for it in man["items"]:
        if it["status"] == "done":
            tot["ok"] += 1
        elif it["status"] in ("failed", "cancelled", "error"):
            tot["failed"] += 1
        m = it.get("metrics") or {}
        if isinstance(m.get("wall_s"), (int, float)):
            tot["wall_s"] += m["wall_s"]
        if isinstance(m.get("cost_usd"), (int, float)):
            tot["cost_usd"] = (tot["cost_usd"] or 0.0) + m["cost_usd"]
    tot["wall_s"] = round(tot["wall_s"], 3)
    man["totals"] = tot
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(man, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def load_manifest(path: Path, sw: dict) -> dict:
    if path.exists():
        man = json.loads(path.read_text(encoding="utf-8"))
        if man.get("schema") != SCHEMA:
            raise BatchError(f"{path} is not a {SCHEMA} manifest")
        return man
    return {"schema": SCHEMA, "name": sw["name"], "created": now_iso(), "engine": "cosmos",
            "model": sw["model"], "mode": sw["mode"], "target": sw["target"],
            "license": {"id": LICENSE_ID, "notice": COSMOS_NOTICE}, "items": [], "totals": {}}


def safe_rel(name: str) -> Path | None:
    p = Path(name)
    if p.is_absolute() or ".." in p.parts or not name:
        return None
    return p


def run(argv=None, out=sys.stdout, sleep=time.sleep, poll_s=1.0) -> int:
    ap = argparse.ArgumentParser(prog="batch.py", description=__doc__.split("\n")[0])
    ap.add_argument("sweep", type=Path)
    ap.add_argument("--worker", default="http://localhost:8787")
    ap.add_argument("--token", default=os.environ.get("LATTICE_TOKEN", ""))
    ap.add_argument("--hf-token-env", default="HF_TOKEN", help="env var holding the HF token (sent as X-HF-Token)")
    ap.add_argument("--out", type=Path, default=Path("dataset"))
    ap.add_argument("--limit", type=int, default=0, help="process at most N pending items")
    ap.add_argument("--dry", action="store_true", help="print the plan, post nothing")
    ap.add_argument("--poll", type=float, default=poll_s)
    a = ap.parse_args(argv)
    say = lambda s: print(s, file=out, flush=True)  # noqa: E731
    try:
        sw = load_sweep(a.sweep)
    except BatchError as e:
        print("error: " + str(e), file=sys.stderr)
        return 2
    items = plan(sw)
    dsdir = a.out / sw["name"]
    mpath = dsdir / "manifest.json"
    man = load_manifest(mpath, sw) if mpath.exists() else None
    done = {(i["prompt"], i["seed"]) for i in (man or {}).get("items", []) if i["status"] == "done"}
    pending = [x for x in items if x not in done]
    if a.limit > 0:
        pending = pending[: a.limit]
    if a.dry:
        say(f"plan: {sw['name']} {sw['engine']}/{sw['mode']} {sw['model']} on {sw['target']}: "
            f"{len(items)} items, {len(done)} done, "
            f"{len(pending)} to run")
        for p, s in pending:
            say(f"  seed={s} prompt={p!r}")
        return 0
    dsdir.mkdir(parents=True, exist_ok=True)
    man = man or load_manifest(mpath, sw)
    client = Client(a.worker, a.token, os.environ.get(a.hf_token_env, ""), sleep=sleep)
    index = {(i["prompt"], i["seed"]): i for i in man["items"]}
    rc = 0
    try:
        # submit everything first (worker is FIFO); reuse in-flight jobs from a previous run
        active = []
        for p, s in pending:
            it = index.get((p, s))
            if it and it.get("job_id") and it["status"] in ("queued", "running"):
                try:
                    client.status(it["job_id"])
                    active.append(it)
                    continue
                except BatchError:
                    pass
            jid = new_id()
            it = it or {"prompt": p, "seed": s}
            it.update({"job_id": jid, "status": "queued", "files": [], "metrics": None})
            if (p, s) not in index:
                man["items"].append(it)
                index[(p, s)] = it
            try:
                r = client.submit(build_job(sw, p, s, jid))
                it["job_id"] = r.get("id") or jid
                say(f"submitted {it['job_id']} seed={s} prompt={p[:60]!r}")
            except BatchError as e:
                it.update({"status": "error", "error": str(e)})
                say(f"submit failed seed={s}: {e}")
                rc = 1
            write_manifest(mpath, man)
            if it["status"] == "queued":
                active.append(it)
        notice_copied = False
        while active:
            for it in list(active):
                st = client.status(it["job_id"])
                if st.get("status") not in TERMINAL:
                    if it["status"] != st.get("status"):
                        it["status"] = st.get("status", it["status"])
                        write_manifest(mpath, man)
                    continue
                active.remove(it)
                jdir = dsdir / it["job_id"]
                jdir.mkdir(parents=True, exist_ok=True)
                files = []
                for art in st.get("artifacts") or []:
                    rel = safe_rel(str(art.get("name", "")))
                    if rel is None:
                        continue
                    dest = jdir / rel
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_bytes(client.fetch(art["url"]))
                    files.append(str(Path(it["job_id"]) / rel))
                    if rel.name == "NOTICE-Cosmos.txt" and not notice_copied:
                        shutil.copyfile(dest, dsdir / "NOTICE-Cosmos.txt")
                        notice_copied = True
                it.update({"status": st["status"], "files": files, "metrics": st.get("metrics"),
                           "error": st.get("error")})
                if st["status"] != "done":
                    rc = 1
                write_manifest(mpath, man)
                say(f"{st['status']:>9} {it['job_id']} ({len(files)} files)")
            if active:
                sleep(a.poll)
        if not (dsdir / "NOTICE-Cosmos.txt").exists():
            (dsdir / "NOTICE-Cosmos.txt").write_text(COSMOS_NOTICE + "\n", encoding="utf-8")
    except KeyboardInterrupt:
        write_manifest(mpath, man)
        say(f"interrupted; manifest saved to {mpath} -- re-run to resume")
        return 130
    except BatchError as e:
        write_manifest(mpath, man)
        print("error: " + str(e), file=sys.stderr)
        return 1
    write_manifest(mpath, man)
    t = man["totals"]
    say(f"dataset {dsdir}: ok={t['ok']} failed={t['failed']} wall_s={t['wall_s']} cost_usd={t['cost_usd']}")
    return rc


if __name__ == "__main__":
    sys.exit(run())
