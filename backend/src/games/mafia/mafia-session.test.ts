/**
 * Phase 11A — Mafia session layer tests. Exercises the boundary between the
 * room system (RoomManager) and the Mafia engine: ownership (one game per room),
 * lifecycle (lock/unlock, deletion, cleanup), mapping (identical player ids),
 * and roster reconciliation. Rule-level coverage lives in mafia-rules.test.ts —
 * these tests only touch the adapter seam.
 */
import { expect, test } from "bun:test";
import { RoomManager, RoomError } from "../../rooms/room-manager.ts";
import type { Player, Room, RoomStatus } from "../../rooms/types.ts";
import { createMafiaGame, MafiaEngineException, type MafiaEngine } from "./mafia-engine.ts";
import { MafiaSessionManager, MafiaSessionError, type MafiaGameSession, type MafiaSessionRoomStore } from "./mafia-session.ts";
import type { MafiaEvent } from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES4 = ["Ada", "Bob", "Cam", "Dee"];
const NAMES8 = ["Ada", "Bob", "Cam", "Dee", "Eve", "Fay", "Gus", "Hal"];

/** Populates a real room with `names` unique players; returns their Player records. */
function fillRoom(rooms: RoomManager, code: string, names: string[]): Player[] {
  return names.map((name) => rooms.addPlayer(code, name));
}

function sessionFor(rooms: RoomManager, options: ConstructorParameters<typeof MafiaSessionManager>[1] = {}): MafiaSessionManager {
  return new MafiaSessionManager(rooms, { random: mulberry32(7), ...options });
}

/** Ready every room player (SYSTEM), then START_GAME, through the session. */
function readyAndStart(game: MafiaGameSession, players: Player[]): void {
  for (const p of players) {
    expect(game.dispatch({ type: "READY", actor: { type: "SYSTEM" }, playerId: p.id }).success).toBe(true);
  }
  const started = game.dispatch({ type: "START_GAME", actor: { type: "SYSTEM" } });
  expect(started.success).toBe(true);
}

/** Fake room store for defensive branches and transition mapping. */
class FakeRoomStore implements MafiaSessionRoomStore {
  readonly rooms = new Map<string, Room>();
  readonly statusCalls: Array<{ code: string; status: RoomStatus }> = [];

  add(code: string, players: Array<{ id: string; name: string }>): void {
    this.rooms.set(code.trim().toUpperCase(), {
      id: `room-${code}`,
      code: code.trim().toUpperCase(),
      status: "waiting",
      players: players.map((p) => ({ ...p, joinedAt: 0, isHost: false })),
      createdAt: 0,
    });
  }

  getRoomByCode(roomCode: string): Room | undefined {
    return this.rooms.get(roomCode.trim().toUpperCase());
  }

  setStatus(roomCode: string, status: RoomStatus): void {
    const code = roomCode.trim().toUpperCase();
    if (!this.rooms.has(code)) {
      throw new MafiaSessionError("ROOM_NOT_FOUND", "Room not found");
    }
    this.statusCalls.push({ code, status });
  }
}

/** Deterministic, scriptable fake engine (for transition mapping). */
function scriptedEngine(script: Map<string, MafiaEvent[]>): MafiaEngine {
  return {
    getState: () => ({ phase: "LOBBY", players: [] }) as never,
    dispatch: (action) => {
      const events = script.get(action.type) ?? [];
      return { success: true, stateChanged: events.length > 0, events };
    },
    getPublicState: createMafiaGame({
      mode: "MULTIPLAYER",
      players: NAMES4.map((n, i) => ({ id: `p${i + 1}`, name: n })),
      random: mulberry32(1),
    }).getPublicState,
    getPlayerState: () => {
      throw new Error("unused");
    },
    getNarratorState: () => {
      throw new Error("unused");
    },
  };
}

// ---------------------------------------------------------------------------
// RoomManager.setStatus (the deliberate Phase 11A addition)
// ---------------------------------------------------------------------------

test("setStatus throws ROOM_NOT_FOUND for an unknown code", () => {
  const rooms = new RoomManager();
  expect(() => rooms.setStatus("ZZZ999", "playing")).toThrow(RoomError);
  expect(() => rooms.setStatus("ZZZ999", "playing")).toThrow(/not found/i);
});

