# ADR 0005 — Determinism is a property of the step function

**Status:** accepted (M0)

## Context

Rewind-replay (M4), the anti-cheat oracle, and two observers arriving at a sleeping entity
on the same tick all assume the authority step is reproducible. Determinism retrofitted
after a thread pool is added is not determinism.

## Decision

* The authority step is a pure function of `(snapshot, intent set, rng_seed)`.
* RNG is explicit and per-island: `Pcg64`, seeded `blake3(frame || island || tick ||
  genesis)`. There is no ambient or thread-local generator anywhere in `tbc-core`.
* Draws are consumed in a fixed order, and `AliasTable::draw` consumes the same two words
  whichever branch it returns, so adding an observer cannot permute unrelated draws.
* Wall clock enters exactly one function, `DeltaTClock::drain`. Timeouts are tick counts.
* `top_B` uses a stable sort rather than heapselect: same complexity class at n = 96, and a
  defined order for equal weights.
* Beam search with tied weights collapses path diversity toward the earliest parent. That is
  inherent to top-B truncation and is why a live ruleset is peaked rather than flat.

## Consequences

`cargo test --test determinism` is a real gate: same genesis → identical world line, one-bit
change → a forked one. Server nodes in a shard pair must be the same arch and build for
replay, as the spec requires.
