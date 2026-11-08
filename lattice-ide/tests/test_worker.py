"""Tests for worker.py (stdlib unittest). Run: cd lattice-ide && python3 -m unittest discover -s tests"""
import importlib
import json
import os
import sys
import tempfile
import threading
import time
import types
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))
import worker as W  # noqa: E402

W.STAGE_SLEEP = 0.02


def job(engine="cosmos", mode="generate", model="cosmos3-edge-4b", target="rtx", params=None, territory=None, **kw):
    lic = {"cosmos": "OpenMDW-1.1", "hyworld": "Tencent-HY-World-2.0",
           "bridge": "OpenMDW-1.1+Tencent-HY-World-2.0"}[engine]
    j = {"schema": "lattice.job/1", "engine": engine, "mode": mode, "model": model, "target": target,
         "inputs": {"prompt": "a warehouse", "media": [], "params": params or {}},
         "license": {"id": lic, "accepted": True}, "code": {"python": "import os; os.system('x')", "cli": ""}}
    if territory:
        j["license"]["territory"] = territory
    j.update(kw)
    return j


HY = dict(engine="hyworld", mode="export", model="hy-world-2.0")
BRIDGE = dict(engine="bridge", mode="bridge", model="cosmos3-nano-16b+hy-world-2.0")


class Base(unittest.TestCase):
    ENV = {}

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        env = {"LATTICE_DRY_RUN": "1", "LATTICE_REGION": "", "LATTICE_GPU_USD_HR": "", "LATTICE_TOKEN": ""}
        env.update(self.ENV)
        self.envp = mock.patch.dict(os.environ, env)
        self.envp.start()
        self.w = W.Worker(Path(self.tmp.name) / "runs", True)
        handler = type("H", (W.Handler,), {"worker": self.w, "log_message": lambda *a: None})
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.httpd.daemon_threads = True
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def tearDown(self):
        for jid in list(self.w.jobs):
            self.w.cancel(jid)
        end = time.time() + 5
        while time.time() < end and any(j.status["status"] in ("queued", "running") for j in self.w.jobs.values()):
            time.sleep(0.02)
        self.httpd.shutdown()
        self.httpd.server_close()
        self.envp.stop()
        time.sleep(0.05)
        self.tmp.cleanup()

    def req(self, method, path, body=None, headers=None):
        data = json.dumps(body).encode() if body is not None else None
        r = urllib.request.Request(self.base + path, data=data, method=method,
                                   headers={"Content-Type": "application/json", **(headers or {})})
        try:
            with urllib.request.urlopen(r, timeout=10) as resp:
                raw = resp.read()
                return resp.status, (json.loads(raw) if "json" in resp.headers.get("Content-Type", "") else raw)
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def run_job(self, j, headers=None, timeout=15):
        code, res = self.req("POST", "/jobs", j, headers)
        self.assertEqual(code, 201, res)
        end = time.time() + timeout
        while time.time() < end:
            _, st = self.req("GET", "/jobs/" + res["id"])
            if st["status"] in ("done", "failed", "cancelled"):
                return st
            time.sleep(0.05)
        self.fail("job did not finish")


class HealthTests(Base):
    def test_health_default(self):
        code, h = self.req("GET", "/health")
        self.assertEqual(code, 200)
        for k in ("ok", "service", "version", "schema", "dry_run", "exec", "auth", "engines", "gpu", "queue",
                  "runs_dir", "region", "hy_territory_ok"):
            self.assertIn(k, h)
        self.assertIsNone(h["region"])
        self.assertTrue(h["hy_territory_ok"])
        self.assertTrue(h["dry_run"])


class ExcludedRegionTests(Base):
    ENV = {"LATTICE_REGION": "de"}

    def test_health_region(self):
        _, h = self.req("GET", "/health")
        self.assertEqual(h["region"], "DE")
        self.assertFalse(h["hy_territory_ok"])

    def test_worker_region_blocks_hy_not_cosmos(self):
        for kw in (HY, BRIDGE):
            code, res = self.req("POST", "/jobs", job(**kw))
            self.assertEqual(code, 400)
            self.assertIn("does not apply in DE", res["error"])
        code, _ = self.req("POST", "/jobs", job())
        self.assertEqual(code, 201)


class TerritoryTests(Base):
    ENV = {"LATTICE_REGION": "US"}

    def test_user_territory(self):
        for t in ("DE", "GB", "KR", "uk", "fr"):
            for kw in (HY, BRIDGE):
                code, res = self.req("POST", "/jobs", job(territory=t, **kw))
                self.assertEqual(code, 400, (t, kw))
                self.assertIn("HY-World 2.0 license does not apply in", res["error"])
            code, _ = self.req("POST", "/jobs", job(territory=t))
            self.assertEqual(code, 201)
        code, _ = self.req("POST", "/jobs", job(territory="US", **HY))
        self.assertEqual(code, 201)
        code, res = self.req("POST", "/jobs", job(territory="Germany", **HY))
        self.assertEqual(code, 400)


