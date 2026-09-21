# PLAYROOM — Mafia Game Specification

**Version:** 1.0 (MVP)
**Status:** Design document — no implementation yet
**Scope:** Defines the Mafia game engine and its three interaction modes. Guides the future backend, game engine, and frontend implementation.

---

## 1. Overview

Mafia is a social deduction party game for **4–20 players**. Players are secretly assigned
one of four roles:

- **Mafia** (1+): works as a team, kills one player each night.
- **Doctor**: saves one player per night from death.
- **Detective**: investigates one player per night to learn whether they are Mafia.
- **Villager**: no night power; wins with the Town.

There is no day/night concept based on real time. Phases are controlled by actions.

The game is a round-based loop:

```
LOBBY → ROLE_REVEAL → NIGHT → MORNING → DISCUSSION → VOTING → VOTE_RESULT
                                                                    ↓
                                            (winner?) → GAME_OVER ⟶ LOBBY
```

A win is checked immediately after night resolution and immediately after vote
elimination. The game ends the moment a win condition is met.

### 1.1 One engine, three modes

There is a single underlying game engine. The three play modes are only different
presentation layers on top of the same rules:

- **Mode A — Pass the phone:** one shared device is passed between players.
- **Mode B — Own mobile:** each player uses their own phone in a network room.
- **Mode C — Narrator + players:** a dedicated narrator device drives the game while players play in person.

The engine is **mode-agnostic**. It processes the same set of actions regardless of mode.
The client (or narrator) is only ever a controller for the engine.

---

## 2. Three Play Modes

### 2.1 Mode A — Pass the phone

One physical phone is shared by all players. The phone is passed around the group.

**Lobby flow**

1. Host (anyone) opens the app and selects "Pass the Phone" / Local game.
2. Host enters the total number of players.
3. One by one, each player takes the phone and enters only their name. The lobby shows the
   list of entered names.
4. Host taps **Start**. The engine assigns roles.

**Player setup**

- Identity is just a name string. There are no accounts, no joins, no connection state.
- The host is only a physical custodian of the device, not a special authority in the engine.

**Role assignment**

- On Start, the engine deals roles deterministically by player count (see Role Distribution).
- Assignment happens inside the app; no network is involved.

**Private role reveal**

