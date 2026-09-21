import { createApp } from "./app.ts";

const port = Number(Bun.env.PORT ?? 3000);
const app = createApp();

console.log(`PLAYROOM backend listening on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
};