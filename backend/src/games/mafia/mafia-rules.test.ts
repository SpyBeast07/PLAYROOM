/**
 * Phase 10B comprehensive rule tests for the Mafia engine.
 * Covers: lobby lifecycle, START_GAME role assignment, role reveal, night
 * submission & resolution (save / pass / doctor-dead / repeat-guard), acting
 * Mafia carry-over, voting (no early votes, aggregate-only publicity, ties,
 * plurality elimination), win detection, PLAY_AGAIN, PLAYER_UNAVAILABLE, and
 * the public/private/narrator information boundaries.
 *
 * Uses a deterministic injected RNG (mulberry32) so role draws are repeatable.
 */
import { expect, test } from "bun:test";
import { createMafiaGame, type CreateMafiaGameOptions, type MafiaEngine } from "./mafia-engine.ts";
import type {
  ActionActor,
  MafiaAction,
  MafiaGameState,
  MafiaNightState,
  MafiaRole,
  MafiaVoteResultState,
  PlayerId,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SYS: ActionActor = { type: "SYSTEM" };
const NAR: ActionActor = { type: "NARRATOR" };

const ROSTER4 = ["p1", "p2", "p3", "p4"].map((id) => ({
  id,
  name: `Player ${id}`,
}));
const ROSTER8 = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"].map((id) => ({
  id,
  name: `Player ${id}`,
}));

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mk(options: Omit<Partial<CreateMafiaGameOptions>, "random"> & { seed?: number } = {}): MafiaEngine {
  return createMafiaGame({
    mode: options.mode ?? "PASS_THE_PHONE",
    players: options.players ?? ROSTER4,
    random: mulberry32(options.seed ?? 1),
  });
}

type OkResult = Extract<ReturnType<MafiaEngine["dispatch"]>, { success: true }>;

function ok(engine: MafiaEngine, action: MafiaAction): OkResult {
  const result = engine.dispatch(action);
  expect(result.success).toBe(true);
  if (!result.success) throw new Error(`unexpected failure: ${result.error.code} ${result.error.message}`);
  return result;
}

function fail(engine: MafiaEngine, action: MafiaAction): string {
  const result = engine.dispatch(action);
  expect(result.success).toBe(false);
  if (result.success) throw new Error("expected a rejected action");
  return result.error.code;
}

function state(engine: MafiaEngine): MafiaGameState {
  return engine.getState();
}

function nightState(engine: MafiaEngine): MafiaNightState {
  const s = state(engine);
  if (s.phase !== "NIGHT") throw new Error(`expected NIGHT, got ${s.phase}`);
  return s;
}

function voteResultState(engine: MafiaEngine): MafiaVoteResultState {
  const s = state(engine);
  if (s.phase !== "VOTE_RESULT") throw new Error(`expected VOTE_RESULT, got ${s.phase}`);
  return s;
}

function roleIds(engine: MafiaEngine, role: MafiaRole): PlayerId[] {
  return state(engine).players
    .filter((p) => state(engine).roles[p.id] === role)
    .map((p) => p.id);
}

function mafiaId(engine: MafiaEngine): PlayerId {
  return roleIds(engine, "MAFIA")[0] as PlayerId;
}
function doctorId(engine: MafiaEngine): PlayerId {
  return roleIds(engine, "DOCTOR")[0] as PlayerId;
}
function detectiveId(engine: MafiaEngine): PlayerId {
  return roleIds(engine, "DETECTIVE")[0] as PlayerId;
}
function villagerId(engine: MafiaEngine): PlayerId {
  return roleIds(engine, "VILLAGER")[0] as PlayerId;
}

/** Ready every player (SYSTEM = pass-phone / narrator mode) and START_GAME. */
function startGame(engine: MafiaEngine): void {
  for (const player of state(engine).players) {
    const result = engine.dispatch({ type: "READY", actor: SYS, playerId: player.id });
    expect(result.success).toBe(true);
  }
  expect(engine.dispatch({ type: "START_GAME", actor: SYS }).success).toBe(true);
}

/** Each player confirms their role as themselves; the last one opens the night. */
function revealAll(engine: MafiaEngine): void {
  const ids = state(engine).players.map((p) => p.id);
  for (const playerId of ids) {
    const result = engine.dispatch({
      type: "ROLE_SEEN",
      actor: { type: "PLAYER", playerId },
      playerId,
    });
    expect(result.success).toBe(true);
  }
}

/** Ready -> START_GAME -> reveal all. Returns the NIGHT state. */
function openGame(engine: MafiaEngine): MafiaGameState {
  startGame(engine);
  revealAll(engine);
  return state(engine);
}

/** Night 1: Mafia kills the Villager, Doctor passes. Land in VOTING (4p games). */
function getToVoting(engine: MafiaEngine): void {
  kill(engine, villagerId(engine));
  save(engine, null);
  ok(engine, { type: "RESOLVE_NIGHT", actor: SYS });
  enterVotingFromMorning(engine);
}

/** MORNING -> DISCUSSION -> VOTING without any votes or casualties. */
function enterVotingFromMorning(engine: MafiaEngine): void {
  expect(engine.dispatch({ type: "ADVANCE_PHASE", actor: SYS }).success).toBe(true);
  expect(engine.dispatch({ type: "ADVANCE_PHASE", actor: SYS }).success).toBe(true);
}

