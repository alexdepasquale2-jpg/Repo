//! **The Big Computer (TBC)** — M1 sim core.
//!
//! An MBT-native MMORPG engine for the Larger Consciousness System. This crate is the
//! first milestone and nothing more: single-process, headless, deterministic. Four
//! modules, in the order the build order demands them.
//!
//! | Module | Spec | What it is |
//! |---|---|---|
//! | [`delta_t`] | §5 | The 20 Hz PMR tick, the accumulator, nested clocks |
//! | [`ledger`] | §8 | The EntropyLedger: private, delayed, noisy ΔS |
//! | [`grid`] | §4 | The hierarchical spatial hash behind render-on-observation |
//! | [`beam`] | §7 | Intent-biased beam prune, B=16, D=8, A=6 |
//!
//! # Non-negotiables
//!
//! These are load-bearing in the code, not just in the design doc:
//!
//! 1. **Authority lives in AUM_Core.** Clients predict; they never commit. Nothing here
//!    takes a client-authoritative input.
//! 2. **Observation allocates compute.** Unobserved regions sleep — [`grid`] is how.
//! 3. **Identity outlives avatars.** The ledger is keyed by [`ids::IuocId`], never by an
//!    avatar, so reincarnation cannot wash S.
//! 4. **Scoring is private, delayed, and noisy.** [`ledger::EntropyLedger`] exposes a band
//!    to an owner and offers no ranking API at all.
//! 5. **Rulesets are data.** Tightness is a number in [`beam::IslandSim::p_ruleset`], not
//!    a code fork.
//! 6. **Consent is a first-class verb.** [`ledger::unconsented_harm`] takes consent as an
//!    argument rather than inferring it.
//! 7. **Coefficient changes ship as a new `ledger_epoch`.** [`ledger::EntropyLedger::retune`]
//!    will not let you edit one in place, and never rewrites an enqueued event.
//!
//! # What is deliberately absent at M1
//!
//! No QUIC gateway, no NATS, no persistence, no ECS archetype store, no UE5 anything, and
//! no snapshot-ring rewind — those are M2 through M4. The tick and the teacher-loop come
//! first.

pub mod beam;
pub mod delta_t;
pub mod grid;
pub mod ids;
pub mod ledger;
pub mod math;
pub mod rng;
pub mod spec;
pub mod toy;
