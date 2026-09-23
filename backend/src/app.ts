import { Hono } from "hono";
import { cors } from "hono/cors";
import { health } from "./routes/health.ts";
import { createNarratorRouter } from "./routes/narrator.ts";
import { createRoomRouter } from "./routes/rooms.ts";
import { NarratorController } from "./games/mafia/adapters/narrator/narrator-controller.ts";
import { ConnectionManager } from "./realtime/connection-manager.ts";
import { createWsRouter } from "./realtime/ws.ts";
import { RoomManager } from "./rooms/room-manager.ts";
import { MafiaSessionManager } from "./games/mafia/mafia-session.ts";

const DEFAULT_CORS_ORIGINS = [
  "http://localhost:5173",
  "https://playrooms.kushagragupta.co.in",
];

export function createApp() {
  const app = new Hono();

  const rawCors =
    Bun.env.CORS_ORIGINS ?? Bun.env.CORS_ORIGIN ?? DEFAULT_CORS_ORIGINS.join(",");
  const corsOrigins = rawCors
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter((origin) => origin.length > 0);

  app.use(
    "*",
    cors({
      origin: (origin) => {
        if (!origin) return null;
        const normalized = origin.trim().replace(/\/+$/, "");
        const isAllowed = corsOrigins.some((allowed) => {
          const target = allowed.trim().replace(/\/+$/, "");
          if (target === normalized) return true;
          if (target.startsWith("https://*.") || target.startsWith("http://*.")) {
            const suffix = target.slice(target.indexOf("*.") + 1);
            const proto = target.slice(0, target.indexOf("*"));
            return normalized.startsWith(proto) && normalized.endsWith(suffix);
          }
          return false;
        });
        return isAllowed ? origin : null;
      },
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    }),
  );

  const roomManager = new RoomManager();
  const connections = new ConnectionManager();
  const mafiaSessions = new MafiaSessionManager(roomManager);

  app.get("/", (c) =>
    c.json({
      status: "ok",
      service: "playroom-backend",
    }),
  );
  app.route("/health", health);
  app.route("/rooms", createRoomRouter(roomManager, connections));
  app.route("/ws", createWsRouter(roomManager, connections, mafiaSessions));
  app.route("/narrator", createNarratorRouter(new NarratorController()));

  return app;
}