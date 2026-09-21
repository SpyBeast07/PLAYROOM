# Mafia Engine Contract

This document describes the **contract, state model, and implemented rules** of
the Mafia engine (`backend/src/games/mafia/`). It is the layer that the three
presentation modes (pass-the-phone, own-mobile, narrator) share. Gameplay rules
live in [`mafia-spec.md`](./mafia-spec.md), which this contract mirrors.

Status: **Phase 10B — full engine implemented.** `dispatch` validates and
applies every action; nights, votes, and win conditions are resolved; derived
per-player views are filled. All 105 backend tests pass (`bun test`) and
`tsc --noEmit` is clean. See the dev log in §12 for what changed since 10A.

---

## 1. Engine responsibility

The engine is a **pure, deterministic, synchronous state machine** for one Mafia
game. It:

- owns the authoritative game state (players, roles, phase, night inputs, votes, timeline);
- validates and applies actions (roles, phases, targets, submission status, authority);
- resolves nights and votes; checks win conditions; emits domain events.

It knows **nothing** about Hono, HTTP, WebSockets, Bun, SvelteKit,
RoomManager, ConnectionManager, databases, auth, cookies, sessions, or any
transport/device concept. There are no repository/service/bus/DI abstractions.

Engine files: `src/games/mafia/types.ts`, `src/games/mafia/constants.ts`,
`src/games/mafia/mafia-engine.ts`.

## 2. State model

