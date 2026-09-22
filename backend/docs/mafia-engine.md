# Mafia Engine Contract

This document describes the **contract, state model, and implemented rules** of
the Mafia engine (`backend/src/games/mafia/`). It is the layer that the three
presentation modes (pass-the-phone, own-mobile, narrator) share. Gameplay rules
live in [`mafia-spec.md`](./mafia-spec.md), which this contract mirrors.

Status: **Phase 13 — narrator (Mode C) adapter.** `dispatch` validates
and applies every action; nights, votes, and win conditions are resolved;
derived per-player views are filled; the public view additionally reveals the
full role assignment at GAME_OVER (spec §8.5). Force-resolved nights now
attribute `PLAYER_UNAVAILABLE` to each actually-pending player. `NarratorController`
(`src/games/mafia/adapters/narrator/`) drives a physical game from one
privileged device: it records players' spoken night actions and votes as
`NARRATOR`, reads only `getNarratorState()` (never raw state), and owns no rules
or handoff choreography. Its state is intentionally privileged and remains
local-only — nothing in it reaches the multiplayer player channels. All 230
backend tests pass (`bun test`) and `tsc --noEmit` is clean. Mode C contract in
§17; Mode A in §16; audit notes in §13; session contract in §14.

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
  GAME_OVER, and at GAME_OVER only the full role assignment (`revealedRoles`,
  spec 8.5 — roles are public precisely there and nowhere else). **No roles, no
  night inputs, no votes map, no verdicts before the game ends.**
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
  force-resolves by marking pending slots `SKIPPED`, emitting one
  `PLAYER_UNAVAILABLE` per pending slot's owner — kill → acting Mafia, save →
  Doctor, investigate → Detective; already-submitted inputs are kept). A
  submitted kill lands **unless** the Doctor is alive and saved the exact
  target (`saveApplied`); a deliberate pass (`DOCTOR_SAVE targetId=null`)
  clears the repeat guard. The Detective's verdict is `role === "MAFIA"`.
  Death and win-precedence: Mafia eliminated → TOWN; otherwise
  `mafia >= nonMafia` → MAFIA, checked at the two allowed moments.
- **Acting Mafia**: the role holder carries over night to night while alive;
  if dead it falls back to the first living Mafia by roster order. By
  carry-over this is always the roster-first *living* Mafia at the start of a
  night, so the narrator's MAFIA_KILL is always attributed to `actingMafiaId`.
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
  the public/private/narrator information boundaries. Phase 10C adds: per-slot
  force-resolve attribution, GAME_OVER `revealedRoles`, narrator night-action
  recording attribution, self-investigation, mafia team-kill legality, dead
  players receiving no action prompts, per-phase reconnect/resume coverage, and
  the events-vs-views hidden-info boundary.
- `src/games/mafia/adapters/pass-phone/pass-phone-controller.test.ts` — Phase 12
  Mode A adapter: lobby/roster lifecycle, role-reveal flow, night action flow
  (target rejection, doctor repeat guard, `endNightNow` force-resolve), voting
  flow (one voter at a time, final-vote auto-end, `endVoting` seal), full games
  to GAME_OVER for both winners, play-again/reset, and a hidden-information
  audit that walks every reachable view and forbids engine-internal fields.
- `src/games/mafia/adapters/narrator/narrator-controller.test.ts` — Phase 13
  Mode C adapter: lobby/start and the reveal screen, begin-night, recorded night
  actions (kill/save-pass/investigate, dead/self/unknown targets, no-living-role
  holder, resolve-without-kill), morning outcome + verdict, discussion/voting
  phase guards, recorded spoken votes (auto-end, dead/unknown/duplicate voters,
  tie, sealed partial round), full games to GAME_OVER for both winners with the
  full reveal, and play-again/reset.

Run with `bun test`; typecheck with `bun run typecheck`.

## 13. Phase 10C audit notes

Pre-integration audit of the engine against `mafia-spec.md` (state machine,
action authority, info security, reconnect, disconnects, ID mapping,
determinism, edge cases). Findings and resolutions:

