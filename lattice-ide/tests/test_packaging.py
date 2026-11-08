"""Packaging checks: pyproject, pip install, Dockerfile, deploy/ files and install.sh.

Stdlib unittest only. Optional pieces skip with a reason:
  - the tomllib parse on Python 3.10 (a small regex reader still checks modules/entry points),
  - the `pip install --target` check when pip (or network for an isolated build) is unavailable,
  - the Docker build + /health check unless LATTICE_TEST_DOCKER=1 (set
    LATTICE_TEST_DOCKER_FFMPEG=0 to skip the apt ffmpeg layer on builders without apt access, or
    LATTICE_TEST_DOCKER_IMAGE=<tag> to test an image built in an earlier step).
"""
from __future__ import annotations

import configparser
import importlib
import json
import os
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

try:
    import tomllib  # Python 3.11+
except ImportError:  # pragma: no cover - 3.10
    tomllib = None

OPTIONAL_MODULES = {"users"}  # multi-user helper; may not exist in every checkout
PWA_FILES = ["index.html", "styles.css", "app.js", "sw.js", "manifest.json", "icon.svg"]
DEPLOY_FILES = ["lattice-worker.service", "worker.env.example", "Caddyfile", "docker-compose.yml"]
# Anything that would fetch or bundle model weights.
WEIGHT_PATTERNS = [r"huggingface-cli", r"\bhf\s+download\b", r"hf_hub_download", r"snapshot_download",
                   r"from_pretrained", r"git\s+lfs", r"\.safetensors", r"\.ckpt\b", r"\.gguf\b",
                   r"\bHF_TOKEN\b", r"huggingface\.co"]


def read(rel: str) -> str:
    return (ROOT / rel).read_text("utf-8")


def code_lines(text: str) -> list[str]:
    """Non-comment, non-blank lines (for Dockerfile / sh / unit checks)."""
    return [ln for ln in text.splitlines() if ln.strip() and not ln.lstrip().startswith("#")]


def load_pyproject() -> dict:
    """Full parse with tomllib; on 3.10 a minimal reader for the keys these tests need."""
    text = read("pyproject.toml")
    if tomllib is not None:
        return tomllib.loads(text)
    data: dict = {"project": {"scripts": {}}, "tool": {"setuptools": {}}}
    section = None
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        m = re.fullmatch(r"\[([^\]]+)\]", line)
        if m:
            section = m.group(1)
            continue
        m = re.fullmatch(r'([A-Za-z0-9_.-]+)\s*=\s*(.+)', line)
        if not m:
            continue
        key, val = m.group(1), m.group(2)
        if section == "project.scripts":
            data["project"]["scripts"][key] = json.loads(val)
        elif section == "tool.setuptools" and key in ("py-modules", "packages"):
            data["tool"]["setuptools"][key] = json.loads(val)
        elif section == "project" and key in ("name", "version", "license", "requires-python"):
            data["project"][key] = json.loads(val)
    return data


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class PyprojectTest(unittest.TestCase):
    def setUp(self):
        self.pp = load_pyproject()
        self.st = self.pp["tool"]["setuptools"]

    def test_tomllib_parse(self):
        if tomllib is None:
            self.skipTest("tomllib needs Python 3.11+; module/entry-point checks still run via a regex reader")
        p = self.pp["project"]
        self.assertEqual(p["name"], "lattice-worker")
        self.assertEqual(p["version"], "1.0.0")
        self.assertEqual(p["license"], "MIT")
        self.assertEqual(p["requires-python"], ">=3.10")
        self.assertEqual(p.get("dependencies", []), [], "the worker is stdlib-only")
        self.assertEqual(self.pp["build-system"]["build-backend"], "setuptools.build_meta")
        self.assertEqual(p["scripts"], {"lattice-worker": "worker:main", "lattice-batch": "batch:run",
                                        "lattice-doctor": "adapters.doctor:main",
                                        "lattice-cosmos": "adapters.cosmos.cli:cli",
                                        "lattice-hyworld": "adapters.hyworld.cli:cli"})
        self.assertIn("worker", self.st["py-modules"])
        self.assertIn("batch", self.st["py-modules"])
        self.assertEqual(self.st["packages"], ["exporters", "adapters", "adapters.cosmos", "adapters.hyworld"])

    def test_version_matches_worker(self):
        import worker
        self.assertEqual(self.pp["project"]["version"], worker.VERSION)

    def test_declared_modules_exist(self):
        for mod in self.st["py-modules"]:
            if mod in OPTIONAL_MODULES and not (ROOT / f"{mod}.py").exists():
                continue
            self.assertTrue((ROOT / f"{mod}.py").is_file(), f"py-module {mod} has no {mod}.py")
        for pkg in self.st["packages"]:
            self.assertTrue((ROOT / pkg.replace(".", "/") / "__init__.py").is_file(), f"package {pkg} has no __init__.py")
        self.assertNotIn("tests", self.st["packages"])

    def test_entry_points_resolve(self):
        scripts = self.pp["project"]["scripts"]
        self.assertEqual(set(scripts), {"lattice-worker", "lattice-batch", "lattice-doctor",
                                        "lattice-cosmos", "lattice-hyworld"})
        for name, target in scripts.items():
            mod_name, _, attr = target.partition(":")
            shipped = mod_name in self.st["py-modules"] or mod_name.rpartition(".")[0] in self.st["packages"]
            self.assertTrue(shipped, f"{name}: {mod_name} is not shipped")
            mod = importlib.import_module(mod_name)
            self.assertTrue(callable(getattr(mod, attr, None)), f"{name}: {target} is not callable")


