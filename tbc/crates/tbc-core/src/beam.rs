//! Probable reality surfaces: the intent-biased beam prune (§7).
//!
//! The unobserved future is a beam of weighted branches, held **per causality island** —
//! world-wide lookahead is `O(entities^fanout^depth)` and dead on arrival. Observation is
//! a weighted draw. Intent reweights the beam: free will prunes branches.
//!
//! Querying the future does not collapse it. Only an in-world observation does. That
//! distinction is the difference between psi-as-database-access and prophecy, and it is
//! why [`ProbabilitySurface::peek_odds`] takes `&self` while
//! [`ProbabilitySurface::observe`] takes `&mut self`.

use std::collections::HashMap;

use crate::grid::{HierGrid, LEVEL_INTEREST, cell_of, neighborhood};
use crate::ids::{Entity, IslandId, Tick};
use crate::math::Vec3;
use crate::rng::Pcg64;
use crate::spec::{ACTION_FANOUT_A, BEAM_WIDTH_B, DEPTH_D, PRUNE_FLOOR_EPS};

/// The multiplier applied to branches that contradict a declared intent.
///
/// Not zero: intent collapses the actor's own fanout, it does not delete the possibility
/// from the world.
pub const INTENT_PRUNE: f32 = 1e-6;

/// One island's simulation rules, as the beam needs them.
///
/// `step` must be pure: `(state, action) -> state`, no wall clock, no ambient RNG. Any
/// randomness the sim needs comes from the surface's generator, in a fixed order.
pub trait IslandSim {
    /// The island snapshot the beam branches over.
    type State: Clone;
    /// A legal action in this ruleset.
    type Action: Copy + PartialEq + core::fmt::Debug;

    /// Sample up to `fanout` legal actions: an AI Guy policy, or an FWAU's verb set.
    fn sample_legal(
        &self,
        state: &Self::State,
        fanout: usize,
        rng: &mut Pcg64,
    ) -> Vec<Self::Action>;

    /// Advance one Δt. Pure.
    fn step(&self, state: &Self::State, action: Self::Action) -> Self::State;

    /// Ruleset likelihood of the action. Tightness lives here: PMR peaked, NPMR flat.
    fn p_ruleset(&self, state: &Self::State, action: Self::Action) -> f32;

    /// Optional profitability nudge. Tiny by construction — it must not "force good".
    fn profit_bias(&self, _before: &Self::State, _after: &Self::State) -> f32 {
        1.0
    }
}

/// Verbs an FWAU has declared, by lookahead depth.
///
/// If f declares `a*` at tick t, every branch whose path at t is not `a*` is multiplied by
/// [`INTENT_PRUNE`] for that FWAU's body. Other entities keep their policy distribution.
#[derive(Clone, Debug)]
pub struct IntentField<A> {
    declared: HashMap<usize, A>,
}

impl<A> Default for IntentField<A> {
    fn default() -> Self {
        Self {
            declared: HashMap::new(),
        }
    }
}

impl<A: Copy + PartialEq> IntentField<A> {
    /// An empty field: no declarations, every branch keeps its policy weight.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Declare `action` at lookahead `depth` (1-based, matching the beam's depth loop).
    pub fn declare(&mut self, depth: usize, action: A) {
        self.declared.insert(depth, action);
    }

    /// The multiplier for taking `action` at `depth`.
    #[must_use]
    pub fn bias(&self, depth: usize, action: A) -> f32 {
        match self.declared.get(&depth) {
            Some(declared) if *declared != action => INTENT_PRUNE,
            _ => 1.0,
        }
    }

    /// Whether anything is declared at all.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.declared.is_empty()
    }
}

/// One live branch of a probability surface.
#[derive(Clone, Debug)]
pub struct Branch<St, Ac> {
    /// The island snapshot at the end of this path.
    pub state: St,
    /// Unnormalised weight. Normalisation happens at observation, not every tick.
    pub weight: f32,
    /// The actions taken to get here.
    pub path: Vec<Ac>,
}