- **GAME_OVER did not reveal every role.** Spec 8.5/7.2 require the full role
  assignment to be public at game end. Added `MafiaPublicState.revealedRoles`,
  `null` except at GAME_OVER where it equals `roles`. Private per-player views
  and the narrator view were already complete. This is the one contract-shape
  change; adapters should render public `revealedRoles` and the `winner` on the
  end-of-game screen (the compact summary in spec 8.5 is the events/timeline
  the adapter already broadcast, and `getNarratorState().timeline` for Mode C).
- **Force-resolve mis-attributed `PLAYER_UNAVAILABLE`.** `ADVANCE_PHASE` in
  NIGHT always reported the acting Mafia as timed out even when they had acted.
  Now one event is emitted per genuinely-pending slot owner (acting Mafia,
  Doctor, Detective as applicable); already-submitted inputs stay `SUBMITTED`.
- **Verified, no change needed:** the acting Mafia is invariantly the
  roster-first living Mafia (carry-over), so narrator/system recording of
  MAFIA_KILL is always attributed correctly; self-vote is allowed (spec 8.3,
  10); detective self-investigation is permitted and deterministically returns
  "not Mafia" (spec is silent — engine does not invent a ban); Mafia may target
  a Mafia teammate (spec forbids only self and dead targets); a disconnected
  acting Mafia means "no kill" that night (spec 6.14/9.3); `PLAYER_UNAVAILABLE`
  is a NIGHT-only choke-point and matches spec 6.14/9.3; rolls of `roles` are
  the only use of randomness (`random` is the single injection point);
  reconnecting clients can rebuild phase, role, role-seen, pending action,
  private results, own vote, availability, deaths, and eliminations from the
  three views (no second identity system; room player IDs map 1:1 to engine
  player IDs).

## 14. Phase 11A session contract (room → engine binding)

`src/games/mafia/mafia-session.ts` is the **only** layer that knows both the
room system (`src/rooms/room-manager.ts`) and the engine. It exists to answer
"which game belongs to which room" and to keep both sides' lifecycles aligned —
not to re-specify gameplay.

Ownership split:

- **RoomManager stays authoritative** for room existence, membership, names,
  host, capacity, and join/leave. It additionally exposes one deliberate
  mutation, `setStatus(roomCode, status)` (`"waiting" | "playing"`), which is
  the single lock: when a game enters its first phase the session sets
  `"playing"` (new joins rejected with `ROOM_STARTED`), and when a game ends or
  is destroyed it sets `"waiting"`. There is deliberately no second
  "room locked" concept anywhere.
- **The session owns** one engine per normalized room code, the room-player →
  engine-player mapping (ids are passed through unchanged; the engine's
  name-uniqueness invariant is checked up front, yielding `NAME_TAKEN` where the
  room would allow duplicates), and room-status transitions driven purely by the
  engine's own `PHASE_CHANGED` events.
- **The engine stays transport- and room-agnostic**; the session never mutates
  room membership and never consults `isHost`.

Key lifecycle decisions:

- **Creation** (`createGame`): validates the room exists, has `4..20` players,
  unique names, then constructs the engine in LOBBY seeded from the room's
  current players. A second game for the same room throws `GAME_ALREADY_EXISTS`.
- **Roster reconciliation** (`syncRoster` / every handle op): only while the
  engine is in LOBBY. Players removed from the room leave the game lobby
  (engine clears readiness); players added join it. Removal runs before
  addition so a rename never trips name-uniqueness mid-sync. Once the game has
  started the sync is a no-op: **room membership ≠ game participation** —
  leaving the room does not remove you from the game; unavailability is
  reported via `PLAYER_UNAVAILABLE` by the transport (a later phase).
- **Lock/unlock**: a successful dispatch transitioning LOBBY→ROLE_REVEAL locks
  the room (`"playing"`); GAME_OVER→LOBBY (`PLAY_AGAIN`) or `removeGame`
  releases it (`"waiting"`). Lock application is best-effort: a store failure
  never turns a valid dispatch into a failure.
