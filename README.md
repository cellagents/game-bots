# game-bots

Headless TypeScript process running N deterministic bots that play
[cells-game](https://github.com/cellagents/cells-game) over the
[`@cellagents/game-protocol`](https://github.com/cellagents/game-protocol)
v1.0 wire format.

All bots run on a single shared heartbeat tick (default 100 ms).
Each bot has its own state machine and three personality knobs:

- `aggressiveness` ∈ [0, 1] : how hard it chases prey when winning.
- `splitWillingness` ∈ [0, 1] : how often it splits (attack and escape).
- `cowardice` ∈ [0, 1] : dominates when the bot is smaller than nearby enemies.

See [`PLAN.md`](./PLAN.md) for the full design.

## Status

Pre-0.1. Milestones 1 (lifecycle), 2 (movement + feeding),
3 (combat + personality), and 4 (resilience hardening) are in
place. The full state machine is live: bots `FLEE` from threats,
`HUNT` smaller prey, and may enter `SPLIT_ATTACK` to close the
gap when the maths work out. Reconnect with exponential backoff
handles a game that goes down and comes back; the DEAD state
latches off on each new session so a dropped socket during
respawn can't permanently freeze a bot; live `rulesChanged` and
`actionsChanged` events keep the welcome bag fresh.

Milestone 5 (release polish, example configs, README) is next.

Bot names must match the protocol-1.0 name regex
`/^[\p{L}\p{N}_]{1,25}$/u` (letters, digits, underscore; no
hyphens or spaces); the config loader rejects anything else at
startup so bots never run into a silent subscribe-reject loop.

Set `GAME_BOTS_LOG_STATES=1` to log every state transition to
stdout; useful for debugging a specific bot's decision flow
without rebuilding.

## Running

Requires Node 22+. From a clean checkout:

```bash
npm install
cp config.example.json config.json   # edit as needed
npm start
```

The loader searches, in order: `$GAME_BOTS_CONFIG`,
`./config.json`, `./config.example.json`. The first file that
exists wins; `config.json` is gitignored.

## Config shape

```jsonc
{
  "heartbeatMs": 100,
  "remotes": [
    {
      "name": "local",
      "url": "http://localhost:3000",
      "bots": [
        { "name": "greedy-1", "aggressiveness": 0.8, "splitWillingness": 0.6, "cowardice": 0.2 },
        { "name": "turtle-1", "aggressiveness": 0.2, "splitWillingness": 0.1, "cowardice": 0.9 }
      ]
    }
  ]
}
```

Bots are listed one by one on purpose: operators tune individuals,
and replays stay identifiable by name. Add more entries to the
`bots` array to run more bots, or more `remotes` to spread them
across game servers.

## License

MIT.
