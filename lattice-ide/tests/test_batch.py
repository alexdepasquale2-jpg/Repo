# MIT License -- Lattice contributors
"""End-to-end tests for batch.py against a real dry-run worker.py subprocess."""
import io
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import batch  # noqa: E402

SECRET = "hf_testsecret"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class BatchTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.dir = Path(cls.tmp.name)
        cls.port = free_port()
        env = dict(os.environ, LATTICE_DRY_RUN="1", LATTICE_PORT=str(cls.port), LATTICE_HOST="127.0.0.1",
                   LATTICE_RUNS=str(cls.dir / "runs"))
        env.pop("LATTICE_TOKEN", None)
        env.pop("LATTICE_REGION", None)
        cls.proc = subprocess.Popen([sys.executable, str(ROOT / "worker.py"), "--host", "127.0.0.1",
                                     "--port", str(cls.port), "--runs", str(cls.dir / "runs"), "--dry-run"],
                                    env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cls.url = f"http://127.0.0.1:{cls.port}"
        for _ in range(100):
            try:
                urllib.request.urlopen(cls.url + "/health", timeout=1).read()
                break
            except OSError:
                time.sleep(0.1)
        else:
            cls.proc.kill()
            raise RuntimeError("worker did not start")

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(10)
        cls.tmp.cleanup()

    def sweep(self, name, **kw):
        sw = {"name": name, "engine": "cosmos", "mode": "generate", "model": "cosmos3-edge-4b",
              "target": "rtx", "prompts": ["a red cube", "a blue cup"], "seeds": [1, 2],
              "params": {"frames": 9}, "license": {"accepted": True}}
        sw.update(kw)
        p = self.dir / f"{name}.json"
        p.write_text(json.dumps(sw))
        return p

    def run_batch(self, *args, env=None):
        buf = io.StringIO()
        old = dict(os.environ)
        os.environ.update(env or {})
        try:
            rc = batch.run([*map(str, args)], out=buf, poll_s=0.2)
        finally:
            os.environ.clear()
            os.environ.update(old)
        return rc, buf.getvalue()

    def worker_jobs(self):
        return json.loads(urllib.request.urlopen(self.url + "/jobs?limit=200").read())["jobs"]

    def test_sweep_and_resume(self):
        out = self.dir / "ds"
        sw = self.sweep("s1")
        rc, log = self.run_batch(sw, "--worker", self.url, "--out", out, "--poll", "0.2",
                                 env={"HF_TOKEN": SECRET})
        self.assertEqual(rc, 0, log)
        man = json.loads((out / "s1" / "manifest.json").read_text())
        self.assertEqual(man["schema"], "lattice.dataset/1")
        self.assertEqual(man["license"]["id"], "OpenMDW-1.1")
        for k in ("name", "created", "engine", "model", "items", "totals"):
            self.assertIn(k, man)
        self.assertEqual(len(man["items"]), 4)
        self.assertEqual({(i["prompt"], i["seed"]) for i in man["items"]},
                         {(p, s) for p in ("a red cube", "a blue cup") for s in (1, 2)})
        self.assertEqual(man["totals"]["ok"], 4)
        self.assertEqual(man["totals"]["failed"], 0)
        for it in man["items"]:
            self.assertEqual(it["status"], "done")
            self.assertRegex(it["job_id"], r"^lj_\d{14}_[0-9a-f]{6}$")
            self.assertTrue(it["files"])
            for f in it["files"]:
                self.assertTrue((out / "s1" / f).is_file(), f)
            self.assertTrue(any(f.endswith("plan.json") for f in it["files"]))
        self.assertTrue((out / "s1" / "NOTICE-Cosmos.txt").is_file())
        # HF token never written to the output dir
        for f in out.rglob("*"):
            if f.is_file():
                self.assertNotIn(SECRET.encode(), f.read_bytes(), f)
        self.assertNotIn(SECRET, log)
        # resume: nothing new posted
        n = len(self.worker_jobs())
        rc, log = self.run_batch(sw, "--worker", self.url, "--out", out, "--poll", "0.2")
        self.assertEqual(rc, 0, log)
        self.assertEqual(len(self.worker_jobs()), n)
        self.assertEqual(json.loads((out / "s1" / "manifest.json").read_text())["totals"]["ok"], 4)

    def test_partial_then_resume_with_limit(self):
        out = self.dir / "ds2"
        sw = self.sweep("s2", prompts=["x"], seeds=[5, 6])
        rc, _ = self.run_batch(sw, "--worker", self.url, "--out", out, "--limit", "1", "--poll", "0.2")
        self.assertEqual(rc, 0)
        man = json.loads((out / "s2" / "manifest.json").read_text())
        self.assertEqual(len(man["items"]), 1)
        rc, log = self.run_batch(sw, "--worker", self.url, "--out", out, "--dry")
        self.assertIn("1 done, 1 to run", log)
        rc, _ = self.run_batch(sw, "--worker", self.url, "--out", out, "--poll", "0.2")
        man = json.loads((out / "s2" / "manifest.json").read_text())
        self.assertEqual(man["totals"]["ok"], 2)
        self.assertEqual(sorted(i["seed"] for i in man["items"]), [5, 6])

    def test_hyworld_refused(self):
        for eng in ("hyworld", "bridge"):
            sw = self.sweep("h_" + eng, engine=eng)
            err = io.StringIO()
            old, sys.stderr = sys.stderr, err
            try:
                rc, _ = self.run_batch(sw, "--worker", self.url, "--out", self.dir / "dsh")
            finally:
                sys.stderr = old
            self.assertEqual(rc, 2)
            self.assertIn("5(b)", err.getvalue())
            self.assertFalse((self.dir / "dsh").exists())

    def test_dry_posts_nothing(self):
        n = len(self.worker_jobs())
        out = self.dir / "dsd"
        rc, log = self.run_batch(self.sweep("d1"), "--worker", self.url, "--out", out, "--dry")
        self.assertEqual(rc, 0)
        self.assertIn("4 to run", log)
        self.assertEqual(len(self.worker_jobs()), n)
        self.assertFalse(out.exists())

    def test_example_sweep_valid(self):
        sw = batch.load_sweep(ROOT / "examples" / "sweep-droid.json")
        self.assertEqual(sw["target"], "jetson")
        self.assertEqual(len(batch.plan(sw)), 12)

    def test_unreachable_worker_retries(self):
        sleeps = []
        c = batch.Client(f"http://127.0.0.1:{free_port()}", sleep=sleeps.append)
        with self.assertRaises(batch.BatchError):
            c.status("lj_x")
        self.assertEqual(len(sleeps), 3)


if __name__ == "__main__":
    unittest.main()