class RunTests(Base):
    def test_metrics_notices_token(self):
        st = self.run_job(job(), headers={"X-HF-Token": "hf_testsecret"})
        self.assertEqual(st["status"], "done", st)
        m = st["metrics"]
        self.assertEqual([s["stage"] for s in m["stages"]], W.STAGES["cosmos"])
        for s in m["stages"]:
            for k in ("stage", "started", "ended", "wall_s", "gpu_name", "gpu_count", "peak_vram_mb", "exit_code"):
                self.assertIn(k, s)
        self.assertGreater(m["wall_s"], 0)
        self.assertIsNone(m["cost_usd"])
        names = {a["name"]: a for a in st["artifacts"]}
        self.assertEqual(names["metrics.json"]["kind"], "json")
        self.assertIn("NOTICE-Cosmos.txt", names)
        self.assertNotIn("NOTICE-HY-World.txt", names)
        rd = self.w.runs / st["id"]
        for p in rd.rglob("*"):
            if p.is_file():
                self.assertNotIn(b"hf_testsecret", p.read_bytes(), p)
        self.assertNotIn("hf_testsecret", json.dumps(st))

    def test_hy_notice(self):
        st = self.run_job(job(**BRIDGE))
        names = {a["name"] for a in st["artifacts"]}
        self.assertTrue({"NOTICE-HY-World.txt", "NOTICE-Cosmos.txt"} <= names)
        txt = (self.w.runs / st["id"] / "NOTICE-HY-World.txt").read_text("utf-8")
        self.assertIn("Tencent HY-WORLD 2.0 Community License", txt)
        self.assertIn("License.txt", txt)
        self.assertIn("improve any other AI model", txt)

    def test_validation_rules(self):
        bad = [job(model="cosmos3-droid-policy", mode="generate"),
               job(model="cosmos3-i2v", mode="action"),
               job(engine="bridge", mode="bridge", model="cosmos3-droid-policy+hy-world-2.0"),
               job(model="cosmos3-super-64b", target="rtx"),
               job(schema="x"), job(license={"id": "OpenMDW-1.1", "accepted": False})]
        for b in bad:
            self.assertEqual(self.req("POST", "/jobs", b)[0], 400, b)
        ok = [job(model="cosmos3-droid-policy", mode="action", target="jetson"),
              job(model="cosmos3-i2v", mode="generate")]
        for g in ok:
            self.assertEqual(self.req("POST", "/jobs", g)[0], 201, g)

    def test_param_filtering(self):
        p = W.validate_job(job(params={"frames": 16, "export_target": "unity", "keyframe_stride": 4, "bogus": 1}))
        self.assertEqual(p, {"frames": 16})
        p = W.validate_job(job(params={"frames": 16, "export_target": "unity", "format": "ply"}, **HY))
        self.assertEqual(p, {"export_target": "unity", "format": "ply"})
        with self.assertRaises(W.JobError):
            W.validate_job(job(params={"frames": -1}))

    def test_export_format_combo(self):
        code, res = self.req("POST", "/jobs", job(params={"export_target": "isaac", "format": "spz"}, **HY))
        self.assertEqual(code, 400)
        self.assertIn("isaac export does not support spz", res["error"])
        with mock.patch.dict(sys.modules, {"exporters": None}):  # package absent -> fallback table
            with self.assertRaises(W.JobError):
                W.validate_job(job(params={"export_target": "isaac", "format": "spz"}, **HY))
        self.assertEqual(self.req("POST", "/jobs", job(params={"export_target": "isaac", "format": "usd"}, **HY))[0], 201)

    def test_subdir_serving_and_traversal(self):
        st = self.run_job(job())
        rd = self.w.runs / st["id"]
        (rd / "sub").mkdir()
        (rd / "sub" / "a.txt").write_text("hello")
        code, body = self.req("GET", f"/runs/{st['id']}/sub/a.txt")
        self.assertEqual((code, body), (200, b"hello"))
        code, _ = self.req("GET", f"/runs/{st['id']}/..%2F..%2Fetc%2Fpasswd")
        self.assertEqual(code, 404)

    def test_fake_exporter_bundle(self):
        calls = []

        def export(run_dir, target, fmt, *, scene_files, log=print):
            calls.append((target, fmt, [p.name for p in scene_files]))
            out = run_dir / "export" / target
            out.mkdir(parents=True, exist_ok=True)
            z = out / f"{target}-bundle.zip"
            z.write_bytes(b"PK\x05\x06" + b"\0" * 18)
            return [z]

        fake = types.ModuleType("exporters")
        fake.export = export
        with mock.patch.dict(sys.modules, {"exporters": fake}):
            st = self.run_job(job(params={"export_target": "unreal", "format": "glb"}, **HY))
        self.assertEqual(calls[0][:2], ("unreal", "glb"))
        self.assertIn("placeholder", calls[0][2][0])
        arts = {a["name"]: a for a in st["artifacts"]}
        b = arts["export/unreal/unreal-bundle.zip"]
        self.assertEqual(b["kind"], "bundle")
        self.assertEqual(b["url"], f"/runs/{st['id']}/export/unreal/unreal-bundle.zip")
        code, _ = self.req("GET", b["url"])
        self.assertEqual(code, 200)


class CostTests(Base):
    ENV = {"LATTICE_GPU_USD_HR": "3.6"}

    def test_dry_run_bills_nothing(self):
        st = self.run_job(job())
        m = st["metrics"]
        self.assertEqual(m["gpu_hours"], 0)
        self.assertIsNone(m["cost_usd"])
        self.assertEqual(m["gpu_usd_hr"], 3.6)
        self.assertTrue(m["stages"])
        doc = json.loads((self.w.runs / st["id"] / "metrics.json").read_text())
        self.assertIsNone(doc["cost_usd"])


class RealExportersTests(Base):
    def test_real_exporters_bundle(self):
        try:
            importlib.import_module("exporters")
        except ImportError:
            self.skipTest("exporters package not present")
        st = self.run_job(job(params={"export_target": "unity", "format": "ply"}, **HY))
        self.assertEqual(st["status"], "done", st)
        bundles = [a for a in st["artifacts"] if a["kind"] == "bundle"]
        self.assertTrue(bundles, st["artifacts"])
        self.assertTrue(bundles[0]["url"].startswith(f"/runs/{st['id']}/export/"))


if __name__ == "__main__":
    unittest.main()