test("setStatus locks and unlocks a room against joining", () => {
  const rooms = new RoomManager();
  const { code } = rooms.createRoom();
  rooms.addPlayer(code, "Ada");

  rooms.setStatus(code, "playing");
  expect(rooms.getRoomByCode(code)?.status).toBe("playing");
  expect(() => rooms.addPlayer(code, "Bob")).toThrow("Room already started");

  rooms.setStatus(code, "waiting");
  expect(rooms.getRoomByCode(code)?.status).toBe("waiting");
  expect(rooms.addPlayer(code, "Bob").name).toBe("Bob");
});

// ---------------------------------------------------------------------------
// RoomManager fulfills the session's room-store contract
// ---------------------------------------------------------------------------

test("RoomManager satisfies MafiaSessionRoomStore structurally (same methods, no extra API)", () => {
  const rooms = new RoomManager();
  // Compile-time contract; runtime just confirms the methods exist and behave.
  const store: MafiaSessionRoomStore = rooms;
  expect(typeof store.getRoomByCode).toBe("function");
  expect(typeof store.setStatus).toBe("function");
});

// ---------------------------------------------------------------------------
// getGame / code normalization
// ---------------------------------------------------------------------------

test("getGame returns undefined when no game exists", () => {
  const rooms = new RoomManager();
  const { code } = rooms.createRoom();
  fillRoom(rooms, code, NAMES4);
  const session = sessionFor(rooms);
  expect(session.getGame(code)).toBeUndefined();
});

test("room codes are normalized (case, whitespace) for session keys", () => {
  const rooms = new RoomManager();
  const { code } = rooms.createRoom();
  fillRoom(rooms, code, NAMES4);
  const session = sessionFor(rooms);
  const game = session.createGame(`  ${code.toLowerCase()}  `);
  expect(game.roomCode).toBe(code);
  expect(session.getGame(code)).toBe(game);
  expect(session.getGame(` ${code.toLowerCase()} `)).toBe(game);
});

// ---------------------------------------------------------------------------
// createGame validation
// ---------------------------------------------------------------------------

test("createGame rejects an unknown room with ROOM_NOT_FOUND", () => {
  const rooms = new RoomManager();
  const session = sessionFor(rooms);
  expect(() => session.createGame("NOEXIST")).toThrow(MafiaSessionError);
  expect(() => session.createGame("NOEXIST")).toThrow(/does not exist/i);
  expect(() => session.createGame("NOEXIST")).toThrow("ROOM_NOT_FOUND");
});

test("createGame allows a below-minimum lobby (start enforces the 4-player minimum)", () => {
  const rooms = new RoomManager();
  const { code } = rooms.createRoom();
  fillRoom(rooms, code, ["Ada", "Bob", "Cam"]);
  const session = sessionFor(rooms);

  const game = session.createGame(code);
  expect(game.getPublicState().phase).toBe("LOBBY");
  expect(game.getPublicState().players).toHaveLength(3);

  // The session may exist with 1-2 players too — the lobby must render.
  const { code: small } = rooms.createRoom();
  fillRoom(rooms, small, ["Solo"]);
  expect(session.createGame(small).getPublicState().players).toHaveLength(1);

  // Whatever the roster, START_GAME still requires MIN_PLAYERS.
  expect(game.dispatch({ type: "START_GAME", actor: { type: "SYSTEM" } }).success).toBe(false);
  expect(rooms.getRoomByCode(code)?.status).toBe("waiting");
});

