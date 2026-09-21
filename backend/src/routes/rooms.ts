import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { RoomError, type RoomManager, type RoomErrorCode } from "../rooms/room-manager.ts";
import { toPublicPlayer, toPublicRoom } from "../rooms/types.ts";
import type { ConnectionManager } from "../realtime/connection-manager.ts";

export function createRoomRouter(
  roomManager: RoomManager,
  connections: ConnectionManager,
): Hono {
  const rooms = new Hono();

  rooms.post("/", (c) => {
    const room = roomManager.createRoom();
    return c.json({ room: toPublicRoom(room) }, 201);
  });

  rooms.get("/:code", (c) => {
    const room = roomManager.getRoomByCode(c.req.param("code"));
    if (!room) return c.json({ error: "Room not found" }, 404);
    return c.json({ room: toPublicRoom(room) });
  });

  rooms.post("/:code/players", async (c) => {
    const name = await readName(c.req);
    if (name === undefined) return c.json({ error: "Invalid request body" }, 400);

    try {
      const player = roomManager.addPlayer(c.req.param("code"), name);
      const room = roomManager.getRoomByCode(c.req.param("code"));
      if (!room) throw new RoomError("ROOM_NOT_FOUND", "Room not found");
      connections.broadcastRoomUpdated(room);
      return c.json({ player: toPublicPlayer(player), room: toPublicRoom(room) }, 201);
    } catch (error) {
      return toErrorResponse(c, error);
    }
  });

  rooms.delete("/:code/players/:playerId", (c) => {
    try {
      const code = c.req.param("code");
      const playerId = c.req.param("playerId");
      roomManager.removePlayer(code, playerId);
      const room = roomManager.getRoomByCode(code);
      if (room) {
        connections.closePlayerConnections(playerId);
        connections.broadcastRoomUpdated(room);
      } else {
        connections.closeRoomConnections(code.trim().toUpperCase());
      }
      return c.body(null, 204);
    } catch (error) {
      return toErrorResponse(c, error);
    }
  });

  return rooms;
}

async function readName(req: { json: () => Promise<unknown> }): Promise<string | undefined> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return undefined;
  }
  if (typeof body !== "object" || body === null || !("name" in body)) return undefined;
  const name = (body as { name: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

const ROOM_ERROR_STATUS: Record<RoomErrorCode, ContentfulStatusCode> = {
  ROOM_NOT_FOUND: 404,
  PLAYER_NOT_FOUND: 404,
  INVALID_PLAYER_NAME: 400,
  ROOM_FULL: 409,
  ROOM_STARTED: 409,
};

function toErrorResponse(c: Context, error: unknown) {
  if (error instanceof RoomError) {
    return c.json({ error: error.message }, ROOM_ERROR_STATUS[error.code]);
  }
  return c.json({ error: "Internal server error" }, 500);
}