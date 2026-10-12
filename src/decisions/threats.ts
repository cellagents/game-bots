// Threat / prey classification over a WorldView.
//
// Mass bookkeeping: in cells-game a cell-vs-cell eat requires full
// enclosure, not a mass ratio, but mass does gate attempts: the
// server's `eatRatio` rule says a cell must have `mass > other *
// eatRatio` to even consider the eat. We use the player's biggest
// cell for threat/prey classification (that's the one that would
// actually land the eat) and total mass for the "am I bigger?"
// cowardice check (that's the whole-of-us comparison).

import type { WorldView, WorldPlayer, WorldCell } from './world.js';
import { dist } from './geometry.js';
import type { Rules } from '@cellagents/game-protocol/wire';

/** Fallback when the server's rules bag omits `eatRatio`. Matches
 *  the 1.0 cells-game default. */
const DEFAULT_EAT_RATIO = 1.1;

export function eatRatio(rules: Rules | null): number {
    if (!rules) return DEFAULT_EAT_RATIO;
    const r = rules.eatRatio;
    return typeof r === 'number' && Number.isFinite(r) && r > 0 ? r : DEFAULT_EAT_RATIO;
}

/** The one cell of ours we treat as "us" for close-range decisions:
 *  the biggest cell. Chasing/fleeing from the centroid is wrong
 *  when the player is split and the halves are far apart; the
 *  biggest cell is both the one most likely to survive and the
 *  one that will do the eating. */
export function biggestOwnCell(world: WorldView): WorldCell | null {
    if (world.self.cells.length === 0) return null;
    let best = world.self.cells[0];
    for (let i = 1; i < world.self.cells.length; i++) {
        if (world.self.cells[i].mass > best.mass) best = world.self.cells[i];
    }
    return best;
}

/** Biggest cell for an arbitrary player (identical rule, lifted to
 *  non-self so threats and prey are evaluated the same way). */
export function biggestCellOf(p: WorldPlayer): WorldCell | null {
    if (p.cells.length === 0) return null;
    let best = p.cells[0];
    for (let i = 1; i < p.cells.length; i++) {
        if (p.cells[i].mass > best.mass) best = p.cells[i];
    }
    return best;
}

export interface Threat {
    player: WorldPlayer;
    biggestCell: WorldCell;
    distance: number;
}

export interface Prey {
    player: WorldPlayer;
    biggestCell: WorldCell;
    distance: number;
    /** Our biggest-cell-mass divided by theirs. Always > eatRatio
     *  by construction (filtered out otherwise). */
    massRatio: number;
}

/** Enemies whose biggest cell could eat our biggest cell on a direct
 *  overlap. Sorted nearest-first; use this list for FLEE targets. */
export function listThreats(world: WorldView, rules: Rules | null): Threat[] {
    const my = biggestOwnCell(world);
    if (!my) return [];
    const ratio = eatRatio(rules);
    const anchor = { x: my.x, y: my.y };
    const out: Threat[] = [];
    for (const p of world.others) {
        const theirs = biggestCellOf(p);
        if (!theirs) continue;
        if (theirs.mass > my.mass * ratio) {
            out.push({ player: p, biggestCell: theirs, distance: dist(anchor, theirs) });
        }
    }
    out.sort((a, b) => a.distance - b.distance);
    return out;
}

/** Enemies whose biggest cell our biggest cell could eat. Filtered
 *  by the eat ratio AND a hunt-ratio floor from personality: we want
 *  more than "possible to eat", we want "worth chasing". */
export function listPrey(
    world: WorldView,
    rules: Rules | null,
    huntRatioFloor: number,
    pursuitRangeMax: number
): Prey[] {
    const my = biggestOwnCell(world);
    if (!my) return [];
    const ratio = Math.max(eatRatio(rules), huntRatioFloor);
    const anchor = { x: my.x, y: my.y };
    const out: Prey[] = [];
    for (const p of world.others) {
        const theirs = biggestCellOf(p);
        if (!theirs) continue;
        if (my.mass > theirs.mass * ratio) {
            const d = dist(anchor, theirs);
            if (d <= pursuitRangeMax) {
                out.push({ player: p, biggestCell: theirs, distance: d, massRatio: my.mass / theirs.mass });
            }
        }
    }
    // Sort by distance primarily, with a mild preference for
    // higher-ratio targets at the same distance.
    out.sort((a, b) => a.distance - b.distance || b.massRatio - a.massRatio);
    return out;
}

/** Any enemy whose TOTAL mass exceeds ours. Used by the cowardice
 *  gate: cowardice fires on whole-player comparison because the
 *  bot's whole future (the sum of its halves, which the enemy can
 *  pick off one by one) is at stake, not just its biggest cell. */
export function anyBiggerPlayer(world: WorldView): boolean {
    for (const p of world.others) {
        if (p.massTotal > world.self.massTotal) return true;
    }
    return false;
}