/** Skip discussion and voting without casualties, ending in VOTE_RESULT. */
function passDay(engine: MafiaEngine): void {
  enterVotingFromMorning(engine);
  expect(engine.dispatch({ type: "END_VOTING", actor: SYS }).success).toBe(true);
}

function kill(engine: MafiaEngine, target: PlayerId): void {
  expect(engine.dispatch({ type: "MAFIA_KILL", actor: SYS, targetId: target }).success).toBe(true);
}
function save(engine: MafiaEngine, target: PlayerId | null): void {
  expect(engine.dispatch({ type: "DOCTOR_SAVE", actor: SYS, targetId: target }).success).toBe(true);
}
function investigate(engine: MafiaEngine, target: PlayerId): void {
  expect(engine.dispatch({ type: "DETECTIVE_INVESTIGATE", actor: SYS, targetId: target }).success).toBe(true);
}
function vote(engine: MafiaEngine, voterId: PlayerId, targetId: PlayerId): void {
  expect(
    engine.dispatch({ type: "CAST_VOTE", actor: SYS, voterId, targetId }).success,
  ).toBe(true);
}

/** Everyone living votes for the given target; the target self-votes another living player. */
function voteEveryoneFor(engine: MafiaEngine, target: PlayerId): void {
  const alive = state(engine).players.filter((p) => p.alive);
  for (const p of alive) {
    if (p.id === target) {
      const other = alive.find((q) => q.id !== target);
      if (other !== undefined) vote(engine, p.id, other.id);
    } else {
      vote(engine, p.id, target);
    }
  }
}

// ---------------------------------------------------------------------------
// Lobby lifecycle
// ---------------------------------------------------------------------------

test("JOIN accepts caller-supplied ids, trims names, and clears readiness", () => {
  const engine = mk({ players: ROSTER4.slice(0, 3) });
  ok(engine, { type: "READY", actor: { type: "PLAYER", playerId: "p1" }, playerId: "p1" });

  const result = ok(engine, { type: "JOIN", actor: SYS, player: { id: "p9", name: "  Zed  " } });
  expect(result.stateChanged).toBe(true);
  expect(state(engine).players).toHaveLength(4);
  expect(state(engine).players.find((p) => p.id === "p9")?.name).toBe("Zed");
  expect(state(engine).players.filter((p) => p.ready)).toHaveLength(0);
});

test("JOIN rejects duplicate ids, duplicate names, bad names, and full rooms", () => {
  const engine = mk();
  expect(fail(engine, { type: "JOIN", actor: SYS, player: { id: "p1", name: "Twin" } })).toBe(
    "PLAYER_ALREADY_JOINED",
  );
  expect(fail(engine, { type: "JOIN", actor: SYS, player: { id: "p9", name: "Player p1" } })).toBe(
    "NAME_TAKEN",
  );
  expect(fail(engine, { type: "JOIN", actor: SYS, player: { id: "p9", name: "" } })).toBe(
    "INVALID_PLAYER_NAME",
  );
  expect(fail(engine, { type: "JOIN", actor: SYS, player: { id: "p9", name: "x".repeat(21) } })).toBe(
    "INVALID_PLAYER_NAME",
  );

  const full = mk({
    players: Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, name: `N${i}` })),
  });
  expect(fail(full, { type: "JOIN", actor: SYS, player: { id: "who", name: "New" } })).toBe(
    "GAME_FULL",
  );
});

test("a player actor can only JOIN as themselves", () => {
  const engine = mk();
  expect(
    fail(engine, {
      type: "JOIN",
      actor: { type: "PLAYER", playerId: "p1" },
      player: { id: "p9", name: "Zed" },
    }),
  ).toBe("INVALID_ACTOR");
});

test("JOIN/LEAVE are lobby-only", () => {
  const engine = mk();
  startGame(engine);
  expect(fail(engine, { type: "JOIN", actor: SYS, player: { id: "p9", name: "Zed" } })).toBe(
    "INVALID_PHASE",
  );
  expect(fail(engine, { type: "LEAVE", actor: SYS, playerId: "p2" })).toBe("INVALID_PHASE");
});

test("LEAVE removes the player and clears readiness", () => {
  const engine = mk();
  ok(engine, { type: "READY", actor: SYS, playerId: "p2" });
  ok(engine, { type: "LEAVE", actor: SYS, playerId: "p2" });
  expect(state(engine).players.map((p) => p.id)).toEqual(["p1", "p3", "p4"]);
  expect(state(engine).players.some((p) => p.ready)).toBe(false);
  expect(fail(engine, { type: "LEAVE", actor: SYS, playerId: "ghost" })).toBe("PLAYER_NOT_FOUND");
});

test("READY/UNREADY: self-only, no-op idempotence, unknown player rejection", () => {
  const engine = mk();
  expect(
    fail(engine, { type: "READY", actor: { type: "PLAYER", playerId: "p1" }, playerId: "p2" }),
  ).toBe("INVALID_ACTOR");
  expect(fail(engine, { type: "READY", actor: SYS, playerId: "ghost" })).toBe("PLAYER_NOT_FOUND");

  expect(ok(engine, { type: "READY", actor: SYS, playerId: "p1" }).stateChanged).toBe(true);
  expect(ok(engine, { type: "READY", actor: SYS, playerId: "p1" }).stateChanged).toBe(false);
  expect(state(engine).players.find((p) => p.id === "p1")?.ready).toBe(true);

  expect(ok(engine, { type: "UNREADY", actor: SYS, playerId: "p1" }).stateChanged).toBe(true);
  expect(state(engine).players.find((p) => p.id === "p1")?.ready).toBe(false);
});

