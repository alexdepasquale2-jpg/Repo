//! §8 and §13 as executable rules. Each test here is a product requirement, not a detail.

use tbc_core::ids::{ActionId, IuocId, Tick};
use tbc_core::ledger::{
    Band, Coefficients, EntropyLedger, Features, ReciprocityTracker, TargetKind,
    audience_sensitivity, unconsented_harm,
};
use tbc_core::rng::Pcg64;

#[test]
fn harming_an_ai_guy_is_not_a_ledger_event() {
    assert_eq!(unconsented_harm(1.0, TargetKind::AiGuy, false), 0.0);
    // Unless it is a flagged ward.
    assert_eq!(unconsented_harm(1.0, TargetKind::WardedAiGuy, false), 1.0);
    assert_eq!(unconsented_harm(1.0, TargetKind::Iuoc, false), 1.0);
    // Agreed combat — a PvP instance sets the consent flag at entry — is not harm.
    assert_eq!(unconsented_harm(1.0, TargetKind::Iuoc, true), 0.0);
}

#[test]
fn love_farming_decays() {
    let (a, b) = (IuocId(1), IuocId(2));
    let mut tracker = ReciprocityTracker::new();
    let multipliers: Vec<f32> = (0..6).map(|_| tracker.record_aid(a, b)).collect();
    println!("A↔B aid cycles → {multipliers:?}");
    assert_eq!(
        &multipliers[..3],
        &[1.0, 1.0, 1.0],
        "the first three cycles are free"
    );
    assert!((multipliers[3] - 0.7).abs() < 1e-6);
    assert!((multipliers[4] - 0.49).abs() < 1e-6);
    assert!((multipliers[5] - 0.343).abs() < 1e-6);

    // The pair is unordered: swapping who heals whom is the same closet.
    assert_eq!(tracker.cycles(b, a), 6);
}

#[test]
fn performative_charity_earns_nothing() {
    let intimate = audience_sensitivity(1, 1);
    let plaza = audience_sensitivity(200, 1);
    println!(
        "perf: 1 witness/1 beneficiary = {intimate:.3}; 200 witnesses/1 beneficiary = {plaza:.3}"
    );
    assert_eq!(
        intimate, 0.0,
        "a witness who is the beneficiary is not an audience"
    );
    assert!(plaza > 0.6, "a crowd is");

    let c = Coefficients::EPOCH_0;
    let mut ledger = EntropyLedger::new(Coefficients { sigma: 0.0, ..c });
    let mut rng = Pcg64::new(3);

    let quiet = IuocId(10);
    let showman = IuocId(11);
    ledger.apply_consequence(
        quiet,
        ActionId(1),
        Features {
            aid: 1.0,
            perf: intimate,
            ..Features::default()
        },
        Tick(0),
        &mut rng,
    );
    ledger.apply_consequence(
        showman,
        ActionId(2),
        Features {
            aid: 1.0,
            perf: plaza,
            ..Features::default()
        },
        Tick(0),
        &mut rng,
    );
    ledger.flush_due(Tick(c.delay_max_ticks));

    let quiet_gain = 0.5 - ledger.s_private(quiet);
    let showman_gain = 0.5 - ledger.s_private(showman);
    println!(
        "aid in private lowered S by {quiet_gain:.4}; the same aid in a plaza by {showman_gain:.4}"
    );
    assert!(quiet_gain > showman_gain * 2.0);
}

#[test]
fn coefficients_ship_as_a_new_epoch_and_never_rewrite_the_past() {
    let mut ledger = EntropyLedger::epoch_0();
    let mut rng = Pcg64::new(5);
    let actor = IuocId(1);
    let id = ledger.apply_consequence(
        actor,
        ActionId(1),
        Features {
            harm: 1.0,
            ..Features::default()
        },
        Tick(0),
        &mut rng,
    );
    let before = ledger.pending_event(id).expect("event is pending");
    assert_eq!(before.epoch, 0);

    ledger.retune(Coefficients {
        epoch: 1,
        eta_harm: 0.500,
        ..Coefficients::EPOCH_0
    });

    let after = ledger.pending_event(id).expect("event is still pending");
    assert_eq!(
        after, before,
        "an enqueued delta is history; retuning cannot touch it"
    );
    assert_eq!(ledger.coefficients().epoch, 1);

    // New events are scored under the new epoch.
    let next = ledger.apply_consequence(
        actor,
        ActionId(2),
        Features {
            harm: 1.0,
            ..Features::default()
        },
        Tick(0),
        &mut rng,
    );
    assert_eq!(ledger.pending_event(next).expect("pending").epoch, 1);
}

