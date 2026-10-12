// HUNT, FLEE, and SPLIT_ATTACK steer helpers. Pure functions over
// a WorldView plus the threat/prey lists computed by threats.ts.

import type { WorldView } from './world.js';
import type { Threat, Prey } from './threats.js';
import { biggestOwnCell } from './threats.js';
import { dist, magnitude, scaleTo, sub, type Vec2 } from './geometry.js';

/** Steer projection magnitude, same scale as feed.ts so FLEE and
 *  HUNT don't appear slower than FEED to the server. */
const STEER_PROJECTION = 400;
/** Below this distance to our biggest cell, we assume the kill is
 *  as good as landed. Steer continues to apply pressure but SPLIT
 *  gates downgrade: no point splitting on top of prey. */
const SPLIT_MIN_DIST = 60;
/** Above this distance a split can't catch prey: the halves slow
 *  down after the burst and the prey has time to react. */
const SPLIT_MAX_DIST = 250;

/** Steer vector toward the closest prey. Caller guarantees the
 *  list is non-empty. */
export function steerForHunt(world: WorldView, prey: Prey): Vec2 {
    const my = biggestOwnCell(world);
    if (!my) return { x: 0, y: 0 };
    return scaleTo(sub(prey.biggestCell, my), STEER_PROJECTION);
}

/** Decide whether a split would plausibly land the kill. Mass
 *  requirement: each half must still outweigh the prey by the
 *  eat ratio; distance band: close enough to catch, far enough
 *  that the split burst actually buys us ground. */
export function splitWouldLand(
    world: WorldView,
    prey: Prey,
    eatRatioFromRules: number,
    splitLimit: number
): boolean {
    const my = biggestOwnCell(world);
    if (!my) return false;
    if (prey.distance < SPLIT_MIN_DIST || prey.distance > SPLIT_MAX_DIST) return false;
    if (world.self.cells.length >= splitLimit) return false;
    const halfMass = my.mass / 2;
    return halfMass > prey.biggestCell.mass * eatRatioFromRules;
}

/** Compute a flee heading. Blends two strategies by `blend`
 *  (cowardice): 0.0 = straight away from the single closest
 *  threat; 1.0 = sum of inverse-distance repulsion vectors from
 *  every larger threat in sight. */
export function steerForFlee(world: WorldView, threats: Threat[], blend: number): Vec2 {
    const my = biggestOwnCell(world);
    if (!my || threats.length === 0) return { x: 0, y: 0 };
    const nearest = threats[0];
    const awayFromNearest: Vec2 = sub(my, nearest.biggestCell);

    // Weighted sum: inverse-distance weighting, so near threats
    // dominate but a wall of distant enemies also tilts the vector.
    const sum: Vec2 = { x: 0, y: 0 };
    for (const t of threats) {
        const d = Math.max(1, t.distance);
        const w = 1 / d;
        sum.x += (my.x - t.biggestCell.x) * w;
        sum.y += (my.y - t.biggestCell.y) * w;
    }

    // Normalise both before blending so the mix is heading-only,
    // not magnitude-weighted (otherwise a far crowd outweighs the
    // single scary neighbour).
    const n1 = scaleTo(awayFromNearest, 1);
    const n2 = scaleTo(sum, 1);
    const blended: Vec2 = {
        x: n1.x * (1 - blend) + n2.x * blend,
        y: n1.y * (1 - blend) + n2.y * blend
    };
    return scaleTo(blended, STEER_PROJECTION);
}

/** True when the biggest own cell is within `margin` of a map
 *  edge. Used by FLEE to decide the bot is cornered and an escape
 *  split is worth attempting. */
export function isCornered(world: WorldView, margin = 150): boolean {
    const my = biggestOwnCell(world);
    if (!my) return false;
    const { width, height } = world.worldSize;
    return my.x < margin || my.x > width - margin || my.y < margin || my.y > height - margin;
}

/** How confident we are a split lands on this prey. 1.0 when the
 *  halves comfortably outweigh the prey; drops toward 0 as parity
 *  approaches. Multiplier on splitWillingness per PLAN section 6. */
export function splitConfidence(
    world: WorldView,
    prey: Prey,
    eatRatioFromRules: number
): number {
    const my = biggestOwnCell(world);
    if (!my) return 0;
    const halfMass = my.mass / 2;
    const needed = prey.biggestCell.mass * eatRatioFromRules;
    if (halfMass <= needed) return 0;
    // Confidence 1.0 at 2x the needed mass, scales linearly below.
    const slack = (halfMass - needed) / needed;
    return Math.min(1, slack);
}

/** Non-null if we should still react to a nearby threat even when
 *  we are bigger overall (non-cowardice branch). Returns the
 *  nearest threat inside `fleeRadius`, else null. */
export function nearbyThreatOutsideCowardice(
    world: WorldView,
    threats: Threat[],
    fleeRadius: number
): Threat | null {
    if (threats.length === 0) return null;
    return threats[0].distance <= fleeRadius ? threats[0] : null;
}

/** Unused in the current ladder but kept for readability of future
 *  distance checks. Export so other decision files can share one
 *  definition rather than ad-hoc inline distance math. */
export function distanceToAnchor(world: WorldView, pt: { x: number; y: number }): number {
    return dist({ x: world.self.x, y: world.self.y }, pt);
}

/** Guardrail so a decision helper never emits a nonsense direction
 *  on exactly colocated inputs. Falls back to a small random nudge. */
export function nonZeroVector(v: Vec2): Vec2 {
    if (magnitude(v) > 1e-6) return v;
    const a = Math.random() * Math.PI * 2;
    return { x: Math.cos(a) * STEER_PROJECTION, y: Math.sin(a) * STEER_PROJECTION };
}