test("READY/UNREADY are lobby-only", () => {
  const engine = mk();
  startGame(engine);
  expect(fail(engine, { type: "READY", actor: SYS, playerId: "p1" })).toBe("INVALID_PHASE");
});

test("START_GAME: actor, count, and readiness gates", () => {
  const engine = mk();
  expect(fail(engine, { type: "START_GAME", actor: { type: "PLAYER", playerId: "p1" } })).toBe(
    "INVALID_ACTOR",
  );

  const underPlayerCount = mk({ players: ROSTER4.slice(0, 3) });
  expect(fail(underPlayerCount, { type: "START_GAME", actor: SYS })).toBe("NOT_ENOUGH_PLAYERS");

  ok(engine, { type: "READY", actor: SYS, playerId: "p1" });
  expect(fail(engine, { type: "START_GAME", actor: SYS })).toBe("NOT_ALL_READY");

  for (const player of ["p2", "p3", "p4"]) {
    ok(engine, { type: "READY", actor: SYS, playerId: player });
  }
  const result = ok(engine, { type: "START_GAME", actor: NAR });
  expect(result.events.map((e) => e.type)).toContain("GAME_STARTED");
  expect(state(engine).phase).toBe("ROLE_REVEAL");
  expect(Object.keys(state(engine).roles).sort()).toEqual(["p1", "p2", "p3", "p4"]);
});

// ---------------------------------------------------------------------------
// Determinism & role assignment
// ---------------------------------------------------------------------------

test("same seed + same roster yields identical role draws", () => {
  const a = mk({ seed: 42 });
  const b = mk({ seed: 42 });
  startGame(a);
  startGame(b);
  expect(state(a).roles).toEqual(state(b).roles);
});

test("role counts match the distribution table for the roster size", () => {
  for (const size of [4, 5, 8, 10, 20]) {
    const engine = mk({
      seed: 3,
      players: Array.from({ length: size }, (_, i) => ({ id: `p${i}`, name: `N${i}` })),
    });
    startGame(engine);
    const counts = state(engine).players.reduce<Record<MafiaRole, number>>(
      (acc, p) => {
        const role = state(engine).roles[p.id];
        if (role !== undefined) acc[role] = (acc[role] ?? 0) + 1;
        return acc;
      },
      { MAFIA: 0, DOCTOR: 0, DETECTIVE: 0, VILLAGER: 0 },
    );
    expect(counts.DOCTOR).toBe(1);
    expect(counts.DETECTIVE).toBe(1);
    expect(counts.MAFIA + counts.DOCTOR + counts.DETECTIVE + counts.VILLAGER).toBe(size);
  }
});

// ---------------------------------------------------------------------------
// ROLE_REVEAL
// ---------------------------------------------------------------------------

test("ROLE_SEEN is self-only (PLAYER) or NARRATOR; SYSTEM cannot confirm", () => {
  const engine = mk();
  startGame(engine);
  expect(fail(engine, { type: "ROLE_SEEN", actor: SYS, playerId: "p1" })).toBe("INVALID_ACTOR");
  expect(
    fail(engine, { type: "ROLE_SEEN", actor: { type: "PLAYER", playerId: "p1" }, playerId: "p2" }),
  ).toBe("INVALID_ACTOR");
  ok(engine, { type: "ROLE_SEEN", actor: { type: "PLAYER", playerId: "p1" }, playerId: "p1" });
  expect(
    ok(engine, { type: "ROLE_SEEN", actor: { type: "PLAYER", playerId: "p1" }, playerId: "p1" })
      .stateChanged,
  ).toBe(false);
});

test("confirming the last role auto-advances (SYSTEM) into night 1 with the acting Mafia", () => {
  const engine = mk({ seed: 5 });
  startGame(engine);
  const ids = state(engine).players.map((p) => p.id);
  let lastResult;
  for (const playerId of ids) {
    lastResult = ok(engine, {
      type: "ROLE_SEEN",
      actor: { type: "PLAYER", playerId },
      playerId,
    });
  }
  const result = lastResult as OkResult;
  expect(result.events.map((e) => e.type)).toEqual(
    expect.arrayContaining(["PHASE_CHANGED", "NIGHT_STARTED"]),
  );
  expect(state(engine).phase).toBe("NIGHT");
  expect(state(engine).nightNumber).toBe(1);
  expect(nightState(engine).actingMafiaId).toBe(mafiaId(engine));
});

test("BEGIN_NIGHT is ROLE_REVEAL-only and narrator/system-gated", () => {
  const engine = mk({ seed: 5 });
  startGame(engine);
  expect(fail(engine, { type: "BEGIN_NIGHT", actor: { type: "PLAYER", playerId: "p1" } })).toBe(
    "INVALID_ACTOR",
  );
  ok(engine, { type: "BEGIN_NIGHT", actor: SYS });
  expect(state(engine).phase).toBe("NIGHT");
  expect(fail(engine, { type: "BEGIN_NIGHT", actor: SYS })).toBe("INVALID_PHASE");
});

