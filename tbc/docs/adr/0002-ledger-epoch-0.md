# ADR 0002 — `ledger_epoch` 0

**Status:** accepted (M0)

## Context

S is a player's history. Retuning a coefficient changes what past actions were worth. If
the retune is applied retroactively, the ledger stops being history and becomes an opinion.

## Decision

`ledger_epoch 0` is the coefficient table published with the specification:

| Knob | Value |
|---|---|
| `eta_aid` | 0.040 |
| `eta_harm` | 0.060 |
| `eta_ego` | 0.030 |
| `eta_coerce` | 0.080 |
| `sigma` (noise) | 0.010 |
| `clamp` (per event) | ±0.150 |
| delay window | 12 000 … 432 000 ticks (10 min … 6 h of playtime at 20 Hz) |
| `S` at IUOC creation | 0.50 (Settled) |

Coefficient changes ship as a **new epoch**. `EntropyLedger::retune` asserts the epoch
advances, and every enqueued `PendingDelta` keeps the epoch that scored it and lands with
its original value. The past is never rewritten.

## Consequences

A live-ops retune is safe to deploy mid-session: deltas already in flight settle under the
rules the player acted under. Analysing S over time requires grouping by epoch, which is the
honest thing to have to do anyway.