/// The live beam for one causality island.
#[derive(Clone, Debug)]
pub struct ProbabilitySurface<St, Ac> {
    island: IslandId,
    beam: Vec<Branch<St, Ac>>,
    width: usize,
    fanout: usize,
    depth: usize,
    eps: f32,
    rng: Pcg64,
    steps_last: u64,
    steps_total: u64,
}

impl<St: Clone, Ac: Copy + PartialEq + core::fmt::Debug> ProbabilitySurface<St, Ac> {
    /// A surface seeded from the island's committed present, at spec defaults
    /// (B=16, A=6, D=8, ε=1e-4).
    #[must_use]
    pub fn new(island: IslandId, present: St, rng: Pcg64) -> Self {
        Self {
            island,
            beam: vec![Branch {
                state: present,
                weight: 1.0,
                path: Vec::new(),
            }],
            width: BEAM_WIDTH_B,
            fanout: ACTION_FANOUT_A,
            depth: DEPTH_D,
            eps: PRUNE_FLOOR_EPS,
            rng,
            steps_last: 0,
            steps_total: 0,
        }
    }

    /// Override B, A and D. Shedding lookahead to `D=4` is the sanctioned stall response.
    #[must_use]
    pub fn with_params(mut self, width: usize, fanout: usize, depth: usize) -> Self {
        self.width = width;
        self.fanout = fanout;
        self.depth = depth;
        self
    }

    /// Seed the beam with an already-saturated set of branches — the steady state a live
    /// island is in on every tick after its first.
    pub fn seed_beam(&mut self, branches: Vec<Branch<St, Ac>>) {
        self.beam = branches;
    }

    /// Grow the surface `D` ticks into the future, biased by declared intent.
    ///
    /// `O(D · B · A · C_step + D · B · A · log B)`. With the spec defaults and a saturated
    /// beam that is exactly `D · B · A` = **768** `step()` calls per island per tick.
    pub fn advance<S>(&mut self, sim: &S, intents: &IntentField<Ac>)
    where
        S: IslandSim<State = St, Action = Ac>,
    {
        self.steps_last = 0;
        for d in 1..=self.depth {
            let parents = core::mem::take(&mut self.beam);
            let mut cand: Vec<Branch<St, Ac>> = Vec::with_capacity(parents.len() * self.fanout);
            for parent in &parents {
                let actions = sim.sample_legal(&parent.state, self.fanout, &mut self.rng);
                for action in actions {
                    let next = sim.step(&parent.state, action);
                    self.steps_last += 1;
                    let weight = parent.weight
                        * sim.p_ruleset(&parent.state, action)
                        * intents.bias(d, action)
                        * sim.profit_bias(&parent.state, &next);
                    let mut path = parent.path.clone();
                    path.push(action);
                    cand.push(Branch {
                        state: next,
                        weight,
                        path,
                    });
                }
            }

            // top_B. The spec says heapselect; a stable sort over n = B·A = 96 is the same
            // complexity class and gives a deterministic order for equal weights, which
            // heapselect would not.
            cand.sort_by(|a, b| {
                b.weight
                    .partial_cmp(&a.weight)
                    .unwrap_or(core::cmp::Ordering::Equal)
            });
            cand.truncate(self.width);
            cand.retain(|b| b.weight >= self.eps);

            self.beam = cand;
            if self.beam.is_empty() {
                break;
            }
        }
        self.steps_total += self.steps_last;
    }

    /// Read the current odds without collapsing anything.
    ///
    /// This is what a psi precognition query returns: a distribution, never a promised
    /// event. The UI renders it as odds. Querying does not measure.
    #[must_use]
    pub fn peek_odds(&self) -> Vec<(f32, &[Ac])> {
        let total: f32 = self.beam.iter().map(|b| b.weight).sum();
        if total <= 0.0 {
            return Vec::new();
        }
        self.beam
            .iter()
            .map(|b| (b.weight / total, b.path.as_slice()))
            .collect()
    }