class PipInstallTest(unittest.TestCase):
    def test_pip_install_target(self):
        if subprocess.run([sys.executable, "-m", "pip", "--version"], capture_output=True).returncode != 0:
            self.skipTest("pip is not available for this interpreter")
        with tempfile.TemporaryDirectory() as td:
            src, out = Path(td) / "src", Path(td) / "out"
            # Build from a copy so no build/ or *.egg-info lands in the checkout.
            src.mkdir()
            for f in ["pyproject.toml", "worker.py", "batch.py", "users.py", "LICENSE", "NOTICE", "README.md"]:
                if (ROOT / f).exists():
                    shutil.copy2(ROOT / f, src / f)
            for pkg in ("exporters", "adapters", "adapters/cosmos", "adapters/hyworld"):
                (src / pkg).mkdir(parents=True, exist_ok=True)
                for f in (ROOT / pkg).glob("*.py"):
                    shutil.copy2(f, src / pkg / f.name)
            cmd = [sys.executable, "-m", "pip", "install", "--no-deps", "--no-input", "--disable-pip-version-check",
                   "--target", str(out), str(src)]
            try:
                import setuptools  # noqa: F401
                v = tuple(int(x) for x in re.findall(r"\d+", setuptools.__version__)[:2])
                if v >= (77, 0):
                    cmd.insert(4, "--no-build-isolation")  # offline-friendly when the local backend suffices
            except ImportError:
                pass
            env = dict(os.environ, PIP_NO_CACHE_DIR="1")
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=600, env=env)
            if r.returncode != 0:
                blob = r.stdout + r.stderr
                if re.search(r"NewConnectionError|ConnectionError|Temporary failure in name resolution|"
                             r"No matching distribution found for setuptools|ProxyError|Network is unreachable",
                             blob):
                    self.skipTest("isolated build needs network to fetch setuptools>=77: " + blob.strip()[-300:])
                self.fail("pip install failed:\n" + blob[-3000:])
            self.assertTrue((out / "worker.py").is_file())
            self.assertTrue((out / "batch.py").is_file())
            self.assertTrue((out / "exporters" / "__init__.py").is_file())
            self.assertTrue((out / "adapters" / "doctor.py").is_file())
            self.assertTrue((out / "adapters" / "cosmos" / "cli.py").is_file())
            self.assertTrue((out / "adapters" / "hyworld" / "cli.py").is_file())
            self.assertFalse((out / "tests").exists(), "tests/ must not be packaged")
            self.assertFalse((out / "examples").exists(), "examples/ must not be packaged")
            if (ROOT / "users.py").exists():
                self.assertTrue((out / "users.py").is_file(), "users.py exists but was not packaged")
            eps = next(out.glob("lattice_worker-1.0.0.dist-info")) / "entry_points.txt"
            text = eps.read_text()
            self.assertIn("lattice-worker = worker:main", text)
            self.assertIn("lattice-batch = batch:run", text)
            self.assertIn("lattice-doctor = adapters.doctor:main", text)
            penv = dict(os.environ, PYTHONPATH=str(out))
            for script in ("lattice-worker", "lattice-batch", "lattice-cosmos", "lattice-hyworld"):
                path = out / "bin" / script
                self.assertTrue(path.is_file(), f"console script {script} missing")
                r = subprocess.run([sys.executable, str(path), "--help"], capture_output=True, text=True,
                                   timeout=60, env=penv, cwd=td)
                self.assertEqual(r.returncode, 0, f"{script} --help failed: {r.stderr[-800:]}")
                self.assertIn("usage", r.stdout.lower())
            # The installed worker finds the installed exporters package.
            r = subprocess.run([sys.executable, "-c",
                                "import worker, sys; m = worker.load_exporters(); "
                                "sys.exit(0 if m and m.__file__.startswith(sys.argv[1]) else 1)", str(out)],
                               capture_output=True, text=True, timeout=60, env=penv, cwd=td)
            self.assertEqual(r.returncode, 0, r.stderr[-800:])


