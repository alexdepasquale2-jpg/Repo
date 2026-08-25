//! The M1 acceptance test: print the numbers in the specification, and make them true.
//!
//! Run with output:
//!
//! ```text
//! cargo test --test spec_numbers -- --nocapture
//! ```

use std::time::Duration;

use tbc_core::beam::{Branch, IntentField, ProbabilitySurface};
use tbc_core::delta_t::DeltaTClock;
use tbc_core::grid::{LEVEL_INTEREST, MoveOutcome, cell_of, neighborhood};
use tbc_core::ids::{ActionId, Entity, IslandId, IuocId, Tick};
use tbc_core::ledger::{Band, Coefficients, EntropyLedger, Features};
use tbc_core::math::Vec3;
use tbc_core::rng::Pcg64;
use tbc_core::spec;
use tbc_core::toy::{FlatSim, ToyAction, ToyState};

/// A saturated island beam costs exactly `D · B · A` = 768 `step()` calls per tick.
#[test]
fn beam_costs_768_steps_per_island_per_tick() {
    println!("\n=== §7  Intent-biased beam prune ===");
    println!(
        "B (beam width)     = {}\nA (action fanout)  = {}\nD (depth, ticks)   = {}  ({} ms at {} Hz)",
        spec::BEAM_WIDTH_B,
        spec::ACTION_FANOUT_A,
        spec::DEPTH_D,
        spec::DEPTH_D as u64 * spec::PMR_PRIME_DT.as_millis() as u64,
        spec::PMR_PRIME_HZ
    );
    println!("ε (prune floor)    = {:e}", spec::PRUNE_FLOOR_EPS);
    println!(
        "D · B · A          = {} step() calls per island per tick",
        spec::STEPS_PER_ISLAND_PER_TICK
    );

    // Steady state: the island already holds a saturated beam of B branches.
    let mut surface = ProbabilitySurface::new(IslandId(0), ToyState::default(), Pcg64::new(1));
    surface.seed_beam(
        (0..spec::BEAM_WIDTH_B)
            .map(|_| Branch {
                state: ToyState::default(),
                weight: 1.0,
                path: Vec::new(),
            })
            .collect(),
    );
    surface.advance(&FlatSim, &IntentField::new());

    println!(
        "saturated advance  = {} step() calls",
        surface.steps_last_advance()
    );
    assert_eq!(
        surface.steps_last_advance() as usize,
        spec::STEPS_PER_ISLAND_PER_TICK,
        "a saturated beam must cost exactly the budget"
    );
    assert_eq!(surface.len(), spec::BEAM_WIDTH_B, "top_B keeps B branches");

    // Cold start from a single committed present: the first two depths cannot saturate,
    // so a from-scratch rebuild costs less than the budget. 6 + 36 + 6·96 = 618.
    let mut cold = ProbabilitySurface::new(IslandId(0), ToyState::default(), Pcg64::new(1));
    cold.advance(&FlatSim, &IntentField::new());
    let expected_cold = spec::ACTION_FANOUT_A
        + spec::ACTION_FANOUT_A * spec::ACTION_FANOUT_A
        + (spec::DEPTH_D - 2) * spec::BEAM_WIDTH_B * spec::ACTION_FANOUT_A;
    println!(
        "cold-start advance = {} step() calls (ramping 1 → 6 → 16 branches)",
        cold.steps_last_advance()
    );
    assert_eq!(cold.steps_last_advance() as usize, expected_cold);
    assert!(cold.steps_last_advance() as usize <= spec::STEPS_PER_ISLAND_PER_TICK);

    // Shard budget at the spec's island count.
    let per_tick = spec::STEPS_PER_ISLAND_PER_TICK * spec::ISLANDS_PER_SHARD;
    println!(
        "{} islands          = {} steps/tick ≈ {} steps/s at {} Hz",
        spec::ISLANDS_PER_SHARD,
        per_tick,
        per_tick * spec::PMR_PRIME_HZ as usize,
        spec::PMR_PRIME_HZ
    );
    assert_eq!(per_tick, 30_720);
    assert_eq!(per_tick * spec::PMR_PRIME_HZ as usize, 614_400);
}

