# game-bots

Headless Node.js process that connects N deterministic bots to one
or more `cells-game` servers over the official
[`@cellagents/game-protocol`](https://github.com/cellagents/game-protocol)
wire, plays indefinitely, and tunes each bot's behaviour from
three personality knobs in a JSON config file.

## `cellagents` project

Cell agents is an educational project where **LLM agents play this
game against each other and against human players.** This repo is
one of several key components in that stack; its job is to provide
scripted baseline opponents the LLM agents (and humans) can measure
themselves against.

Visit [**cellagents.dev**](https://cellagents.dev/) for overview of the full project.

## Compatibility

Targets `cells-game` 4.0+ speaking the official
[`@cellagents/game-protocol`](https://github.com/cellagents/game-protocol)
version 1.0 wire. No legacy fallback: a game server that does not
speak 1.0 will reject the subscribe and the bot will log the
reason and keep retrying.

## Bot variables

Each configured bot has three personality knobs, all in `[0, 1]`:

| Variable           | What it controls                                                              |
|--------------------|-------------------------------------------------------------------------------|
| `aggressiveness`   | Behaviour when the bot is bigger than visible threats. Tunes the hunt-ratio floor (how much mass advantage is "worth chasing": 1.5x at 0.0 → 1.15x at 1.0), the pursuit range (300 → 900 world units), and the non-cowardice flee radius (220 → 120 world units: aggressive bots let threats get a bit closer before fleeing). |
| `splitWillingness` | Probability of entering `SPLIT_ATTACK` from `HUNT` when a split would land the kill (confidence-scaled), and probability of an escape split from `FLEE` when cornered against the map edge. Hard-gated by the server's `splitLimit` and the "halves still outweigh prey" check, so a hot knob never produces a suicide split. |
| `cowardice`        | **Dominates decision-making when the bot is smaller than nearby enemies.** Scales the flee radius from "almost touching" (300 units) to "anywhere in viewport" (2200 units) at 1.0; pins the state machine to `FLEE` while triggered, forbidding `HUNT` of smaller prey in a mixed situation; blends the flee direction between "away from closest" and "sum of inverse-distance repulsion from all larger enemies"; forbids opportunistic food-grabs above 0.5. |

Bot names must match the protocol-1.0 name regex
`/^[\p{L}\p{N}_]{1,25}$/u` (letters, digits, underscore; no
hyphens or spaces); the loader rejects anything else at startup.

See [`PLAN.md`](./PLAN.md) for the full state machine and the
interaction summary between the three knobs.

## Config shape

```jsonc
{
  "heartbeatMs": 100,
  "remotes": [
    {
      "name": "local",
      "url": "http://localhost:3000",
      "bots": [
        { "name": "greedy_1", "aggressiveness": 0.8, "splitWillingness": 0.6, "cowardice": 0.2 },
        { "name": "coward_1", "aggressiveness": 0.2, "splitWillingness": 0.1, "cowardice": 0.9 }
      ]
    }
  ]
}
```

- `heartbeatMs`: scheduler tick period, default `100`. The whole
  process shares one tick: each heartbeat runs every bot's decision
  loop once, in registration order.
- `remotes[].bots[]`: one entry per bot instance. The array length
  is the bot count. Explicit per-bot config is deliberate: operators
  tune individuals, and server-side admin audits stay identifiable
  by bot name.

The loader resolves config in this order; the first match wins:

1. `$GAME_BOTS_INLINE_CONFIG`: the raw JSON above as a string.
   Convenient in `docker-compose.yml` where a stray config file in
   the image shouldn't mask the deployment roster.
2. `$GAME_BOTS_CONFIG`: absolute path to an alternate config file.
3. `./config.json`: user-managed, gitignored.
4. `./config.example.json`: checked-in defaults.

| Variable                   | Overrides                                                   |
|----------------------------|-------------------------------------------------------------|
| `GAME_BOTS_INLINE_CONFIG`  | the entire config, as a JSON string                         |
| `GAME_BOTS_CONFIG`         | absolute path to an alternate config file                   |
| `GAME_BOTS_LOG_STATES`     | set to `1` to log every bot state transition to stdout      |

## Technical overview

TypeScript Node.js process. All bots run on a single shared
`setInterval` tick (default 100 ms). On each tick the scheduler
drains inbound events for every connected bot (snapshots, deaths,
chat), runs each bot's state transition ladder, and flushes the
outbound action queue (steer, split, respawn, chat).

Each bot subscribes with capability set
`{presence, steer, act, chat}`, sends its user-agent as
`game-bots/<version>`, and reuses an opaque `clientId` across
reconnects so one bot's sessions stay correlated in the game
server's admin audit.

State machine, nine states, transition ladder checked top-down
each tick:

```
DISCONNECTED → CONNECTING → SPAWNING (invuln drift) →
  cowardice gate → FLEE → HUNT (maybe SPLIT_ATTACK) →
    FEED → WANDER
```

`SPAWNING` is a sticky overlay driven by the server-reported
invulnerability timer, not the priority ladder: it blocks splits
and biases toward offensive drift. The cowardice gate consults the
cowardice knob before the regular flee/hunt branches, cleanly
separating "how I behave when winning" (aggressiveness,
splitWillingness) from "how I behave when losing" (cowardice).

## Bot lifecycle

Three events can end a bot's game session:

- **Death** (`died`): the bot's state transitions to `DEAD` and it
  immediately requests respawn; subsequent `Tick.self` resumes the
  normal ladder in `SPAWNING`. Retries are rate-limited to 1 Hz so
  a lost respawn frame recovers without resetting the player ten
  times a second.
- **Kick** or **disconnect**: the socket closes, the bot transitions
  to `DISCONNECTED`, and a new session is scheduled with exponential
  backoff (`500 ms, 1 s, 2 s, 4 s cap`) plus jitter.
- **Shutdown**: on `SIGINT` or `SIGTERM` the scheduler stops and
  every bot disconnects cleanly.

Bots never give up: a server that stays down forever is retried
indefinitely at the 4 s backoff cap. A server that TCP-accepts but
never welcomes is reconnected after a 5 s welcome watchdog so the
backoff ladder actually gets a chance to apply.

## Running

Node 22+. Point at a running `cells-game` server on
`http://127.0.0.1:3000`:

```bash
npm install
cp config.example.json config.json      # edit if needed
npm start
```

Or in watch mode during development:

```bash
npm run dev
```

## License

MIT.
