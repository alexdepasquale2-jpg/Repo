# THE BIG COMPUTER (TBC) — Grok Build Package
## Master Prompt & Instructions

**Version:** 1.0 Final  
**Date:** August 2026  
**Source of Truth:** TBC Architecture Specification v1.0 + Complete Project Roadmap

---

## How to Use This Package with Grok

You are building **The Big Computer** — an MBT-native MMORPG engine that implements the Larger Consciousness System (LCS).

This package contains everything required:

| File | Purpose |
|------|---------|
| `00_GROK_MASTER_PROMPT_AND_README.md` | This file — your operating instructions |
| `TBC_Architecture_Specification_v1.0.md` | Full original architecture spec (canon) |
| `TBC_Sections_Structured.json` | Machine-readable structured sections |
| `TBC_Complete_Project_Roadmap_and_Grok_Build_Plan.docx` | Finished roadmap + Grok build plan |
| `TBC_Earlier_Roadmap_v0.docx` | Previous intermediate version (for reference) |

### Core Directive (always obey)

> **Build the teacher-loop and the tick before the world, the world before the bus, the bus before the shards.**  
> Never start with a UE5 open world.  
> Names are canon. Numbers are Δt budgets.

### Non-Negotiables

1. Authority lives in AUM_Core. Clients predict; they never commit.
2. Observation allocates compute. Unobserved regions sleep.
3. Identity outlives avatars. IUOC = soul, FWAU = session, Avatar = disposable body.
4. Scoring is private, delayed, and noisy. The EntropyLedger is **never** a public leaderboard.
5. Rulesets are data. PMR tightness and NPMR looseness are configuration.
6. Consent is a first-class verb. Public virtue scores or moralizing UI are design failures.
7. Changing coefficients only ships as a new `ledger_epoch`. Never rewrite the past.

---

## Recommended First Conversation with Grok

Copy and paste the following prompt (or adapt it) to begin:

```
You are the lead systems engineer building The Big Computer (TBC), an MBT-native MMORPG engine for the Larger Consciousness System.

I am giving you the complete architecture specification and the finished project roadmap.

Your first job is Milestone M0 + M1:

1. Confirm you understand the canon names and the non-negotiables.
2. Create a headless Rust crate skeleton containing:
   - delta_t (20 Hz PMR tick, nested clocks)
   - ledger (EntropyLedger with delayed ΔS, ledger_epoch)
   - grid (hierarchical spatial hash)
   - beam (Intent-biased beam prune parameters B=16, D=8, A=6)
3. Write unit tests that print the exact numbers from the specification (768 steps/island, O(1) cell move, delayed ΔS formula).
4. Make the tests pass and show the printed numbers.

Do not generate a full open-world client or UE5 project yet.
Stay strictly inside the M1 scope: single-process, headless, deterministic tick + ledger.

After the tests pass we will move to M2 (Soul Bind).

Here is the full specification and roadmap for reference.
```

Then attach or paste the relevant sections from this package.

---

## Build Order (Strict)

| Phase | Milestone | Focus | Grok Role |
|-------|-----------|-------|-----------|
| 0 | M0 | Freeze names + ledger_epoch 0 | Confirm understanding, list ADRs |
| 1 | M1 | Tick + Ledger (headless Rust) | Generate crate + tests that print the numbers |
| 2 | M2 | Soul Bind + minimal Scylla/sqlite schema | Generate bind/unbind/death flow + isolation tests |
| 3 | M3 | Observe (grid, sleep/wake, dirty fields) | Generate hierarchical grid + debug client hooks |
| 4 | M4 | Netcode (QUIC, rewind, 8-player LAN) | Generate gateway skeleton + rewind tests |
| 5 | M5 | NPMR + RWW + PsiQuery | Generate nested clocks + NATS subjects + odds-only Psi |
| 6 | M6 | Probability Surfaces / Islands | Generate beam + FutureIsland + profiler hooks |
| 7 | M7 | World (2-shard, reincarnation planner) | Generate suitcase + rankOffers + between-lives data |
| 8 | M8 | Guardrails (Consent, no public S) | Generate Verb::Consent + ethics audit checks |
| 9 | M9 | Scale + Live Ops | Autosplit policies, chaos recovery, coefficient cadence |

---

## Key Numbers (Baseline Budgets — change only with measurement)

- PMR tick: **20 Hz** (50 ms)
- Design RTT: **100 ms** (target 50 ms)
- FWAU per shard target: **400**
- Entities per shard: ~12,000
- Beam: B=16, D=8, A=6
- Snapshot ring: 8
- Max rewind: 400 ms
- WASM guest hard cap: 0.3 ms

---

## What Grok Must Never Do

- Create a public S / virtue leaderboard
- Write moralizing player-facing copy (“you are a worse person”)
- Suggest pay-to-lower-S items
- Rewrite past ledger events when coefficients change
- Start with a full open-world UE5 project before the tick works
- Treat AI Guys as if they have FWAUs (they do not)

---

## Success Criteria for the First Prototype Sprint

- [ ] Headless Rust crate compiles
- [ ] Unit tests print the specification numbers
- [ ] Determinism harness: same seed → identical sequence
- [ ] Ledger delay and accumulation correct
- [ ] No public scoring surfaces of any kind

---

## Closing Instruction for Grok

When in doubt, re-read the Architecture Specification and the Complete Roadmap.  
Prefer measured stalls over vibes.  
Prefer private, delayed, noisy feedback over public moral ranking.  
The teacher-loop and the tick come first.

Begin.
