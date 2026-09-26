"""Tests for lattice-ide/adapters (Cosmos 3 / HY-World 2.0 adapters and doctor). Stdlib only, no GPU.

Upstream libraries are replaced by tiny fake `torch` / `diffusers` packages and a fake HY-World
checkout written into a temp dir and put on PYTHONPATH for the adapter subprocesses.
"""
import base64
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(HERE))

from adapters import common as C  # noqa: E402
from adapters.cosmos import cli as CC  # noqa: E402
from adapters.hyworld import cli as HC  # noqa: E402

TOKEN = "hf_AdapterTestToken0123456789abcdefXYZ"
PNG_1x1 = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")


def png(w, h):
    """Header-only PNG with the given size (enough for image_size())."""
    import struct
    return b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + struct.pack(">II", w, h) + b"\x08\x02\x00\x00\x00" + b"\x00" * 8


FAKE = {
    "torch/__init__.py": """
        import os, types
        __version__ = "0.0-fake"
        bfloat16 = "bfloat16"
        class OutOfMemoryError(RuntimeError):
            pass
        def _avail():
            return os.environ.get("FAKE_CUDA", "1") == "1"
        cuda = types.SimpleNamespace(is_available=_avail, device_count=lambda: 1 if _avail() else 0,
                                     OutOfMemoryError=OutOfMemoryError)
        version = types.SimpleNamespace(cuda="12.8")
        class Generator:
            def __init__(self, device=None):
                self.device, self.seed = device, None
            def manual_seed(self, n):
                self.seed = n
                return self
    """,
    "diffusers/__init__.py": """
        import hashlib, json, os, types
        __version__ = "0.0-fake"
        def _log(rec):
            p = os.environ.get("FAKE_DIFFUSERS_LOG")
            if p:
                with open(p, "a") as f:
                    f.write(json.dumps(rec, default=repr) + "\\n")
        class CosmosActionCondition:
            def __init__(self, **kw):
                self.kw = kw
            def __repr__(self):
                return "CosmosActionCondition(%s)" % json.dumps({k: v for k, v in self.kw.items() if k != "image"})
        class Cosmos3OmniPipeline:
            def __init__(self):
                self.scheduler = types.SimpleNamespace(config={"fake": True})
            @classmethod
            def from_pretrained(cls, repo, **kw):
                tok = kw.pop("token", None)
                _log({"event": "from_pretrained", "repo": repo, "kw": kw,
                      "token_sha256": hashlib.sha256(tok.encode()).hexdigest() if tok else None})
                return cls()
            def to(self, dev):
                _log({"event": "to", "device": dev})
                return self
            def __call__(self, prompt=None, num_inference_steps=None, callback_on_step_end=None, **kw):
                import torch
                if "OOM" in (prompt or ""):
                    raise torch.OutOfMemoryError("CUDA out of memory. Tried to allocate 20.00 GiB")
                gen = kw.pop("generator", None)
                _log({"event": "call", "prompt": prompt, "num_inference_steps": num_inference_steps,
                      "seed": getattr(gen, "seed", None), "kw": kw})
                import time
                for i in range(num_inference_steps or 0):
                    time.sleep(float(os.environ.get("FAKE_STEP_SLEEP", "0")))
                    if callback_on_step_end:
                        callback_on_step_end(self, i, 0, {})
                n = kw.get("num_frames") or 3
                action = [types.SimpleNamespace(tolist=lambda: [[0.1] * 10] * 16)] if "action" in kw else None
                return types.SimpleNamespace(video=[FakeFrame()] * n, sound=None, action=action)
        class FakeFrame:
            def save(self, path):
                open(path, "wb").write(b"\\x89PNG fake")
    """,
    "diffusers/utils.py": """
        def export_to_video(frames, path, fps=24, macro_block_size=None):
            with open(path, "wb") as f:
                f.write(b"\\x00\\x00\\x00\\x18ftypisom" + bytes(64) + bytes([len(frames) % 256, fps % 256]))
        def load_image(p):
            return {"image": str(p)}
        def load_video(p):
            return [{"video_frame": str(p)}]
    """,
    "diffusers/schedulers/__init__.py": "",
    "diffusers/schedulers/scheduling_unipc_multistep.py": """
        import json, os
        class UniPCMultistepScheduler:
            @classmethod
            def from_config(cls, config, **kw):
                p = os.environ.get("FAKE_DIFFUSERS_LOG")
                if p:
                    open(p, "a").write(json.dumps({"event": "scheduler", "kw": kw}) + "\\n")
                return cls()
    """,
    # torch shadow that behaves as "not installed"
    "notorch/torch/__init__.py": "raise ImportError('torch is not installed (test shadow)')\n",
    # fake HY-World checkout
    "hyroot/hyworld2/__init__.py": "",
    "hyroot/hyworld2/worldrecon/__init__.py": "",
    "hyroot/hyworld2/worldrecon/pipeline.py": """
        import argparse, json, os, sys
        ap = argparse.ArgumentParser()
        ap.add_argument("--input_path"); ap.add_argument("--strict_output_path")
        ap.add_argument("--pretrained_model_name_or_path"); ap.add_argument("--subfolder")
        ap.add_argument("--no_interactive", action="store_true")
        ap.add_argument("--no_save_depth", action="store_true"); ap.add_argument("--no_save_normal", action="store_true")
        a = ap.parse_args()
        if os.environ.get("FAKE_HY_OOM"):
            print("torch.OutOfMemoryError: CUDA out of memory.", flush=True); sys.exit(1)
        out = a.strict_output_path; os.makedirs(out, exist_ok=True)
        seen = sorted(os.listdir(a.input_path)) if os.path.isdir(a.input_path) else [os.path.basename(a.input_path)]
        for i in range(1, 5):
            sys.stdout.write("Inference: %d/4 [00:01<00:00]\\r" % i); sys.stdout.flush()
        print("", flush=True)
        ply = "ply\\nformat ascii 1.0\\nelement vertex 1\\nproperty float x\\nproperty float y\\nproperty float z\\nend_header\\n0 0 0\\n"
        open(os.path.join(out, "gaussians.ply"), "w").write(ply)
        open(os.path.join(out, "points.ply"), "w").write(ply)
        json.dump({"argv": sys.argv[1:], "seen": seen}, open(os.path.join(out, "camera_params.json"), "w"))
        print("saved", out, flush=True)
    """,
}