// ---------------------------------------------------------------------------
// Night submission
// ---------------------------------------------------------------------------

test("night actions are gated by role, aliveness, and acting-Mafia status", () => {
  const engine = mk({ seed: 2 });
  openGame(engine);
  const doc = doctorId(engine);
  const det = detectiveId(engine);
  const villager = villagerId(engine);

  // PLAYER actors impersonating roles they do not hold are rejected.
  expect(
    fail(engine, { type: "DETECTIVE_INVESTIGATE", actor: { type: "PLAYER", playerId: villager }, targetId: doc }),
  ).toBe("INVALID_ACTOR");
  expect(
    fail(engine, { type: "MAFIA_KILL", actor: { type: "PLAYER", playerId: doc }, targetId: villager }),
  ).toBe("INVALID_ACTOR");
  expect(
    fail(engine, { type: "DOCTOR_SAVE", actor: { type: "PLAYER", playerId: villager }, targetId: doc }),
  ).toBe("INVALID_ACTOR");

  // Correct role + actor works.
  kill(engine, villager);
  save(engine, det);
  investigate(engine, mafiaId(engine));

  // Duplicate submissions are rejected.
  expect(fail(engine, { type: "MAFIA_KILL", actor: SYS, targetId: det })).toBe(
    "ACTION_ALREADY_SUBMITTED",
  );
  expect(fail(engine, { type: "DOCTOR_SAVE", actor: SYS, targetId: det })).toBe(
    "ACTION_ALREADY_SUBMITTED",
  );
});

test("night action target validation rejects unknown and dead targets, and self-kill", () => {
  const engine = mk({ seed: 2 });
  openGame(engine);
  const mafia = mafiaId(engine);
  const villager = villagerId(engine);

  expect(fail(engine, { type: "MAFIA_KILL", actor: SYS, targetId: "ghost" })).toBe(
    "PLAYER_NOT_FOUND",
  );
  expect(fail(engine, { type: "MAFIA_KILL", actor: SYS, targetId: mafia })).toBe(
    "INVALID_TARGET",
  );

  //
  kill(engine, villager);
  save(engine, null);
  ok(engine, { type: "RESOLVE_NIGHT", actor: SYS });
  passDay(engine);
  ok(engine, { type: "ADVANCE_PHASE", actor: SYS }); // VOTE_RESULT -> NIGHT 2
  expect(fail(engine, { type: "MAFIA_KILL", actor: SYS, targetId: villager })).toBe(
    "INVALID_TARGET",
  );
});

test("DOCTOR_SAVE with a null target records a pass", () => {
  const engine = mk({ seed: 2 });
  openGame(engine);
  const result = ok(engine, { type: "DOCTOR_SAVE", actor: SYS, targetId: null });
  expect(result.events.map((e) => e.type)).toContain("NIGHT_ACTION_RECORDED");
  expect(nightState(engine).nightActions.save).toEqual({ status: "PASSED", targetId: null });
  void doctorId(engine);
});

test("dead players cannot submit night actions", () => {
  const engine = mk({ seed: 1 });
  openGame(engine);
  const doc = doctorId(engine);
  const villager = villagerId(engine);
  kill(engine, doc);
  save(engine, null);
  ok(engine, { type: "RESOLVE_NIGHT", actor: SYS });

  passDay(engine);
  ok(engine, { type: "ADVANCE_PHASE", actor: SYS }); // VOTE_RESULT -> NIGHT 2
  expect(state(engine).players.find((p) => p.id === doc)?.alive).toBe(false);
  expect(
    fail(engine, { type: "DOCTOR_SAVE", actor: { type: "PLAYER", playerId: doc }, targetId: villager }),
  ).toBe("PLAYER_DEAD");
});

// ---------------------------------------------------------------------------
// Night resolution
// ---------------------------------------------------------------------------

test("RESOLVE_NIGHT requires the Mafia kill unless forced", () => {
  const engine = mk({ seed: 1 });
  openGame(engine);
  expect(fail(engine, { type: "RESOLVE_NIGHT", actor: SYS })).toBe("MISSING_REQUIRED_ACTION");
  expect(fail(engine, { type: "RESOLVE_NIGHT", actor: { type: "PLAYER", playerId: "p1" } })).toBe(
    "INVALID_ACTOR",
  );
});

test("kill + doctor save on victim => no death and saveApplied", () => {
  const engine = mk({ seed: 1 });
  openGame(engine);
  const villager = villagerId(engine);
  kill(engine, villager);
  save(engine, villager);
  ok(engine, { type: "RESOLVE_NIGHT", actor: SYS });
  expect(state(engine).phase).toBe("MORNING");
  expect(state(engine).lastResolvedNight?.killedPlayerIds).toEqual([]);
  expect(state(engine).lastResolvedNight?.saveApplied).toBe(true);
  expect(state(engine).players.every((p) => p.alive)).toBe(true);
});

test("kill + doctor save elsewhere => victim dies, save not applied", () => {
  const engine = mk({ seed: 1 });
  openGame(engine);
  const villager = villagerId(engine);
  const detective = detectiveId(engine);
  kill(engine, villager);
  save(engine, detective);
  ok(engine, { type: "RESOLVE_NIGHT", actor: SYS });
  expect(state(engine).lastResolvedNight?.killedPlayerIds).toEqual([villager]);
  expect(state(engine).lastResolvedNight?.saveApplied).toBe(false);
  expect(state(engine).players.find((p) => p.id === villager)?.alive).toBe(false);
});

