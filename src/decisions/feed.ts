// FEED and WANDER decision helpers. Pure functions: input is the
// projected WorldView plus a bit of local scratch state, output
// is a steer offset the Bot shoves at Connection.sendSteer.

import type { WorldView, WorldFood } from './world.js';
import { dist, sub, scaleTo, type Vec2 } from './geometry.js';

/** How far from the self anchor we look for food. Food beyond
 *  this is ignored (we probably can't see it, and chasing it is
 *  pointless when closer pellets exist). In world units. */
const FEED_SEARCH_RANGE = 600;

/** Default steer projection magnitude. The server uses the offset
 *  direction and clamps the magnitude internally, so what matters
 *  is that we send something non-trivial. */
const STEER_PROJECTION = 400;

/** True when at least one food pellet is within FEED_SEARCH_RANGE
 *  of the self anchor. This is the FEED entry condition. */
export function canFeed(world: WorldView): boolean {
    return findClosestFood(world) !== null;
}

/** Pick the closest food pellet to the self anchor, or null if
 *  none in range. Linear scan: tick entity counts are low enough
 *  (<= config.maxFood ~1000) that a sort is overkill. */
export function findClosestFood(world: WorldView): WorldFood | null {
    let best: WorldFood | null = null;
    let bestDist = FEED_SEARCH_RANGE;
    const anchor = { x: world.self.x, y: world.self.y };
    for (const f of world.food) {
        const d = dist(anchor, f);
        if (d < bestDist) {
            bestDist = d;
            best = f;
        }
    }
    return best;
}

/** Steer vector toward the closest food. Returns null when there's
 *  no food in range (caller should fall back to WANDER). */
export function steerForFeed(world: WorldView): Vec2 | null {
    const target = findClosestFood(world);
    if (!target) return null;
    const anchor = { x: world.self.x, y: world.self.y };
    return scaleTo(sub(target, anchor), STEER_PROJECTION);
}

export interface WanderMemory {
    target: { x: number; y: number } | null;
    /** Server-tick time (ms) when this target was chosen. */
    chosenAt: number;
}

export function newWanderMemory(): WanderMemory {
    return { target: null, chosenAt: 0 };
}

/** How close the self anchor must get to the wander target before
 *  we consider it reached and pick a new one. */
const WANDER_ARRIVAL_RADIUS = 150;
/** Hard cap on how long a single wander target is pursued, even if
 *  the bot keeps missing it (e.g. collided with a virus and lost
 *  mass + speed). Picks fresh after this. */
const WANDER_REFRESH_MS = 10_000;

/** Steer vector for WANDER. Keeps the previous target until the
 *  bot either arrives at it or the refresh window elapses, then
 *  rolls a new one uniformly inside the world rectangle (with a
 *  small margin so the target isn't right against the wall). */
export function steerForWander(world: WorldView, mem: WanderMemory, now: number): Vec2 {
    const anchor = { x: world.self.x, y: world.self.y };
    const needsNew =
        mem.target === null
        || now - mem.chosenAt > WANDER_REFRESH_MS
        || dist(anchor, mem.target) < WANDER_ARRIVAL_RADIUS;
    if (needsNew) {
        mem.target = randomTarget(world.worldSize);
        mem.chosenAt = now;
    }
    return scaleTo(sub(mem.target!, anchor), STEER_PROJECTION);
}

function randomTarget(worldSize: { width: number; height: number }): { x: number; y: number } {
    const margin = 200;
    const w = Math.max(1, worldSize.width - 2 * margin);
    const h = Math.max(1, worldSize.height - 2 * margin);
    return {
        x: margin + Math.random() * w,
        y: margin + Math.random() * h
    };
}
