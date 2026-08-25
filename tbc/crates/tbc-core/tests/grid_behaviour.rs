//! §4: interest management, and the sense in which unobserved PMR is not computed.

use tbc_core::grid::{
    Cell, HierGrid, LEVEL_INTEREST, LEVEL_PRECISE, LEVEL_SILHOUETTE, MoveOutcome, cell_of, lod_for,
    neighborhood,
};
use tbc_core::ids::{Entity, FwauId};
use tbc_core::math::Vec3;
use tbc_core::spec::CELL_SIZE_M;

#[test]
fn cells_are_uniform_and_level_indexed() {
    let p = Vec3::new(33.0, 0.0, -1.0);
    assert_eq!(cell_of(p, LEVEL_PRECISE).x, 1);
    assert_eq!(cell_of(p, LEVEL_PRECISE).z, -1, "floor, not truncate");
    assert_eq!(cell_of(p, LEVEL_INTEREST).x, 0);
    assert_eq!(cell_of(p, LEVEL_SILHOUETTE).x, 0);

    // The same position has a different key per level; levels never share cells.
    assert_ne!(cell_of(p, LEVEL_PRECISE), cell_of(p, LEVEL_INTEREST));
}

#[test]
fn lod_picks_the_level_that_covers_the_radius() {
    assert_eq!(lod_for(10.0), LEVEL_PRECISE);
    assert_eq!(lod_for(32.0), LEVEL_PRECISE);
    assert_eq!(lod_for(33.0), LEVEL_INTEREST);
    assert_eq!(lod_for(128.0), LEVEL_INTEREST);
    assert_eq!(lod_for(500.0), LEVEL_SILHOUETTE);
    assert_eq!(
        lod_for(5_000.0),
        LEVEL_SILHOUETTE,
        "clamped, and rare by design"
    );
}

#[test]
fn neighborhoods_are_9_or_27() {
    let key = cell_of(Vec3::ZERO, LEVEL_INTEREST);
    assert_eq!(neighborhood(key, false).len(), 9);
    assert_eq!(neighborhood(key, true).len(), 27);
    assert!(neighborhood(key, false).contains(&key));
}

#[test]
fn crossing_a_boundary_dirties_exactly_the_symmetric_difference() {
    let mut grid = HierGrid::new();
    let subject = Entity::new(0, 1);
    let here = Vec3::new(10.0, 0.0, 0.0);
    let there = Vec3::new(200.0, 0.0, 0.0);
    let (key_here, key_there) = (
        cell_of(here, LEVEL_INTEREST),
        cell_of(there, LEVEL_INTEREST),
    );

    grid.insert(key_here, subject);
    grid.subscribe(key_here, FwauId(1));
    grid.subscribe(key_here, FwauId(2));
    grid.subscribe(key_there, FwauId(2)); // watches both: nothing enters or leaves for them
    grid.subscribe(key_there, FwauId(3));

    let MoveOutcome::Crossed { dirty } = grid.on_move(subject, here, there, LEVEL_INTEREST) else {
        panic!("that move crosses a 128 m boundary");
    };
    println!("subscribers dirtied by one crossing: {dirty:?}");
    assert_eq!(dirty, vec![FwauId(1), FwauId(3)]);
    assert!(
        !dirty.contains(&FwauId(2)),
        "an FWAU watching both sides sees no change"
    );
}

#[test]
fn queries_return_what_is_near_and_nothing_else() {
    let positions: Vec<(Entity, Vec3)> = (0..50u32)
        .map(|i| (Entity::new(i, 1), Vec3::new(i as f32 * 10.0, 0.0, 0.0)))
        .collect();
    let mut grid = HierGrid::new();
    for (e, p) in &positions {
        grid.insert(cell_of(*p, LEVEL_PRECISE), *e);
        grid.insert(cell_of(*p, LEVEL_INTEREST), *e);
    }
    let lookup = |e: Entity| positions[e.index as usize].1;

    let near = grid.query(Vec3::new(100.0, 0.0, 0.0), 25.0, &lookup);
    println!("within 25 m of x=100: {near:?}");
    assert_eq!(
        near,
        vec![
            Entity::new(8, 1),
            Entity::new(9, 1),
            Entity::new(10, 1),
            Entity::new(11, 1),
            Entity::new(12, 1)
        ]
    );

    for e in &near {
        assert!(lookup(*e).distance(Vec3::new(100.0, 0.0, 0.0)) <= 25.0);
    }
}

#[test]
fn emptied_regions_cost_nothing_to_hold() {
    let mut grid = HierGrid::new();
    let e = Entity::new(0, 1);
    let a = Vec3::new(0.0, 0.0, 0.0);
    let b = Vec3::new(1_000.0, 0.0, 0.0);
    grid.insert(cell_of(a, LEVEL_INTEREST), e);
    assert_eq!(grid.occupied_cells(), 1);

    grid.on_move(e, a, b, LEVEL_INTEREST);
    assert_eq!(
        grid.occupied_cells(),
        1,
        "the vacated cell is dropped, not kept empty"
    );
    assert!(grid.cell(&cell_of(a, LEVEL_INTEREST)).is_none());

    // A subscribed cell survives an empty entity set: someone is still listening.
    grid.subscribe(cell_of(a, LEVEL_INTEREST), FwauId(9));
    assert_eq!(
        grid.cell(&cell_of(a, LEVEL_INTEREST))
            .map(Cell::subscribers),
        Some(&[FwauId(9)][..])
    );
    grid.unsubscribe(cell_of(a, LEVEL_INTEREST), FwauId(9));
    assert!(grid.cell(&cell_of(a, LEVEL_INTEREST)).is_none());
}

#[test]
fn cell_sizes_are_the_published_bands() {
    assert_eq!(CELL_SIZE_M, [32.0, 128.0, 512.0]);
}
