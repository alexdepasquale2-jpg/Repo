//! Interest management: the hierarchical spatial hash (§4).
//!
//! Three uniform levels, not a quadtree: insert and remove are O(1) expected, PMR terrain
//! is mostly flat, and cache behaviour beats pointer-chasing at 12 k entities. Quadtrees
//! are reserved for sparse NPMR volumes.
//!
//! This is also where "render-on-observation" stops being a slogan and becomes a data
//! structure: an entity nobody subscribes to is not in anyone's interest set, so it is not
//! stepped.

use std::collections::{HashMap, HashSet};

use crate::ids::{Entity, FwauId};
use crate::math::Vec3;
use crate::spec::CELL_SIZE_M;

/// Level 0: 32 m. Combat, interact, speech, precise replication.
pub const LEVEL_PRECISE: u8 = 0;
/// Level 1: 128 m. Default interest radius, LOD-1 bodies.
pub const LEVEL_INTEREST: u8 = 1;
/// Level 2: 512 m. Silhouettes, map blips, distant events.
pub const LEVEL_SILHOUETTE: u8 = 2;

/// A cell address. Levels do not share cells: the same position has one key per level.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct CellKey {
    /// Grid level, 0..=2.
    pub level: u8,
    /// Cell index along x.
    pub x: i32,
    /// Cell index along y.
    pub y: i32,
    /// Cell index along z.
    pub z: i32,
}

/// The cell containing `p` at `level`.
///
/// # Panics
/// If `level` is not a defined grid level.
#[must_use]
pub fn cell_of(p: Vec3, level: u8) -> CellKey {
    let s = CELL_SIZE_M[level as usize];
    CellKey {
        level,
        x: (p.x / s).floor() as i32,
        y: (p.y / s).floor() as i32,
        z: (p.z / s).floor() as i32,
    }
}

/// The finest level whose cell still covers `radius`, so a 3×3 neighbourhood is enough.
///
/// Coarser levels would scan fewer cells but return more entities; this is the level that
/// keeps the query O(k) in the entities actually near `p`.
#[must_use]
pub fn lod_for(radius: f32) -> u8 {
    match CELL_SIZE_M.iter().position(|&s| s >= radius) {
        Some(level) => level as u8,
        None => LEVEL_SILHOUETTE,
    }
}

/// One cell's occupants and the FWAUs listening to it.
#[derive(Clone, Default, Debug)]
pub struct Cell {
    entities: HashSet<Entity>,
    subscribers: Vec<FwauId>,
}

impl Cell {
    /// Entities currently in this cell.
    pub fn entities(&self) -> impl Iterator<Item = Entity> + '_ {
        self.entities.iter().copied()
    }

    /// FWAUs subscribed to this cell.
    #[must_use]
    pub fn subscribers(&self) -> &[FwauId] {
        &self.subscribers
    }
}

/// What a move cost. The common case is [`MoveOutcome::CellLocal`], which publishes nothing.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum MoveOutcome {
    /// Stayed inside its cell: O(1), no interest churn, no publish.
    CellLocal,
    /// Crossed a cell boundary: the symmetric difference of the two subscriber sets needs
    /// an enter/leave. Empirically 4–16 FWAUs.
    Crossed {
        /// Subscribers who must be told the entity entered or left their view.
        dirty: Vec<FwauId>,
    },
}

/// Counters that make the complexity claims checkable rather than aspirational.
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct GridStats {
    /// Cells inserted into.
    pub inserts: u64,
    /// Cells removed from.
    pub removes: u64,
    /// Moves that stayed in their cell.
    pub local_moves: u64,
    /// Moves that crossed a cell boundary.
    pub crossing_moves: u64,
    /// Subscriber notifications emitted by crossings.
    pub interest_dirty: u64,
}

impl GridStats {
    /// Total cell touches: the work a move actually does on the map.
    #[must_use]
    pub const fn cell_ops(&self) -> u64 {
        self.inserts + self.removes
    }
}

/// The hierarchical spatial hash.
#[derive(Clone, Default, Debug)]
pub struct HierGrid {
    map: HashMap<CellKey, Cell>,
    stats: GridStats,
}

impl HierGrid {
    /// An empty grid.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Put `e` in `key`. O(1) expected.
    pub fn insert(&mut self, key: CellKey, e: Entity) {
        self.map.entry(key).or_default().entities.insert(e);
        self.stats.inserts += 1;
    }

    /// Take `e` out of `key`. O(1) expected. Empty cells are dropped so an emptied region
    /// costs nothing to hold.
    pub fn remove(&mut self, key: CellKey, e: Entity) {
        if let Some(cell) = self.map.get_mut(&key) {
            cell.entities.remove(&e);
            self.stats.removes += 1;
            if cell.entities.is_empty() && cell.subscribers.is_empty() {
                self.map.remove(&key);
            }
        }
    }