`MafiaGameState` is a **discriminated union keyed by `phase`** (8 states:

```
LOBBY → ROLE_REVEAL → NIGHT → MORNING → DISCUSSION → VOTING → VOTE_RESULT
        (GAME_OVER reachable from MORNING, VOTE_RESULT, and NIGHT-resolution)
```

Phase-specific data only exists on its phase:

| Phase         | Extra state                                              |
|---------------|----------------------------------------------------------|
| LOBBY         | roster (`players`, `ready`), empty `roles`               |
| ROLE_REVEAL   | `roles`, `roleSeen` map                                  |
| NIGHT         | `actingMafiaId`, `nightActions`                          |
| MORNING       | — (outcome lives on the shared `lastResolvedNight`)      |
| DISCUSSION    | —                                                        |
| VOTING        | `votes` (voter → target)                                 |
| VOTE_RESULT   | `votes`, `elimination`                                   |
| GAME_OVER     | `winner`                                                 |

Game-level facts (all phases): `gameId`, `mode` (informational only — the
engine never branches on mode), `players`, `timeline`, `lastResolvedNight`
(the most recent atomic night outcome, carried forward so private results and
the Doctor repeat-guard stay derivable), and `lastActingMafiaId` (the acting
Mafia survives night boundaries for carry-over). Roles never travel on the
player objects; they live in the `roles` map, immutable after `START_GAME`,
revealed wholesale only at GAME_OVER.

Night inputs are collected in the fixed order **Mafia → Doctor → Detective**
(`NIGHT_ACTION_ORDER`). Each slot is modeled as a state
(`NOT_ACTED | SUBMITTED | PASSED | SKIPPED`); "invalid" input never becomes
state — it is rejected at dispatch. Missing-but-resolved input (`disconnect`,
`timeout`, `force-resolve`) is `SKIPPED`; the Doctor's deliberate skip is
`PASSED`.

Votes are stored as `Record<voterId, targetId>` (only voters who submitted) and
the tally is **derived at resolution**, never stored — this is the model spec
§10 requires so ties and plurality fall out deterministically.

## 3. Public / private / narrator boundaries

Four layers, kept apart by **distinct view types** (no shared "everything"
object is ever handed out):

- **Internal** (`MafiaGameState`, via `getState()`): full truth. Never shipped
  to any client; server/narrator only.
- **Public** (`MafiaPublicState`, via `getPublicState()`): identical for all.
  Phase, night number, public players (id/name/alive/ready), `morningDeaths`,
  aggregate vote progress (`cast`/`total`, not who voted for whom), outcome of
  an elimination (id only — role is never revealed, spec 8.6), winner at
  GAME_OVER. **No roles, no night inputs, no votes map, no verdicts.**
- **Player private** (`MafiaPlayerState`, via `getPlayerState(id)`): one
  player's own role, readiness, role-seen, their own night slot, their own
  private night result (`INVESTIGATION` verdict or `HEAL` outcome), their own
  vote, and a derived `availableActions` list (what the player may validly
  submit right now, e.g. `READY` in LOBBY, `ROLE_SEEN` in ROLE_REVEAL,
  `MAFIA_KILL`/`DOCTOR_SAVE`/`DETECTIVE_INVESTIGATE` in NIGHT before submitting,
  `CAST_VOTE` in VOTING before voting).
- **Narrator** (`MafiaNarratorState`, via `getNarratorState()`): the public
  view **plus** full hidden truth — all roles, acting Mafia, all night inputs,
  last resolution, the live votes map, readiness/role-seen, timeline. Mode C only.

View derivations are read-only mappings of internal state; they never mutate.
The engine emits **domain events** (`MafiaEvent`) that carry hidden facts
(e.g. `GAME_STARTED` includes the full role map). Events are internal — the
adapter must map them through these three views before any send.

## 4. Action model

`MafiaAction` is a discriminated union (18 types). Phases where each is valid
(fixed by spec §6):

| Action                   | Phase                  |
|--------------------------|------------------------|
| JOIN, LEAVE, READY, UNREADY | LOBBY              |
| START_GAME               | LOBBY                  |
| ROLE_SEEN                | ROLE_REVEAL            |
| BEGIN_NIGHT              | ROLE_REVEAL            |
| MAFIA_KILL, DOCTOR_SAVE, DETECTIVE_INVESTIGATE | NIGHT |
| RESOLVE_NIGHT            | NIGHT                  |
| START_DISCUSSION         | MORNING                |
| START_VOTING             | DISCUSSION             |
| CAST_VOTE                | VOTING                 |
| END_VOTING               | VOTING                 |
| ADVANCE_PHASE            | ROLE_REVEAL/NIGHT/MORNING/DISCUSSION/VOTING/VOTE_RESULT (LOBBY = no-op) |
| PLAY_AGAIN               | GAME_OVER              |
| PLAYER_UNAVAILABLE       | NIGHT (no-op elsewhere) |

`CAST_VOTE` carries both `voterId` and `targetId` so the narrator can record
another player's spoken vote; a `PLAYER` actor must have `voterId ===
actor.playerId`. `DOCTOR_SAVE` accepts a `null` target for a deliberate pass.
`PLAYER_UNAVAILABLE` is the single choke-point where adapters report
disconnect/timeout so the engine marks the player's pending night input
`SKIPPED` (spec 6.14, 9.3).

There is **no early voting**: `CAST_VOTE` outside VOTING is rejected
(`INVALID_PHASE`), and there is **no `ACKNOWLEDGE`** — `ADVANCE_PHASE` is the
single canonical transition action (review decision), including the
`VOTE_RESULT → NIGHT` step.

## 5. Actor / authority model

Every action carries `ActionActor`:

- `{ type: "PLAYER"; playerId }` — the player; validated by identity/role/life/submission.
- `{ type: "NARRATOR" }` — the game operator. Records night actions and spoken
  votes on players' behalf (role checks bypassed, target/life checks kept),
  and drives phase control.
- `{ type: "SYSTEM" }` — the engine/server for automatic transitions.

**There is no `isHost` anywhere.** The host is a room concept; the engine never
sees it. In Mode B the **adapter** decides whether a sender (e.g. the room
host) may act as the advance authority and maps him to the `NARRATOR` actor
for lobby/phase control — exactly the adapter boundary in spec §7.2/"host has
no extra engine authority".

## 6. Phase-transition authority

| Transition             | Who may trigger                                    |
|------------------------|----------------------------------------------------|
| LOBBY → ROLE_REVEAL    | NARRATOR or SYSTEM (`START_GAME`); precondition: 4–20 players, all ready |
| ROLE_REVEAL → NIGHT    | NARRATOR or SYSTEM (`BEGIN_NIGHT`; SYSTEM auto once all `ROLE_SEEN`) |
| NIGHT → MORNING        | NARRATOR or SYSTEM (`RESOLVE_NIGHT`, atomic resolution; `ADVANCE_PHASE` force-resolves) |
| MORNING → DISCUSSION   | NARRATOR or SYSTEM (`START_DISCUSSION` / `ADVANCE_PHASE`) |
| DISCUSSION → VOTING    | NARRATOR or SYSTEM (`START_VOTING` / `ADVANCE_PHASE`) |
| VOTING → VOTE_RESULT   | NARRATOR or SYSTEM (`END_VOTING`; SYSTEM auto once all living voted) |
| VOTE_RESULT → NIGHT    | NARRATOR or SYSTEM (`ADVANCE_PHASE` only — canonical) |
| → GAME_OVER            | SYSTEM only (win check immediately after night resolution and after vote elimination, spec 8.3) |
| GAME_OVER → LOBBY      | NARRATOR or SYSTEM (`PLAY_AGAIN`; keeps the roster, resets game state) |

`ADVANCE_PHASE` is the meta-action that fast-forwards the current phase to its
terminal transition (spec 6.14): in NIGHT it force-resolves (marking every
pending slot `SKIPPED`), in ROLE_REVEAL/VOTE_RESULT it enters the next night,
in MORNING/DISCUSSION/VOTING it advances the serial day, and in LOBBY it is a
permitted no-op. Players never move the phase; they only submit role actions
and votes. Narrator-mode control is the narrator sending `NARRATOR`-actor
actions; the same actions are what a Mode A device or a Mode B adapter-verified
host request maps to.

## 7. Result / error contract

`dispatch` returns:

```ts
type MafiaEngineResult =
  | { success: true; stateChanged: boolean; events: MafiaEvent[] }
  | { success: false; error: { code: MafiaErrorCode; message: string } };
```

`stateChanged` is false for valid-but-no-op actions. Errors are machine-readable
codes (not free strings):

```
INVALID_ACTION, INVALID_PHASE, INVALID_ACTOR, PLAYER_NOT_FOUND, PLAYER_DEAD,
INVALID_TARGET, ACTION_ALREADY_SUBMITTED, GAME_OVER, GAME_FULL,
PLAYER_ALREADY_JOINED, NAME_TAKEN, INVALID_PLAYER_NAME, NOT_ENOUGH_PLAYERS,
NOT_ALL_READY, DOCTOR_REPEAT_GUARD, MISSING_REQUIRED_ACTION
```

Rejected actions never change state; the sender gets the error. `NOT_IMPLEMENTED`
and `ACKNOWLEDGE` were removed in Phase 10B.

## 8. Events

Successful dispatches return `MafiaEvent[]` (internal domain facts):
`PHASE_CHANGED`, `PLAYER_JOINED/LEFT/READY/UNREADY`, `GAME_STARTED` (includes
roles map!), `ROLE_SEEN`, `NIGHT_STARTED` (includes acting Mafia!), 
`NIGHT_ACTION_RECORDED`, `NIGHT_RESOLVED`, `DISCUSSION_STARTED`,
`VOTING_STARTED`, `VOTE_CAST`, `VOTING_RESOLVED`, `PLAYER_ELIMINATED`,
`PLAYER_UNAVAILABLE`, `GAME_OVER`. They carry hidden info and are **not**
transport messages. Adapters translate through the three views.

There is no event bus — events are just data a dispatch returns.

## 9. Engine interface

```ts
interface MafiaEngine {
  getState(): MafiaGameState;
  dispatch(action: MafiaAction): MafiaEngineResult;
  getPublicState(): MafiaPublicState;
  getPlayerState(playerId: PlayerId): MafiaPlayerState;   // throws PLAYER_NOT_FOUND
  getNarratorState(): MafiaNarratorState;
}
createMafiaGame({ gameId?, mode, players?, random? }): MafiaEngine
```

Properties: deterministic; synchronous; side-effect free outside its own state;
no network/persistence knowledge; no framework imports. `players` lets Modes A/C
seed the roster; Mode B starts empty and JOINs. `random` is the one injection
point (uniform `[0,1)` generator): the engine uses it for role shuffling
(Fisher–Yates), and tests supply a seeded PRNG (mulberry32) for repeatable role
draws.

## 10. Core rule implementation notes

- **Role assignment** (`START_GAME`): slot counts come from
  `roleCountsForPlayerCount` (spec §4) and are shuffled across the roster with
  the injected RNG. `GAME_STARTED` carries the full role map — highly
  sensitive, never raw-broadcast (adapter routes it through the views).
- **Night resolution**: the kill is mandatory (`RESOLVE_NIGHT` without a
  submitted/skipped kill → `MISSING_REQUIRED_ACTION`; `ADVANCE_PHASE`
  force-resolves by marking pending slots `SKIPPED`, emitting
  `PLAYER_UNAVAILABLE`). A submitted kill lands **unless** the Doctor is alive
  and saved the exact target (`saveApplied`); a deliberate pass (`DOCTOR_SAVE
  targetId=null`) clears the repeat guard. The Detective's verdict is
  `role === "MAFIA"`. Death and win-precedence: Mafia eliminated → TOWN;
  otherwise `mafia >= nonMafia` → MAFIA, checked at the two allowed moments.
- **Acting Mafia**: the role holder carries over night to night while alive;
  if dead it falls back to the first living Mafia by roster order.
- **Voting**: plurality eliminates the top vote-getter; a top-count tie or zero votes
  eliminates nobody (`tie` distinguishes them). Voting auto-ends (SYSTEM) once
  every living player has voted.
- **PLAY_AGAIN**: keeps the whole roster; resets roles, readiness, aliveness,
  night number, timeline, `lastResolvedNight`, and `lastActingMafiaId`.

## 11. Adapters vs. engine

The engine owns: rules, phase machine, validation, resolutions, win checks,
hidden-state views. **Adapters own:** mapping room/device/connection events to
`MafiaAction`, deciding which sender maps to which actor (host → NARRATOR for
lobby control), translating `MafiaEvent[]`/views into public broadcasts or
targeted sends, reconnection/resume bookkeeping, timers, and the three UIs.
If an action should not be externally dispatchable in a given mode (e.g.
`READY` never used in pass-the-phone), that is an adapter decision — the engine
still accepts the action.

## 12. Test coverage

- `src/games/mafia/mafia-engine.test.ts` — contract: constants/limits exahaust
  the universe, view boundaries, engine shape, well-formed vs rejected actions.
- `src/games/mafia/mafia-rules.test.ts` — rules: lobby lifecycle, deterministic
  role draws, role reveal, night submission & resolution (save, pass, dead
  doctor, repeat guard), acting-Mafia carry-over, voting (early-vote rejection,
  aggregate-only publicity, ties, plurality, auto-end), win detection (town by
  vote, mafia by outnumbering), `ADVANCE_PHASE`/force-resolve, `PLAY_AGAIN`,
  `PLAYER_UNAVAILABLE`, derived `availableActions`/`ownPrivateNightResult`, and
  the public/private/narrator information boundaries.

Run with `bun test`; typecheck with `bun run typecheck`.