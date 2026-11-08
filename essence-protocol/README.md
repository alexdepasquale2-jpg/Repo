# Essence Protocol

A turn-based creature RPG in the Pokémon mould. The creatures are **daemons**, artificial minds that shape essences, and everything in the world is a **merge** of those essences: every attack, every daemon species, every item.

## The merge system

Every merge identity has:

| Part | Rule |
|---|---|
| **Main essence** (lead) | One of Fire, Water, Earth or Air. It carries 65% of the merge's weight and typing. |
| **Second main essence** (follow) | Also one of the four. It can be the same as the lead, which makes a *pure* merge. |
| **Sub-essences** | Up to **3** per merge, each bound to either the lead or the follow. |

There are 16 sub-essences:

- **Essence-specific** (bind only to their own main): Fire has Ember, Plasma and Ash. Water has Tide, Frost and Mist. Earth has Stone, Metal and Root. Air has Spark, Gale and Echo.
- **Universal** (bind to either main): Light, Void, Signal and Time. Each takes on a different *facet* depending on its host. Light on Fire turns Radiant (blinds), on Water Prismatic (heals), on Earth Crystal (shields), on Air Auroral (focus).

That grammar gives **5,896** distinct merge identities: 12 cross pairs × 470 sub layouts, plus 4 pure pairs × 64. `FW-Em1Li2` means Fire leads, Water follows, Ember is bound to the Fire lead and Light to the Water follow.

### Pre-baked into the merge database

`tools/bake.js` runs every identity through a layered rule system (`js/baker.js`, fed by the content in `data/`) and writes it, one merge at a time, as one record in the merge database (`db/`, one shard per pair of mains):

1. The two mains form a **reaction** (Scald/Steam, Magma/Obsidian, Wildfire/Firestorm, Mire/Clay, Squall/Thunderhead, Dune/Sandstorm, or a pure Inferno/Deluge/Tectonic/Tempest). Opposites (Fire/Water, Earth/Air) are volatile.
2. Each essence pushes a 10-axis trait vector (force, guard, mend, speed, precision, status, drain, spread, persistence, chaos). Subs on the lead weigh 1.0 and subs on the follow weigh 0.7.
3. Universal subs add their host-specific **facet**.
4. Specific pairs of subs **resonate** (22 resonances, e.g. Spark + Tide = Conduction, Light + Void = Paradox), and some triples form **Trinities** (10, e.g. Phoenix Protocol, Superconductor, Singularity).
5. About 1.8% of identities, picked by hash, are **Anomalies** that break the rules (Mirror, Fork, Rewind, Nullify, and more).
6. The final vector decides class (Strike, Barrage, Siphon, Hex, Ward, Mend, Field), power, hits, accuracy, Flux cost, priority, instability and effects. It also decides a name and flavor text, a daemon form for the same genome (name, description, base stats, passive), the item it forges into (name, lore and a quality roll), the word it lends to splice lineages, and the traits it leans toward.

Because every outcome comes from a few interacting rules rather than a hand-made table, nearby merges feel related but still surprise you. The whole database is deterministic: `node tools/bake.js --check` fails, and names the merges, if the committed database is out of date.

### Everything is a merge

- **Attacks.** In battle you pick a merge from memory or **compose** one live from your daemon's mains and attuned subs. An unknown merge shows only its reaction and cost until you cast it, and then it goes into the Codex.
- **Daemons.** Every identity is also a genome. A daemon with no subs is Seed-tier. At levels 12, 22 and 32 it can **recompile**, binding one attuned sub into its genome to become a new form. That gives branching evolution up to Prime tier (3 subs).
- **Items.** Defeated daemons drop **motes** of their essences. The Nexus Forge merges motes, and the merge's class decides the item: Mend makes a Patch, Ward a Module, Hex a Lattice (for binding daemons), Field a Catalyst, other merges with subs an Attune Script, and plain merges a Flux Cell.

### Real-time combat

Battles run live on a clock instead of taking turns, and every ability is color-coded by kind:

| Kind | Color | How it works |
|---|---|---|
| **Attack** | red | Strike, Barrage and Siphon merges. Tap one to queue it and it fires every time your **global cooldown** (GCD) finishes, until you queue something else. The GCD is shorter with more Clock, longer for heavy (high-Flux) merges, and shifted by priority. |
| **Active** | violet | Hex, Ward, Mend and Field merges. They fire instantly, off the GCD, then go on their own cooldown (5s + 0.7s per Flux). |
| **Passive** | gold | Always on. One per daemon, from its genome. |
| **Utility** | cyan | Rest (14s cooldown, big Flux refill), Swap (uses the GCD, 4s cooldown), Items (6s shared cooldown), Bind, Run, Pause. |