/// A move inside its cell touches nothing; a crossing touches exactly two cells — and
/// neither figure changes as the world fills up.
#[test]
fn grid_cell_move_is_o1() {
    println!("\n=== §4  Hierarchical spatial hash ===");
    println!(
        "levels             = {:?} m (3×3 = {} cells, 3×3×3 = {} if flying)",
        spec::CELL_SIZE_M,
        neighborhood(cell_of(Vec3::ZERO, 0), false).len(),
        neighborhood(cell_of(Vec3::ZERO, 0), true).len()
    );

    let mut measurements = Vec::new();
    for population in [1_000u32, 10_000, 100_000] {
        let mut grid = tbc_core::grid::HierGrid::new();
        for i in 0..population {
            let p = Vec3::new((i % 400) as f32 * 37.0, 0.0, (i / 400) as f32 * 37.0);
            grid.insert(cell_of(p, LEVEL_INTEREST), Entity::new(i, 1));
        }
        let subject = Entity::new(0, 1);
        grid.reset_stats();

        // 1 000 moves that stay inside one 128 m cell.
        let mut p = Vec3::new(4.0, 0.0, 4.0);
        for _ in 0..1_000 {
            let next = Vec3::new(p.x + 0.05, 0.0, p.z);
            assert_eq!(
                grid.on_move(subject, p, next, LEVEL_INTEREST),
                MoveOutcome::CellLocal
            );
            p = next;
        }
        let local_ops = grid.stats().cell_ops();

        // One move across the boundary.
        grid.reset_stats();
        let across = Vec3::new(200.0, 0.0, 4.0);
        assert!(matches!(
            grid.on_move(subject, p, across, LEVEL_INTEREST),
            MoveOutcome::Crossed { .. }
        ));
        let cross_ops = grid.stats().cell_ops();

        println!(
            "{population:>7} entities   : 1000 cell-local moves = {local_ops} cell ops, 1 crossing = {cross_ops} cell ops"
        );
        measurements.push((local_ops, cross_ops));
    }

    for (local_ops, cross_ops) in measurements {
        assert_eq!(local_ops, 0, "a cell-local move must not touch the map");
        assert_eq!(
            cross_ops, 2,
            "a crossing is exactly one remove + one insert"
        );
    }
    println!("cost is flat in population — O(1) expected, no periodic rebuild");
}

/// ΔS is enqueued, not applied: nothing lands for at least ten minutes of playtime.
#[test]
fn ledger_delta_s_is_delayed() {
    println!("\n=== §8  EntropyLedger ===");
    let c = Coefficients::EPOCH_0;
    println!(
        "ledger_epoch       = {}\nη_aid / η_harm     = {} / {}\nη_ego / η_coerce   = {} / {}\nσ (noise)          = {}\nclamp per event    = ±{}",
        c.epoch, c.eta_aid, c.eta_harm, c.eta_ego, c.eta_coerce, c.sigma, c.clamp
    );
    println!(
        "delay window       = {} … {} ticks = {:.0} min … {:.0} h of playtime",
        c.delay_min_ticks,
        c.delay_max_ticks,
        c.delay_min_ticks as f64 / f64::from(spec::PMR_PRIME_HZ) / 60.0,
        c.delay_max_ticks as f64 / f64::from(spec::PMR_PRIME_HZ) / 3600.0
    );
    assert_eq!(c.delay_min_ticks, 10 * 60 * u64::from(spec::PMR_PRIME_HZ));
    assert_eq!(c.delay_max_ticks, 6 * 3600 * u64::from(spec::PMR_PRIME_HZ));

    let mut ledger = EntropyLedger::epoch_0();
    let mut rng = Pcg64::new(0xDEAD_BEEF);
    let actor = IuocId(1);
    let before = ledger.s_private(actor);

    ledger.apply_consequence(
        actor,
        ActionId(1),
        Features {
            harm: 1.0,
            ..Features::default()
        },
        Tick(0),
        &mut rng,
    );

    assert_eq!(ledger.pending_len(), 1);
    assert!(
        ledger.flush_due(Tick(c.delay_min_ticks - 1)).is_empty(),
        "nothing may land before the delay window opens"
    );
    assert_eq!(
        ledger.s_private(actor),
        before,
        "S must not move on the tick the action resolved"
    );

    let settled = ledger.flush_due(Tick(c.delay_max_ticks));
    assert_eq!(settled.len(), 1);
    let after = ledger.s_private(actor);
    println!(
        "one maximal-harm event: S {before:.3} → {after:.3} (ΔS = {:+.3}), owner is told only \"{}\"",
        after - before,
        settled[0].band.label()
    );
    assert!(after > before, "unconsented harm raises S");
    assert!((after - before).abs() <= c.clamp + f32::EPSILON);

    println!("bands (owner-only) :");
    for s in [0.20f32, 0.35, 0.50, 0.65, 0.80] {
        println!("  S={s:.2} → {}", Band::of(s).label());
    }
}

