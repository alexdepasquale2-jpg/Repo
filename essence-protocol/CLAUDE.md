# CLAUDE.md: Essence Protocol

## What this is
Essence Protocol is a mobile-first web game (vanilla JS PWA, no build step, no dependencies). Everything in it is a **merge** of essences: a lead main (Fire/Water/Earth/Air), a second main, and up to 3 sub-essences bound to either one. That gives 5,896 merge identities. Each identity is both a battle technique and a daemon form (genome), and the Forge turns merges into items.

## Where the content lives
All content is plain JSON in `data/` (the single source of truth). The code only holds rules.

| File | What's in it |
|---|---|
| `data/essences.json` | Mains (colors, type chart `beats`, trait pushes, base stats, passive, name roots/middles, body lines, lineage words, trait leanings), subs (host, effect, adjectives, facets for universal subs, passive with its `mechanic`, name syllables, organ phrase, `sprite` organ shape, color), pair reactions |
| `data/combos.json` | Resonances (2 subs), trinities (3 subs), anomaly kinds (text and magnitude) |
| `data/battle.json` | Classes (description, signature text, icon, spell nouns), effect names, statuses, residue reactions, combo text |
| `data/traits.json` | The 21 trait types (nouns, strength by rarity, epithet, texts, cap, cooldown), leanings by trait axis, lineage nouns and stat words |
| `data/items.json` | Item kinds (name, description, lore template), quality prefixes |
| `data/words.json` | Daemon name endings, temperament sentences, spell-text templates |
| `data/world.json` | The world (format 2): title, start, rules, starters, themes (zone colors), zones (theme, encounter rate, wild tables), maps (a tile grid, a zone grid and the things on them: people, trainers, signs, chests, warps, triggers, blocks), game lines |
| `data/overrides.json` | Hand edits of single merges (spell/daemon names, texts, item name/lore, numbers), applied after the rules |

How it flows: `js/schema.js` describes and validates every field. `js/essences.js`, `designs.js`, `engine.js`, `content.js` and `sprites.js` build their tables from the data (`E.data`); each exposes `make()` to build from other data. `js/baker.js` (pure, runs in Node and the browser) turns the data into one record per merge. `tools/bake.js` writes `db/` and `js/data.js` (the browser bundle of `data/`, loaded before `essences.js`).

What is data and what is code: names, texts, numbers, word lists, combos, colors, the whole world (maps, zones, themes, people, trainers, doors, story flags), and which existing passive mechanic / sprite organ a sub uses are data. New *kinds* of things are code: a new effect, status, anomaly kind, trait type, item kind, class, passive mechanic, sprite organ shape, residue reaction kind, map tile, kind of thing, particle effect, or a fifth main essence.

## Changing content
Three ways, all the same underneath:
- **By hand**: edit `data/*.json`, then `node tools/bake.js` and `node tools/verify.js`.
- **CLI** (validates first, re-bakes, and reports which merges changed): `node tools/content.js` (overview), `list <what>`, `get <path>`, `set <path> <value>`, `add <list> <json>`, `remove <path>`, `merge <key>` (a record and why), `find <text>`, `check`, `preview [changes.json]`, `apply <changes.json>`, `world <file.world.json>` (a world exported from the builder becomes data/world.json), `format`. Paths look like `essences.subs[Em].desc`, `world.maps[lattice].things[air-a].team`, `world.zones[fire].wild`, `battle.residue[F>W].name`, `overrides[FW-Em1Li2].name`.
- **The content editor** (`editor/`): `python tools/serve.py`, open `/editor/`. It validates with the same schema and re-bakes in a worker with the same baker; Save writes `data/`, `db/` and `js/data.js` (byte-identical to `tools/bake.js`, which `bake.js --check` confirms).

Rules:
- Never hand-edit `db/` or `js/data.js`; they're generated.
- Keep `data/*.json` in the canonical layout (`node tools/content.js format`); the editor and CLI write it that way and `verify.js` checks it.
- Everything is deterministic: the same data always bakes the same bytes. Word picks are stable (rendezvous hashing, `stablePick`/`stableRank` in `js/designs.js`): every word gets a score from the merge's key and the highest wins, so adding a word only renames the merges that end up with it, plus some neighbors whose name had to be unique (a freed name goes back to the merge that wanted it); removing a word only moves the merges that had it; the order of a list never matters. The CLI and editor show exactly which merges change. Don't go back to `hash % list.length` picks: they rename most of a list's merges on any edit.
- Saves store merge keys, not names, so renames are safe. Removing a sub-essence that already exists would break saves; the editor only lets you remove subs added in the current draft.
- Seeds and the %RARITY% modulator (`modFor` in `designs.js`) keep the bridge-era formulas, so rolls in existing saves are unchanged.