- **Deletion**: a game never outlives its room — the first access to a session
  whose room is gone destroys it (lazy cleanup, no timers/TTL). `removeGame`
  destroys the game and releases the lock if the room still exists, returning
  whether anything was removed. Stale handles (from a removed/recreated game)
  throw `GAME_NOT_FOUND`; a `getGame` cache miss returns `undefined`.
- **Reconnect**: looking up the game after a reconnect returns the **same**
  session object and the same engine player ids — no second identity, no fresh
  player. Physical connection count is the transport's concern.
- **Host**: never used. Room `isHost` is for room conveniences only; the engine
  has no host and start/end authority is expressed by whoever may dispatch
  `START_GAME`/`PLAY_AGAIN` in the (later) transport.

Session surface: `getGame(roomCode)`, `createGame(roomCode)`, `syncRoster(roomCode)`,
`dispatch(roomCode, action)`, `getPublicState(roomCode)`, `getPlayerState(roomCode, id)`,
`getNarratorState(roomCode)`, `removeGame(roomCode)`; handles expose `roomCode`,
`reconcile()`, `dispatch(action)`, `getPublicState()`, `getPlayerState(id)`,
`getNarratorState()`. Errors are `MafiaSessionError` with codes
`ROOM_NOT_FOUND | GAME_ALREADY_EXISTS | GAME_NOT_FOUND | NOT_ENOUGH_PLAYERS |
TOO_MANY_PLAYERS (defensive) | NAME_TAKEN`. Tests: `mafia-session.test.ts`
(this seam, including the two `setStatus` lock/unlock cases).

## 15. Phase 11B WebSocket protocol (transport ↔ session)

`src/realtime/ws.ts` is the only transport that talks to the Mafia session. It
turns raw JSON frames into engine actions and engine results back into typed
server messages. The HTTP room system (`room-manager.ts`, `connection-manager.ts`)
stays authoritative for rooms; the engine state is authoritative for gameplay.

Client → server (on `/ws/rooms/:code?playerId=:id`):

- `{ type: "ping" }` → `pong` (generic transport ping).
- `{ type: "mafia.action", action: MafiaAction }` — the only gameplay frame.
  The server **derives** the actor on every dispatch; client-sent `actor` /
  `playerId` fields are overwritten, never trusted:
  - a non-host connection is a `PLAYER` acting on themselves (a mismatched
    `playerId` is `INVALID_ACTOR` in the engine);
  - the host (first-joined player, `isHost`) is additionally the **narrator** —
    server-only actions it sends are dispatched as `NARRATOR` and gated per the
    engine's narration rules.
- Anything else on the `mafia.*` namespace is rejected top-level
  (`UNKNOWN_MESSAGE_TYPE` as a generic `error`); malformed `mafia.action`
  frames produce `MISSING_ACTION`; `{action: "nope"}` and unknown action types
  produce `INVALID_ACTION`. Frames are **never** reprocessed as room actions.

Allowlist gating happens in the transport **before** dispatch, in addition to
the engine's own actor validation: `ACTION_FORBIDDEN` (no engine call) for
any action a connection's authority class may never submit (e.g., `SYSTEM`-only
`PLAYER_UNAVAILABLE`/`ADVANCE_PHASE`/`PLAY_AGAIN`, `NARRATOR`-only
`RESOLVE_NIGHT`/`BEGIN_NIGHT` from a player). Defense-in-depth only; the engine
remains the source of truth.

Server → client:

- `mafia.state` — the engine `getPublicState()` (no roles, night actions,
  acting Mafia, votes, or role-seen data). Broadcast to the room **only after a
  dispatch that changed game state**; unchanged/no-op results broadcast nothing.
- `mafia.narrator` — `getNarratorState()` (roles, night actions, votes,
  `readyState`, acting Mafia). Sent **only to the host connection**, and only
  on a state-changing dispatch.
