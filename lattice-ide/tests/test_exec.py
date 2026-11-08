"""Real execution path (LATTICE_EXEC=1) exercised with tests/fake_engine.py -- no GPU needed.

Engine detection is satisfied by pointing LATTICE_COSMOS_MODULE / LATTICE_HY_MODULE at an importable
stdlib module; LATTICE_COSMOS_CMD / LATTICE_HY_CMD run the fake engine CLI.
"""
import hashlib
import json
import os
import shlex
import shutil
import sys
import time
import unittest
import zipfile
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_worker import BRIDGE, HY, Base, W, job  # noqa: E402

FAKE = Path(__file__).resolve().parent / "fake_engine.py"
PY = shlex.quote(sys.executable)
TOKEN = "hf_FakeTokenForTests1234567890abcdef"


class ExecBase(Base):
    ENV = {"LATTICE_DRY_RUN": "", "LATTICE_EXEC": "1",
           "LATTICE_COSMOS_MODULE": "json", "LATTICE_HY_MODULE": "json",
           "LATTICE_COSMOS_CMD": f"{PY} {shlex.quote(str(FAKE))} cosmos",
           "LATTICE_HY_CMD": f"{PY} {shlex.quote(str(FAKE))} hy",
           "FAKE_ENGINE_SLEEP": "0.05", "HF_TOKEN": ""}

    def setUp(self):
        # Base builds a force-dry Worker; rebuild one that may execute.
        super().setUp()
        self.w.force_dry = False
        self.w.exec = True

    def submit(self, j, token=None):
        code, res = self.req("POST", "/jobs", j, {"X-HF-Token": token} if token else None)
        self.assertEqual(code, 201, res)
        return res["id"]

    def wait(self, jid, states=("done", "failed", "cancelled"), timeout=20):
        end = time.time() + timeout
        seen = set()
        while time.time() < end:
            st = self.w.get(jid)
            seen.add(st["progress"])
            if st["status"] in states:
                return st, seen
            time.sleep(0.01)
        self.fail(f"timeout; last status {st}")

    def run_dir(self, jid):
        return self.w.runs / jid

    def assert_no_token_on_disk(self, jid):
        for p in self.run_dir(jid).rglob("*"):
            if p.is_file():
                data = p.read_bytes()
                self.assertNotIn(TOKEN.encode(), data, p)
                if p.suffix == ".zip":
                    with zipfile.ZipFile(p) as z:
                        for n in z.namelist():
                            self.assertNotIn(TOKEN.encode(), z.read(n), n)

    def assert_exit_codes_zero(self, st):
        stages = st["metrics"]["stages"]
        self.assertTrue(stages)
        for s in stages:
            self.assertEqual(s["exit_code"], 0, s)


class TestCosmosExec(ExecBase):
    def test_generate_real_done(self):
        jid = self.submit(job(), token=TOKEN)
        st, seen = self.wait(jid)
        self.assertEqual(st["status"], "done", st)
        self.assertFalse(st["dry_run"])
        # PROGRESS 0.2..0.8 mapped into [0.05, 0.95] -> intermediate values observed
        self.assertTrue(any(0.05 < p < 0.95 for p in seen), seen)
        names = {a["name"]: a["kind"] for a in st["artifacts"]}
        self.assertEqual(names.get("rollout.mp4"), "video", names)
        self.assertEqual(names.get("frames/frame_0000.png"), "image")
        self.assertNotIn("plan.json", names)
        self.assert_exit_codes_zero(st)
        self.assertEqual([s["stage"] for s in st["metrics"]["stages"]], ["validate", "infer", "encode"])
        rd = self.run_dir(jid)
        # token reached the subprocess env (sha256 matches) and is never on disk in plain text
        self.assertEqual((rd / "hf_token.cosmos.sha256").read_text(), hashlib.sha256(TOKEN.encode()).hexdigest())
        self.assert_no_token_on_disk(jid)
        self.assertNotIn(TOKEN, json.dumps(st))
        # the client code field was not executed; argv built from whitelisted fields
        argv = json.loads((rd / "argv.cosmos.json").read_text())
        self.assertEqual(argv["mode"], "generate")
        self.assertNotIn("os.system", json.dumps(argv))

    def test_no_token_means_no_env_leak(self):
        with mock.patch.dict(os.environ, {"HF_TOKEN": "hf_ServerSideShouldNotLeak999", "LATTICE_TOKEN": "sekrit"}):
            jid = self.submit(job())
            st, _ = self.wait(jid)
        self.assertEqual(st["status"], "done", st)
        self.assertEqual((self.run_dir(jid) / "hf_token.cosmos.sha256").read_text(), "none")

    def test_failure_is_failed_and_redacted(self):
        j = job()
        j["inputs"]["prompt"] = "please LEAK then FAIL"
        jid = self.submit(j, token=TOKEN)
        st, _ = self.wait(jid)
        self.assertEqual(st["status"], "failed", st)
        self.assertIn("exited with code 3", st["error"])
        self.assertIn("simulated failure", st["error"])
        self.assertNotIn(TOKEN, json.dumps(st))
        self.assertIn("hf_***", "\n".join(st["log"]))
        infer = [s for s in st["metrics"]["stages"] if s["stage"] == "infer"][0]
        self.assertEqual(infer["exit_code"], 3)
        self.assert_no_token_on_disk(jid)

    def test_missing_binary_fails_cleanly(self):
        with mock.patch.dict(os.environ, {"LATTICE_COSMOS_CMD": "/nonexistent/lattice-engine-xyz"}):
            jid = self.submit(job())
            st, _ = self.wait(jid)
        self.assertEqual(st["status"], "failed")
        self.assertIn("cannot start", st["error"])

    def test_cancel_running_subprocess(self):
        with mock.patch.dict(os.environ, {"FAKE_ENGINE_SLEEP": "5"}):
            jid = self.submit(job())
            end = time.time() + 10
            argvf = self.run_dir(jid) / "argv.cosmos.json"
            while time.time() < end and not argvf.exists():
                time.sleep(0.02)
            self.assertTrue(argvf.exists())
            pid = json.loads(argvf.read_text())["pid"]
            t0 = time.time()
            code, _ = self.req("POST", f"/jobs/{jid}/cancel")
            self.assertEqual(code, 200)
            st, _ = self.wait(jid, timeout=10)
        self.assertEqual(st["status"], "cancelled", st)
        self.assertLess(time.time() - t0, 5)
        end = time.time() + 5
        while time.time() < end and _alive(pid):
            time.sleep(0.05)
        self.assertFalse(_alive(pid), "engine process still running after cancel")


