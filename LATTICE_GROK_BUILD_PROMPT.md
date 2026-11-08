# Lattice — final-build prompt

Learned from v0: two engines, phone as composer not runtime, license as a feature, Bridge as the actual product.

---

**Paste this into a new Grok turn:**

You are Grok. Build the **final production version of Lattice**, a mobile-first world-model IDE.

v0 already exists in `lattice-ide/` (PWA + stub worker). Keep what worked. Do not clone its limits.

**Keep**
- Two engines: Cosmos 3 (OpenMDW 1.1) = physics + action. HY-World 2.0 = persistent place (pano → WorldNav → WorldStereo → 3DGS/mesh).
- **Bridge** stitches them: Cosmos rollout → keyframes → HY freeze.
- Phone composes jobs. Weights stay on Jetson / RTX / datacenter.
- Live Python/CLI from the form.
- License is UI: OpenMDW commercial OK, notices required, no competing public model API, outputs free. HY-World stays on Tencent `License.txt`. Lattice UI is MIT.

**Fix**
- POST jobs to the worker; poll status; store `./runs/<id>/job.json`.
- Phone camera / photo / video ingest (`capture="environment"`).
- Job schema `lattice.job/1` (engine, mode, model, inputs, outputs, license, code).
- Worker dry-runs if the pipeline isn't installed (`LATTICE_DRY_RUN=1`).
- Copy-code, export `lattice-jobs.json`, never log HF tokens.
- Cheap artifact preview if a splat/video URL exists.
- 480px dark PWA, safe-area, 44px targets, IBM Plex.

**Tabs:** Home (health + last 8 jobs) · Cosmos (Reason / Generate / Action / Edge: Edge 4B, Nano 16B, Super 64B, I2V, DROID policies) · HY-World (Pano / WorldMirror / Stereo / Export Unity-Unreal-Isaac) · Bridge · More (jobs, license gate, snippets, settings).

**Ship:** `index.html` `styles.css` `app.js` `sw.js` `manifest.json` `icon.svg` `worker.py` `README.md` `LICENSE`.

Non-goals: no weights in the PWA, no fake on-device Super, no relicensing Hunyuan.

Build the files. Then stop.

---

v0 taught one rule for the final: Lattice is a **control surface**. Cosmos invents motion. HY-World freezes a room. The phone should never pretend it is the GPU.
