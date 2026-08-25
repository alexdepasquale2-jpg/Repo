//! The EntropyLedger (§8): the character sheet, and the slow teacher.
//!
//! `S ∈ [0, 1]`, lower is better. The whole design is in four adjectives: **private**,
//! **delayed**, **noisy**, and **owner-only-coarse**. Anything that makes S public,
//! immediate, precise, or comparable between players is a defect in this module, not a
//! feature request — see the guardrails at the bottom of the file.
//!
//! Fast feedback is physics: you stabbed someone, they are stabbed, this tick. The ledger
//! is the other loop, and it deliberately does not run on the 20 Hz path.

use std::collections::{BTreeMap, HashMap};

use crate::ids::{ActionId, EventId, IuocId, Tick};
use crate::rng::Pcg64;

/// Quality of consciousness. Internally a float; it never leaves the ledger process.
pub type QualityScalar = f32;

/// S for a newly minted IUOC: the middle of the Settled band.
pub const S_INIT: QualityScalar = 0.50;

/// Coefficients for one ledger epoch.
///
/// These are live-ops knobs, not morals. Changing them ships as a **new epoch** — the past
/// is never rewritten, and events already enqueued keep the epoch they were scored under.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Coefficients {
    /// Which epoch these coefficients define.
    pub epoch: u32,
    /// Weight on consented aid (lowers S).
    pub eta_aid: f32,
    /// Weight on unconsented harm (raises S).
    pub eta_harm: f32,
    /// Weight on self-dealing (raises S).
    pub eta_ego: f32,
    /// Weight on coercion (raises S).
    pub eta_coerce: f32,
    /// Standard deviation of the noise added to every delta.
    pub sigma: f32,
    /// Per-event cap on the applied delta, after noise.
    pub clamp: f32,
    /// Earliest a delta may land, in ticks of playtime.
    pub delay_min_ticks: u64,
    /// Latest a delta may land, in ticks of playtime.
    pub delay_max_ticks: u64,
}

impl Coefficients {
    /// `ledger_epoch 0`: the values published with the spec.
    ///
    /// Delay is 10 minutes to 6 hours of playtime, expressed in PMR-Prime ticks
    /// (20 Hz): 12 000 to 432 000.
    pub const EPOCH_0: Self = Self {
        epoch: 0,
        eta_aid: 0.040,
        eta_harm: 0.060,
        eta_ego: 0.030,
        eta_coerce: 0.080,
        sigma: 0.010,
        clamp: 0.150,
        delay_min_ticks: 12_000,
        delay_max_ticks: 432_000,
    };
}

/// The five owner-only bands. This is the entire vocabulary the player ever sees for S.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Band {
    /// `< 0.28` — psi: RwwQuery; the reincarnation planner offers rarer packets.
    Quiet,
    /// `0.28–0.42` — psi: PastShared, FutureIsland; Academy faculty verbs.
    Coherent,
    /// `0.42–0.58` — psi: PastOwn + FutureSelf. The default new-player band.
    Settled,
    /// `0.58–0.72` — psi: PastOwn only.
    Restless,
    /// `≥ 0.72` — psi budget near zero; NPMR visas denied.
    Turbulent,
}

impl Band {
    /// The band containing `s`.
    #[must_use]
    pub fn of(s: QualityScalar) -> Self {
        if s >= 0.72 {
            Self::Turbulent
        } else if s >= 0.58 {
            Self::Restless
        } else if s >= 0.42 {
            Self::Settled
        } else if s >= 0.28 {
            Self::Coherent
        } else {
            Self::Quiet
        }
    }

    /// The name shown to the owner. Never a number, never a comparison.
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::Quiet => "Quiet",
            Self::Coherent => "Coherent",
            Self::Settled => "Settled",
            Self::Restless => "Restless",
            Self::Turbulent => "Turbulent",
        }
    }
}

/// Who an action landed on. Harm to an unwarded AI Guy is zero on this axis: AI Guys have
/// no FWAU, and pretending otherwise would make "be evil for roleplay" a ledger event.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TargetKind {
    /// Driven by an IUOC.
    Iuoc,
    /// An AI Guy. No FWAU, no harm axis.
    AiGuy,
    /// A flagged ward: an AI Guy whose harm does count.
    WardedAiGuy,
}

/// The feature detectors' output for one resolved action (§8). Each is in `[0, 1]`.
#[derive(Clone, Copy, Default, PartialEq, Debug)]
pub struct Features {
    /// Help the target actually asked for.
    pub aid: f32,
    /// Unconsented harm, deception included.
    pub harm: f32,
    /// Benefit captured versus given, inside a 10-minute window.
    pub ego: f32,
    /// Threat, hostage-taking, "be nice or else".
    pub coercion: f32,
    /// Audience sensitivity: witnesses versus beneficiaries.
    pub perf: f32,
}

