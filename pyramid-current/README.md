# Pyramid Current

A 2.5D (isometric) mobile action game. Everything in it comes from the seven reference images it was designed from.

| Reference | In the game |
|---|---|
| Sepia cut-away of three pyramids with coil-wrapped shafts feeding an underground cube | The map: three pyramids, six copper coils, conduits feeding the **Core** cube, and cut-away earth walls on the diorama edge. Also the title art. |
| Painted oak tree | The **Tree**, which heals you when you stand under it (the sprite is used directly). |
| Man in a dark two-tone jacket, grey jeans, sneakers | The hero's outfit. |
| Ushanka, round glasses, bandolier, cigar-lounge wanderer | The hero: fur hat, glasses, beard, bullet bandolier. |
| Arrest scene with police in fur hats | **Wardens**, enemies that shut coils down and cuff (stun) you. |
| High-five with a curly-haired painter at an easel | **The Painter**, who trades a high-five for an upgrade. |
| Cyber arena with orange fire figures and six ability icons | The **Ember** enemies, the **Pyre Colossus** boss, the glowing card-blade, and the six abilities in the bottom bar. |

## Story and progression

The game is a five-chapter campaign. Each chapter opens and closes with a short cutscene, and characters talk to you over the radio during missions. The cast is the Wanderer, Vasko the Painter, Warden Captain Orlov and the Pyre.

1. **The Sleeping Grid:** wake 2 coils. Embers only.
2. **Copper Veins:** wake 4 coils. Wardens arrive.
3. **Lockdown:** wake all 6 coils against heavy Warden pressure.
4. **The Pyre:** relight the grid, then defeat the Pyre Colossus.
5. **Endless Current:** survival mode where the Pyre returns every two minutes. Your best time is saved.

Clearing a chapter opens the next one. Abilities unlock as you progress: 2 in chapter 1, then 4, 5 and finally all 6.

**Sparks** come from takedowns, coils and chapter rewards, and you keep them even when you lose. Spend them in the **Workshop** on permanent upgrades: max HP, damage, fire rate, move speed, cooldowns, and starting high-five tokens. Progress is saved in the browser's local storage.

## Play

Open `index.html` over HTTP (e.g. `python3 -m http.server` in this folder), then add it to your home screen. It is a PWA and works offline.

- **Move:** drag anywhere on screen (floating joystick), or use WASD/arrows. You fire automatically at the nearest enemy.
- **Wake coils:** stand on a coil pad until it lights. Each coil you wake for the first time gives a high-five token, and so does every 25 takedowns.
- **Abilities** (tap, or keys 1–6):
  - Logic Cascade: chain lightning.
  - Dopamine Surge: speed, fire rate and a heal.
  - Echo Verse: knockback shockwave.
  - Network Sanctum: a dome that makes you invulnerable.
  - Atlas Core Link: live coils fire at enemies.
  - Cognitive Flow: slows time and halves the other cooldowns.
- Once all six coils are live, the Core awakens and the **Pyre Colossus** rises. Each live coil strengthens the Core's beam against it.

No build step and no dependencies: `index.html`, `style.css`, `game.js`, `sw.js`.