class TestHyExec(ExecBase):
    def test_export_bundle_contains_real_scene(self):
        jid = self.submit(job(**HY, params={"export_target": "isaac", "format": "ply"}), token=TOKEN)
        st, _ = self.wait(jid)
        self.assertEqual(st["status"], "done", st)
        names = {a["name"]: a["kind"] for a in st["artifacts"]}
        self.assertEqual(names.get("scene/scene.ply"), "splat", names)
        bundles = [n for n, k in names.items() if k == "bundle"]
        self.assertEqual(bundles, ["export/isaac/isaac-bundle.zip"], names)
        with zipfile.ZipFile(self.run_dir(jid) / bundles[0]) as z:
            plys = [n for n in z.namelist() if n.endswith(".ply")]
            self.assertTrue(plys, z.namelist())
            self.assertFalse(any("placeholder" in n for n in z.namelist()), z.namelist())
            self.assertIn(b"fake engine scene", z.read(plys[0]))
        self.assertFalse((self.run_dir(jid) / "placeholder").exists())
        self.assertIn("NOTICE-HY-World.txt", names)
        self.assert_exit_codes_zero(st)
        self.assert_no_token_on_disk(jid)


class TestBridgeExec(ExecBase):
    def _bridge(self):
        jid = self.submit(job(**BRIDGE, params={"export_target": "unity", "format": "ply", "keyframe_stride": 4}),
                          token=TOKEN)
        st, _ = self.wait(jid)
        self.assertEqual(st["status"], "done", st)
        rd = self.run_dir(jid)
        self.assertEqual([s["stage"] for s in st["metrics"]["stages"]],
                         ["validate", "cosmos-rollout", "keyframes", "hy-freeze", "export"])
        self.assert_exit_codes_zero(st)
        seen = json.loads((rd / "inputs_seen.json").read_text())
        self.assertTrue(seen, "hy stage got no keyframes")
        names = {a["name"] for a in st["artifacts"]}
        self.assertIn("rollout/rollout.mp4", names)
        self.assertIn("scene/scene.ply", names)
        self.assertIn("export/unity/unity-bundle.zip", names)
        for eng in ("cosmos", "hy"):
            f = rd / ("rollout" if eng == "cosmos" else "") / f"hf_token.{eng}.sha256"
            self.assertEqual(f.read_text(), hashlib.sha256(TOKEN.encode()).hexdigest())
        self.assert_no_token_on_disk(jid)
        return st, seen

    def test_bridge_without_ffmpeg_copies_video(self):
        # Hide ffmpeg even when installed: exercise the copy fallback.
        with mock.patch.object(W.shutil, "which", lambda name, *a, **k: None if name == "ffmpeg" else shutil.which(name)):
            st, seen = self._bridge()
        self.assertEqual(seen, ["rollout.mp4"])
        self.assertTrue(any("ffmpeg not found" in ln for ln in st["log"]))

    def test_bridge_with_failing_ffmpeg_falls_back(self):
        # A stand-in ffmpeg that rejects the (fake) video: the copy fallback must still run.
        d = Path(self.tmp.name) / "bin"
        d.mkdir()
        ff = d / "ffmpeg"
        ff.write_text("#!/bin/sh\necho 'Invalid data found when processing input'\nexit 1\n")
        ff.chmod(0o755)
        with mock.patch.dict(os.environ, {"PATH": f"{d}{os.pathsep}{os.environ.get('PATH', '')}"}):
            st, seen = self._bridge()
        self.assertEqual(seen, ["rollout.mp4"])
        self.assertTrue(any("keyframe extraction failed" in ln for ln in st["log"]))

    def test_bridge_with_working_ffmpeg(self):
        d = Path(self.tmp.name) / "bin"
        d.mkdir()
        ff = d / "ffmpeg"
        # Fake ffmpeg: writes two PNGs to the pattern's directory (last argv).
        ff.write_text("#!/bin/sh\nfor a; do out=$a; done\ndir=$(dirname \"$out\")\n"
                      "printf x > \"$dir/kf_0001.png\"; printf x > \"$dir/kf_0002.png\"\n")
        ff.chmod(0o755)
        with mock.patch.dict(os.environ, {"PATH": f"{d}{os.pathsep}{os.environ.get('PATH', '')}"}):
            st, seen = self._bridge()
        self.assertEqual(seen, ["kf_0001.png", "kf_0002.png"])


def _alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    # zombie counts as gone
    try:
        with open(f"/proc/{pid}/stat") as f:
            return f.read().split(")")[-1].split()[0] != "Z"
    except OSError:
        return True


if __name__ == "__main__":
    unittest.main()
