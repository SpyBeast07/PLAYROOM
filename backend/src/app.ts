import { Hono } from "hono";
import { cors } from "hono/cors";
import { health } from "./routes/health.ts";
import { createRoomRouter } from "./routes/rooms.ts";
import { ConnectionManager } from "./realtime/connection-manager.ts";
import { createWsRouter } from "./realtime/ws.ts";
import { RoomManager } from "./rooms/room-manager.ts";
import { MafiaSessionManager } from "./games/mafia/mafia-session.ts";

const DEFAULT_CORS_ORIGINS = ["http://localhost:5173"];

export function createApp() {
  const app = new Hono();

  const corsOrigins = (Bun.env.CORS_ORIGIN ?? DEFAULT_CORS_ORIGINS.join(","))
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  app.use("*", cors({ origin: corsOrigins }));

  const roomManager = new RoomManager();
  const connections = new ConnectionManager();
  const mafiaSessions = new MafiaSessionManager(roomManager);

  app.route("/health", health);
  app.route("/rooms", createRoomRouter(roomManager, connections));
  app.route("/ws", createWsRouter(roomManager, connections, mafiaSessions));

  return app;
}