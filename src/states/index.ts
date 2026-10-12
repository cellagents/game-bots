// State machine state names. The transition ladder lives in bot.ts;
// per-state behaviour will live in sibling files once milestones 2
// and 3 wire up movement and combat. Milestone 1 ships the
// connection-lifecycle states only.

export type BotState =
    | 'DISCONNECTED'
    | 'CONNECTING'
    | 'SPAWNING'
    | 'DEAD'
    | 'WANDER'
    | 'FEED'
    | 'HUNT'
    | 'FLEE'
    | 'SPLIT_ATTACK';
