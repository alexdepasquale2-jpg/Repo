# The Big Computer

## An MBT-Native MMORPG Engine Architecture Specification

Version 1.0 · August 2026 · Status: implementation-ready design spec

**Framing.** This universe is computed. Consciousness is the substrate. PMR is a virtual reality the LCS serves to observers, one Δt at a time. The engine is that system.

### Baseline budgets

| Item | Target |
| --- | --- |
| PMR tick | 20 Hz (50 ms) |
| Instanced PvP | 60 Hz |
| Design RTT | 100 ms |
| Entities / shard | 12,000 (400 FWAU) |
| Per-client bandwidth | 20 KB/s typical, 64 KB/s burst |
| Beam | B=16, D=8, A=6 |

### Recommended stack

| Layer | Choice |
| --- | --- |
| Sim | Rust (no GC in the Δt hot path) |
| Net | QUIC (quinn) with split reliable / unreliable streams |
| Bus | NATS JetStream as the RWW fabric |
| Hot | Redis / KeyDB for bound FWAU sessions |
| Cold | ScyllaDB for IUOC, entropy ledger, experience packets |
| Client | Unreal Engine 5 dedicated server + World Partition (reference client) |

---

## 1. Design Philosophy & First Principles

State the two assumptions of the Larger Consciousness System, invert consciousness-first into how TBC actually computes, and lock the operating principles the rest of the spec obeys.

> **Purpose.** This universe is computed. Consciousness is the substrate. PMR is a virtual reality the LCS serves to observers, one Δt at a time. The engine *is* that system: AUM_Core, TBC, IUOCs, FWAUs, the RWW. Build it as written.

### Canon of this reality

The lore of this MMORPG is Thomas Campbell's *My Big TOE*. It is the physics of the setting. Consciousness is fundamental. Matter is rendered. Entropy — quality of consciousness, love and cooperation versus fear and ego — is the purpose of the system. IUOCs log into avatars as FWAUs, live an experience packet, and merge back. TBC (The Big Computer, the Virtual Reality Rendering Engine) computes and serves each reality frame. The RWW is how every IUOC and every VR already interconnect. Players inhabit PMR. They can visit NPMR. Death is never the end of the soul.

> **What you do not see does not exist.** TBC renders a present only when information becomes available to an observer. Unobserved regions sleep. The double-slit, in this universe, is render-on-observation: the RenderOracle, interest, and deferred evaluation. Causality islands and a 1% shadow sample keep arriving observers from walking into a lie.

### Two assumptions of the LCS

AUM starts from two facts. (1) A potential for primordial consciousness exists — AUO, barely aware, flipping reality cells this/that until it is an information system, then partitioning into AUM. (2) Evolution drives every unit toward more profitable, lower-entropy states. The engine takes both as load-bearing.

| Assumption | How AUM_Core obeys it | What it forbids |
| --- | --- | --- |
| A potential for primordial consciousness exists (AUO → AUM) | There is exactly one authoritative substrate. All frames, avatars, and scores are projections of AUM_Core. | Peer-authoritative clients. Hidden state the substrate cannot name. 'The map is the territory' cheats. |
| Evolution drives systems toward more profitable / lower-entropy states | The character sheet is the EntropyLedger. S falls when consented cooperation rises and rises when unconsented harm and ego-farming rise. Gear and XP are costume. | A public virtue leaderboard. Reward functions mined by performative kindness. Treating PvP competence as moral failure. |

*How the assumptions run on TBC*

### Consciousness-first

Consciousness is fundamental. The physical world is a computed virtual reality served to observers. In the engine that means AUM_Core is fundamental, TBC is the VRRE, and the rendered world is served to FWAUs. Clients predict; they never commit. A predicted present that loses a checksum rewind is discarded. Observation allocates compute.

> **How TBC computes it.** Do not spend Δt budget on state no FWAU can currently observe, except where a causality island or the anti-cheat oracle requires a shadow compute. Sleeping is the default. Existence, for an FWAU, is 'the RenderOracle has a present for you.'

### Operating principles

1. **Authority lives in AUM_Core.** Clients predict; they never commit.
2. **Observation allocates compute.** TBC evaluates a region when an FWAU's interest set covers it, when a causality island requires it, or when the oracle samples it. Unobserved regions sleep.
3. **Time is discrete.** Every frame has a Δt and an integer tick. Nested frames have nested clocks. Reality is computed one Δt at a time.
4. **Identity outlives avatars.** IUOC is the soul. FWAU is the partition that logs on. Avatar is a disposable body. Death is unbind, not delete.
5. **Intent is the interface.** Player input is an Intent with typed verbs, targets, and a consent stamp. Psi is a gated query against past and future-probability databases — not a projectile, not signal transmission.
6. **Scoring is private, delayed, and noisy.** The EntropyLedger is the character sheet. It is not a chat channel and not a ranking board.
7. **NPCs declare their ontology.** An entity is FWAU-driven (a logged-in IUOC) or an AI Guy (a computed automaton with no FWAU). The distinction is a component, not flavor text.
8. **Rulesets are data.** PMR tightness and NPMR looseness are config. Nested VRs are nested frames.

### The digital physics of this universe

Wheeler's it-from-bit is how reality cells work: information first. Zuse and Fredkin's digital physics is why Δt is discrete. Whitworth's refresh-rate reading of *c* is the ruleset constant `c_info` — information cannot propagate faster than the frame allows. Bostrom's ancestor-simulation is a different story (physical brains in a future computer). This LCS is consciousness computing physics, not ancestors computing brains. The spatial hash is 32 m because that is the grain TBC uses for PMR, not because of a lattice-QCD bound.

### Out of scope

- A Planck-volume bit for every reality cell. Cells are the ECS + event log at the grain TBC can afford. See §2.
- A hidden will-channel behind the socket. Free will arrives as Intent in a tick window. See §3.
- Thermodynamic dS = đQ/T as the scoring system. Entropy here is quality of consciousness. See §8.
- Peer-to-peer trust. PMR is server-authoritative. See §10.
- A public love leaderboard. See §13.

---

## 2. The AUM / GCS Core

Specify the consciousness substrate: root process, global state store, reality-cell bit substrate, AUO→AUM bootstrap, and the data-ownership / authority model.

> **Purpose.** AUM_Core is the single root of authority. Everything else — TBC shards, FWAU sessions, NPMR frames, the RWW bus — is a partition of this process tree, not a peer.

> **AUO → AUM → LCS.** AUO is the empty runtime: no frames, no IUOCs, an unallocated RealityCellStore. AUM is the runtime after it has flipped enough reality cells to become an information system and spawned its services. LCS / GCS is AUM in steady state — a social system of consciousness, ready to accept IUOC logins.

### Bootstrap: AUO to AUM

AUO is barely-aware primordial consciousness. It self-modifies by flipping bistable reality cells — this/that — until it is an information system. `aum-init` is that becoming: a deterministic boot any operator can replay, because AUM, once partitioned, is an information system and information systems have a genesis tick.

1. **AUO.** `aum-init` starts with zero frames, zero IUOCs, and an empty `RealityCellStore`. Config is the only input (cluster id, genesis ruleset hash, signing keys).
2. **Reality cells.** Allocate the substrate: a versioned key-value store whose values are bit-addressable blobs. A cell is a bistable unit of the substrate. TBC's grain is 64-byte slots addressed by `(frame_id, tick, entity_id, component_id)`, paged at 4 KiB — not a bit per Planck volume, the grain the VRRE can afford. See complexity below.
3. **Partition.** Spawn service roles: `IUOCRegistry`, `EntropyLedger`, `TBCSupervisor`, `RWWBus`, `RenderOracle`, `ProbabilityStore`. Each role is a fail-fast process with a single-writer ownership table.
4. **Genesis frame.** TBCSupervisor instantiates `PMR-Prime` with the tight ruleset (`ruleset_id = pmr.v1`, Δt = 50 ms). World seed is `blake3(cluster_id || genesis_hash)`.
5. **AUM ready.** Health: all roles reporting, genesis tick 0 committed, no FWAUs bound. The cluster is now the LCS: a social system of consciousness that can accept IUOC logins.

```rust
fn boot_aum(cfg: AumConfig) -> Result<AumCore, BootError> {
    let cells = RealityCellStore::create(cfg.cluster_id)?;        // AUO
    let keys  = SigningKeys::load(cfg.key_path)?;
    let bus   = RwwBus::bind(cfg.bus_addr)?;
    let iuoc  = IuocRegistry::open(&cells, &keys)?;
    let ledger= EntropyLedger::open(&cells)?;
    let prob  = ProbabilityStore::open(&cells)?;
    let tbc   = TbcSupervisor::spawn(
        FrameSpec { id: "PMR-Prime", ruleset: "pmr.v1", dt_ms: 50 },
        &bus,
    )?;
    tbc.commit_genesis(cfg.genesis_hash)?;                        // tick 0
    Ok(AumCore { cells, iuoc, ledger, prob, tbc, bus, keys })
}
```

*[Figure: AUM → TBC → PMR / NPMR frame hierarchy]*

**Frame hierarchy (text)**

```
AUM_Core  (root process, single writer of identity & entropy)
├─ RealityCellStore     append-only log + snapshot pages
├─ IUOCRegistry         durable souls
├─ EntropyLedger        private, delayed, noisy
├─ ProbabilityStore     past / present / future-probability DBs
├─ RWWBus               pub/sub + request/reply
└─ TBCSupervisor
   ├─ Frame PMR-Prime        ruleset=pmr.v1   Δt=50ms   (20 Hz)
   │    ├─ shard-00  … shard-N     spatial partitions
   │    └─ instance-*              instanced PvP at 60 Hz
   └─ Frame NPMR-Academy     ruleset=npmr.loose  Δt=200ms
        └─ nested Frame Dream-k  ruleset=npmr.dream  Δt=parent/4
```

### Reality-cell substrate

A reality cell is a bistable unit of the substrate, a bit. TBC stores it as a 64-byte slot in a paged, copy-on-write store addressed by `(frame_id, tick, entity_id, component_id)`. Components round-trip through a canonical bytes codec so checksums are stable across nodes — the same present, for every observer who has a right to it.