class FakeUpstream:
    """Materialize the fake upstream packages once per test class."""

    @classmethod
    def setUpClass(cls):
        cls._td = tempfile.TemporaryDirectory()
        cls.fake = Path(cls._td.name)
        for rel, src in FAKE.items():
            p = cls.fake / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(textwrap.dedent(src))
        cls.hyroot = cls.fake / "hyroot"
        cls.notorch = cls.fake / "notorch"

    @classmethod
    def tearDownClass(cls):
        cls._td.cleanup()

    def env(self, fake=True, **extra):
        env = {k: v for k, v in os.environ.items() if not k.startswith(("LATTICE_", "FAKE_", "HF_", "HUGGING"))}
        paths = [str(ROOT)] + ([str(self.fake)] if fake else [])
        env["PYTHONPATH"] = os.pathsep.join(paths)
        env.update({k: str(v) for k, v in extra.items()})
        return env

    def run_cli(self, module, argv, env, cwd=None):
        return subprocess.run([sys.executable, "-m", module, *argv], capture_output=True, text=True, env=env,
                              cwd=cwd or tempfile.gettempdir(), timeout=60)


def args_for(parser_mod, argv):
    return C.build_parser("t", parser_mod.MODES).parse_args(argv)


# ---------------------------------------------------------------------------
class TestParsing(unittest.TestCase):
    def test_worker_argv_parses(self):
        a = args_for(CC, ["generate", "--model", "cosmos3-nano-16b", "--prompt", "a b", "--out", "/tmp/o",
                          "--input", "x.png", "--input", "y.png", "--frames", "121", "--fps", "24",
                          "--resolution", "832x480", "--seed", "7", "--guidance", "5.5", "--steps", "20"])
        self.assertEqual((a.frames, a.fps, a.seed, a.guidance, a.steps), (121, 24, 7, 5.5, 20))
        self.assertEqual(a.input, ["x.png", "y.png"])
        h = args_for(HC, ["worldmirror", "--model", "hy-world-2.0", "--prompt", "", "--out", "/o",
                          "--input-dir", "/k", "--seed", "1", "--export-target", "isaac", "--format", "usd"])
        self.assertEqual((h.input_dir, h.export_target, h.format), ("/k", "isaac", "usd"))

    def test_bad_args_exit_5_not_2(self):
        with self.assertRaises(C.AdapterError) as cm:
            args_for(CC, ["generate", "--out", "/o"])  # missing --model
        self.assertEqual(cm.exception.code, C.EXIT_USAGE)
        with self.assertRaises(C.AdapterError):
            args_for(CC, ["dance", "--model", "m", "--out", "/o"])

    def test_resolution(self):
        self.assertEqual(C.parse_resolution("1280x720"), (1280, 720))
        self.assertEqual(C.parse_resolution("480p"), (832, 480))
        self.assertEqual(C.parse_resolution("256p"), (320, 192))
        self.assertIsNone(C.parse_resolution(None))
        with self.assertRaises(C.AdapterError):
            C.parse_resolution("huge")

    def test_image_size_and_panorama(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "p.png"
            p.write_bytes(png(2048, 1024))
            self.assertEqual(C.image_size(p), (2048, 1024))
            self.assertTrue(HC.is_panorama(p))
            q = Path(d) / "q.png"
            q.write_bytes(PNG_1x1)
            self.assertEqual(C.image_size(q), (1, 1))
            self.assertFalse(HC.is_panorama(q))

    def test_redact(self):
        with mock.patch.dict(os.environ, {"HF_TOKEN": TOKEN}):
            self.assertNotIn(TOKEN, C.redact(f"x {TOKEN} y"))
        self.assertEqual(C.redact("hf_" + "a" * 30), "hf_***")


class TestProgress(unittest.TestCase):
    def test_monotonic_format(self):
        import io
        buf = io.StringIO()
        p = C.Progress([("load", 1), ("infer", 3)], out=buf)
        p.emit(0.0)
        p.stage("load")
        p.stage("infer", 0.5, announce=False)
        p.stage("load", 1.0, announce=False)  # going backwards is ignored
        p.done()
        vals = [float(m.group(1)) for m in re.finditer(r"^PROGRESS (\d\.\d{3})$", buf.getvalue(), re.M)]
        self.assertEqual(vals[0], 0.0)
        self.assertEqual(vals[-1], 1.0)
        self.assertEqual(vals, sorted(vals))
        self.assertIn(0.625, vals)
        # every PROGRESS line matches the worker's regex
        for ln in buf.getvalue().splitlines():
            if ln.startswith("PROGRESS"):
                self.assertRegex(ln, r"^\s*PROGRESS\s+([0-9]*\.?[0-9]+)\s*(%?)")


class TestModelMap(unittest.TestCase):
    IDS = ["cosmos3-edge-4b", "cosmos3-nano-16b", "cosmos3-super-64b", "cosmos3-i2v", "cosmos3-droid-policy",
           "hy-world-2.0"]

    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.addCleanup(self.td.cleanup)
        p = mock.patch.dict(os.environ, {"LATTICE_MODEL_MAP": ""})
        p.start()
        self.addCleanup(p.stop)

    def test_defaults_cover_all_lattice_ids(self):
        import worker
        self.assertEqual(set(worker.COSMOS_MODELS) | {worker.HY_MODEL}, set(self.IDS))
        m, path = C.load_model_map()
        self.assertIsNone(path)
        for i in self.IDS:
            self.assertTrue(m[i]["repo"], i)
        self.assertEqual(m["cosmos3-nano-16b"]["repo"], "nvidia/Cosmos3-Nano")
        self.assertEqual(m["cosmos3-edge-4b"]["repo"], "nvidia/Cosmos3-Edge")
        self.assertEqual(m["cosmos3-super-64b"]["repo"], "nvidia/Cosmos3-Super")
        self.assertEqual(m["cosmos3-droid-policy"]["repo"], "nvidia/Cosmos3-Nano-Policy-DROID")
        self.assertEqual(m["hy-world-2.0"]["repo"], "tencent/HY-World-2.0")

    def write(self, obj):
        p = Path(self.td.name) / "map.json"
        p.write_text(json.dumps(obj) if not isinstance(obj, str) else obj)
        os.environ["LATTICE_MODEL_MAP"] = str(p)
        return p

    def test_override_merges(self):
        self.write({"models": {"cosmos3-nano-16b": {"repo": "/weights/Cosmos3-Nano", "defaults": {"steps": 12}}}})
        e = C.resolve_model("cosmos3-nano-16b", "cosmos")
        self.assertEqual(e["repo"], "/weights/Cosmos3-Nano")
        self.assertEqual(e["defaults"]["steps"], 12)
        self.assertEqual(e["defaults"]["frames"], 189)  # untouched keys kept
        self.assertEqual(e["framework_checkpoint"], "Cosmos3-Nano")

    def test_unwrapped_and_new_ids(self):
        self.write({"my-model": {"engine": "cosmos", "repo": "org/x"}})
        self.assertEqual(C.resolve_model("my-model", "cosmos")["repo"], "org/x")

    def test_null_removes_and_error_names_key(self):
        p = self.write({"models": {"cosmos3-i2v": None}})
        with self.assertRaises(C.AdapterError) as cm:
            C.resolve_model("cosmos3-i2v", "cosmos")
        self.assertEqual(cm.exception.code, C.EXIT_USAGE)
        self.assertIn("cosmos3-i2v", cm.exception.msg)
        self.assertIn("LATTICE_MODEL_MAP", cm.exception.hint)
        self.assertIn(str(p), cm.exception.hint)
        self.assertIn('"repo"', cm.exception.hint)

    def test_unknown_id_without_override(self):
        with self.assertRaises(C.AdapterError) as cm:
            C.resolve_model("cosmos4-giga", "cosmos")
        self.assertIn("LATTICE_MODEL_MAP", cm.exception.hint)

    def test_bad_files(self):
        self.write("{nope")
        with self.assertRaises(C.AdapterError) as cm:
            C.load_model_map()
        self.assertEqual(cm.exception.code, C.EXIT_USAGE)
        os.environ["LATTICE_MODEL_MAP"] = "/nonexistent/map.json"
        with self.assertRaises(C.AdapterError):
            C.load_model_map()
        self.write({"models": {"x": 3}})
        with self.assertRaises(C.AdapterError):
            C.load_model_map()

    def test_engine_mismatch(self):
        with self.assertRaises(C.AdapterError):
            C.resolve_model("hy-world-2.0", "cosmos")


class TestCosmosPlan(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.addCleanup(self.td.cleanup)
        self.d = Path(self.td.name)
        (self.d / "a.png").write_bytes(PNG_1x1)
        (self.d / "b.png").write_bytes(PNG_1x1)
        (self.d / "c.png").write_bytes(PNG_1x1)
        (self.d / "v.mp4").write_bytes(b"\x00" * 16)
        p = mock.patch.dict(os.environ, {"LATTICE_MODEL_MAP": "", "LATTICE_COSMOS_BACKEND": "",
                                         "LATTICE_COSMOS_GUARDRAILS": "", "LATTICE_COSMOS_OFFLOAD": ""})
        p.start()
        self.addCleanup(p.stop)

    def plan(self, mode, model, *extra):
        a = args_for(CC, [mode, "--model", model, "--prompt", "robot", "--out", str(self.d / "out"), *extra])
        return CC.make_plan(a, C.resolve_model(model, "cosmos"))

    def test_t2v_defaults_nano(self):
        p = self.plan("generate", "cosmos3-nano-16b")
        self.assertEqual((p["task"], p["width"], p["height"], p["frames"], p["fps"], p["steps"], p["guidance"],
                          p["flow_shift"]), ("text2video", 1280, 720, 189, 24, 35, 6.0, 10.0))
        self.assertEqual(p["repo"], "nvidia/Cosmos3-Nano")
        self.assertTrue(p["guardrails"])

    def test_edge_defaults(self):
        p = self.plan("generate", "cosmos3-edge-4b")
        self.assertEqual((p["width"], p["height"], p["frames"], p["steps"], p["guidance"], p["flow_shift"]),
                         (832, 480, 121, 20, 5.0, 8.0))

    def test_param_translation(self):
        p = self.plan("generate", "cosmos3-nano-16b", "--frames", "61", "--fps", "16", "--resolution", "832x480",
                      "--seed", "9", "--guidance", "4.5", "--steps", "12")
        self.assertEqual((p["frames"], p["fps"], p["width"], p["height"], p["seed"], p["guidance"], p["steps"]),
                         (61, 16, 832, 480, 9, 4.5, 12))
        self.assertEqual(p["warnings"], [])

    def test_out_of_envelope_warns(self):
        p = self.plan("generate", "cosmos3-edge-4b", "--resolution", "1280x720", "--frames", "300", "--fps", "25")
        self.assertEqual(len(p["warnings"]), 3)

    def test_edge_mode_on_nano_uses_edge_envelope(self):
        p = self.plan("edge", "cosmos3-nano-16b")
        self.assertEqual((p["width"], p["height"], p["frames"]), (832, 480, 121))

    def test_media_selects_task(self):
        self.assertEqual(self.plan("generate", "cosmos3-nano-16b", "--input", str(self.d / "a.png"))["task"], "image2video")
        self.assertEqual(self.plan("generate", "cosmos3-nano-16b", "--input", str(self.d / "v.mp4"))["task"], "video2video")
        p = self.plan("generate", "cosmos3-nano-16b", "--frames", "1")
        self.assertEqual((p["task"], p["frames"], p["outputs"]), ("text2image", 1, ["image.png"]))

    def test_i2v_requires_image(self):
        with self.assertRaises(C.AdapterError) as cm:
            self.plan("generate", "cosmos3-i2v")
        self.assertEqual(cm.exception.code, C.EXIT_USAGE)
        self.assertEqual(self.plan("generate", "cosmos3-i2v", "--input", str(self.d / "a.png"))["task"], "image2video")

    def test_missing_input_file(self):
        with self.assertRaises(C.AdapterError):
            self.plan("generate", "cosmos3-nano-16b", "--input", str(self.d / "nope.png"))

    def test_action(self):
        with self.assertRaises(C.AdapterError) as cm:
            self.plan("action", "cosmos3-nano-16b", "--input", str(self.d / "a.png"))
        self.assertIn("models.cosmos3-nano-16b.action", cm.exception.hint)
        with self.assertRaises(C.AdapterError):
            self.plan("action", "cosmos3-droid-policy")  # no start frame
        p = self.plan("action", "cosmos3-droid-policy", "--input", str(self.d / "a.png"), "--frames", "9")
        self.assertEqual((p["task"], p["fps"], p["steps"], p["guidance"], p["flow_shift"]), ("policy", 15, 30, 1.0, 5.0))
        self.assertEqual(p["action"]["domain_name"], "droid_lerobot")
        self.assertEqual(p["action"]["chunk_size"], 16)
        self.assertTrue(p["warnings"])  # --frames ignored

    def test_reason(self):
        p = self.plan("reason", "cosmos3-nano-16b", "--input", str(self.d / "v.mp4"))
        self.assertEqual((p["task"], p["backend"], p["reasoner_class"]),
                         ("reason", "transformers", "Cosmos3OmniForConditionalGeneration"))
        self.assertEqual(self.plan("reason", "cosmos3-edge-4b")["reasoner_class"], "AutoModelForImageTextToText")
        with self.assertRaises(C.AdapterError):
            self.plan("reason", "cosmos3-droid-policy")

    def test_framework_payload(self):
        os.environ["LATTICE_COSMOS_BACKEND"] = "framework"
        os.environ["LATTICE_COSMOS_NPROC"] = "4"
        try:
            p = self.plan("generate", "cosmos3-super-64b", "--resolution", "832x480", "--seed", "3",
                          "--input", str(self.d / "a.png"))
        finally:
            del os.environ["LATTICE_COSMOS_NPROC"]
        fw = p["framework"]
        self.assertEqual(fw["checkpoint"], "Cosmos3-Super")
        self.assertEqual(fw["nproc"], 4)
        pl = fw["payload"]
        for k in ("model_mode", "name", "prompt", "negative_prompt", "enable_sound", "num_steps", "guidance", "shift",
                  "fps", "num_frames", "resolution", "aspect_ratio", "seed", "vision_path"):
            self.assertIn(k, pl)
        self.assertEqual((pl["model_mode"], pl["resolution"], pl["aspect_ratio"], pl["seed"]),
                         ("image2video", "480", "16,9", 3))

    def test_bad_backend(self):
        os.environ["LATTICE_COSMOS_BACKEND"] = "magic"
        with self.assertRaises(C.AdapterError):
            self.plan("generate", "cosmos3-nano-16b")

    def test_guardrails_off_and_distilled(self):
        os.environ["LATTICE_COSMOS_GUARDRAILS"] = "0"
        self.assertFalse(self.plan("generate", "cosmos3-nano-16b")["guardrails"])
        m = Path(self.td.name) / "m.json"
        m.write_text(json.dumps({"models": {"cosmos3-i2v": {"repo": "nvidia/Cosmos3-Super-Image2Video-4Step",
                                                            "distilled": True}}}))
        os.environ["LATTICE_MODEL_MAP"] = str(m)
        p = self.plan("generate", "cosmos3-i2v", "--input", str(self.d / "a.png"))
        self.assertTrue(p["distilled"])
        self.assertIsNone(p["steps"])


class TestHyPlan(FakeUpstream, unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.addCleanup(self.td.cleanup)
        self.d = Path(self.td.name)
        (self.d / "photo.png").write_bytes(png(1024, 768))
        (self.d / "pano.png").write_bytes(png(2048, 1024))
        (self.d / "a.png").write_bytes(png(64, 64))
        (self.d / "clip.mp4").write_bytes(b"\x00" * 8)
        p = mock.patch.dict(os.environ, {"LATTICE_MODEL_MAP": "", "LATTICE_HY_ROOT": str(self.hyroot),
                                         "LATTICE_HY_NPROC": "1", "LATTICE_HY_LLM_ADDR": "", "LATTICE_HY_PYTHON": ""})
        p.start()
        self.addCleanup(p.stop)

    def plan(self, mode, *extra):
        a = args_for(HC, [mode, "--model", "hy-world-2.0", "--prompt", "sunny", "--out", str(self.d / "out"), *extra])
        return HC.make_plan(a, C.resolve_model("hy-world-2.0", "hyworld"), HC.hy_root())

    def test_pano(self):
        with self.assertRaises(C.AdapterError) as cm:
            self.plan("pano")
        self.assertEqual(cm.exception.code, C.EXIT_USAGE)
        p = self.plan("pano", "--input", str(self.d / "photo.png"), "--seed", "5", "--resolution", "1952x960")
        (s,) = p["steps"]
        self.assertTrue(s["argv"][1].endswith("hyworld2/panogen/pipeline_with_qwen_image.py"))
        a = s["argv"]
        self.assertEqual(a[a.index("--seed") + 1], "5")
        self.assertEqual(a[a.index("--lora-path") + 1], "tencent/HY-World-2.0")
        self.assertEqual(a[a.index("--lora-subfolder") + 1], "HY-Pano-2.0")
        self.assertEqual(a[a.index("--pretrained-model-name-or-path") + 1], "Qwen/Qwen-Image-Edit-2509")
        self.assertEqual(a[a.index("--width") + 1], "1952")
        self.assertTrue(a[a.index("--save") + 1].endswith("panorama.png"))

    def test_worldmirror(self):
        p = self.plan("worldmirror", "--input", str(self.d / "a.png"), "--input", str(self.d / "photo.png"),
                      "--export-target", "unity", "--format", "ply")
        (s,) = p["steps"]
        a = s["argv"]
        self.assertEqual(a[1:3], ["-m", "hyworld2.worldrecon.pipeline"])
        self.assertTrue(a[a.index("--strict_output_path") + 1].endswith("worldmirror"))
        self.assertEqual(a[a.index("--subfolder") + 1], "HY-WorldMirror-2.0")
        self.assertIn("--no_interactive", a)
        self.assertEqual(len(s["stage_inputs"]), 2)
        v = self.plan("worldmirror", "--input", str(self.d / "clip.mp4"))
        self.assertTrue(v["steps"][0]["argv"][v["steps"][0]["argv"].index("--input_path") + 1].endswith("clip.mp4"))
        with self.assertRaises(C.AdapterError):
            self.plan("worldmirror")

    def test_worldmirror_multi_gpu(self):
        os.environ["LATTICE_HY_NPROC"] = "2"
        p = self.plan("worldmirror", "--input", str(self.d / "a.png"), "--input", str(self.d / "photo.png"))
        a = p["steps"][0]["argv"]
        self.assertIn("torch.distributed.run", a)
        self.assertIn("--use_fsdp", a)
        one = self.plan("worldmirror", "--input", str(self.d / "a.png"))  # fewer images than GPUs -> 1 GPU
        self.assertNotIn("torch.distributed.run", one["steps"][0]["argv"])

    def test_stereo_needs_llm(self):
        with self.assertRaises(C.AdapterError) as cm:
            self.plan("stereo", "--input", str(self.d / "photo.png"))
        self.assertIn("LATTICE_HY_LLM_ADDR", cm.exception.hint)

    def test_export_pipeline(self):
        os.environ["LATTICE_HY_LLM_ADDR"] = "10.0.0.5"
        p = self.plan("export", "--input", str(self.d / "photo.png"), "--seed", "11")
        labels = [s["label"] for s in p["steps"]]
        self.assertEqual(labels, ["HY-Pano 2.0 (qwen)", "WorldNav traj_generate", "WorldNav traj_render",
                                  "WorldStereo 2.0 video_gen", "gen_gs_data", "world_gs_trainer"])
        self.assertEqual([s["stage"] for s in p["steps"]], ["pano", "worldnav", "worldnav", "worldstereo", "3dgs", "3dgs"])
        tg = p["steps"][1]["argv"]
        self.assertIn("--force_vlm", tg)
        self.assertEqual(tg[tg.index("--llm_addr") + 1], "10.0.0.5")
        self.assertEqual(tg[tg.index("--llm_name") + 1], "Qwen/Qwen3-VL-8B-Instruct")
        self.assertEqual(tg[tg.index("--seed") + 1], "11")
        tr = p["steps"][-1]["argv"]
        self.assertEqual(tr[tr.index("--max_steps") + 1], "8000")  # 1 GPU per upstream README
        self.assertEqual(p["gs_max_steps"], 8000)
        self.assertIn("--convert_to_spz", tr)
        self.assertIn("--export_mesh", tr)
        self.assertEqual(p["outputs"], ["panorama.png", "scene.ply", "scene.spz", "scene_mesh.ply"])

    def test_export_panorama_input_and_8_gpus(self):
        os.environ.update(LATTICE_HY_LLM_ADDR="h", LATTICE_HY_NPROC="8")
        p = self.plan("export", "--input", str(self.d / "pano.png"))
        self.assertEqual(p["steps"][0]["label"], "use input panorama")
        vg = p["steps"][3]["argv"]
        self.assertIn("--nproc_per_node=8", vg)
        self.assertIn("--fsdp", vg)
        tr = p["steps"][-1]["argv"]
        self.assertEqual(tr[tr.index("--max_steps") + 1], "1500")
        self.assertEqual(tr[tr.index("--strategy.refine-stop-iter") + 1], "750")

    def test_pano_backend_override(self):
        m = self.d / "m.json"
        m.write_text(json.dumps({"models": {"hy-world-2.0": {"pano_backend": "hunyuan-image-3"}}}))
        os.environ["LATTICE_MODEL_MAP"] = str(m)
        p = self.plan("pano", "--input", str(self.d / "photo.png"))
        a = p["steps"][0]["argv"]
        self.assertTrue(a[1].endswith("panogen/pipeline.py"))
        self.assertEqual(a[a.index("--subfolder") + 1], "HY-Pano-2.0")


# ---------------------------------------------------------------------------
PROG_RE = re.compile(r"^PROGRESS (\d\.\d{3})$", re.M)


class TestCosmosRuns(FakeUpstream, unittest.TestCase):
    """The cosmos adapter as a subprocess against the fake torch/diffusers."""

    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.addCleanup(self.td.cleanup)
        self.out = Path(self.td.name) / "out"
        self.log = Path(self.td.name) / "calls.jsonl"

    def calls(self):
        return [json.loads(x) for x in self.log.read_text().splitlines()] if self.log.exists() else []

    def base(self, prompt="a robot"):
        return ["generate", "--model", "cosmos3-edge-4b", "--prompt", prompt, "--out", str(self.out),
                "--frames", "9", "--resolution", "832x480", "--seed", "7", "--steps", "4", "--guidance", "5"]

    def test_generate_success(self):
        r = self.run_cli("adapters.cosmos.cli", self.base(),
                         self.env(FAKE_DIFFUSERS_LOG=self.log, HF_TOKEN=TOKEN))
        self.assertEqual(r.returncode, 0, r.stderr)
        vals = [float(v) for v in PROG_RE.findall(r.stdout)]
        self.assertEqual(vals[-1], 1.0)
        self.assertEqual(vals, sorted(vals))
        self.assertGreater(len(vals), 5)  # per-step callback progress
        self.assertNotIn(TOKEN, r.stdout + r.stderr)
        self.assertTrue((self.out / "rollout.mp4").exists())
        res = json.loads((self.out / "cosmos_result.json").read_text())
        self.assertEqual(res["outputs"], ["rollout.mp4"])
        self.assertNotIn(TOKEN, (self.out / "cosmos_result.json").read_text())
        ev = {c["event"]: c for c in self.calls()}
        self.assertEqual(ev["from_pretrained"]["repo"], "nvidia/Cosmos3-Edge")
        self.assertEqual(ev["from_pretrained"]["token_sha256"], hashlib.sha256(TOKEN.encode()).hexdigest())
        self.assertTrue(ev["from_pretrained"]["kw"]["enable_safety_checker"])
        self.assertEqual(ev["scheduler"]["kw"], {"flow_shift": 8.0})
        self.assertEqual(ev["to"]["device"], "cuda")
        call = ev["call"]
        self.assertEqual((call["num_inference_steps"], call["seed"]), (4, 7))
        kw = call["kw"]
        self.assertEqual((kw["num_frames"], kw["height"], kw["width"], kw["fps"], kw["guidance_scale"]),
                         (9, 480, 832, 24, 5.0))
        self.assertNotIn("image", kw)

    def test_i2v_and_policy(self):
        img = Path(self.td.name) / "a.png"
        img.write_bytes(PNG_1x1)
        r = self.run_cli("adapters.cosmos.cli", ["generate", "--model", "cosmos3-i2v", "--prompt", "go", "--out",
                                                 str(self.out), "--input", str(img)],
                         self.env(FAKE_DIFFUSERS_LOG=self.log))
        self.assertEqual(r.returncode, 0, r.stderr)
        call = [c for c in self.calls() if c["event"] == "call"][0]
        self.assertTrue(call["kw"]["image"]["image"].endswith("a.png"))
        self.assertEqual(call["kw"]["num_frames"], 189)

    def test_missing_torch_exit_2(self):
        env = self.env(fake=False)
        env["PYTHONPATH"] = os.pathsep.join([str(ROOT), str(self.notorch)])
        r = self.run_cli("adapters.cosmos.cli", self.base(), env)
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn("PyTorch is not installed", r.stderr)
        self.assertIn("hint: install the Diffusers backend", r.stderr)

    def test_missing_diffusers_exit_2(self):
        env = self.env(fake=False)
        shadow = Path(self.td.name) / "onlytorch"
        (shadow / "torch").mkdir(parents=True)
        (shadow / "torch" / "__init__.py").write_text(textwrap.dedent(FAKE["torch/__init__.py"]))
        env["PYTHONPATH"] = os.pathsep.join([str(ROOT), str(shadow)])
        r = self.run_cli("adapters.cosmos.cli", self.base(), env)
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn("diffusers is not installed", r.stderr)

    def test_no_cuda_exit_3(self):
        r = self.run_cli("adapters.cosmos.cli", self.base(), self.env(FAKE_CUDA=0))
        self.assertEqual(r.returncode, 3, r.stderr)
        self.assertIn("CUDA is not available", r.stderr)

    def test_oom_exit_4(self):
        r = self.run_cli("adapters.cosmos.cli", self.base("OOM please"), self.env(HF_TOKEN=TOKEN))
        self.assertEqual(r.returncode, 4, r.stderr)
        self.assertIn("out of GPU memory", r.stderr)
        self.assertIn("datacenter", r.stderr)
        self.assertNotIn(TOKEN, r.stdout + r.stderr)

    def test_unmapped_model_exit_5(self):
        m = Path(self.td.name) / "m.json"
        m.write_text(json.dumps({"models": {"cosmos3-edge-4b": None}}))
        r = self.run_cli("adapters.cosmos.cli", self.base(), self.env(LATTICE_MODEL_MAP=m))
        self.assertEqual(r.returncode, 5, r.stderr)
        self.assertIn("LATTICE_MODEL_MAP", r.stderr)

    def test_script_form_and_plan(self):
        r = subprocess.run([sys.executable, str(ROOT / "adapters" / "cosmos" / "cli.py"), *self.base(), "--plan"],
                           capture_output=True, text=True, env=self.env(fake=False), cwd=self.td.name, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        plan = json.loads(r.stdout)
        self.assertEqual((plan["repo"], plan["frames"], plan["seed"]), ("nvidia/Cosmos3-Edge", 9, 7))
        self.assertFalse(self.out.exists())  # --plan writes nothing

    def test_policy_run(self):
        imgs = []
        for n in ("wrist.png", "ext1.png", "ext2.png"):
            p = Path(self.td.name) / n
            p.write_bytes(PNG_1x1)
            imgs += ["--input", str(p)]
        # PIL may be missing on the test box: use a single pre-composited frame when it is
        try:
            import PIL  # noqa: F401
        except ImportError:
            imgs = imgs[:2]
            fake_pil = Path(self.td.name) / "pil"
            (fake_pil / "PIL").mkdir(parents=True)
            (fake_pil / "PIL" / "__init__.py").write_text(textwrap.dedent("""
                class _Img:
                    def convert(self, m): return self
                    def save(self, p): open(p, "wb").write(b"img")
                class Image:
                    @staticmethod
                    def open(p): return _Img()
                ImageOps = None
            """))
            (fake_pil / "PIL" / "Image.py").write_text("from PIL import Image as _I\nopen = _I.open\n")
            (fake_pil / "PIL" / "ImageOps.py").write_text("")
            extra = str(fake_pil)
        else:
            extra = None
        env = self.env(FAKE_DIFFUSERS_LOG=self.log)
        if extra:
            env["PYTHONPATH"] += os.pathsep + extra
        r = self.run_cli("adapters.cosmos.cli", ["action", "--model", "cosmos3-droid-policy", "--prompt",
                                                 "put the cup in the bin", "--out", str(self.out), *imgs], env)
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        call = [c for c in self.calls() if c["event"] == "call"][0]
        self.assertIn("droid_lerobot", call["kw"]["action"])
        self.assertEqual(call["kw"]["fps"], 15)
        self.assertFalse(call["kw"]["use_system_prompt"])
        sched = [c for c in self.calls() if c["event"] == "scheduler"][0]
        self.assertEqual(sched["kw"], {"flow_shift": 5.0, "use_karras_sigmas": False})
        acts = json.loads((self.out / "actions.json").read_text())
        self.assertEqual(acts["space"], "model-normalized")
        self.assertTrue((self.out / "rollout.mp4").exists())


class TestHyRuns(FakeUpstream, unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.addCleanup(self.td.cleanup)
        self.out = Path(self.td.name) / "run"
        self.imgs = []
        for i in range(2):
            p = Path(self.td.name) / f"view{i}.png"
            p.write_bytes(png(640, 480))
            self.imgs += ["--input", str(p)]

    def test_worldmirror_run(self):
        r = self.run_cli("adapters.hyworld.cli", ["worldmirror", "--model", "hy-world-2.0", "--prompt", "",
                                                  "--out", str(self.out), *self.imgs, "--seed", "3"],
                         self.env(LATTICE_HY_ROOT=self.hyroot, LATTICE_HY_NPROC=1, HF_TOKEN=TOKEN))
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        self.assertTrue((self.out / "worldmirror" / "gaussians.ply").exists())
        cam = json.loads((self.out / "worldmirror" / "camera_params.json").read_text())
        self.assertEqual(cam["seen"], ["view0.png", "view1.png"])
        self.assertFalse((self.out / "hy_work").exists())  # intermediates cleaned
        res = json.loads((self.out / "hyworld_result.json").read_text())
        self.assertIn("worldmirror/gaussians.ply", res["outputs"])
        self.assertIn("Tencent", res["license"])
        vals = [float(v) for v in PROG_RE.findall(r.stdout)]
        self.assertEqual(vals[-1], 1.0)
        self.assertEqual(vals, sorted(vals))
        self.assertGreater(len(vals), 3)  # tqdm "i/n [" lines mapped to progress
        self.assertNotIn(TOKEN, r.stdout + r.stderr)

    def test_missing_root_exit_2(self):
        r = self.run_cli("adapters.hyworld.cli", ["worldmirror", "--model", "hy-world-2.0", "--out", str(self.out),
                                                  *self.imgs], self.env(fake=False))
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn("LATTICE_HY_ROOT", r.stderr)

    def test_no_cuda_exit_3_and_oom_exit_4(self):
        r = self.run_cli("adapters.hyworld.cli", ["worldmirror", "--model", "hy-world-2.0", "--out", str(self.out),
                                                  *self.imgs], self.env(LATTICE_HY_ROOT=self.hyroot, FAKE_CUDA=0))
        self.assertEqual(r.returncode, 3, r.stderr)
        r = self.run_cli("adapters.hyworld.cli", ["worldmirror", "--model", "hy-world-2.0", "--out", str(self.out),
                                                  *self.imgs],
                         self.env(LATTICE_HY_ROOT=self.hyroot, LATTICE_HY_NPROC=1, FAKE_HY_OOM=1))
        self.assertEqual(r.returncode, 4, r.stderr)
        self.assertIn("out of GPU memory", r.stderr)


class TestDoctor(FakeUpstream, unittest.TestCase):
    KEYS = {"schema", "python", "platform", "gpu", "ffmpeg", "cosmos", "hyworld", "model_map", "hf_token_in_env",
            "hf_cached_login", "disk", "models", "can_run"}

    def test_json_report(self):
        with tempfile.TemporaryDirectory() as d:
            r = subprocess.run([sys.executable, "-m", "adapters.doctor", "--json", "--runs", str(Path(d) / "runs")],
                               capture_output=True, text=True, env=self.env(fake=False, HF_TOKEN=TOKEN,
                                                                            PATH=os.environ.get("PATH", "")),
                               cwd=d, timeout=240)
        self.assertIn(r.returncode, (0, 1), r.stderr)
        rep = json.loads(r.stdout)
        self.assertTrue(self.KEYS <= set(rep), self.KEYS - set(rep))
        self.assertEqual(rep["schema"], "lattice.doctor/1")
        self.assertIs(rep["hf_token_in_env"], True)
        self.assertNotIn(TOKEN, r.stdout + r.stderr)
        self.assertEqual(set(rep["models"]), set(TestModelMap.IDS))
        for m in rep["models"].values():
            self.assertIn("can_run", m)
        self.assertIn("free_gib", rep["disk"])
        self.assertEqual(r.returncode, 0 if rep["can_run"] else 1)

    def test_feasibility_logic(self):
        from adapters import doctor as D
        e = C.DEFAULT_MODEL_MAP
        g = lambda *gib: [{"name": "x", "memory_gib": v} for v in gib]  # noqa: E731
        self.assertEqual(D.feasibility(e["cosmos3-nano-16b"], g(80), True, True)["status"], "fits")
        self.assertEqual(D.feasibility(e["cosmos3-nano-16b"], g(32), True, True)["status"], "fits-with-offload")
        self.assertEqual(D.feasibility(e["cosmos3-super-64b"], g(80, 80), True, True)["status"], "multi-gpu")
        self.assertEqual(D.feasibility(e["cosmos3-super-64b"], g(24), True, True)["status"], "too-small")
        self.assertFalse(D.feasibility(e["cosmos3-edge-4b"], g(48), False, True)["can_run"])
        self.assertTrue(D.feasibility(e["cosmos3-edge-4b"], g(48), True, True)["can_run"])
        self.assertEqual(D.feasibility(e["cosmos3-edge-4b"], [], True, True)["status"], "no-gpu")
        self.assertFalse(D.feasibility(e["hy-world-2.0"], g(24, 24), True, True)["worldgen_ok"])


# ---------------------------------------------------------------------------
# End-to-end: worker (LATTICE_EXEC=1) -> adapters.cosmos.cli -> fake upstream -> video artifact
# ---------------------------------------------------------------------------
from test_exec import ExecBase  # noqa: E402
from test_worker import job  # noqa: E402


class TestWorkerEndToEnd(FakeUpstream, ExecBase):
    ENV = {}

    def setUp(self):
        self.ENV = {
            "LATTICE_DRY_RUN": "", "LATTICE_EXEC": "1", "HF_TOKEN": "", "LATTICE_MODEL_MAP": "",
            "LATTICE_COSMOS_MODULE": "diffusers", "LATTICE_HY_MODULE": "hyworld2",
            "LATTICE_COSMOS_CMD": f"{shlex.quote(sys.executable)} -m adapters.cosmos.cli",
            "LATTICE_HY_CMD": f"{shlex.quote(sys.executable)} -m adapters.hyworld.cli",
            "LATTICE_HY_ROOT": str(self.hyroot), "LATTICE_HY_NPROC": "1",
            "PYTHONPATH": os.pathsep.join([str(ROOT), str(self.fake), str(self.hyroot)]),
            "FAKE_DIFFUSERS_LOG": str(self.fake / "e2e_calls.jsonl"), "FAKE_STEP_SLEEP": "0.15",
        }
        # the worker detects engines with find_spec in *this* process: expose the fakes here too
        sys.path[:0] = [str(self.fake), str(self.hyroot)]
        import importlib
        importlib.invalidate_caches()
        self.addCleanup(lambda: [sys.path.remove(p) for p in (str(self.fake), str(self.hyroot)) if p in sys.path])
        super().setUp()

    def test_cosmos_job_real_path_produces_video(self):
        self.assertTrue(self.w.engines()["cosmos"]["installed"])
        jid = self.submit(job(model="cosmos3-edge-4b", params={"frames": 9, "fps": 16, "resolution": "832x480",
                                                               "seed": 5, "steps": 6, "guidance": 4.0}), token=TOKEN)
        st, seen = self.wait(jid, timeout=60)
        self.assertEqual(st["status"], "done", st)
        self.assertFalse(st["dry_run"])
        vids = [a for a in st["artifacts"] if a["kind"] == "video"]
        self.assertEqual([a["name"] for a in vids], ["rollout.mp4"])
        self.assertIn("cosmos_result.json", [a["name"] for a in st["artifacts"]])
        self.assertTrue(any(0.05 < p < 0.95 for p in seen), seen)  # adapter PROGRESS reached the status
        self.assert_no_token_on_disk(jid)
        self.assert_exit_codes_zero(st)
        calls = [json.loads(x) for x in (self.fake / "e2e_calls.jsonl").read_text().splitlines()]
        call = [c for c in calls if c["event"] == "call"][-1]
        self.assertEqual((call["kw"]["num_frames"], call["kw"]["fps"], call["seed"], call["num_inference_steps"]),
                         (9, 16, 5, 6))
        fp = [c for c in calls if c["event"] == "from_pretrained"][-1]
        self.assertEqual(fp["token_sha256"], hashlib.sha256(TOKEN.encode()).hexdigest())

    def test_cosmos_job_oom_fails_with_code_4(self):
        j = job(model="cosmos3-edge-4b")
        j["inputs"]["prompt"] = "OOM storm"
        jid = self.submit(j)
        st, _ = self.wait(jid, timeout=60)
        self.assertEqual(st["status"], "failed", st)
        self.assertIn("code 4", st["error"])
        self.assertTrue(any("out of GPU memory" in ln for ln in st["log"]), st["log"])

    def test_hyworld_worldmirror_job(self):
        self.assertTrue(self.w.engines()["hyworld"]["installed"])
        data = "data:image/png;base64," + base64.b64encode(png(640, 480)).decode()
        j = job(engine="hyworld", mode="worldmirror", model="hy-world-2.0",
                params={"export_target": "unity", "format": "ply"})
        j["inputs"]["media"] = [{"name": f"v{i}.png", "type": "image/png", "size": 30, "kind": "image", "data": data}
                                for i in range(2)]
        jid = self.submit(j)
        st, _ = self.wait(jid, timeout=60)
        self.assertEqual(st["status"], "done", st)
        names = [a["name"] for a in st["artifacts"]]
        self.assertIn("worldmirror/gaussians.ply", names)

    def test_bridge_job_through_both_adapters(self):
        j = job(engine="bridge", mode="bridge", model="cosmos3-edge-4b+hy-world-2.0",
                params={"frames": 9, "steps": 2, "export_target": "unity", "format": "ply"})
        import shutil as _sh
        import worker as W
        # the fake mp4 is not decodable: hide ffmpeg so the worker's copy fallback runs deterministically
        with mock.patch.object(W.shutil, "which", lambda n, *a, **k: None if n == "ffmpeg" else _sh.which(n, *a, **k)):
            jid = self.submit(j)
            st, _ = self.wait(jid, timeout=90)
        self.assertEqual(st["status"], "done", st)
        names = [a["name"] for a in st["artifacts"]]
        self.assertIn("rollout/rollout.mp4", names)
        self.assertIn("worldmirror/gaussians.ply", names)
        self.assertTrue(any(a["kind"] == "bundle" for a in st["artifacts"]), names)
        self.assert_exit_codes_zero(st)


if __name__ == "__main__":
    unittest.main()