impl Features {
    /// Clamp every feature into `[0, 1]`, which the formula assumes.
    #[must_use]
    pub fn clamped(self) -> Self {
        Self {
            aid: self.aid.clamp(0.0, 1.0),
            harm: self.harm.clamp(0.0, 1.0),
            ego: self.ego.clamp(0.0, 1.0),
            coercion: self.coercion.clamp(0.0, 1.0),
            perf: self.perf.clamp(0.0, 1.0),
        }
    }
}

/// `log(1 + witnesses) / log(1 + beneficiaries)`, squashed to `[0, 1]`.
///
/// Farming applause is low-quality consciousness — and it is the anti-pattern every karma
/// system dies to, so it is a first-class term rather than a later patch.
#[must_use]
pub fn audience_sensitivity(witnesses: u32, beneficiaries: u32) -> f32 {
    let w = (1.0 + f64::from(witnesses)).ln();
    let b = (1.0 + f64::from(beneficiaries)).ln();
    if w <= 0.0 {
        return 0.0;
    }
    if b <= 0.0 {
        return 1.0;
    }
    let ratio = w / b;
    // Squash: 1 witness per beneficiary is not performance; a crowd is.
    ((ratio - 1.0) / (1.0 + (ratio - 1.0).abs())).clamp(0.0, 1.0) as f32
}

/// Harm as the ledger sees it: zero against an unwarded AI Guy.
#[must_use]
pub fn unconsented_harm(raw_harm: f32, target: TargetKind, consented: bool) -> f32 {
    if consented || target == TargetKind::AiGuy {
        0.0
    } else {
        raw_harm.clamp(0.0, 1.0)
    }
}

/// Reciprocity decay against love-farming: A↔B aid decays by 0.7 per cycle after 3.
#[derive(Clone, Default, Debug)]
pub struct ReciprocityTracker {
    cycles: HashMap<(IuocId, IuocId), u32>,
}

impl ReciprocityTracker {
    /// An empty tracker.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Record an aid cycle between two IUOCs and return the multiplier that applies to it.
    ///
    /// The pair is unordered: healing each other in a closet is the same loop whichever
    /// way round it runs.
    pub fn record_aid(&mut self, a: IuocId, b: IuocId) -> f32 {
        let key = if a <= b { (a, b) } else { (b, a) };
        let count = self.cycles.entry(key).or_insert(0);
        *count += 1;
        Self::multiplier(*count)
    }

    /// The multiplier for the `n`-th cycle: 1.0 for the first three, then 0.7 per cycle.
    #[must_use]
    pub fn multiplier(cycle: u32) -> f32 {
        if cycle <= 3 {
            1.0
        } else {
            0.7f32.powi((cycle - 3) as i32)
        }
    }

    /// Cycles recorded for a pair.
    #[must_use]
    pub fn cycles(&self, a: IuocId, b: IuocId) -> u32 {
        let key = if a <= b { (a, b) } else { (b, a) };
        self.cycles.get(&key).copied().unwrap_or(0)
    }
}

/// A scored consequence waiting out its delay.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct PendingDelta {
    /// Whose ledger it lands on. The IUOC, never the avatar — reincarnation cannot wash S.
    pub actor: IuocId,
    /// The signed delta, already noised and clamped.
    pub delta: f32,
    /// When it lands.
    pub due: Tick,
    /// The action that caused it.
    pub src: ActionId,
    /// The epoch whose coefficients scored it. Retuning does not rewrite this.
    pub epoch: u32,
}

/// A landed delta, handed back to the caller so it can send the owner a non-specific ping.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct SettledEvent {
    /// Whose ledger moved.
    pub actor: IuocId,
    /// The event id.
    pub id: EventId,
    /// The band after the delta landed. The delta itself is not in this struct on purpose.
    pub band: Band,
}

/// The ledger.
///
/// `pending` is a `BTreeMap` keyed by `(due, id)`: due-ordered iteration is the whole
/// access pattern, and the id breaks ties deterministically so two runs of the same seed
/// flush in the same order.
#[derive(Clone, Debug)]
pub struct EntropyLedger {
    s: HashMap<IuocId, QualityScalar>,
    pending: BTreeMap<(Tick, EventId), PendingDelta>,
    coefficients: Coefficients,
    next_event: u64,
}

impl EntropyLedger {
    /// A ledger running `coefficients`.
    #[must_use]
    pub fn new(coefficients: Coefficients) -> Self {
        Self {
            s: HashMap::new(),
            pending: BTreeMap::new(),
            coefficients,
            next_event: 0,
        }
    }

    /// A ledger at `ledger_epoch 0`.
    #[must_use]
    pub fn epoch_0() -> Self {
        Self::new(Coefficients::EPOCH_0)
    }