class DockerfileTest(unittest.TestCase):
    def setUp(self):
        self.text = read("Dockerfile")
        self.lines = code_lines(self.text)
        self.code = "\n".join(self.lines)

    def instr(self, name):
        return [ln for ln in self.lines if ln.split()[0].upper() == name]

    def test_base_and_layout(self):
        froms = self.instr("FROM")
        self.assertEqual(len(froms), 1, "single CPU stage; the CUDA variant is documentation only")
        self.assertEqual(froms[0].split()[1], "python:3.12-slim")
        self.assertIn("WORKDIR /app", self.lines)
        self.assertTrue(any("8787" in ln for ln in self.instr("EXPOSE")))
        self.assertTrue(any("/data" in ln for ln in self.instr("VOLUME")))

    def test_non_root_user(self):
        users = self.instr("USER")
        self.assertTrue(users, "Dockerfile must switch to a non-root USER")
        final = users[-1].split()[1].split(":")[0]
        self.assertNotIn(final, ("root", "0"))
        user_idx = self.lines.index(users[-1])
        cmd_idx = self.lines.index(self.instr("CMD")[-1])
        self.assertLess(user_idx, cmd_idx)

    def test_healthcheck_and_cmd(self):
        hc = [ln for ln in self.lines if ln.startswith("HEALTHCHECK")]
        self.assertTrue(hc)
        self.assertIn("/health", self.code.split("HEALTHCHECK", 1)[1].split("\nCMD", 1)[0])
        cmd = json.loads(self.instr("CMD")[-1][len("CMD"):].strip())
        self.assertEqual(cmd, ["python3", "worker.py", "--host", "0.0.0.0", "--port", "8787", "--runs", "/data/runs"])

    def test_ffmpeg_no_recommends(self):
        self.assertRegex(self.code, r"apt-get install -y --no-install-recommends ffmpeg")
        self.assertIn("rm -rf /var/lib/apt/lists/*", self.code)

    def test_no_weights_or_downloads(self):
        for pat in WEIGHT_PATTERNS + [r"\bcurl\b", r"\bwget\b", r"pip\s+install", r"^ADD\s"]:
            self.assertIsNone(re.search(pat, self.code, re.M | re.I), f"Dockerfile must not match {pat!r}")
        self.assertNotRegex(self.code, r"ENV[^\n]*LATTICE_DRY_RUN", "LATTICE_DRY_RUN stays unset in the image")
        self.assertNotRegex(self.code, r"ENV[^\n]*LATTICE_TOKEN", "no baked-in tokens")

    def test_copy_sources_exist(self):
        for ln in self.instr("COPY"):
            parts = ln.split()[1:-1]
            for src in parts:
                if src.startswith("--"):
                    continue
                if "[" in src:  # optional file via bracket glob (e.g. users.p[y])
                    continue
                matches = list(ROOT.glob(src))
                self.assertTrue(matches, f"COPY source {src} does not exist")
                self.assertFalse(src.startswith(("tests", "runs", "deploy")), f"do not COPY {src}")
        for f in PWA_FILES:
            self.assertIn(f, self.code, f"PWA file {f} not copied")

    def test_dockerignore(self):
        di = read(".dockerignore").splitlines()
        for pat in ("runs/", "tests/", "**/*.safetensors", "*.env"):
            self.assertIn(pat, di)


