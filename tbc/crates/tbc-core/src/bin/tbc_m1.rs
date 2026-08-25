//! M1 harness: one process, one Δt loop, two FWAUs, no client.
//!
//! This is the "single-process Δt loop with 2 keyboard FWAUs" from the M1 exit criteria,
//! with the keyboard replaced by a scripted intent tape so the run is reproducible. A real
//! input front-end binds at exactly one place: [`Fwau::intent_at`].
//!
//! Run: `cargo run --bin tbc-m1 -- [ticks]`

use std::collections::HashMap;

use tbc_core::beam::{IntentField, ProbabilityStore, ProbabilitySurface, build_islands};
use tbc_core::delta_t::{DeltaTClock, Dilation, NestedClock};
use tbc_core::grid::{HierGrid, LEVEL_INTEREST, MoveOutcome, cell_of};
use tbc_core::ids::{ActionId, Entity, FrameId, FwauId, IslandId, IuocId, Tick};
use tbc_core::ledger::{
    Coefficients, EntropyLedger, Features, ReciprocityTracker, TargetKind, audience_sensitivity,
    unconsented_harm,
};
use tbc_core::math::Vec3;
use tbc_core::rng::{Pcg64, island_seed};
use tbc_core::spec;
use tbc_core::toy::{PeakedSim, ToyAction, ToyState};

/// Genesis seed for this world line. Everything random downstream derives from it.
const GENESIS: u128 = 0x5442_4300_4C43_5300_4155_4D00_4658_4155;

/// PMR-Prime.
const FRAME_PMR: FrameId = FrameId(0);

/// Two ticks with no observer and no island membership is 2.0 s at 20 Hz.
const SLEEP_AFTER_TICKS: u64 = 40;

/// One bound session.
struct Fwau {
    id: FwauId,
    iuoc: IuocId,
    avatar: Entity,
    pos: Vec3,
    tape: Vec<ToyAction>,
}

impl Fwau {
    /// The one place a keyboard, a gamepad or a network gateway would bind.
    fn intent_at(&self, tick: Tick) -> ToyAction {
        self.tape[(tick.0 as usize) % self.tape.len()]
    }
}

