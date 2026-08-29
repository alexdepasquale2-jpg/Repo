# Module Contract — Cul-de-Sac-a-Doo

All parallel work builds against this contract. Do not change it unilaterally.

## Conventions

- **ES modules.** Every file uses `export class X` / `import { X } from '...'`. Entry point is
  `src/main.js`, loaded via `<script type="module" src="src/main.js"></script>`.
- **No build step.** Plain browser-native ESM. Relative import paths with explicit `.js` extension.
- **No numeric UI.** No module may render a number to the screen. Internally numbers are fine;
  they must never reach the DOM or canvas as text.
- **Deterministic RNG.** Use `rng(seed)` from `src/systems/rng.js` (Agent A owns this file) rather
  than `Math.random()` anywhere gameplay-affecting, so runs are reproducible for testing.
- **Units.** Positions in world pixels. `deltaTime` in **seconds** (fractional), not ms.

## Canonical viewport

Portrait, 375 x 812 logical pixels. Canvas is scaled to fit; all layout math uses logical units.

## The seven neighbors

Fixed IDs. Every system keys off these exact strings.

| id | name | combat wave identity | vendor role | rumor relay role |
|----|------|---------------------|-------------|------------------|
| `sheila` | Sheila Vance | Lawn Gnome Swarm | HOA Shop (Trust-priced) | Gossip Hub (corrupts) |
| `colonel` | The Colonel | Chicken flock | Barter crate (loot-for-relics) | Skeptic (slows spread) |
| `frog` | Debt Frog | Boss | Under-the-table stall (silent Debt) | Origin (never relays) |
| `marge` | Marge Tillery | Sprinkler Wraith | none | Fast relay |
| `dwayne` | Dwayne Boggs | Sprinkler Wraith | none | Fast relay |
| `newlyweds` | The Prices | Newlywed Elite | none | Mirror (echoes back) |
| `previous` | The Previous Owner | absent / haunting | none | Terminal (absorbs, never forwards) |

## Shared types

```js
// Vector-ish. Plain objects, no class needed.
{ x: Number, y: Number }

// Entity base shape — every combat entity has at least this.
{ id, x, y, vx, vy, radius, hp, maxHp, alive, neighborId }

// Item — the universal currency of loot, gifts, shop stock, garden yield.
{ id, kind: 'weapon'|'relic'|'seed'|'produce'|'junk', neighborId?, rarity: 0..3, name }

// Rumor
{ id, seedText, text, originNeighborId, holders: Set<string>, ageTicks, corruptions: Number }
```

## Module boundaries — who owns what

| Owner | Files |
|-------|-------|
| **A — Foundation & Combat** | `src/main.js`, `src/game/game.js`, `src/systems/rng.js`, `src/systems/collision.js`, `src/entities/player.js`, `src/entities/enemy.js`, `src/entities/projectile.js`, `index.html` |
| **B — Progression** | `src/systems/leveling.js`, `src/systems/weapons.js`, `src/systems/passives.js`, `src/systems/evolution.js`, `src/systems/loot.js`, `src/data/weapons.js`, `src/data/passives.js` |
| **C — Social meta-game** | `src/entities/neighbor.js`, `src/entities/vendor.js`, `src/systems/economy.js`, `src/systems/rumor.js`, `src/systems/aftermath.js`, `src/systems/garden.js`, `src/data/neighbors.js`, `src/data/rumors.js` |
| **D — UI, audio, ending** | `src/ui/ui.js`, `src/ui/pinboard.js`, `src/ui/screens.js`, `src/systems/audio.js`, `src/systems/particles.js`, `src/systems/ending.js`, `styles/main.css` |

Nobody edits a file they do not own. Cross-module needs are met by importing the other module's
exported API, which is frozen below.

## Frozen APIs

Each owner MUST export exactly these. Add more if useful, but never rename or remove these.

```js
// A — src/game/game.js
export class GameState {
  phase; dayTick; run;             // run = per-night stats object
  constructor(seed)
  update(dt)
  startNight(); endNight();        // endNight() returns a RunSummary
}
// RunSummary — consumed by C (aftermath) and D (screens)
// { kills, damageTaken, noise, itemsLooted: Item[], wavesCleared, bossDefeated, durationSec }

// A — src/systems/collision.js
export function circleHit(a, b)           // -> bool
export class SpatialGrid { insert(e); queryNear(x, y, r) }

// B — src/systems/weapons.js
export class WeaponSystem {
  equip(weaponId); current();
  update(dt, player, spawnProjectile)     // calls spawnProjectile(opts) on auto-fire
}
// B — src/systems/leveling.js
export class Leveling {
  addXp(n)                                // -> null | { choices: PassiveDef[] }
  choose(passiveId)
  statMultiplier(statName)                // -> Number, applied by A
}
// B — src/systems/loot.js
export function rollLoot(waveNumber, neighborId, rng)   // -> Item[]

// C — src/systems/economy.js
export class Economy {
  trust; debt;                            // never rendered
  credit(source, amount); owe(source, amount)
  priceFor(item, vendorId)                // -> { tier: 0..4, affordable: bool }  (NO raw number out)
}
// C — src/systems/rumor.js
export class RumorEngine {
  spawn(seedText, originNeighborId)
  tick()                                  // advance one day-tick of propagation
  fragmentsNear(neighborId)               // -> string[] overheard fragments
}
// C — src/entities/neighbor.js
export class Neighbor { id; opinion; receive(rumor); reactToGift(item) }
export function allNeighbors()            // -> Neighbor[7]

// D — src/ui/ui.js
export class UIManager {
  constructor(root)
  renderDay(state); renderNight(state); hideAll()
  showFragment(text); showVendor(vendor); showGiftMenu(neighbor, inventory)
}
// D — src/systems/audio.js
export class AudioManager { load(manifest); sfx(id); music(id, {fade}); stopMusic({fade}) }
// D — src/systems/particles.js
export class Particles { burst(x, y, kind); update(dt); render(ctx) }
```

## Placeholder assets

No real art exists yet. Every renderer draws **flat colored shapes** with a documented palette
constant, so sprites can drop in later without touching layout. Do not block on assets.

## Definition of done for any module

- Imports cleanly in the browser with zero console errors.
- Exports exactly the frozen API above.
- Has a `// SELF-TEST:` comment block at the bottom describing how to exercise it by hand.
- Renders no numbers to screen.
