// Bot: one instance per configured bot. Owns a Connection, holds
// the latest world snapshot, runs its own decision loop on each
// scheduler tick, and emits actions through the connection.
//
// Milestone 1 is the lifecycle skeleton: states DISCONNECTED →
// CONNECTING → SPAWNING → WANDER (idle, no steering). On kick or
// socket drop the bot goes back to DISCONNECTED and reconnects
// with exponential backoff. On died it respawns. Chat join
// announcement fires once per welcome.
//
// Movement, prey/threat decisions, and SPLIT_ATTACK land in later
// milestones.

import { randomUUID } from 'node:crypto';
import type { BotConfig } from './config.js';
import { Connection } from './transport/connection.js';
import type { ConnectionEvent } from './transport/connection.js';
import type { BotState } from './states/index.js';
import { recordMetric } from './metrics.js';
import type { Tick, Welcome } from '@cellagents/game-protocol/wire';

/** Backoff ladder for reconnection attempts after the socket drops
 *  or the server kicks us. Index is clamped to the array length so
 *  the last entry is the steady-state cap. Values in ms. */
const RECONNECT_BACKOFF_MS = [500, 1000, 2000, 4000];
/** Reasonable default viewport advertised on subscribe. The server
 *  clamps this to its `maxViewport`, so the exact number doesn't
 *  need to be tuned per deployment; it just sets the upper bound on
 *  what we can perceive. */
const DEFAULT_SCREEN = { width: 1920, height: 1080 };

export interface BotRuntimeOptions {
    remoteName: string;
    remoteUrl: string;
    config: BotConfig;
}

export class Bot {
    readonly name: string;
    readonly remoteName: string;
    private state: BotState = 'DISCONNECTED';
    /** Opaque per-bot identity. Reused across reconnects so the
     *  server can correlate the sessions in its audit log. */
    private readonly clientId: string = randomUUID();
    private connection: Connection | null = null;
    private latestTick: Tick | null = null;
    private welcome: Welcome | null = null;
    /** Timestamp (ms) when spawn invulnerability ends. Set from
     *  the invulnerable effect on welcome / respawn. 0 when there
     *  is no active invuln. */
    private invulnUntil = 0;
    /** Number of consecutive reconnect attempts since the last
     *  successful welcome; indexes into RECONNECT_BACKOFF_MS. */
    private reconnectAttempt = 0;
    /** Pending reconnect timer, so we don't schedule two in flight. */
    private reconnectTimer: NodeJS.Timeout | null = null;
    /** Whether we already announced ourselves on this session.
     *  Resets on disconnect so each new session says hello again. */
    private announcedThisSession = false;
    /** True once stop() has been called; blocks any further
     *  reconnect attempts. */
    private shutdown = false;

    constructor(private readonly opts: BotRuntimeOptions) {
        this.name = opts.config.name;
        this.remoteName = opts.remoteName;
    }

    /** Called by the scheduler when the process is starting up and
     *  the bot should begin its lifecycle. */
    start(): void {
        this.openConnection();
    }

    /** Called by the scheduler on each heartbeat tick. Runs the
     *  state-transition ladder, then dispatches state-specific
     *  behaviour. Milestone 1: lifecycle only, no steering. */
    tick(): void {
        this.evaluateInvuln();

        // Transition ladder. The lifecycle branches are the only
        // ones wired in milestone 1; FLEE/HUNT/FEED/WANDER
        // discrimination arrives in milestones 2 and 3.
        if (!this.connection) {
            this.setState('DISCONNECTED');
        } else if (!this.welcome) {
            this.setState('CONNECTING');
        } else if (this.state === 'DEAD') {
            // Stays in DEAD until the server welcomes us back.
        } else if (this.isInvulnerable()) {
            this.setState('SPAWNING');
        } else {
            this.setState('WANDER');
        }

        recordMetric({
            time: Date.now(),
            botName: this.name,
            remote: this.remoteName,
            state: this.state,
            massTotal: this.latestTick?.self?.massTotal ?? 0,
            cellCount: this.countOwnCells(),
            decision: this.decisionTag()
        });
    }

