//! §5: the accumulator, and frames nested inside frames.

use std::time::Duration;

use tbc_core::delta_t::{DeltaTClock, Dilation, NestedClock};
use tbc_core::ids::{FrameId, Tick};
use tbc_core::spec;

#[test]
fn the_accumulator_never_loses_a_partial_tick() {
    let mut clock = DeltaTClock::new(spec::PMR_PRIME_DT);
    // Ten passes of 30 ms is 300 ms: six ticks, nothing dropped.
    let mut stepped = 0;
    for _ in 0..10 {
        stepped += clock.drain(Duration::from_millis(30));
    }
    assert_eq!(stepped, 6);
    assert_eq!(clock.tick(), Tick(6));
    assert_eq!(clock.accumulator(), Duration::ZERO);
    assert_eq!(clock.stalls(), 0);
}

#[test]
fn overload_drops_time_not_ticks() {
    let mut clock = DeltaTClock::new(spec::PMR_PRIME_DT);
    let before = clock.tick();
    clock.drain(Duration::from_secs(10));
    assert_eq!(clock.tick().since(before), u64::from(spec::MAX_CATCHUP));
    assert_eq!(clock.stalls(), 1);
    assert!(clock.dropped() >= Duration::from_millis(9_800));

    // Recovery is immediate: the next normal slice steps exactly one tick.
    assert_eq!(clock.drain(spec::PMR_PRIME_DT), 1);
    assert_eq!(clock.stalls(), 1);
}

#[test]
fn a_dream_runs_four_ticks_per_parent_tick() {
    let mut dream = NestedClock::new(FrameId(2), spec::NPMR_ACADEMY_DT, Dilation::new(4, 1));
    assert_eq!(dream.on_parent_ticks(1), 4);
    assert_eq!(dream.on_parent_ticks(3), 12);
    assert_eq!(dream.clock().tick(), Tick(16));
    assert!((dream.dilation().ratio() - 4.0).abs() < f64::EPSILON);
    println!(
        "dream: 4 parent ticks → {} child ticks",
        dream.clock().tick().0
    );
}

#[test]
fn a_slow_frame_waits_for_its_window() {
    // One child tick per four parent ticks: a lounge that refuses to cost 20 Hz.
    let mut slow = NestedClock::new(FrameId(3), spec::NPMR_ACADEMY_DT, Dilation::new(1, 4));
    assert_eq!(slow.on_parent_ticks(1), 0);
    assert!(
        !slow.handoff_allowed(),
        "mid-window, a crossing would be fractional"
    );
    assert_eq!(slow.on_parent_ticks(3), 1);
    assert!(
        slow.handoff_allowed(),
        "the window closed on a parent tick edge"
    );
    assert_eq!(slow.clock().tick(), Tick(1));
}

#[test]
fn child_time_reads_back_in_parent_units() {
    let mut dream = NestedClock::new(FrameId(2), spec::NPMR_ACADEMY_DT, Dilation::new(4, 1));
    dream.on_parent_ticks(1);
    // Four child ticks completed inside parent tick 0: the window is closed again.
    assert!((dream.now_in_parent_units(Tick(1)) - 1.0).abs() < f64::EPSILON);
    assert!(dream.handoff_allowed());
}

#[test]
fn the_academy_is_the_spec_configuration() {
    let academy = NestedClock::new(FrameId(1), spec::NPMR_ACADEMY_DT, Dilation::new(1, 1));
    assert_eq!(academy.clock().dt(), Duration::from_millis(200));
    assert_eq!(academy.clock().hz(), spec::NPMR_ACADEMY_HZ);
    assert_eq!(academy.dilation(), Dilation::new(1, 1));
    assert_eq!(academy.frame(), FrameId(1));
}
