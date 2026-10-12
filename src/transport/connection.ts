// Thin socket.io wrapper, one instance per bot. Owns the socket
// lifecycle (connect, subscribe, kick/disconnect) and surfaces
// everything else as plain events the Bot state machine consumes.
//
// This is intentionally dumb: it does not decide to reconnect, it
// does not steer, it does not read snapshots. The Bot owns the
// state machine; the connection owns the socket.

import { io, Socket } from 'socket.io-client';
import {
    PROTOCOL_VERSION,
    ClientEvent,
    ServerEvent,
    type Welcome,
    type Reject,
    type Tick,
    type Kick,
    type Message,
    type Rules
} from '@cellagents/game-protocol/wire';

/** User-agent string sent on subscribe. Static for v0.1; a later
 *  version can resolve this from package.json at module load like
 *  cells-mcp does. */
export const GAME_BOTS_USER_AGENT = 'game-bots/0.1.2';

/** Default capability set every bot requests. The chat capability
 *  is in here so milestone 1 can send the join announcement
 *  ("Hello, I am <name>!") from the PLAN's open-questions resolution. */
export const DEFAULT_CAPABILITIES = ['presence', 'steer', 'act', 'chat'] as const;

export type ConnectionEvent =
    | { kind: 'welcome'; payload: Welcome }
    | { kind: 'reject'; payload: Reject }
    | { kind: 'tick'; payload: Tick }
    | { kind: 'kick'; payload: Kick }
    | { kind: 'died' }
    | { kind: 'message'; payload: Message }
    | { kind: 'rulesChanged'; rules: Rules }
    | { kind: 'actionsChanged'; actions: string[] }
    | { kind: 'disconnect'; reason: string }
    | { kind: 'connect_error'; error: Error };

export type ConnectionListener = (event: ConnectionEvent) => void;

export interface ConnectionOptions {
    url: string;
    name: string;
    screen: { width: number; height: number };
    /** Opaque per-bot identity. Sent as `clientId` on subscribe so
     *  the server can correlate reconnects of the same bot in its
     *  audit log. */
    clientId: string;
}

export class Connection {
    private socket: Socket;
    private listener: ConnectionListener | null = null;

    constructor(private readonly opts: ConnectionOptions) {
        this.socket = io(opts.url, { reconnection: false });
        this.wire();
    }

    on(listener: ConnectionListener): void {
        this.listener = listener;
    }

    private emit(event: ConnectionEvent): void {
        if (this.listener) this.listener(event);
    }

    private wire(): void {
        this.socket.on('connect', () => {
            this.socket.emit(ClientEvent.subscribe, {
                protocol: PROTOCOL_VERSION,
                userAgent: GAME_BOTS_USER_AGENT,
                capabilities: [...DEFAULT_CAPABILITIES],
                name: this.opts.name,
                screen: this.opts.screen,
                clientId: this.opts.clientId
            });
        });

        this.socket.on(ServerEvent.welcome, (payload: Welcome) => {
            this.emit({ kind: 'welcome', payload });
        });

        this.socket.on(ServerEvent.reject, (payload: Reject) => {
            this.emit({ kind: 'reject', payload });
        });

        this.socket.on(ServerEvent.tick, (payload: Tick) => {
            this.emit({ kind: 'tick', payload });
        });

        this.socket.on(ServerEvent.kick, (payload: Kick) => {
            this.emit({ kind: 'kick', payload });
        });

        this.socket.on(ServerEvent.died, () => {
            this.emit({ kind: 'died' });
        });

        this.socket.on(ServerEvent.message, (payload: Message) => {
            this.emit({ kind: 'message', payload });
        });

        this.socket.on(ServerEvent.rulesChanged, (payload: { rules: Rules }) => {
            if (payload && payload.rules && typeof payload.rules === 'object') {
                this.emit({ kind: 'rulesChanged', rules: payload.rules });
            }
        });

        this.socket.on(ServerEvent.actionsChanged, (payload: { actions: string[] }) => {
            if (payload && Array.isArray(payload.actions)) {
                this.emit({ kind: 'actionsChanged', actions: payload.actions });
            }
        });

        this.socket.on('disconnect', (reason: string) => {
            this.emit({ kind: 'disconnect', reason });
        });

        this.socket.on('connect_error', (err: Error) => {
            this.emit({ kind: 'connect_error', error: err });
        });
    }

    /** Steer offset relative to the bot's cell. Zero vector keeps
     *  the cell drifting under its own momentum. */
    sendSteer(offset: { x: number; y: number }): void {
        this.socket.emit(ClientEvent.heartbeat, offset);
    }

    sendAction(type: 'split' | 'eject'): void {
        this.socket.emit(ClientEvent.action, { type });
    }

    sendRespawn(): void {
        this.socket.emit(ClientEvent.respawn);
    }

    sendSay(text: string, opts: {
        scope?: 'all' | 'direct';
        to?: string;
        data?: Record<string, string | number | boolean>;
    } = {}): void {
        const scope = opts.scope ?? 'all';
        this.socket.emit(ClientEvent.say, {
            scope,
            text,
            ...(scope === 'direct' && opts.to ? { to: opts.to } : {}),
            ...(opts.data ? { data: opts.data } : {})
        });
    }

    disconnect(): void {
        this.socket.disconnect();
    }
}
