"""Multi-user workspace: users CLI, role matrix, audit log, /report, backward compatibility.

Run: cd lattice-ide && python3 -m unittest discover -s tests
"""
import contextlib
import csv
import hashlib
import io
import json
import os
import stat
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_worker import Base, W, job  # noqa: E402

WORKER_PY = Path(__file__).resolve().parent.parent / "worker.py"


def cli(*args, env=None):
    """Run the users CLI in-process; returns (exit code, stdout, stderr)."""
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            rc = W.main(["users", *args])
        except SystemExit as e:  # argparse errors
            rc = e.code
    return rc, out.getvalue(), err.getvalue()


def token_from(stdout: str) -> str:
    toks = [ln.strip() for ln in stdout.splitlines() if ln.strip().startswith("lt_")]
    assert len(toks) == 1, stdout
    return toks[0]


class UsersCliTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = Path(self.tmp.name)
        self.file = self.d / "conf" / "users.json"
        self.runs = self.d / "runs"
        self.runs.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def add(self, name, role):
        rc, out, err = cli("add", name, "--role", role, "--file", str(self.file), "--runs", str(self.runs))
        self.assertEqual(rc, 0, err)
        return token_from(out)

    def test_add_stores_hash_only_with_0600(self):
        tok = self.add("alex", "operator")
        raw = self.file.read_text()
        self.assertNotIn(tok, raw)
        doc = json.loads(raw)
        self.assertEqual(len(doc["users"]), 1)
        u = doc["users"][0]
        self.assertEqual((u["name"], u["role"]), ("alex", "operator"))
        self.assertEqual(u["token_sha256"], hashlib.sha256(tok.encode()).hexdigest())
        self.assertFalse(set(u) & {"token", "secret", "password"})
        if os.name == "posix":
            self.assertEqual(stat.S_IMODE(self.file.stat().st_mode), 0o600)
        # no temp files left behind by the atomic write
        self.assertEqual(sorted(p.name for p in self.file.parent.iterdir()), ["users.json"])

    def test_list_remove_duplicates_and_bad_input(self):
        self.add("alex", "admin")
        self.add("bo", "viewer")
        rc, out, _ = cli("list", "--file", str(self.file))
        self.assertEqual(rc, 0)
        self.assertIn("alex\tadmin", out)
        self.assertIn("bo\tviewer", out)
        self.assertNotIn(json.loads(self.file.read_text())["users"][0]["token_sha256"], out)
        self.assertEqual(cli("add", "alex", "--file", str(self.file))[0], 1)
        self.assertEqual(cli("add", "bad name!", "--file", str(self.file))[0], 2)
        self.assertEqual(cli("add", "x", "--role", "root", "--file", str(self.file))[0], 2)
        rc, out, _ = cli("remove", "bo", "--file", str(self.file), "--runs", str(self.runs))
        self.assertEqual(rc, 0)
        self.assertEqual([u["name"] for u in json.loads(self.file.read_text())["users"]], ["alex"])
        self.assertEqual(cli("remove", "bo", "--file", str(self.file))[0], 1)
        self.assertEqual(cli("rotate", "nobody", "--file", str(self.file))[0], 1)

    def test_file_from_env_and_missing(self):
        old = os.environ.pop("LATTICE_USERS", None)
        try:
            self.assertEqual(cli("list")[0], 2)
            os.environ["LATTICE_USERS"] = str(self.file)
            rc, out, _ = cli("add", "env-user", "--role", "viewer", "--runs", str(self.runs))
            self.assertEqual(rc, 0)
            self.assertTrue(self.file.exists())
        finally:
            os.environ.pop("LATTICE_USERS", None)
            if old is not None:
                os.environ["LATTICE_USERS"] = old

    def test_rotate_changes_hash_and_audits_without_tokens(self):
        t1 = self.add("alex", "operator")
        h1 = json.loads(self.file.read_text())["users"][0]["token_sha256"]
        rc, out, _ = cli("rotate", "alex", "--file", str(self.file), "--runs", str(self.runs))
        self.assertEqual(rc, 0)
        t2 = token_from(out)
        self.assertNotEqual(t1, t2)
        u = json.loads(self.file.read_text())["users"][0]
        self.assertNotEqual(u["token_sha256"], h1)
        self.assertEqual(u["token_sha256"], hashlib.sha256(t2.encode()).hexdigest())
        self.assertIn("rotated", u)
        audit = (self.runs / "_audit" / "audit.jsonl").read_text()
        lines = [json.loads(ln) for ln in audit.splitlines()]
        self.assertEqual([(x["action"], x["change"], x["subject"]) for x in lines],
                         [("users.change", "add", "alex"), ("users.change", "rotate", "alex")])
        for t in (t1, t2):
            self.assertNotIn(t, audit)
            self.assertNotIn(hashlib.sha256(t.encode()).hexdigest(), audit)

    def test_cli_via_python_worker_py(self):
        r = subprocess.run([sys.executable, str(WORKER_PY), "users", "add", "sub", "--role", "admin",
                            "--file", str(self.file), "--runs", str(self.runs)],
                           capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        tok = token_from(r.stdout)
        self.assertEqual(json.loads(self.file.read_text())["users"][0]["token_sha256"],
                         hashlib.sha256(tok.encode()).hexdigest())


class UsersBase(Base):
    """A worker with LATTICE_USERS: admin, two operators, a viewer."""

    def setUp(self):
        self.utmp = tempfile.TemporaryDirectory()
        self.ufile = Path(self.utmp.name) / "users.json"
        self.tok = {}
        for name, role in (("root", "admin"), ("op1", "operator"), ("op2", "operator"), ("vic", "viewer")):
            rc, out, err = cli("add", name, "--role", role, "--file", str(self.ufile), "--runs", "/nonexistent-lattice")
            self.assertEqual(rc, 0, err)
            self.tok[name] = token_from(out)
        self.ENV = dict(self.ENV, LATTICE_USERS=str(self.ufile), LATTICE_TOKEN="legacy-token-ignored")
        err = io.StringIO()
        with contextlib.redirect_stderr(err):  # "LATTICE_TOKEN is ignored" warning
            super().setUp()
        self.assertIn("LATTICE_TOKEN is ignored", err.getvalue())

    def tearDown(self):
        super().tearDown()
        self.utmp.cleanup()

    def as_(self, name):
        return {"Authorization": "Bearer " + self.tok[name]}

    def run_job(self, j, headers=None, timeout=15):
        code, res = self.req("POST", "/jobs", j, headers)
        self.assertEqual(code, 201, res)
        end = time.time() + timeout
        while time.time() < end:
            _, st = self.req("GET", "/jobs/" + res["id"], headers=headers)
            if st["status"] in ("done", "failed", "cancelled"):
                return st
            time.sleep(0.05)
        self.fail("job did not finish")

    def audit_text(self):
        p = self.w.runs / "_audit" / "audit.jsonl"
        return p.read_text() if p.exists() else ""


class RoleMatrixTests(UsersBase):
    def test_health_reports_mode_and_identity(self):
        _, h = self.req("GET", "/health")
        self.assertEqual(h["auth_mode"], "users")
        self.assertTrue(h["auth"])
        self.assertNotIn("you", h)
        _, h = self.req("GET", "/health", headers=self.as_("op1"))
        self.assertEqual(h["you"], {"name": "op1", "role": "operator"})
        _, h = self.req("GET", "/health", headers={"Authorization": "Bearer nope"})
        self.assertNotIn("you", h)
        self.assertNotIn(self.tok["op1"], json.dumps(h))

    def test_unauthenticated_and_legacy_token_rejected(self):
        self.assertEqual(self.req("GET", "/jobs")[0], 401)
        self.assertEqual(self.req("GET", "/jobs", headers={"Authorization": "Bearer legacy-token-ignored"})[0], 401)
        self.assertEqual(self.req("POST", "/jobs", job(), {"Authorization": "Bearer wrong"})[0], 401)
        lines = [json.loads(x) for x in self.audit_text().splitlines()]
        fails = [x for x in lines if x["action"] == "auth.fail"]
        self.assertEqual(len(fails), 3)
        self.assertTrue(all(x["user"] is None and x["ip"] == "127.0.0.1" for x in fails))
        self.assertNotIn("wrong", self.audit_text())
        self.assertNotIn("legacy-token-ignored", self.audit_text())

    def test_viewer_reads_but_cannot_post(self):
        code, res = self.req("POST", "/jobs", job(), self.as_("op1"))
        self.assertEqual(code, 201, res)
        jid = res["id"]
        v = self.as_("vic")
        self.assertEqual(self.req("GET", "/jobs", headers=v)[0], 200)
        self.assertEqual(self.req("GET", "/jobs/" + jid, headers=v)[0], 200)
        code, res = self.req("POST", "/jobs", job(), v)
        self.assertEqual(code, 403)
        self.assertIn("viewer", res["error"])
        self.assertEqual(self.req("POST", f"/jobs/{jid}/cancel", headers=v)[0], 403)
        for p in ("/audit", "/audit.csv", "/report"):
            self.assertEqual(self.req("GET", p, headers=v)[0], 403, p)
            self.assertEqual(self.req("GET", p, headers=self.as_("op1"))[0], 403, p)
        # the job keeps running/finishing untouched by the viewer
        self.assertNotEqual(self.w.get(jid)["status"], "cancelled")

    def test_operator_cancels_own_not_others_admin_any(self):
        _, a = self.req("POST", "/jobs", job(), self.as_("op1"))
        _, b = self.req("POST", "/jobs", job(), self.as_("op1"))
        _, c = self.req("POST", "/jobs", job(), self.as_("op2"))
        self.assertEqual(self.w.get(a["id"])["submitted_by"], "op1")
        code, res = self.req("POST", f"/jobs/{a['id']}/cancel", headers=self.as_("op2"))
        self.assertEqual(code, 403)
        self.assertIn("own jobs", res["error"])
        self.assertNotEqual(self.w.get(a["id"])["status"], "cancelled")
        code, st = self.req("POST", f"/jobs/{c['id']}/cancel", headers=self.as_("op2"))
        self.assertEqual((code, st["status"]), (200, "cancelled"))
        code, st = self.req("POST", f"/jobs/{b['id']}/cancel", headers=self.as_("root"))
        self.assertEqual((code, st["status"]), (200, "cancelled"))
        self.assertEqual(self.req("POST", "/jobs/nope_nope/cancel", headers=self.as_("op2"))[0], 404)
        lines = [json.loads(x) for x in self.audit_text().splitlines()]
        cancels = [(x["user"], x["job_id"]) for x in lines if x["action"] == "job.cancel"]
        self.assertEqual(cancels, [("op2", c["id"]), ("root", b["id"])])

    def test_mine_filter(self):
        _, a = self.req("POST", "/jobs", job(), self.as_("op1"))
        _, b = self.req("POST", "/jobs", job(), self.as_("op2"))
        _, r = self.req("GET", "/jobs?mine=1&limit=50", headers=self.as_("op1"))
        self.assertEqual([j["id"] for j in r["jobs"]], [a["id"]])
        _, r = self.req("GET", "/jobs?limit=50", headers=self.as_("op1"))
        self.assertEqual({j["id"] for j in r["jobs"]}, {a["id"], b["id"]})
        self.assertTrue(all("submitted_by" in j for j in r["jobs"]))

    def test_runs_query_token_hash_compared_and_audit_private(self):
        st = self.run_job(job(), headers=self.as_("op1"))
        art = st["artifacts"][0]["url"]
        self.assertEqual(self.req("GET", art)[0], 401)
        self.assertEqual(self.req("GET", art + "?token=" + self.tok["vic"])[0], 200)
        self.assertEqual(self.req("GET", art + "?token=nope")[0], 401)
        # ?token= only works for /runs
        self.assertEqual(self.req("GET", "/jobs?token=" + self.tok["root"])[0], 401)
        self.assertEqual(self.req("GET", "/audit?token=" + self.tok["root"])[0], 401)
        # the audit log is never served as a run file
        self.assertEqual(self.req("GET", "/runs/_audit/audit.jsonl", headers=self.as_("root"))[0], 404)

    def test_rotate_invalidates_old_token_without_restart(self):
        old = self.tok["op1"]
        self.assertEqual(self.req("GET", "/jobs", headers=self.as_("op1"))[0], 200)
        rc, out, _ = cli("rotate", "op1", "--file", str(self.ufile), "--runs", str(self.w.runs))
        self.assertEqual(rc, 0)
        new = token_from(out)
        self.assertEqual(self.req("GET", "/jobs", headers={"Authorization": "Bearer " + old})[0], 401)
        self.assertEqual(self.req("GET", "/jobs", headers={"Authorization": "Bearer " + new})[0], 200)
        rc, _, _ = cli("remove", "vic", "--file", str(self.ufile), "--runs", str(self.w.runs))
        self.assertEqual(self.req("GET", "/jobs", headers=self.as_("vic"))[0], 401)
        _, a = self.req("GET", "/audit", headers=self.as_("root"))
        changes = [(e["subject"], e["change"]) for e in a["entries"] if e["action"] == "users.change"]
        self.assertEqual(changes, [("op1", "rotate"), ("vic", "remove")])


class AuditTests(UsersBase):
    def test_audit_lines_and_no_token_material(self):
        hf = "hf_AuditMustNeverSeeThis12345"
        j = job(**{"engine": "hyworld", "mode": "export", "model": "hy-world-2.0"})
        j["license"].update(acceptedAt="2026-09-26T11:59:00Z", territory="us")
        code, res = self.req("POST", "/jobs", j, dict(self.as_("op1"), **{"X-HF-Token": hf}))
        self.assertEqual(code, 201, res)
        self.req("POST", f"/jobs/{res['id']}/cancel", headers=self.as_("op1"))
        self.req("GET", "/jobs", headers={"Authorization": "Bearer " + self.tok["op1"] + "x"})
        code, a = self.req("GET", "/audit", headers=self.as_("root"))
        self.assertEqual(code, 200)
        by = {e["action"]: e for e in a["entries"]}
        self.assertEqual(by["job.submit"]["user"], "op1")
        self.assertEqual(by["job.submit"]["job_id"], res["id"])
        lic = by["license.accept"]
        self.assertEqual((lic["license_id"], lic["accepted_at"], lic["territory"], lic["job_id"]),
                         ("Tencent-HY-World-2.0", "2026-09-26T11:59:00Z", "US", res["id"]))
        self.assertEqual(by["job.cancel"]["user"], "op1")
        self.assertIsNone(by["auth.fail"]["user"])
        for e in a["entries"]:
            self.assertIn("ts", e)
            self.assertIn("ip", e)
        raw = self.audit_text()
        for secret in list(self.tok.values()) + [hf, "legacy-token-ignored"]:
            self.assertNotIn(secret, raw)
            self.assertNotIn(hashlib.sha256(secret.encode()).hexdigest(), raw)
        if os.name == "posix":
            self.assertEqual(stat.S_IMODE((self.w.runs / "_audit" / "audit.jsonl").stat().st_mode), 0o600)

    def test_audit_limit_and_csv(self):
        for _ in range(3):
            self.req("POST", "/jobs", job(), self.as_("op1"))
        _, a = self.req("GET", "/audit?limit=2", headers=self.as_("root"))
        self.assertEqual(a["count"], 2)
        _, full = self.req("GET", "/audit", headers=self.as_("root"))
        self.assertEqual(a["entries"], full["entries"][-2:])
        r = urllib.request.Request(self.base + "/audit.csv", headers=self.as_("root"))
        with urllib.request.urlopen(r, timeout=10) as resp:
            self.assertTrue(resp.headers["Content-Type"].startswith("text/csv"))
            self.assertIn("lattice-audit.csv", resp.headers["Content-Disposition"])
            text = resp.read().decode()
        rows = list(csv.DictReader(io.StringIO(text)))
        self.assertEqual(len(rows), len(full["entries"]))
        self.assertEqual(list(rows[0].keys()), W.AUDIT_FIELDS)
        self.assertEqual(sum(r["action"] == "job.submit" for r in rows), 3)
        self.assertEqual(W.csv_cell("=HYPERLINK(1)"), "'=HYPERLINK(1)")


class ReportTests(UsersBase):
    ENV = {"LATTICE_GPU_USD_HR": "2"}

    def test_report_totals(self):
        for who in ("op1", "op1", "op2"):
            self.run_job(job(), headers=self.as_(who))
        self.run_job(job(engine="hyworld", mode="pano", model="hy-world-2.0"), headers=self.as_("root"))
        # Pretend one op1 job ran for real (1.5 GPU-hours, $3) and one op2 job failed.
        with self.w.lock:
            jobs = sorted(self.w.jobs.values(), key=lambda j: j.status["created"])
            j1 = next(j for j in jobs if j.status["submitted_by"] == "op1")
            j1.status["metrics"] = dict(j1.status["metrics"], gpu_hours=1.5, cost_usd=3.0)
            j2 = next(j for j in jobs if j.status["submitted_by"] == "op2")
            j2.status["status"] = "failed"
        code, r = self.req("GET", "/report", headers=self.as_("root"))
        self.assertEqual(code, 200, r)
        users = {u["user"]: u for u in r["users"]}
        self.assertEqual(users["op1"]["jobs"], 2)
        self.assertEqual(users["op1"]["gpu_hours"], 1.5)
        self.assertEqual(users["op1"]["cost_usd"], 3.0)
        self.assertEqual(users["op2"]["failures"], 1)
        self.assertIsNone(users["op2"]["cost_usd"])  # dry runs carry no cost
        engines = {e["engine"]: e for e in r["engines"]}
        self.assertEqual(engines["cosmos"]["jobs"], 3)
        self.assertEqual(engines["hyworld"]["jobs"], 1)
        self.assertEqual(r["totals"], {"jobs": 4, "gpu_hours": 1.5, "cost_usd": 3.0, "failures": 1})
        # since filters by job creation time
        _, r = self.req("GET", "/report?since=2999-01-01", headers=self.as_("root"))
        self.assertEqual(r["totals"]["jobs"], 0)
        self.assertEqual(r["since"], "2999-01-01T00:00:00Z")
        _, r = self.req("GET", "/report?since=2000-01-01T00:00:00Z", headers=self.as_("root"))
        self.assertEqual(r["totals"]["jobs"], 4)
        self.assertEqual(self.req("GET", "/report?since=yesterday", headers=self.as_("root"))[0], 400)


class BackwardCompatTests(Base):
    """No LATTICE_USERS: open mode behaves as before; the new endpoints are full-access like everything else."""

    def test_open_mode(self):
        _, h = self.req("GET", "/health")
        self.assertEqual(h["auth_mode"], "open")
        self.assertFalse(h["auth"])
        self.assertNotIn("you", h)
        st = self.run_job(job())
        self.assertIsNone(st["submitted_by"])
        code, st2 = self.req("POST", "/jobs/" + st["id"] + "/cancel")
        self.assertEqual(code, 200)
        _, r = self.req("GET", "/report")
        self.assertEqual(r["users"][0]["user"], None)
        _, a = self.req("GET", "/audit")
        self.assertIn("job.submit", [e["action"] for e in a["entries"]])
        # client-chosen ids can never land in the reserved _audit dir
        code, res = self.req("POST", "/jobs", job(id="_audit"))
        self.assertEqual(code, 201)
        self.assertNotEqual(res["id"], "_audit")


class TokenModeTests(Base):
    ENV = {"LATTICE_TOKEN": "s3cret-shared"}

    def test_token_mode(self):
        _, h = self.req("GET", "/health")
        self.assertEqual((h["auth_mode"], h["auth"]), ("token", True))
        self.assertEqual(self.req("GET", "/jobs")[0], 401)
        auth = {"Authorization": "Bearer s3cret-shared"}
        self.assertEqual(self.req("GET", "/jobs", headers=auth)[0], 200)
        self.assertEqual(self.req("GET", "/audit", headers=auth)[0], 200)
        self.assertNotIn("s3cret-shared", (self.w.runs / "_audit" / "audit.jsonl").read_text())


class MissingUsersFileTests(Base):
    def setUp(self):
        self.ENV = {"LATTICE_USERS": "/nonexistent/lattice-users.json"}
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            super().setUp()
            _, self.h = self.req("GET", "/health")
            self.code = self.req("GET", "/jobs", headers={"Authorization": "Bearer anything"})[0]

    def test_fails_closed(self):
        self.assertEqual(self.h["auth_mode"], "users")
        self.assertEqual(self.code, 401)


if __name__ == "__main__":
    unittest.main()
