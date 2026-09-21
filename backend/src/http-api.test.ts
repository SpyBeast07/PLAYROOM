import { describe, expect, test } from "bun:test";
import { api, withServer } from "./test-server.ts";

function roomBody(json: Record<string, unknown> | null): Record<string, unknown> {
  return (json?.["room"] as Record<string, unknown>) ?? {};
}

function playersOf(json: Record<string, unknown> | null): Array<Record<string, unknown>> {
  const players = roomBody(json)["players"];
  return Array.isArray(players) ? (players as Array<Record<string, unknown>>) : [];
}

function playerFrom(json: Record<string, unknown> | null): Record<string, unknown> {
  return (json?.["player"] as Record<string, unknown>) ?? {};
}

async function createRoom(baseUrl: string): Promise<string> {
  const res = await api(baseUrl, "POST", "/rooms");
  expect(res.status).toBe(201);
  return roomBody(res.json)["code"] as string;
}

async function joinPlayer(baseUrl: string, code: string, name: string) {
  return api(baseUrl, "POST", `/rooms/${code}/players`, { name });
}

describe("health endpoint", () => {
  test("GET /health returns 200 with expected body", async () => {
    await withServer(async ({ baseUrl }) => {
      const res = await api(baseUrl, "GET", "/health");
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ status: "ok", service: "playroom-backend" });
    });
  });
});

describe("room creation", () => {
  test("POST /rooms creates a valid public room without internal fields", async () => {
    await withServer(async ({ baseUrl }) => {
      const res = await api(baseUrl, "POST", "/rooms");
      expect(res.status).toBe(201);
      const room = roomBody(res.json);
      expect(Object.keys(room).sort()).toEqual(["code", "createdAt", "players", "status"]);
      expect(room["code"]).toMatch(/^[A-Z0-9]{6}$/);
      expect(room["status"]).toBe("waiting");
      expect(room["players"]).toEqual([]);
      expect(typeof room["createdAt"]).toBe("number");
      expect(room["id"]).toBeUndefined();
    });
  });

  test("created rooms have unique codes", async () => {
    await withServer(async ({ baseUrl }) => {
      const codes = new Set<string>();
      for (let i = 0; i < 200; i++) {
        const res = await api(baseUrl, "POST", "/rooms");
        codes.add(roomBody(res.json)["code"] as string);
      }
      expect(codes.size).toBe(200);
    });
  });
});

describe("get room", () => {
  test("GET /rooms/:code returns the room; code is normalized to uppercase", async () => {
    await withServer(async ({ baseUrl }) => {
      const code = await createRoom(baseUrl);
      const res = await api(baseUrl, "GET", `/rooms/${code}`);
      expect(res.status).toBe(200);
      expect(roomBody(res.json)["code"]).toBe(code);

      const lower = await api(baseUrl, "GET", `/rooms/${code.toLowerCase()}`);
      expect(lower.status).toBe(200);
      expect(roomBody(lower.json)["code"]).toBe(code);
    });
  });

  test("GET /rooms/:code for a nonexistent room returns 404", async () => {
    await withServer(async ({ baseUrl }) => {
      const res = await api(baseUrl, "GET", "/rooms/ZZZZZZ");
      expect(res.status).toBe(404);
      expect(res.json).toEqual({ error: "Room not found" });
    });
  });
});

describe("player join", () => {
  test("first player joins as host; joinedAt not exposed", async () => {
    await withServer(async ({ baseUrl }) => {
      const code = await createRoom(baseUrl);
      const res = await joinPlayer(baseUrl, code, "Alice");
      expect(res.status).toBe(201);
      const player = playerFrom(res.json);
      expect(Object.keys(player).sort()).toEqual(["id", "isHost", "name"]);
      expect(player["name"]).toBe("Alice");
      expect(player["isHost"]).toBe(true);
      expect(typeof player["id"]).toBe("string");
      expect(player["id"]).not.toBe("");
      expect(player["joinedAt"]).toBeUndefined();

      const get = await api(baseUrl, "GET", `/rooms/${code}`);
      expect(playersOf(get.json).length).toBe(1);
    });
  });

  test("multiple players: unique ids, only first is host, duplicate names allowed, trimmed names", async () => {
    await withServer(async ({ baseUrl }) => {
      const code = await createRoom(baseUrl);
      const a = await joinPlayer(baseUrl, code, "Alice");
      const b = await joinPlayer(baseUrl, code, "Bob");
      const dup = await joinPlayer(baseUrl, code, "  Bob  ");

      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(dup.status).toBe(201);

      const ids = [a, b, dup].map((r) => playerFrom(r.json)["id"]);
      expect(new Set(ids).size).toBe(3);
      expect(playerFrom(a.json)["isHost"]).toBe(true);
      expect(playerFrom(b.json)["isHost"]).toBe(false);
      expect(playerFrom(dup.json)["isHost"]).toBe(false);
      expect(playerFrom(dup.json)["name"]).toBe("Bob");
    });
  });
});