## Worlds and the world builder (play and create in the game)
- **The format** (`js/schema.js`, `WORLD_SCHEMA`): a map is `tiles` (one letter per tile; the legend is `SC.TILES`: floor, static, path, sand, flowers, bridge, ice, walls, void, fence, boulder, tree, pillar, crystal, lamp, water, magma, console, shelf, the healing terminal, Forge and Rift, and gates `1`-`9` that open with that many keys) plus `zones` (one zone letter per tile, `.` = the map's own zone) and `things` (ids unique in the world). Things: `person` (lines, `after`, `gives` once, `heal`), `trainer` (team, sight, `warden`, `badge` = a key, `final`), `sign`, `chest` (`gives`, opened once), `warp` (`to` {map,x,y,facing}; works when stepped on, even in a wall), `trigger` (invisible, on step), `block` (in the way while its condition holds). Any thing can have `if` (a condition: `flag`, `!flag`, `beat:<trainer>`, `open:<chest>`, `got:<person>`, `keys:<n>`, `won`; all must hold) and `sets` (a flag). Rewards: `{ lattices, cells, motes: {code: n}, item: <merge key, forged>, daemon: {key, level} }`. A world may carry `merges` (its own names and numbers for single merges, laid over the baked records while it is played: `ENGINE.setEdits`).
- **Code**: `js/content.js` builds a world for the game (`CONTENT.make(E)` for data/world.json, `C.withWorld(world)` for any other; lenient, problems in `C.problems`). `js/world-render.js` draws tiles, things, people and particles for the game, the builder and the editor's previews (`WORLD_RENDER.mini` draws a map overview). `js/game.js` plays any world: maps, warps, flags, per-world saves (`ep-save:<id>`, test runs `ep-test:<id>`, the original keeps `essence-protocol-save-v1`). `js/worlds.js` keeps player worlds in localStorage (`ep-worlds-v1`, `ep-world:<id>`), the templates (demo town, empty map, remix) and the Worlds screen, import/export (a `.world.json` file `{ format: 'essence-protocol.world/2', world }` or a compressed `EPW1:` code). `js/build.js` is the builder (tools, inspector, world menu, pickers, playtest); `build.css` styles both.
- **Checks**: `SC.validateWorld(world, data, ctx, C)` = the schema for one world + `checkWorld` (walks from the start through every warp: everything must be reachable, no warp into a wall). `verify.js` checks the official world and every template.
- **Fusion with the editor**: where the editor is served next to the game (tools/serve.py, the desktop and Android apps; not the hosted page), the editor's World section has "Open in the world builder" (hand-off in localStorage `ep-builder-handoff`, the game opens it as world `editor`) and the builder's Save & share sends it back (`ep-editor-world-return`, applied as the editor's draft world). The editor's ▶ Play opens `index.html?draft`: `js/draft.js` swaps in the draft content before the modules load and `db.js` reads the draft's re-baked records from IndexedDB (`ep-play`), on the save slot `ep-save:draft`.
- A world from a player becomes the game's world with `node tools/content.js world <file>`.

## Apps: Android, Windows, Linux, macOS (`platforms/`)
Thin shells around the same web files; see `platforms/README.md`.
- `platforms/desktop/` (Go): embeds the game and editor, serves them on `127.0.0.1:47823` (a fixed port: saves belong to it) and opens a Chromium-based app window with its own profile (default browser as a fallback, stopping via page heartbeats). `--lan` hosts it for other devices, `--no-open` only serves. `build.sh` makes the six binaries.
- `platforms/android/`: one Java activity, a full-screen WebView serving the APK's assets on `https://appassets.androidplatform.net/`, no internet permission. The page gets `window.EPAndroid.share(title, text)` (share sheet; `WORLDS.download` uses it) and Android's back calls `window.epBack()` (in `js/game.js`; the builder's `BUILD.back()`). `build.sh` uses the SDK's aapt2/javac/d8/zipalign/apksigner (no Gradle), signs with `sideload.keystore` (a public sideload key so updates install over older builds; use `ANDROID_KEYSTORE*` for a private one). Keep the activity free of lambdas only if you build with dx; d8 handles either.
- `.github/workflows/essence-apps.yml` builds all of them on pushes that touch the game, checks the Linux build over HTTP and the APK on an emulator (`android/smoke.sh`), and on `main` replaces the release `essence-protocol-latest` (notes: `platforms/RELEASE.md`).
- New shipped files must be copied by both `build.sh` scripts (they copy `index.html style.css build.css manifest.json icon.svg sw.js icons js db` and the editor's files).

## The hosted editor (claude.ai) and applying its draft
The editor is also published as a private claude.ai page ("Essence Protocol Editor", https://claude.ai/artifact/XW2x6j5ZcQptDGRwGSqFLE). There it keeps the user's edits as a draft in the page's store (`db` capability): collection `draft`, one document per change `{ op, path, value, before, label, seq, base }`, and collection `requests`, free-text asks `{ text, at, status, reply }`. When the user says "apply my editor changes":
1. Read both collections with the `ArtifactData` tool (`list` on `draft` and `requests`).
2. Save the draft bodies as a JSON list and run `node tools/content.js apply <file>`. It applies them in `seq` order, reports conflicts (an edit whose `before` no longer matches), validates and re-bakes. Resolve conflicts with the user if there are any.
3. `node tools/verify.js`, then commit and push. Do the requests too when they're clear (they usually need code), or ask.
4. Clear the draft: delete each `draft` document, set `meta/applied` to `{ at, commit, summary }`, and mark handled requests `{ status: 'done', reply }`.
5. Republish so the page has the new content: `python tools/build-host.py <out>`, then publish `<out>/editor/index.html` to the editor's URL with `editor/bake-worker.js`, `js/schema.js`, `js/essences.js`, `js/designs.js`, `js/baker.js`, `icon.svg`, `icons/icon-192.png`, `icons/maskable-512.png` as files (capabilities `db` and `downloads` carry over), and `<out>/game/index.html` with `db/*.json` to the game's URL (https://claude.ai/artifact/6zv411VHRAQS1zpDZyjCMj).

## No AI integrations
FriedrichBridge (a local server that asked Ollama/FriedrichAI to design spells, forms, items, lineages and traits) is **retired**, along with its client, its proxy in `tools/serve.py` and `bridge.example.json`. The game sends nothing anywhere while you play (the only outside request is the optional display font). Do not add model calls back; everything is pre-baked or designed by pure functions. `tools/verify.js` fails if any shipped file references `/bridge`. Old saves are migrated on load (`migrate()` in `js/game.js`).

## The merge database (`db/`)
One record per merge, one line per record, in `db/<pair>.json` (16 shards, one per ordered pair of mains). `db/index.json` holds the schema, the record layout (`fields`), rarity counts and shard hashes.

| Part of a record | Fields |
|---|---|
| Technique | `name cls power acc flux prio hits instab fx rarity tags text anomaly` |
| Daemon form | `dName dStats dPassive dDesc` |
| Forged item | `item` = `[kind, name, lore, tier, pct]` |
| Splice word | `line` |
| Trait affinity | `aff` = `[[trait code, weight], ...]` |

Designs that can't be enumerated are pure functions in `js/designs.js`: `lineage(pair, rec)` for a splice of two genomes and `trait(genome, seed, info, rec)` for one daemon. In the browser `js/db.js` loads the shards while the title screen is up; `ENGINE.rec()` is synchronous after that.

## Mobile
- The overworld renders at 1 canvas px per CSS px, light glows are cached sprites and the vignette is a CSS layer. Keep per-frame work allocation-free.
- Touch rules: tooltips open on a real hover only (pointer events); on touch, holding still peeks at a tooltip and lifting hides it without pressing. The long-press menu, selection and dragging are cancelled outside text fields; the D-pad, A button and map swallow `touchstart`. Don't add vibration to held controls.
- Toasts go through `toast()` / `showToast()`: at most three, a repeat replaces itself, a tap dismisses, an expiry sweep removes stuck ones.
- Bump `CACHE` in `sw.js` on every release; it precaches the code (add new files to `ASSETS`), icons, `js/data.js` and all of `db/`. It never intercepts `editor/` or `api/`, and on localhost it fetches fresh files first so edits saved by the editor show up on reload.
- The builder shares the game's canvas and renderer; its panels are a bottom sheet on phones and a side panel from 900px. Every control is at least 40px tall.

## Checks
- `node essence-protocol/tools/bake.js --check`: `db/` and `js/data.js` are fresh (names the stale merges if not)
- `node essence-protocol/tools/content.js check`: `data/` passes the schema, references resolve, the map is reachable
- `node essence-protocol/tools/verify.js`: schema and canonical layout, record sanity, 450 simulated battles, 6000 lineages and 6000 traits, the world (reachability through warps, keys for the gates, one final boss), the builder's world templates, no bridge references
- `python essence-protocol/tools/serve.py [--lan]`: local server on 8090 with the editor at `/editor/` (only this computer can save; `--lan` lets a phone play)
