#!/usr/bin/env python3
"""Fake engine CLI standing in for cosmos3.cli / hyworld.cli in tests (no GPU needed).

Usage: fake_engine.py <cosmos|hy> <mode> [--out DIR] [--input-dir DIR] [--prompt P] [--sleep S] [...]
Prints "PROGRESS 0.x" lines, writes outputs by mode, exits 3 when the prompt contains "FAIL";
"LEAK" in the prompt makes it echo $HF_TOKEN to stdout (to test redaction).
Writes hf_token.sha256 (sha256 of $HF_TOKEN, never the value) and argv.json into --out.
"""
import hashlib
import json
import os
import sys
import time
from pathlib import Path

PLY = ("ply\nformat ascii 1.0\ncomment fake engine scene\nelement vertex 4\n"
       "property float x\nproperty float y\nproperty float z\nend_header\n"
       "0 0 0\n1 0 0\n0 1 0\n0 0 1\n")
# Not a playable video; just enough bytes with an mp4-ish ftyp box.
MP4 = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2" + b"\x00" * 64
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


def opt(args, name, default=None):
    return args[args.index(name) + 1] if name in args and args.index(name) + 1 < len(args) else default


def main(argv):
    if len(argv) < 2:
        print("usage: fake_engine.py <cosmos|hy> <mode> ...", file=sys.stderr)
        return 2
    engine, mode, args = argv[0], argv[1], argv[2:]
    out = Path(opt(args, "--out", "."))
    out.mkdir(parents=True, exist_ok=True)
    prompt = opt(args, "--prompt", "")
    delay = float(opt(args, "--sleep", os.environ.get("FAKE_ENGINE_SLEEP", "0.05")))
    tok = os.environ.get("HF_TOKEN")
    (out / f"hf_token.{engine}.sha256").write_text(hashlib.sha256(tok.encode()).hexdigest() if tok else "none")
    (out / f"argv.{engine}.json").write_text(json.dumps({"engine": engine, "mode": mode, "args": args,
                                                          "pid": os.getpid()}))
    print(f"fake {engine} {mode} starting", flush=True)
    for i in range(1, 5):
        time.sleep(delay)
        print(f"PROGRESS {i / 5:.1f}", flush=True)
    if "LEAK" in prompt and tok:  # simulates an engine echoing the token to stdout (worker must redact)
        print(f"using token {tok}", flush=True)
    if "FAIL" in prompt:
        print(f"fatal: simulated failure{' token=' + tok if tok and 'LEAK' in prompt else ''}", flush=True)
        return 3
    if engine == "cosmos" and mode in ("generate", "action", "edge"):
        (out / "rollout.mp4").write_bytes(MP4)
        fr = out / "frames"
        fr.mkdir(exist_ok=True)
        for i in range(3):
            (fr / f"frame_{i:04d}.png").write_bytes(PNG)
    elif engine == "cosmos":
        (out / "reasoning.json").write_text(json.dumps({"answer": "fake"}))
    else:
        indir = opt(args, "--input-dir")
        seen = sorted(os.listdir(indir)) if indir and os.path.isdir(indir) else []
        (out / "inputs_seen.json").write_text(json.dumps(seen))
        scene = out / "scene"
        scene.mkdir(exist_ok=True)
        (scene / "scene.ply").write_text(PLY)
    print("PROGRESS 1.0", flush=True)
    print("fake done", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
