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

### Pre-baked, then live-baked

`tools/bake.js` runs every identity through a layered rule system once and writes the results to `js/merges.baked.js`:

1. The two mains form a **reaction** (Scald/Steam, Magma/Obsidian, Wildfire/Firestorm, Mire/Clay, Squall/Thunderhead, Dune/Sandstorm, or a pure Inferno/Deluge/Tectonic/Tempest). Opposites (Fire/Water, Earth/Air) are volatile.
2. Each essence pushes a 10-axis trait vector (force, guard, mend, speed, precision, status, drain, spread, persistence, chaos). Subs on the lead weigh 1.0 and subs on the follow weigh 0.7.
3. Universal subs add their host-specific **facet**.
4. Specific pairs of subs **resonate** (22 resonances, e.g. Spark + Tide = Conduction, Light + Void = Paradox), and some triples form **Trinities** (10, e.g. Phoenix Protocol, Superconductor, Singularity).
5. About 1.8% of identities, picked by hash, are **Anomalies** that break the rules (Mirror, Fork, Rewind, Nullify, and more).
6. The final vector decides class (Strike, Barrage, Siphon, Hex, Ward, Mend, Field), power, hits, accuracy, Flux cost, priority, instability and effects. It also decides a name and flavor text, and a daemon form for the same genome (name, base stats, passive).

Because every outcome comes from a few interacting rules rather than a hand-made table, nearby merges feel related but still surprise you. The whole table is deterministic: `node tools/bake.js --check` fails if the committed file is out of date.

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

## Live baking (FriedrichBridge)

The lattice is baked twice. `tools/bake.js` bakes all 5,896 merges offline, and while you play, [FriedrichBridge](CLAUDE.md) (a local server in front of a local model) **bakes them again, live**. Every design is saved in the bridge's SQLite database, so asking again always returns the same design. Without the bridge, the offline bake fills in.

What gets live-baked:

| Design | Asked for when | What it decides |
|---|---|---|
| **Technique** | you discover a merge (cast, forge, see it cast) | name, text, class, power, hits, Flux, accuracy, instability, effects |
| **Form** | you meet, bind, recompile or boot a daemon | species name and description |
| **Forged item** | you forge | item name, lore and quality (stronger Patches, Modules and Lattices) |
| **Lineage** | you splice two daemons | which of the parents' essences lead the offspring, which sub-essences it inherits, a stat pedigree, the line's name |
| **Trait** | a daemon joins you, and again when it recompiles | one per individual daemon: utilities, passives and actives (below) |

Element typing, base stats and passives stay with the essences.

### Seeds and the %RARITY% modulator

Every request carries a **seed** (fixed for that merge, pair or individual daemon) and a **%RARITY%** roll computed by the game: the share of designs at least this rare, for example `2.7% (epic, about 1 in 37)`. The roll uses the seed plus what the thing is made of. More sub-essences, rarer baked merges, later generations, rarer parents and prismatics all push it rarer. The roll, not the model, decides the tier. The tier sets the scope: how many effects a technique may carry, how strong an item is, how much a lineage passes on, and how many trait effects a daemon gets. The model designs within that budget, and `js/bridge.js` maps its answer onto mechanics with pure, deterministic functions (`abilityFrom`, `offspringFrom`, `traitFrom`).

### Traits: evolving per daemon

Every daemon you own has its own seed and its own trait, designed for that individual:

- **Utilities while in the party:** forage (motes double), tutor (XP), binder (bind odds), smith (free forging), nurture (faster kernels), mender (heals while walking), fortune (prismatic odds), archive (motes from discoveries), lure / shroud (more or fewer encounters)
- **Battle passives:** +% Logic, Firewall, Clock, HP, Flux or Coherence
- **Actives from the Party menu, on a step cooldown:** pulse (heal the party), warp (back to the last terminal), repel (no encounters for a while), hasten (advance kernels), transmute (turn motes into its essence)