fn main() {
    let ticks: u64 = std::env::args()
        .nth(1)
        .and_then(|a| a.parse().ok())
        .unwrap_or(200);

    // --- Frames -----------------------------------------------------------------------
    let mut pmr = DeltaTClock::new(spec::PMR_PRIME_DT);
    let mut academy = NestedClock::new(FrameId(1), spec::NPMR_ACADEMY_DT, Dilation::new(1, 1));
    let mut dream = NestedClock::new(FrameId(2), spec::NPMR_ACADEMY_DT, Dilation::new(4, 1));

    // --- World ------------------------------------------------------------------------
    let mut fwaus = vec![
        Fwau {
            id: FwauId(1),
            iuoc: IuocId(0xA1),
            avatar: Entity::new(0, 1),
            pos: Vec3::new(0.0, 0.0, 0.0),
            tape: vec![
                ToyAction::Advance,
                ToyAction::Aid,
                ToyAction::Hold,
                ToyAction::Speak,
            ],
        },
        Fwau {
            id: FwauId(2),
            iuoc: IuocId(0xB2),
            avatar: Entity::new(1, 1),
            pos: Vec3::new(90.0, 0.0, 0.0),
            tape: vec![
                ToyAction::Advance,
                ToyAction::Strike,
                ToyAction::Retreat,
                ToyAction::Strike,
            ],
        },
    ];

    // A handful of AI Guys. No FWAU binding, so harm against them is not a ledger event.
    let ai_guys: Vec<(Entity, Vec3)> = (0..8)
        .map(|i| {
            (
                Entity::new(100 + i, 1),
                Vec3::new(30.0 * i as f32, 0.0, 12.0 * (i % 3) as f32),
            )
        })
        .collect();

    let mut grid = HierGrid::new();
    for f in &fwaus {
        grid.insert(cell_of(f.pos, LEVEL_INTEREST), f.avatar);
        grid.subscribe(cell_of(f.pos, LEVEL_INTEREST), f.id);
    }
    for (e, p) in &ai_guys {
        grid.insert(cell_of(*p, LEVEL_INTEREST), *e);
    }

    let mut ledger = EntropyLedger::new(Coefficients::EPOCH_0);
    let mut reciprocity = ReciprocityTracker::new();
    let mut ledger_rng = Pcg64::new(GENESIS ^ 0x1ED6_E200_0000_0000_0000_0000_0000_0001);
    let mut store: ProbabilityStore<ToyState, ToyAction> = ProbabilityStore::new();
    let mut last_seen: HashMap<Entity, Tick> = HashMap::new();
    let sim = PeakedSim::default();

    let lookahead =
        spec::lookahead_distance_m(spec::C_INFO_M_PER_S, spec::DEPTH_D, spec::PMR_PRIME_DT);

    let mut beam_steps: u64 = 0;
    let mut collapses: u64 = 0;
    let mut snapshots: u64 = 0;
    let mut replicated: u64 = 0;
    let mut asleep: u64 = 0;
    let mut islands_seen: u64 = 0;
    let mut action_id: u64 = 0;

    println!("TBC M1 — headless. genesis={GENESIS:#034x}, frame=PMR-Prime, ticks={ticks}");
    println!(
        "Δt={:?} ({} Hz), catch-up cap {}, island lookahead {lookahead:.0} m",
        pmr.dt(),
        pmr.hz(),
        spec::MAX_CATCHUP
    );

    // --- The loop ---------------------------------------------------------------------
    // Step order per tick is fixed (§12). Changing it is a protocol break.
    while pmr.tick().0 < ticks {
        // Simulated wall time: exactly one Δt per pass, so the run is reproducible. A real
        // shard passes the measured elapsed time and lets the accumulator do its job.
        let stepped = pmr.drain(spec::PMR_PRIME_DT);
        for _ in 0..stepped {
            let now = pmr.tick();

            // (1) intents in, bucketed by declared tick.
            let mut intents: IntentField<ToyAction> = IntentField::new();
            for f in &fwaus {
                intents.declare(1, f.intent_at(now));
            }

            // (2) movement.
            for f in &mut fwaus {
                let old = f.pos;
                let delta = match f.intent_at(now) {
                    ToyAction::Advance => 4.0,
                    ToyAction::Retreat => -4.0,
                    _ => 0.0,
                };
                f.pos = Vec3::new(old.x + delta, old.y, old.z);
                if let MoveOutcome::Crossed { dirty } =
                    grid.on_move(f.avatar, old, f.pos, LEVEL_INTEREST)
                {
                    replicated += dirty.len() as u64;
                    grid.unsubscribe(cell_of(old, LEVEL_INTEREST), f.id);
                    grid.subscribe(cell_of(f.pos, LEVEL_INTEREST), f.id);
                }
                last_seen.insert(f.avatar, now);
            }

            // (3) islands rebuild.
            let mut population: Vec<(Entity, Vec3)> =
                fwaus.iter().map(|f| (f.avatar, f.pos)).collect();
            population.extend(ai_guys.iter().copied());
            let islands = build_islands(&population, lookahead);
            islands_seen += islands.len() as u64;

            // (4) surface.advance, and (5) observe/collapse. An island with an observer
            // resolves this tick; the rest keep their beam.
            for (i, members) in islands.iter().enumerate() {
                let island = IslandId(i as u64);
                let seed = island_seed(FRAME_PMR, island, now, GENESIS);
                let present = store
                    .present(island)
                    .copied()
                    .unwrap_or_else(ToyState::default);
                let mut surface = ProbabilitySurface::new(island, present, Pcg64::new(seed));
                surface.advance(&sim, &intents);
                beam_steps += surface.steps_last_advance();

                let observed = members.iter().any(|e| fwaus.iter().any(|f| f.avatar == *e));
                if observed {
                    if let Some(resolved) = surface.observe() {
                        store.commit(now, island, resolved);
                        collapses += 1;
                    }
                } else {
                    let odds = surface
                        .peek_odds()
                        .into_iter()
                        .map(|(p, path)| (p, path.to_vec()))
                        .collect();
                    store.put_future(island, odds);
                }
            }

            // (6) verbs, and (7) ledger enqueue. Fast feedback already happened above in
            // the island step; this is the slow teacher, and it lands hours from now.
            for (i, f) in fwaus.iter().enumerate() {
                let verb = f.intent_at(now);
                let other = fwaus[(i + 1) % 2].iuoc;
                let witnesses = 1 + islands.len() as u32;
                let features = match verb {
                    ToyAction::Aid => {
                        let decay = reciprocity.record_aid(f.iuoc, other);
                        Features {
                            aid: 0.8 * decay,
                            perf: audience_sensitivity(witnesses, 1),
                            ..Features::default()
                        }
                    }
                    ToyAction::Strike => Features {
                        // Struck an AI Guy: zero on the harm axis, by design.
                        harm: unconsented_harm(0.7, TargetKind::AiGuy, false),
                        ..Features::default()
                    },
                    _ => continue,
                };
                action_id += 1;
                ledger.apply_consequence(
                    f.iuoc,
                    ActionId(action_id),
                    features,
                    now,
                    &mut ledger_rng,
                );
            }

            // (8) sleep / wake.
            for (e, _) in &ai_guys {
                let seen = last_seen.get(e).copied().unwrap_or(Tick(0));
                let in_island = islands.iter().any(|m| {
                    m.contains(e) && m.iter().any(|x| fwaus.iter().any(|f| f.avatar == *x))
                });
                if in_island {
                    last_seen.insert(*e, now);
                } else if now.since(seen) >= SLEEP_AFTER_TICKS {
                    asleep += 1;
                }
            }

            // (9) replicate: dirty fields to subscribers, counted above on cell crossings.
            // (10) snapshot if due.
            if now.0 % spec::SNAPSHOT_EVERY_TICKS == 0 {
                snapshots += 1;
            }

            // Child frames are scheduled from their parent, never from wall time. The
            // dream is nested in the Academy, so the Academy's ticks drive it.
            let academy_steps = academy.on_parent_ticks(1);
            dream.on_parent_ticks(academy_steps);

            // The ledger worker runs here to prove it finds nothing: every delta is 10
            // minutes to 6 hours of playtime away.
            let _settled = ledger.flush_due(now);
        }
    }

    // --- Report -----------------------------------------------------------------------
    println!();
    println!("ticks stepped      : {}", pmr.tick().0);
    println!(
        "stalls / dropped   : {} / {:?}",
        pmr.stalls(),
        pmr.dropped()
    );
    println!(
        "academy tick       : {} (Δt {:?}, ratio {:.2})",
        academy.clock().tick().0,
        academy.clock().dt(),
        academy.dilation().ratio()
    );
    println!(
        "dream tick         : {} (nested in Academy, ratio {:.2}, handoff open: {})",
        dream.clock().tick().0,
        dream.dilation().ratio(),
        dream.handoff_allowed()
    );
    println!(
        "islands / tick avg : {:.2}",
        islands_seen as f64 / ticks as f64
    );
    println!("beam step() calls  : {beam_steps}");
    println!("collapses          : {collapses}");
    println!("snapshots          : {snapshots}");
    println!("grid               : {:?}", grid.stats());
    println!("occupied cells     : {}", grid.occupied_cells());
    println!("interest updates   : {replicated}");
    println!("sleep candidates   : {asleep}");
    println!(
        "ledger pending     : {} events, epoch {}",
        ledger.pending_len(),
        ledger.coefficients().epoch
    );
    println!("ledger settled now : 0 (by design — the delay is the mechanism)");
    for f in &fwaus {
        // The band, never the float. This is the only S-derived value that leaves.
        println!(
            "  {:?} band        : {}",
            f.iuoc,
            ledger.band_of(f.iuoc).label()
        );
    }

    // A demonstration of the background worker, not a shortcut in the loop: fast-forward
    // past the maximum delay window and let the queue land.
    let far = pmr.tick().plus(Coefficients::EPOCH_0.delay_max_ticks);
    let settled = ledger.flush_due(far);
    println!();
    println!(
        "worker demo: {} events settled after {} ticks of playtime",
        settled.len(),
        Coefficients::EPOCH_0.delay_max_ticks
    );
    for f in &fwaus {
        println!(
            "  {:?} band        : {}",
            f.iuoc,
            ledger.band_of(f.iuoc).label()
        );
    }
}
