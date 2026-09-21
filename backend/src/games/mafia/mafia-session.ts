/**
 * Mafia session layer — binds the PLAYROOM room system to the Mafia engine
 * (Phase 11A). Ownership & lifecycle only: which Mafia game belongs to which
 * room, and how room players map to game players.
 *
 *   Room
 *    └── room players ───► Mafia game session (BoundGame) ───► Mafia engine
 *
 * Division of responsibility:
 * - RoomManager (rooms): room existence, membership, names, host, capacity,
 *   join/leave. The room owns the single lock (status "playing").
 * - This session: one game per room, roster mapping, lobby reconciliation,
 *   and the room-lock transition when a game starts/ends.
 * - The engine (mafia-engine.ts): roles, alive/dead state, phases, votes,
 *   night actions, rules. It stays framework-independent; this file is the
 *   only adapter that knows about RoomManager types.
 *
 * The host is never consulted here. RoomManager assigns isHost for room
 * conveniences only; the engine has no host concept and this layer must not
 * introduce one.
 *
 * Room membership ≠ game participation: players who leave the room *after* the
 * game starts are not removed from the game — the transport bounds a later
 * phase reports them as PLAYER_UNAVAILABLE. The session only reconciles the
 * engine's lobby against the room roster while the game is still in LOBBY.
 *
 * Surface: getGame / createGame / syncRoster / dispatch / getPublicState /
 * getPlayerState / getNarratorState / removeGame. WebSocket messages, client
 * parsing, and broadcasts are out of scope (a later phase owns the transport).
 */
import { createMafiaGame, type CreateMafiaGameOptions, type MafiaEngine } from "./mafia-engine.ts";
import { MAX_PLAYERS, MIN_PLAYERS } from "./constants.ts";
import type {
  MafiaAction,
  MafiaEngineResult,
  MafiaEvent,
  MafiaGameMode,
  MafiaNarratorState,
  MafiaPlayerState,
  MafiaPublicState,
  PlayerId,
} from "./types.ts";
import type { Room, RoomStatus } from "../../rooms/types.ts";

/**
 * The minimal view of the room system this session needs. RoomManager
 * (src/rooms/room-manager.ts) satisfies it structurally — no new methods were
 * required beyond the status lock the room already owns.
 */
export interface MafiaSessionRoomStore {
  getRoomByCode(roomCode: string): Room | undefined;
  /** Room status lock used to bar joins once the mafia game starts (rooms.status). */
  setStatus(roomCode: string, status: RoomStatus): void;
}

export type MafiaSessionErrorCode =
  | "ROOM_NOT_FOUND"
  | "GAME_ALREADY_EXISTS"
  | "GAME_NOT_FOUND"
  | "NOT_ENOUGH_PLAYERS"
  | "TOO_MANY_PLAYERS"
  | "NAME_TAKEN";