describe("player validation", () => {
  test("rejects invalid names with 400 and does not insert a player", async () => {
    await withServer(async ({ baseUrl }) => {
      const code = await createRoom(baseUrl);
      const cases: Array<{ label: string; body: unknown }> = [
        { label: "empty name", body: { name: "" } },
        { label: "whitespace-only name", body: { name: "     " } },
        { label: "21-character name", body: { name: "012345678901234567890" } },
        { label: "non-string name", body: { name: 123 } },
        { label: "missing name", body: {} },
        { label: "null name", body: { name: null } },
        { label: "malformed JSON", body: "{not json" },
        { label: "empty body", body: "" },
      ];
      for (const c of cases) {
        const res = await api(baseUrl, "POST", `/rooms/${code}/players`, c.body);
        expect(res.status, c.label).toBe(400);
      }
      const get = await api(baseUrl, "GET", `/rooms/${code}`);
      expect(playersOf(get.json).length).toBe(0);
    });
  });

  test("20-character name is accepted", async () => {
    await withServer(async ({ baseUrl }) => {
      const code = await createRoom(baseUrl);
      const res = await joinPlayer(baseUrl, code, "01234567890123456789");
      expect(res.status).toBe(201);
      expect(playerFrom(res.json)["name"]).toBe("01234567890123456789");
    });
  });
});

describe("room capacity", () => {
  test("20 players join; the 21st is rejected with 409 Room full", async () => {
    await withServer(async ({ baseUrl }) => {
      const code = await createRoom(baseUrl);
      for (let i = 1; i <= 20; i++) {
        const res = await joinPlayer(baseUrl, code, `P${i}`);
        expect(res.status).toBe(201);
      }
      const beyond = await joinPlayer(baseUrl, code, "P21");
      expect(beyond.status).toBe(409);
      expect(beyond.json).toEqual({ error: "Room full" });

      const get = await api(baseUrl, "GET", `/rooms/${code}`);
      expect(playersOf(get.json).length).toBe(20);
    });
  });
});

describe("room lifecycle", () => {
  test("room is deleted after the final player leaves", async () => {
    await withServer(async ({ baseUrl }) => {
      const code = await createRoom(baseUrl);
      const a = await joinPlayer(baseUrl, code, "Alice");
      const b = await joinPlayer(baseUrl, code, "Bob");
      expect((await api(baseUrl, "GET", `/rooms/${code}`)).status).toBe(200);

      const delA = await api(baseUrl, "DELETE", `/rooms/${code}/players/${playerFrom(a.json)["id"]}`);
      expect(delA.status).toBe(204);
      expect((await api(baseUrl, "GET", `/rooms/${code}`)).status).toBe(200);

      const delB = await api(baseUrl, "DELETE", `/rooms/${code}/players/${playerFrom(b.json)["id"]}`);
      expect(delB.status).toBe(204);
      expect((await api(baseUrl, "GET", `/rooms/${code}`)).status).toBe(404);
    });
  });
});

