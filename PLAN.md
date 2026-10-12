# game-bots: implementation plan

Headless TypeScript process that connects N bots to one or more cells-game
remotes over the `@cellagents/game-protocol` v1.0 wire format. All bots run
on a single shared heartbeat tick, each with its own state machine and
tuning knobs.

## 1. Scope and non-goals

**In scope (v0.1):**
- Node + TypeScript, single-process, single-threaded event loop.
- Load a JSON config, spin up the configured bot instances, keep them playing indefinitely.
- One state machine, three per-bot tuning knobs: `aggressiveness`, `splitWillingness`, `cowardice`.
- Reconnect on kick/disconnect, respawn on death, no human intervention required.

**Out of scope (deferred):**
- Multi-process / worker-thread scaling: single thread is enough at 100 ms
  per tick for dozens of bots. Revisit only if the tick budget blows.
- LLM-driven bots: this repo is the deterministic baseline. LLM agents
  live in cells-mcp and consume the same protocol separately.
- Metrics server, web dashboard, replay recorder: nice-to-have, not v0.1.
- `REGROUP` state (post-split merge): fold into `WANDER` with a merge bias until it earns its keep.

## 2. Dependencies

- `@cellagents/game-protocol` (wire format, event types, capability flags).
- `socket.io-client` (matches cells-game's transport).
- A tiny arg/env loader. No framework.
- `vitest` or `node:test` for unit tests on the decision functions.

No React, no bundler, no build pipeline beyond `tsc`.

## 3. Repo layout

```
game-bots/
  package.json
  tsconfig.json
  config.example.json
  README.md
  src/
    index.ts                 # entrypoint: load config, start scheduler
    config.ts                # config schema + loader + env overrides
    scheduler.ts             # the single 100 ms heartbeat loop
    bot.ts                   # Bot class: state, world snapshot, action queue
    world.ts                 # view of latest server snapshot per bot
    states/
      index.ts               # state enum + priority ladder
      disconnected.ts
      connecting.ts
      spawning.ts
      dead.ts
      wander.ts
      feed.ts
      hunt.ts
      flee.ts
      splitAttack.ts
    decisions/
      threats.ts             # threat/prey detection, mass-ratio math
      geometry.ts             # vector helpers, viewport-local coords
      personality.ts          # knob -> threshold functions
    transport/
      connection.ts          # socket wrapper: connect, subscribe, reconnect
      events.ts               # typed event handlers over game-protocol wire
  test/
    personality.test.ts
    states.test.ts
```

## 4. Config shape

Single JSON file loaded from `$GAME_BOTS_CONFIG` → `./config.json` →
`./config.example.json` (first that exists wins, matching cells-game's loader).

```jsonc
{
  "heartbeatMs": 100,
  "remotes": [
    {
      "name": "local",
      "url": "http://localhost:3000",
      "bots": [
        {
          "name": "greedy-1",
          "aggressiveness": 0.8,
          "splitWillingness": 0.6,
          "cowardice": 0.2
        },
        {
          "name": "turtle-1",
          "aggressiveness": 0.2,
          "splitWillingness": 0.1,
          "cowardice": 0.9
        }
      ]
    }
  ]
}
```

- `heartbeatMs`: scheduler tick period. Default 100.
- `remotes[].bots[]`: one entry per bot instance; the array length is the bot count. Explicit per-bot config beats a `count` field: operators tune individuals, replays stay identifiable by name.
- Each bot has three knobs in `[0, 1]`:
  - `aggressiveness`: how willing to pursue prey and tolerate close threats.
  - `splitWillingness`: how often `SPLIT_ATTACK` fires when `HUNT` thinks a split would land the kill.
  - `cowardice`: dominates decisions when the bot is smaller than nearby enemies (see section 6).

Validation: all three knobs clamp to `[0, 1]` at load time with a warning;
unknown fields in the config error out loudly so typos don't fail silently.

## 5. State machine

Nine states, same shape as the earlier proposal:

- `DISCONNECTED` → schedule reconnect, back off with jitter.
- `CONNECTING` → socket open, subscribe sent, waiting for welcome + first snapshot.
- `SPAWNING` → in the 3 s invuln window; splits deferred.
- `DEAD` → `died` received, request respawn.
- `WANDER` → fallback alive state, drift toward food gradients.
- `FEED` → food in easy reach, no immediate threat.
- `HUNT` → smaller player in viewport, pursue.
- `FLEE` → larger player in danger radius, run.
- `SPLIT_ATTACK` → transient 1-3 tick state, emits split then falls back to `HUNT`/`WANDER`.

### Transition priority (checked top-down each tick)

1. Connection lost → `DISCONNECTED`
2. `died` event received → `DEAD`
3. **Cowardice gate**: if any enemy within viewport has `mass > self.mass`,
   the cowardice branch runs first (section 6).
4. Threat in danger radius → `FLEE`
5. Prey in opportunity radius → `HUNT` (or `SPLIT_ATTACK` if conditions met)
6. Food in easy reach → `FEED`
7. Otherwise → `WANDER`

`SPAWNING` is a sticky overlay driven by a timer, not the priority ladder: it blocks splits and biases toward offensive moves until the invuln expires.

## 6. Personality knobs and how they plug in

None of the knobs spawn new states; they parametrise thresholds inside existing ones.

### `aggressiveness` ∈ [0, 1]

Baseline personality. Takes effect when the bot is **larger than or comparable to** nearby threats.

- **Hunt threshold**: minimum mass ratio to pursue prey.
  `huntRatio = lerp(1.5, 1.15, aggressiveness)` (timid bots need a 1.5x advantage, aggressive bots pursue at 1.15x).
- **Pursuit distance**: max world-units to chase prey.
  `pursuitRange = lerp(300, 900, aggressiveness)`.
- **Wander bias**: timid bots bias toward map edges and sparse regions;
  aggressive bots bias toward center and dense clusters.
- **Flee danger radius** (only when **not** triggered by cowardice): a slight
  nudge, aggressive bots let threats get a bit closer.

### `splitWillingness` ∈ [0, 1]

Separate from aggressiveness so an operator can configure "aggressive but
never splits" (hunts hard, never fragments) or "cautious but will split to
escape" independently.

- **Attack split probability**: inside `HUNT`, when a split would close the
  gap to prey, enter `SPLIT_ATTACK` with probability proportional to this knob.
  `pSplit = splitWillingness * confidenceFactor` where `confidenceFactor`
  is 1.0 when the resulting halves still outweigh the prey, dropping toward 0 as parity approaches.
- **Escape split probability**: inside `FLEE`, when cornered against an edge,
  split to burst away. Same multiplier.
- **Hard gates**: never split in `SPAWNING` (wastes invuln), never split if
  cell count is already at `limitSplit`, never split below `defaultPlayerMass * 2`.

### `cowardice` ∈ [0, 1]

**Dominates decision-making when the bot is smaller than nearby enemies.** Section 5's priority ladder consults it before the regular `FLEE`/`HUNT`/`FEED`/`WANDER` branches.

Trigger: at least one enemy inside viewport with `mass > self.mass`.

When triggered:
- **Dynamic flee radius**: the bigger-than-us enemies induce a repulsion field. The flee radius scales with cowardice:
  `fleeRadius = lerp(threatCellRadius * 1.5, viewportDiagonal, cowardice)`.
  A `cowardice = 1.0` bot flees from any larger enemy anywhere in viewport; a `cowardice = 0.0` bot only reacts when the enemy is almost on top of it.
- **Decision override**: while any enemy is inside `fleeRadius`, the state
  machine is pinned to `FLEE`. `HUNT` of smaller prey is forbidden even if
  present (cowardice beats greed in a mixed situation).
- **Flee direction weighting**: cowardice also affects path choice.
  High-cowardice bots pick the direction that maximises distance from
  **all** larger enemies simultaneously (weighted sum of repulsion vectors);
  low-cowardice bots run straight away from the single closest.
- **Food opportunism**: while fleeing, cowardice `< 0.5` bots will still
  grab pellets that happen to lie along the flee vector; `>= 0.5` bots
  single-mindedly maximise distance and ignore pellets.

### Interaction summary

| Situation | Dominant knob |
|---|---|
| Bot bigger than all visible enemies | `aggressiveness` + `splitWillingness` |
| Bot smaller than at least one visible enemy | `cowardice` (gates everything else) |
| No enemies in viewport | `aggressiveness` (biases `WANDER`/`FEED`) |

This cleanly separates "how I behave when winning" (aggressiveness,
splitWillingness) from "how I behave when losing" (cowardice).

## 7. Scheduler

Single `setInterval(tick, heartbeatMs)` on the main loop.

Per tick, in order:
1. Drain inbound events for every connected bot (snapshots, deaths, chat).
2. For each bot, run `bot.decide()`:
   - Update world view from latest snapshot.
   - Run transition ladder (section 5) to pick current state.
   - State's `tick()` function emits 0..N actions into the bot's outbound queue.
3. Flush the outbound queue for every bot (steer, split, eject, respawn, chat).

A bot can queue multiple actions on a single tick: e.g. `FLEE` can emit
`steer(awayVector)` and `split(awayVector)` in the same tick. The server
is the authority on whether both land in the same physics frame.

Backpressure: if `tick()` runtime creeps past `heartbeatMs * 0.5` on average
over 10 s, log a warning. Don't skip ticks; just surface the saturation.

## 8. Lifecycle

- **Startup**: load config, construct `Bot` instances, open sockets concurrently, start the heartbeat.
- **Reconnect**: `DISCONNECTED` state schedules a reconnect with exponential backoff + jitter (500 ms, 1 s, 2 s, 4 s cap).
- **Kick / disconnect mid-game**: bot transitions to `DISCONNECTED`; a fresh session is established and it rejoins under the same name.
- **Death**: bot transitions to `DEAD`, sends respawn action, re-enters `SPAWNING` on the server's spawn confirmation.
- **Shutdown**: on SIGINT, send clean disconnect for each bot, then exit.

## 9. Testing

- Unit-test the pure decision functions in `decisions/` with hand-crafted
  world snapshots: threat/prey selection, flee vector math, cowardice override.
- Unit-test the state transition ladder with synthetic world views to lock
  in the "cowardice beats hunt" rule and the invuln-blocks-split rule.
- End-to-end smoke: `npm run smoke` spins up a local cells-game, launches
  the example config, asserts all bots reach `SPAWNING` within 5 s and
  stay alive-or-respawning for 60 s. Lives behind an env flag so CI without a game process still passes.

## 10. Milestones

1. **Scaffold**: package.json, tsconfig, config loader, scheduler skeleton. Bots connect, subscribe, idle. (No decisions, no actions.)
2. **Movement**: `WANDER` + `FEED` wired. Bots eat food, nothing else.
3. **Combat**: `HUNT`, `FLEE`, `SPLIT_ATTACK`, cowardice override. Full state machine live.
4. **Resilience**: reconnect, respawn, backoff. Multi-remote support.
5. **Polish**: README, example configs, smoke test, first tagged release `v0.1.0`.

## 11. Open questions

- Chat usage: should bots acknowledge each other via `chat` for emergent.
  behaviour, or stay mute? Default v0.1: mute, publish on an opt-in config flag later.
    Bots will announce their join with 'Hello, I am <bot name>!'.
- Shared randomness seed: deterministic replays would need a seeded RNG per bot. Nice-to-have, not v0.1.
    Not in scope now.
- Metrics: what to expose and where. Punt to a later milestone; `console.log` with structured JSON lines is enough for v0.1.
    We will collect cell state + next decision with each heartbeat for each bot into file-based sql db, similarly to chat - but presently we do not implement this yet, so metrics collection function exists but it has no backend.
