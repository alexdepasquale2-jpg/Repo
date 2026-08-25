//! Baseline budgets, verbatim from the Architecture Specification v1.0.
//!
//! Every number the tests print comes from here, so "the spec numbers" and "the numbers
//! the code uses" cannot drift apart without a compile-visible edit. Numbers are Δt
//! budgets and may be changed with measurement; names are frozen (M0).

use core::time::Duration;

/// PMR-Prime open world: 50 ms, 20 Hz. Human combat is readable at this grain.
pub const PMR_PRIME_DT: Duration = Duration::from_millis(50);
/// PMR-Prime tick rate in Hz.
pub const PMR_PRIME_HZ: u32 = 20;
/// Instanced PvP: 16.67 ms, 60 Hz. Tighter hit confirmation in a smaller instance.
pub const PVP_DT: Duration = Duration::from_micros(16_667);
/// Instanced PvP tick rate in Hz.
pub const PVP_HZ: u32 = 60;
/// NPMR-Academy: 200 ms, 5 Hz. Loose ruleset, psi is request/reply rather than traced.
pub const NPMR_ACADEMY_DT: Duration = Duration::from_millis(200);
/// NPMR-Academy tick rate in Hz.
pub const NPMR_ACADEMY_HZ: u32 = 5;

/// Design RTT the netcode is budgeted against (target 50 ms).
pub const DESIGN_RTT: Duration = Duration::from_millis(100);
/// Bound FWAU per shard, M9 target.
pub const FWAU_PER_SHARD: u32 = 400;
/// Entities per shard at the FWAU target.
pub const ENTITIES_PER_SHARD: u32 = 12_000;

/// Beam width: max live branches per island.
pub const BEAM_WIDTH_B: usize = 16;
/// Action fanout: legal actions sampled per branch per depth.
pub const ACTION_FANOUT_A: usize = 6;
/// Lookahead depth in ticks. 8 ticks = 400 ms at 20 Hz — matches the snapshot ring.
pub const DEPTH_D: usize = 8;
/// Prune floor: branches below this weight are dropped.
pub const PRUNE_FLOOR_EPS: f32 = 1e-4;
/// Islands per shard, expected (combat clusters plus idle singles).
pub const ISLANDS_PER_SHARD: usize = 40;

/// Snapshot ring depth. Also the max rewind in ticks.
pub const SNAPSHOT_RING: usize = 8;
/// Snapshot cadence: every 2 ticks (100 ms at 20 Hz).
pub const SNAPSHOT_EVERY_TICKS: u64 = 2;
/// Max rewind window. 8 ticks at 20 Hz.
pub const MAX_REWIND: Duration = Duration::from_millis(400);
/// Catch-up cap: at most 4 ticks in one wall slice (200 ms), then time is dropped.
pub const MAX_CATCHUP: u32 = 4;

/// Speed of information in PMR-Prime, metres per second. Sets the island lookahead radius.
pub const C_INFO_M_PER_S: f32 = 300.0;
/// Hard cap on a WASM guest verb, per invocation.
pub const WASM_GUEST_CAP: Duration = Duration::from_micros(300);

/// Steps a saturated island beam costs per tick: `D · B · A`.
///
/// The headline number of §7: 8 × 16 × 6 = 768.
pub const STEPS_PER_ISLAND_PER_TICK: usize = DEPTH_D * BEAM_WIDTH_B * ACTION_FANOUT_A;

/// Interest-management cell sizes in metres, indexed by grid level (§4).
pub const CELL_SIZE_M: [f32; 3] = [32.0, 128.0, 512.0];

/// Lookahead distance for causality-island membership: `c_info · D · Δt`.
///
/// PMR-Prime: 300 m/s × 8 × 0.05 s = 120 m, comfortably inside the 128 m interest radius.
#[must_use]
pub fn lookahead_distance_m(c_info_m_per_s: f32, depth: usize, dt: Duration) -> f32 {
    c_info_m_per_s * depth as f32 * dt.as_secs_f32()
}