class DeployFilesTest(unittest.TestCase):
    def test_files_present(self):
        for f in DEPLOY_FILES:
            self.assertTrue((ROOT / "deploy" / f).is_file(), f"deploy/{f} missing")

    def test_systemd_unit(self):
        cp = configparser.ConfigParser(interpolation=None, strict=True)
        cp.optionxform = str
        cp.read_string(read("deploy/lattice-worker.service"))
        self.assertTrue(cp.get("Unit", "Description"))
        self.assertIn("network-online.target", cp.get("Unit", "After"))
        s = cp["Service"]
        self.assertEqual(s["User"], "lattice")
        self.assertEqual(s["Group"], "lattice")
        self.assertEqual(s["EnvironmentFile"], "/etc/lattice/worker.env")
        self.assertRegex(s["ExecStart"], r"^/\S*python3 /opt/lattice/worker\.py$")
        self.assertEqual(s["WorkingDirectory"], "/opt/lattice")
        self.assertEqual(s["NoNewPrivileges"], "true")
        self.assertEqual(s["ProtectSystem"], "strict")
        self.assertIn("/var/lib/lattice", s["ReadWritePaths"].split())
        self.assertEqual(s["Restart"], "on-failure")
        self.assertNotIn("PrivateDevices", s, "GPU engines need /dev/nvidia*")
        self.assertEqual(cp.get("Install", "WantedBy"), "multi-user.target")

    def test_env_example_covers_every_var(self):
        env = read("deploy/worker.env.example")
        used = set(re.findall(r"LATTICE_[A-Z][A-Z0-9_]*", read("worker.py")))
        for extra in ("users.py",):
            if (ROOT / extra).exists():
                used |= set(re.findall(r"LATTICE_[A-Z][A-Z0-9_]*", read(extra)))
        missing = sorted(v for v in used if not re.search(rf"^#?{v}=", env, re.M))
        self.assertEqual(missing, [], "document these in deploy/worker.env.example")

    def test_env_example_placeholders_only(self):
        env = read("deploy/worker.env.example")
        self.assertNotRegex(env, r"hf_[A-Za-z0-9]{8,}", "no HF tokens")
        self.assertNotRegex(env, r"(?m)^\s*(HF_TOKEN|HUGGING_FACE_HUB_TOKEN)\s*=")
        tok = re.search(r"(?m)^LATTICE_TOKEN=(.*)$", env).group(1).strip()
        self.assertTrue(tok == "" or tok.startswith("CHANGE_ME"), f"LATTICE_TOKEN must be a placeholder, got {tok!r}")
        self.assertRegex(env, r"(?m)^LATTICE_HOST=127\.0\.0\.1$", "bind locally behind the proxy")
        self.assertRegex(env, r"(?m)^LATTICE_RUNS=/var/lib/lattice/")

    def test_caddyfile(self):
        c = read("deploy/Caddyfile")
        body = "\n".join(code_lines(c))
        self.assertEqual(body.count("{") - body.count("{$"), body.count("}") - body.count("{$"),
                         "unbalanced braces")
        self.assertIn("handle_path /api/*", body)
        self.assertRegex(body, r"reverse_proxy \{\$LATTICE_UPSTREAM:127\.0\.0\.1:8787\}")
        self.assertIn("max_size 64MB", body)
        self.assertIn("file_server", body)
        self.assertIn("https://<host>/api", c)

    def test_compose(self):
        y = read("deploy/docker-compose.yml")
        body = "\n".join(code_lines(y))
        for needle in ("worker:", "caddy:", "image: caddy:2", "lattice-runs:/data", "./worker.env",
                       "LATTICE_UPSTREAM: worker:8787", "./Caddyfile:/etc/caddy/Caddyfile:ro"):
            self.assertIn(needle, body)
        self.assertNotRegex(body, r"\"?\d*:?8787:8787", "the worker port must not be published")
        for pat in WEIGHT_PATTERNS:
            self.assertIsNone(re.search(pat, body, re.I), pat)
        for f in PWA_FILES:
            self.assertIn(f"../{f}:/srv/lattice/{f}:ro", body)