- Each player is handed the phone one at a time, in a private moment.
- The phone shows "*Player 3: You are the DOCTOR*" then the player confirms and passes the phone.
- The phone records that the reveal was acknowledged (so a player cannot accidentally see a
  later player's reveal).
- Players are trusted to not peek: the app can only prompt, not enforce.

**Night actions**

- The phone is passed to the players who have night actions, one at a time:
  1. Mafia player — selects a kill target.
  2. Doctor — selects a save target (or passes).
  3. Detective — selects an investigation target.
- Each selection is made on the shared device and confirmed.
- The order is **Mafia → Doctor → Detective**, matching the fixed night resolution order.

**Discussion**

- The phone displays simple prompts/summaries ("Discussion time. Pass around and talk.") with
  maybe a timer. No real chat exists in this mode.
- There is no per-player messaging.

**Voting**

- The phone is passed around. Each living player taps the name of the player they vote for.
- The host (or the device, if set up to track passer) advances voting to results.

**Elimination**

- The device reveals who was eliminated. The eliminated player's role is only revealed if the
  rule says so (see role reveal on elimination).
- The game continues: the device drives the next night.

**Game completion**

- The device announces the winner and shows each player's final role.
- "Play again" starts a fresh lobby (re-entering names) without leaving the app.

**No unnecessary mechanics:** no network, no chat, no QR codes, no reconnection.

### 2.2 Mode B — Everyone on their own mobile

A network room. The **server is authoritative** for all rules and hidden information.

**Host behavior**

- A host creates a room and receives a room code (and optionally a QR code/link).
- The host does **not** own the game state. The host is a normal player who merely configured
  the room. If the host disconnects, the game continues (see Reconnection Requirements).

**Player identity**

- A player enters a display name. The server assigns an opaque per-room player ID.
- Names are unique per room at join time (server-enforced).
- No accounts.

**Joining**

- A player joins with a room code (or by scanning the QR / opening the link).
- The server validates the room code and adds the player to the lobby.
- The server broadcasts only the **public lobby state** (name list, ready flags, player count).

**Lobby**

- All players see the lobby: members, ready status, player count, min/max.
- Host sees the Start button once the player count is within range and all players are ready.

**Ready/start behavior**

- Each player sends `READY`. Start requires: player count in [4, 20] **and** all players ready.
- Only the host may send `START_GAME`. Once started, the room is locked to new joins.

**Role assignment**

- The server assigns roles at start and never sends the full assignment to anyone.

**Private information**

- Conversation · The server sends **player-specific private state** only to the owning client.
- In particular, only a player's own role is ever delivered to them.
- Night action results (Doctor learning of a failed kill, Detective investigation verdicts)
  are delivered only to the relevant player.

**Night actions**

- Each night, the server sends targeted prompts only to players who can act:
  - Mafia (one chosen mafia acting on behalf of the team) sends `MAFIA_KILL`.
  - Doctor sends `DOCTOR_SAVE`.
  - Detective sends `DETECTIVE_INVESTIGATE`.
- The server collects submissions until all required actions are done (or timeout), then resolves.

**Discussion**

- This mode has **no built-in chat in the MVP** (chat is a deferred feature; see Future / Out of
  Scope). Players talk out loud or over the user's chosen external voice call.
- The client simply shows the discussion timer and living players.

**Voting**

- Each living player submits a `CAST_VOTE` with their chosen target.
- Votes are private to the server; only totals/elimination are revealed (see Voting).

**Elimination**

- The server resolves the vote, reveals the eliminated player, and broadcasts the reduced
  living-player list.
- Role on elimination is revealed per the documented rule.

**Reconnect expectations**

- Reconnecting clients receive the **public game state** plus their **own private state**.
- See section 14 for details.

**Game completion**

- The server announces the winner to everyone, then unlocks the room to "Play again".

**Server authority note:** clients only ever render the slices of state the server sends.
A client cannot compute roles, validate actions, resolve nights, or decide winners.

### 2.3 Mode C — Narrator + players

One person operates a **narrator interface** on their own device. Players participate
physically and do not need phones. The narrator is the sole controller of the game.

**The narrator sees**

- The public game state at all times: current phase, living players, time, results.
- The full hidden truth: every player's role, all night actions as they are submitted,
  investigation results, and current vote tally.
- The narrator is the authoritative human controller for the table.

**The narrator controls**

- Advances phases (`ADVANCE_PHASE` / `START_DISCUSSION` / `END_VOTING`).
- Resolves actions and records outcomes through the narrator interface.
- Reveals information ("Bob, you are Mafia. Choose your target in secret.").
- Announces results and eliminations.
- Ends the game when a win condition is reached.

**Flow (simplified)**

1. Narrator creates a room in narrator mode with N players and enters everyone's names.
2. Narrator advances to role reveal; privately tells each player their role.
3. Night: the narrator asks each acting player in secret, records the action in the interface,
   and the engine resolves the night.
4. Morning: narrator announces deaths.
5. Discussion: narrator runs the spoken discussion (no chat).
6. Voting: narrator records each living player's spoken vote.
7. On elimination/win, narrator announces and ends the game.

**Explicitly out of scope for this mode**

- No AI narration.
- No voice/TTS synthesis. Voice is a later feature layered on the engine.

---

## 3. MVP Rules

- **Players:** 4–20.
- **Roles:** Mafia, Doctor, Detective, Villager only. No additional roles.
- **Night:** each night, Mafia kills; Doctor saves; Detective investigates.
- **Day/night pacing:** phases are triggered by actions, not by the clock. A single optional
  phase timer is allowed at the UI level.
- **Doctor's save:** negates one kill on the saved player that same night. The Doctor may save
  themselves. The Doctor may skip (pass). The Doctor cannot target the same player on two
  consecutive nights (a documented design decision to prevent an immortal Doctor; see Open
  Design Decisions).
- **Detective's investigation:** reveals to the Detective whether the target is Mafia or not.
  It does not reveal the exact role.
- **Mafia coordination:** exactly **one** Mafia acts per night as the team's kill action
  (the "acting Mafia"). If the acting Mafia submits, the team cannot retract. The acting role
  passes to a living Mafia each night. This avoids ambiguous multi-actor kills while keeping
  one team action.
- **Winning:** Mafia wins when Mafia count equals non-Mafia count. Town wins when all Mafia are
  dead. Details in Win Conditions.

### 3.1 Design decisions called out explicitly

- Doctor cannot heal the same player two nights in a row.
- Mafia kill is a single nightly action performed by one acting Mafia.
- No role can be revealed on elimination (see 8.6) — roles are revealed only at game end.
- Investigations return only "Mafia or not", never the exact role.

---

## 4. Role Distribution

Deterministic and based purely on player count.

The number of slots for each role is determined by the player-count table below. Role
assignments are then **shuffled randomly across all players** — the table only fixes *how many*
players hold each role, never *which* players do.

| Players | Mafia | Doctor | Detective | Villager |
|--------:|------:|-------:|----------:|---------:|
| 4       | 1     | 1      | 1         | 1        |
| 5       | 1     | 1      | 1         | 2        |
| 6       | 1     | 1      | 1         | 3        |
| 7       | 1     | 1      | 1         | 4        |
| 8       | 2     | 1      | 1         | 4        |
| 9       | 2     | 1      | 1         | 5        |
| 10      | 2     | 1      | 1         | 6        |
| 11      | 2     | 1      | 1         | 7        |
| 12      | 3     | 1      | 1         | 7        |
| 13      | 3     | 1      | 1         | 8        |
| 14      | 3     | 1      | 1         | 9        |
| 15      | 3     | 1      | 1         | 10       |
| 16      | 4     | 1      | 1         | 10       |
| 17      | 4     | 1      | 1         | 11       |
| 18      | 4     | 1      | 1         | 12       |
| 19      | 5     | 1      | 1         | 12       |
| 20      | 5     | 1      | 1         | 13       |

**Formula:** `Mafia = floor(Players / 4)` for players ≥ 8, and `1` for players 4–7.
Doctor and Detective are always `1`. `Villager = Players − Mafia − 2`.

---

## 5. Game State Machine

The engine is an explicit state machine. State lives on the server (Mode B) or in the local
game engine controller (Modes A and C). Each state defines who can act, which actions are
valid, and when it transitions.

```
LOBBY
  ↓ START_GAME
ROLE_REVEAL
  ↓ BEGIN_NIGHT / all ROLE_SEEN
NIGHT
  ↓ all required actions resolved
MORNING
  ↓ BEGIN_DISCUSSION
DISCUSSION
  ↓ START_VOTING
VOTING
  ↓ all votes in / END_VOTING
VOTE_RESULT
  ├── win → GAME_OVER
  └── no win → NIGHT   (next night, new acting Mafia)
```

### 5.1 State definitions

#### LOBBY
- **Purpose:** form the player group before roles exist.
- **Who can act:** host (Mode B) / whoever holds the phone (Mode A) / narrator (Mode C); all
  players can `READY` (Mode B).
- **Allowed actions:** `JOIN`, `LEAVE`, `READY`, `UNREADY`, `SET_PLAYER_COUNT` (narrator/local),
  `START_GAME`, `ADVANCE_PHASE` (allowed no-op guard).
- **Transition:** → `ROLE_REVEAL` when `START_GAME` is accepted (count in [4,20], all ready in
  Mode B).

#### ROLE_REVEAL
- **Purpose:** privately inform each player of their role.
- **Who can act:** engine/host; players acknowledge (`ROLE_SEEN`).
- **Allowed actions:** `ROLE_SEEN`, `BEGIN_NIGHT`, `ADVANCE_PHASE`.
- **Transition:** → `NIGHT` when all players have confirmed `ROLE_SEEN` (or narrator advances).

#### NIGHT
- **Purpose:** collect all night actions in fixed conceptual order.
- **Who can act:** acting Mafia, Doctor, Detective (and narrator, who records on their behalf).
- **Allowed actions:** `MAFIA_KILL`, `DOCTOR_SAVE`, `DETECTIVE_INVESTIGATE`, `RESOLVE_NIGHT`
  (engine/narrator).
- **Transition:** → `MORNING` once all required actions are present (kill is required; save and
  investigate may be skipped). A night only resolves with **missing actions** in exactly two
  cases (see §6.14 and §9.3): a player **disconnected or timed out** (their missing action is
  skipped) or the **narrator explicitly force-resolves**. It never resolves silently because a
  player merely did not act.

#### MORNING
- **Purpose:** announce night outcome (deaths and investigation result).
- **Who can act:** engine/narrator.
- **Allowed actions:** `BEGIN_DISCUSSION`, `ADVANCE_PHASE`.
- **Transition:** → `GAME_OVER` (win detected) or → `DISCUSSION`.

#### DISCUSSION
- **Purpose:** players talk (in person / external call) before voting.
- **Who can act:** engine can `START_VOTING`. Timer is cosmetic.
- **Allowed actions:** `START_VOTING` (host/narrator), `CAST_VOTE` (early tolerated but not
  resolved), `ADVANCE_PHASE`.
- **Transition:** → `VOTING` on `START_VOTING`.

#### VOTING
- **Purpose:** collect one vote per living player.
- **Who can act:** all living players; narrator records spoken votes.
- **Allowed actions:** `CAST_VOTE`, `END_VOTING`.
- **Transition:** → `VOTE_RESULT` when all living players have voted **or** `END_VOTING` is
  triggered (host/narrator) **or** timer expires.

#### VOTE_RESULT
- **Purpose:** resolve votes, eliminate the target (if any), check win condition.
- **Who can act:** engine/narrator.
- **Allowed actions:** `ACKNOWLEDGE`, `ADVANCE_PHASE`.
- **Transition:** → `NIGHT` (no win) or → `GAME_OVER` (win).

#### GAME_OVER
- **Purpose:** reveal the result and roles.
- **Who can act:** everyone (read-only).
- **Allowed actions:** `PLAY_AGAIN` (new lobby), `LEAVE`.
- **Transition:** → `LOBBY` on `PLAY_AGAIN`.

**Notes**
- The five listed states from the brief are all used. No extra states were needed.
- `ADVANCE_PHASE` is a meta-action available to narrator/host that fast-forwards a timed phase
  to its terminal transition.

---

## 6. Actions

Every action is validated by the engine. Invalid actions are **rejected** with an error; the
server never partially applies them.

Conventions:

- `actor` = player or narrator/host.
- `phase` = state in which the action is valid.
- `permissions` = role/authority requirements.
- If an action is rejected, state is unchanged and the sender receives an error.

### 6.1 `JOIN`
- **actor:** new player (Mode B)
- **phase:** LOBBY (and only while not started)
- **permissions:** none
- **payload:** `{ roomCode, name }`
- **validation:** room exists; room in LOBBY; 4 ≤ (current + new) ≤ 20; name unique and valid;
  not already joined.
- **state change:** player added; public lobby state broadcast.

### 6.2 `LEAVE`
- **actor:** any player (Mode B)
- **phase:** LOBBY (a leave mid-game is treated as a disconnect; see 14)
- **permissions:** self
- **payload:** `{ playerId }`
- **validation:** player exists and is in the room.
- **state change:** player removed; lobby broadcast; if player count < 4 after start, game ends
  (see 14).

### 6.3 `READY`
- **actor:** any player (Mode B)
- **phase:** LOBBY
- **permissions:** self
- **payload:** `{ playerId }`
- **validation:** player in room.
- **state change:** player marked ready. Readiness cleared on any lobby change.

### 6.4 `UNREADY`
- **actor:** any player (Mode B)
- **phase:** LOBBY
- **permissions:** self
- **payload:** `{ playerId }`
- **validation:** player in room and currently ready.
- **state change:** player marked not ready.

### 6.5 `START_GAME`
- **actor:** host (Mode B) / device holder (Mode A) / narrator (Mode C)
- **phase:** LOBBY
- **permissions:** host/narrator only
- **payload:** (none)
- **validation:** actor is host; player count in [4, 20]; all players ready (Mode B).
- **state change:** roles assigned server-side; → `ROLE_REVEAL`; roles distributed privately.

### 6.6 `ROLE_SEEN`
- **actor:** any player
- **phase:** ROLE_REVEAL
- **permissions:** self
- **payload:** `{ playerId }`
- **validation:** player is alive for role-reveal purposes (all are).
- **state change:** player acknowledged their role.

### 6.7 `MAFIA_KILL`
- **actor:** acting Mafia (or narrator recording for them)
- **phase:** NIGHT
- **permissions:** Mafia (only one acting Mafia may submit)
- **payload:** `{ targetPlayerId }`
- **validation:** target is alive; target is not the acting Mafia themselves; a kill was not
  already submitted this night.
- **state change:** records the kill target; marks kill as done.

### 6.8 `DOCTOR_SAVE`
- **actor:** Doctor (or narrator on their behalf)
- **phase:** NIGHT
- **permissions:** Doctor only
- **payload:** `{ targetPlayerId | null }`
- **validation:** target is alive; target ≠ the Doctor's save target from the previous night.
  `null` = skip.
- **state change:** records the save; marks save as done.

### 6.9 `DETECTIVE_INVESTIGATE`
- **actor:** Detective (or narrator on their behalf)
- **phase:** NIGHT
- **permissions:** Detective only
- **payload:** `{ targetPlayerId }`
- **validation:** target is alive.
- **state change:** records the investigation; marks investigate as done. Result is computed at
  resolution and delivered privately to the Detective.

### 6.10 `START_DISCUSSION`
- **actor:** host/narrator (Mode C) or anyone with the advance authority (Mode A device)
- **phase:** MORNING
- **permissions:** advance authority
- **payload:** none
- **validation:** phase is MORNING.
- **state change:** → `DISCUSSION`.

### 6.11 `START_VOTING`
- **actor:** host/narrator/advance authority
- **phase:** DISCUSSION
- **permissions:** advance authority
- **payload:** none
- **validation:** phase is DISCUSSION.
- **state change:** → `VOTING`.

### 6.12 `CAST_VOTE`
- **actor:** any living player (narrator records spoken votes)
- **phase:** VOTING
- **permissions:** player must be alive; one vote per player.
- **payload:** `{ targetPlayerId }`
- **validation:** actor alive; actor has not yet voted; target alive; (optional) self-vote
  allowed per 8.3.
- **state change:** vote recorded; when all living players have voted, phase auto-transitions.

### 6.13 `END_VOTING`
- **actor:** host/narrator/advance authority
- **phase:** VOTING
- **permissions:** advance authority
- **payload:** none
- **validation:** phase is VOTING.
- **state change:** forces → `VOTE_RESULT` (ties/none handled per Voting rules).

### 6.14 `ADVANCE_PHASE`
- **actor:** host/narrator/advance authority (Mode A device holder)
- **phase:** any timed phase
- **permissions:** advance authority
- **payload:** none
- **validation:** phase is a timed phase.
- **state change:** fast-forwards the current phase to its terminal transition.

**Force-resolve semantics (important).** `ADVANCE_PHASE` during NIGHT is an explicit
**force-resolve** by the advance authority, distinct from a passive timeout. Only two things
may resolve a night with missing actions — never a player simply not acting:

1. **Disconnect / timeout** (`AFK_TIMEOUT`, player unreachable): the missing action becomes
   "no action" and the night resolves with the collected inputs (per §9.3).
2. **Explicit force-resolve** (`ADVANCE_PHASE` by host/narrator): the authority decides the
   waiting player's action is never coming and resolves with what was collected.

A connected player who has merely not submitted does **not** stall or silently skip the game —
if they stay silent, the authority must either wait (timed phase) or force-advance.

### 6.15 `PLAY_AGAIN`
- **actor:** host/narrator
- **phase:** GAME_OVER
- **permissions:** host/narrator
- **payload:** none
- **validation:** phase is GAME_OVER.
- **state change:** → `LOBBY`, clears roles, resets players.

### 6.16 Example invalid-action rejections (must hold)
- Dead player casting a vote — rejected (`actor must be alive`).
- Villager sending `MAFIA_KILL` — rejected (`role mismatch`).
- Mafia sending `MAFIA_KILL` during VOTING — rejected (`invalid phase`).
- Voting for a dead player — rejected (`target must be alive`).
- Voting for a player not in the room — rejected (`unknown target`).
- Any action arriving after the phase transitioned — rejected (`phase changed`).
- A second Mafia kill in the same night — rejected (`kill already submitted`).
- Doctor healing the same player on consecutive nights — rejected (`doctor repeat guard`).

---

## 7. Hidden Information

This is the most critical part of the design. The engine distinguishes four information
layers. **The server never ships the full game state to any client.**

### 7.1 The four layers

**1. Internal server state** — the complete truth, never sent in full to any client.

```
roles:      { alice: MAFIA,   bob: DOCTOR,   charlie: VILLAGER, david: DETECTIVE }
night:      { kill: david, save: david, investigate: charlie → isMafia: false }
  votes:      { alice → bob, bob → charlie, charlie → bob }
  tally:      { bob: 2, charlie: 1 }   // computed, never stored
```

**2. Public game state** — identical for everyone; contains no hidden info.

```
phase, livingPlayerIds, eliminatedPlayerIds, playerNames, roomsize,
discussionTimer, currentNight, winnerAtGameOver
```

**3. Player-specific private state** — different per player; sent only to that player.

```
ownPlayerId, ownRole, available actions this phase,
private night results (Doctor: "your heal was used"; Detective: "target is Mafia / not Mafia"),
vote submission status
```

**4. Narrator state** — the union of public + full hidden truth, only in Mode C.

```
everything in (1) that has been resolved, plus pending night actions
```

### 7.2 Who is allowed to know what

| Info                        | Public | Private (player)               | Narrator |
|-----------------------------|:------:|:-------------------------------|:--------:|
| Player names / count / room | ✅    | ✅                             | ✅       |
| Own role                    | –      | ✅ (only own)                  | ✅ (all) |
| Other players' roles        | –      | –                              | ✅ (all) |
| Night setup / results       | ✅ deaths only | Detective verdicts, Doctor heal notice | ✅ (all details) |
| Vote tally during voting    | ✅ (recorded per 8.5) | ✅ | ✅ |
| Eliminated player's role    | – (see 8.6) | – | ✅ |
| Full role assignment        | ✅ only at GAME_OVER | dated at GAME_OVER | always |

### 7.3 What is visible in each phase

| Phase          | Public sees                     | Private sees (per player)            |
|----------------|--------------------------------|--------------------------------------|
| LOBBY          | names, ready, count            | own name, ready state                |
| ROLE_REVEAL    | phase label                    | own role only                        |
| NIGHT          | "Night N in progress", living  | own prompt if they can act; nothing otherwise |
| MORNING        | deaths (or "no one died"), living | Doctor: whether heal was used; Detective: verdict |
| DISCUSSION     | living, timer, discussion prompt | same as public                       |
| VOTING         | living (so voters know options) | voting state (has-voted/not)         |
| VOTE_RESULT    | eliminated player (if any)     | elimination result                   |
| GAME_OVER      | winner; every role revealed    | winner; every role revealed          |

### 7.4 Multiplayer-specific rules
- Every network message is either a **public broadcast** or a **targeted send** to exactly one
  player. The protocol is never "send the whole state".
- Targeted sends are the only way a player learns their own role, their private results, or
  their prompt to act.
- Dead players continue receiving **public** broadcasts (it is easier to hide the fact that a
  player who got a private prompt can act by not sending anyone a notification when a dead
  player would have acted). Dead players receive no action prompts and no private results.

---

## 8. Win Conditions

### 8.1 Mafia wins
**Condition:** number of living Mafia ≥ number of living non-Mafia (i.e., `M ≥ V` where
`V = living non-Mafia`).

Rationale: at that point the Mafia can outvote or out-kill the Town.

### 8.2 Town wins
**Condition:** number of living Mafia = 0.

### 8.3 When a win is checked
- **Immediately after night resolution** (in `MORNING` setup, before announcing a full morning):
  if the night leaves the Mafia in a winning position (`M ≥ V`) the game ends in Mafia victory;
  if all Mafia died at night the game ends in Town victory. Death announcements are still shown.
- **Immediately after a vote elimination** (in `VOTE_RESULT`): if the eliminated player was the
  final Mafia, the Town wins. If the eliminated player was a non-Mafia and this brings `M ≥ V`,
  the Mafia wins.
- The game **always** checks after resolving an elimination or night, never mid-phase, to keep
  the resolution atomic.

### 8.4 Game ends immediately
Yes. The first moment a win condition is true, the game transitions to `GAME_OVER`. There is no
"last night of pity plays".

### 8.5 Information revealed at game end
- The winning team.
- The complete role assignment for every player.
- A compact summary: nights, deaths, eliminations in order (useful for post-game debrief).

### 8.6 No dead-tell at elimination
We do **not** reveal a player's role when they are eliminated mid-game. This keeps investigation
and discussion meaningful. Revealed only at GAME_OVER.

---

## 9. Night Resolution

Actions are collected and then **resolved atomically** in a fixed order. The engine computes
the outcome of the whole night in one step so results are never order-dependent at the client
level.

### 9.1 Fixed conceptual order
1. **Mafia** selects a kill target.
2. **Doctor** selects a save target (or passes).
3. **Detective** selects an investigation target.
4. Server **resolves all actions together**:
   5. Determine deaths.
   6. Determine investigation result (if any).
   7. Check win condition.
   8. Generate morning state.

### 9.2 Resolution algorithm (documented logic, not code)
```
killTarget   = mafiaKill.selectedTarget
saveTarget   = doctorSave.selectedTarget            // or null when skipped
doctorAlive  = doctor.isAlive at resolution
detectiveInvestigation = detectiveInvestigate.selectedTarget or null

# A single target can be both the kill target and the save target:
# the save cancels the kill on that player.
killedPlayers = []
if killTarget != null:
    if saveTarget != killTarget or doctorAlive == false:
        if not (saveTarget == killTarget and doctorAlive):
            killedPlayers = [ killTarget ]

# Alternative simpler formulation (equivalent):
if killTarget != null and (saveTarget != killTarget or !doctorAlive):
    killedPlayers = [killTarget]
else:
    killedPlayers = [null]

# Investigation
if detectiveInvestigation != null:
    verdict = (role[target] == MAFIA)   # binary: is the target Mafia?
```

Equivalent final rules:

- **Death happens** iff `killTarget` was submitted **and** the Doctor is alive **and** the
  save target ≠ killTarget **or** Doctor is dead.
  Concretely: the save cancels the kill **only when the Doctor is alive at the moment of
  resolution** (a dead Doctor's earlier save from before death — impossible, since the Doctor
  acts each night fresh — never applies).
- There is exactly **one possible death per night** (one kill, one heal).

### 9.3 Edge cases (documented, deterministic)

| Situation                          | Outcome |
|------------------------------------|---------|
| Mafia kills Doctor                 | Doctor dies (Doctor cannot save self unless that was their own save — see next row) |
| Doctor saves the Mafia target      | Target survives; night has no death |
| Doctor saves themselves            | Doctor survives a kill aimed at them; no death that night |
| Detective investigates a Mafia     | Verdict = `IsMafia: true` (exact role not revealed) |
| Detective investigates a non-Mafia | Verdict = `IsMafia: false` |
| A selected player dies that same night | Only possible target of the single kill; save+vote atomics avoid double-death |
| Mafia's kill action is missing     | No kill that night; night still resolves; morning says "No one was killed" |
| Doctor's action is missing         | No heal; resolution proceeds without it |
| Detective's action is missing      | No investigation; no verdict delivered |
| Patient/Doctor dies at night        | Save is ignored if the Doctor dies before resolution — see Resolution order: Doctor's save applies only if the Doctor is alive at resolution; a Doctor who is the kill target only survives by having saved themselves |
| A player disconnects during night  | Their in-flight action is treated as **missing/skipped** (only on disconnect/timeout per §6.14), game continues |
| A connected player never acts      | The night does **not** silently resolve; the authority must wait (timed phase) or explicitly force-resolve per §6.14 |

**Key simplification:** because the MVP has a single kill and a single heal that cancel each
other on the same target, there are no "two kills one night", "kill redirected", or "double
death" cases. Ordering only matters for *who submitted what* (collect step), never for the
resolution math — resolution is a single pure computation on the collected inputs.

---

## 10. Voting

- **Who can vote:** all living players.
- **Who can be voted for:** any living player.
- **Self-vote:** allowed. (Simple; prevents lockout edge cases.)
- **Dead players voting:** forbidden (rejected).
- **Public or private votes:** votes are **private** (individual choices and the running
  tally are not revealed live). Only the final result (eliminated player) is revealed. This
  keeps hidden-information boundaries clean.
- **When voting ends:** automatically when every living player has voted, or when `END_VOTING`
  is triggered, or on phase timeout.
- **How elimination is determined:** votes arrive as a `voter → target` map
  (`votes: Record<PlayerId, PlayerId | null>`); the tally is **derived, not stored**
  (`tally[target] = count of voters who chose target`). Then:
  1. Compute the tally from the received votes.
  2. If there is a **strict plurality** winner (highest count with no tie) → eliminate that
     player.
  3. **Tie** for highest count (including a tie between two+ players) → **no elimination**
     (`Eliminated: none`). This is simple and deterministic; deliberate (see Open Decisions).
  4. **Nobody votes** → no elimination.

### 10.1 Elimination consequences
- Eliminated player is marked dead; removed from living list.
- If the eliminated player was the Mafia's acting Mafia, a new acting Mafia is chosen next night
  (a living Mafia).
- If the eliminated player was the Doctor or Detective, they lose their power.
- Role is **not** revealed on elimination.
- Win condition checked immediately (see 8.3).

### 10.2 Ties
Ties collapse to "no one is eliminated". We do not run a second-round runoff in the MVP.

---

## 11. Mode-to-Engine Mapping

The engine is identical; the mode only changes *who submits the action* and *which device*.

| Engine action        | Mode A — Pass the phone                    | Mode B — Own mobile                 | Mode C — Narrator                          |
|----------------------|--------------------------------------------|-------------------------------------|--------------------------------------------|
| `READY`              | implicit; not used (host taps start)       | each player taps Ready             | implicit; narrator taps start              |
| `START_GAME`         | host taps Start on shared device           | host sends Start                   | narrator taps Start                        |
| `ROLE_SEEN`          | each player confirms on the passed phone   | each player gets own role, taps ok | narrator reads role, tells player          |
| `MAFIA_KILL`         | acting Mafia picks target on shared device | acting Mafia picks target on own phone, sends to server | narrator records the Mafia's spoken target |
| `DOCTOR_SAVE`        | Doctor picks on shared device              | Doctor picks on own phone, sends   | narrator records Doctor's spoken choice    |
| `DETECTIVE_INVESTIGATE` | Detective picks on shared device        | Detective picks on own phone, sends| narrator records Detective's spoken choice |
| `BEGIN_NIGHT`        | phone auto-advances                        | server auto-advances after results | narrator advances                          |
| `START_DISCUSSION`   | device shows prompt/timer                  | server broadcasts phase            | narrator announces                         |
| `CAST_VOTE`          | each living player taps a name on the phone| living players vote on own phones | narrator records spoken votes              |
| `END_VOTING`         | host taps on device                        | server auto / host ends            | narrator ends                              |
| `PLAY_AGAIN`         | host taps on device                        | host sends                         | narrator taps                              |

In every mode the engine enforces the exact same validation, night math, tie handling, and win
conditions. Mode is a **view-layer concern**, never a rule change.

---

## 12. Conceptual Data Model

TypeScript-oriented model for documentation. This is **not** production code and not the final
schema; it makes assumptions explicit before implementation.

```ts
type PlayerId = string;

type Role =
  | "MAFIA"
  | "DOCTOR"
  | "DETECTIVE"
  | "VILLAGER";

type Phase =
  | "LOBBY"
  | "ROLE_REVEAL"
  | "NIGHT"
  | "MORNING"
  | "DISCUSSION"
  | "VOTING"
  | "VOTE_RESULT"
  | "GAME_OVER";

type Mode = "PASS_THE_PHONE" | "MULTIPLAYER" | "NARRATOR";

interface GameState {
  gameId: string;
  mode: Mode;
  phase: Phase;
  nightNumber: number;          // increments after each NIGHT resolution
  players: Player[];            // full roster; status lives here (see Player.alive)
  roles: Record<PlayerId, Role>;            // internal, never broadcast wholesale
  actingMafiaId: PlayerId | null;           // which Mafia may submit the kill this night
  night: NightResolution | null;            // current night's collected actions
  votes: Record<PlayerId, PlayerId> | null; // voter → target; one entry per living voter.
                                            // NOT a tally — the count is derived at resolution:
                                            //   tally[target] = count of voters pointing at it
  winner: Team | null;                      // null until GAME_OVER
  createdAt: number;
}

interface Player {
  id: PlayerId;
  name: string;
  alive: boolean;
  ready: boolean;                            // multiplayer lobby only
  isHost: boolean;                           // multiplayer only; narrator is host in Mode C
  connections: number;                       // multiplayer reconnect accounting
  lastKnownAliveAtNight: NightNumber | null; // not needed in MVP; reserved for dead-tell rules
}

interface NightResolution {
  nightNumber: number;
  killTargetId: PlayerId | null;
  saveTargetId: PlayerId | null;
  investigatedTargetId: PlayerId | null;
  investigationVerdict: boolean | null;      // true = target is Mafia
  deaths: PlayerId[];                        // 0 or 1 entries
}

interface GameEvent {
  type:
    | "PHASE_CHANGED"
    | "PLAYER_JOINED" | "PLAYER_LEFT"
    | "PLAYER_READY" | "PLAYER_UNREADY"
    | "GAME_STARTED"
    | "ROLE_REVEALED"          // private, single recipient
    | "NIGHT_STARTED"
    | "NIGHT_RESOLVED"
    | "MORNING_ANNOUNCED"
    | "DISCUSSION_STARTED"
    | "VOTING_STARTED"
    | "VOTE_CAST"                      // private: confirms own vote recorded
    | "VOTING_RESOLVED"
    | "PLAYER_ELIMINATED"
    | "WINNER_DECLARED"
    | "ACTION_REJECTED";               // error to the sender only
  payload: unknown;
  public: boolean;                       // vs. targeted (private)
  playerId?: PlayerId;                   // recipient when !public
}

// Server/client wiring (multiplayer)
interface PublicGameState { /* §7.2 table, public column only */ }
interface PrivatePlayerState { ownRole, privateNightResults, allowedActions, ownVoteStatus }
interface NarratorState { PublicGameState & { roles, nightDetails, votes } }
```

**Key model invariants**

- `roles` is created at `START_GAME` and immutable until `GAME_OVER`.
- `actingMafiaId` is always a living Mafia.
- `deaths` and `votes` resolve to at most one eliminated player per transition.
- `winner` is set exactly once and triggers `GAME_OVER`.

---

## 13. Server Authority

The server owns **everything** that can be only in one place:

- **Role assignment** — random deal at `START_GAME`.
- **Randomization** — role shuffle only; no other roll is randomized in the MVP.
- **Phase transitions** — the state machine lives server-side; clients only request.
- **Action validation** — every action passes through §6 before it mutates state.
- **Night resolution** — the pure computation in §9.
- **Voting resolution** — counting, tie collapse, plurality election (§10).
- **Eliminations** — marking dead, removing from living list.
- **Win conditions** — evaluated at the two allowed moments (§8.3).
- **Hidden information** — §7 layering; server decides what to broadcast vs. target.
- **Authoritative game state** — the single source of truth; messages are derived, not mirrored.

The client:

- **Renders** only the slices of state the server sends.
- **Collects** user input.
- **Sends** actions.
- **Displays** only what it was permitted to see.

A compromised or modified client gains no rules power: the server re-validates everything and
only believes its own state.

---

## 14. Reconnection Requirements (multiplayer)

Desired behavior only — for the architecture to avoid making the host the owner of game state,
**the room/game state always lives on the server**, never on the host's client.

| Event | Desired behavior |
|-------|------------------|
| Player refreshes | Client re-negotiates; server rebinds the same `playerId`; client receives `PublicGameState` + their `PrivatePlayerState`; if a phase requires their input and it was pending, the prompt is re-sent. |
| Player temporarily disconnects | Their pending actions are treated as missing (skipped) for current resolution (consistent with §9.3). The game does not wait forever; it resolves with whatever is collected and continues. |
| Player reconnects | Same as refresh. If the player had been eliminated mid-disconnect, they are told via public state. |
| Host disconnects | The game continues. A next host may be auto-promoted for lobby-only purposes (e.g., "start"). The host has **no** extra engine authority — the state machine is server-owned, so losing the host is harmless. |
| Narrator disconnects (Mode C) | The narrator is the table's operator. Desired: the room is paused and a rejoin link resumes the narrator session with a full `NarratorState` so nothing is lost. There is no reassignment of narration unless explicitly relinked. |
| All players / everyone disconnects | Room is kept alive for a brief grace window, then garbage-collected. |

Rules to be implemented later and enforced by whoever works on networking:

1. `playerId` and any reconnect token are opaque and server-generated.
2. The server is the only holder of `roles`, `actingMafiaId`, `night`, and `votes`.
3. Reconnect never re-sends the whole state; always the canonical `PublicGameState` + targeted
   private slice.

---

## 15. Future / Out of Scope (MVP)

Explicitly deferred. Not part of this phase, the backend, or the engine:

- Additional Mafia roles (Bodyguard, Godfather, etc.)
- AI narrator
- AI-generated dialogue
- External text-to-speech / voice synthesis
- Accounts and authentication
- Friends / social graph
- In-app chat (in all modes; voice calls are the players' own)
- Matchmaking / quick play
- Leaderboards
- Player statistics
- Persistent game history / analytics
- Custom Mafia rules / configurable role decks
- Custom role creation
- Spectators (note: Narrator Mode is *not* spectating — it is an operator role)
- Moderation systems
- Payments / monetization
- Redis
- Horizontal scaling
- PostgreSQL persistence for active game state (a single-process server is out of scope too)

These can be layered later without changing the core engine contract.

---

## 16. Open Design Decisions

Decisions that must be confirmed (or left as-is with the default) before backend implementation.

| # | Question | Default (used in this document) | Impact if changed |
|---|----------|---------------------------------|-------------------|
| 1 | Doctor repeat-heal guard | Doctor cannot heal the same player on consecutive nights | Any change removes the "immortal guarded player" stalemate; default prevents degenerate play |
| 2 | Role reveal on mid-game elimination | Do **not** reveal | Revealing changes discussion/vote dynamics; default keeps the classic sanitized spread |
| 3 | Ties in voting | No elimination on a tie (incl. multiple-way and zero-vote) | A runoff or plurality-break changes strategy; default is the simplest deterministic rule |
| 4 | One acting Mafia vs. all Mafia vote to kill | One acting Mafia submits the single kill | All-Mafia voting adds phase complexity; default keeps night = one action |
| 5 | Doctor-dead save applicability | Save only applies if Doctor alive at resolution | Alternative: save applies regardless; changes a niche night outcome |
| 6 | Self-vote allowed | Yes | Minor; disabling it changes a tie edge case |
| 7 | Investigation verdict breadth | Binary (is Mafia / is not Mafia) | Returned exact role would change Doctor/Detective triage |
| 8 | Phase timers | Cosmetics only; engine is action-driven | Timer-driven nights would change disconnection semantics |
| 9 | Win check moments | Only after night resolution and vote elimination | Mid-discussion checks would end games early |
| 10 | Game-end requirement (`M ≥ V` for Mafia win) | `livingMafia ≥ livingNonMafia` | A stricter ">" condition would make games slightly longer |

---

*End of document. Implementation of the backend, engine, and networking is deliberately not
started in this phase.*