- `mafia.private` — `getPlayerState(id)` (role, phase, `availableActions`,
  `ownNightAction`, `ownPrivateNightResult`, `ownVoteTargetId`). Sent **only to
  that player** and only when their serialized view changed since the last
  broadcast (diffed per room+player in `privateSnapshots`). On room-game
  creation every player's view is primed silently so the first dispatch emits
  genuine diffs only.
- `mafia.error` — single message type for mafia-channel failures (`createGame`
  session errors, allowlist, and engine result errors); each error is sent only
  to the connection that caused it and never severs the socket.
- `room.updated` / generic `error` remain the transport's own non-mafia messages.

Lifecycle decisions:

- **Lazy creation**: the game is created from the room's live roster on the
  first `mafia.action`, so joined-but-idle rooms never materialize a game.
- **Reconnect** (`sendMafiaSync` on socket open): replays `mafia.state`,
  `mafia.private`, and (host only) `mafia.narrator` — the same session object,
  the same ids, no restart. The replayed private view carries the pending night
  action so a client reconnects straight back into an in-flight game.
- **Disconnect** (`PLAYER_UNAVAILABLE`, SYSTEM actor) is dispatched only when
  the room still exists, a game exists, **and** the player has no remaining
  connected sockets (multi-socket safe). It is a NIGHT-only no-op elsewhere and
  marks the departed player's own night slot `SKIPPED` when not yet acted;
  the player is never removed from the game, and the game does not terminate.
- **Room membership ≠ participation**: joins after `"playing"` are rejected by
  the room system; leaving mid-game is out of scope for this phase.

Tests: `src/games/mafia/mafia-protocol.test.ts` covers the wire contract end to
end (handshake, broadcast boundaries, action enforcement, information security /
need-to-know, reconnect, disconnect/SKIPPED, multi-socket, and room isolation)
against `src/test-server.ts`.

## 16. Phase 12 pass-the-phone (Mode A) adapter contract

`PassPhoneController` (`src/games/mafia/adapters/pass-phone/`) is the Mode A
adapter (spec §2.1): one shared device, one phone. The engine stays the single
authority — the adapter adds no rules of its own.

- **Boundary.** The adapter reads only `getPublicState()` and
  `getPlayerState(id)`; it never reads `getState()`, `getNarratorState()`, or
  any engine-internal field (the test suite audits every reachable view against
  a forbidden-keys list). It owns exactly: the roster (engine `JOIN`/`LEAVE` in
  LOBBY), id minting (`p1…`, `createId` seam for tests), and the phone-passing
  interaction state (current player + `HANDOFF`→`REVEAL` step). Alive/dead,
  roles, kills, saves, investigations, votes, eliminations, and winners come
  from the engine.
- **Authority.** Every dispatch uses `actor: NARRATOR`: the device is the Mode A
  advance authority, and the engine records each holder's choice on their
  behalf (the engine's NARRATOR path attributes the record to the real
  role-holder). `READY`/`START_GAME`/`PLAY_AGAIN` likewise run as NARRATOR.
- **Views** (`types.ts`): `SETUP` (roster, can-start), `ROLE_HANDOFF` /
  `ROLE_REVEAL` (per-player pass; the handler's own name and role,
  engine `getPlayerState`), `NIGHT_HANDOFF` (role only — never a player id or
  name, so the group can't out the holder), `SECRET_ACTION` (the holder's own
  role + `action` + living candidates), `MORNING` (deaths: names only),
  `DISCUSSION`, `VOTE_HANDOFF` / `VOTE` (living candidates), `VOTE_RESULT`,
  `GAME_OVER` (engine winner + `revealedRoles`).
- **Advance.** `getView()`/transitions resolve NIGHT automatically when every
  night actor has acted (engine `RESOLVE_NIGHT`, NARRATOR); otherwise the
  device walks the handoff. Day flow is explicit taps: morning → discussion →
  voting → result → next night (`continueAfterResult`). `endNightNow()` and
  `endVoting()` are device escape hatches that force-resolve (engine
  `ADVANCE_PHASE`/`END_VOTING`).