test("doctor pass / no save => victim dies", () => {
  const engine = mk({ seed: 1 });
  openGame(engine);
  const villager = villagerId(engine);
  kill(engine, villager);
  save(engine, null);
  ok(engine, { type: "RESOLVE_NIGHT", actor: SYS });
  expect(state(engine).lastResolvedNight?.killedPlayerIds).toEqual([villager]);
});

test("doctor self-save protects against their own murder", () => {
  const engine = mk({ seed: 1 });
  openGame(engine);
  const doc = doctorId(engine);
  kill(engine, doc);
  save(engine, doc);
  ok(engine, { type: "RESOLVE_NIGHT", actor: SYS });
  expect(state(engine).lastResolvedNight?.killedPlayerIds).toEqual([]);
  expect(state(engine).players.every((p) => p.alive)).toBe(true);
});

test("dead doctor's save slot is inert", () => {
  const engine = mk({ seed: 1 });
  openGame(engine);
  kill(engine, doctorId(engine));
  save(engine, null);
  ok(engine, { type: "RESOLVE_NIGHT", actor: SYS });

  passDay(engine);
  ok(engine, { type: "ADVANCE_PHASE", actor: SYS }); // VOTE_RESULT -> NIGHT 2
  const villa = villagerId(engine);
  kill(engine, villa);
  ok(engine, { type: "RESOLVE_NIGHT", actor: SYS });
  expect(state(engine).lastResolvedNight?.doctorAlive).toBe(false);
  expect(state(engine).lastResolvedNight?.killedPlayerIds).toEqual([villa]);
});

test("doctor repeat guard blocks consecutive saves of the same target; a pass clears it", () => {
  const engine = mk({ seed: 1 });
  openGame(engine);
  const villager = villagerId(engine);
  const detective = detectiveId(engine);

  // night 1: kill + save the villager -> no deaths, guard = villager
  kill(engine, villager);
  save(engine, villager);
  ok(engine, { type: "RESOLVE_NIGHT", actor: SYS });
  passDay(engine);
  ok(engine, { type: "ADVANCE_PHASE", actor: SYS }); // -> NIGHT 2
  expect(state(engine).nightNumber).toBe(2);

  kill(engine, detective);
  expect(fail(engine, { type: "DOCTOR_SAVE", actor: SYS, targetId: villager })).toBe(
    "DOCTOR_REPEAT_GUARD",
  );
  save(engine, null); // pass clears the guard (saveTargetId -> null)
  ok(engine, { type: "RESOLVE_NIGHT", actor: SYS });

  passDay(engine);
  ok(engine, { type: "ADVANCE_PHASE", actor: SYS }); // -> NIGHT 3
  expect(ok(engine, { type: "DOCTOR_SAVE", actor: SYS, targetId: villager }).success).toBe(true);
});

test("detective investigation verdict is revealed privately", () => {
  const engine = mk({ seed: 1 });
  openGame(engine);
  const det = detectiveId(engine);
  const villager = villagerId(engine);
  kill(engine, villager);
  save(engine, null);
  investigate(engine, villager);
  ok(engine, { type: "RESOLVE_NIGHT", actor: SYS });

  const own = engine.getPlayerState(det).ownPrivateNightResult;
  expect(own?.kind).toBe("INVESTIGATION");
  if (own?.kind === "INVESTIGATION") {
    expect(own.targetId).toBe(villager);
    expect(own.isMafia).toBe(false);
  }
});

test("investigating a Mafia returns isMafia true", () => {
  const engine = mk({ seed: 1 });
  openGame(engine);
  const det = detectiveId(engine);
  const mafia = mafiaId(engine);
  const villager = villagerId(engine);
  kill(engine, villager);
  save(engine, null);
  investigate(engine, mafia);
  ok(engine, { type: "RESOLVE_NIGHT", actor: SYS });
  const own = engine.getPlayerState(det).ownPrivateNightResult;
  expect(own?.kind).toBe("INVESTIGATION");
  if (own?.kind === "INVESTIGATION") expect(own.isMafia).toBe(true);
});

// ---------------------------------------------------------------------------
// ADVANCE_PHASE / force resolution
// ---------------------------------------------------------------------------

test("ADVANCE_PHASE from NIGHT force-resolves, skipping every pending slot", () => {
  const engine = mk({ seed: 1 });
  openGame(engine);
  const result = ok(engine, { type: "ADVANCE_PHASE", actor: SYS });
  expect(result.events.map((e) => e.type)).toEqual(
    expect.arrayContaining(["PLAYER_UNAVAILABLE", "NIGHT_RESOLVED"]),
  );
  expect(state(engine).phase).toBe("MORNING");
  expect(state(engine).lastResolvedNight?.killedPlayerIds).toEqual([]);
  expect(state(engine).players.every((p) => p.alive)).toBe(true);
});

test("ADVANCE_PHASE fast-forwards and is a no-op in the lobby", () => {
  const engine = mk({ seed: 1 });
  expect(ok(engine, { type: "ADVANCE_PHASE", actor: SYS }).stateChanged).toBe(false);

  startGame(engine);
  ok(engine, { type: "ADVANCE_PHASE", actor: SYS }); // ROLE_REVEAL -> NIGHT
  expect(state(engine).phase).toBe("NIGHT");
});

