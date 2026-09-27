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
| `data/world.json` | Starters, zones and wild tables, trainers, people (`npcs`), room layouts, game lines |
| `data/overrides.json` | Hand edits of single merges (spell/daemon names, texts, item name/lore, numbers), applied after the rules |

How it flows: `js/schema.js` describes and validates every field. `js/essences.js`, `designs.js`, `engine.js`, `content.js` and `sprites.js` build their tables from the data (`E.data`); each exposes `make()` to build from other data. `js/baker.js` (pure, runs in Node and the browser) turns the data into one record per merge. `tools/bake.js` writes `db/` and `js/data.js` (the browser bundle of `data/`, loaded before `essences.js`).

What is data and what is code: names, texts, numbers, word lists, combos, colors, world layout, and which existing passive mechanic / sprite organ a sub uses are data. New *kinds* of things are code: a new effect, status, anomaly kind, trait type, item kind, class, passive mechanic, sprite organ shape, residue reaction kind, zone (needs map space and a gate), or a fifth main essence.

## Changing content
Three ways, all the same underneath:
- **By hand**: edit `data/*.json`, then `node tools/bake.js` and `node tools/verify.js`.
- **CLI** (validates first, re-bakes, and reports which merges changed): `node tools/content.js` (overview), `list <what>`, `get <path>`, `set <path> <value>`, `add <list> <json>`, `remove <path>`, `merge <key>` (a record and why), `find <text>`, `check`, `preview [changes.json]`, `apply <changes.json>`, `format`. Paths look like `essences.subs[Em].desc`, `world.trainers[air-a].team`, `battle.residue[F>W].name`, `overrides[FW-Em1Li2].name`.
- **The content editor** (`editor/`): `python tools/serve.py`, open `/editor/`. It validates with the same schema and re-bakes in a worker with the same baker; Save writes `data/`, `db/` and `js/data.js` (byte-identical to `tools/bake.js`, which `bake.js --check` confirms).

Rules:
- Never hand-edit `db/` or `js/data.js`; they're generated.
- Keep `data/*.json` in the canonical layout (`node tools/content.js format`); the editor and CLI write it that way and `verify.js` checks it.
- Everything is deterministic: the same data always bakes the same bytes. Word picks are stable (rendezvous hashing, `stablePick`/`stableRank` in `js/designs.js`): every word gets a score from the merge's key and the highest wins, so adding a word only renames the merges that end up with it, plus some neighbors whose name had to be unique (a freed name goes back to the merge that wanted it); removing a word only moves the merges that had it; the order of a list never matters. The CLI and editor show exactly which merges change. Don't go back to `hash % list.length` picks: they rename most of a list's merges on any edit.
- Saves store merge keys, not names, so renames are safe. Removing a sub-essence that already exists would break saves; the editor only lets you remove subs added in the current draft.
- Seeds and the %RARITY% modulator (`modFor` in `designs.js`) keep the bridge-era formulas, so rolls in existing saves are unchanged.

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
- Bump `CACHE` in `sw.js` on every release; it precaches the code, icons, `js/data.js` and all of `db/`. It never intercepts `editor/` or `api/`, and on localhost it fetches fresh files first so edits saved by the editor show up on reload.

## Checks
- `node essence-protocol/tools/bake.js --check`: `db/` and `js/data.js` are fresh (names the stale merges if not)
- `node essence-protocol/tools/content.js check`: `data/` passes the schema, references resolve, the map is reachable
- `node essence-protocol/tools/verify.js`: schema and canonical layout, record sanity, 450 simulated battles, 6000 lineages and 6000 traits, map connectivity, no bridge references
- `python essence-protocol/tools/serve.py [--lan]`: local server on 8090 with the editor at `/editor/` (only this computer can save; `--lan` lets a phone play)
