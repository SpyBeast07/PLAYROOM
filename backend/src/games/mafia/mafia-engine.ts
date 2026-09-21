/**
 * Mafia engine — full implementation (Phase 10B).
 *
 * Pure, deterministic, synchronous state machine. No Hono/WebSocket/Bun/room
 * knowledge. Randomness is injected (`random` option) for the role shuffle.
 * Every mutation happens through `dispatch`; rejected actions never change state.
 *
 * See backend/docs/mafia-engine.md for the architecture and rules.
 */
import {
  MAFIA_ACTION_TYPES,
  MAX_PLAYER_NAME_LENGTH,
  MAX_PLAYERS,
  MIN_PLAYERS,
  roleCountsForPlayerCount,
} from "./constants.ts";
import type {
  ActionActor,
  MafiaAction,
  MafiaActionType,
  MafiaEngineError,
  MafiaEngineResult,
  MafiaEvent,
  MafiaGameMode,
  MafiaGameState,
  MafiaLobbyState,
  MafiaNarratorState,
  MafiaNightAction,
  MafiaNightState,
  MafiaPlayer,
  MafiaPlayerState,
  MafiaPublicPlayer,
  MafiaPublicState,
  MafiaRole,
  MafiaTeam,
  MafiaTimelineEntry,
  MafiaVotingState,
  NightActionStatus,
  PlayerId,
  ResolvedNight,
  VoteMap,
} from "./types.ts";

export interface CreateMafiaGameOptions {
  gameId?: string;
  /** Informational only; the engine never branches on mode (spec 11). */
  mode: MafiaGameMode;
  /** Initial roster (Modes A/C). Multiplayer starts empty and JOINs fill it. */
  players?: Array<{ id: PlayerId; name: string }>;
  /**
   * Determinism injection point for role shuffling. Returns a uniform real in
   * [0, 1). Tests inject a seeded PRNG; defaults to Math.random.
   */
  random?: () => number;
}

/** The engine contract every presentation mode drives. See docs/mafia-engine.md §9. */
export interface MafiaEngine {
  /** Authoritative internal state — never ship this to a client. */
  getState(): MafiaGameState;
  /** Validate and apply one action. Synchronous, side-effect free outside own state. */
  dispatch(action: MafiaAction): MafiaEngineResult;
  /** Identical-for-everyone view. No hidden information. */
  getPublicState(): MafiaPublicState;
  /** Private view for exactly one player. Throws MafiaEngineError for unknown id. */
  getPlayerState(playerId: PlayerId): MafiaPlayerState;
  /** Full hidden truth for the narrator (Mode C). */
  getNarratorState(): MafiaNarratorState;
}