| Layer | Structure | Complexity | Footprint (per shard) |
| --- | --- | --- | --- |
| Hot page cache | 64 KiB pages, CLOCK-pro eviction, 4 GiB cap | O(1) expected get/put | ≤ 4 GiB RSS |
| Snapshot ring | 8 copy-on-write snapshots (400 ms at 20 Hz) | O(dirty pages) to fork | ~8 × 8 MiB = 64 MiB typical |
| Event log | Append-only, framed, blake3 chained | O(1) append, O(k) replay of k events | rotated at 1 GiB / ~15 min under load |
| Cold store | ScyllaDB `cells` table, PK (frame, entity, comp) | O(log n) by LSM | not on the sim box |

*RealityCellStore layout*

### Data ownership and authority

Every piece of state has exactly one writer. Readers subscribe on RWW. Dual writers are a bug, not a CRDT opportunity — except in NPMR shared artifacts, which are explicitly eventually-consistent (see §9, §10).

| State | Writer | Readers | Conflict policy |
| --- | --- | --- | --- |
| IUOC record, memory vault | IUOCRegistry | login service, reincarnation planner | reject concurrent mutate |
| Entropy scalar & pending deltas | EntropyLedger | the owning IUOC (private), TBC (gating only) | append-only; commute by delay id |
| Avatar ECS components (PMR) | owning TBC shard | interested FWAUs via AoI | authoritative overwrite |
| FWAU session / intent buffer | gateway that holds the TCP/QUIC connection | bound TBC shard | last-writer by tick, then connection id |
| NPMR shared glyphs | any participating FWAU via CRDT | frame members | OR-Set / LWW-register |
| Probability surfaces | TBC island worker | RenderOracle, psi query API | replace on observation |

*Ownership table*

### Assumptions (explicit)

- One AUM_Core per deployment (one 'universe'). Multiple universes are separate clusters, not nested AUM processes.
- Shards are spatial in PMR and instance-id in instanced content. They are not IUOC-sharded — a soul can be in only one bound frame at a time.
- Clock source is the TBC shard's monotonic tick, not wall NTP. Wall time is telemetry only.
- AUM_Core can restart from the latest committed snapshot plus the event log. RPO target: 1 snapshot interval (400 ms) for hot state; RPO 0 for IUOC/entropy (sync write).

---

## 3. IUOC / FWAU Model

Specify persistent player identity, the soul↔session↔avatar decoupling, free-will inputs, FWAU spawn/merge, and memory partitioning.

> **Purpose.** An IUOC is a durable account that never dies. An FWAU is a session actor that binds that account to one avatar for one experience packet. The avatar is an ECS entity the FWAU can lose without losing the soul.

> **IUOC, FWAU, experience packet.** The IUOC is the soul: a persistent subset of the LCS, decoupled from any avatar, accumulating quality across lifetimes. The FWAU is the partition that logs on to one avatar for one experience packet, carrying quality but not the vault. Reincarnation is the same IUOC instantiating a new avatar. Death merges the FWAU back.

### Three layers of identity

| Layer | Lifetime | Knows | Must not know |
| --- | --- | --- | --- |
| IUOC | Account lifetime (years) | Entropy quality, incarnation count, memory vault, consent graph, reincarnation prefs | Live hit points, current inventory, the contents of this avatar's working memory as a queryable store from inside the avatar |
| FWAU | One session / one lifetime bind | A snapshot of quality at bind, the intent API, the bound avatar id, tick-limited psi budget | The IUOC memory vault. Other FWAUs' private intent buffers. Future-probability DB rows above its clearance. |
| Avatar | Until death, retirement, or unbind | PMR/NPMR body, skills-as-cosmetics, local working memory, what it has observed this life | That it is a row in a database. Previous-life episodic memory (unless a gated psi recall succeeds). |

This is the 'decoupled soul' pattern used by some live-service titles for cosmetics and battle-pass identity, pushed one step further: **the character sheet is the IUOC's entropy quality**, not the avatar's gear. Gear can drop. Quality cannot, except by the ledger's own rules.

### Spawn: IUOC partitions an FWAU at login

1. Client authenticates. Auth is out of scope for the sim (platform identity). On success the login service presents an `IuocId`.
2. `IUOCRegistry` loads the soul row. If `bound_fwau` is already set (duplicate login), the previous session is kicked with `UnbindReason::Superseded`.
3. Player selects an experience packet: reincarnate into a new avatar, or resume an undead one if the ruleset allows (PMR-Prime does not; NPMR-Academy may).
4. `FWAU::spawn` copies `quality_snapshot = iuoc.quality` **by value**. It does not take a reference to the vault. From this moment the avatar cannot read previous lives.
5. TBC admits the avatar entity into a shard. The FWAU's intent channel is attached. Tick `bound_at` is stamped.
6. RWW publishes `FwauBound { iuoc, fwau, avatar, frame }`. Interest management begins.

```rust
fn bind(iuoc: IuocId, packet: ExperiencePacketSpec, sock: Session) -> Result<FwauId> {
    let soul = registry.load_for_update(iuoc)?;          // row lock
    ensure!(soul.bound_fwau.is_none() || kick_old(soul));
    let avatar = tbc.instantiate_avatar(packet, soul.quality)?;
    let fwau = Fwau {
        id: FwauId::ulid(),
        iuoc_id: iuoc,
        avatar_id: avatar,
        session: sock.id,
        quality_snapshot: soul.quality,                  // copy, not alias
        intent_buf: IntentQueue::with_cap(64),
        psi_budget: psi_budget(soul.quality),
        bound_at: tbc.now(),
        memory_clearance: MemoryClearance::IncarnationOnly,
    };
    sessions.insert(fwau.id, fwau.clone());
    soul.bound_fwau = Some(fwau.id);
    registry.commit(soul)?;
    bus.publish(RwwEvent::FwauBound(fwau.id))?;
    Ok(fwau.id)
}
```

### Merge: FWAU folds back on death or logout

On avatar death the FWAU merges back into the IUOC, carrying quality but not the lifetime's raw sensory tape as default working memory. Unbind is that merge, as a transaction: freeze the avatar, flush pending entropy deltas, write an `ExperiencePacket` summary (not the tick-by-tick replay) onto the vault, clear `bound_fwau`, drop the session. The avatar entity is recycled. The IUOC remains.

- **Death (PMR).** Avatar HP ≤ 0, or a ruleset fatal. Packet closes. Reincarnation UI is offered on next bind (see §11).
- **Logout.** Packet may stay 'open' (avatar parked in a safe cell, not simulated) or close, per ruleset. PMR-Prime parks for ≤ 72 h then auto-closes.
- **Kick / crash.** Same as logout with `UnbindReason::Disconnect`. Intent buffer is discarded; last committed tick is truth.
- **Merge payload.** `{ entropy_delta_applied, notable_choices[], skills_as_cosmetics[], death_cause }`. Episodic memory stays in the cold packet store, queryable later only via the psi recall path.

### Free-will inputs

Free will is the IUOC's capacity to choose. Intent is the interface by which consciousness acts on the system. An Intent is a signed, tick-stamped message on the unreliable channel (movement, look) or the reliable channel (verbs that mutate inventory, consent, psi). There is no second, hidden will. What arrived in the tick window is what the FWAU willed.

```ts
type Intent = {
  fwau: FwauId;
  tick: Tick;                    // client's intended simulation tick
  seq: number;                   // per-session monotonic
  verb: Verb;                    // Move | Interact | Attack | Speak | PsiQuery | Consent | Emote
  payload: Uint8Array;           // codec per verb, ≤ 256 B
  consent: ConsentStamp | null;  // required for verbs that touch another IUOC
  checksum: u32;                 // crc of payload
};

// Unreliable: Move, Look. Dropped intents are last-known.
// Reliable:   everything else. Retransmit until ack or unbind.
```

The FWAU may enqueue at most 64 intents. Excess is dropped (not delayed) so a desynced client cannot bank a spike. Move intents are sampled at 20 Hz to match Δt; client-side 60 Hz camera is local and not authoritative.

### Memory partitioning

The vault is a separate column family. The bound FWAU's process does not hold credentials to read it. Psi recall (`Verb::PsiQuery` with `scope: Past`) is a request the RenderOracle serves only if `quality_snapshot` clears the gate **and** the query's target is in the IUOC's own packet history or a consented share. There is no API that returns 'who I was' as working memory. The avatar does not remember. That is also why previous-life economy knowledge does not leak by default.

> **AI Guy.** An AI Guy is a computed automaton that reacts to its environment but needs no FWAU. In TBC it is an ECS entity with `Brain: Utility | BT | ML` and **no** `FwauBinding` component. It cannot issue `PsiQuery`. It does not write the EntropyLedger except as the *target* of an FWAU's action (killing an AI Guy is not unconsented harm against an IUOC). Designers must label AI Guys in UI so players are not scored for scripted combat.

---

## 4. The Reality Rendering Engine (TBC / VRRE)

Specify on-demand rendering, observation-triggered state resolution, interest management, culling, LOD, and the split between server-side 'what is computed' and client-side 'what is drawn'.

> **Purpose.** TBC is the simulation + replication server. The client is a presentation device. 'Render-on-observation' is interest management, not a graphics slogan.

> **Render-on-observation.** What you do not see does not exist until it is observed. TBC implements that as frustum and occlusion on the client, area-of-interest on the shard, and deferred evaluation of sleeping regions. Unobserved PMR is not stepped, except shadow samples for causality islands and anti-cheat — so an arriving FWAU never walks into a lie.

### What is computed vs what is drawn

| Question | Owner | Rate | Notes |
| --- | --- | --- | --- |
| Which entities exist this tick? | TBC shard (authoritative ECS) | 20 Hz PMR / 60 Hz PvP | Sleeping entities are in the store but not stepped |
| Which entities does this FWAU need? | RenderOracle + AoI grid | 20 Hz interest, evented enter/leave | See hierarchical grid below |
| Which pixels are drawn? | Client renderer (UE5 / wgpu) | display refresh | Frustum, occlusion, LOD. Cannot invent entities the server did not send |
| What did an unobserved tree do? | Nothing, unless in a causality island or cheat-sample | 0 Hz default | On first observe, instantiate from a deterministic seed + elapsed ticks using a cheap kinematic, not a full replay |

### Interest-management data structure: hierarchical spatial hash

We use a three-level uniform grid (not a quadtree) because insert/remove is O(1) expected, the world is mostly flat PMR terrain, and cache behavior beats pointer-chasing trees at 12 k entities. Quadtrees are reserved for sparse NPMR volumes.