export class MafiaSessionError extends Error {
  constructor(
    readonly code: MafiaSessionErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Session errors carry a machine-readable code prefix so callers/logs can match on code. */
function sessionError(code: MafiaSessionErrorCode, message: string): MafiaSessionError {
  return new MafiaSessionError(code, `[${code}] ${message}`);
}

export interface MafiaSessionManagerOptions {
  /** Passed straight through to the engine (informational only). Defaults to MULTIPLAYER. */
  mode?: MafiaGameMode;
  /** Determinism injection for role draws (tests use a seeded PRNG). */
  random?: () => number;
  /**
   * Internal test seam: replaces createMafiaGame so the adapter's room-status
   * transition mapping can be exercised without replaying whole games. Defaults
   * to createMafiaGame; apps never set it.
   */
  engineFactory?: (options: CreateMafiaGameOptions) => MafiaEngine;
}

export interface MafiaRosterSync {
  /** Room players added to the game lobby during this sync. */
  added: number;
  /** Room players removed from the game lobby during this sync. */
  removed: number;
}

/**
 * One room's bound game. Obtained from getGame/createGame; a thin, room-checked
 * facade over the engine. Reconnect uses the same instance: a player looking up
 * their (identical) player id gets this same game back, never a fresh one.
 */
export interface MafiaGameSession {
  /** The canonical (normalized) room code this game is bound to. */
  readonly roomCode: string;
  /** Reconcile the LOBBY roster against the room (no-op once the game starts). */
  reconcile(): MafiaRosterSync;
  /** Validate and apply one engine action (see MafiaEngine.dispatch). */
  dispatch(action: MafiaAction): MafiaEngineResult;
  /** Identical-for-everyone view; no hidden information. */
  getPublicState(): MafiaPublicState;
  /** Private view for exactly one game player. Throws for unknown game players. */
  getPlayerState(playerId: PlayerId): MafiaPlayerState;
  /** Full hidden truth for the narrator (Mode C). */
  getNarratorState(): MafiaNarratorState;
}

const SYSTEM_ACTOR = { type: "SYSTEM" } as const;

export class MafiaSessionManager {
  private readonly sessions = new Map<string, BoundGame>();

  constructor(
    private readonly rooms: MafiaSessionRoomStore,
    private readonly options: MafiaSessionManagerOptions = {},
  ) {}

  /**
   * The bound game for a room code — undefined when none exists, or when the
   * room was deleted (a game never outlives its room; cleanup is lazy and
   * side-effect-free for the room's caller).
   */
  getGame(roomCode: string): MafiaGameSession | undefined {
    const code = this.normalize(roomCode);
    const session = this.sessions.get(code);
    if (session === undefined) return undefined;
    if (this.rooms.getRoomByCode(code) === undefined) {
      // The room is gone; its game dies with it rather than leak.
      this.sessions.delete(code);
      return undefined;
    }
    return session;
  }

  /**
   * Maps the room's current roster (room players → mafia players, identical
   * ids/names), creates the engine in LOBBY, and binds it to the room code.
   * Requires a live room with MIN..MAX players and unique display names (the
   * engine's name-uniqueness invariant; the room layer currently allows
   * duplicates). One game per room — a second createGame throws.
   */
  createGame(roomCode: string): MafiaGameSession {
    const code = this.normalize(roomCode);
    if (this.sessions.has(code)) {
      throw sessionError("GAME_ALREADY_EXISTS", `A Mafia game already exists for room ${code}`);
    }

    const room = this.rooms.getRoomByCode(code);
    if (room === undefined) {
      throw sessionError("ROOM_NOT_FOUND", `Room ${code} does not exist`);
    }
    if (room.players.length < MIN_PLAYERS) {
      throw sessionError(
        "NOT_ENOUGH_PLAYERS",
        `Room ${code} needs at least ${MIN_PLAYERS} players to start a game`,
      );
    }
    if (room.players.length > MAX_PLAYERS) {
      throw sessionError("TOO_MANY_PLAYERS", `Room ${code} exceeds the ${MAX_PLAYERS}-player cap`);
    }

    const names = room.players.map((p) => p.name);
    if (new Set(names).size !== names.length) {
      throw sessionError("NAME_TAKEN", `Room ${code} has duplicate player names`);
    }

    const engine = (this.options.engineFactory ?? createMafiaGame)({
      mode: this.options.mode ?? "MULTIPLAYER",
      players: room.players.map((p) => ({ id: p.id, name: p.name })),
      random: this.options.random ?? Math.random,
    });

    const session = new BoundGame(this, engine, code);
    this.sessions.set(code, session);
    return session;
  }

  /** Reconcile a room's game lobby against its room roster (see MafiaGameSession.reconcile). */
  syncRoster(roomCode: string): MafiaRosterSync {
    return this.requireGame(roomCode).reconcile();
  }

  /** Forward one action to the room's game. */
  dispatch(roomCode: string, action: MafiaAction): MafiaEngineResult {
    return this.requireGame(roomCode).dispatch(action);
  }

  getPublicState(roomCode: string): MafiaPublicState {
    return this.requireGame(roomCode).getPublicState();
  }

  getPlayerState(roomCode: string, playerId: PlayerId): MafiaPlayerState {
    return this.requireGame(roomCode).getPlayerState(playerId);
  }

  getNarratorState(roomCode: string): MafiaNarratorState {
    return this.requireGame(roomCode).getNarratorState();
  }

  /**
   * Destroys a room's game and, if the room still exists, releases its lock
   * back to "waiting". Returns whether a game was removed.
   */
  removeGame(roomCode: string): boolean {
    const code = this.normalize(roomCode);
    const removed = this.sessions.delete(code);
    if (removed) {
      try {
        this.rooms.setStatus(code, "waiting");
      } catch {
        // Room is gone; nothing to release.
      }
    }
    return removed;
  }

  // ---------------------------------------------------------------------------
  // Internals (BoundGame delegates here)
  // ---------------------------------------------------------------------------

  private normalize(roomCode: string): string {
    return roomCode.trim().toUpperCase();
  }

  private requireGame(code: string): MafiaGameSession {
    const session = this.getGame(code);
    if (session === undefined) {
      throw sessionError("GAME_NOT_FOUND", `No Mafia game found for room ${code}`);
    }
    return session;
  }

  /**
   * @internal Adapter internals used by BoundGame; callers outside this module
   * should only use the public session surface.
   */

  /**
   * Lobby-only roster reconciliation. No-op once the game has started, and a
   * no-op if the room vanished. Removal runs before addition so a renamed
   * player never trips the engine's name-uniqueness rule mid-sync.
   */
  reconcileLobby(code: string, engine: MafiaEngine): MafiaRosterSync {
    if (engine.getState().phase !== "LOBBY") {
      return { added: 0, removed: 0 };
    }

    const room = this.rooms.getRoomByCode(code);
    if (room === undefined) return { added: 0, removed: 0 };

    const roomPlayerById = new Map(room.players.map((p) => [p.id, p] as const));
    let removed = 0;
    let added = 0;

    for (const player of [...engine.getState().players]) {
      if (!roomPlayerById.has(player.id)) {
        const result = engine.dispatch({ type: "LEAVE", actor: SYSTEM_ACTOR, playerId: player.id });
        if (result.success) removed += 1;
      }
    }

    const engineIds = new Set(engine.getState().players.map((p) => p.id));
    for (const roomPlayer of room.players) {
      if (engineIds.has(roomPlayer.id)) continue;
      const result = engine.dispatch({
        type: "JOIN",
        actor: SYSTEM_ACTOR,
        player: { id: roomPlayer.id, name: roomPlayer.name },
      });
      if (result.success) added += 1;
    }

    return { added, removed };
  }

  /**
   * Keeps the room status aligned with the game lifecycle: LOBBY → ROLE_REVEAL
   * locks the room ("playing"); GAME_OVER → LOBBY (PLAY_AGAIN) reopens it
   * ("waiting"). Driven purely by the engine's own transitions — the room owns
   * the single lock, never duplicated here.
   */
  applyRoomStatusTransitions(code: string, events: readonly MafiaEvent[]): void {
    for (const event of events) {
      if (event.type !== "PHASE_CHANGED") continue;
      if (event.from === "LOBBY" && event.to === "ROLE_REVEAL") {
        try {
          this.rooms.setStatus(code, "playing");
        } catch {
          // Room vanished this same tick; the game has no room to lock.
        }
      } else if (event.from === "GAME_OVER" && event.to === "LOBBY") {
        try {
          this.rooms.setStatus(code, "waiting");
        } catch {
          // Room vanished this same tick; nothing to reopen.
        }
      }
    }
  }
}

/**
 * A thin, room-checked facade over one engine. Every operation re-validates
 * that its room still has a live game (a stale handle from a removed or
 * recreated game fails with GAME_NOT_FOUND), reconciles the LOBBY roster, then
 * delegates to the engine. Holds the engine directly — no manager round-trip.
 */
class BoundGame implements MafiaGameSession {
  constructor(
    private readonly manager: MafiaSessionManager,
    private readonly engine: MafiaEngine,
    readonly roomCode: string,
  ) {}

  private assertCurrent(): void {
    if (this.manager.getGame(this.roomCode) !== this) {
      throw sessionError("GAME_NOT_FOUND", `No active Mafia game for room ${this.roomCode}`);
    }
  }

  reconcile(): MafiaRosterSync {
    this.assertCurrent();
    return this.manager.reconcileLobby(this.roomCode, this.engine);
  }

  dispatch(action: MafiaAction): MafiaEngineResult {
    this.assertCurrent();
    this.manager.reconcileLobby(this.roomCode, this.engine);
    const result = this.engine.dispatch(action);
    if (result.success) {
      this.manager.applyRoomStatusTransitions(this.roomCode, result.events);
    }
    return result;
  }

  getPublicState(): MafiaPublicState {
    this.assertCurrent();
    return this.engine.getPublicState();
  }

  getPlayerState(playerId: PlayerId): MafiaPlayerState {
    this.assertCurrent();
    return this.engine.getPlayerState(playerId);
  }

  getNarratorState(): MafiaNarratorState {
    this.assertCurrent();
    return this.engine.getNarratorState();
  }
}