/** Error thrown by view methods that must fail (e.g. unknown player). */
export class MafiaEngineException extends Error implements MafiaEngineError {
  constructor(
    readonly code: MafiaEngineError["code"],
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Engine construction
// ---------------------------------------------------------------------------

export function createMafiaGame(options: CreateMafiaGameOptions): MafiaEngine {
  const random = options.random ?? Math.random;

  let state: MafiaGameState = initialLobby(options);

  return {
    getState: () => state,
    dispatch: (action: MafiaAction): MafiaEngineResult => {
      const update = applyAction(state, action, random);
      if (update.type === "err") {
        return { success: false, error: update.error };
      }
      state = update.state;
      return {
        success: true,
        stateChanged: update.changed,
        events: update.events,
      };
    },
    getPublicState: () => buildPublicState(state),
    getPlayerState: (playerId: PlayerId): MafiaPlayerState => {
      const player = state.players.find((p) => p.id === playerId);
      if (player === undefined) {
        throw new MafiaEngineException("PLAYER_NOT_FOUND", `Player ${playerId} is not in this game`);
      }
      return buildPlayerState(state, player);
    },
    getNarratorState: () => buildNarratorState(state),
  };
}

function initialLobby(options: CreateMafiaGameOptions): MafiaLobbyState {
  const players: MafiaPlayer[] = (options.players ?? []).map((p) => {
    const name = String(p.name).trim();
    if (p.id === "" || name.length < 1 || name.length > MAX_PLAYER_NAME_LENGTH) {
      throw new RangeError(`Invalid roster entry: id must be non-empty and name 1-${MAX_PLAYER_NAME_LENGTH} chars`);
    }
    return { id: p.id, name, ready: false, alive: true };
  });
  assertUniqueIds(players.map((p) => p.id));
  assertUniqueNames(players.map((p) => p.name));

  return {
    gameId: options.gameId ?? crypto.randomUUID(),
    mode: options.mode,
    players,
    timeline: [],
    lastResolvedNight: null,
    lastActingMafiaId: null,
    phase: "LOBBY",
    roles: {},
    winner: null,
    nightNumber: 0,
  };
}

// ---------------------------------------------------------------------------
// Update plumbing
// ---------------------------------------------------------------------------

type Update =
  | { type: "ok"; state: MafiaGameState; events: MafiaEvent[]; changed: boolean }
  | { type: "err"; error: MafiaEngineError };

function ok(state: MafiaGameState, events: MafiaEvent[], changed = true): Update {
  return { type: "ok", state, events, changed };
}

function err(code: MafiaEngineError["code"], message: string): Update {
  return { type: "err", error: { code, message } };
}

function applyAction(
  current: MafiaGameState,
  action: MafiaAction,
  random: () => number,
): Update {
  if (!isWellFormedAction(action)) {
    return err("INVALID_ACTION", "Unknown or malformed action");
  }
  switch (action.type) {
    case "JOIN":
      return join(current, action);
    case "LEAVE":
      return leave(current, action);
    case "READY":
      return setReady(current, action, true);
    case "UNREADY":
      return setReady(current, action, false);
    case "START_GAME":
      return startGame(current, action, random);
    case "ROLE_SEEN":
      return roleSeen(current, action);
    case "BEGIN_NIGHT":
      return beginNight(current, action);
    case "MAFIA_KILL":
      return submitNightAction(current, action, "MAFIA_KILL");
    case "DOCTOR_SAVE":
      return submitNightAction(current, action, "DOCTOR_SAVE");
    case "DETECTIVE_INVESTIGATE":
      return submitNightAction(current, action, "DETECTIVE_INVESTIGATE");
    case "RESOLVE_NIGHT":
      return resolveNight(current, action);
    case "START_DISCUSSION":
      return startDiscussion(current, action);
    case "START_VOTING":
      return startVoting(current, action);
    case "CAST_VOTE":
      return castVote(current, action);
    case "END_VOTING":
      return endVoting(current, action);
    case "ADVANCE_PHASE":
      return advancePhase(current, action);
    case "PLAY_AGAIN":
      return playAgain(current, action);
    case "PLAYER_UNAVAILABLE":
      return playerUnavailable(current, action);
  }
}

function isWellFormedAction(value: MafiaAction): boolean {
  const action = value as { type?: unknown; actor?: unknown };
  if (typeof action !== "object" || action === null) return false;
  if (typeof action.type !== "string") return false;
  if (!isMafiaActionType(action.type)) return false;

  const actor = action.actor as ActionActor;
  if (typeof actor !== "object" || actor === null) return false;
  if (actor.type === "PLAYER") return typeof actor.playerId === "string";
  return actor.type === "NARRATOR" || actor.type === "SYSTEM";
}

const KNOWN_ACTION_TYPES = MAFIA_ACTION_TYPES;

function isMafiaActionType(value: string): value is MafiaActionType {
  return (KNOWN_ACTION_TYPES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function playerActorId(actor: ActionActor): PlayerId | null {
  return actor.type === "PLAYER" ? actor.playerId : null;
}

function findPlayer(state: MafiaGameState, playerId: PlayerId): MafiaPlayer | undefined {
  return state.players.find((p) => p.id === playerId);
}

function roleOf(state: MafiaGameState, playerId: PlayerId): MafiaRole | null {
  return state.roles[playerId] ?? null;
}

function isAlive(state: MafiaGameState, playerId: PlayerId): boolean {
  return findPlayer(state, playerId)?.alive ?? false;
}

function livingMafiaCount(state: MafiaGameState): number {
  return state.players.filter((p) => p.alive && roleOf(state, p.id) === "MAFIA").length;
}

function livingCount(state: MafiaGameState): number {
  return state.players.filter((p) => p.alive).length;
}

function assertUniqueIds(ids: PlayerId[]): void {
  if (new Set(ids).size !== ids.length) {
    throw new RangeError("Duplicate player id in roster");
  }
}

function assertUniqueNames(names: string[]): void {
  if (new Set(names).size !== names.length) {
    throw new RangeError("Duplicate player name in roster");
  }
}

function clearReady(players: MafiaPlayer[]): MafiaPlayer[] {
  return players.map((p) => (p.ready ? { ...p, ready: false } : p));
}

function setPlayerAlive(players: MafiaPlayer[], playerId: PlayerId, alive: boolean): MafiaPlayer[] {
  return players.map((p) => (p.id === playerId ? { ...p, alive } : p));
}

function withRoles(
  state: MafiaGameState,
  patch: Record<string, unknown>,
): MafiaGameState {
  return { ...state, ...patch } as MafiaGameState;
}

/** Deterministic Fisher-Yates shuffle driven by the injected RNG. */
function shuffle<T>(items: T[], random: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = result[i];
    if (result[i] !== undefined) result[i] = result[j] as T;
    if (result[j] !== undefined) result[j] = tmp as T;
  }
  return result;
}

function assignRoles(players: MafiaPlayer[], random: () => number): Record<PlayerId, MafiaRole> {
  const counts = roleCountsForPlayerCount(players.length);
  const slots: MafiaRole[] = [
    ...Array<MafiaRole>(counts.mafia).fill("MAFIA"),
    ...Array<MafiaRole>(counts.doctor).fill("DOCTOR"),
    ...Array<MafiaRole>(counts.detective).fill("DETECTIVE"),
    ...Array<MafiaRole>(counts.villager).fill("VILLAGER"),
  ];
  const shuffled = shuffle(slots, random);
  const roles: Record<PlayerId, MafiaRole> = {};
  players.forEach((player, index) => {
    const role = shuffled[index];
    if (role === undefined) throw new Error("Role shuffle produced fewer slots than players");
    roles[player.id] = role;
  });
  return roles;
}

/** First living Mafia by roster order (tie-breaker for the acting role). */
function firstLivingMafia(state: MafiaGameState): PlayerId | null {
  for (const player of state.players) {
    if (player.alive && roleOf(state, player.id) === "MAFIA") return player.id;
  }
  return null;
}

function roleName(type: "MAFIA_KILL" | "DOCTOR_SAVE" | "DETECTIVE_INVESTIGATE"): string {
  switch (type) {
    case "MAFIA_KILL":
      return "Mafia";
    case "DOCTOR_SAVE":
      return "Doctor";
    case "DETECTIVE_INVESTIGATE":
      return "Detective";
  }
}

/** The living player who owns a given night role, or null. */
function roleHolderId(
  state: MafiaGameState,
  type: "MAFIA_KILL" | "DOCTOR_SAVE" | "DETECTIVE_INVESTIGATE",
): PlayerId | null {
  const role: MafiaRole = type === "MAFIA_KILL" ? "MAFIA" : type === "DOCTOR_SAVE" ? "DOCTOR" : "DETECTIVE";
  for (const player of state.players) {
    if (player.alive && roleOf(state, player.id) === role) return player.id;
  }
  return null;
}

/** Acting Mafia: carry the previous acting role while alive, else first living Mafia. */
function nextActingMafia(state: MafiaGameState): PlayerId | null {
  const previous = state.lastActingMafiaId;
  if (previous !== null && isAlive(state, previous) && roleOf(state, previous) === "MAFIA") {
    return previous;
  }
  return firstLivingMafia(state);
}

function gameOver(
  state: MafiaGameState,
  winner: MafiaTeam,
): { state: MafiaGameState; events: MafiaEvent[] } {
  const timeline: MafiaTimelineEntry[] = [...state.timeline, { kind: "GAME_OVER", winner }];
  const next = withRoles(state, {
    phase: "GAME_OVER",
    winner,
    timeline,
  });
  const events: MafiaEvent[] = [
    { type: "PHASE_CHANGED", from: state.phase, to: "GAME_OVER" },
    { type: "GAME_OVER", winner },
  ];
  return { state: next, events };
}

/**
 * Win check — only ever called at the two allowed moments (spec 8.3):
 * immediately after night resolution and immediately after a vote elimination.
 */
function detectWinner(state: MafiaGameState): MafiaTeam | null {
  const mafia = livingMafiaCount(state);
  if (mafia === 0) return "TOWN";
  if (mafia >= livingCount(state) - mafia) return "MAFIA";
  return null;
}

// ---------------------------------------------------------------------------
// 1. Game creation & 2. player lifecycle
// ---------------------------------------------------------------------------

function join(state: MafiaGameState, action: Extract<MafiaAction, { type: "JOIN" }>): Update {
  if (state.phase !== "LOBBY") return err("INVALID_PHASE", "Players can only join in the lobby");
  const self = playerActorId(action.actor);
  if (self !== null && self !== action.player.id) {
    return err("INVALID_ACTOR", "A player may only join as themselves");
  }

  const { id, name } = action.player;
  const trimmed = String(name).trim();
  if (id === "" || trimmed.length < 1 || trimmed.length > MAX_PLAYER_NAME_LENGTH) {
    return err("INVALID_PLAYER_NAME", `Name must be 1-${MAX_PLAYER_NAME_LENGTH} characters`);
  }
  if (state.players.some((p) => p.id === id)) {
    return err("PLAYER_ALREADY_JOINED", "That player id is already in the game");
  }
  if (state.players.some((p) => p.name === trimmed)) {
    return err("NAME_TAKEN", "That name is already taken");
  }
  if (state.players.length + 1 > MAX_PLAYERS) {
    return err("GAME_FULL", `Room is full (max ${MAX_PLAYERS})`);
  }

  const player: MafiaPlayer = { id, name: trimmed, ready: false, alive: true };
  const next = withRoles(state, {
    // Readiness is cleared on any lobby change (spec 6.3).
    players: [...clearReady(state.players), player],
  });
  return ok(next, [{ type: "PLAYER_JOINED", playerId: id }]);
}

function leave(state: MafiaGameState, action: Extract<MafiaAction, { type: "LEAVE" }>): Update {
  if (state.phase !== "LOBBY") return err("INVALID_PHASE", "LEAVE is only valid in the lobby");
  const self = playerActorId(action.actor);
  if (self !== null && self !== action.playerId) {
    return err("INVALID_ACTOR", "A player may only leave as themselves");
  }
  if (findPlayer(state, action.playerId) === undefined) {
    return err("PLAYER_NOT_FOUND", "Player is not in this game");
  }
  const next = withRoles(state, {
    players: clearReady(state.players.filter((p) => p.id !== action.playerId)),
  });
  return ok(next, [{ type: "PLAYER_LEFT", playerId: action.playerId }]);
}

function setReady(
  state: MafiaGameState,
  action: Extract<MafiaAction, { type: "READY" | "UNREADY" }>,
  value: boolean,
): Update {
  if (state.phase !== "LOBBY") return err("INVALID_PHASE", "Readiness only changes in the lobby");
  const self = playerActorId(action.actor);
  if (self !== null && self !== action.playerId) {
    return err("INVALID_ACTOR", "A player may only toggle their own readiness");
  }
  const player = findPlayer(state, action.playerId);
  if (player === undefined) return err("PLAYER_NOT_FOUND", "Player is not in this game");
  if (player.ready === value) {
    return ok(state, [], false); // idempotent no-op
  }
  const next = withRoles(state, {
    players: state.players.map((p) => (p.id === action.playerId ? { ...p, ready: value } : p)),
  });
  return ok(next, [
    { type: value ? "PLAYER_READY" : "PLAYER_UNREADY", playerId: action.playerId },
  ]);
}

// ---------------------------------------------------------------------------
// 3. START_GAME + deterministic role assignment
// ---------------------------------------------------------------------------

function startGame(
  state: MafiaGameState,
  action: Extract<MafiaAction, { type: "START_GAME" }>,
  random: () => number,
): Update {
  if (state.phase !== "LOBBY") return err("INVALID_PHASE", "Game can only start from the lobby");
  if (action.actor.type === "PLAYER") return err("INVALID_ACTOR", "Only the advance authority may start the game");
  if (state.players.length < MIN_PLAYERS) {
    return err("NOT_ENOUGH_PLAYERS", `START_GAME needs at least ${MIN_PLAYERS} players`);
  }
  if (state.players.some((p) => !p.ready)) {
    return err("NOT_ALL_READY", "Every player must be ready before starting");
  }

  const roles = assignRoles(state.players, random);
  const next = withRoles(state, {
    phase: "ROLE_REVEAL",
    roles,
    roleSeen: Object.fromEntries(state.players.map((p) => [p.id, false])),
    timeline: [...state.timeline, { kind: "GAME_STARTED" }],
  });
  return ok(next, [
    { type: "GAME_STARTED", roles },
    { type: "PHASE_CHANGED", from: "LOBBY", to: "ROLE_REVEAL" },
  ]);
}

// ---------------------------------------------------------------------------
// 4. ROLE_REVEAL
// ---------------------------------------------------------------------------

function roleSeen(state: MafiaGameState, action: Extract<MafiaAction, { type: "ROLE_SEEN" }>): Update {
  if (state.phase !== "ROLE_REVEAL") return err("INVALID_PHASE", "ROLE_SEEN is only valid during role reveal");
  if (action.actor.type === "SYSTEM") return err("INVALID_ACTOR", "SYSTEM cannot confirm a role on a player's behalf");
  const self = playerActorId(action.actor);
  if (self !== null && self !== action.playerId) {
    return err("INVALID_ACTOR", "A player may only confirm their own role");
  }
  if (findPlayer(state, action.playerId) === undefined) {
    return err("PLAYER_NOT_FOUND", "Player is not in this game");
  }
  if (state.roleSeen[action.playerId] === true) {
    return ok(state, [], false); // idempotent no-op
  }

  const seen: Record<PlayerId, boolean> = { ...state.roleSeen, [action.playerId]: true };
  const marked = withRoles(state, { roleSeen: seen });
  const events: MafiaEvent[] = [{ type: "ROLE_SEEN", playerId: action.playerId }];

  const allSeen = state.players.every((p) => seen[p.id] === true);
  if (allSeen) {
    // System auto-advances to the first night.
    const nightOutcome = enterNight(marked);
    return ok(nightOutcome.state, [...events, ...nightOutcome.events]);
  }
  return ok(marked, events);
}

function beginNight(state: MafiaGameState, action: Extract<MafiaAction, { type: "BEGIN_NIGHT" }>): Update {
  if (action.actor.type === "PLAYER") return err("INVALID_ACTOR", "Players cannot begin the night");
  if (state.phase !== "ROLE_REVEAL") {
    return err("INVALID_PHASE", "BEGIN_NIGHT is only valid during role reveal");
  }
  const outcome = enterNight(state);
  return ok(outcome.state, outcome.events);
}

function enterNight(state: MafiaGameState): { state: MafiaGameState; events: MafiaEvent[] } {
  const nightNumber = state.nightNumber + 1;
  const actingMafiaId = nextActingMafia(state);
  if (actingMafiaId === null) throw new Error("Cannot begin night without a living Mafia");
  const nightActions = {
    nightNumber,
    actingMafiaId,
    kill: { status: "NOT_ACTED", targetId: null },
    save: { status: "NOT_ACTED", targetId: null },
    investigate: { status: "NOT_ACTED", targetId: null },
  } satisfies MafiaNightState["nightActions"];

  const next = withRoles(state, {
    phase: "NIGHT",
    nightNumber,
    actingMafiaId,
    nightActions,
    lastActingMafiaId: actingMafiaId,
  });
  const events: MafiaEvent[] = [
    { type: "PHASE_CHANGED", from: state.phase, to: "NIGHT" },
    { type: "NIGHT_STARTED", nightNumber, actingMafiaId },
  ];
  return { state: next, events };
}

// ---------------------------------------------------------------------------
// 5. Night action submission
// ---------------------------------------------------------------------------

const NIGHT_SLOTS: Record<"MAFIA_KILL" | "DOCTOR_SAVE" | "DETECTIVE_INVESTIGATE", "kill" | "save" | "investigate"> = {
  MAFIA_KILL: "kill",
  DOCTOR_SAVE: "save",
  DETECTIVE_INVESTIGATE: "investigate",
};

function submitNightAction(
  state: MafiaGameState,
  action: Extract<
    MafiaAction,
    { type: "MAFIA_KILL" | "DOCTOR_SAVE" | "DETECTIVE_INVESTIGATE" }
  >,
  type: "MAFIA_KILL" | "DOCTOR_SAVE" | "DETECTIVE_INVESTIGATE",
): Update {
  if (state.phase !== "NIGHT") return err("INVALID_PHASE", `Cannot ${type} outside the night`);

  const slotKey = NIGHT_SLOTS[type];
  const slot = state.nightActions[slotKey];
  if (slot.status !== "NOT_ACTED") {
    return err("ACTION_ALREADY_SUBMITTED", `${type} was already recorded this night`);
  }

  // Resident authority: a PLAYER actor must be the right living player.
  const self = playerActorId(action.actor);
  let actingPlayerId: PlayerId;
  if (self !== null) {
    actingPlayerId = self;
    const player = findPlayer(state, actingPlayerId);
    if (player === undefined) return err("PLAYER_NOT_FOUND", "Acting player is not in this game");
    if (!player.alive) return err("PLAYER_DEAD", "Dead players cannot perform night actions");
    if (type === "MAFIA_KILL") {
      if (roleOf(state, actingPlayerId) !== "MAFIA") return err("INVALID_ACTOR", "Only Mafia can submit MAFIA_KILL");
      if (actingPlayerId !== state.actingMafiaId) return err("INVALID_ACTOR", "Only the acting Mafia may kill");
    } else if (type === "DOCTOR_SAVE" && roleOf(state, actingPlayerId) !== "DOCTOR") {
      return err("INVALID_ACTOR", "Only the Doctor can submit DOCTOR_SAVE");
    } else if (type === "DETECTIVE_INVESTIGATE" && roleOf(state, actingPlayerId) !== "DETECTIVE") {
      return err("INVALID_ACTOR", "Only the Detective can submit DETECTIVE_INVESTIGATE");
    }
  } else {
    // NARRATOR records the actor's choice on their behalf (spec 6.7-6.9).
    // Attribute the record to the real role-holder for events/views.
    const holder = roleHolderId(state, type);
    if (holder === null) return err("INVALID_ACTOR", `No living ${roleName(type)} to record action for`);
    actingPlayerId = holder;
  }

  // Target validation.
  const targetId = action.targetId;
  if (type === "MAFIA_KILL") {
    if (targetId === state.actingMafiaId) return err("INVALID_TARGET", "The acting Mafia cannot kill themselves");
  }
  if (targetId === null) {
    if (type !== "DOCTOR_SAVE") return err("INVALID_TARGET", "This action requires a target");
    // Doctor passes (skip).
    const recorded: MafiaNightAction = { status: "PASSED", targetId: null };
    const next = recordNightAction(state, slotKey, recorded);
    return ok(next, [
      { type: "NIGHT_ACTION_RECORDED", actionType: type, playerId: actingPlayerId, action: recorded },
    ]);
  }
  const target = findPlayer(state, targetId);
  if (target === undefined) return err("PLAYER_NOT_FOUND", "Target is not in this game");
  if (!target.alive) return err("INVALID_TARGET", "Target is dead");

  if (type === "DOCTOR_SAVE") {
    const previous = state.lastResolvedNight?.saveTargetId ?? null;
    if (previous !== null && targetId === previous) {
      return err("DOCTOR_REPEAT_GUARD", "The Doctor cannot save the same player on consecutive nights");
    }
  }

  const recorded: MafiaNightAction = { status: "SUBMITTED", targetId };
  const next = recordNightAction(state, slotKey, recorded);
  return ok(next, [
    { type: "NIGHT_ACTION_RECORDED", actionType: type, playerId: actingPlayerId, action: recorded },
  ]);
}

function recordNightAction(
  state: MafiaNightState,
  slotKey: "kill" | "save" | "investigate",
  recorded: MafiaNightAction,
): MafiaGameState {
  return withRoles(state, {
    nightActions: { ...state.nightActions, [slotKey]: recorded },
  });
}

// ---------------------------------------------------------------------------
// 6. Night resolution
// ---------------------------------------------------------------------------

function resolveNight(
  state: MafiaGameState,
  action: Extract<MafiaAction, { type: "RESOLVE_NIGHT" | "ADVANCE_PHASE" }>,
  force = false,
): Update {
  if (state.phase !== "NIGHT") return err("INVALID_PHASE", "Night is not in progress");
  if (action.actor.type === "PLAYER") return err("INVALID_ACTOR", "Players cannot resolve the night");

  const kill = state.nightActions.kill;
  if (kill.status === "NOT_ACTED" && !force) {
    return err("MISSING_REQUIRED_ACTION", "The Mafia kill is required; force-resolve (ADVANCE_PHASE) to skip it");
  }

  let nightActions = state.nightActions;
  const events: MafiaEvent[] = [];
  if (force) {
    for (const [key, slot] of Object.entries(nightActions) as Array<[keyof MafiaNightState["nightActions"], MafiaNightAction]>) {
      if (slot.status === "NOT_ACTED") {
        nightActions = { ...nightActions, [key]: { status: "SKIPPED", targetId: null } };
      }
    }
    events.push({ type: "PLAYER_UNAVAILABLE", playerId: state.actingMafiaId, reason: "TIMED_OUT" });
  }

  const resolved: ResolvedNight = computeResolution(state, nightActions);
  const killedPlayerIds = resolved.killedPlayerIds;
  let players = state.players;
  for (const id of killedPlayerIds) {
    players = setPlayerAlive(players, id, false);
  }

  let next = withRoles(state, {
    phase: "MORNING",
    players,
    lastResolvedNight: resolved,
    timeline: [...state.timeline, { kind: "NIGHT_RESOLVED", nightNumber: resolved.nightNumber, killedPlayerIds }],
  }) as MafiaGameState;

  // Win check happens immediately after night resolution (spec 8.3). If the
  // game is decided, MORNING/DISCUSSION never happen; SYSTEM takes it to GAME_OVER.
  const winner = detectWinner(next);
  if (winner !== null) {
    const over = gameOver(next, winner);
    return ok(over.state, [
      ...events,
      { type: "NIGHT_RESOLVED", resolvedNight: resolved },
      ...over.events,
    ]);
  }

  return ok(next, [
    ...events,
    { type: "NIGHT_RESOLVED", resolvedNight: resolved },
    { type: "PHASE_CHANGED", from: "NIGHT", to: "MORNING" },
  ]);
}

function computeResolution(state: MafiaGameState, nightActions: MafiaNightState["nightActions"]): ResolvedNight {
  const kill = nightActions.kill;
  const save = nightActions.save;
  const investigate = nightActions.investigate;

  const killTargetId = kill.status === "SUBMITTED" ? kill.targetId : null;
  const saveTargetId = save.status === "SUBMITTED" ? save.targetId : null;

  const doctor = state.players.find((p) => roleOf(state, p.id) === "DOCTOR");
  const doctorAlive = doctor?.alive ?? false;

  // Death happens iff a kill was submitted AND (doctor is dead OR save misses the target).
  const deathApplied = killTargetId !== null && (saveTargetId !== killTargetId || !doctorAlive);
  const killedPlayerIds: PlayerId[] = deathApplied && killTargetId !== null ? [killTargetId] : [];
  const saveApplied = killTargetId !== null && saveTargetId === killTargetId && doctorAlive;

  const investigatedTargetId = investigate.status === "SUBMITTED" ? investigate.targetId : null;
  const investigationVerdict =
    investigatedTargetId !== null ? (roleOf(state, investigatedTargetId) === "MAFIA") : null;

  return {
    nightNumber: state.nightNumber,
    killTargetId,
    saveTargetId,
    saveApplied,
    doctorAlive,
    killedPlayerIds,
    investigatedTargetId,
    investigationVerdict,
  };
}

// ---------------------------------------------------------------------------
// 8. Discussion, 9-11. Voting and vote resolution
// ---------------------------------------------------------------------------

function startDiscussion(
  state: MafiaGameState,
  action: Extract<MafiaAction, { type: "START_DISCUSSION" }>,
): Update {
  if (action.actor.type === "PLAYER") return err("INVALID_ACTOR", "Players cannot advance the phase");
  if (state.phase !== "MORNING") return err("INVALID_PHASE", "Discussion starts from the morning");
  const next = withRoles(state, { phase: "DISCUSSION" });
  return ok(next, [
    { type: "DISCUSSION_STARTED", nightNumber: state.nightNumber },
    { type: "PHASE_CHANGED", from: "MORNING", to: "DISCUSSION" },
  ]);
}

function startVoting(state: MafiaGameState, action: Extract<MafiaAction, { type: "START_VOTING" }>): Update {
  if (action.actor.type === "PLAYER") return err("INVALID_ACTOR", "Players cannot start voting");
  if (state.phase !== "DISCUSSION") return err("INVALID_PHASE", "Voting can only start from discussion");
  const next = withRoles(state, { phase: "VOTING", votes: {} });
  return ok(next, [
    { type: "VOTING_STARTED", nightNumber: state.nightNumber },
    { type: "PHASE_CHANGED", from: "DISCUSSION", to: "VOTING" },
  ]);
}

function castVote(state: MafiaGameState, action: Extract<MafiaAction, { type: "CAST_VOTE" }>): Update {
  if (state.phase !== "VOTING") return err("INVALID_PHASE", "Votes are only accepted during voting");

  const self = playerActorId(action.actor);
  const voterId = self ?? action.voterId;
  if (self !== null && self !== action.voterId) {
    return err("INVALID_ACTOR", "A player may only cast their own vote");
  }
  const voter = findPlayer(state, voterId);
  if (voter === undefined) return err("PLAYER_NOT_FOUND", "Voter is not in this game");
  if (!voter.alive) return err("PLAYER_DEAD", "Dead players cannot vote");

  const target = findPlayer(state, action.targetId);
  if (target === undefined) return err("PLAYER_NOT_FOUND", "Target is not in this game");
  if (!target.alive) return err("INVALID_TARGET", "Votes must target a living player");

  if (state.votes[voterId] !== undefined) {
    return err("ACTION_ALREADY_SUBMITTED", `${voterId} already voted this round`);
  }

  const votes: VoteMap = { ...state.votes, [voterId]: action.targetId };
  const events: MafiaEvent[] = [
    { type: "VOTE_CAST", voterId, targetId: action.targetId },
  ];
  const next = withRoles(state, { votes }) as MafiaVotingState;

  const living = state.players.filter((p) => p.alive).length;
  if (Object.keys(votes).length >= living) {
    const result = enterVoteResult(next);
    return ok(result.state, [...events, ...result.events]);
  }
  return ok(next, events);
}

function endVoting(state: MafiaGameState, action: Extract<MafiaAction, { type: "END_VOTING" }>): Update {
  if (state.phase !== "VOTING") return err("INVALID_PHASE", "Voting is not in progress");
  if (action.actor.type === "PLAYER") return err("INVALID_ACTOR", "Players cannot end voting");
  const result = enterVoteResult(state);
  return ok(result.state, result.events);
}

function enterVoteResult(state: MafiaVotingState): { state: MafiaGameState; events: MafiaEvent[] } {
  const votes = state.votes;
  const elimination = deriveElimination(votes);
  const events: MafiaEvent[] = [
    { type: "PHASE_CHANGED", from: "VOTING", to: "VOTE_RESULT" },
    { type: "VOTING_RESOLVED", elimination },
  ];

  let next = withRoles(state, {
    phase: "VOTE_RESULT",
    votes,
    elimination,
  });

  const eliminatedId = elimination.eliminatedPlayerId;
  if (eliminatedId !== null) {
    events.push({ type: "PLAYER_ELIMINATED", playerId: eliminatedId });
    next = withRoles(next, {
      players: setPlayerAlive(next.players, eliminatedId, false),
      timeline: [...next.timeline, { kind: "PLAYER_ELIMINATED", nightNumber: next.nightNumber, playerId: eliminatedId }],
    });
  }

  const winner = detectWinner(next);
  if (winner !== null) {
    const over = gameOver(next, winner);
    return { state: over.state, events: [...events, ...over.events] };
  }
  return { state: next, events };
}

function deriveElimination(votes: VoteMap): { eliminatedPlayerId: PlayerId | null; tie: boolean } {
  const tally = new Map<PlayerId, number>();
  for (const targetId of Object.values(votes)) {
    if (targetId === undefined) continue;
    tally.set(targetId, (tally.get(targetId) ?? 0) + 1);
  }
  if (tally.size === 0) return { eliminatedPlayerId: null, tie: false };

  let max = 0;
  for (const count of tally.values()) {
    if (count > max) max = count;
  }
  const leaders = [...tally.entries()].filter(([, count]) => count === max).map(([id]) => id);
  if (leaders.length === 1) {
    const winner = leaders[0];
    if (winner === undefined) return { eliminatedPlayerId: null, tie: false };
    return { eliminatedPlayerId: winner, tie: false };
  }
  return { eliminatedPlayerId: null, tie: true };
}

// ---------------------------------------------------------------------------
// 12-13. GAME_OVER / PLAY_AGAIN
// ---------------------------------------------------------------------------

function playAgain(state: MafiaGameState, action: Extract<MafiaAction, { type: "PLAY_AGAIN" }>): Update {
  if (state.phase !== "GAME_OVER") return err("INVALID_PHASE", "PLAY_AGAIN is only valid after a game ends");
  if (action.actor.type === "PLAYER") return err("INVALID_ACTOR", "Only the advance authority can restart");
  // Keep the roster; reset all game state (review decision).
  const next: MafiaLobbyState = {
    gameId: state.gameId,
    mode: state.mode,
    players: state.players.map((p) => ({ ...p, alive: true, ready: false })),
    timeline: [],
    lastResolvedNight: null,
    lastActingMafiaId: null,
    phase: "LOBBY",
    roles: {},
    winner: null,
    nightNumber: 0,
  };
  return ok(next, [{ type: "PHASE_CHANGED", from: "GAME_OVER", to: "LOBBY" }]);
}

// ---------------------------------------------------------------------------
// ADVANCE_PHASE meta-action
// ---------------------------------------------------------------------------

function advancePhase(state: MafiaGameState, action: Extract<MafiaAction, { type: "ADVANCE_PHASE" }>): Update {
  if (action.actor.type === "PLAYER") return err("INVALID_ACTOR", "Players cannot fast-forward phases");
  switch (state.phase) {
    case "LOBBY":
      return ok(state, [], false); // permitted no-op guard (spec 5.1)
    case "ROLE_REVEAL": {
      const outcome = enterNight(state);
      return ok(outcome.state, outcome.events);
    }
    case "NIGHT":
      return resolveNight(state, action, true);
    case "MORNING": {
      const next = withRoles(state, { phase: "DISCUSSION" });
      return ok(next, [
        { type: "DISCUSSION_STARTED", nightNumber: state.nightNumber },
        { type: "PHASE_CHANGED", from: "MORNING", to: "DISCUSSION" },
      ]);
    }
    case "DISCUSSION":
      return startVoting(state, { type: "START_VOTING", actor: action.actor });
    case "VOTING":
      return endVoting(state, { type: "END_VOTING", actor: action.actor });
    case "VOTE_RESULT": {
      const outcome = enterNight(state);
      return ok(outcome.state, outcome.events);
    }
    case "GAME_OVER":
      return err("INVALID_PHASE", "ADVANCE_PHASE is not valid after the game ends");
  }
}

// ---------------------------------------------------------------------------
// PLAYER_UNAVAILABLE (disconnect / timeout)
// ---------------------------------------------------------------------------

function playerUnavailable(
  state: MafiaGameState,
  action: Extract<MafiaAction, { type: "PLAYER_UNAVAILABLE" }>,
): Update {
  if (action.actor.type === "PLAYER") return err("INVALID_ACTOR", "SYSTEM/NARRATOR report availability");
  if (findPlayer(state, action.playerId) === undefined) {
    return err("PLAYER_NOT_FOUND", "Player is not in this game");
  }
  if (state.phase !== "NIGHT") {
    return ok(state, [], false); // no pending action to skip
  }
  const role = roleOf(state, action.playerId);
  const slotKey =
    action.playerId === state.actingMafiaId ? "kill" : role === "DOCTOR" ? "save" : role === "DETECTIVE" ? "investigate" : null;
  if (slotKey === null) {
    return ok(state, [], false); // that player has no night input
  }
  const slot = state.nightActions[slotKey];
  if (slot.status !== "NOT_ACTED") {
    return ok(state, [], false); // already submitted/passed/skipped
  }
  const next = recordNightAction(state, slotKey, { status: "SKIPPED", targetId: null });
  return ok(next, [{ type: "PLAYER_UNAVAILABLE", playerId: action.playerId, reason: action.reason }]);
}

// ---------------------------------------------------------------------------
// View derivation
// ---------------------------------------------------------------------------

function publicPlayers(state: MafiaGameState): MafiaPublicPlayer[] {
  return state.players.map((p) => ({
    id: p.id,
    name: p.name,
    alive: p.alive,
    ready: p.ready,
  }));
}

function buildPublicState(state: MafiaGameState): MafiaPublicState {
  const base = {
    gameId: state.gameId,
    phase: state.phase,
    nightNumber: state.nightNumber,
    players: publicPlayers(state),
    winner: state.phase === "GAME_OVER" ? state.winner : null,
  };

  switch (state.phase) {
    case "LOBBY":
    case "ROLE_REVEAL":
    case "NIGHT":
    case "DISCUSSION":
      return { ...base, voting: null, morningDeaths: null, elimination: null };
    case "MORNING":
      return {
        ...base,
        voting: null,
        morningDeaths: state.lastResolvedNight?.killedPlayerIds ?? [],
        elimination: null,
      };
    case "VOTING":
      return {
        ...base,
        voting: { cast: Object.keys(state.votes).length, total: livingCount(state) },
        morningDeaths: null,
        elimination: null,
      };
    case "VOTE_RESULT":
      return {
        ...base,
        voting: null,
        morningDeaths: null,
        elimination: { eliminatedPlayerId: state.elimination.eliminatedPlayerId },
      };
    case "GAME_OVER":
      return { ...base, voting: null, morningDeaths: null, elimination: null };
  }
}

function buildPlayerState(state: MafiaGameState, player: MafiaPlayer): MafiaPlayerState {
  return {
    playerId: player.id,
    name: player.name,
    role: roleOf(state, player.id),
    alive: player.alive,
    ready: player.ready,
    roleSeen: state.phase === "LOBBY" ? false : state.phase === "ROLE_REVEAL" ? (state.roleSeen[player.id] ?? false) : true,
    phase: state.phase,
    nightNumber: state.nightNumber,
    availableActions: availableActionsFor(state, player),
    ownNightAction: ownNightActionStatus(state, player),
    ownPrivateNightResult: ownNightResult(state, player),
    ownVoteTargetId: ownVoteTarget(state, player.id),
  };
}

function roleActionAvailable(state: MafiaGameState, player: MafiaPlayer): MafiaActionType | null {
  if (!player.alive) return null;
  const phase = state.phase;
  if (phase === "LOBBY") return player.ready ? "UNREADY" : "READY";
  if (phase === "ROLE_REVEAL") return state.roleSeen[player.id] === true ? null : "ROLE_SEEN";
  if (phase === "NIGHT") {
    const role = roleOf(state, player.id);
    const acting = player.id === state.actingMafiaId;
    if (role === "MAFIA" && acting && state.nightActions.kill.status === "NOT_ACTED") return "MAFIA_KILL";
    if (role === "DOCTOR" && state.nightActions.save.status === "NOT_ACTED") return "DOCTOR_SAVE";
    if (role === "DETECTIVE" && state.nightActions.investigate.status === "NOT_ACTED") return "DETECTIVE_INVESTIGATE";
    return null;
  }
  if (phase === "VOTING" && state.votes[player.id] === undefined) return "CAST_VOTE";
  return null;
}

function availableActionsFor(state: MafiaGameState, player: MafiaPlayer): readonly MafiaActionType[] {
  const action = roleActionAvailable(state, player);
  return action === null ? [] : [action];
}

function ownNightActionStatus(state: MafiaGameState, player: MafiaPlayer): NightActionStatus | null {
  if (state.phase !== "NIGHT") return null;
  const slotKey =
    player.id === state.actingMafiaId ? "kill" : roleOf(state, player.id) === "DOCTOR" ? "save" : roleOf(state, player.id) === "DETECTIVE" ? "investigate" : null;
  return slotKey === null ? null : state.nightActions[slotKey].status;
}

function ownNightResult(
  state: MafiaGameState,
  player: MafiaPlayer,
): MafiaPlayerState["ownPrivateNightResult"] {
  const resolved = state.lastResolvedNight;
  if (resolved === null) return null;
  const role = roleOf(state, player.id);
  if (role === "DETECTIVE" && resolved.investigatedTargetId !== null) {
    return {
      kind: "INVESTIGATION",
      nightNumber: resolved.nightNumber,
      targetId: resolved.investigatedTargetId,
      isMafia: resolved.investigationVerdict === true,
    };
  }
  if (role === "DOCTOR") {
    return {
      kind: "HEAL",
      nightNumber: resolved.nightNumber,
      applied: resolved.saveApplied,
      targetId: resolved.saveTargetId,
    };
  }
  return null;
}

function ownVoteTarget(state: MafiaGameState, playerId: PlayerId): PlayerId | null {
  if (state.phase !== "VOTING" && state.phase !== "VOTE_RESULT") return null;
  return state.votes[playerId] ?? null;
}

function buildNarratorState(state: MafiaGameState): MafiaNarratorState {
  const shared = {
    roles: state.roles,
    readyState: Object.fromEntries(state.players.map((p) => [p.id, p.ready])),
    roleSeen: Object.fromEntries(state.players.map((p) => [p.id, state.phase === "LOBBY" ? false : state.phase === "ROLE_REVEAL" ? (state.roleSeen[p.id] ?? false) : true])),
    lastResolvedNight: state.lastResolvedNight,
    timeline: state.timeline,
  };

  switch (state.phase) {
    case "LOBBY":
    case "ROLE_REVEAL":
      return {
        publicState: buildPublicState(state),
        ...shared,
        actingMafiaId: null,
        nightActions: null,
        votes: null,
        lastElimination: null,
      };
    case "NIGHT":
      return {
        publicState: buildPublicState(state),
        ...shared,
        actingMafiaId: state.actingMafiaId,
        nightActions: state.nightActions,
        votes: null,
        lastElimination: null,
      };
    case "MORNING":
      return {
        publicState: buildPublicState(state),
        ...shared,
        actingMafiaId: null,
        nightActions: null,
        votes: null,
        lastElimination: null,
      };
    case "DISCUSSION":
      return {
        publicState: buildPublicState(state),
        ...shared,
        actingMafiaId: null,
        nightActions: null,
        votes: null,
        lastElimination: null,
      };
    case "VOTING":
    case "VOTE_RESULT":
      return {
        publicState: buildPublicState(state),
        ...shared,
        actingMafiaId: null,
        nightActions: null,
        votes: state.votes,
        lastElimination: state.phase === "VOTE_RESULT" ? state.elimination : null,
      };
    case "GAME_OVER":
      return {
        publicState: buildPublicState(state),
        ...shared,
        actingMafiaId: null,
        nightActions: null,
        votes: null,
        lastElimination: null,
      };
  }
}