//! §7: what collapses a surface, what does not, and what the three stores retain.

use tbc_core::beam::{
    AliasTable, Branch, IntentField, ProbabilityStore, ProbabilitySurface, build_islands,
};
use tbc_core::ids::{Entity, IslandId, Tick};
use tbc_core::math::Vec3;
use tbc_core::rng::Pcg64;
use tbc_core::spec;
use tbc_core::toy::{FlatSim, PeakedSim, ToyAction, ToyState};

#[test]
fn querying_the_future_does_not_collapse_it() {
    let mut surface = ProbabilitySurface::new(IslandId(1), ToyState::default(), Pcg64::new(4));
    surface.advance(&PeakedSim::default(), &IntentField::new());
    let before = surface.len();

    // Psi precognition: a SELECT on FutureDB. It returns a distribution and changes nothing.
    let odds = surface.peek_odds();
    let total: f32 = odds.iter().map(|(p, _)| p).sum();
    println!("{} branches, odds sum to {total:.6}", odds.len());
    assert_eq!(
        surface.len(),
        before,
        "a query is database access, not a measurement"
    );
    assert!(
        (total - 1.0).abs() < 1e-3,
        "odds are normalised for the reader"
    );

    // An in-world observation is what collapses it.
    let resolved = surface.observe().expect("beam is live");
    assert_eq!(surface.len(), 1, "the present is unique");
    assert_eq!(
        resolved.tick,
        spec::DEPTH_D as u32,
        "resolved D ticks ahead"
    );
}

#[test]
fn the_prune_floor_drops_dead_branches() {
    let mut surface = ProbabilitySurface::new(IslandId(1), ToyState::default(), Pcg64::new(4))
        .with_params(spec::BEAM_WIDTH_B, spec::ACTION_FANOUT_A, 2);
    // A ruleset so tight that all but the likeliest paths fall under ε in two steps.
    let brutal = PeakedSim {
        weights: [1.0, 0.005, 0.005, 0.005, 0.005, 0.005],
    };
    surface.advance(&brutal, &IntentField::new());
    println!(
        "after 2 depths under a very tight ruleset: {} branches",
        surface.len()
    );
    assert!(surface.len() < spec::BEAM_WIDTH_B);
    for branch in surface.branches() {
        assert!(branch.weight >= spec::PRUNE_FLOOR_EPS);
    }
}

#[test]
fn shedding_lookahead_is_the_stall_response() {
    let saturated = |depth: usize| {
        let mut s = ProbabilitySurface::new(IslandId(0), ToyState::default(), Pcg64::new(1))
            .with_params(spec::BEAM_WIDTH_B, spec::ACTION_FANOUT_A, depth);
        s.seed_beam(
            (0..spec::BEAM_WIDTH_B)
                .map(|_| Branch {
                    state: ToyState::default(),
                    weight: 1.0,
                    path: Vec::new(),
                })
                .collect(),
        );
        s.advance(&FlatSim, &IntentField::new());
        s.steps_last_advance()
    };
    let full = saturated(spec::DEPTH_D);
    let shed = saturated(4);
    println!("D=8 → {full} steps; shed to D=4 → {shed} steps");
    assert_eq!(full, 768);
    assert_eq!(shed, 384, "halving depth halves the cost");
}

#[test]
fn alias_draws_follow_the_weights() {
    let table = AliasTable::build(&[3.0, 1.0]).expect("weights sum above zero");
    let mut rng = Pcg64::new(0x5A1A5);
    let mut counts = [0u32; 2];
    for _ in 0..100_000 {
        counts[table.draw(&mut rng)] += 1;
    }
    let ratio = f64::from(counts[0]) / f64::from(counts[1]);
    println!("weights 3:1 drew {counts:?} → ratio {ratio:.3}");
    assert!(
        (ratio - 3.0).abs() < 0.06,
        "Walker's alias must respect the distribution"
    );

    assert!(AliasTable::build(&[]).is_none());
    assert!(AliasTable::build(&[0.0, 0.0]).is_none());
}

