# Cul-de-Sac-a-Doo: Survival Night

A portrait-mode mobile roguelite that fuses a *Vampire Survivors*-style bullet-heaven combat loop with an invisible, delayed social-consequence meta-game inspired by paranoia-stealth design.

## Project Structure

```
cul-de-sac-a-doo/
├── index.html              # Main entry point
├── src/
│   ├── main.js            # Game initialization and main loop
│   ├── game/
│   │   └── game.js        # Game state, combat, and core logic
│   ├── ui/
│   │   └── ui.js          # UI management and rumor display
│   └── systems/
│       ├── input.js       # Input handling (keyboard, mouse)
│       └── audio.js       # Audio management (music & SFX)
├── styles/
│   └── main.css           # Stylesheet
├── assets/
│   ├── sprites/           # Character and enemy sprites
│   ├── sounds/            # Audio files
│   └── ui/                # UI asset files
└── docs/
    └── design.md          # Detailed design documentation
```

## Game Phases

### Night Phase (12-15 min runs)
- Auto-attacking combat against escalating waves of corrupted neighbors
- Standard roguelite leveling system
- Weapon variety with "vice" passive mods
- Weapon evolutions through neighbor-relic pairings
- Boss demand from Debt Frog at timer end

### Day Phase (hub/meta layer)
- Walk the street in daylight
- Garden backyard plot with looted seeds
- Shop at three vendors (Sheila's HOA, Colonel's crate, Frog's stall)
- Gift items to neighbors to influence their opinion
- Track rumors and their spread

## Currency & Economy

- **Trust**: Earned through clean runs, gardening, good gifts
- **Debt**: Spent on stronger gear, frog purchases
- Both currencies affect shop prices and stock availability
- No numeric UI - all values are implicit/decontextualized

## Key Systems

- **Rumor Propagation**: Private social consequences spreading neighbor-to-neighbor over ticks
- **Neighbor Relationships**: 7 fixed neighbors, each with combat identity and shop role
- **No Meters**: Zero numeric UI anywhere - all state inferred by player
- **Causality Ambiguity**: Game never confirms rumor links or social consequences

## Development Status

- [x] Project scaffolding
- [ ] Combat system
- [ ] Neighbor AI
- [ ] Shop/economy system
- [ ] Rumor propagation engine
- [ ] Asset creation (sprites, sounds)
- [ ] UI implementation
- [ ] Testing & balance

## Notes for Implementation

- Keep numeric state hidden - only show fragmented rumors and overheard conversations
- Vendors restock based on how loud prior runs were
- Over-gifting reads as suspicious
- Garden plants grow in real-time or by day-tick
- Manual pinboard for player rumor tracking
- Best ending mirrors what happened to the previous owner
- Never explain whether player got the causality right
