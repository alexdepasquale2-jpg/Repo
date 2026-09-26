"""Lattice export presets: package a run's scene files for Unity, Unreal or Isaac Sim.

Pure stdlib. export() writes into run_dir/"export"/<target>/ and returns produced files,
with the zip bundle "<target>-bundle.zip" last. See lattice.export/1 manifest.
"""
from __future__ import annotations

import datetime as _dt
import json
import pathlib
import shutil
import struct
import subprocess
import zipfile

__all__ = ["export", "SUPPORTED", "read_ply_info", "SCHEMA"]

SCHEMA = "lattice.export/1"
SUPPORTED: dict[str, list[str]] = {
    "unity": ["ply", "spz", "glb", "usd"],
    "unreal": ["ply", "spz", "glb", "usd"],
    "isaac": ["ply", "glb", "usd"],
}
_MESH = {"glb", "usd"}
_EXTS = {"ply": {".ply"}, "spz": {".spz"}, "glb": {".glb", ".gltf"}, "usd": {".usd", ".usda", ".usdc", ".usdz"}}
SPLAT_UNITY = "https://github.com/aras-p/UnityGaussianSplatting"
SPLAT_UNREAL = "a 3D Gaussian Splatting plugin for Unreal (e.g. XVERSE XV3DGS or Luma AI UE plugin)"


# ---------------------------------------------------------------- PLY reader
_PLY_TYPES = {"char": "b", "int8": "b", "uchar": "B", "uint8": "B", "short": "h", "int16": "h",
              "ushort": "H", "uint16": "H", "int": "i", "int32": "i", "uint": "I", "uint32": "I",
              "float": "f", "float32": "f", "double": "d", "float64": "d"}


def read_ply_info(path: pathlib.Path, max_points: int = 2_000_000) -> dict | None:
    """Best-effort: {'format','vertex_count','properties','bounds':{min,max}|None}. None if unparseable."""
    try:
        with open(path, "rb") as f:
            if f.readline().strip() != b"ply":
                return None
            fmt, elements, cur = None, [], None
            while True:
                line = f.readline()
                if not line:
                    return None
                parts = line.decode("ascii", "replace").split()
                if not parts:
                    continue
                if parts[0] == "format":
                    fmt = parts[1]
                elif parts[0] == "element":
                    cur = {"name": parts[1], "count": int(parts[2]), "props": []}
                    elements.append(cur)
                elif parts[0] == "property" and cur is not None:
                    if parts[1] == "list":
                        cur["props"].append(("list", parts[2], parts[3], parts[4]))
                    else:
                        cur["props"].append((parts[1], parts[2]))
                elif parts[0] == "end_header":
                    break
            vert = next((e for e in elements if e["name"] == "vertex"), None)
            if vert is None or fmt not in ("ascii", "binary_little_endian", "binary_big_endian"):
                return None
            names = [p[-1] for p in vert["props"]]
            info = {"format": fmt, "vertex_count": vert["count"], "properties": names, "bounds": None}
            if not all(n in names for n in "xyz"):
                return info
            idx = [names.index(a) for a in "xyz"]
            lo, hi = [float("inf")] * 3, [float("-inf")] * 3
            n = min(vert["count"], max_points)

            def acc(v):
                for k in range(3):
                    x = v[idx[k]]
                    if x < lo[k]: lo[k] = x
                    if x > hi[k]: hi[k] = x

            # only handle vertex being first element with scalar props (the common splat/pointcloud case)
            if elements[0] is not vert or any(p[0] == "list" for p in vert["props"]):
                return info
            if fmt == "ascii":
                for _ in range(n):
                    acc([float(t) for t in f.readline().split()])
            else:
                end = "<" if fmt == "binary_little_endian" else ">"
                st = struct.Struct(end + "".join(_PLY_TYPES[p[0]] for p in vert["props"]))
                for _ in range(n):
                    buf = f.read(st.size)
                    if len(buf) < st.size:
                        break
                    acc(st.unpack(buf))
            if lo[0] != float("inf"):
                info["bounds"] = {"min": lo, "max": hi, "sampled": n}
            return info
    except Exception:
        return None


# ---------------------------------------------------------------- helpers
def _pick(scene_files, fmt):
    exts = _EXTS[fmt]
    chosen = [pathlib.Path(p) for p in scene_files if pathlib.Path(p).suffix.lower() in exts and pathlib.Path(p).is_file()]
    others = [pathlib.Path(p) for p in scene_files if pathlib.Path(p).is_file() and pathlib.Path(p) not in chosen]
    return chosen, others


