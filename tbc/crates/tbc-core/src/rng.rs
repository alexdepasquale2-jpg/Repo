//! Determinism primitives (§5).
//!
//! The authority step is deterministic given `(snapshot, intent set, rng_seed)`. That is
//! only true if the RNG is explicit, per-island, and consumed in a fixed order — so there
//! is no thread RNG anywhere in this crate.

use crate::ids::{FrameId, IslandId, Tick};

/// PCG64 XSL-RR multiplier.
const PCG_MULT: u128 = 0x2360_ED05_1FC6_5DA4_4385_DF64_9FCC_F645;
/// Default stream selector, used when a caller does not pick one.
const PCG_STREAM_DEFAULT: u128 = 0x5851_F42D_4C95_7F2D_1405_7B7E_F767_814F;

/// A per-island PCG64 generator.
///
/// Cloneable on purpose: a beam that forks branches forks its RNG with them, and a rewind
/// restores the generator alongside the snapshot.
#[derive(Clone, Debug)]
pub struct Pcg64 {
    state: u128,
    inc: u128,
}

impl Pcg64 {
    /// Seed on the default stream.
    #[must_use]
    pub fn new(seed: u128) -> Self {
        Self::with_stream(seed, PCG_STREAM_DEFAULT)
    }

    /// Seed on an explicit stream. Two generators with the same seed and different streams
    /// produce independent sequences.
    #[must_use]
    pub fn with_stream(seed: u128, stream: u128) -> Self {
        let mut rng = Self {
            state: 0,
            inc: (stream << 1) | 1,
        };
        rng.advance();
        rng.state = rng.state.wrapping_add(seed);
        rng.advance();
        rng
    }

    fn advance(&mut self) {
        self.state = self.state.wrapping_mul(PCG_MULT).wrapping_add(self.inc);
    }

    /// Next 64 bits.
    pub fn next_u64(&mut self) -> u64 {
        self.advance();
        let s = self.state;
        let xorshifted = ((s >> 64) ^ s) as u64;
        let rot = (s >> 122) as u32;
        xorshifted.rotate_right(rot)
    }

    /// Uniform in `[0, 1)`, 24 bits of mantissa.
    pub fn next_f32(&mut self) -> f32 {
        ((self.next_u64() >> 40) as f32) * (1.0 / ((1u64 << 24) as f32))
    }

    /// Uniform integer in `[lo, hi)`. Rejection-sampled, so no modulo bias.
    ///
    /// # Panics
    /// If `hi <= lo`.
    pub fn uniform_u64(&mut self, lo: u64, hi: u64) -> u64 {
        assert!(hi > lo, "uniform_u64 needs a non-empty range");
        let span = hi - lo;
        let zone = u64::MAX - (u64::MAX % span) - 1;
        loop {
            let v = self.next_u64();
            if v <= zone {
                return lo + (v % span);
            }
        }
    }

    /// Uniform index in `[0, n)`.
    ///
    /// # Panics
    /// If `n == 0`.
    pub fn uniform_index(&mut self, n: usize) -> usize {
        assert!(n > 0, "uniform_index needs a non-empty range");
        self.uniform_u64(0, n as u64) as usize
    }

    /// Box-Muller normal draw. Used for ledger noise (§8) and nothing on the hot path.
    pub fn gaussian(&mut self, mean: f32, sigma: f32) -> f32 {
        let u1 = (1.0 - self.next_f32()).max(f32::MIN_POSITIVE);
        let u2 = self.next_f32();
        mean + sigma * (-2.0 * u1.ln()).sqrt() * (core::f32::consts::TAU * u2).cos()
    }
}

/// Derive an island's seed: `blake3(frame || island || tick || genesis)`.
///
/// Deterministic across processes and restarts, and independent per island — so adding an
/// observer to one island cannot permute draws in another.
#[must_use]
pub fn island_seed(frame: FrameId, island: IslandId, tick: Tick, genesis: u128) -> u128 {
    let mut hasher = blake3::Hasher::new();
    hasher.update(&frame.0.to_le_bytes());
    hasher.update(&island.0.to_le_bytes());
    hasher.update(&tick.0.to_le_bytes());
    hasher.update(&genesis.to_le_bytes());
    let digest = hasher.finalize();
    let mut half = [0u8; 16];
    half.copy_from_slice(&digest.as_bytes()[..16]);
    u128::from_le_bytes(half)
}
