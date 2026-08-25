# ADR 0001 — Names are canon

**Status:** accepted (M0)

## Context

The specification names its first-class types before it implements them. A rename mid-build
costs more than the sum of its diffs, because the design conversation and the code stop
sharing a vocabulary.

## Decision

These names are frozen. They appear in `tbc_core::ids` and the module names, spelled the
same way as in the spec:

`IUOC`, `FWAU`, `Avatar`, `AUM_Core`, `TBC`, `Δt` / `DeltaTClock`, `Ruleset`,
`ProbabilitySurface`, `EntropyLedger`, `RenderOracle`, `RWWBus`, `ExperiencePacket`,
`FrameId`, `IslandId`, `Tick`, `Entity`, `QualityScalar`.

Layer meanings are frozen with them: **IUOC = soul, FWAU = session, Avatar = disposable
body.** An AI Guy is an entity with no `FwauBinding` and is never given one.

## Consequences

`tbc-core` reads like the specification. Ports to other languages keep the same identifiers.
Renaming requires a superseding ADR, not a pull request.
