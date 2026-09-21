import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import type { RoomManager } from "../rooms/room-manager.ts";
import { toPublicRoom, type Player, type Room } from "../rooms/types.ts";
import { ConnectionManager } from "./connection-manager.ts";
import type { ServerMessage } from "./types.ts";

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
): Hono<{ Variables: WsVariables }> {
  const app = new Hono<{ Variables: WsVariables }>();

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
        },
        onMessage: (event, ws) => {
          if (typeof event.data === "string") {
            handleClientMessage(event.data, ws);
          } else {
            sendError(ws, "INVALID_MESSAGE", "Invalid message");
          }
        },
        onClose: () => {
          connections.remove(connectionId);
        },
        onError: () => {
          connections.remove(connectionId);
        },
      };
    }),
  );

  return app;
}

function handleClientMessage(raw: string, ws: WsSocket): void {
  let message: unknown;
  try {
    message = JSON.parse(raw);
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

  sendError(ws, "UNKNOWN_MESSAGE_TYPE", "Unknown message type");
}

function send(ws: WsSocket, message: ServerMessage): void {
  ws.send(JSON.stringify(message));
}

function sendError(ws: WsSocket, code: string, message: string): void {
  send(ws, { type: "error", code, message });
}