# ADR 0000 — Architecture decision records

**Status:** accepted (M0)

## Context

M0's exit criterion is "signed by eng + design; numbers adjustable, names frozen". A frozen
name with no record of why it was chosen gets un-frozen by the first person who finds it
inconvenient.

## Decision

Every decision that changes a canon name, a baseline budget, a ledger coefficient, or the
fixed per-tick step order gets an ADR in `docs/adr/`, numbered sequentially, never edited
after acceptance — superseded instead, with a link.

Numbers may change with measurement, and an ADR is how the measurement is recorded. Names
change only by superseding ADR 0001.

## Consequences

Changing `ETA_HARM` is a two-line code change and a new ADR plus a new `ledger_epoch`. That
asymmetry is intentional: it is a live-ops knob attached to people's history.