class InstallShTest(unittest.TestCase):
    SHIMMED = ("useradd", "adduser", "groupadd", "systemctl", "chown")

    def setUp(self):
        self.td = tempfile.mkdtemp(prefix="lattice-pkg-")
        os.chmod(self.td, 0o755)
        self.src = Path(self.td) / "src"
        self.prefix = Path(self.td) / "prefix"
        self.prefix.mkdir()
        # Self-contained source tree so the "writes nothing outside the prefix" check is exact.
        self.src.mkdir()
        for f in ["install.sh", "worker.py", "batch.py", "users.py", "LICENSE", "NOTICE", "README.md", "DEPLOY.md",
                  "ENGINES.md", *PWA_FILES]:
            if (ROOT / f).exists():
                shutil.copy2(ROOT / f, self.src / f)
        shutil.copytree(ROOT / "exporters", self.src / "exporters", ignore=shutil.ignore_patterns("__pycache__"))
        shutil.copytree(ROOT / "adapters", self.src / "adapters", ignore=shutil.ignore_patterns("__pycache__"))
        shutil.copytree(ROOT / "deploy", self.src / "deploy")
        shutil.copytree(ROOT / "examples", self.src / "examples")
        # PATH shims: privileged tools must never run in dry-run or staged mode.
        self.shims = Path(self.td) / "shims"
        self.shims.mkdir()
        for name in self.SHIMMED:
            p = self.shims / name
            p.write_text(f"#!/bin/sh\necho SHIM-CALLED {name} \"$@\" >&2\nexit 97\n")
            p.chmod(0o755)
        for d in Path(self.td).rglob("*"):
            d.chmod(d.stat().st_mode | stat.S_IROTH | (stat.S_IXOTH if d.is_dir() or os.access(d, os.X_OK) else 0))

    def tearDown(self):
        shutil.rmtree(self.td, ignore_errors=True)

    def snapshot(self, root: Path) -> dict:
        return {str(p.relative_to(root)): (p.stat().st_size, p.stat().st_mtime_ns)
                for p in root.rglob("*")}

    def run_sh(self, *args, prefix=True, drop_root=False, extra_env=None):
        env = {"PATH": f"{self.shims}:{os.environ.get('PATH', '/usr/bin:/bin')}", "HOME": self.td,
               "PYTHON": sys.executable, "LANG": "C"}
        if prefix:
            env["INSTALL_PREFIX"] = str(self.prefix)
        env.update(extra_env or {})
        cmd = ["sh", str(self.src / "install.sh"), *args]
        if drop_root and hasattr(os, "geteuid") and os.geteuid() == 0:
            setpriv = shutil.which("setpriv")
            if not setpriv:
                self.skipTest("running as root without setpriv; cannot prove the dry run needs no root")
            cmd = [setpriv, "--reuid=65534", "--regid=65534", "--clear-groups", *cmd]
        return subprocess.run(cmd, capture_output=True, text=True, timeout=120, env=env, cwd="/")

    def test_syntax(self):
        for shell in ("sh", "dash", "bash"):
            if shutil.which(shell):
                r = subprocess.run([shell, "-n", str(ROOT / "install.sh")], capture_output=True, text=True)
                self.assertEqual(r.returncode, 0, f"{shell} -n: {r.stderr}")
        self.assertTrue(read("install.sh").startswith("#!/bin/sh\n"))
        # Executable code only: drop comments and the printed next-steps heredoc.
        text = re.sub(r"(?s)<<EOF\n.*?\nEOF\n", "<<EOF\n", read("install.sh"))
        body = "\n".join(code_lines(text))
        for pat in WEIGHT_PATTERNS + [r"\bcurl\b", r"\bwget\b", r"pip\s+install", r"\brm\s+-r",
                                      r"systemctl\s+(enable|start|restart)\b"]:
            self.assertIsNone(re.search(pat, body), f"install.sh must not run {pat!r}")

    def test_dry_run_as_non_root_writes_nothing(self):
        before_src = self.snapshot(self.src)
        for prefix in (True, False):
            r = self.run_sh("--dry-run", prefix=prefix, drop_root=True)
            out = r.stdout + r.stderr
            self.assertEqual(r.returncode, 0, out[-2000:])
            self.assertNotIn("SHIM-CALLED", out)
            self.assertIn("[dry-run]", out)
            self.assertIn("Next steps", out)
            for word in ("LATTICE_TOKEN", "LATTICE_REGION", "License.txt", "OpenMDW", "Install the engines"):
                self.assertIn(word, out)
            self.assertEqual(list(self.prefix.iterdir()), [], "dry run wrote into the prefix")
            self.assertEqual(self.snapshot(self.src), before_src, "dry run wrote into the source tree")
        self.assertIn("/opt/lattice/worker.py", r.stdout)  # un-prefixed run shows real targets

    def test_staged_install_is_idempotent(self):
        before_src = self.snapshot(self.src)
        r = self.run_sh()
        out = r.stdout + r.stderr
        self.assertEqual(r.returncode, 0, out[-2000:])
        self.assertNotIn("SHIM-CALLED", out)
        app = self.prefix / "opt/lattice"
        for f in ["worker.py", "batch.py", "exporters/__init__.py", "ENGINES.md", "adapters/doctor.py",
                  "adapters/cosmos/cli.py", "adapters/hyworld/cli.py", "LICENSE", "NOTICE",
                  *[f"pwa/{p}" for p in PWA_FILES], *[f"deploy/{d}" for d in DEPLOY_FILES]]:
            self.assertTrue((app / f).is_file(), f"{f} not installed")
        env = self.prefix / "etc/lattice/worker.env"
        self.assertEqual(stat.S_IMODE(env.stat().st_mode), 0o600)
        env_text = env.read_text()
        self.assertRegex(env_text, r"(?m)^LATTICE_TOKEN=[0-9a-f]{64}$", "fresh random token expected")
        self.assertNotIn("CHANGE_ME", env_text)
        unit = (self.prefix / "etc/systemd/system/lattice-worker.service").read_text()
        self.assertIn(f"ExecStart={sys.executable} /opt/lattice/worker.py", unit)
        self.assertTrue((self.prefix / "var/lib/lattice/runs").is_dir())
        self.assertNotIn(env_text.split("LATTICE_TOKEN=")[1][:64], out, "token must not be printed")

        # Second run: nothing changes, env and token kept.
        r2 = self.run_sh()
        self.assertEqual(r2.returncode, 0, r2.stderr)
        self.assertNotRegex(r2.stdout, r"(?m)^installed ")
        self.assertIn("kept", r2.stdout)
        self.assertEqual(env.read_text(), env_text)

        # A locally edited unit is never overwritten; the shipped one goes to .new.
        unit_path = self.prefix / "etc/systemd/system/lattice-worker.service"
        unit_path.write_text(unit + "# local edit\n")
        r3 = self.run_sh()
        self.assertEqual(r3.returncode, 0, r3.stderr)
        self.assertTrue(unit_path.read_text().endswith("# local edit\n"))
        self.assertTrue(unit_path.with_name("lattice-worker.service.new").is_file())
        self.assertEqual(self.snapshot(self.src), before_src, "install wrote into the source tree")

    def test_rejects_old_python_and_unknown_flags(self):
        fake = self.shims / "oldpy"
        fake.write_text("#!/bin/sh\nexit 1\n")
        fake.chmod(0o755)
        r = self.run_sh("--dry-run", extra_env={"PYTHON": str(fake)})
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("3.10", r.stderr)
        r = self.run_sh("--bogus")
        self.assertEqual(r.returncode, 2)


