# ADR 0004 — The EntropyLedger has no public surface

**Status:** accepted (M0)

## Context

A scoring system that claims to measure love is a weapon if it is public, real-time, or
required for basic play. Every karma system that has shipped has died to the same three
attacks: performative charity, reciprocal farming, and leaderboard pressure.

## Decision

Enforced in the API, not in a style guide:

* No ranking. `EntropyLedger` exposes no `top_n`, no comparison between IUOCs, and no
  iterator over `(IuocId, QualityScalar)`. A leaderboard cannot be built without adding one.
* The float never leaves the ledger process. The public accessor is `band_of`, returning one
  of five named bands. The raw accessor is named `s_private` for the rule it carries.
* Nothing lands immediately. There is no `flush_now` and no delay override. The delay is the
  mechanism.
* `SettledEvent` carries a band, not a delta, so an owner's ping can say "something settled"
  and nothing more precise.
* `audience_sensitivity` and `ReciprocityTracker` are in the scoring path, not on a backlog.

Player-facing copy never states a number, never compares two people, and never moralises.

## Consequences

Some analytics are harder. That is the intent: an internal dashboard that ranks players by S
is the same artefact as a public leaderboard, one screenshot away.