    /// Move `e` from `old` to `new` at `level`.
    ///
    /// The whole point of the structure: a move that stays in its cell returns immediately
    /// and publishes nothing, which is the overwhelmingly common case at 20 Hz.
    pub fn on_move(&mut self, e: Entity, old: Vec3, new: Vec3, level: u8) -> MoveOutcome {
        let a = cell_of(old, level);
        let b = cell_of(new, level);
        if a == b {
            self.stats.local_moves += 1;
            return MoveOutcome::CellLocal;
        }
        let dirty = self.subscriber_symmetric_difference(a, b);
        self.remove(a, e);
        self.insert(b, e);
        self.stats.crossing_moves += 1;
        self.stats.interest_dirty += dirty.len() as u64;
        MoveOutcome::Crossed { dirty }
    }

    /// Subscribe `f` to `key`, so entities entering it dirty that FWAU's interest set.
    pub fn subscribe(&mut self, key: CellKey, f: FwauId) {
        let cell = self.map.entry(key).or_default();
        if !cell.subscribers.contains(&f) {
            cell.subscribers.push(f);
        }
    }

    /// Drop `f`'s subscription to `key`.
    pub fn unsubscribe(&mut self, key: CellKey, f: FwauId) {
        if let Some(cell) = self.map.get_mut(&key) {
            cell.subscribers.retain(|&s| s != f);
            if cell.entities.is_empty() && cell.subscribers.is_empty() {
                self.map.remove(&key);
            }
        }
    }

    /// Entities within `radius` of `p`, scanned over the 3×3 neighbourhood of the level
    /// that covers it. O(k) in the entities in those cells.
    #[must_use]
    pub fn query(&self, p: Vec3, radius: f32, positions: &dyn Fn(Entity) -> Vec3) -> Vec<Entity> {
        let level = lod_for(radius);
        let r2 = radius * radius;
        let mut out = Vec::new();
        for key in neighborhood(cell_of(p, level), false) {
            if let Some(cell) = self.map.get(&key) {
                for e in cell.entities() {
                    if positions(e).distance_sq(p) <= r2 {
                        out.push(e);
                    }
                }
            }
        }
        out.sort_unstable();
        out
    }

    /// Every entity in the 3×3 (or 3×3×3) neighbourhood, unfiltered by exact distance.
    ///
    /// This is the replication-side query: LOD bands are distance bands, but the AoI set
    /// itself is cell-shaped.
    #[must_use]
    pub fn neighborhood_entities(&self, p: Vec3, level: u8, flying: bool) -> Vec<Entity> {
        let mut out = Vec::new();
        for key in neighborhood(cell_of(p, level), flying) {
            if let Some(cell) = self.map.get(&key) {
                out.extend(cell.entities());
            }
        }
        out.sort_unstable();
        out
    }

    /// The cell at `key`, if it exists.
    #[must_use]
    pub fn cell(&self, key: &CellKey) -> Option<&Cell> {
        self.map.get(key)
    }

    /// Occupied cells. Sleeping regions cost memory, not CPU — but they should not cost
    /// memory for long either, hence the drop-on-empty above.
    #[must_use]
    pub fn occupied_cells(&self) -> usize {
        self.map.len()
    }

    /// Complexity counters.
    #[must_use]
    pub const fn stats(&self) -> GridStats {
        self.stats
    }

    /// Reset the counters, for measuring one phase in isolation.
    pub fn reset_stats(&mut self) {
        self.stats = GridStats::default();
    }

    fn subscriber_symmetric_difference(&self, a: CellKey, b: CellKey) -> Vec<FwauId> {
        let left = self.map.get(&a).map(Cell::subscribers).unwrap_or_default();
        let right = self.map.get(&b).map(Cell::subscribers).unwrap_or_default();
        let mut dirty: Vec<FwauId> = left
            .iter()
            .filter(|f| !right.contains(f))
            .chain(right.iter().filter(|f| !left.contains(f)))
            .copied()
            .collect();
        dirty.sort_unstable();
        dirty.dedup();
        dirty
    }
}

/// The 9 (2D) or 27 (flying) cells around `key`.
#[must_use]
pub fn neighborhood(key: CellKey, flying: bool) -> Vec<CellKey> {
    let ys: &[i32] = if flying { &[-1, 0, 1] } else { &[0] };
    let mut out = Vec::with_capacity(if flying { 27 } else { 9 });
    for dx in [-1, 0, 1] {
        for &dy in ys {
            for dz in [-1, 0, 1] {
                out.push(CellKey {
                    level: key.level,
                    x: key.x + dx,
                    y: key.y + dy,
                    z: key.z + dz,
                });
            }
        }
    }
    out
}
