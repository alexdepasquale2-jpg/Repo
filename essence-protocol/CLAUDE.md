# CLAUDE.md: Essence Protocol + FriedrichBridge

## What this is
Essence Protocol is a web game (no build step). Everything in it is a **merge** of essences: a lead main (Fire/Water/Earth/Air), a second main, and up to 3 sub-essences bound to either one. That gives 5,896 merge identities. Each identity is both a battle technique and a daemon form (genome), and the Forge turns merges into items.

Merges have two layers:

| Layer | Source |
|---|---|
| **Spells and abilities** (every technique): name, description, class, power, hits, accuracy, Flux cost, cooldown, instability, priority, effects | **FriedrichBridge**, a local HTTP server that asks a local model (Ollama or FriedrichAI) and saves every result in its SQLite DB. The bridge item is turned into mechanics by `BRIDGE.abilityFrom` in `js/bridge.js` |
| **Daemon forms**: name and description | FriedrichBridge |
| **Element typing** (the 65/35 lead/follow split), daemon base stats, passives, class signature mechanics | Baked (`js/merges.baked.js` from `tools/bake.js`), because they come from the essences themselves |
| **Offline fallback** for everything above | The baked record for the same merge |

Rules for Claude working in this project:
- Never invent spells or recipes in game code. Ask the bridge (`js/bridge.js`). The baked records in `merges.baked.js` are only the offline fallback and the source of element typing.
- To change how bridge items become abilities, edit `abilityFrom` in `js/bridge.js`. It is pure and deterministic (same item, same ability). `tools/verify.js` fuzzes it against all 5,896 merges and runs real-time battles on the results.
- If the baked fallback changes, edit `essences.js`/`bake.js`, run `node tools/bake.js`, then `node tools/verify.js`.
- The bridge caches every recipe. The same pair always returns the same item, and A+B equals B+A (see the id scheme below for how lead/follow order survives that).
- Engine: **web** (vanilla JS PWA in `essence-protocol/`).

## How a game merge maps onto a bridge merge
Each merge identity (key like `FW-Em1Li2`) is sent as a two-item `POST /merge`:
- `a` is the lead main plus the subs bound to it: `{"id": "ep.t.lead.F.Em", "name": "Fire (Ember)", "element": "fire", "role": "lead", "essences": [...]}`
- `b` is the second main plus its subs: `{"id": "ep.t.follow.W.Li", "name": "Water (Light)", ...}`
- The **role is part of the id** because lead/follow order matters here (Fire-led Scald is not Water-led Steam), while the bridge treats A+B as B+A.
- Techniques use the prefix `ep.t.` and daemon forms use `ep.f.`, so each identity has two independent recipes.
- `context` carries the baked class, reaction, power and effects so the name fits what the merge does.
- All ids match `^[A-Za-z0-9_.:\-]{1,128}$` and never contain `+`. `tools/verify.js` checks every one of the 11,792 requests, and checks that no two merges collide as an unordered pair.

The request's `context` asks the model to design a combat technique. Its `tags` should include one type from `strike, barrage, siphon, hex, ward, mend, field` and any effect words the engine knows (burn, freeze, chill, static, root, corrupt, lullaby, blind, soak, petrify, pierce, crit, echo, delay, drain, heal, shield, guard, overclock, haste, veil, regen, wash, cleanse, priority).

What the game does with the response (`abilityFrom`):
- **Class** comes from the type tag, or else from keywords in the name, description and tags, or else the lattice's class.
- **Rarity** (`common` to `legendary`) sets base power, Flux cost, instability, accuracy and effect strength. Higher rarity is stronger and riskier.
- **`stats`** (any keys): attack-like keys drive damage; defense-like keys drive shield, heal and drain; special-like keys drive effect chances; speed-like keys give priority and extra Barrage hits.
- **Effect words** anywhere in the name, description or tags become effects. Each class also keeps its core effect (Siphon drains, Mend heals, Ward shields, Hex applies a status).
- `name` and `description` become the spell's name and text everywhere (hotbar, codex, tooltips, battle log, forge items).
- Unknown fields are kept in the local cache.
- Results are cached in the browser (`localStorage`, key `ep-bridge-cache-v1`) and applied at boot.
- A 200 with `cached: false` shows a "FriedrichBridge named…" discovery toast.