- **Day-night ordering** (Mafia → Doctor → Detective) comes from the engine's
  `availableActions` plus `NIGHT_ACTION_ORDER`; the night card's legal targets
  come from `candidatesFor` (living players, and the Mafia may not kill
  themselves); the engine remains the judge.
- **Secrets.** `secureClear()` nulls the on-screen secret at any time (e.g. app
  blur). No view ever carries engine-internal state (`roles`, `votes`,
  `nightActions`, `actingMafiaId`, `roleSeen`, `readyState`,
  `lastResolvedNight`, `lastElimination`, `timeline`).
- **Determinism.** Randomness is injected (`createMafiaGame({ random })`), so
  integration tests replay the same deal while still learning roles only through
  the reveal screens, never from the engine.

Tests: `src/games/mafia/adapters/pass-phone/pass-phone-controller.test.ts`
exercises the adapter exactly as a UI would — read `getView()`, confirm the
handoff, perform the action, follow the engine — across 27 cases (roster,
reveal, night, voting, both winners, replay/reset, secret-leak audit).

## 17. Phase 13 narrator (Mode C) adapter contract

`NarratorController` (`src/games/mafia/adapters/narrator/`) is the Mode C
adapter (spec §2.3): one narrator device, players participate physically with no
phones. The engine stays the single authority — the adapter adds no rules of its
own.

- **Boundary.** The adapter reads only `getNarratorState()` (the engine's
  privileged view: roles, ready/role-seen, acting Mafia, night inputs, resolved
  night, votes, elimination, timeline). It never reads `getState()` and it owns
  exactly two things: the roster (engine `JOIN`/`LEAVE` in LOBBY) and id minting
  (`p1…`, `createId` seam). Alive/dead, roles, acting-Mafia selection, night
  math, verdicts, votes, eliminations, and winners all come from the engine.
- **Authority.** Every dispatch uses `actor: NARRATOR`. The engine records a
  player's *spoken* night choice or vote on their behalf (`MAFIA_KILL`,
  `DOCTOR_SAVE` with `null` = deliberate pass, `DETECTIVE_INVESTIGATE`, and
  `CAST_VOTE` with an explicit `voterId`) while keeping target/life checks.
  Lobby control (READY/START_GAME/PLAY_AGAIN) and the role-reveal→night
  transition (`BEGIN_NIGHT`) are also NARRATOR.
- **Views** (`types.ts`), all derived from `getNarratorState()` with names
  resolved so the UI reads people by name: `LOBBY` (roster + ready + can-start),
  `ROLE_REVEAL` (every player's dealt role to tell them), `NIGHT` (acting Mafia
  + the kill/save/investigate slots with their recorded status/targets),
  `MORNING` (deaths + the Detective's verdict), `DISCUSSION`,
  `VOTING` (recorded tally + who still owes a spoken vote), `VOTE_RESULT`
  (elimination/tie), `GAME_OVER` (winner + full role reveal, spec §8.5).
- **Advance.** Explicit taps: `beginNight`, `startDiscussion`, `startVoting`,
  `endVoting`, `resolveNight` (normal, kill required), and the generic
  `advancePhase()` meta-button (engine `ADVANCE_PHASE`: MORNING→DISCUSSION,
  DISCUSSION→VOTING, VOTING→VOTE_RESULT, VOTE_RESULT→NIGHT,
  ROLE_REVEAL→NIGHT, and NIGHT→force-resolution of still-pending slots).
- **Replay.** `playAgain()` keeps the roster on a fresh deal; `resetGame()`
  starts a completely empty lobby.
- **Security.** Narrator state is privileged by definition and this adapter is
  **local-only**: it imports nothing from the session/protocol/room layers and
  nothing from those layers imports it. Its views must never be routed through
  Mode B player messages.

Tests: `src/games/mafia/adapters/narrator/narrator-controller.test.ts`
exercises the adapter as a narrator UI would — read the screen, record the
spoken action, resolve, advance — across 21 cases (lobby/start, reveal + first
night, recorded night actions incl. rejected targets, morning + verdict,
recorded voting incl. auto-end/tie/guards, both winner paths to GAME_OVER, and
replay/reset).