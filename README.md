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

Pre-0.1. Milestone 1 (scaffold + lifecycle: connect, subscribe,
respawn, reconnect, chat join announcement) is in place. States
`WANDER`/`FEED`/`HUNT`/`FLEE`/`SPLIT_ATTACK` are declared but not
yet wired to decisions; the bot currently stands still and drifts.

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