The battle HUD is an action bar. A cast bar shows your global cooldown, and a hotbar holds your four memory slots (red square tiles are attacks, violet round tiles are actives, with cooldown sweeps and key numbers 1–4). A gold passive diamond sits beside it, and a cyan utility row sits below. Buff and debuff icons with live timers sit under each card. **Auto** (or the A key) hands your daemon to the same AI the foes use; tapping any tile takes control back.

Flux regenerates continuously, and statuses, regen, echoes and delayed hits tick every 2 seconds. The foe's card has a wind-up bar that shows when it will act next. Opening Compose, Items, Swap or Info pauses the fight. Keys: 1–4 use memory slots, Space pauses, R rests.

### Signature mechanics

On top of its baked stats, every ability class has a signature mechanic. These are tuned to feel big rather than perfectly balanced:

| Class | Signature |
|---|---|
| Strike | **Stagger** pushes the foe's next action back (twice as far on a crit), and Strike crits hit ×2 |
| Barrage | Each hit adds **Charge**; at 6, your next attack is an **OVERDRIVE** (×1.8, guaranteed crit) |
| Siphon | **Theft** steals Flux on top of its drain |
| Hex | **Curse** slows the foe (Clock −1, next action delayed), doubles status chances and extends them |
| Ward | **Riposte** reflects 35% of what the shield absorbs, then bursts on the attacker when it breaks |
| Mend | **Reboot** purges statuses and stat drops, grants haste and trims your cooldown |
| Field | **Domain** damages the foe every pulse; your merges of that element cost 40% less Flux |

Every third cast of the same attack in a row is a **COMBO** (×1.6). Each trigger shows a big callout in the arena. Battles run at about 60% speed at level 5 and ramp up to full speed by level 30.

### Battle depth

- Type cycle: Water > Fire > Air > Earth > Water. It's weighted 65/35 on both the merge and the defender, so multipliers are graded rather than binary.
- **Flux**, an energy resource, regenerates each turn. *Defrag* skips a turn to recover a lot of it.
- **Residue**: every merge charges the arena with its essences. A merge cast into 2+ residue of another essence triggers a field reaction (Steam Burst, Quench, Mudslide, Dust Devil, Flare-up...). Field merges saturate the arena for 5 turns.
- **Instability**: complex or volatile merges can backfire, or *mutate* into a neighboring merge, which discovers it for you. High Coherence and the Time passive keep them stable.
- Statuses (Burn, Frozen, Static, Rooted, Corrupted, Dormant, Petrify, Soak), stat stages, shields, regen, echoes, delayed hits and element immunities (Earth can't get Static, Air can't be Rooted...).
- 20 passives, one per main and one per sub, taken from the genome's lead sub.

## Beyond the story

- **Archive Requests:** three rotating goals at a time (discover merges of a pair, bind an element, trigger reactions, forge items...). Each pays out right away and is replaced. Every 50 merges discovered is a Codex milestone with its own reward.
- **XP share:** daemons that sit out a battle still earn half XP, as long as they're standing.
- **Rogue and Prismatic daemons:** 7% of wild encounters are Rogue builds with an extra sub-essence. About 1 in 64 is Prismatic, with a hue-shifted sprite and +10% stats.
- **Post-game:** Wardens and the Architect offer rematches with recompiled, higher-level teams. **The Rift**, a terminal in the Core, is an endless descent through random genomes from the whole table. Floors get harder, every fifth floor has a guardian, and you can leave with your rewards after any floor.

## Designs without AI

Earlier versions asked a local AI model (FriedrichBridge) to design techniques, forms, items, lineages and traits while you played. That integration is retired: the game sends nothing anywhere (the only request is the optional display font), runs fully offline, and needs no server beyond static files. Per-merge designs are pre-baked in `db/`; the rest are pure functions in `js/designs.js`:

| Design | Where it comes from |
|---|---|
| **Technique, form, forged item** | The merge's record in the database |
| **Lineage** (splice two daemons) | The two parents' records: the dominant main leads, sub-essences carry on, the parents' strongest stats become a pedigree, and their line words name it |
| **Trait** (one per daemon) | The genome's trait affinity, shuffled by the daemon's seed, evolving from its ancestors' traits |

### Seeds and the %RARITY% modulator

Every item, lineage and trait carries a **rarity roll** from its seed and makeup: the share of designs at least this rare, for example `2.7% (epic, about 1 in 37)`. The roll sets the tier (common to legendary) and the scope: how strong an item is, how much a lineage passes on, and how many trait effects a daemon gets. Techniques use their structural rarity (Base, Compound, Resonant, Trinity, Anomaly), shown with how rare that is across the lattice.