#[test]
fn intent_collapses_the_actors_fanout_across_the_whole_path() {
    let mut intents = IntentField::new();
    intents.declare(1, ToyAction::Advance);
    intents.declare(2, ToyAction::Strike);

    // Three depths: two declared, one free.
    let mut surface = ProbabilitySurface::new(IslandId(2), ToyState::default(), Pcg64::new(8))
        .with_params(spec::BEAM_WIDTH_B, spec::ACTION_FANOUT_A, 3);
    surface.advance(&FlatSim, &intents);
    let top = surface.branches().first().expect("beam is live");
    println!(
        "declared Advance then Strike → top path {:?}",
        &top.path[..2]
    );
    assert_eq!(top.path[0], ToyAction::Advance);
    assert_eq!(top.path[1], ToyAction::Strike);

    // Every surviving branch obeys the declaration — 1e-6 is below the prune floor, so
    // contradicting branches do not merely rank last, they leave the beam.
    for branch in surface.branches() {
        assert_eq!(branch.path[0], ToyAction::Advance);
        assert_eq!(branch.path[1], ToyAction::Strike);
    }

    // The undeclared depth keeps its full policy distribution: intent collapses the
    // actor's own fanout, it does not rewrite the world.
    let free: Vec<ToyAction> = surface.branches().iter().map(|b| b.path[2]).collect();
    println!(
        "undeclared depth 3 still opens {} ways: {free:?}",
        free.len()
    );
    assert_eq!(free.len(), spec::ACTION_FANOUT_A);
    assert!(free.iter().any(|a| *a != free[0]));
}

#[test]
fn the_three_stores_have_three_retentions() {
    let mut store: ProbabilityStore<ToyState, ToyAction> = ProbabilityStore::new();
    let island = IslandId(5);

    store.put_future(
        island,
        vec![(0.7, vec![ToyAction::Hold]), (0.3, vec![ToyAction::Strike])],
    );
    assert_eq!(store.future(island).map(<[_]>::len), Some(2));
    assert!(store.present(island).is_none());

    store.commit(Tick(1), island, ToyState::default());
    assert!(
        store.present(island).is_some(),
        "PresentDB holds the unique committed state"
    );
    assert_eq!(store.past().len(), 1, "PastDB accumulates");
    assert!(
        store.future(island).is_none(),
        "the beam is dropped on observation"
    );

    store.commit(Tick(2), island, ToyState::default());
    assert_eq!(store.past().len(), 2);
}

#[test]
fn islands_are_connected_components_under_the_lookahead() {
    let lookahead =
        spec::lookahead_distance_m(spec::C_INFO_M_PER_S, spec::DEPTH_D, spec::PMR_PRIME_DT);

    // Two clusters 400 m apart, each internally within 120 m.
    let population = vec![
        (Entity::new(0, 1), Vec3::new(0.0, 0.0, 0.0)),
        (Entity::new(1, 1), Vec3::new(80.0, 0.0, 0.0)),
        (Entity::new(2, 1), Vec3::new(160.0, 0.0, 0.0)),
        (Entity::new(3, 1), Vec3::new(600.0, 0.0, 0.0)),
        (Entity::new(4, 1), Vec3::new(660.0, 0.0, 0.0)),
    ];
    let islands = build_islands(&population, lookahead);
    println!("lookahead {lookahead:.0} m → islands {islands:?}");
    assert_eq!(islands.len(), 2);
    assert_eq!(
        islands[0].len(),
        3,
        "0–1–2 chain within 120 m of a neighbour"
    );
    assert_eq!(islands[1].len(), 2);

    // A lone entity is its own island: idle singles are cheap, not free.
    let solo = build_islands(&[(Entity::new(9, 1), Vec3::ZERO)], lookahead);
    assert_eq!(solo, vec![vec![Entity::new(9, 1)]]);
    assert!(build_islands(&[], lookahead).is_empty());
}
