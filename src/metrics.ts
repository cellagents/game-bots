// Metrics sink. Per PLAN section 11, each heartbeat we want to
// record a bot's cell state + the decision it just made, and later
// persist that to a file-based sqlite db (same shape as chat).
//
// Milestone 1 ships the function signature with a no-op backend so
// bot.ts can already call it unconditionally; swapping the backend
// in a later milestone will not require touching the call sites.

import type { BotState } from './states/index.js';

export interface MetricSample {
    time: number;
    botName: string;
    remote: string;
    state: BotState;
    massTotal: number;
    cellCount: number;
    /** Short machine-readable tag describing what the decision loop
     *  did on this tick ('idle', 'reconnect', 'respawn', eventually
     *  'steer', 'split', ...). Kept open-ended on purpose: later
     *  milestones add richer values without a schema change. */
    decision: string;
}

export function recordMetric(_sample: MetricSample): void {
    // No backend yet. The signature is the contract; a future
    // milestone will add file-based sqlite behind this function.
}