### Traits: evolving per daemon

Every daemon you own has its own seed and its own trait:

- **Utilities while in the party:** forage (motes double), tutor (XP), binder (bind odds), smith (free forging), nurture (faster kernels), mender (heals while walking), fortune (prismatic odds), archive (motes from discoveries), lure / shroud (more or fewer encounters)
- **Battle passives:** +% Logic, Firewall, Clock, HP, Flux or Coherence
- **Actives from the Party menu, on a step cooldown:** pulse (heal the party), warp (back to the last terminal), repel (no encounters for a while), hasten (advance kernels), transmute (turn motes into its essence)

Recompiling redesigns the trait for the new genome with the old one as its ancestor, and a spliced offspring's trait evolves from both parents' traits.

### Splicing

At the Nexus Forge, the **Splice** tab takes two daemons at level 10 or higher and some motes, and makes a kernel. The kernel compiles while you walk (60 steps) and boots as a new level 5 daemon of the next generation. The same two genomes always splice into the same lineage, but every offspring is its own individual with its own trait.

### Discovery toasts and reveals

Rare or statistically unusual finds (epic or legendary rolls, Trinity and Anomaly merges, the top few percent of what you know) get a large discovery toast, or outside battle a full-screen reveal: the essences converge and fuse, the rarity dial rolls, and the design's powers appear.

## Mobile

Built for phones first: the title shows instantly while the database streams in, the overworld renders pixel art at one canvas pixel per CSS pixel (a steady 60 fps on a throttled mid-range phone, up from about 28), the D-pad follows your thumb as it slides, the game saves and pauses whenever you switch apps, hits vibrate (toggle in System), and landscape phones get a side-by-side battle layout. Install it to the home screen for offline play.

## Play

**Apps:** the release `essence-protocol-latest` on GitHub has the game as an Android app (`EssenceProtocol.apk`), a Windows program (`EssenceProtocol-windows-x64.exe`), and Linux and macOS programs; each one is the whole game, builder and editor in one file, offline. The Linux one doubles as a home server (`--lan`). How to install each: `platforms/RELEASE.md`; how they're built: `platforms/README.md`.

Or open `index.html` over HTTP: `python tools/serve.py` (add `--lan` to open it from a phone on the same Wi-Fi), or any static server. It is a PWA and works offline once loaded.

- **Move:** D-pad or WASD/arrows. **Interact:** A, Enter or Space. **Menu:** ☰ or Esc.
- Flickering tiles are **static**, where wild daemons live. In battle your four memory merges are one tap away (▲ strong / ▼ weak against the foe; keys 1–4 on desktop), and **Bind** shows your capture odds with your best lattice. Tap either card to inspect a daemon. Tap the battle text or press Space to fast-forward.
- Beat the Wardens of the Cirrus Array (Air), Cinder Foundry (Fire), Tidal Archive (Water) and Bedrock Vault (Earth). Each key opens the next gate, and all four open the Core, where the Architect waits.
- The **Codex** tracks discovered merges, **Forms** the genomes you've seen, and the **Lexicon** the reactions, resonances and anomalies you've found.

## Create: make your own game inside the game

