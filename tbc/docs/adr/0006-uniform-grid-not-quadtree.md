# ADR 0006 — A three-level uniform grid, not a quadtree

**Status:** accepted (M0)

## Context

Interest management is the largest recurring cost in the loop after the beam, and it runs
at 20 Hz against ~12 000 entities per shard.

## Decision

Three uniform levels — 32 m, 128 m, 512 m — in one hash map. Insert and remove are O(1)
expected; a move that stays inside its cell touches nothing and publishes nothing; a
crossing costs one remove, one insert, and the symmetric difference of the two subscriber
sets (empirically 4–16). No periodic rebuild.

Quadtrees are reserved for sparse NPMR volumes, where the density assumption that makes a
uniform grid win does not hold.

## Consequences

Measured in `spec_numbers::grid_cell_move_is_o1`: 1 000 cell-local moves cost 0 cell
operations and one crossing costs exactly 2, unchanged from 1 000 to 100 000 entities.
Emptied cells are dropped so a vacated region costs no memory either.
