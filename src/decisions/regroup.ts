// REGROUP: convergence steer for a scattered swarm.
//
// After a split (our own SPLIT_ATTACK, a bump into a virus, or a
// chomp that didn't quite finish a cell off) the player can end
// up with outlier cells far from the biggest cell. The server's
// per-cell movement math is
//
//   per-cell target = (player.centroid - cell.position) + steer_offset
//
// so sending a steer_offset of (0, 0) tells every cell to head
// toward the player centroid: the big cell drifts "backward"
// toward it, outliers move "forward" toward it, and the swarm
// collapses onto its own middle until the merge timer lets them
// fuse.
//
// Why this exists as its own state (rather than, say, biasing
// WANDER): FEED and WANDER steer toward specific world points,
// and when the swarm is scattered the big cell and an outlier
// end up pulling in opposite directions through the centroid,
// producing a visible oscillator when food lands between them.
// REGROUP sidesteps the pathology by committing the whole swarm
// to its own middle instead of asking it to pick a side.

import type { WorldView, WorldCell } from './world.js';
import { biggestOwnCell } from './threats.js';
import { dist, type Vec2 } from './geometry.js';

/** Minimum biggest-cell-to-centroid distance that counts as
 *  "scattered enough to prioritise regrouping". The merge timer
 *  governs when cells can physically fuse; this threshold is a
 *  behavioural one, roughly "the big cell has a lot of catching
 *  up to do before the halves can start merging." */
const REGROUP_ENTRY_DIST = 150;
/** Hysteresis: once in REGROUP we stay there until the swarm
 *  tightens below this. Without the gap we'd flap at the entry
 *  boundary every time the big cell drifts past 150 units for a
 *  tick. */
const REGROUP_EXIT_DIST = 60;

/** Mass-weighted centroid of the swarm. The server's self.x/self.y
 *  is already a centroid, but computing locally from the cells
 *  keeps REGROUP's math independent of what the server chose to
 *  send (plain-mean vs mass-weighted etc.) and matches what the
 *  server's cell.move() uses as the convergence point. */
export function swarmCentroid(cells: WorldCell[]): { x: number; y: number } | null {
    if (cells.length === 0) return null;
    let sumX = 0;
    let sumY = 0;
    let sumM = 0;
    for (const c of cells) {
        sumX += c.x * c.mass;
        sumY += c.y * c.mass;
        sumM += c.mass;
    }
    if (sumM === 0) return null;
    return { x: sumX / sumM, y: sumY / sumM };
}

/** Distance from the biggest cell to the swarm centroid, which
 *  we use as the "how scattered are we?" scalar. Returns 0 when
 *  the player has only one cell. */
export function swarmSpread(world: WorldView): number {
    if (world.self.cells.length < 2) return 0;
    const big = biggestOwnCell(world);
    const centroid = swarmCentroid(world.self.cells);
    if (!big || !centroid) return 0;
    return dist(big, centroid);
}

/** Entry predicate, honouring hysteresis: if we're already in
 *  REGROUP, require the spread to drop below REGROUP_EXIT_DIST
 *  before leaving; otherwise require it to exceed
 *  REGROUP_ENTRY_DIST to join. */
export function shouldRegroup(world: WorldView, currentlyRegrouping: boolean): boolean {
    const spread = swarmSpread(world);
    if (currentlyRegrouping) return spread > REGROUP_EXIT_DIST;
    return spread > REGROUP_ENTRY_DIST;
}

/** Zero steer offset. Through the server's cell.move() math this
 *  resolves to a per-cell target of (centroid - cell.position),
 *  so every cell heads toward the centroid. Exported as a function
 *  for symmetry with the other steerFor* helpers and in case we
 *  later want a small bias (e.g. slight nudge toward the big cell
 *  rather than the plain centroid). */
export function steerForRegroup(_world: WorldView): Vec2 {
    return { x: 0, y: 0 };
}
