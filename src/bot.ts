// Bot: one instance per configured bot. Owns a Connection, holds
// the latest world snapshot, runs its own decision loop on each
// scheduler tick, and emits actions through the connection.
//
// Milestone 3 scope: full state machine, all three personality
// knobs active. Transition ladder (section 5 of PLAN.md):
//
//   DISCONNECTED → CONNECTING → SPAWNING (invuln drift) →
//     cowardice gate → FLEE → HUNT (maybe SPLIT_ATTACK) →
//     FEED → WANDER
//
// SPLIT_ATTACK is a one-tick transient: it emits a split action
// and then falls back to HUNT/WANDER on the next tick.

import { randomUUID } from 'node:crypto';
import type { BotConfig } from './config.js';
import { Connection } from './transport/connection.js';
import type { ConnectionEvent } from './transport/connection.js';
import type { BotState } from './states/index.js';
import { recordMetric } from './metrics.js';
import type { Tick, Welcome } from '@cellagents/game-protocol/wire';
import { projectTick, type WorldView } from './decisions/world.js';
import {
    canFeed,
    newWanderMemory,
    steerForFeed,
    steerForWander,
    type WanderMemory
} from './decisions/feed.js';
import {
    listThreats,
    listPrey,
    anyBiggerPlayer,
    eatRatio,
    type Threat,
    type Prey
} from './decisions/threats.js';
import {
    steerForHunt,
    steerForFlee,
    splitWouldLand,
    splitConfidence,
    isCornered,
    nearbyThreatOutsideCowardice,
    nonZeroVector
} from './decisions/combat.js';
import {
    attackSplitProbability,
    cowardFleeRadius,
    escapeSplitProbability,
    fleesIgnoreFood,
    huntRatioThreshold,
    multiThreatBlend,
    nonCowardFleeRadius,
    pursuitRange
} from './decisions/personality.js';

/** Backoff ladder for reconnection attempts after the socket drops
 *  or the server kicks us. Index is clamped to the array length so
 *  the last entry is the steady-state cap. Values in ms. */
const RECONNECT_BACKOFF_MS = [500, 1000, 2000, 4000];
/** Reasonable default viewport advertised on subscribe. The server
 *  clamps this to its `maxViewport`, so the exact number doesn't
 *  need to be tuned per deployment; it just sets the upper bound on
 *  what we can perceive. */
const DEFAULT_SCREEN = { width: 1920, height: 1080 };
/** How long to wait for a welcome after socket connect before
 *  giving up and reconnecting. A healthy server welcomes in well
 *  under a second; 5 s catches a server that TCP-accepts but
 *  never sends the handshake (process stuck on startup, bad
 *  config, etc). */