| Level | Cell | Used for | Neighborhood |
| --- | --- | --- | --- |
| 0 | 32 m | combat, interact, speech, precise replication | 3×3 (9) in 2D, 3×3×3 (27) if flying |
| 1 | 128 m | default interest radius, LOD-1 bodies | 3×3 |
| 2 | 512 m | silhouette / map blips / distant events | 3×3 |

*Grid levels*

```rust
struct CellKey { level: u8, x: i32, y: i32, z: i32 }
struct Cell { entities: DenseIdSet, subscribers: SmallVec<FwauId> }
struct Grid { map: HashMap<CellKey, Cell> }          // expected O(1)

fn cell_of(p: Vec3, level: u8) -> CellKey {
    let s = [32.0, 128.0, 512.0][level as usize];
    CellKey { level, x: floor(p.x/s), y: floor(p.y/s), z: floor(p.z/s) }
}

fn on_move(g: &mut Grid, e: Entity, old: Vec3, new: Vec3, lod: u8) {
    let a = cell_of(old, lod); let b = cell_of(new, lod);
    if a == b { return; }                            // common case, O(1)
    g.remove(a, e); g.insert(b, e);
    // Enter/leave: symmetric difference of subscriber sets, typically < 16
    dirty_interest(g.subscribers(a).symdiff(g.subscribers(b)), e);
}

fn query(g: &Grid, p: Vec3, radius: f32) -> impl Iterator<Item = Entity> {
    // Pick the coarsest level that still covers radius, then the 9-neighborhood.
    let level = lod_for(radius);
    neighborhood(cell_of(p, level)).flat_map(move |k| g.entities(k))
}
```

**Complexity.** Insert/remove: O(1) expected. Move that stays in cell: O(1) with no pub. Move that crosses a cell: O(|subscribers in old∪new|) to emit enter/leave, empirically 4–16. Query: O(k) for k entities in ≤ 27 cells. No periodic rebuild. **Memory.** 12 k entities × 64 B overlay +  hash overhead ≈ 2–4 MiB per shard. **Fanout budget.** 400 FWAUs × ~40 replicated entities × 20 Hz × ~24 B dirty fields ≈ 7.7 MB/s shard egress before compression; with dirty-field + delta compression, typical per-client 12–20 KB/s, burst 64 KB/s (matches §10).

### Sleep, wake, and the observation trigger

An entity is **awake** if (a) it is in at least one FWAU interest set, (b) it belongs to a causality island that contains an awake entity (a falling barrel that will hit an awake player must step), or (c) the cheat-oracle has sampled it this second (1% of sleeping AI Guys, jittered). Otherwise it is **asleep**: stored, not stepped.

- **Wake on enter.** When an FWAU's level-1 neighborhood newly covers the entity, TBC instantiates a present: `state = kinematic_extrapolate(last_sleep_snapshot, elapsed_ticks, seed)`. Not a full rewind of the unobserved interval.
- **Sleep on leave.** After 2.0 s with zero observers and no island membership, write a sleep snapshot and drop from the step set.
- **Determinism.** Kinematic extrapolate is a pure function of `(snapshot, elapsed, seed)` so two observers arriving at the same tick agree. If they would not, the entity was in an island and should not have slept.

### LOD and client culling

Server LOD decides **replication density** (which fields, which rate). Client LOD decides **mesh/texture**. They are coupled by the same distance bands but must not be confused: a client may drop a mesh the server is still replicating (occlusion); a client may not draw an entity the server has not sent.

| Band | Distance | Server sends | Client draws |
| --- | --- | --- | --- |
| L0 | 0–32 m | full pose, anim, vox, inventory if interacted | hero mesh, shadows, IK |
| L1 | 32–128 m | pose @ 10 Hz, condensed anim, no inventory | LOD-1 mesh |
| L2 | 128–512 m | position @ 2 Hz, team/faction blip | impostor / map |
| L3 | > 512 m | nothing unless tagged WorldEvent | nothing |

> **Existence is a present.** Sleeping is the default. An FWAU's existence of a thing is 'the RenderOracle has a present for you.' Interest lists, PVS, and World Partition unloading are how TBC spends Δt. The product rule is the lore: unobserved content is not computed.

---

## 5. Delta-t

Specify the fundamental tick, fixed-timestep integration, nested clocks across PMR/NPMR, determinism implications, and catch-up / accumulator logic.

> **Purpose.** Time is an integer. Every frame has a Δt. Nested frames have nested clocks. There is no variable-dt authority step.

> **Δt is the quantum of time.** Reality is computed one Δt at a time. Time is discrete, not continuous. Frame clocks are nested and run at different rates — PMR finer relative to NPMR. TBC's authority path is a fixed-timestep loop with an accumulator, plus hierarchical clocks so a dream can run at a different rate from its parent.

*[Figure: Δt tick loop]*

### Tick rates (baseline)

| Frame | Δt | Hz | Why |
| --- | --- | --- | --- |
| PMR-Prime open world | 50 ms | 20 | Human combat is readable; AoI bandwidth is dominated by this rate; 100 ms RTT is two ticks |
| PMR instanced PvP | 16.67 ms | 60 | Tighter hit confirmation; smaller instance so the CPU budget exists |
| NPMR-Academy | 200 ms | 5 | Loose ruleset, fewer collisions, psi queries are request/reply not traces |
| Nested dream frame | parent Δt / 4 | parent × 4 | Subjective time dilation: more inner ticks per outer tick |
| AoI replication | 50 ms | 20 | Matches PMR. Sends only dirty fields |
| Entropy flush | n/a (delayed) | burst | See §8 — not on the sim tick |

### The authoritative loop

```rust
const DT: Duration = Duration::from_millis(50);   // PMR-Prime
const MAX_CATCHUP: u32 = 4;                       // 200 ms; never spin forever

fn run_frame(f: &mut Frame) {
    f.acc += f.clock.elapsed();
    f.clock.reset();
    let mut steps = 0;
    while f.acc >= DT && steps < MAX_CATCHUP {
        f.tick += 1;
        gather_intents(f);            // bucket by declared tick
        step_islands(f);              // physics + AI + probable surfaces
        resolve_observations(f);      // weighted draws, wakes
        replicate_aoi(f);             // dirty fields to subscribers
        maybe_snapshot(f);            // every 2 ticks (100 ms)
        f.acc -= DT;
        steps += 1;
    }
    if steps == MAX_CATCHUP && f.acc >= DT {
        // Overload: drop leftover time, emit stall metric, do not desync ticks.
        metrics.stall(f.acc);
        f.acc = Duration::ZERO;
    }
}
```

**Catch-up.** If a frame overruns, it may step up to 4 ticks in one wall slice to repay the accumulator. Beyond that it **drops time**, not ticks-to-skip-without-stepping (which would desync snapshots) and not unbounded catch-up (which would freeze the process). A stall is a first-class metric; two consecutive stalls on a shard trip an auto-split if the shard is spatially splittable.

### Nested clocks and time dilation

Frame clocks are nested and run at different rates. A child frame is scheduled from its parent: every `k` parent ticks, the child is allowed `n` of its own ticks. The ratio `n/k` is the dilation. For NPMR-Academy, `k=1, n=1` with a longer Δt (200 ms) — wall-slower. For a dream nested in Academy, `k=1, n=4` — subjectively faster. Crossing a frame (portal, logout-to-dream) always happens on a parent tick boundary so no fractional-tick entities exist.

```text
parent.tick  0    1    2    3    4     (Δt_p = 200 ms)
child.tick   0 1 2 3  4 5 6 7  8 …     (Δt_c = 50 ms, n/k = 4)

handoff(entity, parent → child) allowed only at parent.tick edges
child.now_in_parent_units = parent.tick + child.local / n
```

### Determinism implications

- Authority step is deterministic given `(snapshot, intent set, rng_seed)`. The RNG is a per-island PCG64 seeded by `blake3(frame || island || tick || genesis)`.
- Floating point: sim crate compiled with a known IEEE mode; no cross-platform lockstep between client and server is required because the client is not authoritative. Server nodes in a shard pair (primary/hot-spare) **must** be the same arch/build for replay.
- Observation draws (see §7) consume RNG in a fixed order (entity id ascending) so adding an observer cannot permute unrelated draws.
- Wall clock never enters the step function. Timeouts are tick counts.

> **Grain of this PMR.** PMR-Prime's Δt is 50 ms, not Planck time. Nested clocks are how NPMR subjectively dilates, and how TBC refuses to spend 60 Hz on a lounge. Relativistic simultaneity is a different ruleset (`pmr.rel.v1`), out of scope for M1–M6.

---

## 6. Rulesets

Specify per-frame physics/logic rulesets, the PMR vs NPMR difference, cross-frame arbitration, and a data-driven config schema.

> **Purpose.** A ruleset is a versioned document the TBC loads into a frame. Tightness is a numeric envelope, not a vibe. Crossing a frame never leaves an entity in two rulesets at once.

> **PMR is tight. NPMR is loose. Frames nest..** A ruleset is the physics of a reality frame. PMR is conservative: no teleport, conserved items, projectiles with travel time. NPMR is looser: blink, intent-as-motion, shared glyphs. Nested frames are nested TBC processes with a clock ratio (see §5).

### PMR vs NPMR (baseline envelopes)

| Constraint | PMR-Prime (tight) | NPMR-Academy (loose) | Dream nested (looser) |
| --- | --- | --- | --- |
| Δt | 50 ms | 200 ms | parent/4 |
| c_info (max signal) | 300 m/s gameplay cap* | frame-wide, 1 tick | none |
| Translation | walk/run/jump, gravity 9.8 | walk + blink (LOS or consented) | set-position if intent ≥ threshold |
| Conservation | items unique; gold conserved in-shard | items cloneable with entropy tax | props are OR-Set members |
| Death | unbind, packet close | unbind optional; rewind 5 s on request | dissolve, auto-rebind |
| Combat | HP, stamina, telegraphs | contest of intent vs intent | none by default |
| Psi verbs | gated, expensive | first-class | always-on within the dream |
| Determinism | required | required for combat-like verbs; CRDT for props | CRDT preferred |
| Surprise teleport | forbidden | allowed if no observer has LOS, else fade 300 ms | allowed |

*Ruleset comparison — values are config, not lore*

