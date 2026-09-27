# CLAUDE.md: Essence Protocol

## What this is
Essence Protocol is a mobile-first web game (vanilla JS PWA, no build step, no dependencies). Everything in it is a **merge** of essences: a lead main (Fire/Water/Earth/Air), a second main, and up to 3 sub-essences bound to either one. That gives 5,896 merge identities. Each identity is both a battle technique and a daemon form (genome), and the Forge turns merges into items.

## No AI integrations
FriedrichBridge (a local server that asked Ollama/FriedrichAI to design spells, forms, items, lineages and traits) is **retired**, along with its client (`js/bridge.js`), its proxy in `tools/serve.py` and `bridge.example.json`. The game sends nothing anywhere while you play (the only outside request is the optional display font). Do not add model calls back; everything is pre-baked or designed by pure functions. `tools/verify.js` fails if any shipped file references `/bridge`.

Old saves are migrated on load (`migrate()` in `js/game.js`): traits and lineages that were waiting for the bridge are designed, forged items take their pre-baked design, and the bridge's `localStorage` keys (`ep-bridge-cache-v1`, `ep-bridge-outbox-v1`, `ep-bridge-conf`) are deleted.

## The merge database (`db/`)
`tools/bake.js` pre-bakes every merge identity **one merge at a time** into one record, one line, in `db/<pair>.json` (16 shards, one per ordered pair of mains, e.g. `db/FW.json` = Fire-led, Water-following). `db/index.json` holds the schema, the record layout (`fields`), rarity counts and shard hashes.

| Part of a record | Fields |
|---|---|
| Technique | `name cls power acc flux prio hits instab fx rarity tags text anomaly` |
| Daemon form | `dName dStats dPassive dDesc` |
| Forged item | `item` = `[kind, name, lore, tier, pct]` (quality roll from the %RARITY% modulator) |
| Splice word | `line` (the word the genome lends to lineage names) |
| Trait affinity | `aff` = `[[trait code, weight], ...]` (the traits this genome leans toward) |

Designs that can't be enumerated are pure functions in `js/designs.js` of the records they're made of:
- `lineage(pair, rec)`: a splice of two genomes (17M pairs). Dominant main leads, parents' subs carry on, the parents' strongest base stats become the pedigree.
- `trait(genome, seed, info, rec)`: one individual daemon (a 32-bit seed). Codes come from the genome's `aff`, shuffled by the seed, with ancestors' codes carried on.
- Seeds and the %RARITY% modulator (`modFor`) keep the bridge-era formulas, so rolls in existing saves are unchanged.

Rules:
- Never invent spells, names or recipes in game code. Change `essences.js` / `bake.js` / `designs.js`, run `node tools/bake.js`, then `node tools/verify.js`.
- Everything is deterministic: the same merge, pair or seed always gives the same design.
- In the browser `js/db.js` loads the shards in the background while the title screen is up; `ENGINE.rec()` is synchronous after that. In Node, requiring `js/db.js` reads `db/` from disk.

## Mobile
- The overworld renders at 1 canvas px per CSS px (pixel art scaled with `image-rendering: pixelated`), light glows are cached sprites and the vignette is a CSS layer. Keep per-frame work allocation-free.
- The D-pad is one pointer surface (sliding between directions works). The game saves and pauses on `visibilitychange`/`pagehide`, unlocks audio on the first touch, and vibrates on hits (setting in System).
- Landscape phones get a side-by-side battle layout. Inputs are 16px and selectable (no iOS zoom). PNG icons live in `icons/`.
- Bump `CACHE` in `sw.js` on every release; it precaches the code, icons and all of `db/`.

## Checks
- `node essence-protocol/tools/bake.js --check`: the database is fresh (names the stale merges if not)
- `node essence-protocol/tools/verify.js`: record sanity, completeness, 450 simulated battles, 6000 lineages and 6000 traits, map connectivity, and no bridge references. Both ignore CRLF line endings.
- `python essence-protocol/tools/serve.py [--lan]`: local server on 8090 (with `--lan`, a phone on the same Wi-Fi can connect).