Tap **✦ Create** on the title screen. The Worlds screen lists the original and every world you made; start a new one from the **Brightwater demo** (a town, a route with an ice slide, a Warden's lab and a shrine, built to be taken apart), an **empty map**, or a **remix of the original**, or import one someone shared.

The **world builder** runs on the game's own canvas with the game's own renderer, so what you paint is what you play:

- **Tools:** Move, Paint (1×1 to 3×3), Rect, Room (walls with floor inside), Fill, Pick, and Things. Pinch or scroll to zoom, two fingers to pan, and undo everything.
- **Tiles:** floor, static (wild daemons), path, sand, flowers, bridges, ice you slide across, walls, void, fences, boulders, trees, pillars, crystals, lamps, water, magma, consoles, archive shelves, the healing terminal, the Forge, the Rift, and gates that open with 1 to 9 keys.
- **Zones:** paint regions on the Zones layer; each has a name, a color theme, an encounter rate and its wild daemons (any of the 5,896 genomes, with level ranges and weights).
- **Things:** people (lines, a gift once, healing), trainers (teams from the genome picker, line of sight, Wardens who give keys, a final boss who ends the game), signs, chests (lattices, flux cells, motes, a forged item or a daemon), warps (doors, stairs, portals, pads, hidden map edges; "Way back" adds the return trip), triggers (little cutscenes when you step somewhere) and blocks. Any of them can appear or vanish with the story: "only while" conditions on flags, beaten trainers, opened chests, gifts, keys or the ending.
- **The world menu:** maps (new, resize, duplicate), zones, color themes with live preview, starters, the story (title, start point, tutorial and ending lines, how main essences unlock), your own names for any merge, a problems list that finds anything unreachable, and sharing.
- **▶ Play** tests from the middle of the screen or from the start, or plays for real on its own save; **✎** in the game jumps back to the builder on the same spot. Worlds save in the browser after every change; share one as a file or a short world code, and Claude Code can make it the game's world (`node tools/content.js world <file>`).

## Editing the content

Every name, number and line in the game is plain JSON in `data/`: essences, combos, battle text, traits, items, word lists, the world, and hand edits of single merges. Three ways to change it, all checked by the same schema (`js/schema.js`) and baked by the same code:

- **The content editor.** Run `python tools/serve.py` and open `http://127.0.0.1:8090/editor/`. It's a dashboard for everything: all 5,896 spells, daemons and items with why each came out the way it did, essences (including new sub-essences), combos, battle names, traits, every word list with how busy it is, and the world as forms (maps, zones, themes, trainers, people and things, starters, story), with **Open in the world builder** to paint it in the game. Every edit is validated and re-baked live, so the Changes page shows exactly which merges it changes before you save. Word picks are stable: adding a word to a list only renames the merges that end up with it (plus a few neighbors whose names have to stay unique), and reordering a list renames nothing. Save writes `data/`, `db/` and `js/data.js`; reload the game to play it, or press **▶ Play** to play the unsaved draft right away (the game re-bakes nothing: it uses the editor's records). It works on a phone too.
- **Hosted on claude.ai.** A private copy of the editor keeps your edits as a draft in the page, on any device. Tell Claude Code "apply my Essence Protocol editor changes" and it applies them, re-bakes, checks and pushes. Requests for things that need new code (a new effect, zone or mechanic) go along with them.
- **The command line** (for Claude Code and scripts): `node tools/content.js` with `list`, `get`, `set`, `add`, `remove`, `merge <key>`, `find`, `check`, `preview` and `apply <changes.json>`. Every write validates first, re-bakes and lists the merges it changed.

## Files

| File | What it is |
|---|---|
| `data/*.json` | The content: essences, combos, battle, traits, items, words, world, overrides |
| `js/schema.js` | What every content field is (labels, help, rules), validation, change sets, the canonical JSON layout |
| `js/essences.js` | Essence tables (from `data/`) and the merge-key grammar |
| `js/baker.js` | The rule system: bakes every merge, one at a time (pure; Node and browser) |
| `tools/bake.js` | Writes `db/` and `js/data.js` from `data/`; `--check` names stale merges |
| `js/data.js` | Generated. `data/` bundled for the browser |
| `db/` | Generated. The merge database: `index.json` and 16 shards holding all 5,896 records |
| `js/db.js` | Loads the database (in the background in the browser, from disk in Node) |
| `js/designs.js` | Seeds, the %RARITY% modulator, lineages and traits (pure functions) |
| `js/engine.js` | Daemon model and battle engine (no DOM, runs in Node) |
| `js/content.js` | A world for the game: maps, zones, themes, things and starters (from `data/world.json`, or any player's world) |
| `js/world-render.js` | The overworld's pixel art: tiles, things, people, particles, map overviews (game, builder and editor) |
| `js/worlds.js` | Player worlds in the browser, templates, import and export, the Worlds screen |
| `js/build.js`, `build.css` | The world builder |
| `js/draft.js` | Plays the content editor's unsaved draft |
| `js/sprites.js` | Procedural pixel sprites, a pure function of the genome |
| `js/reveal.js` | Reveals: essences converge and fuse, the rarity dial rolls and the tier stamps in, then the name, powers and stats appear |
| `js/game.js` | Overworld, battle UI, composer, menus, forge, splicing, traits, discovery toasts |
| `tools/verify.js` | CI checks: the database is fresh and complete, records are sane, content keys exist, the world is connected through its warps, the builder's templates are valid, 450 headless battles finish, 6000 lineages and traits are deterministic and sane, and nothing references the retired bridge |
| `tools/serve.py` | Local server (`--lan` for phones), with the content editor's save API |
| `tools/content.js` | Read and change the content from the command line |
| `editor/` | The content editor |
| `tools/build-host.py` | Builds the claude.ai copies of the game and the editor |
| `platforms/` | The Android app and the Windows, Linux and macOS programs (see `platforms/README.md`) |

No build step and no dependencies. After changing `data/` by hand, or a rule in `js/baker.js` or `js/designs.js`, run `node tools/bake.js` and then `node tools/verify.js`.