    /// Collapse the surface: normalise, draw, and keep only the drawn branch.
    ///
    /// Walker's alias: O(B) to build, O(1) to draw. The table is rebuilt on observation,
    /// not every tick. Returns `None` only if every branch was pruned.
    pub fn observe(&mut self) -> Option<St> {
        if self.beam.is_empty() {
            return None;
        }
        let weights: Vec<f32> = self.beam.iter().map(|b| b.weight).collect();
        let table = AliasTable::build(&weights)?;
        let drawn = table.draw(&mut self.rng);
        let chosen = self.beam.swap_remove(drawn);
        // Branches incompatible with the resolved present are dropped: the present is
        // unique, and the residual future is recomputed from it.
        self.beam = vec![Branch {
            state: chosen.state.clone(),
            weight: 1.0,
            path: Vec::new(),
        }];
        Some(chosen.state)
    }

    /// The island this surface belongs to.
    #[must_use]
    pub const fn island(&self) -> IslandId {
        self.island
    }

    /// Live branches.
    #[must_use]
    pub fn len(&self) -> usize {
        self.beam.len()
    }

    /// Whether every branch has been pruned.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.beam.is_empty()
    }

    /// The live beam.
    #[must_use]
    pub fn branches(&self) -> &[Branch<St, Ac>] {
        &self.beam
    }

    /// `step()` calls made by the last [`ProbabilitySurface::advance`].
    #[must_use]
    pub const fn steps_last_advance(&self) -> u64 {
        self.steps_last
    }

    /// `step()` calls made since this surface was created.
    #[must_use]
    pub const fn steps_total(&self) -> u64 {
        self.steps_total
    }
}

/// Walker's alias method: O(n) build, O(1) draw.
#[derive(Clone, Debug)]
pub struct AliasTable {
    prob: Vec<f32>,
    alias: Vec<usize>,
}

impl AliasTable {
    /// Build from unnormalised, non-negative weights. `None` if they sum to zero.
    #[must_use]
    pub fn build(weights: &[f32]) -> Option<Self> {
        let n = weights.len();
        if n == 0 {
            return None;
        }
        let total: f32 = weights.iter().sum();
        if total.partial_cmp(&0.0) != Some(core::cmp::Ordering::Greater) {
            return None;
        }

        let mut prob: Vec<f32> = weights.iter().map(|w| w / total * n as f32).collect();
        let mut alias = vec![0usize; n];
        let mut small = Vec::new();
        let mut large = Vec::new();
        for (i, p) in prob.iter().enumerate() {
            if *p < 1.0 {
                small.push(i)
            } else {
                large.push(i)
            }
        }

        while let (Some(s), Some(l)) = (small.pop(), large.pop()) {
            alias[s] = l;
            prob[l] = (prob[l] + prob[s]) - 1.0;
            if prob[l] < 1.0 {
                small.push(l);
            } else {
                large.push(l);
            }
        }
        for i in large.into_iter().chain(small) {
            prob[i] = 1.0;
            alias[i] = i;
        }

        Some(Self { prob, alias })
    }

    /// Draw an index. Consumes exactly two RNG words, always, so the generator stays in
    /// lockstep across replays regardless of which branch is drawn.
    pub fn draw(&self, rng: &mut Pcg64) -> usize {
        let i = rng.uniform_index(self.prob.len());
        let f = rng.next_f32();
        if f < self.prob[i] { i } else { self.alias[i] }
    }

    /// Number of outcomes.
    #[must_use]
    pub fn len(&self) -> usize {
        self.prob.len()
    }

    /// Whether the table is empty. Never true for a built table.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.prob.is_empty()
    }
}