    /// The active coefficients.
    #[must_use]
    pub const fn coefficients(&self) -> Coefficients {
        self.coefficients
    }

    /// Ship new coefficients as a new epoch.
    ///
    /// Deltas already enqueued keep the epoch that scored them and land unchanged. The
    /// past is not rewritten — that is the whole rule, and it is enforced here rather than
    /// in a runbook.
    ///
    /// # Panics
    /// If the new epoch does not advance, which would make ledger history ambiguous.
    pub fn retune(&mut self, next: Coefficients) {
        assert!(
            next.epoch > self.coefficients.epoch,
            "coefficient changes ship as a new ledger_epoch; never as an in-place edit"
        );
        self.coefficients = next;
    }

    /// The raw scalar.
    ///
    /// Named for the rule it carries: this float is ledger-process-only. It must not be
    /// replicated, logged next to a player name, exposed to a client, or sorted. The
    /// player-facing accessor is [`EntropyLedger::band_of`].
    #[must_use]
    pub fn s_private(&self, actor: IuocId) -> QualityScalar {
        self.s.get(&actor).copied().unwrap_or(S_INIT)
    }

    /// The owner-facing band. This is the only S-derived value allowed to leave the process,
    /// and only to its owner (or to a group the owner has consented to share it with).
    #[must_use]
    pub fn band_of(&self, actor: IuocId) -> Band {
        Band::of(self.s_private(actor))
    }

    /// Score a resolved action and enqueue its consequence. Returns the event id.
    ///
    /// The delta is **not** applied this tick, and the caller is given no way to apply it
    /// early. O(log P) in pending events.
    pub fn apply_consequence(
        &mut self,
        actor: IuocId,
        src: ActionId,
        features: Features,
        now: Tick,
        rng: &mut Pcg64,
    ) -> EventId {
        let c = self.coefficients;
        let f = features.clamped();
        let raw = -c.eta_aid * f.aid * (1.0 - f.perf)
            + c.eta_harm * f.harm
            + c.eta_ego * f.ego
            + c.eta_coerce * f.coercion;
        let noisy = (raw + rng.gaussian(0.0, c.sigma)).clamp(-c.clamp, c.clamp);
        let delay = rng.uniform_u64(c.delay_min_ticks, c.delay_max_ticks);
        self.enqueue(actor, noisy, now.plus(delay), src)
    }

    /// Enqueue an already-scored delta. O(log P).
    pub fn enqueue(&mut self, actor: IuocId, delta: f32, due: Tick, src: ActionId) -> EventId {
        let id = EventId(self.next_event);
        self.next_event += 1;
        self.pending.insert(
            (due, id),
            PendingDelta {
                actor,
                delta,
                due,
                src,
                epoch: self.coefficients.epoch,
            },
        );
        id
    }

    /// Apply every delta due at or before `now`. O(k + log P) for k due.
    ///
    /// Called by a background worker. Never by the 20 Hz loop: a ledger flush on the sim
    /// tick would put the slow teacher back on the fast feedback path.
    pub fn flush_due(&mut self, now: Tick) -> Vec<SettledEvent> {
        let due_keys: Vec<(Tick, EventId)> = self
            .pending
            .range(..=(now, EventId(u64::MAX)))
            .map(|(k, _)| *k)
            .collect();

        let mut settled = Vec::with_capacity(due_keys.len());
        for key in due_keys {
            let Some(ev) = self.pending.remove(&key) else {
                continue;
            };
            let s = self.s_private(ev.actor);
            let next = (s + ev.delta).clamp(0.0, 1.0);
            self.s.insert(ev.actor, next);
            settled.push(SettledEvent {
                actor: ev.actor,
                id: key.1,
                band: Band::of(next),
            });
        }
        settled
    }

    /// Events still waiting out their delay.
    #[must_use]
    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }

    /// A pending event, for tests and GM tooling.
    #[must_use]
    pub fn pending_event(&self, id: EventId) -> Option<PendingDelta> {
        self.pending
            .iter()
            .find(|((_, k), _)| *k == id)
            .map(|(_, v)| *v)
    }

    /// How many IUOCs this ledger has ever moved.
    #[must_use]
    pub fn tracked_iuocs(&self) -> usize {
        self.s.len()
    }
}

// Guardrails, stated where they can be checked in review (§8, §13):
//
// * There is no `fn ranking()`, no `fn top_n()`, no `Ord` on `QualityScalar` exposed for
//   sorting IUOCs, and no iterator over `(IuocId, QualityScalar)` pairs. A public
//   leaderboard cannot be built from this API without adding one — and adding one is the
//   design failure, not the omission.
// * There is no `flush_now`, `apply_immediately`, or delay override. The delay is the
//   mechanism; a knob to skip it is a knob to destroy the system.
// * `SettledEvent` carries a band, not a delta, so the owner's ping can say "something
//   settled" and nothing more precise.