#[test]
#[should_panic(expected = "new ledger_epoch")]
fn retuning_in_place_is_refused() {
    let mut ledger = EntropyLedger::epoch_0();
    ledger.retune(Coefficients {
        eta_harm: 0.9,
        ..Coefficients::EPOCH_0
    });
}

#[test]
fn every_event_is_clamped_and_noisy() {
    let c = Coefficients::EPOCH_0;
    let mut ledger = EntropyLedger::epoch_0();
    let mut rng = Pcg64::new(11);

    // A maximal action on every axis at once, repeatedly.
    let mut deltas = Vec::new();
    for i in 0..500u64 {
        let actor = IuocId(u128::from(i));
        ledger.apply_consequence(
            actor,
            ActionId(i),
            Features {
                harm: 1.0,
                ego: 1.0,
                coercion: 1.0,
                ..Features::default()
            },
            Tick(0),
            &mut rng,
        );
        ledger.flush_due(Tick(c.delay_max_ticks));
        deltas.push(ledger.s_private(actor) - 0.5);
    }

    let max = deltas.iter().copied().fold(f32::MIN, f32::max);
    let min = deltas.iter().copied().fold(f32::MAX, f32::min);
    println!(
        "500 maximal events: ΔS ∈ [{min:+.4}, {max:+.4}], clamp ±{}",
        c.clamp
    );
    assert!(max <= c.clamp + 1e-6, "the per-event cap holds");
    assert!(
        min < max,
        "noise means two identical actions do not score identically"
    );
    assert!(min > 0.0, "harm still raises S despite the noise");
}

#[test]
fn s_is_bounded_and_survives_the_avatar() {
    let mut ledger = EntropyLedger::epoch_0();
    let actor = IuocId(77);
    for i in 0..200u64 {
        ledger.enqueue(actor, 0.15, Tick(i), ActionId(i));
    }
    ledger.flush_due(Tick(1_000));
    assert_eq!(ledger.s_private(actor), 1.0, "S saturates at 1.0");
    assert_eq!(ledger.band_of(actor), Band::Turbulent);

    for i in 0..200u64 {
        ledger.enqueue(actor, -0.15, Tick(2_000 + i), ActionId(i));
    }
    ledger.flush_due(Tick(3_000));
    assert_eq!(ledger.s_private(actor), 0.0);
    assert_eq!(ledger.band_of(actor), Band::Quiet);

    // The ledger is keyed by IUOC. There is no avatar in this API to reset.
    assert_eq!(ledger.tracked_iuocs(), 1);
}

#[test]
fn bands_match_the_published_table() {
    for (s, expected) in [
        (0.00, Band::Quiet),
        (0.2799, Band::Quiet),
        (0.28, Band::Coherent),
        (0.4199, Band::Coherent),
        (0.42, Band::Settled),
        (0.5799, Band::Settled),
        (0.58, Band::Restless),
        (0.7199, Band::Restless),
        (0.72, Band::Turbulent),
        (1.00, Band::Turbulent),
    ] {
        assert_eq!(Band::of(s), expected, "S={s}");
    }
    // A new IUOC starts in the default band.
    assert_eq!(Band::of(tbc_core::ledger::S_INIT), Band::Settled);
}

#[test]
fn nothing_flushes_twice() {
    let mut ledger = EntropyLedger::epoch_0();
    ledger.enqueue(IuocId(1), 0.1, Tick(5), ActionId(1));
    assert_eq!(ledger.flush_due(Tick(10)).len(), 1);
    assert_eq!(ledger.flush_due(Tick(10)).len(), 0);
    assert_eq!(ledger.pending_len(), 0);
    assert!((ledger.s_private(IuocId(1)) - 0.6).abs() < 1e-6);
}
