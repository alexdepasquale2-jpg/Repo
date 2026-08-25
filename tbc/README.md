# The Big Computer (TBC)

An MBT-native MMORPG engine for the Larger Consciousness System.

**Status: M0 complete, M1 complete.** Single-process, headless, deterministic tick and
ledger. No client, no network, no persistence — by design.

> Build the teacher-loop and the tick before the world, the world before the bus, the bus
> before the shards. Names are canon. Numbers are Δt budgets.

## Run it

```bash
cd tbc
cargo test -- --nocapture      # 41 tests; prints every number in the specification
cargo run --bin tbc-m1 -- 200  # 200 ticks of PMR-Prime, two FWAUs, no client
```

`cargo test --test spec_numbers -- --nocapture` is the acceptance test on its own: it
prints the §4, §5, §7 and §8 numbers and asserts each one.

## What M1 is

| Module | Spec | Contents |
|---|---|---|
| `delta_t` | §5 | 20 Hz fixed-timestep loop, accumulator, catch-up cap of 4, stall metric, nested clocks and dilation |
| `ledger` | §8 | EntropyLedger: `S ∈ [0,1]`, five owner-only bands, delayed and noisy ΔS, reciprocity decay, `ledger_epoch` |
| `grid` | §4 | Three-level uniform spatial hash (32 / 128 / 512 m), O(1) moves, subscriber symmetric difference |
| `beam` | §7 | Intent-biased beam prune (B=16, A=6, D=8, ε=1e-4), Walker's alias collapse, Past/Present/Future stores, causality islands |

Supporting: `ids` (canon identifiers), `rng` (PCG64 + blake3 island seeds), `math`, `spec`
(every baseline budget as a constant), `toy` (a four-body demo island so the beam has
something to branch over before the ECS lands at M3).

## The numbers, as printed by the tests

```
D · B · A          = 768 step() calls per island per tick
saturated advance  = 768 step() calls
cold-start advance = 618 step() calls (ramping 1 → 6 → 16 branches)
40 islands         = 30720 steps/tick ≈ 614400 steps/s at 20 Hz
   1000 entities   : 1000 cell-local moves = 0 cell ops, 1 crossing = 2 cell ops
 100000 entities   : 1000 cell-local moves = 0 cell ops, 1 crossing = 2 cell ops
delay window       = 12000 … 432000 ticks = 10 min … 6 h of playtime
1 000 ms hitch     : stepped 4 (cap 4), stalls 1, dropped 820ms
c_info · D · Δt    = 300 m/s × 8 × 0.05 s = 120 m (interest radius 128 m)
```

**On 768 versus 618.** `D · B · A` = 768 is the per-island *budget*: the cost of advancing
a beam that is saturated at every depth, which is the steady state and the number to plan
capacity against. A surface rebuilt from a freshly committed present cannot saturate until
depth 3 (1 → 6 → 16 branches), so a cold-start advance costs 618. Both are asserted; the
budget is the one that bounds a shard.

## Non-negotiables, and where they live in the code

1. **Authority lives in AUM_Core.** Nothing in `tbc-core` accepts a client-authoritative input.
2. **Observation allocates compute.** `grid` is the mechanism; an entity in nobody's interest set is not stepped.
3. **Identity outlives avatars.** `EntropyLedger` is keyed by `IuocId`. There is no avatar in that API to reset.
4. **Scoring is private, delayed, noisy.** `band_of` is the public accessor; `s_private` is named for the rule it carries. There is no ranking API, no `flush_now`, and no delay override — see the guardrail block at the foot of `ledger.rs`.
5. **Rulesets are data.** Tightness is `IslandSim::p_ruleset`, not a code fork.
6. **Consent is a verb.** `unconsented_harm` takes consent as an argument rather than inferring it.
7. **Coefficients ship as a new `ledger_epoch`.** `retune` refuses an in-place edit and never touches an enqueued delta.

Harm to an AI Guy is zero on the ledger's harm axis unless it is a flagged ward. AI Guys
have no FWAU.

## Deliberately absent at M1

No QUIC gateway, no NATS, no Scylla or sqlite, no ECS archetype store, no snapshot-ring
rewind, no UE5 anything. Those are M2–M4. The `toy` island is a stand-in and is marked as
one.

## Next: M2 — Soul Bind

Bind/unbind/death merge with a minimal `iuoc` / `packets` / `ledger_events` schema (sqlite
is acceptable at M2), atomic bind with read-only spectate on failure, an ExperiencePacket
on death, and multi-IUOC vault-isolation tests. The delayed queue is not flushed early on
unbind — death is not a shortcut past the delay.

## Layout

```
tbc/
├── Cargo.toml                  workspace; net/persist/client crates join at M2+
├── docs/adr/                   architecture decision records (M0)
└── crates/tbc-core/
    ├── src/{delta_t,ledger,grid,beam}.rs
    ├── src/{ids,rng,math,spec,toy}.rs
    ├── src/bin/tbc_m1.rs       the headless harness
    └── tests/                  spec_numbers, determinism, and one file per module
```
