# AGE-STT-1/U Rev. 1 — flight mechanics simulator

An HTML5 / three.js real-time physics simulation of the **AGE-STT-1/U Rev. 1**
UAV blueprint: a 720 mm slab-form VTOL demonstrator with no rotors, whose lift
comes from an anti-damping-surplus body force on a tiled perpendicular-MTJ
array.

> **This is a simulation of a speculative paper design.** Every force, TWR and
> hover-time figure is valid *if and only if* the blueprint's invented body-force
> law `F = N_live · κ · σ · n̂` holds at `κ₀ = 6.7×10⁻¹⁷ N·s/rad`. Every existing
> magnetomechanical measurement implies it does not. If Eq. (4) is false the
> vehicle produces zero new force and is an 18.4 kg MRAM plate with a 1.6 MW
> heater. The simulator is built to make that outcome visible, not to hide it.

## Running

ES modules will not load from `file://`, so serve the directory:

```bash
python3 -m http.server 8000     # then open http://127.0.0.1:8000/
```

`three` r160 is vendored in `vendor/`, so it runs fully offline.

## What is actually simulated

### Magnetization dynamics (inherited, unmodified — §2)

LLGS is not re-derived; the simulator hosts the blueprint's map from surplus
rate to force. Everything is computed from first principles each step, not
from a lookup of the published table:

| Quantity | Implementation |
|---|---|
| `u = γħηI / (2 e M_s V)` | `uOf(I)`, signed — `u > 0` is anti-damping (Eq. 2) |
| `I_c = 2 e α M_s V B_eff / (ħη)` | `IcOf()`, recomputed every step so it drifts with `B_eff(T)` (Eq. 2b) |
| `σ = max(0, u − αγB_eff)` | `sigmaOf()` — reverse polarity gives `u < 0` ⇒ `σ = 0` (Eq. 3) |
| `F = N_live κ σ n̂` | `forcePass()`, summed per bank (Eq. 4) |

The design-point cell (α = 0.010, B_eff = 0.80 T, I/I_c = 1.35) reproduces the
blueprint exactly: I_c = 370 µA, J_c = 7.78 MA/cm², σ = 4.93×10⁸ rad/s,
**F = 190 N**, TWR = 1.05, I_live = 2.87 MA, P_bus = 1.58 MW. Warm mode (0.80)
gives F = 0 at 0.94 MW; climb (1.67) gives 364 N / TWR 2.02 / 1.96 MW.

The four carried constraints are enforced structurally, not by special case:

- **C1** `F = 0` below `I_c` — falls out of `max(0, ·)`.
- **C2** polarity enters only through the sign of `u`; reversal zeros σ and can
  never produce negative g. Dump is not thrust reversal.
- **C3** force is extensive in `N_live` — the live-fraction slider scales force
  and bus power 1:1.
- **C4** no velocity dependence in the lift law. Airframe drag is separate.

### Flight mechanics (§7)

Eight 45° banks, B0 body-forward. Each bank carries its own `I/I_c`, its own σ,
and its own array normal, and the net force and moment are integrated as
`Σ F_i` and `Σ r_i × F_i` over a rigid disc (`I_zz = ½mR²`, `I_xx = ¼mR² + mh²/12`).

- **Heave** — common `I/I_c`, clamped at 1.67.
- **Roll / pitch** — opposite-bank Δσ, bank Δ(I/I_c) ≤ 0.15. Sign conventions
  follow the §7 channel table (positive pitch = nose up, positive roll = right
  side down); the roll allocation is negated for that reason, and the code says so.
- **Lateral** — common ±8 mT loop tilt of the local `p` and `H_eff`. The hull
  does **not** bank. The normal deflection is not a tuning constant: it is
  `atan(B_loop / B_eff)`, so 8 mT against 0.80 T buys **0.573°** and about
  **1.9 N** of side force on 18.4 kg.
- **Yaw** — the weak axis, and weak *for the right reason*: Eq. (4) has no
  azimuthal term, so yaw torque exists only as the tangential projection of a
  0.573° tilt. Full yaw command produces **0.44 N·m** against **9.4 N·m** of
  pitch authority. The 15 g·cm² hub wheel is modelled with its real inertia and
  saturates almost immediately — a damper, not a lift device.
- **GNC** — 2 kHz current loop, 200 Hz attitude loop; stick input is an attitude
  setpoint (±20°), read off the body up-axis.

### Why it does not fly (§6, §11) — modelled, not asserted

The simulator refuses to flatter the design:

- **Variant F / C pack.** The 5.2 kg pack is power-limited to ~104 kW against a
  1.58 MW demand. The bus sags, every bank's `I/I_c` scales down together, it
  falls below 1.0, the damping floor wins, and **σ → 0, F = 0**. The vehicle
  does not lift at all. You can switch off "enforce source power limit" to fly
  the paper-only regime — and then the 0.94 kWh pack empties in **2.1 s**,
  which is exactly the blueprint's number.
- **Variant T.** Restrained on a 6-axis load cell. Eq. (4) reads out as a
  **−190 N change in apparent weight** plus moment components, not as motion.
- **Thermal.** 4.39 MW/m² over the 0.36 m² deck, **71.9 kg/s** of dielectric
  coolant to hold a 20 K rise at DP (89 kg/s at climb, which saturates the
  loop). `B_eff` drifts with tile temperature, which moves `I_c` and therefore σ
  — so hover actually reads 188 N, not 190 N, once the deck warms.
- **Conversion efficiency** is displayed live: ~0.012 % at 1 m/s climb.
- **Fail-safe ladder** (§8), in order: `I/I_c` clamp → polarity dump → contactor
  / busbar breaker open → parachute. Because dump still draws full bus current,
  a coolant loss is *not* arrested by the dump; the breaker step is what stops
  the runaway. Press **L** to cut the coolant loop and watch the ms-scale PMA
  excursion.

### Falsification stays on the vehicle (§9, §10)

Variant **K** is the Step 0 article: 10⁴ cells on a torsion fibre in vacuum. It
draws **5.0 A / 2.74 W** and predicts **3.26×10⁻⁴ N** — the blueprint's
3.3×10⁻⁴ N. Drag the κ slider down: below the 10⁻⁸ N null floor the verdict
flips to *program retired*, and the 720 mm hull produces nothing at any current.

Competing real channels are computed alongside: Lorentz force from the
uncancelled conductor length (the 7 µm budget is a slider — exceed it and the
1 mN line goes red), the photon-recoil ceiling `P/c`, and the Einstein–de Haas
bound.

## Controls

`W`/`S` heave · `↑`/`↓` pitch · `←`/`→` roll · `Q`/`E` yaw · `A`/`D` lateral
tilt · `Space` dump · `P` parachute · `L` coolant loop · `K` kill a random bank
driver · `R` reset. Drag to orbit.

`window.SIM` exposes the state and parameter objects for console experiments,
e.g. `SIM.P.kappa = 1e-20`.

## Files

```
index.html    simulation, physics and instrumentation (single file)
vendor/       three.js r160 + OrbitControls
```

## Disclaimer

This reproduces a paper design that is itself a theoretical construction. It
does not describe a built device, a measured force, a government program, or a
method for producing weapons. Known real channels (Einstein–de Haas, photon
recoil, Lorentz) cannot be rescaled to 190 N inside this geometry.
