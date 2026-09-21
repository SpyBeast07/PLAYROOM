import { describe, expect, test } from "bun:test";
import { WsClient, api, expectNoMessage, expectOpen, expectRejected, sleep, withServer } from "./test-server.ts";

type AnyRecord = Record<string, unknown>;

async function createRoom(baseUrl: string): Promise<string> {
  const res = await api(baseUrl, "POST", "/rooms");
  expect(res.status).toBe(201);
  return (res.json?.["room"] as AnyRecord)["code"] as string;
}

async function joinPlayer(baseUrl: string, code: string, name: string): Promise<string> {
  const res = await api(baseUrl, "POST", `/rooms/${code}/players`, { name });
  expect(res.status).toBe(201);
  return (res.json?.["player"] as AnyRecord)["id"] as string;
}

function roomOf(msg: { type: string; [k: string]: unknown }): AnyRecord {
  return msg["room"] as AnyRecord;
}

function playerCount(msg: { type: string; [k: string]: unknown }): number {
  const players = roomOf(msg)["players"];
  return Array.isArray(players) ? players.length : 0;
}

describe("WebSocket connection", () => {
  test("valid connection receives connected then room.updated with public room state", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const code = await createRoom(baseUrl);
      const aliceId = await joinPlayer(baseUrl, code, "Alice");

      const client = new WsClient(`${wsBase}/ws/rooms/${code}?playerId=${aliceId}`);
      expect(await expectOpen(client)).toBe(true);

      const connected = await client.next();
      expect(connected["type"]).toBe("connected");
      expect(connected["playerId"]).toBe(aliceId);

      const updated = await client.next();
      expect(updated["type"]).toBe("room.updated");
      expect(Object.keys(roomOf(updated)).sort()).toEqual(["code", "createdAt", "players", "status"]);

      client.close();
    });
  });

  test("missing playerId is rejected", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const code = await createRoom(baseUrl);
      const client = new WsClient(`${wsBase}/ws/rooms/${code}`);
      expect(await expectRejected(client)).toBe(true);
    });
  });

  test("invalid room is rejected", async () => {
    await withServer(async ({ wsBase }) => {
      const client = new WsClient(`${wsBase}/ws/rooms/DOESNT?playerId=abc`);
      expect(await expectRejected(client)).toBe(true);
    });
  });

  test("invalid player (known room, unknown id) is rejected", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const code = await createRoom(baseUrl);
      const client = new WsClient(`${wsBase}/ws/rooms/${code}?playerId=unknown-id`);
      expect(await expectRejected(client)).toBe(true);
    });
  });

  test("player from another room is rejected", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const roomA = await createRoom(baseUrl);
      const roomB = await createRoom(baseUrl);
      const aliceInA = await joinPlayer(baseUrl, roomA, "Alice");
      const bobInB = await joinPlayer(baseUrl, roomB, "Bob");

      const bobConnectingToA = new WsClient(`${wsBase}/ws/rooms/${roomA}?playerId=${bobInB}`);
      expect(await expectRejected(bobConnectingToA)).toBe(true);

      const aliceConnectingToA = new WsClient(`${wsBase}/ws/rooms/${roomA}?playerId=${aliceInA}`);
      expect(await expectOpen(aliceConnectingToA)).toBe(true);
      aliceConnectingToA.close();
    });
  });
});

describe("WebSocket room synchronization", () => {
  test("HTTP join/leave is broadcast to connected clients", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const code = await createRoom(baseUrl);
      const aliceId = await joinPlayer(baseUrl, code, "Alice");
      const bobId = await joinPlayer(baseUrl, code, "Bob");

      const alice = new WsClient(`${wsBase}/ws/rooms/${code}?playerId=${aliceId}`);
      const bob = new WsClient(`${wsBase}/ws/rooms/${code}?playerId=${bobId}`);
      expect(await expectOpen(alice)).toBe(true);
      expect(await expectOpen(bob)).toBe(true);
      await alice.next(); // connected
      await alice.next(); // room.updated
      await bob.next();   // connected
      await bob.next();   // room.updated

      // Charlie joins through HTTP
      const charlieRes = await api(baseUrl, "POST", `/rooms/${code}/players`, { name: "Charlie" });
      expect(charlieRes.status).toBe(201);

      for (const client of [alice, bob]) {
        const updated = await client.next();
        expect(updated["type"]).toBe("room.updated");
        expect(playerCount(updated)).toBe(3);
      }

      // Charlie leaves through HTTP
      const charlieId = (charlieRes.json?.["player"] as AnyRecord)["id"] as string;
      const del = await api(baseUrl, "DELETE", `/rooms/${code}/players/${charlieId}`);
      expect(del.status).toBe(204);

      for (const client of [alice, bob]) {
        const updated = await client.next();
        expect(updated["type"]).toBe("room.updated");
        expect(playerCount(updated)).toBe(2);
      }

      alice.close();
      bob.close();
    });
  });
});

