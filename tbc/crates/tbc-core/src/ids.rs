//! Canon identifiers (§12). Frozen at M0: these names do not change, only their budgets.

use core::fmt;

macro_rules! canon_id {
    ($(#[$meta:meta])* $name:ident($inner:ty)) => {
        $(#[$meta])*
        #[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
        pub struct $name(pub $inner);

        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}({})", stringify!($name), self.0)
            }
        }
    };
}

canon_id!(
    /// The soul. Outlives every avatar it ever wears; the EntropyLedger is keyed by it.
    IuocId(u128)
);
canon_id!(
    /// The session: a Free Will Awareness Unit, partitioned from an IUOC at login.
    FwauId(u128)
);
canon_id!(
    /// A disposable body. Generational, recycled per frame.
    AvatarId(u64)
);
canon_id!(
    /// A reality frame (PMR-Prime, an Academy zone, a nested dream).
    FrameId(u32)
);
canon_id!(
    /// A causality island: the connected component that can affect itself within the horizon.
    IslandId(u64)
);
canon_id!(
    /// An ExperiencePacket, carried between lives.
    PacketId(u128)
);
canon_id!(
    /// A resolved action, as referenced by a ledger event.
    ActionId(u64)
);
canon_id!(
    /// A ledger event. Ordering key alongside the due tick.
    EventId(u64)
);
canon_id!(
    /// Per-frame tick counter, starting at 0. Time is an integer; wall clock never
    /// enters a step function.
    Tick(u64)
);

impl Tick {
    /// The next tick.
    #[must_use]
    pub const fn next(self) -> Self {
        Self(self.0 + 1)
    }

    /// This tick advanced by `n`.
    #[must_use]
    pub const fn plus(self, n: u64) -> Self {
        Self(self.0 + n)
    }

    /// Ticks elapsed since `earlier`, saturating at zero.
    #[must_use]
    pub const fn since(self, earlier: Self) -> u64 {
        self.0.saturating_sub(earlier.0)
    }
}

/// ECS handle: index plus generation, so a recycled slot never aliases a stale reference.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct Entity {
    /// Dense slot index.
    pub index: u32,
    /// Generation, bumped on recycle.
    pub generation: u32,
}

impl Entity {
    /// A handle for `index` at `generation`.
    #[must_use]
    pub const fn new(index: u32, generation: u32) -> Self {
        Self { index, generation }
    }
}

impl fmt::Debug for Entity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Entity({}v{})", self.index, self.generation)
    }
}
