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

## Room endpoints

Rooms are **in-memory only**. Everything lives in the running process and **disappears when the
backend restarts**. Rooms start in `waiting` status; there is currently no way to transition a
room to `playing`.

### POST /rooms

Creates a room and returns its public state with a random 6-character code (A–Z, 0–9).

```bash
curl -X POST http://localhost:3000/rooms
```

```json
{
  "room": {
    "code": "A7K9P2",
    "status": "waiting",
    "players": [],
    "createdAt": 1750000000000
  }
}
```

### GET /rooms/:code

Returns the public room state.

```bash
curl http://localhost:3000/rooms/A7K9P2
```

```json
{
  "room": {
    "code": "A7K9P2",
    "status": "waiting",
    "players": [
      {
        "id": "opaque-id",
        "name": "Alice",
        "isHost": true
      }
    ],
    "createdAt": 1750000000000
  }
}
```

### POST /rooms/:code/players

Adds a player to a room. The first player to join becomes the host. The returned player `id`
is required so a future client can identify itself.

```bash
curl -X POST http://localhost:3000/rooms/A7K9P2/players \
  -H "Content-Type: application/json" \
  -d '{"name": "Alice"}'
```

```json
{
  "player": {
    "id": "opaque-id",
    "name": "Alice",
    "isHost": true
  },
  "room": {
    "code": "A7K9P2",
    "status": "waiting",
    "players": []
  }
}
```

### DELETE /rooms/:code/players/:playerId

Removes a player. If the removed player was the host, host status transfers to the first
remaining player. If the room becomes empty, the room is destroyed.

```bash
curl -X DELETE http://localhost:3000/rooms/A7K9P2/players/opaque-id
```

Returns `204 No Content` on success.

### Room and player constraints

- Room code: 6 uppercase alphanumeric characters (A–Z, 0–9), unique among active rooms.
- Player name: trimmed; 1–20 characters. Duplicate names are allowed.
- Maximum room size: 20 players. Minimum size is not enforced yet.
- A room accepts players only while `status` is `waiting`.
- Player IDs are opaque UUIDs. Duplicate names are allowed.

### Errors

Errors return consistent JSON with an appropriate status code:

```json
{ "error": "Room not found" }
```

`400` invalid request body / invalid player name, `404` room or player not found,
`409` room full or room already started.

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

The backend exposes `/health` and the in-memory room API, and is structured as:

```
src/
├── index.ts           # server entry point (port config, Bun.serve)
├── app.ts             # Hono application (middleware, routes)
├── routes/
│   ├── health.ts      # GET /health
│   └── rooms.ts       # in-memory room endpoints
└── rooms/
    ├── types.ts       # Room / Player types + public-state mappers
    └── room-manager.ts # in-memory RoomManager (no HTTP concerns)
```

## Not implemented yet

WebSockets, Mafia (game engine and rules), game state, authentication, database /
persistence, chat, matchmaking, and accounts are intentionally **not** implemented yet.

Current limitations:

- Rooms live only in memory and are gone after a backend restart.
- There is no way to transition a room from `waiting` to `playing` yet; the model is
  structured to allow it in a future phase.
- The host is only a lobby concept (join/host-transfer) and is **not** authoritative over any
  future game state.
- No player reconnection, since there is no transport/connection layer yet.

The Mafia rules live only in `docs/mafia-spec.md` at this stage.