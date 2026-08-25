//! Δt: the quantum of time (§5).
//!
//! Time is an integer. There is no variable-dt authority step: the loop is fixed-timestep
//! with an accumulator, and frames nest so a dream can run at a different rate from its
//! parent. Wall clock enters exactly one function — [`DeltaTClock::drain`] — and never a
//! step function.

use core::time::Duration;

use crate::ids::{FrameId, Tick};
use crate::spec::MAX_CATCHUP;

/// A fixed-timestep clock for one frame.
#[derive(Clone, Debug)]
pub struct DeltaTClock {
    dt: Duration,
    tick: Tick,
    acc: Duration,
    max_catchup: u32,
    stalls: u64,
    dropped: Duration,
}

impl DeltaTClock {
    /// A clock at tick 0 with the default catch-up cap of 4.
    #[must_use]
    pub fn new(dt: Duration) -> Self {
        Self {
            dt,
            tick: Tick(0),
            acc: Duration::ZERO,
            max_catchup: MAX_CATCHUP,
            stalls: 0,
            dropped: Duration::ZERO,
        }
    }

    /// Override the catch-up cap. Raising it trades a freeze for a desync risk; the
    /// spec's answer is 4 and a stall metric.
    #[must_use]
    pub fn with_max_catchup(mut self, max_catchup: u32) -> Self {
        self.max_catchup = max_catchup;
        self
    }

    /// Fold `elapsed` wall time into the accumulator and return how many ticks are owed.
    ///
    /// Steps up to `max_catchup` ticks in one wall slice. Beyond that it **drops time** —
    /// not ticks-to-skip-without-stepping, which would desync snapshots, and not unbounded
    /// catch-up, which would freeze the process. A stall is a first-class metric: two
    /// consecutive stalls trip an auto-split on a spatially splittable shard.
    ///
    /// O(1): the loop body is bounded by `max_catchup`.
    pub fn drain(&mut self, elapsed: Duration) -> u32 {
        self.acc += elapsed;
        let mut steps = 0;
        while self.acc >= self.dt && steps < self.max_catchup {
            self.tick = self.tick.next();
            self.acc -= self.dt;
            steps += 1;
        }
        if steps == self.max_catchup && self.acc >= self.dt {
            self.stalls += 1;
            self.dropped += self.acc;
            self.acc = Duration::ZERO;
        }
        steps
    }

    /// This frame's Δt.
    #[must_use]
    pub const fn dt(&self) -> Duration {
        self.dt
    }

    /// Ticks per wall second, rounded.
    #[must_use]
    pub fn hz(&self) -> u32 {
        (1.0 / self.dt.as_secs_f64()).round() as u32
    }

    /// The current tick.
    #[must_use]
    pub const fn tick(&self) -> Tick {
        self.tick
    }

    /// Unspent time in the accumulator.
    #[must_use]
    pub const fn accumulator(&self) -> Duration {
        self.acc
    }

    /// How many times this clock has overrun its catch-up budget.
    #[must_use]
    pub const fn stalls(&self) -> u64 {
        self.stalls
    }

    /// Total wall time dropped by stalls. Ticks are never dropped, only time.
    #[must_use]
    pub const fn dropped(&self) -> Duration {
        self.dropped
    }
}

/// A child frame's rate relative to its parent: `n` child ticks per `k` parent ticks.
///
/// NPMR-Academy is `n=1, k=1` with a longer Δt (wall-slower). A dream nested in the
/// Academy is `n=4, k=1` — subjectively faster.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Dilation {
    /// Child ticks granted per window.
    pub n: u32,
    /// Parent ticks per window.
    pub k: u32,
}

impl Dilation {
    /// A dilation of `n` child ticks per `k` parent ticks.
    ///
    /// # Panics
    /// If either side is zero.
    #[must_use]
    pub const fn new(n: u32, k: u32) -> Self {
        assert!(
            n > 0 && k > 0,
            "a dilation of zero would stop the child frame"
        );
        Self { n, k }
    }

    /// Subjective rate: > 1 runs faster than the parent, < 1 slower.
    #[must_use]
    pub fn ratio(self) -> f64 {
        f64::from(self.n) / f64::from(self.k)
    }
}

/// A frame clock scheduled from its parent (§5, nested clocks).
///
/// The child is not driven by wall time; it is driven by its parent's ticks. That is what
/// makes a portal crossing land on a whole tick on both sides.
#[derive(Clone, Debug)]
pub struct NestedClock {
    frame: FrameId,
    clock: DeltaTClock,
    dilation: Dilation,
    parent_in_window: u32,
}

impl NestedClock {
    /// A child frame running at `dt`, granted `dilation` by its parent.
    #[must_use]
    pub fn new(frame: FrameId, dt: Duration, dilation: Dilation) -> Self {
        Self {
            frame,
            clock: DeltaTClock::new(dt),
            dilation,
            parent_in_window: 0,
        }
    }

    /// Advance by `parent_ticks` of the parent frame; returns the child ticks stepped.
    ///
    /// The child is granted `n` ticks each time `k` parent ticks complete, so the grant
    /// lands on a parent tick edge and never mid-tick.
    pub fn on_parent_ticks(&mut self, parent_ticks: u32) -> u32 {
        let mut stepped = 0;
        for _ in 0..parent_ticks {
            self.parent_in_window += 1;
            if self.parent_in_window == self.dilation.k {
                self.parent_in_window = 0;
                for _ in 0..self.dilation.n {
                    self.clock.drain(self.clock.dt());
                    stepped += 1;
                }
            }
        }
        stepped
    }

    /// Whether an entity may be handed off to or from this frame right now.
    ///
    /// Crossing a frame always happens on a parent tick boundary, so no fractional-tick
    /// entities exist.
    #[must_use]
    pub const fn handoff_allowed(&self) -> bool {
        self.parent_in_window == 0
    }

    /// This child's local tick expressed in parent units: `parent.tick + child.local / n`.
    #[must_use]
    pub fn now_in_parent_units(&self, parent: Tick) -> f64 {
        let local_in_window = self.clock.tick().0 % u64::from(self.dilation.n);
        parent.0 as f64 + local_in_window as f64 / f64::from(self.dilation.n)
    }

    /// The frame this clock belongs to.
    #[must_use]
    pub const fn frame(&self) -> FrameId {
        self.frame
    }

    /// The child's own clock.
    #[must_use]
    pub const fn clock(&self) -> &DeltaTClock {
        &self.clock
    }

    /// The dilation this child was granted.
    #[must_use]
    pub const fn dilation(&self) -> Dilation {
        self.dilation
    }
}
