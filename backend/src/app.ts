import { Hono } from "hono";
import { cors } from "hono/cors";
import { health } from "./routes/health.ts";

const DEFAULT_CORS_ORIGINS = ["http://localhost:5173"];

export function createApp() {
  const app = new Hono();

  const corsOrigins = (Bun.env.CORS_ORIGIN ?? DEFAULT_CORS_ORIGINS.join(","))
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  app.use("*", cors({ origin: corsOrigins }));

  app.route("/health", health);

  return app;
}