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

## Run tests

```bash
bun run test
```

Tests use Bun's native test runner and spin up real HTTP + WebSocket servers on ephemeral ports.

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

## WebSocket endpoint

Rooms can be subscribed to for real-time room updates.

### Connect

```text
/ws/rooms/:code?playerId=<playerId>
```

The `playerId` is the opaque ID returned by `POST /rooms/:code/players`. The connection is
rejected (HTTP error) if the `playerId` query parameter is missing, the room does not exist,
or the player does not belong to the room.

```bash
# example client (browser or any WebSocket client)
wscat -c "ws://localhost:3000/ws/rooms/A7K9P2?playerId=<playerId>"
```

### Connection lifecycle

On a successful connection, the server immediately sends:

1. `connected` with the player's ID
2. `room.updated` with the current public room state

```json
{ "type": "connected", "playerId": "abc123" }
```

```json
{
  "type": "room.updated",
  "room": {
    "code": "A7K9P2",
    "status": "waiting",
    "players": [{ "id": "abc123", "name": "Alice", "isHost": true }],
    "createdAt": 1750000000000
  }
}
```

### Server → client messages

```ts
type ServerMessage =
  | { type: "connected"; playerId: string }
  | { type: "room.updated"; room: PublicRoom }
  | { type: "pong" }
  | { type: "error"; code: string; message: string };
```

### Client → server messages

```ts
type ClientMessage = { type: "ping" };
```

`ping` is answered with `pong`. The connection stays open.

Malformed JSON is answered with `{ "type": "error", "code": "INVALID_MESSAGE", ... }`.
Valid JSON with an unsupported `type` is answered with
`{ "type": "error", "code": "UNKNOWN_MESSAGE_TYPE", ... }`. Invalid messages do not close the
connection.

### Room update behavior

Whenever a player joins (`POST /rooms/:code/players`) or leaves
(`DELETE /rooms/:code/players/:playerId`) an existing room through the HTTP API, the server
broadcasts `room.updated` (the public room state via `toPublicRoom`) to every connected
client in that room. The internal room object, internal room ID, and `joinedAt` are never sent.

### Disconnect vs leaving

Closing a WebSocket only removes that **connection**. The **player remains in the room**.
A network disconnect is not a room leave: future reconnection reuses the same `playerId`.
The explicit room-leave operation is `DELETE /rooms/:code/players/:playerId`. If a leaving
player still has an open WebSocket, the server closes that connection. Rooms are not
preserved when the last player leaves.

### Reconnection

Reconnecting with the same `playerId` establishes a fresh association with the same
room/player and replays `connected` + `room.updated`. There is no session system yet.

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

The backend exposes `/health`, the in-memory room API, and a WebSocket endpoint that
broadcasts room-level updates. It is structured as:

```
src/
├── index.ts              # server entry point (port config, Bun.serve + websocket)
├── app.ts                # Hono application (middleware, routes, wiring)
├── routes/
│   ├── health.ts         # GET /health
│   └── rooms.ts          # in-memory room endpoints (creates/broadcasts)
├── rooms/
│   ├── types.ts          # Room / Player types + public-state mappers
│   └── room-manager.ts   # in-memory RoomManager (domain, transport-agnostic)
└── realtime/
    ├── types.ts          # WebSocket message types + Connection model
    ├── connection-manager.ts  # active connections, room broadcasts (owns no room state)
    └── ws.ts             # /ws/rooms/:code upgrade + client message handling
```

`RoomManager` remains the single source of truth for room membership. The WebSocket layer
only tracks *connections*; it never stores its own copy of players.

## Not implemented yet

Mafia (game engine and rules), Mafia/game state, game events, ready/start game, chat,
authentication, database / persistence, matchmaking, accounts, and narrator/pass-the-phone
modes are intentionally **not** implemented yet.

Current limitations:

- Rooms and connections live only in memory and are gone after a backend restart.
- WebSockets currently only synchronize **room/lobby state** (`room.updated`). Game/Mafia
  events are not implemented yet, and there is no protocol for game messages.
- There is no way to transition a room from `waiting` to `playing` yet; the model is
  structured to allow it in a future phase.
- The host is only a lobby concept (join/host-transfer) and is **not** authoritative over any
  future game state.
- No session/authentication system: the `playerId` query parameter is enough to associate a
  connection, and duplicate connections per player are allowed.
- No heartbeat / reconnection tokens / persistent sessions yet.

The Mafia rules live only in `docs/mafia-spec.md` at this stage.