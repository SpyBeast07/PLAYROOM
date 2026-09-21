# backend

Bun + Hono backend for PLAYROOM.

## Install dependencies

```bash
bun install
```

## Run the development server

```bash
bun run dev
```

The dev server uses Bun's `--hot` flag, so files are reloaded automatically on change.
A plain (non-watch) start is available via `bun run start`.

## Development port

Defaults to **3000**. Override with the `PORT` environment variable:

```bash
PORT=4000 bun run dev
```

## GET /health

```bash
curl http://localhost:3000/health
```

```json
{
  "status": "ok",
  "service": "playroom-backend"
}
```

## CORS

Development CORS allows requests from `http://localhost:5173` (the SvelteKit dev server)
by default. Override with the `CORS_ORIGIN` environment variable (comma-separated list):

```bash
CORS_ORIGIN="http://localhost:5173,http://localhost:4173" bun run dev
```

## Typecheck

```bash
bun run typecheck
```

## Current scope

This is the backend foundation only. It exposes the `/health` route and is structured as:

```
src/
├── index.ts        # server entry point (port config, Bun.serve)
├── app.ts          # Hono application (middleware, routes)
└── routes/
    └── health.ts   # GET /health
```

## Not implemented yet

Rooms, WebSockets, Mafia (game engine and rules), authentication, database / persistence,
and game state are intentionally **not** implemented yet. The Mafia rules live only in
`docs/mafia-spec.md` at this stage.