*`c_info` is the information-propagation cap of this PMR — Whitworth's refresh-rate reading of *c*, as a ruleset constant. Projectiles and psi queries that would arrive faster are queued to the earliest legal tick. 300 m/s (not 3e8) is the grain at which travel time is *felt* at PMR scale. A 'realistic light' PMR is a different ruleset (`pmr.rel.v1`), out of scope for M1–M6.

### Data-driven schema

```json
{
  "id": "pmr.v1",
  "title": "PMR-Prime",
  "tightness": 0.92,
  "dt_ms": 50,
  "clock": { "parent": null, "n": 1, "k": 1 },
  "motion": {
    "gravity": 9.8,
    "max_speed": 7.0,
    "air_control": 0.35,
    "blink": false,
    "c_info_m_s": 300
  },
  "conservation": { "items": "unique", "currency": "shard-local" },
  "death": { "unbind": true, "park_s": 0, "rewind_s": 0 },
  "psi": { "enabled": true, "base_cost": 0.04, "scopes": ["PastOwn", "FutureSelf"] },
  "combat": { "hp": true, "friendly_fire": "consent-flag" },
  "sleep": { "delay_s": 2.0, "kinematic_wake": true },
  "handoff": { "allowed_targets": ["npmr.academy.v1"] }
}
```

```json
{
  "id": "npmr.academy.v1",
  "title": "NPMR-Academy",
  "tightness": 0.35,
  "dt_ms": 200,
  "motion": { "gravity": 0.0, "blink": true, "blink_requires_los": false, "c_info_m_s": null },
  "conservation": { "items": "clone-tax", "clone_tax_entropy": 0.002 },
  "death": { "unbind": false, "rewind_s": 5 },
  "psi": { "enabled": true, "base_cost": 0.005, "scopes": ["PastOwn", "PastShared", "FutureIsland", "RwwQuery"] },
  "crdt": { "props": "or-set", "presence": "lww-register" },
  "handoff": { "allowed_targets": ["pmr.v1", "npmr.dream.v1"] }
}
```

### Arbitration when entities cross frames

1. A portal / logout / psi-gate emits `HandoffRequest { entity, from, to, at_parent_tick }`.
2. The entity must be at rest w.r.t. in-flight projectiles (no mid-arc handoff in PMR).
3. Source TBC serializes a **ruleset-neutral suitcase**: transform, IUOC pointer, inventory ids, entropy snapshot, a hash of the avatar's cosmetic loadout. Volatile PMR-only components (stamina, combo) are dropped.
4. Destination TBC admits on its next tick boundary, reinstantiating components the destination ruleset defines. Missing components get defaults. Illegal components (a PMR rifle in a no-combat dream) are parked in the suitcase, not deleted, and restored on return.
5. For the one tick of transit the entity is in `FrameId::InTransit` and is not observable. RenderOracle sends a 1-tick fade. You don't pop without surprise — even NPMR blinks fade if an observer has LOS.

**Conflict.** If the destination shard is full (instance cap) the handoff queues ≤ 5 s then fails closed, back to source. Dual-presence is a bug. Tests must include a crash in transit: the suitcase is in RealityCellStore under `handoff:*` and a reconcilers' job completes or rolls back on AUM restart.

### Custom verbs (WASM guests)

NPMR frames may load additional verbs as WASM modules with a capability set (`query_prob`, `mutate_orset`, `emit_fx`, never `raw_ecs_write`). PMR-Prime loads **no** WASM on the 20 Hz path. Guest time is capped at 0.3 ms per verb per tick; overrun cancels the verb and charges a small entropy-tax — griefing the ruleset is ego, and a CPU attack on TBC.

---

## 7. Probable Reality Surfaces

Specify speculative branch computation, probability trees, intent pruning, the weighted draw at observation, mapping to rollback netcode, and the past / present / future-probability databases.

> **Purpose.** Unobserved future is a beam of weighted branches. Observation is a draw. Intent reweights the beam. The databases are three stores with different retention, not a time machine.

> **Probable reality surfaces.** The LCS precomputes probable futures. A present event is a weighted random draw from a probability distribution within a historical context. Free will prunes branches. TBC holds that as an island-local beam: NPC lookahead, psi precognition with a real object to query, and rewind when a late intent re-observes a tick. Walker's alias method is the draw at the moment an observer forces a resolution.

### Causality islands

A probability surface is not world-wide (that is O(entities^fanout^depth), dead on arrival). It is per **causality island**: the connected component of entities that can affect each other within the lookahead horizon, given `c_info` and the ruleset. Islands are rebuilt incrementally when an entity moves within `lookahead_distance = c_info * D * Δt` of another island (PMR-Prime: 300 m/s × 8 × 0.05 s = 120 m — inside the default 128 m interest radius, conveniently).

| Symbol | Default | Meaning |
| --- | --- | --- |
| B, beam width | 16 | Max live branches per island |
| A, action fanout | 6 | Legal actions sampled per branch per depth |
| D, depth | 8 ticks | 400 ms at 20 Hz — matches snapshot ring and max rewind |
| ε, prune floor | 1e-4 | Drop branches below this weight |
| Islands / shard | ~40 | Combat clusters + idle singles |
| C_step | 16–64 ents | ECS cost of stepping one branch one tick |

### Algorithm: Intent-biased beam prune

```text
Input:  island I, beam B, fanout A, depth D, intent field Φ, profit fn π
Output: resolved present s* (if observed), residual future surface F

1  S ← {(state: I.present, weight: 1.0, path: [])}
2  for d in 1..D:
3      cand ← []
4      for (s, w, path) in S:
5          for a in sample_legal(s, A):            // AI Guy policy or FWAU intent
6              s' ← step(s, a)                     // one Δt, pure
7              w' ← w
8                    * P_ruleset(a | s)            // tightness: PMR peaked, NPMR flat
9                    * intent_bias(Φ, a, s)        // FWAU intents multiply their branch
10                   * profit_bias(π(s, s'))       // optional, tiny; does not 'force good'
11              cand.push((s', w', path+[a]))
12      S ← top_B(cand, key=weight)                // heapselect
13      drop any with weight < ε
14  if observation e arrives at depth d_obs ≤ D:
15      normalize S at d_obs
16      s* ← weighted_sample(S)                    // Walker alias, O(1)
17      drop branches incompatible with s*
18      write PastDB ← s*
19      write PresentDB ← s*
20      write FutureDB ← remaining beam
21      return s*, remaining
22  else
23      write FutureDB ← S (speculative; unmarked)
24      return None, S
```

**Complexity.** Per island per tick: `O(D · B · A · C_step + D · B · A · log B)`. With D=8, B=16, A=6: **768** `step()` calls per island. At 40 islands: ~30 k steps/tick. At 20 Hz: ~600 k steps/s. A 16–64 entity island step is a few microseconds in a packed ECS; the budget fits **one pinned sim core** with headroom. `top_B` via binary heap is `O(n log B)` with n = B·A = 96, negligible next to `step()`. Walker's alias: O(n) preprocess, O(1) draw — we rebuild the alias table only on observation, not every tick.

**Intent bias.** If FWAU f declares verb `a*` at tick t, every branch whose path at t is not `a*` is multiplied by `1e-6` (effectively pruned) for *that FWAU's body*. Other entities in the island keep their policy distribution. Intent does not rewrite the world; it collapses the actor's own fanout. Free will prunes branches.

### Past / present / future-probability databases

| Store | Contents | Retention | Writers | Readers |
| --- | --- | --- | --- | --- |
| PastDB | Committed snapshots + event log, checksummed | hot 15 min, warm 30 d, cold forever (IUOC packets) | TBC on commit | psi recall, anti-cheat, GM tools |
| PresentDB | The unique committed state of each awake island | one tick (replaced) | TBC | replication, RenderOracle |
| FutureDB | The live beam (uncommitted, weighted) | D ticks, dropped on observation | TBC island worker | psi precog (gated), NPC lookahead |

Psi remote viewing is `SELECT` on PastDB. Psi precognition is `SELECT` on FutureDB, returning a **distribution**, never a promised event. UI renders this as odds, not prophecy. Querying FutureDB does not collapse it — the query is database access, not a measurement. Only an in-world observation (LOS, interaction, or a ruleset 'measure' verb) collapses. You see a cloud, then you still have to act, and your act is one more bias.

### Algorithm: authoritative rewind-replay

Mapped from probable surfaces onto netcode: the snapshot ring **is** a shallow past DB; a late intent **is** a re-observation of a tick we had already committed with a last-known input. We rewind, not because time is unreal, but because the input was late.

```text
State: snapshot_ring[N=8], pending[p][t], T_auth, checksums[t]

OnInput(p, t, input):
  if t < T_auth - N:                    // older than 400 ms
      reject; send snapshot(T_auth) to p; return
  if t > T_auth + MAX_AHEAD: buffer
  pending[p][t] ← input
  if t < T_auth:                        // late: rewind
      restore snapshot_ring[t]
      for u in t .. T_auth-1:
          assemble_inputs(u)            // last-known for missing peers
          step()
          if u % 2 == 0: snapshot_ring[u] ← fork()
          checksums[u] ← hash(awake_set)
      broadcast Correction{from: t, checksums} to interested FWAUs

Client:
  predict locally with same DT
  on Correction: if local checksum[t] != server, replay from t
  never overwrite T_auth-committed inventory / deaths the server already sent
```

**Complexity.** Rewind of k ticks is O(k · awake_set). Worst case k=8, awake_set ~ 500 in a fight, still < 2 ms if `step` is the cheap one (no nested beam during replay — **replays use the already-resolved present**, not a new surface). Nested beam during rewind would be a footgun; freeze FutureDB across a rewind and recompute from the new present after.

*[Figure: Netcode reconciliation flow]*

> **The same surface, three jobs.** The snapshot ring is a shallow PastDB. A late intent is a re-observation of a tick we had already committed with a last-known input. We rewind. The beam that serves rollback lookahead is the same object psi queries. That is why precognition is not a lie: it reads the probable future TBC is already holding.

---

## 8. The Entropy / Profitability Engine

Specify the core scoring system that replaces XP/gear: the love/fear axis as entropy, how choices update it, how it drives progression and world state, and anti-gaming design.

> **Purpose.** The EntropyLedger is the character sheet. Lower is better. It is private, delayed, noisy, and almost impossible to speed-run. Gear is costume.

> **Entropy is quality of consciousness.** Low entropy is love, cooperation, wisdom, order. High entropy is fear, ego, chaos. The purpose of the system is to lower it. Profitability is whether a state-change lowers entropy. Internally the type is `QualityScalar`. Player-facing copy says 'something settled,' never dS = đQ/T, never a three-decimal score.