    stop(): void {
        this.shutdown = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.connection) {
            this.connection.disconnect();
            this.connection = null;
        }
    }

    // ---------------------------------------------------------------
    // Connection lifecycle
    // ---------------------------------------------------------------

    private openConnection(): void {
        if (this.shutdown) return;
        this.welcome = null;
        this.latestTick = null;
        this.announcedThisSession = false;
        this.invulnUntil = 0;
        const conn = new Connection({
            url: this.opts.remoteUrl,
            name: this.name,
            screen: DEFAULT_SCREEN,
            clientId: this.clientId
        });
        conn.on((e) => this.handleConnectionEvent(e));
        this.connection = conn;
        this.setState('CONNECTING');
    }

    private handleConnectionEvent(e: ConnectionEvent): void {
        switch (e.kind) {
            case 'welcome':
                this.welcome = e.payload;
                this.reconnectAttempt = 0;
                // Welcome.self carries only id/name/hue; the
                // invuln effect arrives on the first Tick.
                this.maybeAnnounce();
                break;
            case 'reject':
                console.warn(`[bot ${this.name}] subscribe rejected: ${e.payload.code} ${e.payload.message}`);
                this.scheduleReconnect();
                break;
            case 'tick':
                this.latestTick = e.payload;
                this.readInvulnFromTick(e.payload);
                break;
            case 'kick':
                console.warn(`[bot ${this.name}] kicked: ${e.payload.reason}`);
                this.scheduleReconnect();
                break;
            case 'died':
                this.setState('DEAD');
                // Milestone 1: ask for respawn immediately on next
                // tick. Later milestones might delay (e.g. observe
                // the room first), but indefinite play is the stated
                // behaviour.
                if (this.connection) this.connection.sendRespawn();
                break;
            case 'message':
                // No-op in milestone 1. Metrics sink can grow a
                // chat hook later.
                break;
            case 'disconnect':
                console.warn(`[bot ${this.name}] disconnected: ${e.reason}`);
                this.scheduleReconnect();
                break;
            case 'connect_error':
                console.warn(`[bot ${this.name}] connect_error: ${e.error.message}`);
                this.scheduleReconnect();
                break;
        }
    }

    private scheduleReconnect(): void {
        if (this.shutdown || this.reconnectTimer) return;
        if (this.connection) {
            this.connection.disconnect();
            this.connection = null;
        }
        this.welcome = null;
        this.latestTick = null;
        this.setState('DISCONNECTED');
        const idx = Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1);
        const base = RECONNECT_BACKOFF_MS[idx];
        const jitter = Math.floor(Math.random() * (base / 2));
        const delay = base + jitter;
        this.reconnectAttempt++;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.openConnection();
        }, delay);
    }

    // ---------------------------------------------------------------
    // Invuln timer
    // ---------------------------------------------------------------

    private readInvulnFromTick(t: Tick): void {
        if (!t.self) return;
        const deadline = extractInvulnDeadline(t.self.effects);
        if (deadline !== null) this.invulnUntil = deadline;
    }

    private evaluateInvuln(): void {
        if (this.invulnUntil && Date.now() >= this.invulnUntil) {
            this.invulnUntil = 0;
        }
    }

    private isInvulnerable(): boolean {
        return this.invulnUntil > 0;
    }

    // ---------------------------------------------------------------
    // Chat
    // ---------------------------------------------------------------

    private maybeAnnounce(): void {
        if (this.announcedThisSession || !this.connection) return;
        if (!this.welcome?.capabilities?.includes('chat')) return;
        this.connection.sendSay(`Hello, I am ${this.name}!`, { scope: 'all' });
        this.announcedThisSession = true;
    }

    // ---------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------

    private setState(next: BotState): void {
        if (this.state === next) return;
        this.state = next;
    }

    private countOwnCells(): number {
        if (!this.latestTick?.self) return 0;
        let n = 0;
        const myId = this.latestTick.self.id;
        for (const e of this.latestTick.entities) {
            if (e.kind === 'cell') {
                const owner = (e as { owner?: string }).owner;
                if (owner === myId) n++;
            }
        }
        return n;
    }

    private decisionTag(): string {
        switch (this.state) {
            case 'DISCONNECTED': return 'reconnect';
            case 'CONNECTING':   return 'awaiting-welcome';
            case 'SPAWNING':     return 'invuln-wait';
            case 'DEAD':         return 'respawn-pending';
            default:              return 'idle';
        }
    }
}

/** Pull the `invulnerable` effect's `until` deadline out of an
 *  effects list. Returns the ms timestamp when invuln expires, or
 *  null when there is no invuln effect in the list (i.e. the server
 *  did not say anything about it on this frame; keep the previous
 *  value). */
function extractInvulnDeadline(effects: unknown): number | null {
    if (!Array.isArray(effects)) return null;
    for (const eff of effects) {
        if (eff && typeof eff === 'object' && (eff as { type?: unknown }).type === 'invulnerable') {
            const until = (eff as { until?: unknown }).until;
            if (typeof until === 'number' && Number.isFinite(until)) return until;
        }
    }
    return null;
}
