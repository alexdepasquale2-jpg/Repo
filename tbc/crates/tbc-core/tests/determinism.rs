//! The determinism harness: same seed → identical sequence.
//!
//! Determinism is not a nicety here. Rewind-replay (M4), the anti-cheat oracle, and two
//! observers arriving at a sleeping entity on the same tick all assume the authority step
//! is a pure function of `(snapshot, intent set, rng_seed)`.

use tbc_core::beam::{IntentField, ProbabilitySurface};
use tbc_core::ids::{ActionId, FrameId, IslandId, IuocId, Tick};
use tbc_core::ledger::{EntropyLedger, Features};
use tbc_core::rng::{Pcg64, island_seed};
use tbc_core::toy::{PeakedSim, ToyState};

/// Run a small island for `ticks` and return a checksum of every resolved present.
fn run(genesis: u128, ticks: u64) -> u64 {
    let sim = PeakedSim::default();
    let mut trace: u64 = 0;
    let mut present = ToyState::default();
    for t in 0..ticks {
        let seed = island_seed(FrameId(0), IslandId(3), Tick(t), genesis);
        let mut surface = ProbabilitySurface::new(IslandId(3), present, Pcg64::new(seed));
        surface.advance(&sim, &IntentField::new());
        present = surface
            .observe()
            .expect("beam never empties in this ruleset");
        trace = trace
            .rotate_left(7)
            .wrapping_add(present.checksum())
            .wrapping_mul(0x1000_0000_01b3);
    }
    trace
}

#[test]
fn same_seed_same_sequence() {
    let a = run(0xC0FF_EE00_1234, 240);
    let b = run(0xC0FF_EE00_1234, 240);
    println!("genesis 0xC0FFEE001234 → trace {a:#018x} (twice)");
    assert_eq!(a, b, "identical seeds must produce identical world lines");
}

#[test]
fn different_seed_different_sequence() {
    let a = run(0xC0FF_EE00_1234, 240);
    let b = run(0xC0FF_EE00_1235, 240);
    println!("neighbouring genesis seeds → {a:#018x} vs {b:#018x}");
    assert_ne!(a, b, "a one-bit genesis change must fork the world line");
}

#[test]
fn island_seeds_are_independent_and_stable() {
    let genesis = 0xABCD_u128;
    let a = island_seed(FrameId(0), IslandId(1), Tick(10), genesis);
    let again = island_seed(FrameId(0), IslandId(1), Tick(10), genesis);
    assert_eq!(a, again, "seed derivation is a pure function");

    // Adding an observer to island 2 cannot permute island 1's draws, because island 1's
    // generator never sees island 2's inputs.
    assert_ne!(a, island_seed(FrameId(0), IslandId(2), Tick(10), genesis));
    assert_ne!(a, island_seed(FrameId(0), IslandId(1), Tick(11), genesis));
    assert_ne!(a, island_seed(FrameId(1), IslandId(1), Tick(10), genesis));
}

#[test]
fn rng_streams_are_reproducible_and_independent() {
    let mut a = Pcg64::new(42);
    let mut b = Pcg64::new(42);
    let first: Vec<u64> = (0..64).map(|_| a.next_u64()).collect();
    let second: Vec<u64> = (0..64).map(|_| b.next_u64()).collect();
    assert_eq!(first, second);

    let mut other = Pcg64::with_stream(42, 7);
    let third: Vec<u64> = (0..64).map(|_| other.next_u64()).collect();
    assert_ne!(first, third, "different streams are independent sequences");

    // Uniform draws stay in range, and f32 draws stay in [0, 1).
    let mut rng = Pcg64::new(1);
    for _ in 0..10_000 {
        let v = rng.uniform_u64(10, 20);
        assert!((10..20).contains(&v));
        let f = rng.next_f32();
        assert!((0.0..1.0).contains(&f));
    }
}

#[test]
fn ledger_flush_order_is_deterministic() {
    let flush = |seed: u128| {
        let mut ledger = EntropyLedger::epoch_0();
        let mut rng = Pcg64::new(seed);
        for i in 0..64u64 {
            ledger.apply_consequence(
                IuocId(u128::from(i % 4)),
                ActionId(i),
                Features {
                    harm: 0.5,
                    aid: 0.2,
                    ..Features::default()
                },
                Tick(i),
                &mut rng,
            );
        }
        ledger
            .flush_due(Tick(1_000_000))
            .into_iter()
            .map(|e| (e.actor, e.id))
            .collect::<Vec<_>>()
    };

    let a = flush(0x5EED);
    let b = flush(0x5EED);
    assert_eq!(
        a, b,
        "due-ordered flush must not depend on hash iteration order"
    );
    assert_eq!(a.len(), 64);
}