test("ADVANCE_PHASE from VOTE_RESULT begins the next night (canonical +1)", () => {
  const engine = mk({ seed: 1 });
  openGame(engine);
  kill(engine, villagerId(engine));
  save(engine, null);
  ok(engine, { type: "RESOLVE_NIGHT", actor: SYS });
  passDay(engine);
  expect(state(engine).phase).toBe("VOTE_RESULT");
  ok(engine, { type: "ADVANCE_PHASE", actor: SYS });
  expect(state(engine).phase).toBe("NIGHT");
  expect(state(engine).nightNumber).toBe(2);
});

test("ADVANCE_PHASE cannot be driven by players", () => {
  const engine = mk({ seed: 1 });
  openGame(engine);
  expect(
    fail(engine, { type: "ADVANCE_PHASE", actor: { type: "PLAYER", playerId: "p1" } }),
  ).toBe("INVALID_ACTOR");
});

// ---------------------------------------------------------------------------
// Voting
// ---------------------------------------------------------------------------

test("no early voting outside VOTING", () => {
  const engine = mk({ seed: 1 });
  openGame(engine);
  expect(
    fail(engine, { type: "CAST_VOTE", actor: SYS, voterId: "p1", targetId: "p2" }),
  ).toBe("INVALID_PHASE");
  expect(engine.getPublicState().voting).toBeNull();
});

test("vote validation: self-only PLAYER actor, unknown voters", () => {
  const engine = mk({ seed: 1 });
  openGame(engine);
  getToVoting(engine);
  expect(
    fail(engine, {
      type: "CAST_VOTE",
      actor: { type: "PLAYER", playerId: "p1" },
      voterId: "p2",
      targetId: "p3",
    }),
  ).toBe("INVALID_ACTOR");
  expect(fail(engine, { type: "CAST_VOTE", actor: SYS, voterId: "ghost", targetId: "p2" })).toBe(
    "PLAYER_NOT_FOUND",
  );
});

test("votes are aggregate-public; never voter->target; player sees only their own", () => {
  const engine = mk({ seed: 1 });
  openGame(engine);
  getToVoting(engine);
  const alive = state(engine).players.filter((p) => p.alive);
  const voter = alive[0]?.id as PlayerId;
  const target = alive[1]?.id as PlayerId;
  vote(engine, voter, target);

  const pub = engine.getPublicState();
  expect(pub.phase).toBe("VOTING");
  expect(pub.voting).toEqual({ cast: 1, total: alive.length });
  expect(pub).not.toHaveProperty("votes");
  expect(Object.keys(pub.players[0] ?? {})).not.toContain("role");

  expect(engine.getPlayerState(voter).ownVoteTargetId).toBe(target);
  expect(engine.getPlayerState(target).ownVoteTargetId).toBeNull();
});

test("votes are single-submission per voter", () => {
  const engine = mk({ seed: 1 });
  openGame(engine);
  getToVoting(engine);
  const doc = doctorId(engine);
  const det = detectiveId(engine);
  vote(engine, doc, det);
  expect(fail(engine, { type: "CAST_VOTE", actor: SYS, voterId: doc, targetId: mafiaId(engine) })).toBe(
    "ACTION_ALREADY_SUBMITTED",
  );
});

test("dead players cannot vote", () => {
  const engine = mk({ seed: 1 });
  openGame(engine);
  getToVoting(engine);
  const deadVillager = villagerId(engine);
  expect(state(engine).players.find((p) => p.id === deadVillager)?.alive).toBe(false);
  expect(fail(engine, { type: "CAST_VOTE", actor: SYS, voterId: deadVillager, targetId: "p1" })).toBe(
    "PLAYER_DEAD",
  );
});

test("plurality eliminates the leader; all-living-votes auto-resolve (8p)", () => {
  const engine = mk({ seed: 8, players: ROSTER8 });
  openGame(engine);
  // force-resolve night 1 with zero deaths so all 8 can vote
  ok(engine, { type: "ADVANCE_PHASE", actor: SYS });
  enterVotingFromMorning(engine);

  const target = doctorId(engine);
  const alive = state(engine).players.filter((p) => p.alive);
  expect(alive).toHaveLength(8);
  const stray = alive.find((p) => p.id !== target)?.id as PlayerId;
  for (const p of alive) {
    vote(engine, p.id, p.id === target ? stray : target);
  }

  // the last living vote auto-resolved into VOTE_RESULT
  expect(state(engine).phase).toBe("VOTE_RESULT");
  expect(voteResultState(engine).elimination).toEqual({ eliminatedPlayerId: target, tie: false });
  expect(state(engine).players.find((p) => p.id === target)?.alive).toBe(false);
});

