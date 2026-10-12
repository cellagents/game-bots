// Project a protocol-1.0 Tick into the shape the decision loop
// wants: self anchor + own cells, other players' cells grouped by
// owner, and the three static entity kinds split out. Unknown
// kinds are dropped (per protocol rule 1, we preserve on the wire
// but have nothing useful to do with them here).

import type { Tick } from '@cellagents/game-protocol/wire';

export interface WorldCell { id: number; x: number; y: number; mass: number; radius: number; }
export interface WorldPlayer {
    id: string;
    name: string | null;
    massTotal: number;
    cells: WorldCell[];
}
export interface WorldFood { id: number; x: number; y: number; mass: number; }

export interface WorldView {
    self: {
        id: string;
        x: number;
        y: number;
        massTotal: number;
        cells: WorldCell[];
    };
    /** All other players (self excluded). */
    others: WorldPlayer[];
    food: WorldFood[];
    ejected: WorldFood[];
    viruses: WorldFood[];
    worldSize: { width: number; height: number };
    time: number;
}

export function projectTick(tick: Tick, worldSize: { width: number; height: number }): WorldView | null {
    const self = tick.self;
    if (!self) return null;

    const myCells: WorldCell[] = [];
    const cellsByOwner = new Map<string, WorldCell[]>();
    const food: WorldFood[] = [];
    const ejected: WorldFood[] = [];
    const viruses: WorldFood[] = [];

    for (const e of tick.entities) {
        switch (e.kind) {
            case 'cell': {
                const owner = (e as { owner?: unknown }).owner;
                if (typeof owner !== 'string') break;
                const c: WorldCell = { id: e.id, x: e.x, y: e.y, mass: e.mass, radius: e.radius };
                if (owner === self.id) {
                    myCells.push(c);
                } else {
                    const list = cellsByOwner.get(owner);
                    if (list) list.push(c);
                    else cellsByOwner.set(owner, [c]);
                }
                break;
            }
            case 'food':
                food.push({ id: e.id, x: e.x, y: e.y, mass: e.mass });
                break;
            case 'ejected':
                ejected.push({ id: e.id, x: e.x, y: e.y, mass: e.mass });
                break;
            case 'virus':
                viruses.push({ id: e.id, x: e.x, y: e.y, mass: e.mass });
                break;
            default:
                break;
        }
    }

    const others: WorldPlayer[] = tick.players
        .filter((p) => p.id !== self.id)
        .map((p) => ({
            id: p.id,
            name: p.name ?? null,
            massTotal: p.massTotal,
            cells: cellsByOwner.get(p.id) ?? []
        }));

    return {
        self: {
            id: self.id,
            x: self.x,
            y: self.y,
            massTotal: self.massTotal,
            cells: myCells
        },
        others,
        food,
        ejected,
        viruses,
        worldSize,
        time: tick.time
    };
}