@unittest.skipUnless(os.environ.get("LATTICE_TEST_DOCKER") == "1", "set LATTICE_TEST_DOCKER=1 to build the image")
class DockerImageTest(unittest.TestCase):
    def test_build_and_health(self):
        if not shutil.which("docker"):
            self.skipTest("docker CLI not found")
        name = f"lattice-pkgtest-{os.getpid()}"
        tag = os.environ.get("LATTICE_TEST_DOCKER_IMAGE")  # prebuilt image: skip the build step
        if not tag:
            tag = "lattice-worker:pkgtest"
            args = ["docker", "build", "-t", tag, str(ROOT)]
            if os.environ.get("LATTICE_TEST_DOCKER_FFMPEG") == "0":
                args[2:2] = ["--build-arg", "WITH_FFMPEG=0"]
            r = subprocess.run(args, capture_output=True, text=True, timeout=1200)
            self.assertEqual(r.returncode, 0, r.stderr[-3000:])
        port = free_port()
        subprocess.run(["docker", "rm", "-f", name], capture_output=True)
        r = subprocess.run(["docker", "run", "-d", "--name", name, "-p", f"127.0.0.1:{port}:8787",
                            "-e", "LATTICE_REGION=US", tag], capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 0, r.stderr)
        try:
            health, deadline = None, time.time() + 60
            while time.time() < deadline:
                try:
                    with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=3) as resp:
                        health = json.load(resp)
                        break
                except OSError:
                    time.sleep(1)
            self.assertIsNotNone(health, "worker never answered /health")
            self.assertTrue(health["ok"])
            self.assertEqual(health["runs_dir"], "/data/runs")
            self.assertTrue(health["dry_run"], "no engines in the image -> dry run")
            uid = subprocess.run(["docker", "exec", name, "id", "-u"], capture_output=True, text=True).stdout.strip()
            self.assertNotEqual(uid, "0")
        finally:
            subprocess.run(["docker", "rm", "-f", name], capture_output=True)


if __name__ == "__main__":
    unittest.main()
