import { Hono, type Context } from "hono";
import { RoomError, RoomManager } from "../rooms/room-manager.ts";
import { toPublicPlayer, toPublicRoom } from "../rooms/types.ts";

export const rooms = new Hono();

const roomManager = new RoomManager();

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
    if (!room) throw new RoomError(404, "Room not found");
    return c.json({ player: toPublicPlayer(player), room: toPublicRoom(room) }, 201);
  } catch (error) {
    return toErrorResponse(c, error);
  }
});

rooms.delete("/:code/players/:playerId", (c) => {
  try {
    roomManager.removePlayer(c.req.param("code"), c.req.param("playerId"));
    return c.body(null, 204);
  } catch (error) {
    return toErrorResponse(c, error);
  }
});

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

function toErrorResponse(c: Context, error: unknown) {
  if (error instanceof RoomError) {
    return c.json({ error: error.message }, error.statusCode);
  }
  return c.json({ error: "Internal server error" }, 500);
}