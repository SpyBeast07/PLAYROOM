import { websocket } from "hono/bun";
import { createApp } from "./app.ts";

const port = Number(Bun.env.PORT ?? 3000);
const hostname = Bun.env.HOST ?? "0.0.0.0";
const app = createApp();

console.log(`PLAYROOM backend listening on http://${hostname}:${port}`);

export default {
  port,
  hostname,
  fetch: app.fetch,
  websocket,
};