test("createGame defends against more than MAX_PLAYERS (unreachable via RoomManager cap)", () => {
  const store = new FakeRoomStore();
  const tooMany = Array.from({ length: 21 }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` }));
  store.add("AAA111", tooMany);
  const session = new MafiaSessionManager(store, { random: mulberry32(1) });
  try {
    session.createGame("AAA111");
  } catch (error) {
    expect((error as MafiaSessionError).code).toBe("TOO_MANY_PLAYERS");
    return;
  }
  throw new Error("expected TOO_MANY_PLAYERS");
});

test("createGame rejects duplicate display names (engine invariant the room allows)", () => {
  const rooms = new RoomManager();
  const { code } = rooms.createRoom();
  fillRoom(rooms, code, ["Ada", "Bob", "Cam", "Ada"]);
  const session = sessionFor(rooms);
  expect(() => session.createGame(code)).toThrow("NAME_TAKEN");
});

test("createGame maps room players onto the game with identical ids and names", () => {
  const rooms = new RoomManager();
  const { code } = rooms.createRoom();
  const players = fillRoom(rooms, code, NAMES8);
  const session = sessionFor(rooms);
  const game = session.createGame(code);

  const publicPlayers = game.getPublicState().players;
  expect(publicPlayers).toHaveLength(8);
  for (const p of players) {
    const inGame = publicPlayers.find((gp) => gp.id === p.id);
    expect(inGame).toBeDefined();
    expect(inGame?.name).toBe(p.name);
  }

  const enginePlayers = game.getNarratorState().publicState.players;
  expect(enginePlayers.map((gp) => gp.id).sort()).toEqual(players.map((p) => p.id).sort());
});

test("createGame binds one game per room; a second createGame throws GAME_ALREADY_EXISTS", () => {
  const rooms = new RoomManager();
  const { code } = rooms.createRoom();
  fillRoom(rooms, code, NAMES4);
  const session = sessionFor(rooms);
  const first = session.createGame(code);
  expect(() => session.createGame(code)).toThrow("GAME_ALREADY_EXISTS");
  expect(session.getGame(code)).toBe(first);
});

test("createGame leaves a fresh room unlocked until the game actually starts", () => {
  const rooms = new RoomManager();
  const { code } = rooms.createRoom();
  fillRoom(rooms, code, NAMES4);
  const session = sessionFor(rooms);
  session.createGame(code);
  expect(rooms.getRoomByCode(code)?.status).toBe("waiting");
  expect(rooms.addPlayer(code, "Zed").name).toBe("Zed");
});

// ---------------------------------------------------------------------------
// Lifecycle lock/unlock via real engine play
// ---------------------------------------------------------------------------

test("START_GAME locks the room (playing) and blocks new joins", () => {
  const rooms = new RoomManager();
  const { code } = rooms.createRoom();
  const players = fillRoom(rooms, code, NAMES4);
  const session = sessionFor(rooms);
  const game = session.createGame(code);

  readyAndStart(game, players);
  expect(rooms.getRoomByCode(code)?.status).toBe("playing");
  expect(() => rooms.addPlayer(code, "Zed")).toThrow(RoomError);
  expect(() => rooms.addPlayer(code, "Zed")).toThrow("Room already started");
});

test("public/player/narrator views reflect the started game through the session", () => {
  const rooms = new RoomManager();
  const { code } = rooms.createRoom();
  const players = fillRoom(rooms, code, NAMES4);
  const session = sessionFor(rooms);
  const game = session.createGame(code);

  expect(game.getPublicState().phase).toBe("LOBBY");
  expect(game.getPlayerState(players[0]?.id ?? "p0").role).toBeNull();

  readyAndStart(game, players);
  expect(game.getPublicState().phase).toBe("ROLE_REVEAL");
  expect(game.getPublicState().revealedRoles).toBeNull();
  expect(players[0]?.id ?? "p0").toBeDefined();
  const first = game.getPlayerState(players[0]?.id ?? "p0");
  expect(first.role).not.toBeNull();
  expect(game.getNarratorState().roles).toHaveProperty(players[0]?.id ?? "p0");
});

test("dispatching an invalid action through the session returns the engine rejection", () => {
  const rooms = new RoomManager();
  const { code } = rooms.createRoom();
  const players = fillRoom(rooms, code, NAMES4);
  const session = sessionFor(rooms);
  const game = session.createGame(code);

  const startByPlayer = game.dispatch({ type: "START_GAME", actor: { type: "PLAYER", playerId: players[0]?.id ?? "p0" } });
  expect(startByPlayer.success).toBe(false);
  expect(rooms.getRoomByCode(code)?.status).toBe("waiting");
});

test("a rejected dispatch never locks the room", () => {
  const rooms = new RoomManager();
  const { code } = rooms.createRoom();
  fillRoom(rooms, code, NAMES4);
  const session = sessionFor(rooms);
  const game = session.createGame(code);

  const doomed = game.dispatch({ type: "START_GAME", actor: { type: "SYSTEM" } });
  expect(doomed.success).toBe(false); // nobody is ready
  expect(rooms.getRoomByCode(code)?.status).toBe("waiting");
});

// ---------------------------------------------------------------------------
// Roster reconciliation (room membership vs game participation)
// ---------------------------------------------------------------------------

test("a player leaving the room before the game starts leaves the game lobby", () => {
  const rooms = new RoomManager();
  const { code } = rooms.createRoom();
  const players = fillRoom(rooms, code, NAMES4);
  const session = sessionFor(rooms);
  const game = session.createGame(code);

  const leaver = players[0];
  const leaverId = leaver?.id ?? "p0";
  rooms.removePlayer(code, leaverId);

  const sync = session.syncRoster(code);
  expect(sync.removed).toBe(1);
  expect(sync.added).toBe(0);
  expect(game.getNarratorState().publicState.players.map((p) => p.id)).not.toContain(leaverId);
});

test("a player joining the room before the game starts joins the game lobby", () => {
  const rooms = new RoomManager();
  const { code } = rooms.createRoom();
  fillRoom(rooms, code, NAMES4);
  const session = sessionFor(rooms);
  const game = session.createGame(code);

  const joiner = rooms.addPlayer(code, "Zed");
  expect(game.getNarratorState().publicState.players).toHaveLength(4);

  const sync = session.syncRoster(code);
  expect(sync.added).toBe(1);
  expect(sync.removed).toBe(0);
  expect(game.getNarratorState().publicState.players.map((p) => p.id)).toContain(joiner.id);
});

test("post-start room changes are ignored: membership ≠ game participation", () => {
  const rooms = new RoomManager();
  const { code } = rooms.createRoom();
  const players = fillRoom(rooms, code, NAMES4);
  const session = sessionFor(rooms);
  const game = session.createGame(code);
  readyAndStart(game, players);

  const leaver = players[0];
  const leaverId = leaver?.id ?? "p0";
  rooms.removePlayer(code, leaverId);

  const sync = session.syncRoster(code);
  expect(sync).toEqual({ added: 0, removed: 0 });
  // The room player is still a game player.
  expect(game.getNarratorState().publicState.players.map((p) => p.id)).toContain(leaverId);
  expect(game.getPlayerState(leaverId).playerId).toBe(leaverId);
});

test("syncRoster with no game throws GAME_NOT_FOUND", () => {
  const rooms = new RoomManager();
  const { code } = rooms.createRoom();
  fillRoom(rooms, code, NAMES4);
  const session = sessionFor(rooms);
  expect(() => session.syncRoster(code)).toThrow("GAME_NOT_FOUND");
});

// ---------------------------------------------------------------------------
// Room deletion and cleanup
// ---------------------------------------------------------------------------

test("deleting the room (last player leaves) destroys its game; stale handles fail", () => {
  const rooms = new RoomManager();
  const { code } = rooms.createRoom();
  const players = fillRoom(rooms, code, NAMES4);
  const session = sessionFor(rooms);
  const game = session.createGame(code);
  readyAndStart(game, players);

  for (const p of players) rooms.removePlayer(code, p.id);
  expect(rooms.getRoomByCode(code)).toBeUndefined();

  expect(session.getGame(code)).toBeUndefined();
  expect(() => game.dispatch({ type: "PLAYER_UNAVAILABLE", actor: { type: "SYSTEM" }, playerId: players[0]?.id ?? "p0", reason: "DISCONNECTED" })).toThrow(
    "GAME_NOT_FOUND",
  );
  expect(() => session.getPublicState(code)).toThrow("GAME_NOT_FOUND");
});

// ---------------------------------------------------------------------------
// removeGame
// ---------------------------------------------------------------------------

test("removeGame destroys the game and releases the room lock", () => {
  const rooms = new RoomManager();
  const { code } = rooms.createRoom();
  const players = fillRoom(rooms, code, NAMES4);
  const session = sessionFor(rooms);
  const game = session.createGame(code);
  readyAndStart(game, players);
  expect(rooms.getRoomByCode(code)?.status).toBe("playing");

  expect(session.removeGame(code)).toBe(true);
  expect(session.getGame(code)).toBeUndefined();
  expect(rooms.getRoomByCode(code)?.status).toBe("waiting");
  expect(rooms.addPlayer(code, "Zed").name).toBe("Zed");

  expect(session.removeGame(code)).toBe(false);
});

test("removeGame on a deleted room still cleans up without throwing", () => {
  const rooms = new RoomManager();
  const { code } = rooms.createRoom();
  const players = fillRoom(rooms, code, NAMES4);
  const session = sessionFor(rooms);
  const game = session.createGame(code);
  for (const p of players) rooms.removePlayer(code, p.id);
  expect(rooms.getRoomByCode(code)).toBeUndefined();

  expect(session.removeGame(code)).toBe(true);
  expect(() => game.getPublicState()).toThrow("GAME_NOT_FOUND");
});

test("a stale handle from a removed game cannot resurrect or mutate", () => {
  const rooms = new RoomManager();
  const { code } = rooms.createRoom();
  const players = fillRoom(rooms, code, NAMES4);
  const session = sessionFor(rooms);
  const game = session.createGame(code);
  readyAndStart(game, players);
  session.removeGame(code);

  expect(() => game.getPublicState()).toThrow("GAME_NOT_FOUND");
  expect(session.getGame(code)).toBeUndefined();
  expect(() =>
    game.dispatch({ type: "READY", actor: { type: "SYSTEM" }, playerId: players[0]?.id ?? "p0" }),
  ).toThrow("GAME_NOT_FOUND");
});

// ---------------------------------------------------------------------------
// Reconnect: same player id, same game, no duplicate identity
// ---------------------------------------------------------------------------

test("reconnect resolves the existing game and private state by player id", () => {
  const rooms = new RoomManager();
  const { code } = rooms.createRoom();
  const players = fillRoom(rooms, code, NAMES4);
  const session = sessionFor(rooms);
  const first = session.createGame(code);
  readyAndStart(first, players);
  const playerId = players[0]?.id ?? "p0";

  // A "reconnecting" player re-looks-up the same session object.
  const again = session.getGame(code);
  expect(again).toBe(first);
  expect(session.getPlayerState(code, playerId).playerId).toBe(playerId);
  expect(again?.getPlayerState(playerId)).toEqual(first.getPlayerState(playerId));
  expect(session.getNarratorState(code).publicState.players).toHaveLength(4);
});

test("getPlayerState for a non-game player throws MafiaEngineException", () => {
  const rooms = new RoomManager();
  const { code } = rooms.createRoom();
  const players = fillRoom(rooms, code, NAMES4);
  const session = sessionFor(rooms);
  const game = session.createGame(code);
  readyAndStart(game, players);

  expect(() => game.getPlayerState("not-a-player")).toThrow(MafiaEngineException);
  expect(() => session.getPlayerState(code, "not-a-player")).toThrow(MafiaEngineException);
});

// ---------------------------------------------------------------------------
// Room-status transition mapping (scripted engine via the test seam)
// ---------------------------------------------------------------------------

test("lifecycle transitions drive the room lock through the session (scripted engine)", () => {
  const store = new FakeRoomStore();
  store.add("AAA111", NAMES4.map((n, i) => ({ id: `p${i + 1}`, name: n })));

  const eventsByAction = new Map<string, MafiaEvent[]>([
    ["START_GAME", [{ type: "PHASE_CHANGED", from: "LOBBY", to: "ROLE_REVEAL" }]],
    ["PLAY_AGAIN", [{ type: "PHASE_CHANGED", from: "GAME_OVER", to: "LOBBY" } as MafiaEvent]],
  ]);
  const session = new MafiaSessionManager(store, {
    random: mulberry32(1),
    engineFactory: (_options) => scriptedEngine(eventsByAction),
  });

  const game = session.createGame("AAA111");
  expect(store.statusCalls).toEqual([]);

  const locked = game.dispatch({ type: "START_GAME", actor: { type: "SYSTEM" } });
  expect(locked.success).toBe(true);
  expect(store.statusCalls).toEqual([{ code: "AAA111", status: "playing" }]);

  const reopened = game.dispatch({ type: "PLAY_AGAIN", actor: { type: "SYSTEM" } });
  expect(reopened.success).toBe(true);
  expect(store.statusCalls).toEqual([
    { code: "AAA111", status: "playing" },
    { code: "AAA111", status: "waiting" },
  ]);
});

test("a store failure while locking does not break dispatch (lock is best-effort)", () => {
  const store = new FakeRoomStore();
  store.add("AAA111", NAMES4.map((n, i) => ({ id: `p${i + 1}`, name: n })));
  const originalSetStatus = store.setStatus.bind(store);
  store.setStatus = (code, status) => {
    if (status === "playing") throw new Error("store unavailable");
    originalSetStatus(code, status);
  };

  const session = new MafiaSessionManager(store, {
    random: mulberry32(1),
    engineFactory: (_options) =>
      scriptedEngine(new Map([["START_GAME", [{ type: "PHASE_CHANGED", from: "LOBBY", to: "ROLE_REVEAL" }]]])),
  });
  const game = session.createGame("AAA111");

  const started = game.dispatch({ type: "START_GAME", actor: { type: "SYSTEM" } });
  expect(started.success).toBe(true);
  expect(store.statusCalls).toEqual([]);
});