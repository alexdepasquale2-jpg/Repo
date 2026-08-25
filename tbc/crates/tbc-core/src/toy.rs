//! A toy island, so the beam has something to branch over at M1.
//!
//! Demonstration only: four entities on a line, six verbs, no ECS. It exists to make the
//! §7 numbers measurable and the determinism harness meaningful before the real ECS lands
//! at M3. Nothing here is canon.

use crate::beam::IslandSim;
use crate::rng::Pcg64;

/// The six verbs the toy ruleset allows. `A = 6` is the spec's action fanout.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ToyAction {
    /// Do nothing this Δt.
    Hold,
    /// Close distance.
    Advance,
    /// Open distance.
    Retreat,
    /// Damage the nearest other body.
    Strike,
    /// Heal the nearest other body.
    Aid,
    /// Say something. Free in PMR, load-bearing for the coercion detector.
    Speak,
}

/// Every toy verb, in a fixed order. Fixed order is a determinism requirement.
pub const TOY_ACTIONS: [ToyAction; 6] = [
    ToyAction::Hold,
    ToyAction::Advance,
    ToyAction::Retreat,
    ToyAction::Strike,
    ToyAction::Aid,
    ToyAction::Speak,
];

/// Four bodies on a line.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct ToyState {
    /// Position of each body, in decimetres so the state stays integral.
    pub pos: [i32; 4],
    /// Hit points.
    pub hp: [i16; 4],
    /// Ticks simulated.
    pub tick: u32,
}

impl Default for ToyState {
    fn default() -> Self {
        Self {
            pos: [0, 40, -40, 120],
            hp: [100; 4],
            tick: 0,
        }
    }
}

impl ToyState {
    /// A checksum, so two runs can be compared in one comparison.
    #[must_use]
    pub fn checksum(&self) -> u64 {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for v in self.pos {
            h = (h ^ v as u32 as u64).wrapping_mul(0x1000_0000_01b3);
        }
        for v in self.hp {
            h = (h ^ v as u16 as u64).wrapping_mul(0x1000_0000_01b3);
        }
        (h ^ u64::from(self.tick)).wrapping_mul(0x1000_0000_01b3)
    }
}

/// A flat ruleset: every legal action is equally likely.
///
/// This is NPMR-loose, and it is what the 768-step measurement runs on: with uniform
/// weights the beam stays saturated at B, so the count is the budget rather than a
/// coincidence of one distribution.
#[derive(Clone, Copy, Default, Debug)]
pub struct FlatSim;

/// A peaked ruleset: PMR-tight, where holding station is the likely thing to do.
#[derive(Clone, Copy, Debug)]
pub struct PeakedSim {
    /// Per-action likelihood, indexed like [`TOY_ACTIONS`].
    pub weights: [f32; 6],
}

impl Default for PeakedSim {
    fn default() -> Self {
        Self {
            weights: [0.90, 0.80, 0.70, 0.60, 0.60, 0.50],
        }
    }
}

fn toy_step(state: &ToyState, action: ToyAction) -> ToyState {
    let mut next = *state;
    next.tick += 1;
    match action {
        ToyAction::Hold | ToyAction::Speak => {}
        ToyAction::Advance => next.pos[0] += 5,
        ToyAction::Retreat => next.pos[0] -= 5,
        ToyAction::Strike => next.hp[1] = next.hp[1].saturating_sub(7),
        ToyAction::Aid => next.hp[1] = (next.hp[1] + 4).min(100),
    }
    next
}

impl IslandSim for FlatSim {
    type State = ToyState;
    type Action = ToyAction;

    fn sample_legal(&self, _state: &ToyState, fanout: usize, _rng: &mut Pcg64) -> Vec<ToyAction> {
        TOY_ACTIONS.iter().copied().take(fanout).collect()
    }

    fn step(&self, state: &ToyState, action: ToyAction) -> ToyState {
        toy_step(state, action)
    }

    fn p_ruleset(&self, _state: &ToyState, _action: ToyAction) -> f32 {
        1.0
    }
}

impl IslandSim for PeakedSim {
    type State = ToyState;
    type Action = ToyAction;

    fn sample_legal(&self, _state: &ToyState, fanout: usize, _rng: &mut Pcg64) -> Vec<ToyAction> {
        TOY_ACTIONS.iter().copied().take(fanout).collect()
    }

    fn step(&self, state: &ToyState, action: ToyAction) -> ToyState {
        toy_step(state, action)
    }

    fn p_ruleset(&self, _state: &ToyState, action: ToyAction) -> f32 {
        let index = TOY_ACTIONS
            .iter()
            .position(|a| *a == action)
            .unwrap_or(TOY_ACTIONS.len() - 1);
        self.weights[index]
    }
}
