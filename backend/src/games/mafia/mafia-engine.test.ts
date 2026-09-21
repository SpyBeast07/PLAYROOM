/**
 * Phase 10A contract verification. These tests check the contract, not gameplay
 * rules: types instantiates, constants are exhaustive and match mafia-spec.md,
 * view boundaries exist, and the engine shell is usable without any framework.
 * Rule behavior (START_GAME, NIGHT, VOTING, wins) is Phase 10B's test concern.
 */
import { expect, test } from "bun:test";
import {
  MAX_PLAYERS,
  MAFIA_ACTION_TYPES,
  MAFIA_MODES,
  MAFIA_PHASES,
  MAFIA_ROLES,
  MAFIA_TEAMS,
  MIN_PLAYERS,
  NIGHT_ACTION_ORDER,
  ROLE_DISTRIBUTION,
  roleCountsForPlayerCount,
  totalPlayerCount,
} from "./constants.ts";
import { createMafiaGame, type MafiaEngine, MafiaEngineException } from "./mafia-engine.ts";
import type {
  ActionActor,
  MafiaAction,
  MafiaActionType,
  MafiaGameState,
  MafiaPhase,
  MafiaRole,
  MafiaTeam,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test("player limits match the specification", () => {
  expect(MIN_PLAYERS).toBe(4);
  expect(MAX_PLAYERS).toBe(20);
});

test("role distribution table matches mafia-spec.md section 4", () => {
  const expected: Record<number, [number, number]> = {
    4: [1, 1], 5: [1, 2], 6: [1, 3], 7: [1, 4],
    8: [2, 4], 9: [2, 5], 10: [2, 6], 11: [2, 7],
    12: [3, 7], 13: [3, 8], 14: [3, 9], 15: [3, 10],
    16: [4, 10], 17: [4, 11], 18: [4, 12], 19: [5, 12], 20: [5, 13],
  };
  for (let count = MIN_PLAYERS; count <= MAX_PLAYERS; count++) {
    const [mafia, villager] = expected[count] ?? [0, 0];
    const counts = roleCountsForPlayerCount(count);
    expect(counts.mafia).toBe(mafia);
    expect(counts.detective).toBe(1);
    expect(counts.doctor).toBe(1);
    expect(counts.villager).toBe(villager);
    expect(totalPlayerCount(counts)).toBe(count);
    expect(ROLE_DISTRIBUTION[count]).toEqual(counts);
  }
});

test("role distribution rejects unsupported player counts", () => {
  for (const count of [0, 3, 21]) {
    expect(() => roleCountsForPlayerCount(count)).toThrow(RangeError);
  }
});

test("exhaustive value arrays cover the role/phase/team/mode/action universes", () => {
  const roles: readonly MafiaRole[] = ["MAFIA", "DOCTOR", "DETECTIVE", "VILLAGER"];
  const phases: readonly MafiaPhase[] = [
    "LOBBY", "ROLE_REVEAL", "NIGHT", "MORNING", "DISCUSSION", "VOTING", "VOTE_RESULT", "GAME_OVER",
  ];
  const teams: readonly MafiaTeam[] = ["MAFIA", "TOWN"];
  expect(MAFIA_ROLES).toEqual(roles);
  expect(MAFIA_PHASES).toEqual(phases);
  expect(MAFIA_TEAMS).toEqual(teams);
  expect(MAFIA_MODES).toEqual(["PASS_THE_PHONE", "MULTIPLAYER", "NARRATOR"]);

  const actionTypes: readonly MafiaActionType[] = [
    "JOIN", "LEAVE", "READY", "UNREADY", "START_GAME", "ROLE_SEEN", "BEGIN_NIGHT",
    "MAFIA_KILL", "DOCTOR_SAVE", "DETECTIVE_INVESTIGATE", "RESOLVE_NIGHT",
    "START_DISCUSSION", "START_VOTING", "CAST_VOTE", "END_VOTING",
    "ADVANCE_PHASE", "PLAY_AGAIN", "PLAYER_UNAVAILABLE",
  ];
  expect(MAFIA_ACTION_TYPES).toEqual(actionTypes);
});

test("night action order is fixed at Mafia -> Doctor -> Detective", () => {
  expect(NIGHT_ACTION_ORDER).toEqual(["MAFIA_KILL", "DOCTOR_SAVE", "DETECTIVE_INVESTIGATE"]);
});

// ---------------------------------------------------------------------------
// Engine instantiation (no framework in sight)
// ---------------------------------------------------------------------------

const initialRoster = [
  { id: "p1", name: "Alice" },
  { id: "p2", name: "Bob" },
  { id: "p3", name: "Charlie" },
  { id: "p4", name: "Dana" },
];

function makeEngine(options?: Partial<{ mode: typeof MAFIA_MODES[number]; players: typeof initialRoster }>): MafiaEngine {
  return createMafiaGame({
    mode: options?.mode ?? "PASS_THE_PHONE",
    players: options?.players ?? initialRoster,
  });
}

test("createMafiaGame instantiates an engine in LOBBY with the given roster", () => {
  const engine = makeEngine();
  const state = engine.getState();

  expect(state.phase).toBe("LOBBY");
  expect(state.winner).toBeNull();
  expect(state.nightNumber).toBe(0);
  expect(state.roles).toEqual({});
  expect(state.players.map((p) => `${p.id}:${p.name}`)).toEqual(
    initialRoster.map((p) => `${p.id}:${p.name}`),
  );
  for (const player of state.players) {
    expect(player.alive).toBe(true);
    expect(player.ready).toBe(false);
    expect(player).not.toHaveProperty("role");
    expect(player).not.toHaveProperty("connection");
    expect(player).not.toHaveProperty("device");
  }
});

test("dispatch rejects structurally malformed / unknown actions without changing state", () => {
  const engine = makeEngine();
  const before = engine.getState();

  const malformed = engine.dispatch({ type: "NONSENSE" } as unknown as MafiaAction);
  expect(malformed.success).toBe(false);
  if (!malformed.success) expect(malformed.error.code).toBe("INVALID_ACTION");

  for (const bad of [
    { type: "JOIN" } as unknown as MafiaAction,
    { type: "MAFIA_KILL", actor: { type: "PLAYER" }, targetId: "p2" } as unknown as MafiaAction,
    { type: "READY" } as unknown as MafiaAction,
  ]) {
    const result = engine.dispatch(bad);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("INVALID_ACTION");
  }

  expect(engine.getState()).toEqual(before);
});

test("well-formed actions are accepted and phase-invalid ones are rejected (Phase 10B)", () => {
  const engine = makeEngine();
  const actor: ActionActor = { type: "SYSTEM" };
  const rally: MafiaAction[] = [
    { type: "JOIN", actor, player: { id: "p5", name: "Eve" } },
    { type: "READY", actor, playerId: "p1" },
  ];
  for (const action of rally) {
    const result = engine.dispatch(action);
    expect(result.success).toBe(true);
  }
  expect(engine.getState().players).toHaveLength(5);

  // Phase-invalid: lobby actions don't exist in the middle of a game.
  const midGame = createMafiaGame({ mode: "PASS_THE_PHONE", players: initialRoster });
  const readyUp: MafiaAction[] = [
    { type: "READY", actor, playerId: "p1" },
    { type: "READY", actor, playerId: "p2" },
    { type: "READY", actor, playerId: "p3" },
    { type: "READY", actor, playerId: "p4" },
    { type: "START_GAME", actor },
  ];
  for (const action of readyUp) expect(midGame.dispatch(action).success).toBe(true);
  expect(midGame.getState().phase).toBe("ROLE_REVEAL");

  const rejected = midGame.dispatch({ type: "JOIN", actor, player: { id: "p9", name: "Zed" } });
  expect(rejected.success).toBe(false);
  if (!rejected.success) expect(rejected.error.code).toBe("INVALID_PHASE");
});

// ---------------------------------------------------------------------------
// View boundaries
// ---------------------------------------------------------------------------

test("public state omits every hidden field", () => {
  const engine = makeEngine();
  const publicState = engine.getPublicState();

  expect(Object.keys(publicState).sort()).toEqual([
    "elimination",
    "gameId",
    "morningDeaths",
    "nightNumber",
    "phase",
    "players",
    "voting",
    "winner",
  ]);
  expect(publicState).not.toHaveProperty("roles");
  expect(publicState).not.toHaveProperty("votes");
  expect(publicState).not.toHaveProperty("nightActions");
  expect(publicState).not.toHaveProperty("actingMafiaId");
  expect(publicState.voting).toBeNull();
  expect(publicState.morningDeaths).toBeNull();
  expect(publicState.elimination).toBeNull();

  for (const player of publicState.players) {
    expect(Object.keys(player).sort()).toEqual(["alive", "id", "name", "ready"]);
  }
});

test("player private state reveals only what belongs to that player", () => {
  const engine = makeEngine();
  const privateState = engine.getPlayerState("p1");

  expect(privateState.playerId).toBe("p1");
  expect(privateState.name).toBe("Alice");
  expect(privateState.role).toBeNull(); // no roles until START_GAME
  expect(privateState.alive).toBe(true);
  expect(privateState.roleSeen).toBe(false);
  expect(privateState.phase).toBe("LOBBY");
  expect(privateState.availableActions).toEqual(["READY"]);
  expect(privateState.ownNightAction).toBeNull();
  expect(privateState.ownPrivateNightResult).toBeNull();
  expect(privateState.ownVoteTargetId).toBeNull();

  expect(privateState).not.toHaveProperty("votes");
  expect(privateState).not.toHaveProperty("actingMafiaId");
  expect(privateState).not.toHaveProperty("roles");
});

test("getPlayerState throws PLAYER_NOT_FOUND for an unknown player", () => {
  const engine = makeEngine();
  let thrown: unknown;
  try {
    engine.getPlayerState("ghost");
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(MafiaEngineException);
  expect((thrown as MafiaEngineException).code).toBe("PLAYER_NOT_FOUND");
});

test("narrator state embeds the public view plus the hidden truth", () => {
  const engine = makeEngine();
  const narrator = engine.getNarratorState();

  expect(narrator.publicState.phase).toBe("LOBBY");
  expect(narrator.roles).toEqual({});
  expect(narrator.actingMafiaId).toBeNull();
  expect(narrator.nightActions).toBeNull();
  expect(narrator.lastResolvedNight).toBeNull();
  expect(narrator.votes).toBeNull();
  expect(narrator.timeline).toEqual([]);
  expect(Object.keys(narrator.readyState).sort()).toEqual(["p1", "p2", "p3", "p4"]);
});

test("all three modes instantiate identically", () => {
  for (const mode of MAFIA_MODES) {
    const engine = makeEngine({ mode, players: [] });
    expect(engine.getState().phase).toBe("LOBBY");
  }
});

test("internal state shape is a discriminated union keyed by phase", () => {
  const state: MafiaGameState = makeEngine().getState();
  expect(state.phase === "LOBBY" ? state.winner === null : false).toBe(true);
  // Type-only guard below would fail to compile if the union were not exhaustive.
  const checked: MafiaGameState["phase"] = state.phase;
  expect(typeof checked).toBe("string");
});