def _try_convert(src: pathlib.Path, dst: pathlib.Path, log) -> bool:
    """Optional converters if on PATH; never raises."""
    tools = []
    if src.suffix.lower() == ".glb" and dst.suffix.lower() in (".usd", ".usda", ".usdc"):
        tools.append(["usd_from_gltf", str(src), str(dst)])
    for argv in tools:
        if shutil.which(argv[0]):
            try:
                r = subprocess.run(argv, capture_output=True, text=True, timeout=600)
                if r.returncode == 0 and dst.exists():
                    log(f"export: converted {src.name} -> {dst.name} with {argv[0]}")
                    return True
            except Exception as e:  # noqa: BLE001
                log(f"export: {argv[0]} failed: {e}")
    return False


def _w(path: pathlib.Path, text: str, out: list):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, "utf-8")
    out.append(path)


def _cs(run_id, fmt):
    return f'''// Auto-generated by Lattice. Place under Assets/Editor or keep in Assets/Lattice/{run_id}/Editor.
// Source (HY-World / 3DGS) is Y-up right-handed; Unity is Y-up left-handed -> flip X (scale.x = -1 on the root,
// or mirror at import). Units: meters (1 unit = 1 m).
#if UNITY_EDITOR
using UnityEditor;
using UnityEngine;

public class LatticeImporter : AssetPostprocessor
{{
    const string Root = "Assets/Lattice/{run_id}/";

    void OnPreprocessModel()
    {{
        if (!assetPath.StartsWith(Root)) return;
        var mi = (ModelImporter)assetImporter;
        mi.globalScale = 1f;
        mi.useFileUnits = true;
        mi.bakeAxisConversion = true;
        mi.isReadable = true;
    }}

    void OnPostprocessModel(GameObject go)
    {{
        if (!assetPath.StartsWith(Root)) return;
        var s = go.transform.localScale;
        go.transform.localScale = new Vector3(-s.x, s.y, s.z); // RH -> LH: flip X
        foreach (var mf in go.GetComponentsInChildren<MeshFilter>())
        {{
            if (mf.GetComponent<MeshCollider>() == null)
                mf.gameObject.AddComponent<MeshCollider>().sharedMesh = mf.sharedMesh;
        }}
    }}

    [MenuItem("Lattice/Instantiate {run_id}")]
    static void Instantiate()
    {{
        foreach (var guid in AssetDatabase.FindAssets("t:GameObject", new[] {{ Root.TrimEnd('/') }}))
        {{
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(AssetDatabase.GUIDToAssetPath(guid));
            if (prefab != null) PrefabUtility.InstantiatePrefab(prefab);
        }}
        // Splats (.ply/.spz): need a Gaussian Splatting package, e.g. {SPLAT_UNITY}
        // Use Tools > Gaussian Splats > Create GaussianSplatAsset on the .ply, then add a GaussianSplatRenderer
        // with transform scale (-1,1,1) to apply the same X flip.
        Debug.Log("Lattice: imported {run_id} (format {fmt}).");
    }}
}}
#endif
'''


def _ue_py(run_id, files, fmt):
    return f'''"""Auto-generated by Lattice. Run inside the Unreal Editor (Python Editor Script Plugin enabled):
    py "import_lattice.py"
Converts Y-up right-handed meters (HY-World/3DGS) to Unreal Z-up left-handed centimeters:
    UE(x, y, z) = 100 * (src.z, src.x, src.y)   -> uniform scale x100, rotate Y-up to Z-up.
Splats (.ply/.spz) are not natively supported: install {SPLAT_UNREAL} and import them with it.
"""
import os
import unreal

HERE = os.path.dirname(os.path.abspath(__file__))
DEST = "/Game/Lattice/{run_id}"
FILES = {json.dumps([f.name for f in files])}
SCALE = 100.0  # meters -> centimeters

tasks = []
for name in FILES:
    src = os.path.join(HERE, name)
    if name.lower().endswith((".ply", ".spz")):
        unreal.log_warning("Lattice: %s is a Gaussian splat; import it with your 3DGS plugin." % name)
        continue
    t = unreal.AssetImportTask()
    t.filename = src
    t.destination_path = DEST
    t.automated = True
    t.replace_existing = True
    t.save = True
    tasks.append(t)

if tasks:
    unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks(tasks)

world = unreal.EditorLevelLibrary
for t in tasks:
    for path in t.imported_object_paths:
        asset = unreal.load_asset(path)
        if isinstance(asset, unreal.StaticMesh):
            actor = world.spawn_actor_from_object(asset, unreal.Vector(0, 0, 0), unreal.Rotator(roll=90, pitch=0, yaw=0))
            actor.set_actor_scale3d(unreal.Vector(SCALE, SCALE, SCALE))
            comp = actor.static_mesh_component
            comp.set_collision_enabled(unreal.CollisionEnabled.QUERY_AND_PHYSICS)
unreal.log("Lattice: imported {run_id} ({fmt}) into " + DEST)
'''