Traits evolve. Recompiling asks for a new trait with the old one as its ancestor, and a spliced offspring's trait is designed from both parents' traits.

### Splicing

At the Nexus Forge, the **Splice** tab takes two daemons at level 10 or higher and some motes, and makes a kernel. The kernel compiles while you walk (60 steps) and boots as a new level 5 daemon of the next generation. The same two genomes always splice into the same lineage, which is saved in the database, but every offspring is its own individual with its own trait.

### Discovery toasts

When something rare or statistically unusual turns up, a large discovery toast appears with its rarity color, odds ("1 in 142") and why it stands out. Examples: an epic or legendary roll, the top few percent of the designed techniques you know by value per Flux, your strongest trait, or a trait type you've never had.

### Nothing is lost offline

Anything the database hasn't saved yet waits in an **outbox** kept in the browser across sessions. While the bridge is down, the game checks again every minute and sends the outbox when it's back. Things you do in play jump ahead of bulk jobs like "Design the whole lattice".

```
start_bridge.bat                         (FriedrichBridge on 127.0.0.1:8765, with Ollama running)
set FRIEDRICH_BRIDGE_KEY=<your key>      (or copy bridge.example.json to bridge.local.json)
python tools/serve.py                    -> open http://127.0.0.1:8090
```

`tools/serve.py` serves the game and proxies `/bridge/*` to the bridge, adding the key server side, so the key never reaches the browser or git. **System > FriedrichBridge** shows status, designs and waiting requests by kind, *Sync now*, *Send everything I've met*, the database's newest recipes, and *Forget local designs* (which pulls them back from the database).

## Play

Open `index.html` over HTTP (for example `python3 -m http.server` in this folder). It is a PWA and works offline once loaded.

- **Move:** D-pad or WASD/arrows. **Interact:** A, Enter or Space. **Menu:** ☰ or Esc.
- Flickering tiles are **static**, where wild daemons live. In battle your four memory merges are one tap away (▲ strong / ▼ weak against the foe; keys 1–4 on desktop), and **Bind** shows your capture odds with your best lattice. Tap either card to inspect a daemon. Tap the battle text or press Space to fast-forward.
- Beat the Wardens of the Cirrus Array (Air), Cinder Foundry (Fire), Tidal Archive (Water) and Bedrock Vault (Earth). Each key opens the next gate, and all four open the Core, where the Architect waits.
- The **Codex** tracks discovered merges, **Forms** the genomes you've seen, and the **Lexicon** the reactions, resonances and anomalies you've found.

## Files

| File | What it is |
|---|---|
| `js/essences.js` | Essence data and the merge-key grammar (shared by the game and the baker) |
| `tools/bake.js` | The rule system. Writes `js/merges.baked.js` |
| `js/merges.baked.js` | Generated. All 5,896 outcomes |
| `js/engine.js` | Daemon model and battle engine (no DOM, runs in Node) |
| `js/content.js` | Map, zones, operators, starters |
| `js/sprites.js` | Procedural pixel sprites, a pure function of the genome |
| `js/bridge.js` | Live baking: request mapping, seeds and the %RARITY% modulator, design-to-mechanics mappings (abilities, offspring, traits), priority queue, retries, persistent outbox, local cache |
| `tools/serve.py` | Local server and `/bridge` proxy (keeps the API key server side) |
| `js/reveal.js` | Merge reveals: essences converge and fuse, the %RARITY% dial rolls and the tier stamps in, then the name, powers and stats appear |
| `js/game.js` | Overworld, battle UI, composer, menus, forge, splicing, traits, discovery toasts |
| `tools/verify.js` | CI checks: bake is fresh and complete, records are sane, content keys exist, the map is connected, 300 seeded headless battles finish, every live-bake request id is valid and distinct, lineage and trait designs map to sane mechanics, and the bridge client keeps its outbox against a fake bridge |

No build step and no dependencies. After changing any rule in `essences.js` or `bake.js`, run `node tools/bake.js` and then `node tools/verify.js`.