const WELCOME_TIMEOUT_MS = 5000;

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
    /** Fires if no welcome arrives after socket connect. Cleared on
     *  welcome or on scheduleReconnect. Without this a stalled
     *  server (TCP accepts, never responds) pins us in CONNECTING
     *  forever and the backoff never fires. */
    private welcomeTimeout: NodeJS.Timeout | null = null;
    /** Whether we already announced ourselves on this session.
     *  Resets on disconnect so each new session says hello again. */
    private announcedThisSession = false;
    /** True once stop() has been called; blocks any further
     *  reconnect attempts. */
    private shutdown = false;
    /** Persistent memory for WANDER so the bot pursues a single
     *  target for several ticks instead of jittering. Reset on
     *  each new session. */
    private wanderMemory: WanderMemory = newWanderMemory();
    /** Per-tick scratchpad holding the prey/threat the current
     *  state is targeting. Rebuilt from scratch each tick; stored
     *  on the instance only so emitSteerForState() can read the
     *  same objects the ladder picked without recomputing them. */
    private tickPlan: {
        prey: Prey | null;
        threats: Threat[];
        preySplitLands: boolean;
    } = { prey: null, threats: [], preySplitLands: false };

    constructor(private readonly opts: BotRuntimeOptions) {
        this.name = opts.config.name;
        this.remoteName = opts.remoteName;
    }

    /** Called by the scheduler when the process is starting up and
     *  the bot should begin its lifecycle. */
    start(): void {
        this.openConnection();
    }

    /** Called by the scheduler on each heartbeat tick. Projects
     *  the latest Tick, runs the state-transition ladder, emits a
     *  steer offset (and sometimes a split action), and reports a
     *  metric sample. */
    tick(): void {
        this.evaluateInvuln();

        const world = this.projectWorld();
        this.tickPlan = { prey: null, threats: [], preySplitLands: false };

        if (!this.connection) {
            this.setState('DISCONNECTED');
        } else if (!this.welcome || !world) {
            this.setState('CONNECTING');
        } else if (this.isInvulnerable()) {
            this.setState('SPAWNING');
        } else {
            this.pickAliveState(world);
        }

        this.emitActions(world);

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

    /** Alive-state branch of the ladder: step 3 (cowardice) through
     *  step 7 (wander) of PLAN section 5. Populates this.tickPlan
     *  with any prey/threats the chosen state will steer against. */
    private pickAliveState(world: WorldView): void {
        const rules = this.welcome?.rules ?? null;
        const cfg = this.opts.config;
        const threats = listThreats(world, rules);
        this.tickPlan.threats = threats;

        // Hysteresis multiplier: a bot currently in FLEE stays in
        // FLEE until the nearest threat passes 1.5x the entry
        // radius. Without this the bot flaps FEED/FLEE every tick
        // on the knife-edge of the radius, wasting most ticks and
        // producing no net progress away from the threat.
        const stickyMul = this.state === 'FLEE' ? 1.5 : 1.0;

        // Step 3: cowardice gate. Triggers when any enemy outweighs
        // us in TOTAL mass and the closest biggest-cell threat is
        // inside the cowardice-scaled flee radius. Once engaged it
        // pins the bot to FLEE and forbids HUNT (section 6 of PLAN).
        if (anyBiggerPlayer(world) && threats.length > 0) {
            const cowardRadius = cowardFleeRadius(cfg.cowardice) * stickyMul;
            if (threats[0].distance <= cowardRadius) {
                this.setState('FLEE');
                return;
            }
        }

        // Step 4: non-coward FLEE. Even when we're bigger overall,
        // a nearby bigger cell is a problem (think a split enemy
        // whose half still outweighs ours). Smaller radius here.
        const nonCowardFlee = nearbyThreatOutsideCowardice(
            world,
            threats,
            nonCowardFleeRadius(cfg.aggressiveness) * stickyMul
        );
        if (nonCowardFlee) {
            this.setState('FLEE');
            return;
        }

        // Step 5: HUNT. Prey list is already filtered by eat ratio
        // AND the personality-driven hunt ratio floor AND the
        // pursuit range cap.
        const prey = listPrey(
            world,
            rules,
            huntRatioThreshold(cfg.aggressiveness),
            pursuitRange(cfg.aggressiveness)
        );
        if (prey.length > 0) {
            const target = prey[0];
            this.tickPlan.prey = target;
            const rulesEatRatio = eatRatio(rules);
            const splitLimit = readSplitLimit(rules);
            if (splitWouldLand(world, target, rulesEatRatio, splitLimit)) {
                const conf = splitConfidence(world, target, rulesEatRatio);
                const p = attackSplitProbability(cfg.splitWillingness) * conf;
                if (Math.random() < p) {
                    this.tickPlan.preySplitLands = true;
                    this.setState('SPLIT_ATTACK');
                    return;
                }
            }
            this.setState('HUNT');
            return;
        }

        // Step 6: FEED (unchanged).
        if (canFeed(world)) {
            this.setState('FEED');
            return;
        }

        // Step 7: WANDER fallback.
        this.setState('WANDER');
    }

    stop(): void {
        this.shutdown = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.clearWelcomeTimeout();
        if (this.connection) {
            this.connection.close();
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
        this.wanderMemory = newWanderMemory();
        // Clear the DEAD latch so a dropped socket during the DEAD
        // window doesn't permanently freeze the ladder on the new
        // session. Without this, if we die, lose the socket before
        // the respawn Tick, reconnect, and get a Welcome, the
        // ladder would short-circuit on this.state === 'DEAD' and
        // never advance.
        this.setState('CONNECTING');
        const conn = new Connection({
            url: this.opts.remoteUrl,
            name: this.name,
            screen: DEFAULT_SCREEN,
            clientId: this.clientId
        });
        conn.on((e) => this.handleConnectionEvent(e));
        this.connection = conn;
        this.armWelcomeTimeout();
    }

    private armWelcomeTimeout(): void {
        this.clearWelcomeTimeout();
        this.welcomeTimeout = setTimeout(() => {
            this.welcomeTimeout = null;
            if (this.welcome) return;
            console.warn(`[bot ${this.name}] no welcome in ${WELCOME_TIMEOUT_MS}ms, reconnecting`);
            this.scheduleReconnect();
        }, WELCOME_TIMEOUT_MS);
        this.welcomeTimeout.unref?.();
    }

    private clearWelcomeTimeout(): void {
        if (this.welcomeTimeout) {
            clearTimeout(this.welcomeTimeout);
            this.welcomeTimeout = null;
        }
    }

    private handleConnectionEvent(e: ConnectionEvent): void {
        switch (e.kind) {
            case 'welcome':
                this.welcome = e.payload;
                this.reconnectAttempt = 0;
                this.clearWelcomeTimeout();
                // Welcome.self carries only id/name/hue; the
                // invuln effect arrives on the first Tick.
                this.maybeAnnounce();
                break;
            case 'rulesChanged':
                if (this.welcome) this.welcome.rules = e.rules;
                break;
            case 'actionsChanged':
                if (this.welcome) this.welcome.actions = e.actions;
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
                // Server nulls record.player as soon as a player is
                // eaten, and its respawn handler short-circuits when
                // record.player is null. So `respawn` is effectively
                // dead code for a bot that was already eaten; the web
                // client itself handles death by returning to the
                // lobby and reconnecting. Mirror that: drop the socket
                // and let the reconnect ladder bring us back as a
                // fresh subscribe.
                console.log(`[bot ${this.name}] died, reconnecting for respawn`);
                this.setState('DEAD');
                this.scheduleReconnect();
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
        this.clearWelcomeTimeout();
        if (this.connection) {
            // close() detaches the listener BEFORE disconnecting
            // the socket, so the queued transport-close event that
            // socket.io fires on its way down can't cascade back
            // into another scheduleReconnect() call against the
            // next session.
            this.connection.close();
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
        if (process.env.GAME_BOTS_LOG_STATES === '1') {
            console.log(`[bot ${this.name}] ${this.state} -> ${next}`);
        }
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
            case 'DISCONNECTED':  return 'reconnect';
            case 'CONNECTING':    return 'awaiting-welcome';
            case 'SPAWNING':      return 'invuln-drift';
            case 'DEAD':          return 'respawn-pending';
            case 'FEED':          return 'steer-feed';
            case 'WANDER':        return 'steer-wander';
            case 'HUNT':          return 'steer-hunt';
            case 'FLEE':          return 'steer-flee';
            case 'SPLIT_ATTACK':  return 'split-attack';
        }
    }

    private projectWorld(): WorldView | null {
        if (!this.latestTick || !this.welcome) return null;
        return projectTick(this.latestTick, this.welcome.world);
    }

    /** Translate the current state into a steer offset (always)
     *  plus zero or more one-shot actions (split, respawn, etc.)
     *  and push them down the wire. States with no useful heading
     *  emit the zero vector so the server sees us as alive-and-
     *  drifting rather than stalled. */
    private emitActions(world: WorldView | null): void {
        if (!this.connection) return;
        if (!world) {
            this.connection.sendSteer({ x: 0, y: 0 });
            return;
        }
        const cfg = this.opts.config;
        let offset = { x: 0, y: 0 };
        switch (this.state) {
            case 'HUNT': {
                const prey = this.tickPlan.prey;
                if (prey) offset = steerForHunt(world, prey);
                break;
            }
            case 'SPLIT_ATTACK': {
                const prey = this.tickPlan.prey;
                if (prey) offset = steerForHunt(world, prey);
                // Fire the split alongside the steer. Server
                // interprets the steer as the heading the halves
                // will burst along; splitting without a steer is
                // non-deterministic.
                this.connection.sendAction('split');
                break;
            }
            case 'FLEE': {
                offset = steerForFlee(world, this.tickPlan.threats, multiThreatBlend(cfg.cowardice));
                // Opportunistic food grab for low-cowardice bots:
                // if a pellet lies roughly along the flee vector,
                // blend it in. We approximate "along the vector"
                // by preferring the pellet whose displacement has
                // a positive dot product with the flee vector.
                if (!fleesIgnoreFood(cfg.cowardice)) {
                    const feedOffset = steerForFeed(world);
                    if (feedOffset && (offset.x * feedOffset.x + offset.y * feedOffset.y) > 0) {
                        offset = { x: offset.x + feedOffset.x * 0.3, y: offset.y + feedOffset.y * 0.3 };
                    }
                }
                offset = nonZeroVector(offset);
                // Escape split: cornered against the map edge, we
                // can burst outward. Only fires on splitWillingness
                // roll AND cornered check AND cell-count headroom.
                if (
                    isCornered(world)
                    && this.tickPlan.threats.length > 0
                    && world.self.cells.length < readSplitLimit(this.welcome?.rules ?? null)
                    && Math.random() < escapeSplitProbability(cfg.splitWillingness)
                ) {
                    this.connection.sendAction('split');
                }
                break;
            }
            case 'FEED':
                offset = steerForFeed(world) ?? offset;
                break;
            case 'WANDER':
            case 'SPAWNING':
                // SPAWNING drifts under the wander policy: the
                // invuln bot wants to spread out, and the random
                // target serves that until a dedicated spawn
                // heuristic earns its keep.
                offset = steerForWander(world, this.wanderMemory, world.time);
                break;
            default:
                // DISCONNECTED, CONNECTING, DEAD: nothing to send.
                // DEAD is a brief latch between `died` and the
                // scheduled reconnect; emitActions runs between
                // the two but has nothing useful to do.
                break;
        }
        this.connection.sendSteer(offset);
    }
}

/** Read the server-advertised split cap from the rules bag.
 *  Falls back to a conservative 16 (the 1.0 cells-game default)
 *  when the rules key is missing. */
function readSplitLimit(rules: { [k: string]: unknown } | null): number {
    if (!rules) return 16;
    const v = rules.splitLimit;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
    return 16;
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