describe("host transfer", () => {
  test("host moves to the first remaining player; never two hosts", async () => {
    await withServer(async ({ baseUrl }) => {
      const code = await createRoom(baseUrl);
      const alice = await joinPlayer(baseUrl, code, "Alice");
      const bob = await joinPlayer(baseUrl, code, "Bob");
      const charlie = await joinPlayer(baseUrl, code, "Charlie");

      const assertHosts = async (expectedHostName: string) => {
        const get = await api(baseUrl, "GET", `/rooms/${code}`);
        const players = playersOf(get.json);
        const hosts = players.filter((p) => p["isHost"] === true);
        expect(hosts.length).toBe(1);
        expect(hosts[0]?.["name"]).toBe(expectedHostName);
        return players;
      };

      await assertHosts("Alice");

      const removeAlice = await api(baseUrl, "DELETE", `/rooms/${code}/players/${playerFrom(alice.json)["id"]}`);
      expect(removeAlice.status).toBe(204);
      await assertHosts("Bob");

      const removeBob = await api(baseUrl, "DELETE", `/rooms/${code}/players/${playerFrom(bob.json)["id"]}`);
      expect(removeBob.status).toBe(204);
      await assertHosts("Charlie");

      const removeCharlie = await api(baseUrl, "DELETE", `/rooms/${code}/players/${playerFrom(charlie.json)["id"]}`);
      expect(removeCharlie.status).toBe(204);
      expect((await api(baseUrl, "GET", `/rooms/${code}`)).status).toBe(404);
    });
  });
});

describe("player removal", () => {
  test("removing a player keeps others; nonexistent player/room return 404; double remove is safe", async () => {
    await withServer(async ({ baseUrl }) => {
      const code = await createRoom(baseUrl);
      const alice = await joinPlayer(baseUrl, code, "Alice");
      await joinPlayer(baseUrl, code, "Bob");

      const del = await api(baseUrl, "DELETE", `/rooms/${code}/players/${playerFrom(alice.json)["id"]}`);
      expect(del.status).toBe(204);

      const get = await api(baseUrl, "GET", `/rooms/${code}`);
      const names = playersOf(get.json).map((p) => p["name"]);
      expect(names).toEqual(["Bob"]);

      const secondDel = await api(baseUrl, "DELETE", `/rooms/${code}/players/${playerFrom(alice.json)["id"]}`);
      expect(secondDel.status).toBe(404);

      const noPlayer = await api(baseUrl, "DELETE", `/rooms/${code}/players/does-not-exist`);
      expect(noPlayer.status).toBe(404);

      const noRoom = await api(baseUrl, "DELETE", "/rooms/ZZZZZZ/players/anything");
      expect(noRoom.status).toBe(404);

      const after = await api(baseUrl, "GET", `/rooms/${code}`);
      expect(playersOf(after.json).length).toBe(1);
    });
  });
});

describe("public state isolation", () => {
  test("HTTP responses never expose internal fields", async () => {
    await withServer(async ({ baseUrl }) => {
      const code = await createRoom(baseUrl);
      await joinPlayer(baseUrl, code, "Alice");
      await joinPlayer(baseUrl, code, "Bob");

      const get = await api(baseUrl, "GET", `/rooms/${code}`);
      const room = roomBody(get.json);
      expect(Object.keys(room).sort()).toEqual(["code", "createdAt", "players", "status"]);
      expect(room["id"]).toBeUndefined();

      for (const player of playersOf(get.json)) {
        expect(Object.keys(player).sort()).toEqual(["id", "isHost", "name"]);
        expect(player["joinedAt"]).toBeUndefined();
      }

      const joined = await api(baseUrl, "POST", "/rooms");
      expect(Object.keys(roomBody(joined.json)).sort()).toEqual(["code", "createdAt", "players", "status"]);
    });
  });
});

describe("error mapping", () => {
  test("domain error codes map to correct HTTP statuses", async () => {
    await withServer(async ({ baseUrl }) => {
      const code = await createRoom(baseUrl);

      // ROOM_NOT_FOUND → 404
      expect((await api(baseUrl, "GET", "/rooms/ZZZZZZ")).status).toBe(404);

      // PLAYER_NOT_FOUND → 404
      expect((await api(baseUrl, "DELETE", `/rooms/${code}/players/nope`)).status).toBe(404);

      // INVALID_PLAYER_NAME → 400
      expect((await joinPlayer(baseUrl, code, "")).status).toBe(400);

      // ROOM_FULL → 409
      for (let i = 1; i <= 20; i++) {
        await joinPlayer(baseUrl, code, `P${i}`);
      }
      expect((await joinPlayer(baseUrl, code, "P21")).status).toBe(409);

      // ROOM_STARTED is not reachable through HTTP (no start endpoint yet); covered at domain level.
    });
  });
});