## Connection
- **Run the game through the proxy**: `python essence-protocol/tools/serve.py` serves the game on `http://127.0.0.1:8090` and forwards `/bridge/*` to the bridge.
  - The browser only talks to its own origin (no CORS), and the proxy adds the key server side, so the key never reaches the browser.
  - The proxy refuses `/merge/reset`.
- Bridge base URL: `http://127.0.0.1:8765`. The port is `port` in `C:\Users\Albert\FriedrichBridge\config.json`. The game must **not** use 8765 itself, nor 8080 (FriedrichAI's engine listens on 127.0.0.1:8080), so serve it on 8090.
- Auth: the proxy reads the key from the `FRIEDRICH_BRIDGE_KEY` env var, or from `essence-protocol/bridge.local.json` (gitignored; copy `bridge.example.json`). **Never commit the key.**
- Start the bridge with `C:\Users\Albert\FriedrichBridge\start_bridge.bat`. Ollama must be running (`ollama serve` or the tray app).
- Liveness: `GET /health` (the game calls it on load and from System > FriedrichBridge > Test connection).
- A direct endpoint (no proxy) can be set in System > FriedrichBridge > Endpoint. It needs the key in the browser and CORS enabled on the bridge, so it is not recommended.
- The hosted artifact link cannot reach localhost. There the game always uses the baked names.

## Handling every outcome (implemented in `js/bridge.js`)
| Result | Meaning | Game does |
|---|---|---|
| 200 `cached: true` | Known recipe | Apply the name silently |
| 200 `cached: false` | New recipe | Apply it and show a discovery toast |
| 422 with `retryable: false` | Model gave bad output twice | Keep the baked name and don't retry this merge again this session |
| 422 with `detail` as a list | Our request was malformed | `console.error` (a game bug) and no retry |
| 502 / 503 / 504 with `retryable: true` | AI backend error, down, or timed out | Retry with backoff 2s, 5s, 10s (max 3), then mark it "try again later" |
| 404 | Configured Ollama model not installed | Status `error` with a clear message, and stop calling |
| 401 | Wrong or missing key | Status `error`, and stop calling |
| Connection refused / proxy 503 `bridge_down` | Bridge not running | Status `offline` ("run start_bridge.bat"), keep baked names, and drop the queue |

Timing:
- Calls are async and never block the game loop or combat.
- Only one merge is in flight at a time (a single queue), and duplicate requests for the same key share one promise.
- The client timeout is 75 s (the bridge's `merge_timeout` is 60 s, including queue time).
- On load, if the bridge is online, the game designs the party's forms and up to 40 undesigned discoveries. In System, "Design discovered merges" queues the rest, and "Design the whole lattice…" queues all 5,896. That takes hours on a local model and runs in the background.

## Other endpoints
- `GET /merge/recipes?limit=50`: available as `BRIDGE.recipes(limit)` for a recipe-book view.
- `GET /merge/items/{id}`: not needed yet (the game keys its cache by merge identity).
- `POST /merge/reset` with `{"confirm": true}` is dev only. The game proxy refuses it, so call the bridge directly if you really mean it.

## Quick test (key from the environment, never pasted into files)
```bash
curl -X POST http://127.0.0.1:8765/merge -H "X-API-Key: $FRIEDRICH_BRIDGE_KEY" -H "Content-Type: application/json" \
  -d "{\"a\":{\"id\":\"ep.t.lead.F.Em\",\"name\":\"Fire (Ember)\"},\"b\":{\"id\":\"ep.t.follow.W\",\"name\":\"Water\"}}"
```

## Changing what flavor looks like
Edit `merge_schema` and `merge_prompt` in `C:\Users\Albert\FriedrichBridge\config.json` and restart the bridge. Existing cached items keep their old shape. In the game, System > FriedrichBridge > "Forget local names" clears the browser cache; `/merge/reset` (dev only) regenerates on the bridge side. Unknown new fields on `item` are kept in the local cache.

## Checks
- `node essence-protocol/tools/bake.js --check`: the baked table is fresh
- `node essence-protocol/tools/verify.js`: table sanity, bridge id mapping, map connectivity, 450 simulated battles