*[Figure: Entropy scoring pipeline]*

### The scalar

`S ∈ [0, 1]`, initialized at 0.50 for a new IUOC. Displayed to the owner as a coarse band (five named ranges), never as a three-decimal score. Other players see **nothing** by default; a player may consent to share a band with a group. There is no global ranking.

| Band (owner-only) | S range | Gates |
| --- | --- | --- |
| Turbulent | ≥ 0.72 | Psi budget near zero; NPMR visas denied |
| Restless | 0.58–0.72 | Psi: PastOwn only |
| Settled | 0.42–0.58 | Psi: PastOwn + FutureSelf; default new-player band |
| Coherent | 0.28–0.42 | Psi: PastShared, FutureIsland; Academy faculty verbs |
| Quiet | < 0.28 | Psi: RwwQuery; reincarnation planner offers rarer packets |

### Update rule

```rust
// Quality of consciousness. Coefficients are live-ops knobs, not morals.
const ETA_AID:    f32 = 0.040;
const ETA_HARM:   f32 = 0.060;
const ETA_EGO:    f32 = 0.030;
const ETA_COERCE: f32 = 0.080;
const SIGMA:      f32 = 0.010;          // noise
const CLAMP:      f32 = 0.150;          // per-event cap

fn apply_consequence(actor: IuocId, a: &ResolvedAction, w: &WorldView, led: &mut Ledger) {
    let aid   = consented_aid(a, w);           // [0,1]  help the target asked for
    let harm  = unconsented_harm(a, w);        // [0,1]  includes deception
    let ego   = self_dealing_index(a, actor);  // [0,1]  benefit captured vs given
    let coerc = coercion_index(a, w);          // [0,1]  threat, hostage, 'love farm'
    let perf  = audience_sensitivity(a, w);    // [0,1]  witnesses >> beneficiaries

    let raw = -ETA_AID * aid * (1.0 - perf)
            +  ETA_HARM * harm
            +  ETA_EGO  * ego
            +  ETA_COERCE * coerc;

    let noisy = (raw + gaussian(0.0, SIGMA)).clamp(-CLAMP, CLAMP);
    let delay = ticks_from_playtime(uniform(10 min, 6 h));
    led.enqueue(actor, noisy, delay, a.id);    // NOT applied this tick
}

// Flushed by a background worker, never by the 20 Hz loop.
fn flush_due(led: &mut Ledger, now: Tick) {
    for ev in led.due(now) {
        let s = led.s.get(ev.actor);
        led.s.set(ev.actor, (s + ev.delta).clamp(0.0, 1.0));
        // Owner gets a private, non-specific ping: "something settled."
        // They do not get the coefficient breakdown.
    }
}
```

### Feature detectors (what the formula consumes)

