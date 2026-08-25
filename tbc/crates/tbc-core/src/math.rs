//! The little bit of geometry the sim core needs. No linear-algebra dependency at M1.

/// A position or offset in metres.
#[derive(Clone, Copy, PartialEq, Debug, Default)]
pub struct Vec3 {
    /// East.
    pub x: f32,
    /// Up.
    pub y: f32,
    /// North.
    pub z: f32,
}

impl Vec3 {
    /// Origin.
    pub const ZERO: Self = Self::new(0.0, 0.0, 0.0);

    /// A position in metres.
    #[must_use]
    pub const fn new(x: f32, y: f32, z: f32) -> Self {
        Self { x, y, z }
    }

    /// Squared distance, in m². Compare radii squared rather than paying a sqrt.
    #[must_use]
    pub fn distance_sq(self, other: Self) -> f32 {
        let (dx, dy, dz) = (self.x - other.x, self.y - other.y, self.z - other.z);
        dx * dx + dy * dy + dz * dz
    }

    /// Distance in metres.
    #[must_use]
    pub fn distance(self, other: Self) -> f32 {
        self.distance_sq(other).sqrt()
    }
}