/// The three probability stores (§7). In-memory at M1; Scylla and Redis arrive at M2.
///
/// Retention is the difference between them, not the schema: `past` is committed and
/// checksummable, `present` is replaced every tick, `future` is dropped on observation.
#[derive(Clone, Debug)]
pub struct ProbabilityStore<St, Ac> {
    past: Vec<(Tick, IslandId, St)>,
    present: HashMap<IslandId, St>,
    future: HashMap<IslandId, Vec<(f32, Vec<Ac>)>>,
}

impl<St, Ac> Default for ProbabilityStore<St, Ac> {
    fn default() -> Self {
        Self {
            past: Vec::new(),
            present: HashMap::new(),
            future: HashMap::new(),
        }
    }
}

impl<St: Clone, Ac: Clone> ProbabilityStore<St, Ac> {
    /// An empty store.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Commit a resolved present: written to PastDB and PresentDB, and the island's
    /// speculative future is dropped.
    pub fn commit(&mut self, tick: Tick, island: IslandId, state: St) {
        self.past.push((tick, island, state.clone()));
        self.present.insert(island, state);
        self.future.remove(&island);
    }

    /// Record the residual beam as the island's future. Speculative and unmarked.
    pub fn put_future(&mut self, island: IslandId, odds: Vec<(f32, Vec<Ac>)>) {
        self.future.insert(island, odds);
    }

    /// The committed present of an island.
    #[must_use]
    pub fn present(&self, island: IslandId) -> Option<&St> {
        self.present.get(&island)
    }

    /// The island's live future, as odds. A `SELECT`, not a measurement.
    #[must_use]
    pub fn future(&self, island: IslandId) -> Option<&[(f32, Vec<Ac>)]> {
        self.future.get(&island).map(Vec::as_slice)
    }

    /// Committed history, oldest first.
    #[must_use]
    pub fn past(&self) -> &[(Tick, IslandId, St)] {
        &self.past
    }
}

/// Group entities into causality islands: connected components under `lookahead`.
///
/// `lookahead = c_info · D · Δt` (120 m in PMR-Prime), which is why island membership fits
/// inside the 128 m interest radius and the grid can answer it in one neighbourhood scan.
///
/// Returns components sorted by their lowest entity, each component sorted — a stable
/// island order is a determinism requirement, not a nicety.
#[must_use]
pub fn build_islands(entities: &[(Entity, Vec3)], lookahead: f32) -> Vec<Vec<Entity>> {
    let mut grid = HierGrid::new();
    let mut index: HashMap<Entity, usize> = HashMap::new();
    for (i, (e, p)) in entities.iter().enumerate() {
        grid.insert(cell_of(*p, LEVEL_INTEREST), *e);
        index.insert(*e, i);
    }

    let mut parent: Vec<usize> = (0..entities.len()).collect();
    let r2 = lookahead * lookahead;
    for (i, (_, p)) in entities.iter().enumerate() {
        for key in neighborhood(cell_of(*p, LEVEL_INTEREST), true) {
            let Some(cell) = grid.cell(&key) else {
                continue;
            };
            for other in cell.entities() {
                let Some(&j) = index.get(&other) else {
                    continue;
                };
                if j > i && entities[j].1.distance_sq(*p) <= r2 {
                    union(&mut parent, i, j);
                }
            }
        }
    }

    let mut groups: HashMap<usize, Vec<Entity>> = HashMap::new();
    for (i, (entity, _)) in entities.iter().enumerate() {
        let root = find(&mut parent, i);
        groups.entry(root).or_default().push(*entity);
    }
    let mut out: Vec<Vec<Entity>> = groups.into_values().collect();
    for group in &mut out {
        group.sort_unstable();
    }
    out.sort_unstable_by_key(|g| g.first().copied().unwrap_or_default());
    out
}

fn find(parent: &mut [usize], mut i: usize) -> usize {
    while parent[i] != i {
        parent[i] = parent[parent[i]];
        i = parent[i];
    }
    i
}

fn union(parent: &mut [usize], a: usize, b: usize) {
    let (ra, rb) = (find(parent, a), find(parent, b));
    if ra != rb {
        parent[rb.max(ra)] = rb.min(ra);
    }
}