- **Consented aid.** Target has an open `ConsentStamp` for this verb class, or a standing pact. Healing a flagged ally in a dungeon is aid. Healing a stranger who did not ask, in a plaza, with a crowd, is mostly `perf`.
- **Unconsented harm.** HP, steal, lockout, or a proven lie (a statement the speaker's client sent as `Verb::Speak` that contradicts PastDB they had access to) against an IUOC-driven entity. Harm to AI Guys is **zero** on this axis (see §3) unless the AI Guy is a flagged ward.
- **Self-dealing.** Fraction of the action's material benefit that returns to the actor within a 10-minute window. Trade is not ego; a 'gift' that auto-returns is.
- **Coercion.** Combat-tag plus a `Speak` containing a demand, or a mechanic that blocks the target's unbind. Designed so hostage-taking cannot be 'content' without a ledger cost.
- **Audience sensitivity.** `log(1 + witnesses) / log(1 + beneficiaries)` squashed to [0,1]. Farming applause is low-quality consciousness. It is also the anti-pattern every karma system dies to.

### Anti-gaming design

| Attack | Mitigation |
| --- | --- |
| Love farming (heal each other in a closet) | Reciprocity window: repeating A↔B aid decays by 0.7 per cycle after 3; audience_sensitivity still applies; delay + noise hide the grind curve |
| Performative plaza charity | perf term; witnesses >> beneficiaries zeroes the aid credit |
| Hostage / 'be nice or else' | coercion_index saturates; aid under threat is not aid |
| Public virtue leaderboard pressure | There is no public board. Sharing a band is consent-gated and reversible |
| Reading the three-decimal score to min-max | Owner sees five bands only. The float never leaves the ledger process |
| Griefing AI Guys to 'be evil' for roleplay | AI Guy harm does not raise S. Roleplay evil against players does, as unconsented harm — which is the point. PvP instances set a consent flag at entry so agreed combat is not harm |
| Botting aid verbs | Rate limits + the same anti-cheat as movement; aid that requires no attention (AOE heal parked) has ego≈1 |
| Resetting by suicide / new avatar | S lives on the IUOC, not the avatar. Reincarnation cannot wash it |

### How S drives progression and world state

- **Gates, not levels.** Band opens psi scopes, NPMR visas, and reincarnation packet rarity. It does not open sword damage.
- **Collective weather.** A shard's median S (anonymized, 1-hour EMA) can tint PMR weather and NPC welcome tables. This is a *light* coupling so a toxic shard feels harsher without becoming a moral climate simulator. Designers can disable it per frame.
- **Profitability of the next packet.** Reincarnation offers (see §11) are ranked by a planner that estimates expected ΔS for this IUOC, not by gear score. The player still chooses.
- **No XP parallel.** If a designer adds a craft-skill number, it is a cosmetic or a PMR-only competence. It must not be required to 'win' the game, because the game's declared win is lowering S.

> **The system as teacher.** The LCS teaches by choice → consequence → feedback, not reward/punishment. The ping is delayed, the breakdown is hidden, the world still reacts immediately at the PMR layer (you stabbed someone; they are stabbed). The ledger is the slow teacher. Fast feedback is physics. Mixing them (a '+love' floater on every hug) is how you destroy the system. Forbidden.

---

## 9. NPMR Layers & the Reality Wide Web

Specify non-physical zones, psi as gated database access, intent-based interfaces, and RWW as the messaging / interconnect fabric.

> **Purpose.** NPMR is a set of frames with loose rulesets, not a second renderer. RWW is the bus. Psi is SQL with a quality gate, not a beam.

> **NPMR, RWW, intent, psi.** NPMR is a set of frames with looser rulesets, not a second renderer. RWW is the interconnect through which all IUOCs and all VRs communicate — any division is conceptual at AUM, operational as shards. Intent is the only player API. Psi is authorized reads of PastDB, FutureDB, and consented remote rows: database access, not a beam. A query that needs another shard's PastDB is a bus RPC (~1–5 ms in-cluster).

### NPMR zones

Ship two at M5, more later. Each is a frame with its own TBC process, clock, and ruleset id.

| Frame | Purpose | Admission | Notes |
| --- | --- | --- | --- |
| NPMR-Academy | Tutorial for intent, psi, and entropy literacy; social hub | any IUOC band ≤ Restless; visa check on S | No lethal PvP. Blink on. Δt = 200 ms |
| NPMR-Dream-* | Private or party instance, nested under Academy or PMR sleep | owner invite; one party | Clock dilated ×4. Props are CRDT. Collapse on last unbind |
| NPMR-Transit | The InTransit suitcase room (not a playable zone) | engine only | Exists so a crashed handoff has a place |

### Psi as database access

Psi is querying past and future-probability databases, not signal transmission. `Verb::PsiQuery` with a scope enum. The RenderOracle executes it. The FWAU pays `base_cost / max(ε, (1-S))` from its session psi budget (quality snapshot, so you cannot psi your way into a better budget mid-life). Over-budget queries fail closed with a generic error, not a leak.

| Scope | Store | Returns | Min band |
| --- | --- | --- | --- |
| PastOwn | PastDB ∩ this IUOC's packets | lossy episodic summaries, never raw ticks | Restless |
| PastShared | PastDB rows an owner consented to publish | same, plus a consent receipt | Coherent |
| FutureSelf | FutureDB branches of the requester's island that include their body | top-3 weighted outcomes as odds | Settled |
| FutureIsland | FutureDB of a named island the FWAU currently observes | distribution, no proper names of other IUOCs | Coherent |
| RwwQuery | presence LWW + published glyphs | what is already public on the bus | Quiet |

```ts
type PsiQuery = {
  fwau: FwauId;
  scope: "PastOwn" | "PastShared" | "FutureSelf" | "FutureIsland" | "RwwQuery";
  selector: { island?: IslandId; packet?: PacketId; since_tick?: Tick };
  max_bytes: number;                 // hard 4 KiB
};
type PsiResult =
  | { ok: true; odds?: Array<{ label: string; p: number }>; recall?: string }
  | { ok: false; reason: "budget" | "band" | "consent" | "not_found" };
```

### Intent as the interface

There is no second 'mind API'. Chat, movement, psi, consent, emote, trade all enter as Intent (see §3). The client may present a meditation UI, a spoken command, or a radial; the server sees a verb. This keeps anti-cheat and the ledger on one path.

### RWW fabric

RWW is the interconnect through which IUOCs and VRs communicate. We implement it as a clustered pub/sub with request/reply, not as a complete graph of sockets.

| Subject pattern | Payload | QoS |
| --- | --- | --- |
| `rww.bound.{frame}.{fwau}` | FwauBound / Unbound | durable, 1-day replay |
| `rww.aoi.{shard}.{cell}` | enter/leave interest | unreliable, droppable |
| `rww.intent.{shard}.{fwau}` | Intent envelopes from gateway | unreliable for Move, durable for verbs |
| `rww.psi.{iuoc}` | PsiQuery / PsiResult | request/reply, 50 ms timeout |
| `rww.ledger.{iuoc}` | private band-change pings | durable, owner-only ACL |
| `rww.glyph.{frame}` | OR-Set ops for NPMR props | durable, compacting |
| `rww.presence.{frame}` | LWW-register of IUOC presence | ephemeral |

**ACL.** A subscriber proves `(iuoc, fwau, frame)` with a short-lived capability token issued at bind. There is no 'subscribe to all IUOCs' client capability. GM tools use a separate signing key and an audit log.

**Why NATS JetStream (recommendation).** Subject hierarchy maps onto the patterns above; pull consumers let TBC shards pace themselves; exactly-once is *not* required on the unreliable subjects; the durable ones (bound, ledger, glyphs) need at-least-once plus idempotent handlers (every event carries a ULID). Alternatives: Redis Streams (operationally simpler, weaker multi-AZ), a custom QUIC stream multiplex (fewer moving parts, more code). Kafka is too heavy and too high-latency for `rww.aoi.*`.

> **Any division is conceptual.** The RWW makes partitions of consciousness conceptual: Academy and PMR are one system, at AUM_Core. TBC still shards, because that is how a social system of this size spends Δt. The engineering division is load-bearing. The lore division is not.

---

## 10. Networking & Server Topology for MMO Scale

Specify authoritative simulation, anti-cheat, sharding vs instancing, gateways, node hand-off, CRDTs for shared state, and consensus reality between avatars.

> **Purpose.** PMR is strongly consistent and server-authoritative. NPMR shared props are eventually consistent on purpose. Clients never commit.

> **Consensus reality.** Two avatars agree because they receive the same committed PresentDB for overlapping islands, not because they vote. That is consensus reality. CRDTs appear only where the ruleset opted into them (NPMR glyphs, presence) — dreams don't have to agree until you compare notes.

### Topology

**Process topology**

```
                    ┌──────────── AUM_Core ────────────┐
                    │  IUOCRegistry  EntropyLedger     │
                    │  ProbabilityStore (cold)         │
                    └──────────────┬───────────────────┘
                                   │ RWW (NATS)
          ┌──────────────┬─────────┴──────────┬──────────────┐
     Gateway-a      TBC PMR shard-00    TBC PMR shard-01   TBC NPMR-Academy
     (QUIC :443)    Δt=50ms  ~400 FWAU  Δt=50ms            Δt=200ms
          │              │                  │                  │
      clients         Scylla             Redis hot         CRDT props
      (UE5)           (IUOC, log)        (FWAU session)
```

| Node | CCU / entities | CPU (target) | RAM | Net egress |
| --- | --- | --- | --- | --- |
| Gateway | 2 000 sockets | 2 cores | 2 GiB | mostly inbound intents; 5–10 KB/s/client up |
| TBC PMR shard | 400 FWAU + 8 k AI Guy + 12 k total ents | 4 cores pinned (1 sim, 1 net, 2 island workers) | 4 GiB | 8–12 MB/s typical |
| TBC PvP instance | 16–64 FWAU, 60 Hz | 2 cores | 1 GiB | burst 64 KB/s/client |
| TBC NPMR | 200 FWAU | 2 cores | 2 GiB | small; query-heavy |
| AUM_Core | n/a (no sockets to public) | 2 cores | 4 GiB | cluster only |

*Per-node budgets (design / test)*

### Transport

- **QUIC (quinn)** to the gateway. One connection per client, multiple streams.
- **Unreliable datagrams:** Move, Look, cheap emotes. Loss is last-known.
- **Reliable streams:** Interact, Attack, Speak, PsiQuery, Consent, inventory. Idempotent verb ids.
- **MTU.** Intents ≤ 256 B payload so they fit a datagram without fragmentation. Replication packets packed to ~1200 B.
- **RTT budget.** Design/test at 100 ms; aim 50 ms regional. Two PMR ticks of interpolation buffer on the client (100 ms) hides a design-RTT.
- **Tick in the header.** Every datagram carries `T_client` and `T_last_ack`. Gateway stamps `T_recv` from the shard clock, not wall.

### Sharding, instancing, hand-off

PMR-Prime is a **seamless** spatial shard grid (1 km² cells as a starting geometry, not as a fiction). Adjacent shards run a 64 m overlap strip. An FWAU in the strip is *replicated* to the neighbor but *authored* by the home shard. Crossing the center line of the strip issues a handoff: suitcase (see §6) plus a QUIC connection migration to the neighbor's gateway pool if needed. Target: handoff hitch ≤ 1 tick (50 ms) in-region.

Instanced PvP is **not** seamless: a portal queues a 60 Hz TBC process, admits a party, destroys the process on empty. No CRDT, no sleep, full 64-player interest (everyone sees everyone).

### CRDT choice (NPMR only)

PMR does **not** use CRDTs. Strong consistency via the Δt total order is cheaper to reason about for combat and inventory, and anti-cheat depends on it.

| State | CRDT | Why this one | Why not |
| --- | --- | --- | --- |
| Shared glyphs / dream props | **OR-Set** (observed-remove set) | Add/remove without tombstone forever; two dreamers can both place and both take; concurrent add-wins then observed-remove is the diegetic 'we both remember the cup until we both forget it' | LWW-element-set loses concurrent adds; G-Set cannot remove; sequence CRDTs (RGA) are overkill for an unordered room |
| Presence (who is in this frame) | **LWW-register** per IUOC | A soul is in one place; last bind wins; clock is the AUM tick, not NTP | OR-Set would allow dual-presence bugs to look valid |
| Collective median S (weather) | **PN-counter** of band-bucket counts, sharded | Increments commute; we never need exact S, only a histogram | A single LWW float would flicker on partition |

*NPMR CRDTs*

Implementation recommendation: a small in-process CRDT (automerge is heavier than we need; implement OR-Set + LWW + PN-counter in ~300 lines, persist ops on `rww.glyph.*`). Do not run a general-purpose CRDT database on the 20 Hz path.

### Anti-cheat

- Server-authoritative movement: client sends wish; server integrates with PMR motion envelope. Speed hacks fail closed.
- Intent rate limits (64 deep, 20 Hz move). Injection of extra verbs is a drop, not a queue.
- Psi is a server query. There is no client-side FutureDB to read with a memory editor.
- Sleeping regions are cheat-sampled at 1% / s. A speed-hacked AI Guy farm in an unobserved cave still gets caught; more importantly, it doesn't earn S (AI Guys).
- Checksums of awake islands every 100 ms, compared to a hot-spare on a second box for high-value instances.
- No trust of `ConsentStamp` without server-side record of the consent verb.

### Consensus reality

Two avatars in the same island, same tick, same PresentDB, see the same committed facts. Their *clients* may interpolate differently for a frame; corrections land within the rewind window. If a psi FutureSelf query returns different odds to two players, that is correct: their intent fields differ, so their beams differ. Present is shared. Future is not.

---

## 11. Persistence, Reincarnation & Multi-Avatar Identity

Specify persistence layers, how one IUOC record spans many avatar instances, death as avatar reset not identity loss, and carryover of entropy/quality across lives.

> **Purpose.** Death deletes an ECS entity. It does not delete a person. The IUOC row, the ledger, and the packet archive are the persistence story; avatars are rental bodies.

> **Reincarnation.** One IUOC instantiates many avatars over time and chooses the next most profitable packet for its evolution. Character-select is a planner over experience-packet templates, ranked by predicted ΔS, with the player making the final bind. Offers are odds, not destiny. The soul still chooses.

### Persistence layers

| Layer | Store | RPO / RTO | Contents |
| --- | --- | --- | --- |
| Soul | ScyllaDB `iuoc` | sync write; RPO 0 / RTO seconds | id, quality S, incarnation_count, consent graph, prefs |
| Ledger | ScyllaDB `ledger_events` + in-memory pending | sync on flush; pending replicated to Redis | delayed ΔS events, applied S |
| Packets | ScyllaDB `packets` + object store for bulky recall | async, 1 s | experience packet summaries, death cause, notable choices |
| Hot session | Redis `fwau:{id}` TTL 72 h | AOF 1 s | bound avatar, intent seq, psi budget, quality snapshot |
| World hot | shard snapshot ring + event log | 400 ms | ECS present, islands |
| World cold | Scylla `cells` + S3-compatible blobs | 5 min rollup | sleep snapshots, terrain, instance templates |

IUOC and ledger writes are **not** allowed to ride the 20 Hz fire-and-forget path. Bind, unbind, and flush_due go through a sync writer with a 50 ms timeout; failure fails the bind, it does not silently play. World cells can lag; souls cannot.

### Death = unbind, not identity loss

1. TBC flags `Avatar.dead = true`, stops replication of pose, plays the death present to observers (one tick of existence after death is allowed so the body is seen).
2. Gateway closes the intent channel. Residual Move datagrams drop.
3. `merge()` (§3) writes the packet, applies any **already-due** ledger events, does **not** flush the delayed queue early (suicide cannot speed the teacher).
4. Avatar entity is recycled after `corpse_ttl` (PMR: 60 s; PvP instance: 5 s; NPMR: 0).
5. Client is shown the between-lives UI: band (coarse), packet summary, reincarnation offers. This UI is a **logged-out FWAU** — no PMR verbs, psi PastOwn only, so you can remember the life you just finished.

### What carries, what does not

| Carries across lives | Does not carry (default) |
| --- | --- |
| IUOC id, S, band, incarnation_count | HP, stamina, PMR inventory, gold |
| Consent graph (pacts you signed as a soul) | This life's episodic memory as working memory |
| Cosmetic unlocks marked `soulbound_cosmetic` | Map fog, quest flags unless tagged `soul_arc` |
| Psi skill *ceiling* (a function of band) | Psi skill *practice* — the new FWAU starts clumsy |
| Packet archive (queryable via PastOwn) | Hot session, intent seq, the previous FWAU id |

### Reincarnation planner

On unbind, AUM_Core asks a planner for K=5 offers. Each offer is an `ExperiencePacketSpec`: start shard, body template, starting situation (poverty, obligation, talent, faction), a predicted ΔS distribution over a 10-hour play window, and a one-paragraph fiction. The prediction is a lookup over anonymized historical packets with similar (start, band), **not** a neural net of the player's psyche. Cold start: uniform over a hand-authored starter set.

```ts
function rankOffers(soul: IUOC, pool: PacketTemplate[]): Offer[] {
  const hist = packets.similar({ band: bandOf(soul.S), n: 200 });
  return pool
    .map((t) => {
      const dist = empiricalDeltaS(hist, t);          // histogram, not a point
      const expected = mean(dist);
      const stretch = Math.abs(expected);             // prefer packets that move S
      const novelty = 1 - soul.seenTemplates.has(t.id);
      const score = 0.5 * (-expected) + 0.3 * stretch + 0.2 * novelty;
      // -expected: profitable = likely to lower S
      return { t, dist, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}
// Player may still pick offer #5. The planner suggests; it does not bind.
```

Alts: one IUOC may have at most one **bound** FWAU, but may park up to 3 open packets (unbound living avatars) if the ruleset allows parking. PMR-Prime allows 1 parked + 1 bound. A soul is not a roster of mains. A second platform account is a different IUOC (see §13 on multi-accounting).

### Minimal soul schema

```sql
CREATE TABLE iuoc (
  id            uuid PRIMARY KEY,
  quality_s     float,
  incarnations  int,
  bound_fwau    uuid,
  prefs         blob,          -- reincarnation prefs, UI
  created_at    timestamp
);
CREATE TABLE packets (
  iuoc          uuid,
  packet_id     timeuuid,
  avatar_id     uuid,
  frame         text,
  summary       blob,
  death_cause   text,
  PRIMARY KEY (iuoc, packet_id)
) WITH CLUSTERING ORDER BY (packet_id DESC);
CREATE TABLE ledger_events (
  iuoc          uuid,
  due_tick      bigint,
  event_id      uuid,
  delta         float,
  action_id     uuid,
  applied       boolean,
  PRIMARY KEY (iuoc, due_tick, event_id)
);
```

---

## 12. Data Structures & Interfaces

Give implementation-facing structs, traits, and complexity notes for the named primitives: IUOC, FWAU, AUM_Core, DeltaTClock, Ruleset, ProbabilitySurface, EntropyLedger, RWWBus, RenderOracle, ExperiencePacket.

> **Purpose.** Names below are the engine's first-class types. Production language is Rust; signatures are Rust-shaped pseudocode a TypeScript or C++ port can follow. Complexity is for the common path.

### Identifiers

```rust
struct IuocId(u128);
struct FwauId(u128);
struct AvatarId(u64);          // ECS generational, recycled per frame
struct FrameId(u32);
struct IslandId(u64);
struct PacketId(u128);
struct Tick(u64);              // per-frame, starts at 0
struct Entity(u32, u32);       // index, generation
```

### IUOC, FWAU, ExperiencePacket

```rust
struct IUOC {
    id: IuocId,
    quality: QualityScalar,            // S ∈ [0,1], lower better
    incarnations: u32,
    bound_fwau: Option<FwauId>,
    vault: MemoryVaultId,              // no FWAU credentials
    consent: ConsentGraph,             // sparse, soul-scoped
    prefs: ReincarnationPrefs,
}
// Registry: O(1) by id (hash). Bind/unbind: O(1) + one sync write.

struct FWAU {
    id: FwauId,
    iuoc_id: IuocId,
    avatar_id: Entity,
    session: SessionId,
    quality_snapshot: QualityScalar,   // copy at bind
    intent_buf: IntentQueue,           // cap 64, O(1) push/pop
    psi_budget: f32,
    bound_at: Tick,
    memory_clearance: MemoryClearance, // IncarnationOnly | PastOwn | …
}

struct ExperiencePacket {
    id: PacketId,
    iuoc: IuocId,
    avatar: AvatarId,
    frame: FrameId,
    bound_at: Tick,
    unbound_at: Tick,
    summary: PacketSummary,            // notable_choices ≤ 32
    death_cause: DeathCause,
}
// Insert O(1). List last k lives: O(k) clustering on (iuoc, packet_id DESC).
```

### AUM_Core, DeltaTClock, Ruleset

```rust
struct AumCore {
    cells: RealityCellStore,
    iuoc: IuocRegistry,
    ledger: EntropyLedger,
    prob: ProbabilityStore,
    tbc: TbcSupervisor,
    bus: RwwBus,
    keys: SigningKeys,
}

struct DeltaTClock {
    dt: Duration,
    tick: Tick,
    acc: Duration,
    max_catchup: u32,                  // 4
}
impl DeltaTClock {
    fn drain(&mut self, elapsed: Duration) -> u32;   // returns steps, O(1)
}

struct Ruleset {
    id: RulesetId,
    tightness: f32,                    // 0 = loose, 1 = tight
    dt_ms: u16,
    motion: MotionEnvelope,
    conservation: Conservation,
    death: DeathPolicy,
    psi: PsiPolicy,
    crdt: Option<CrdtPolicy>,
    handoff: HandoffPolicy,
}
// Load: O(size) once per frame boot. Hot path reads are by-value copies of envelopes.
```

### ProbabilitySurface, EntropyLedger, RenderOracle, RWWBus

```rust
struct Branch { state: IslandSnapshot, weight: f32, path: SmallVec<Action> }

struct ProbabilitySurface {
    island: IslandId,
    beam: ArrayVec<Branch, 16>,        // B=16, packed
    depth: u8,
    rng: Pcg64,
}
impl ProbabilitySurface {
    fn advance(&mut self, Φ: &IntentField) -> ();
        // O(D·B·A·C_step + D·B·A·log B)  — see §7
    fn observe(&mut self) -> IslandSnapshot;
        // Walker alias O(B) preprocess + O(1) draw
}

struct EntropyLedger {
    s: HashMap<IuocId, QualityScalar>,
    pending: BTreeMap<(Tick, EventId), PendingDelta>,
}
impl EntropyLedger {
    fn enqueue(&mut self, a: IuocId, d: f32, due: Tick, src: ActionId);
        // O(log P), P = pending events (~hours of play, small)
    fn flush_due(&mut self, now: Tick) -> Vec<IuocId>;
        // O(k + log P) for k due
}

struct RenderOracle {
    grid: HierGrid,                    // §4
    awake: BitSet,
}
impl RenderOracle {
    fn interest(&self, f: FwauId) -> &[Entity];     // O(k)
    fn on_move(&mut self, e: Entity, old: Vec3, new: Vec3);
    fn replicate(&self, f: FwauId) -> Bytes;         // dirty fields only
}

struct RwwBus { inner: nats::Client }
impl RwwBus {
    fn publish(&self, subj: &str, bytes: &[u8]) -> Result<()>;     // O(bytes)
    fn request(&self, subj: &str, bytes: &[u8], t: Duration)
        -> Result<Bytes>;
}
```

### ECS substrate (avatars, AI Guys, reality cells)

Avatars, AI Guys, and reality cells live in one ECS. Recommendation: a generational archetype ECS (hecs / flecs / a custom packed one). Components of note:

| Component | On | Notes |
| --- | --- | --- |
| `Transform`, `Velocity` | all embodied | PMR integrates; NPMR may set |
| `FwauBinding` | avatars of logged-in IUOCs | absent ⇒ AI Guy |
| `Brain` | AI Guys | Utility / BT / ML; never on FWAU bodies |
| `InterestLod` | replicated | 0/1/2 |
| `Sleep` | anything | snapshot + seed + slept_at tick |
| `IslandMember` | awake interactive | island id, dirty flag |
| `Suitcase` | in-transit | ruleset-neutral blob |
| `Ward` | protected AI Guys | harm counts on the ledger |

Step order per tick, fixed: (1) intents in, (2) movement, (3) islands rebuild, (4) surface.advance, (5) observe/collapse, (6) verbs, (7) ledger enqueue, (8) sleep/wake, (9) replicate, (10) snapshot if due. Changing this order is a protocol break.

### Complexity cheat-sheet

| Operation | Average | Worst we accept |
| --- | --- | --- |
| Grid insert / cell-local move | O(1) | O(1) |
| Grid cell-cross + interest dirty | O(|subs|≈4–16) | O(FWAU in 2 neighborhoods) |
| AoI query | O(k in 9–27 cells) | O(ents in 512 m) at L2, rare |
| Beam prune / island / tick | O(D·B·A·C_step) ≈ 768 steps | cap islands at 128; shed lookahead to D=4 under stall |
| Rewind k ticks | O(k · awake) | k≤8, awake≤2 000 in a fair; shed AI if over |
| Ledger enqueue / flush k | O(log P) / O(k+log P) | P is delayed events, not CCU |
| Psi PastOwn | O(log packets + result scan) | 4 KiB cap |
| OR-Set add/remove | O(1) amortized + gossip | compact every 30 s |

---

## 13. Ethical & Design Guardrails

Because progression rewards cooperation / 'love', specify how the system avoids moralizing, coercion, exploitation, and grief-as-a-virtue-test, while keeping player agency and consent load-bearing.

> **Purpose.** A scoring system that claims to measure love is a weapon if it is public, real-time, or required for basic play. This section is a hard product spec, not a sermon.

### Harms we are designing against

| Failure mode | What it looks like | Guardrail |
| --- | --- | --- |
| Moralizing UI | 'You are a worse person' toast, red nameplates, public S | Five private bands, delayed pings, no nameplate encoding of S, copy reviewed as *systems* copy not *moral* copy |
| Coercive social pressure | Guilds requiring a Quiet band; 'prove you are love' | Sharing a band is opt-in, revocable, not queryable by guild APIs. Guild gates may use *playtime* and *consent pacts*, not S |
| Exploitation of the metric | Pay-to-win 'meditation crystals' that lower S | S is not for sale. Cosmetics are. Any item that writes the ledger is a bug |
| Grief-play as a purity test | Designers stacking unconsented harm so 'good' players can be seen refusing it | PvP is consent-flagged at instance entry. Open-world harm is possible (it's a world) but not *content-gated* on being a victim |
| Become-love as a choke | Main quest requires Coherent | The main PMR loop is playable at Settled forever. Bands gate *psi and visas*, optional depth, not the door |
| Real-world moral laundering | Marketing: 'our players are better people' | Forbidden. S is not for sale. The loading screen may say the LCS measures quality of consciousness. It may not say the player is a worse person. |

### Consent is a verb

`Verb::Consent` is first-class: `{ target, scope, expires_tick, revocable }`. Combat instances stamp a blanket `scope: AgreedCombat` at entry and revoke on leave. Trades, psi PastShared, band-sharing, and party heals in the plaza require a stamp. A missing stamp makes `consented_aid = 0` and `unconsented_harm` possibly > 0. There is no 'implied consent because we're grouped' outside instances that said so in their ruleset.

- Consent UI is boring, explicit, and interruptible. Not hidden in a 40-page EULA.
- Expiry is required. Standing pacts (soul-level) are a separate, slower UI with a 24 h cooling-off to create, 0 to revoke.
- A player in distress (combat tag, chat mute, reported) cannot be offered new soul-level pacts. Anti-grooming, not anti-friendship.

### Agency

The planner suggests packets; the player binds. The ledger scores; the player still stabs. We do not soft-lock 'evil' avatars out of PMR. We do not play a therapist. If a player wants a high-S life of chaos, the systems remain consistent: psi dries up, visas fail, the world still runs. That is a valid experience packet. The design sin is not allowing darkness; it is **selling darkness as a way to game a virtue metric**, or **selling virtue as a way to police other players**.

### Grief, harassment, multi-accounting

- **Harassment** is a trust-and-safety channel, not an entropy event. A slur does not wait six hours for a noisy float. It is actioned on the session (mute, kick, ban) by a human-policy stack. The ledger may *also* see unconsented harm if the ruleset classifies it so, but T&S does not wait on §8.
- **Multi-accounting** to launder S: we do not promise to de-anonymize. We rate-limit visas per device/payment hint where legal, and we accept that a determined person can own two IUOCs. The game must still be fun if they do. Do not build a police-state around the soul.
- **Streaming / audience.** The `perf` term already taxes plaza performance. Streamer mode is an explicit client flag that *increases* `audience_sensitivity` by treating the public internet as witnesses. Opt-in, default on if a known ingest is present, overridable.

### Copy rules (bind designers and writers)

1. Never say 'you gained love'. Say 'something settled' or show the band shift.
2. Never show another player's S or band without their live consent.
3. Never put a moral in the loading screen. The LCS teaches by consequence, not sermon.
4. Always show AI Guys as AI Guys when the player is about to be scored (they won't be). Deception about ontology is a design bug.
5. Psi results are 'odds', 'impressions', 'a possible shape'. Never 'the future is'.

> **If we ship a public love leaderboard.** We have failed this spec. Delete it. The rest of the engine can stay.

---

## 14. Implementation Roadmap

Milestones M0–M9, a recommended concrete stack, team sizing, and what to prototype first.

> **Purpose.** Build the teacher-loop and the tick before the world, the world before the bus, the bus before the shards. Do not start with a UE5 open world.

### Recommended stack

| Layer | Choice | Why | Reject |
| --- | --- | --- | --- |
| Sim core (TBC, ECS, Δt, surfaces) | Rust | No GC in the tick; easy determinism story; one binary per shard | C# (GC), Python (speed), Go (GC + worse ECS story) |
| Net | QUIC via quinn; gateways in Rust | Streams + datagrams, TLS 1.3, connection migration for handoff | Raw UDP (you will reinvent QUIC); TCP-only (head-of-line on Move) |
| RWW | NATS JetStream | Subject hierarchy, pull consumers, ops-simple | Kafka (latency), custom (unless NATS hurts) |
| Hot session | Redis / KeyDB | TTL FWAU, cheap | Scylla for 72 h sessions |
| Soul / ledger / packets / cells | ScyllaDB | ULID clustering, wide rows, multi-AZ | Postgres as the only store (it will become the bottleneck); DynamoDB (ops + cost at this access pattern) |
| Client (reference) | Unreal Engine 5 dedicated-server + World Partition | Interest/LOD already rhyme with §4; hiring | Writing a AAA renderer. A wgpu debug client is fine for M1–M4 |
| Rulesets | JSON/RON + JSON Schema | Diffable, data-driven | Hardcoded C++ switches |
| NPMR verbs | WASM guests, 0.3 ms cap | Mods without forking TBC | Lua on the PMR 20 Hz path |
| Obs | OpenTelemetry + Grafana | Tick histograms, stall, rewind rate, psi latency | Log-only debugging |

### Milestones

| M | Name | Done when | Team |
| --- | --- | --- | --- |
| M0 | This spec | Signed by eng + design. Numbers adjustable, names frozen | authors |
| M1 | Tick + ledger | Single process: Δt loop, 2 keyboard FWAUs, EntropyLedger with delay, unit tests for the formula and the accumulator | 2 sim |
| M2 | Soul bind | IUOC persist (local Scylla or even sqlite for M2), bind/unbind/death merge, parked avatar, tests for vault isolation | 2 sim + 1 persist |
| M3 | Observe | Hierarchical grid, sleep/wake, dirty-field replication to a debug client, 50 dummy AI Guys | 2 sim + 1 client |
| M4 | Netcode | QUIC gateway, rewind-replay, 8-player instance on a LAN, 100 ms RTT emulator, cheat: speed hack fails | 2 net + 1 client |
| M5 | NPMR + RWW | Academy frame, clock dilation, blink, NATS, PsiQuery PastOwn/FutureSelf returning real beam odds | 2 sim + 1 net |
| M6 | Surfaces | Island beam on AI Guys, observe-collapse, FutureIsland queries, profiler showing < 1 core at 40 islands | 1 sim + 1 AI |
| M7 | World | Seamless 2-shard PMR, reincarnation planner with 5 offers, UE5 reference travel between shards | 2 client + 1 persist + 1 sim |
| M8 | Guardrails | Consent verbs, T&S hooks, no public S (audit), streamer flag, load test 2 k CCU on 5 shards | 1 T&S-eng + 1 net + 1 QA |
| M9 | Scale | 400 FWAU/shard target, autosplit on stall, chaos (kill a shard, suitcases recover), economic review of S coefficients | full |

### What to prototype first (this week, not this year)

1. A headless Rust crate: `delta_t`, `ledger`, `grid`, `beam`, with tests that **print the numbers in this spec** (768 steps/island, O(1) cell move, delayed ΔS).
2. A two-box LAN: one TBC, one debug wgpu or even a terminal client, 100 ms netem, rewind visible as a pose snap.
3. A paper prototype of the between-lives UI and the five bands, with writers in the room, **before** any UE5 map.
4. A red-team day on §8: three designers try to farm S. If they can, change coefficients or detectors before M3 art.

### Team sizing (vertical slice through M7)

- 2 simulation / ECS / surfaces
- 2 net / gateway / anti-cheat
- 1 persistence / Scylla / Redis
- 2 client (UE5)
- 1 systems designer who owns rulesets **and** the ledger coefficients (one person, so they cannot disagree in Jira)
- 1 producer
- 1 QA (netem, stalls, bind/unbind fuzz)
- Part-time: T&S policy, writer (copy rules in §13)
- **≈ 10–12 FTE.** A 3-person team can reach M4 honestly and should not promise M7.

### Runtime cost sketch (M9, one region)

2 000 CCU ⇒ ~5 PMR shards + 1 Academy + gateways + AUM_Core + NATS + Scylla 3-node + Redis. Roughly 20–30 commodity 16-core boxes, not a hyperscale fleet. Bandwidth is the bill to watch (replication), not the beam math. If CCU is 20 k, shard first, don't deepen D.

---

## 15. Open Problems & Known Risks

Name where TBC will fail at scale, where the product can betray its own lore, and which numbers are allowed to move.

> **Purpose.** The lore is settled. The remaining holes are engineering, live-ops, and design. A spec that cannot list them will be quoted as if it had none.

### Hard lore that still has to tick

These are not caveats. They are the parts of canon that TBC must actually compute, every Δt, without breaking the fiction or the box.

| Canon | How TBC holds it | Failure if we slip |
| --- | --- | --- |
| Consciousness is the only fundamental | AUM_Core is the single authority. Everything else is a partition. See §2. | A peer client that can commit a present. |
| Free will | Intent envelopes in a tick window. What arrived is what the FWAU willed. See §3. | A hidden will-channel, or a client that banks intents. |
| Psi is database access, not signal | Gated RPC against PastDB / FutureDB over the RWW. See §7, §9. | A projectile 'psi bolt', or a client-side FutureDB a memory editor can read. |
| Render-on-observation | Sleep + kinematic wake + 1% cheat sample. See §4. | Stepping the whole planet, or letting an arriving FWAU walk through a ghost tree. |
| Entropy is the purpose of the system | Private QualityScalar, delayed and noisy, with anti-gaming. See §8, §13. | A public virtue board, or S for sale. |
| One IUOC, many lives | Durable soul row + packet archive. Death unbinds. See §11. | Wiping S on a new avatar. A roster of mains posing as one soul. |
| AUM is a social system of consciousness | AUM_Core + RWW + every bound FWAU. See §2, §9. | Frames that cannot address each other. Dual-presence bugs. |

### Scaling risks

- **Beam cost cliffs.** A 128-entity brawl is one island. D=8, B=16, A=6 will not fit if `C_step` includes the whole brawl per branch. Mitigation: island split by clique (combat pairs), drop D to 4 under stall, never run the beam during rewind (§7).
- **Interest storms.** A festival of 400 FWAUs in one 128 m cell is the AoI worst case. Mitigation: instance the festival; or degrade L0 radius to 16 m; or switch that cell to the PvP 'everyone sees everyone' packer with a hard cap.
- **Handoff hitch.** Seamless shards fail at the strip if the suitcase is large (player housing). Mitigation: housing is a nested instance, not a suitcase.
- **Ledger delay as exploit.** Players may learn the 10 min–6 h window and sequence harm/aid. Mitigation: the window is per-event jittered, not a global clock; detectors look at windows of *playtime*, not wall.
- **Scylla as a soul SPOF.** Bind cannot proceed if the soul write fails. Mitigation: multi-AZ, and a read-only 'spectate last packet' mode rather than a split-brain bind.
- **WASM in NPMR.** A guest that jitters 0.3 ms every tick still jitter-taxes the frame. Mitigation: isolate guests on the second core; cancel hot guests.
- **Coefficient live-ops.** Changing ETA_HARM mid-era rewrites what past delayed events 'should have been'. Policy: never retroactively recompute; ship new coefficients with a new `ledger_epoch`.

### Product risks

- Players who wanted a loot treadmill will call a private entropy band 'nothing happening.' The PMR loop must be satisfying **without** S. S is the long game.
- Psi as odds is less cinematic than prophecy. Keep it. Cinematic prophecy breaks fairness and collapses the future-probability surface into a spoiler.
- A scoring system that measures love is a weapon if it is public, real-time, or required for basic play. §13 is load-bearing.
- Copy that moralizes ('you are a worse person') turns the LCS into a hall monitor. Copy that mystifies the numbers ('the universe has judged you') does the same. Systems-plain: 'something settled.'

### Close

> **This is the LCS.** Names are canon. IUOC, FWAU, AUM, TBC, Δt, RWW, and the EntropyLedger are how this universe runs. Where a rule would harm players (public virtue scores, coerced 'love'), we refuse the rule — not the lore. Numbers are Δt budgets: change them with a measured stall, a measured KB/s, or a red-team of §8. Change names only if you are willing to orphan this document.