test("tie vote eliminates nobody and reports tie", () => {
  const engine = mk({ seed: 1 });
  openGame(engine);
  ok(engine, { type: "ADVANCE_PHASE", actor: SYS }); // force night 1
  enterVotingFromMorning(engine); // MORNING -> DISCUSSION -> VOTING

  const alive = state(engine).players.filter((p) => p.alive);
  expect(alive).toHaveLength(4);
  const [a, b, c, d] = alive.map((p) => p.id) as [PlayerId, PlayerId, PlayerId, PlayerId];
  vote(engine, a, c);
  vote(engine, b, c);
  vote(engine, c, d);
  vote(engine, d, d);
  expect(state(engine).phase).toBe("VOTE_RESULT");
  expect(voteResultState(engine).elimination).toEqual({ eliminatedPlayerId: null, tie: true });
  expect(state(engine).players.every((p) => p.alive)).toBe(true);
});

test("END_VOTING with nobody voting eliminates nobody (tie false)", () => {
  const engine = mk({ seed: 1 });
  openGame(engine);
  getToVoting(engine);
  ok(engine, { type: "END_VOTING", actor: SYS });
  expect(state(engine).phase).toBe("VOTE_RESULT");
  expect(voteResultState(engine).elimination).toEqual({ eliminatedPlayerId: null, tie: false });
});

// ---------------------------------------------------------------------------
// Win detection
// ---------------------------------------------------------------------------

test("town wins by voting out the last Mafia", () => {
  const engine = mk({ seed: 1 });
  openGame(engine);
  getToVoting(engine);
  const mafia = mafiaId(engine);
  voteEveryoneFor(engine, mafia);
  expect(state(engine).phase).toBe("GAME_OVER");
  expect(state(engine).winner).toBe("TOWN");
});

test("mafia wins by outnumbering town through night kills", () => {
  const engine = mk({ seed: 1 });
  openGame(engine);
  // N1: kill the villager
  kill(engine, villagerId(engine));
  save(engine, null);
  ok(engine, { type: "RESOLVE_NIGHT", actor: SYS });
  // N2: kill the detective -> only Mafia + Doctor remain
  passDay(engine);
  ok(engine, { type: "ADVANCE_PHASE", actor: SYS });
  kill(engine, detectiveId(engine));
  ok(engine, { type: "RESOLVE_NIGHT", actor: SYS });

  expect(state(engine).phase).toBe("GAME_OVER");
  expect(state(engine).winner).toBe("MAFIA");
});

// ---------------------------------------------------------------------------
// Acting Mafia carry-over
// ---------------------------------------------------------------------------

test("the acting Mafia is the roster-first Mafia and carries over while alive", () => {
  const engine = mk({ seed: 8, players: ROSTER8 });
  openGame(engine);
  const [m1, m2] = roleIds(engine, "MAFIA") as [PlayerId, PlayerId];
  expect(nightState(engine).actingMafiaId).toBe(m1);

  // the non-acting Mafia cannot kill
  expect(
    fail(engine, { type: "MAFIA_KILL", actor: { type: "PLAYER", playerId: m2 }, targetId: m1 }),
  ).toBe("INVALID_ACTOR");

  // night 1 with no deaths -> day -> night 2
  ok(engine, { type: "ADVANCE_PHASE", actor: SYS });
  passDay(engine);
  ok(engine, { type: "ADVANCE_PHASE", actor: SYS }); // VOTE_RESULT -> NIGHT 2
  expect(state(engine).nightNumber).toBe(2);
  expect(nightState(engine).actingMafiaId).toBe(m1);
});

test("the acting role falls back to the next living Mafia when the holder is eliminated", () => {
  const engine = mk({ seed: 8, players: ROSTER8 });
  openGame(engine);
  const [m1, m2] = roleIds(engine, "MAFIA") as [PlayerId, PlayerId];
  expect(nightState(engine).actingMafiaId).toBe(m1);

  ok(engine, { type: "ADVANCE_PHASE", actor: SYS }); // force night 1 (no deaths)
  enterVotingFromMorning(engine);
  voteEveryoneFor(engine, m1);
  expect(state(engine).phase).toBe("VOTE_RESULT");
  expect(voteResultState(engine).elimination.eliminatedPlayerId).toBe(m1);
  expect(state(engine).players.find((p) => p.id === m1)?.alive).toBe(false);

  ok(engine, { type: "ADVANCE_PHASE", actor: SYS }); // VOTE_RESULT -> NIGHT 2
  expect(nightState(engine).actingMafiaId).toBe(m2);
});

// ---------------------------------------------------------------------------
// PLAY_AGAIN
// ---------------------------------------------------------------------------

test("PLAY_AGAIN keeps the roster and resets all game state", () => {
  const engine = mk({ seed: 1 });
  openGame(engine);
  getToVoting(engine);
  voteEveryoneFor(engine, mafiaId(engine));
  expect(state(engine).phase).toBe("GAME_OVER");

  expect(fail(engine, { type: "PLAY_AGAIN", actor: { type: "PLAYER", playerId: "p1" } })).toBe(
    "INVALID_ACTOR",
  );
  ok(engine, { type: "PLAY_AGAIN", actor: SYS });

  const s = state(engine);
  expect(s.phase).toBe("LOBBY");
  expect(s.players).toHaveLength(ROSTER4.length);
  expect(s.players.every((p) => p.alive && !p.ready)).toBe(true);
  expect(s.players.map((p) => p.id).sort()).toEqual(["p1", "p2", "p3", "p4"]);
  expect(s.roles).toEqual({});
  expect(s.winner).toBeNull();
  expect(s.nightNumber).toBe(0);
  expect(s.lastResolvedNight).toBeNull();
  expect(s.timeline).toEqual([]);

  ok(engine, { type: "JOIN", actor: SYS, player: { id: "p9", name: "Zed" } });
  startGame(engine);
  expect(state(engine).phase).toBe("ROLE_REVEAL");
});

