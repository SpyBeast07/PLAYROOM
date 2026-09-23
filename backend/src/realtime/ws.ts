import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import type { RoomManager } from "../rooms/room-manager.ts";
import { toPublicRoom, type Player, type Room } from "../rooms/types.ts";
import { ConnectionManager } from "./connection-manager.ts";
import type { ServerMessage } from "./types.ts";
import {
  MafiaSessionError,
  type MafiaGameSession,
  type MafiaSessionManager,
} from "../games/mafia/mafia-session.ts";
import {
  allowedActionTypes,
  buildAuthenticatedAction,
  isNarratorConnection,
  parseMafiaClientMessage,
  type MafiaServerMessage,
} from "../games/mafia/mafia-protocol.ts";
import type { ActionActor, MafiaEngineResult } from "../games/mafia/types.ts";

type WsVariables = {
  wsRoom: Room;
  wsPlayer: Player;
};

type WsSocket = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export function createWsRouter(
  roomManager: RoomManager,
  connections: ConnectionManager,
  mafiaSessions: MafiaSessionManager,
): Hono<{ Variables: WsVariables }> {
  const app = new Hono<{ Variables: WsVariables }>();

  // Last mafia.private payload we sent each room/player, so private messages
  // are only emitted when that player's own view actually changed.
  const privateSnapshots = new Map<string, Map<string, string>>();

  app.get(
    "/rooms/:code",
    (c, next) => {
      const code = c.req.param("code");
      const playerId = c.req.query("playerId");
      if (!playerId) return c.json({ error: "Missing playerId" }, 400);

      const room = roomManager.getRoomByCode(code);
      if (!room) return c.json({ error: "Room not found" }, 404);

      const player = room.players.find((p) => p.id === playerId);
      if (!player) return c.json({ error: "Player not found" }, 404);

      c.set("wsRoom", room);
      c.set("wsPlayer", player);
      return next();
    },
    upgradeWebSocket((c) => {
      const room = c.get("wsRoom");
      const player = c.get("wsPlayer");
      const connectionId = crypto.randomUUID();

      return {
        onOpen: (_event, ws) => {
          const currentRoom = roomManager.getRoomByCode(room.code);
          if (!currentRoom) {
            ws.close();
            return;
          }
          connections.add({
            connectionId,
            roomCode: currentRoom.code,
            playerId: player.id,
            socket: ws,
          });
          send(ws, { type: "connected", playerId: player.id });
          send(ws, { type: "room.updated", room: toPublicRoom(currentRoom) });
          sendMafiaSync(currentRoom, player, ws);
        },
        onMessage: (event, ws) => {
          if (typeof event.data !== "string") {
            sendError(ws, "INVALID_MESSAGE", "Invalid message");
            return;
          }
          let message: unknown;
          try {
            message = JSON.parse(event.data);
          } catch {
            sendError(ws, "INVALID_MESSAGE", "Invalid message");
            return;
          }

          if (typeof message !== "object" || message === null || !("type" in message)) {
            sendError(ws, "INVALID_MESSAGE", "Invalid message");
            return;
          }

          const type = (message as { type: unknown }).type;
          if (type === "ping") {
            send(ws, { type: "pong" });
            return;
          }
          if (type === "mafia.action") {
            const currentRoom = roomManager.getRoomByCode(room.code);
            if (!currentRoom) {
              sendMafiaError(ws, "ROOM_NOT_FOUND", "Room not found");
              return;
            }
            handleMafiaAction(message, currentRoom, player, ws);
            return;
          }

          sendError(ws, "UNKNOWN_MESSAGE_TYPE", "Unknown message type");
        },
        onClose: () => {
          connections.remove(connectionId);
          // Report unavailability ONLY when the player has no remaining sockets
          // (multi-socket safe) and a game exists. Never removes them from the
          // room — room membership and game participation are separate.
          const currentRoom = roomManager.getRoomByCode(room.code);
          if (!currentRoom) return;
          if (connections.hasPlayerConnections(currentRoom.code, player.id)) return;

          const game = mafiaSessions.getGame(currentRoom.code);
          if (!game) return;

          const result = game.dispatch({
            type: "PLAYER_UNAVAILABLE",
            actor: { type: "SYSTEM" },
            playerId: player.id,
            reason: "DISCONNECTED",
          });
          if (result.success && result.stateChanged) {
            broadcastGameUpdate(currentRoom, game, result);
          }
        },
        onError: () => {
          connections.remove(connectionId);
        },
      };
    }),
  );

  return app;

  // -------------------------------------------------------------------------
  // Mafia channel internals
  // -------------------------------------------------------------------------

  /**
   * Handle one `mafia.action` frame from an authenticated connection. The actor
   * is derived from the connection, never from the client payload.
   */
  function handleMafiaAction(message: unknown, room: Room, player: Player, ws: WsSocket): void {
    const parsed = parseMafiaClientMessage(message);
    if (!parsed.ok) {
      sendMafiaError(ws, parsed.code, parsed.message);
      return;
    }

    const narrator = isNarratorConnection(room, player.id);
    if (!allowedActionTypes(narrator).includes(parsed.actionType)) {
      sendMafiaError(ws, "ACTION_FORBIDDEN", `Action ${parsed.actionType} is not allowed on this connection`);
      return;
    }

    // The game is created (lazily) from the room's current roster the first
    // time the room talks to the Mafia engine. Validation failures surface as
    // mafia.error; the connection and the room stay intact.
    let game = mafiaSessions.getGame(room.code);
    if (game === undefined) {
      try {
        game = mafiaSessions.createGame(room.code);
        // Baseline each player's private view so the FIRST broadcast after
        // creation carries only genuine changes, never whole-room noise.
        primePrivateSnapshots(room, game);
      } catch (error) {
        if (error instanceof MafiaSessionError) {
          sendMafiaError(ws, error.code, error.message);
          return;
        }
        throw error;
      }
    }

    const actor: ActionActor = narrator ? { type: "NARRATOR" } : { type: "PLAYER", playerId: player.id };
    const action = buildAuthenticatedAction(parsed.actionType, parsed.action, actor);

    const result = game.dispatch(action);
    if (!result.success) {
      // Engine rejection: report to the sender only — never broadcast.
      sendMafiaError(ws, result.error.code, result.error.message);
      return;
    }
    broadcastGameUpdate(room, game, result);
  }

  /**
   * Post-dispatch fan-out. Nothing is sent unless the engine actually changed
   * state: public state to the room, narrator state to the authority
   * connection, and each player's private view only when it changed.
   */
  function broadcastGameUpdate(room: Room, game: MafiaGameSession, result: MafiaEngineResult): void {
    if (!result.success || !result.stateChanged) return;

    const code = room.code;
    connections.broadcastMessage(
      code,
      JSON.stringify({ type: "mafia.state", state: game.getPublicState() } satisfies MafiaServerMessage),
    );

    const narratorId = narratorConnectionId(room);
    if (narratorId !== undefined) {
      connections.sendToPlayer(
        code,
        narratorId,
        JSON.stringify({ type: "mafia.narrator", state: game.getNarratorState() } satisfies MafiaServerMessage),
      );
    }

    let snapshots = privateSnapshots.get(code);
    if (snapshots === undefined) {
      snapshots = new Map();
      privateSnapshots.set(code, snapshots);
    }
    for (const roomPlayer of room.players) {
      let privateState;
      try {
        privateState = game.getPlayerState(roomPlayer.id);
      } catch {
        continue; // room member not (yet) a game player — nothing private to send
      }
      const serialized = JSON.stringify(privateState);
      if (snapshots.get(roomPlayer.id) !== serialized) {
        snapshots.set(roomPlayer.id, serialized);
        connections.sendToPlayer(
          code,
          roomPlayer.id,
          JSON.stringify({ type: "mafia.private", state: privateState } satisfies MafiaServerMessage),
        );
      }
    }
  }

  /**
   * Reconnect synchronization: replay the current public state, this player's
   * private view (which carries their role, phase, and pending action), and —
   * for the narrator connection — the narrator view. Never restarts the game.
   *
   * A live room always has a LOBBY view, so if no session exists yet (fresh
   * room, nobody has acted), it is created eagerly here and reconciled against
   * the room roster. This is what lets the frontend leave the "connecting…"
   * state: every room member receives a `mafia.state` on connect, even before
   * the first action. START_GAME still enforces the 4-20 player range.
   */
  function sendMafiaSync(room: Room, player: Player, ws: WsSocket): void {
    let game = mafiaSessions.getGame(room.code);
    if (game === undefined) {
      try {
        game = mafiaSessions.createGame(room.code);
        // Baseline each player's private view so broadcasts after this point
        // carry only genuine changes, never whole-room noise.
        primePrivateSnapshots(room, game);
      } catch (error) {
        if (error instanceof MafiaSessionError) {
          // Room cannot host a session yet (e.g. duplicate display names, a
          // start-time invariant the session layer owns). The connection stays
          // open with the plain room view; there is simply no Mafia view yet.
          return;
        }
        throw error;
      }
    }

    game.reconcile();

    const code = room.code;
    sendMafia(ws, { type: "mafia.state", state: game.getPublicState() });

    try {
      const privateState = game.getPlayerState(player.id);
      sendMafia(ws, { type: "mafia.private", state: privateState });

      let snapshots = privateSnapshots.get(code);
      if (snapshots === undefined) {
        snapshots = new Map();
        privateSnapshots.set(code, snapshots);
      }
      snapshots.set(player.id, JSON.stringify(privateState));
    } catch {
      // Room member not (yet) in engine
    }

    if (isNarratorConnection(room, player.id)) {
      sendMafia(ws, { type: "mafia.narrator", state: game.getNarratorState() });
    }
  }

  function narratorConnectionId(room: Room): string | undefined {
    return room.players.find((p) => p.isHost)?.id;
  }

  /**
   * Seed each room player's private snapshot right after the game is created,
   * WITHOUT sending anything. From then on mafia.private is emitted only when a
   * player's own view actually changes (see broadcastGameUpdate).
   */
  function primePrivateSnapshots(room: Room, game: MafiaGameSession): void {
    let snapshots = privateSnapshots.get(room.code);
    if (snapshots === undefined) {
      snapshots = new Map();
      privateSnapshots.set(room.code, snapshots);
    }
    for (const roomPlayer of room.players) {
      try {
        snapshots.set(roomPlayer.id, JSON.stringify(game.getPlayerState(roomPlayer.id)));
      } catch {
        // Room member not (yet) a game player — nothing to seed.
      }
    }
  }

  function send(ws: WsSocket, message: ServerMessage): void {
    ws.send(JSON.stringify(message));
  }

  function sendError(ws: WsSocket, code: string, message: string): void {
    send(ws, { type: "error", code, message });
  }

  function sendMafia(ws: WsSocket, message: MafiaServerMessage): void {
    ws.send(JSON.stringify(message));
  }

  function sendMafiaError(ws: WsSocket, code: string, message: string): void {
    sendMafia(ws, { type: "mafia.error", code, message });
  }
}