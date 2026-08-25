# ADR 0003 — Headless Rust before any world

**Status:** accepted (M0)

## Context

The failure mode this project is most likely to hit is an open world that renders
beautifully and cannot tick: an engine whose authority loop was retrofitted to a client.

## Decision

M1 is one headless Rust crate with four modules — `delta_t`, `ledger`, `grid`, `beam` — and
tests that print the specification's numbers. No renderer, no gateway, no database, no
engine integration until the tick is measured.

Rust, because there is no GC in the Δt hot path, determinism is achievable, and a shard is
one binary. `tbc-core` takes exactly one dependency (blake3, for island seed derivation).

## Consequences

The M1 crate is boring to look at and cheap to reason about. Every later milestone attaches
to a loop whose cost is already known: 768 steps per island per tick, ~614 k steps/s at 40
islands, inside one pinned sim core.