/// The Δt table, the accumulator, and the catch-up cap.
#[test]
fn delta_t_tick_rates_and_catchup() {
    println!("\n=== §5  Δt ===");
    for (name, dt, hz) in [
        ("PMR-Prime", spec::PMR_PRIME_DT, spec::PMR_PRIME_HZ),
        ("PvP instance", spec::PVP_DT, spec::PVP_HZ),
        ("NPMR-Academy", spec::NPMR_ACADEMY_DT, spec::NPMR_ACADEMY_HZ),
    ] {
        let clock = DeltaTClock::new(dt);
        println!("{name:<14} Δt = {dt:>8.3?} → {hz:>2} Hz");
        assert_eq!(clock.hz(), hz);
    }

    let mut clock = DeltaTClock::new(spec::PMR_PRIME_DT);
    assert_eq!(clock.drain(Duration::from_millis(120)), 2);
    assert_eq!(clock.accumulator(), Duration::from_millis(20));

    // A one-second hitch: 20 ticks are owed, 4 may be repaid, the rest is dropped time.
    let steps = clock.drain(Duration::from_millis(1_000));
    println!(
        "1 000 ms hitch     : stepped {} (cap {}), stalls {}, dropped {:?} — time is dropped, never ticks",
        steps,
        spec::MAX_CATCHUP,
        clock.stalls(),
        clock.dropped()
    );
    assert_eq!(steps, spec::MAX_CATCHUP);
    assert_eq!(clock.stalls(), 1);
    assert_eq!(clock.accumulator(), Duration::ZERO);
}

/// Causality-island lookahead: `c_info · D · Δt` = 120 m, inside the 128 m interest radius.
#[test]
fn island_lookahead_is_120_metres() {
    let d = spec::lookahead_distance_m(spec::C_INFO_M_PER_S, spec::DEPTH_D, spec::PMR_PRIME_DT);
    println!(
        "\n=== §7  Causality islands ===\nc_info · D · Δt    = {} m/s × {} × {} s = {d} m (interest radius {} m)",
        spec::C_INFO_M_PER_S,
        spec::DEPTH_D,
        spec::PMR_PRIME_DT.as_secs_f32(),
        spec::CELL_SIZE_M[LEVEL_INTEREST as usize]
    );
    assert!((d - 120.0).abs() < 1e-3);
    assert!(d < spec::CELL_SIZE_M[LEVEL_INTEREST as usize]);
}

/// The remaining baseline budgets, printed so a reviewer can diff them against the spec.
#[test]
fn baseline_budgets() {
    println!("\n=== Baseline budgets ===");
    println!(
        "design RTT         = {:?} ({} ticks at {} Hz)",
        spec::DESIGN_RTT,
        spec::DESIGN_RTT.as_millis() as u64 / spec::PMR_PRIME_DT.as_millis() as u64,
        spec::PMR_PRIME_HZ
    );
    println!("FWAU / shard       = {}", spec::FWAU_PER_SHARD);
    println!("entities / shard   = {}", spec::ENTITIES_PER_SHARD);
    println!(
        "snapshot ring      = {} (every {} ticks)",
        spec::SNAPSHOT_RING,
        spec::SNAPSHOT_EVERY_TICKS
    );
    println!(
        "max rewind         = {:?} = {} ticks",
        spec::MAX_REWIND,
        spec::MAX_REWIND.as_millis() as u64 / spec::PMR_PRIME_DT.as_millis() as u64
    );
    println!("WASM guest cap     = {:?}", spec::WASM_GUEST_CAP);

    assert_eq!(
        spec::DESIGN_RTT.as_millis() as u64 / spec::PMR_PRIME_DT.as_millis() as u64,
        2
    );
    assert_eq!(
        spec::MAX_REWIND.as_millis() as usize / spec::PMR_PRIME_DT.as_millis() as usize,
        spec::SNAPSHOT_RING
    );
    assert_eq!(spec::ENTITIES_PER_SHARD / spec::FWAU_PER_SHARD, 30);
}

/// Intent collapses the actor's own fanout and nothing else's.
#[test]
fn intent_prunes_branches() {
    let mut intents = IntentField::new();
    intents.declare(1, ToyAction::Strike);
    assert_eq!(intents.bias(1, ToyAction::Strike), 1.0);
    assert_eq!(
        intents.bias(1, ToyAction::Hold),
        tbc_core::beam::INTENT_PRUNE
    );
    assert_eq!(
        intents.bias(2, ToyAction::Hold),
        1.0,
        "no declaration, no bias"
    );

    let mut declared = ProbabilitySurface::new(IslandId(7), ToyState::default(), Pcg64::new(9));
    declared.advance(&FlatSim, &intents);
    let top = declared.branches().first().expect("beam survives");
    println!(
        "\n=== §7  Free will prunes branches ===\ndeclared Strike at depth 1 → top branch opens with {:?}",
        top.path.first()
    );
    assert_eq!(top.path.first(), Some(&ToyAction::Strike));
}
