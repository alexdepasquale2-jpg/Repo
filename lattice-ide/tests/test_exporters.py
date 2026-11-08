import json, pathlib, struct, sys, tempfile, unittest, zipfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import exporters  # noqa: E402


def make_ply(path, binary=True):
    pts = [(0.0, 0.0, 0.0), (1.0, 2.0, 3.0), (-1.0, 0.5, 4.0)]
    hdr = ("ply\nformat %s 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\n"
           "property float opacity\nend_header\n") % ("binary_little_endian" if binary else "ascii")
    with open(path, "wb") as f:
        f.write(hdr.encode())
        for p in pts:
            f.write(struct.pack("<4f", *p, 1.0) if binary else ("%g %g %g 1\n" % p).encode())


class T(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.run = pathlib.Path(self.tmp.name) / "lj_20260926000000_abcdef"
        self.run.mkdir()
        self.ply = self.run / "scene.ply"; make_ply(self.ply)
        self.glb = self.run / "scene.glb"; self.glb.write_bytes(b"glTF\x02\x00\x00\x00" + b"\x00" * 16)
        (self.run / "NOTICE-HY-World.txt").write_text("Tencent notice")
        self.logs = []

    def tearDown(self):
        self.tmp.cleanup()

    def go(self, target, fmt):
        out = exporters.export(self.run, target, fmt, scene_files=[self.ply, self.glb], log=self.logs.append)
        self.assertEqual(out[-1].name, f"{target}-bundle.zip")
        for p in out:
            self.assertTrue(p.exists(), p)
        names = zipfile.ZipFile(out[-1]).namelist()
        self.assertIn("lattice-export.json", names)
        self.assertIn("NOTICE-HY-World.txt", names)
        m = json.loads((self.run / "export" / target / "lattice-export.json").read_text())
        for k in ("schema", "target", "fmt", "files", "coordinate_conversion", "units", "source_run",
                  "required_plugins", "manual_steps"):
            self.assertIn(k, m)
        self.assertEqual(m["schema"], "lattice.export/1")
        self.assertEqual((m["target"], m["fmt"], m["source_run"]), (target, fmt, self.run.name))
        return out, names, m

    def test_unity_ply(self):
        _, names, m = self.go("unity", "ply")
        base = f"Assets/Lattice/{self.run.name}/"
        self.assertIn(base + "scene.ply", names)
        self.assertIn(base + "Editor/LatticeImporter.cs", names)
        self.assertNotIn(base + "scene.glb", names)
        self.assertEqual(m["files"][0]["ply"]["vertex_count"], 3)
        self.assertEqual(m["files"][0]["ply"]["bounds"]["max"], [1.0, 2.0, 4.0])
        self.assertTrue(any("UnityGaussianSplatting" in p["name"] for p in m["required_plugins"]))

    def test_unity_glb_collider(self):
        out, names, m = self.go("unity", "glb")
        cs = next(p for p in out if p.name == "LatticeImporter.cs").read_text()
        self.assertIn("MeshCollider", cs)
        self.assertIn("-s.x", cs)

    def test_unreal(self):
        out, names, m = self.go("unreal", "glb")
        self.assertIn(f"Content/Lattice/{self.run.name}/import_lattice.py", names)
        self.assertEqual(m["units"], "centimeters")
        py = next(p for p in out if p.name == "import_lattice.py").read_text()
        compile(py, "import_lattice.py", "exec")
        self.assertIn("100", py)

    def test_isaac_glb(self):
        out, names, m = self.go("isaac", "glb")
        self.assertIn("stage.usda", names); self.assertIn("isaac_load.py", names)
        u = (self.run / "export/isaac/stage.usda").read_text()
        self.assertTrue(u.startswith("#usda 1.0"))
        self.assertIn('upAxis = "Z"', u); self.assertIn("metersPerUnit = 1", u)
        self.assertIn("PhysicsScene", u); self.assertIn("PhysicsCollisionAPI", u)
        self.assertIn("scene.glb", u)
        self.assertEqual(u.count("{"), u.count("}"))

    def test_isaac_ply(self):
        _, names, m = self.go("isaac", "ply")
        self.assertIn("scene.ply", names)
        self.assertTrue(m["manual_steps"])

    def test_ascii_ply_and_garbage(self):
        p = self.run / "a.ply"; make_ply(p, binary=False)
        i = exporters.read_ply_info(p)
        self.assertEqual(i["vertex_count"], 3); self.assertEqual(i["bounds"]["min"], [-1.0, 0.0, 0.0])
        g = self.run / "g.ply"; g.write_bytes(b"nope")
        self.assertIsNone(exporters.read_ply_info(g))

    def test_missing_files_ok(self):
        out = exporters.export(self.run, "unreal", "spz", scene_files=[], log=self.logs.append)
        self.assertEqual(out[-1].name, "unreal-bundle.zip")

    def test_bad_args(self):
        with self.assertRaises(ValueError):
            exporters.export(self.run, "godot", "ply", scene_files=[])
        with self.assertRaises(ValueError):
            exporters.export(self.run, "unity", "obj", scene_files=[])
        with self.assertRaises(ValueError):
            exporters.export(self.run, "isaac", "spz", scene_files=[])
        self.assertEqual(set(exporters.SUPPORTED), {"unity", "unreal", "isaac"})


if __name__ == "__main__":
    unittest.main()