def _usda(run_id, mesh_rel: str | None, note: str):
    ref = ""
    if mesh_rel:
        ref = f'''
    def Xform "Scene" (
        prepend payload = @./{mesh_rel}@
    )
    {{
        # Source is Y-up; rotate +90 deg about X to land in Z-up.
        float3 xformOp:rotateXYZ = (90, 0, 0)
        uniform token[] xformOpOrder = ["xformOp:rotateXYZ"]
    }}
'''
    return f'''#usda 1.0
(
    defaultPrim = "World"
    doc = "Lattice export {run_id}. {note}"
    metersPerUnit = 1
    upAxis = "Z"
)

def Xform "World"
{{
    def PhysicsScene "PhysicsScene"
    {{
        vector3f physics:gravityDirection = (0, 0, -1)
        float physics:gravityMagnitude = 9.81
    }}

    def Mesh "GroundPlane" (
        prepend apiSchemas = ["PhysicsCollisionAPI"]
    )
    {{
        int[] faceVertexCounts = [4]
        int[] faceVertexIndices = [0, 1, 2, 3]
        point3f[] points = [(-50, -50, 0), (50, -50, 0), (50, 50, 0), (-50, 50, 0)]
        normal3f[] normals = [(0, 0, 1), (0, 0, 1), (0, 0, 1), (0, 0, 1)] (interpolation = "vertex")
        color3f[] primvars:displayColor = [(0.5, 0.5, 0.5)]
        uniform token subdivisionScheme = "none"
    }}
{ref}}}
'''


def _isaac_py(stage_name):
    return f'''"""Auto-generated by Lattice. Open the exported stage in Isaac Sim:
    ./python.sh isaac_load.py      (from the Isaac Sim install dir)
"""
import os
from isaacsim import SimulationApp  # Isaac Sim 4.x

app = SimulationApp({{"headless": False}})
import omni.usd  # noqa: E402

stage_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "{stage_name}")
omni.usd.get_context().open_stage(stage_path)
while app.is_running():
    app.update()
app.close()
'''