test("PLAY_AGAIN only after game over", () => {
  const engine = mk();
  expect(fail(engine, { type: "PLAY_AGAIN", actor: SYS })).toBe("INVALID_PHASE");
});

// ---------------------------------------------------------------------------
// PLAYER_UNAVAILABLE
// ---------------------------------------------------------------------------

test("disconnect during the night marks the pending slot SKIPPED", () => {
  const engine = mk({ seed: 1 });
  openGame(engine);
  const result = ok(engine, {
    type: "PLAYER_UNAVAILABLE",
    actor: SYS,
    playerId: mafiaId(engine),
    reason: "DISCONNECTED",
  });
  expect(result.events.map((e) => e.type)).toContain("PLAYER_UNAVAILABLE");
  expect(nightState(engine).nightActions.kill.status).toBe("SKIPPED");
  ok(engine, { type: "RESOLVE_NIGHT", actor: SYS });
  expect(state(engine).lastResolvedNight?.killedPlayerIds).toEqual([]);
});

test("availability reports with no pending input are no-ops", () => {
  const engine = mk({ seed: 1 });
  openGame(engine);
  expect(
    ok(engine, { type: "PLAYER_UNAVAILABLE", actor: SYS, playerId: villagerId(engine), reason: "TIMED_OUT" })
      .stateChanged,
  ).toBe(false);
  expect(
    fail(engine, { type: "PLAYER_UNAVAILABLE", actor: SYS, playerId: "ghost", reason: "TIMED_OUT" }),
  ).toBe("PLAYER_NOT_FOUND");
  expect(
    fail(engine, {
      type: "PLAYER_UNAVAILABLE",
      actor: { type: "PLAYER", playerId: "p1" },
      playerId: "p1",
      reason: "TIMED_OUT",
    }),
  ).toBe("INVALID_ACTOR");
});

// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------

test("available actions derive from phase + role + submission state", () => {
  const engine = mk({ seed: 1 });
  expect(engine.getPlayerState("p1").availableActions).toEqual(["READY"]);

  startGame(engine);
  expect(engine.getPlayerState("p1").roleSeen).toBe(false);
  expect(engine.getPlayerState("p1").availableActions).toEqual(["ROLE_SEEN"]);

  revealAll(engine);
  const mafia = mafiaId(engine);
  const doc = doctorId(engine);
  const det = detectiveId(engine);
  const villager = villagerId(engine);
  expect(engine.getPlayerState(mafia).availableActions).toEqual(["MAFIA_KILL"]);
  expect(engine.getPlayerState(doc).availableActions).toEqual(["DOCTOR_SAVE"]);
  expect(engine.getPlayerState(det).availableActions).toEqual(["DETECTIVE_INVESTIGATE"]);
  expect(engine.getPlayerState(villager).availableActions).toEqual([]);

  kill(engine, villager);
  expect(engine.getPlayerState(mafia).availableActions).toEqual([]);
  expect(engine.getPlayerState(mafia).ownNightAction).toBe("SUBMITTED");

  save(engine, null);
  investigate(engine, mafia);
  ok(engine, { type: "RESOLVE_NIGHT", actor: SYS });

  enterVotingFromMorning(engine);
  // the villager died at night; the doctor is a guaranteed living voter
  expect(engine.getPlayerState(doc).availableActions).toEqual(["CAST_VOTE"]);
  vote(engine, doc, det);
  expect(engine.getPlayerState(doc).availableActions).toEqual([]);
});

test("own night result is delivered only to the role holder", () => {
  const engine = mk({ seed: 1 });
  openGame(engine);
  const doc = doctorId(engine);
  const det = detectiveId(engine);
  const villagers = roleIds(engine, "VILLAGER");
  const villager = villagers[0] as PlayerId;
  kill(engine, villager);
  save(engine, null);
  investigate(engine, villager);
  ok(engine, { type: "RESOLVE_NIGHT", actor: SYS });

  expect(engine.getPlayerState(doc).ownPrivateNightResult?.kind).toBe("HEAL");
  expect(engine.getPlayerState(det).ownPrivateNightResult?.kind).toBe("INVESTIGATION");
  expect(engine.getPlayerState(villager).ownPrivateNightResult).toBeNull();
});

test("public and narrator boundaries never leak hidden state", () => {
  const engine = mk({ seed: 2 });
  openGame(engine);
  const pub = engine.getPublicState();
  expect(Object.keys(pub).sort()).toEqual([
    "elimination",
    "gameId",
    "morningDeaths",
    "nightNumber",
    "phase",
    "players",
    "voting",
    "winner",
  ]);
  expect(pub).not.toHaveProperty("roles");
  expect(pub).not.toHaveProperty("votes");
  expect(pub).not.toHaveProperty("nightActions");
  expect(pub).not.toHaveProperty("actingMafiaId");

  const narrator = engine.getNarratorState();
  expect(narrator.actingMafiaId).toBe(nightState(engine).actingMafiaId);
  expect(narrator.nightActions).toEqual(nightState(engine).nightActions);
  expect(narrator.roles).toEqual(state(engine).roles);
});