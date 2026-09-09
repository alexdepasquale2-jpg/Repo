# The Chair Is Not Locked

A top-down 2D browser game built from the *Untitled Throne/Mycelium* tech tree (v2 + v3 + v4).
Tab-target, auto-swing, five levels, and a throne room where somebody has to sit down.

Open `index.html` from any static server:

```
python3 -m http.server 8000
# then http://localhost:8000
```

No build step, no dependencies — ES modules and one canvas.

## What it is

You are a salvager. You go down through five rooms of a ruin for gear, not glory.
At the bottom there is a chair, the door behind you is sealed, and **the loot is on
whoever sits in it — and the one who sits decides who gets paid.** So the group
does not wonder whether to sit. They negotiate who does.

Sitting hands you the boss role: you cannot move, you see through the fungal
network instead of with your eyes, and you fire from its nodes. If you go quiet
for too long the room is punished — but every attack you make travels out from
the root, and that is the only moment the throne can be hurt. There is no safe
state for anyone.

Beat the boss and they are not killed — they are left **downed**, human again,
dying next to the chair. Spare them and they allocate the pot. Kill them and
nobody gets paid at all. Mercy is not a moral choice here; it is the only way
anyone gets their money, and the boss knows it while he is fighting you.

Then the chair is empty again, and there are fewer of you.

## Controls

| | Attacker | Seated |
|---|---|---|
| WASD | move | — |
| Tab / Q | cycle target | move your gaze between nodes |
| Space | step (no i-frames — this is a positioning game) | feint the current cast / bloom collapse |
| E | loot, break a husk, **hold** to sit | wake a husk |
| 1–4 | abilities | Lash · Bloom · Tether · Grow |
| F | — | mark an attacker, then again to spare them |
| Esc | — | change what growth spends on |
| Enter / Esc | spare / kill a downed sitter | |
| ` · P · [ ] | debug overlay · pause · timescale | |

Your weapon swings itself, but **only inside its band**, and every weapon wants a
different distance. Holding that band while knockback, fungal ground and your own
allies push you out of it is the skill in the game. Your swing uptime is on screen;
so is everyone else's, in the data.

## Layout

```
src/core/     loop (fixed 60Hz), input intents, math, seeded rng, events
src/engine/   entities, collision + uniform grid, camera, pooled particles
src/game/     combat, status, targeting, weapons, abilities, spirits,
              network, boss, throne, ai, levels, world (the orchestrator)
src/ui/       render, hud
```

Node IDs from the plan are cited in comments where a file implements one, so the
document and the code can be read against each other.

## What is implemented

**Tier 0–1** — fixed timestep with interpolated render, intent-based input,
weighted movement, uniform-grid collision, deadzone camera, debug overlay,
entity/component split, deterministic tab-targeting, auto-swing with per-weapon
bands, tech weapons as data, damage packets, status effects, combat feel.

**Tier 2 (the vertical slice)** — throne interaction with a deliberate hold,
full teardown/rebuild controller swap, transformation sequence carrying its own
onboarding, boss camera and node-selection controls, boss vision filtered by
network coverage, three node types with distinct silhouettes, scars and
suppressed regrowth, biomass economy with three competing sinks, overgrowth,
Lash/Bloom/Tether with a shared telegraph grammar, the idle pulse (fired from
the root, so stalling still opens him), root window and armor scaling, feints,
husk reactivation and salvage, network-keyed phases, bloom collapse, the
alternate exit, the mercy choice, the allocation, and successions.

**Tier 3–7 fragments** — five hand-crafted levels with rising fungal
encroachment, XP and levels, safe rooms, the sealed door in every level, husks
as set dressing and as resource, the bound-spirit system (capacity, possession,
and gear that starts making decisions for you), and one telegraph language used
by every threat in the game.

## What is not

Netcode. The authority model is designed for it — the network, biomass and idle
timer are single-authority, boss vision is a filtered view rather than
client-side hiding, and every random draw goes through one seeded stream — but
this build runs the other five players as AI. The social layer (marking,
sparing, friendly fire, the allocation) is played against them.

Audio, art, and the myth layer beyond the husks and the sealed door.

## Tuning

The debug overlay (`` ` ``) reports the instrumentation the plan asks for: node
count against peak, biomass, overgrowth, cruelty, swing uptime, node kills, root
window hits, time to first death. The stated levers, cleanest first, are regrowth
rate, root window duration, and biomass income — not damage numbers.

Current measured shape of one fight: about 80 seconds, three phases, armor
falling from 0.97 to 0.4 as the network is cleared, and the boss pushed into
overgrowth as he overspends to hold ground.