describe("WebSocket disconnect and reconnect", () => {
  test("disconnect keeps the player in the room; reconnect re-sends connected + room.updated", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const code = await createRoom(baseUrl);
      const aliceId = await joinPlayer(baseUrl, code, "Alice");

      const first = new WsClient(`${wsBase}/ws/rooms/${code}?playerId=${aliceId}`);
      expect(await expectOpen(first)).toBe(true);
      const c1 = await first.next();
      expect(c1["type"]).toBe("connected");
      await first.next();
      first.close();
      await sleep(100);

      const get = await api(baseUrl, "GET", `/rooms/${code}`);
      const players = (get.json?.["room"] as AnyRecord)["players"] as Array<{ id: string }>;
      expect(players.some((p) => p.id === aliceId)).toBe(true);

      const second = new WsClient(`${wsBase}/ws/rooms/${code}?playerId=${aliceId}`);
      expect(await expectOpen(second)).toBe(true);
      expect((await second.next())["type"]).toBe("connected");
      expect((await second.next())["type"]).toBe("room.updated");

      second.close();
    });
  });
});

describe("WebSocket messages", () => {
  test("ping is answered with pong", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const code = await createRoom(baseUrl);
      const id = await joinPlayer(baseUrl, code, "Alice");
      const client = new WsClient(`${wsBase}/ws/rooms/${code}?playerId=${id}`);
      expect(await expectOpen(client)).toBe(true);
      await client.next();
      await client.next();

      client.send({ type: "ping" });
      const pong = await client.next();
      expect(pong).toEqual({ type: "pong" });
      client.close();
    });
  });

  test("malformed message returns INVALID_MESSAGE and the connection stays open", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const code = await createRoom(baseUrl);
      const id = await joinPlayer(baseUrl, code, "Alice");
      const client = new WsClient(`${wsBase}/ws/rooms/${code}?playerId=${id}`);
      expect(await expectOpen(client)).toBe(true);
      await client.next();
      await client.next();

      client.sentRaw("{not json");
      const err = await client.next();
      expect(err).toEqual({ type: "error", code: "INVALID_MESSAGE", message: "Invalid message" });

      client.send({ type: "ping" });
      expect((await client.next())["type"]).toBe("pong");
      client.close();
    });
  });

  test("unknown message type returns UNKNOWN_MESSAGE_TYPE and the connection stays open", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const code = await createRoom(baseUrl);
      const id = await joinPlayer(baseUrl, code, "Alice");
      const client = new WsClient(`${wsBase}/ws/rooms/${code}?playerId=${id}`);
      expect(await expectOpen(client)).toBe(true);
      await client.next();
      await client.next();

      client.send({ type: "unknown" });
      const err = await client.next();
      expect(err).toEqual({ type: "error", code: "UNKNOWN_MESSAGE_TYPE", message: "Unknown message type" });

      client.send({ type: "ping" });
      expect((await client.next())["type"]).toBe("pong");
      client.close();
    });
  });
});

