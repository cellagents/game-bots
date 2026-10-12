// Personality knobs → runtime thresholds. One place to edit the
// numbers, one place to grep when behaviour changes. All inputs are
// in [0, 1]; all outputs are documented alongside their helpers.

import { lerp } from './geometry.js';

/** Minimum mass ratio (self / prey) to even consider HUNT.
 *  Timid bots want a 1.5x advantage; aggressive bots pursue at
 *  1.15x. Below the floor the bot does not treat the target as
 *  prey at all. */
export function huntRatioThreshold(aggressiveness: number): number {
    return lerp(1.5, 1.15, aggressiveness);
}

/** Maximum chase distance in world units. Timid bots give up at
 *  300 units; aggressive bots chase up to 900. */
export function pursuitRange(aggressiveness: number): number {
    return lerp(300, 900, aggressiveness);
}

/** Flee radius used when the bot is BIGGER than visible threats
 *  (so cowardice does not apply). A gentle nudge, nothing dramatic.
 *  Aggressive bots let threats get a bit closer before fleeing. */
export function nonCowardFleeRadius(aggressiveness: number): number {
    return lerp(220, 120, aggressiveness);
}

/** Cowardice-driven flee radius. Scales from "almost touching"
 *  (0.0) to "anywhere in viewport" (1.0). A viewport diagonal of
 *  ~2200 world units matches cells-game's typical maxViewport. */
export function cowardFleeRadius(cowardice: number, viewportDiagonal = 2200): number {
    return lerp(300, viewportDiagonal, cowardice);
}

/** Probability of entering SPLIT_ATTACK from HUNT when a split
 *  would land the kill. Pure linear in splitWillingness; HUNT
 *  scales this by a confidence factor (section 6 of PLAN.md). */
export function attackSplitProbability(splitWillingness: number): number {
    return splitWillingness;
}

/** Probability of emitting an escape split from FLEE when cornered.
 *  Same knob as attack splits; splitting is a single trait. */
export function escapeSplitProbability(splitWillingness: number): number {
    return splitWillingness;
}

/** When fleeing, how much to weight the full "repel from all
 *  larger enemies" vector versus "run straight away from the
 *  closest". High-cowardice bots prefer the sum; low-cowardice
 *  bots prefer the single closest. */
export function multiThreatBlend(cowardice: number): number {
    return cowardice;
}

/** While fleeing, whether to still grab food that happens to lie
 *  along the flee vector. Low-cowardice bots are opportunistic
 *  (<0.5); high-cowardice bots single-mindedly maximise distance. */
export function fleesIgnoreFood(cowardice: number): boolean {
    return cowardice >= 0.5;
}