# ---------------------------------------------------------------- main
def export(run_dir: pathlib.Path, target: str, fmt: str, *, scene_files: list[pathlib.Path], log=print) -> list[pathlib.Path]:
    if target not in SUPPORTED:
        raise ValueError(f"unsupported export target {target!r}; expected one of {sorted(SUPPORTED)}")
    if fmt not in SUPPORTED[target]:
        raise ValueError(f"format {fmt!r} not supported for {target}; expected one of {SUPPORTED[target]}")
    run_dir = pathlib.Path(run_dir)
    run_id = run_dir.name
    out_dir = run_dir / "export" / target
    if out_dir.exists():
        shutil.rmtree(out_dir, ignore_errors=True)
    out_dir.mkdir(parents=True, exist_ok=True)
    chosen, others = _pick(scene_files or [], fmt)
    produced: list[pathlib.Path] = []
    manual: list[str] = []
    plugins: list[dict] = []
    splat = fmt in ("ply", "spz")
    if not chosen:
        manual.append(f"No .{fmt} scene file was produced by the run; bundle contains scripts only.")
        log(f"export: no {fmt} files among scene_files")

    if target == "unity":
        base = out_dir / "Assets" / "Lattice" / run_id
        conv = {"from": "Y-up right-handed, meters", "to": "Y-up left-handed, meters", "applied_by": "LatticeImporter.cs",
                "transform": "scale X by -1"}
        units = "meters"
        _w(base / "Editor" / "LatticeImporter.cs", _cs(run_id, fmt), produced)
        if splat:
            plugins.append({"name": "UnityGaussianSplatting", "url": SPLAT_UNITY, "vendored": False})
            manual.append("Install a Gaussian Splatting package (e.g. aras-p/UnityGaussianSplatting), create a "
                          "GaussianSplatAsset from the .ply/.spz, add a renderer with scale (-1,1,1).")
        if fmt == "usd":
            plugins.append({"name": "com.unity.formats.usd", "vendored": False})
        manual.append(f"Copy the Assets/ folder into your Unity project; run menu Lattice > Instantiate {run_id}.")
        dest = base
    elif target == "unreal":
        base = out_dir / "Content" / "Lattice" / run_id
        conv = {"from": "Y-up right-handed, meters", "to": "Z-up left-handed, centimeters",
                "applied_by": "import_lattice.py", "transform": "UE(x,y,z) = 100*(z,x,y); scale x100"}
        units = "centimeters"
        dest = base
        if splat:
            plugins.append({"name": "3D Gaussian Splatting plugin", "hint": SPLAT_UNREAL, "vendored": False})
            manual.append("Install a Gaussian Splatting plugin and import the splat with it (x100 scale, Y-up -> Z-up).")
        if fmt == "usd":
            plugins.append({"name": "USD Importer (built-in)", "vendored": False})
        manual.append("Copy Content/ into your project; in the editor run: py \"Content/Lattice/<run>/import_lattice.py\".")
    else:
        dest = out_dir
        conv = {"from": "Y-up right-handed, meters", "to": "Z-up right-handed, meters (metersPerUnit=1)",
                "applied_by": "stage.usda", "transform": "rotateX +90 on /World/Scene"}
        units = "meters"
        plugins.append({"name": "NVIDIA Isaac Sim 4.x", "vendored": False})

    copied = []
    for src in chosen:
        dst = dest / src.name
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        produced.append(dst)
        copied.append(dst)

    if target == "unreal":
        _w(base / "import_lattice.py", _ue_py(run_id, copied, fmt), produced)

    if target == "isaac":
        mesh_rel = None
        if copied and fmt in _MESH:
            src = copied[0]
            if fmt == "glb":
                usd = out_dir / (src.stem + ".usd")
                if _try_convert(src, usd, log):
                    produced.append(usd)
                    mesh_rel = usd.name
                else:
                    mesh_rel = src.name  # Isaac Sim / Kit can load glTF via its asset converter extension
                    manual.append(f"If the payload to {src.name} doesn't load, convert it with Isaac Sim's "
                                  "Asset Converter (omni.kit.asset_converter) to .usd and update stage.usda.")
            else:
                mesh_rel = src.name
            note = f"Mesh payload: {mesh_rel}."
        elif fmt == "ply":
            note = "Gaussian splat PLY included alongside; not referenced (USD has no standard splat schema)."
            manual.append("Splat .ply is included as-is. Convert to a USD point cloud / mesh (e.g. via a 3DGS->mesh "
                          "tool or Omniverse's NuRec / 3DGUT pipeline) and add it under /World in stage.usda.")
        else:
            note = "No scene payload."
        _w(out_dir / "stage.usda", _usda(run_id, mesh_rel, note), produced)
        _w(out_dir / "isaac_load.py", _isaac_py("stage.usda"), produced)
        manual.append("Open stage.usda in Isaac Sim or run ./python.sh isaac_load.py.")

    notices = []
    for n in sorted(run_dir.glob("NOTICE-*.txt")):
        dst = out_dir / n.name
        shutil.copy2(n, dst)
        produced.append(dst)
        notices.append(n.name)

    file_info = []
    for p in copied:
        entry = {"path": p.relative_to(out_dir).as_posix(), "bytes": p.stat().st_size}
        if p.suffix.lower() == ".ply":
            entry["ply"] = read_ply_info(p)
        file_info.append(entry)

    manifest = {
        "schema": SCHEMA,
        "created": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
        "source_run": run_id,
        "target": target,
        "fmt": fmt,
        "kind": "splat" if splat else "mesh",
        "files": file_info,
        "all_files": [p.relative_to(out_dir).as_posix() for p in produced],
        "ignored_inputs": [p.name for p in others],
        "coordinate_conversion": conv,
        "units": units,
        "required_plugins": plugins,
        "manual_steps": manual,
        "notices": notices,
        "placeholder": any("placeholder" in p.name.lower() for p in chosen),
    }
    mpath = out_dir / "lattice-export.json"
    _w(mpath, json.dumps(manifest, indent=2), produced)

    zpath = out_dir / f"{target}-bundle.zip"
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for p in produced:
            z.write(p, p.relative_to(out_dir).as_posix())
    produced.append(zpath)
    log(f"export: {target}/{fmt} bundle -> {zpath} ({len(produced) - 1} files)")
    return produced