describe("WebSocket + room lifecycle", () => {
  test("removed player's connection closes and the player cannot reconnect", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const code = await createRoom(baseUrl);
      const id = await joinPlayer(baseUrl, code, "Alice");
      const client = new WsClient(`${wsBase}/ws/rooms/${code}?playerId=${id}`);
      expect(await expectOpen(client)).toBe(true);
      await client.next();
      await client.next();

      const del = await api(baseUrl, "DELETE", `/rooms/${code}/players/${id}`);
      expect(del.status).toBe(204);

      const closed = await Promise.race([client.closed, sleep(1500).then(() => false)]);
      expect(closed).toBe(true);

      const reconnect = new WsClient(`${wsBase}/ws/rooms/${code}?playerId=${id}`);
      expect(await expectRejected(reconnect)).toBe(true);
    });
  });

  test("deleting the only player removes the room, closes the socket, and blocks reconnect", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const code = await createRoom(baseUrl);
      const id = await joinPlayer(baseUrl, code, "Alice");
      const client = new WsClient(`${wsBase}/ws/rooms/${code}?playerId=${id}`);
      expect(await expectOpen(client)).toBe(true);
      await client.next();
      await client.next();

      const del = await api(baseUrl, "DELETE", `/rooms/${code}/players/${id}`);
      expect(del.status).toBe(204);
      expect((await api(baseUrl, "GET", `/rooms/${code}`)).status).toBe(404);

      const closed = await Promise.race([client.closed, sleep(1500).then(() => false)]);
      expect(closed).toBe(true);

      const reconnect = new WsClient(`${wsBase}/ws/rooms/${code}?playerId=${id}`);
      expect(await expectRejected(reconnect)).toBe(true);
    });
  });
});

describe("cross-room isolation", () => {
  test("a room update reaches only that room's clients", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const roomA = await createRoom(baseUrl);
      const roomB = await createRoom(baseUrl);
      const aliceA = await joinPlayer(baseUrl, roomA, "Alice");
      const bobB = await joinPlayer(baseUrl, roomB, "Bob");

      const a = new WsClient(`${wsBase}/ws/rooms/${roomA}?playerId=${aliceA}`);
      const b = new WsClient(`${wsBase}/ws/rooms/${roomB}?playerId=${bobB}`);
      expect(await expectOpen(a)).toBe(true);
      expect(await expectOpen(b)).toBe(true);
      await a.next(); await a.next();
      await b.next(); await b.next();

      // Modify room A only
      await api(baseUrl, "POST", `/rooms/${roomA}/players`, { name: "Charlie" });

      const seen = await a.next();
      expect(seen["type"]).toBe("room.updated");
      expect(playerCount(seen)).toBe(2);
      expect(await expectNoMessage(b, 400)).toBe(true);

      a.close();
      b.close();
    });
  });
});

describe("HTTP + WebSocket concurrency sanity", () => {
  test("clients converge on the correct final public room state across sequential changes", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const code = await createRoom(baseUrl);
      const aliceId = await joinPlayer(baseUrl, code, "Alice");
      const bobId = await joinPlayer(baseUrl, code, "Bob");

      const alice = new WsClient(`${wsBase}/ws/rooms/${code}?playerId=${aliceId}`);
      const bob = new WsClient(`${wsBase}/ws/rooms/${code}?playerId=${bobId}`);
      expect(await expectOpen(alice)).toBe(true);
      expect(await expectOpen(bob)).toBe(true);
      await alice.next(); await alice.next();
      await bob.next(); await bob.next();

      const charlieId = await joinPlayer(baseUrl, code, "Charlie");
      const daveRes = await api(baseUrl, "POST", `/rooms/${code}/players`, { name: "Dave" });
      const daveId = (daveRes.json?.["player"] as AnyRecord)["id"] as string;

      for (const client of [alice, bob]) {
        expect((await client.next())["type"]).toBe("room.updated"); // Charlie
        expect((await client.next())["type"]).toBe("room.updated"); // Dave
      }

      await api(baseUrl, "DELETE", `/rooms/${code}/players/${daveId}`);

      for (const client of [alice, bob]) {
        const seen = await client.next();
        expect(seen["type"]).toBe("room.updated");
        expect(playerCount(seen)).toBe(3);
      }

      await api(baseUrl, "DELETE", `/rooms/${code}/players/${charlieId}`);

      const get = await api(baseUrl, "GET", `/rooms/${code}`);
      const finalNames = (get.json?.["room"] as AnyRecord)["players"] as Array<{ name: string }>;

      for (const client of [alice, bob]) {
        const seen = await client.next();
        expect(seen["type"]).toBe("room.updated");
        expect(playerCount(seen)).toBe(2);
        const roomPlayers = roomOf(seen)["players"] as Array<{ name: string }>;
        expect(roomPlayers.map((p) => p.name).sort()).toEqual(
          finalNames.map((p) => p.name).sort(),
        );
      }

      alice.close();
      bob.close();
    });
  });
});