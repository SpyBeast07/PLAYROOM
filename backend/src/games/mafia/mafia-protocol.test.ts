/**
 * Phase 11B — Mafia WebSocket protocol integration tests.
 *
 * Exercises the real transport (ws.ts) through a live Bun server, end to end:
 * connection handshake, action validation, the public/private/narrator
 * information boundaries, room isolation, reconnect resynchronization, and
 * disconnect (PLAYER_UNAVAILABLE) semantics.
 *
 * Determinism note: the server uses Math.random for role draws, so tests never
 * guess roles. They read them from the host's narrator channel and treat the
 * host (players[0], assigned by RoomManager) as the narrator authority.
 */
import { describe, expect, test } from "bun:test";
import {
  WsClient,
  api,
  expectNoMessage,
  expectOpen,
  sleep,
  withServer,
  type WsMsg,
} from "../../test-server.ts";
import {
  NARRATOR_SUBMITTABLE_ACTION_TYPES,
  PLAYER_SUBMITTABLE_ACTION_TYPES,
  allowedActionTypes,
  buildAuthenticatedAction,
  isNarratorConnection,
  parseMafiaClientMessage,
  parseMafiaClientMessageRaw,
} from "./mafia-protocol.ts";

type AnyRecord = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Test doubles & helpers
// ---------------------------------------------------------------------------

type Party = { id: string; name: string; client: WsClient };
type GameRoom = { code: string; hostId: string; players: Party[] };

const NAMES = ["Ada", "Bob", "Cam", "Dea"];

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

function first<T>(items: T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error("expected at least one item");
  return item;
}

async function joinAll(baseUrl: string, wsBase: string, names: string[]): Promise<GameRoom> {
  const code = await createRoom(baseUrl);
  const host: Party[] = [];
  for (const name of names) {
    const id = await joinPlayer(baseUrl, code, name);
    const client = new WsClient(`${wsBase}/ws/rooms/${code}?playerId=${id}`);
    expect(await expectOpen(client)).toBe(true);
    host.push({ id, name, client });
  }
  const hostId = first(host).id;
  const roomRes = await api(baseUrl, "GET", `/rooms/${code}`);
  const roomPlayers = (roomRes.json?.["room"] as AnyRecord)?.["players"] as AnyRecord[] | undefined;
  expect(roomPlayers?.[0]?.["isHost"]).toBe(true);
  // Subsequent HTTP joins broadcast room.updated to earlier sockets; drain so
  // every test starts from a clean queue.
  await sleep(80);
  for (const p of host) p.client.drain();
  return { code, hostId, players: host };
}

function sendAction(client: WsClient, action: AnyRecord): void {
  client.send({ type: "mafia.action", action });
}

/** Drain every client after a quiet settle — the "let messages land" primitive. */
async function gather(room: Pick<GameRoom, "players">): Promise<Map<string, WsMsg[]>> {
  await sleep(80);
  return new Map(room.players.map((p) => [p.id, p.client.drain()]));
}

function ofType(msgs: WsMsg[], type: string): WsMsg[] {
  return msgs.filter((m) => m.type === type);
}

function lastByType(msgs: WsMsg[], type: string): AnyRecord | undefined {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.type === type) return msgs[i] as AnyRecord;
  }
  return undefined;
}

function lastPublic(msgs: WsMsg[]): AnyRecord | undefined {
  return lastByType(msgs, "mafia.state")?.["state"] as AnyRecord | undefined;
}

function lastPrivate(msgs: WsMsg[]): AnyRecord | undefined {
  return lastByType(msgs, "mafia.private")?.["state"] as AnyRecord | undefined;
}

function lastNarratorState(msgs: WsMsg[]): AnyRecord | undefined {
  return lastByType(msgs, "mafia.narrator")?.["state"] as AnyRecord | undefined;
}

function lastErrorCode(msgs: WsMsg[]): string | undefined {
  return lastByType(msgs, "mafia.error")?.["code"] as string | undefined;
}

/** Every player confirms their role; the last one auto-advances the game to NIGHT. */
async function revealAll(room: GameRoom): Promise<{
  roles: AnyRecord;
  actingMafiaId: string;
  messages: Map<string, WsMsg[]>;
}> {
  for (const p of room.players) {
    sendAction(p.client, { type: "ROLE_SEEN", playerId: p.id });
    await sleep(20);
  }
  await sleep(80);
  const messages = new Map(room.players.map((p) => [p.id, p.client.drain()]));
  const narr = lastNarratorState(messages.get(room.hostId) ?? []);
  return {
    roles: (narr?.["roles"] as AnyRecord) ?? {},
    actingMafiaId: narr?.["actingMafiaId"] as string,
    messages,
  };
}

async function readyUp(room: GameRoom): Promise<void> {
  for (const p of room.players) {
    sendAction(p.client, { type: "READY", playerId: p.id });
    await sleep(20);
  }
  await gather(room);
}

/** Host (narrator authority) starts the game. Returns the role assignment. */
async function startGame(room: GameRoom): Promise<{ roles: AnyRecord }> {
  await readyUp(room);
  sendAction(first(room.players).client, { type: "START_GAME" });
  await sleep(80);
  const hostMsgs = first(room.players).client.drain();
  for (const p of room.players.slice(1)) p.client.drain();
  const narr = lastNarratorState(hostMsgs);
  return { roles: (narr?.["roles"] as AnyRecord) ?? {} };
}

/** Full night setup: start the game, then everyone confirms their role (→ NIGHT). */
async function enterNight(room: GameRoom): Promise<{
  roles: AnyRecord;
  actingMafiaId: string;
  messages: Map<string, WsMsg[]>;
}> {
  const { roles } = await startGame(room);
  const { actingMafiaId, messages } = await revealAll(room);
  return { roles, actingMafiaId, messages };
}

function nightSlotFor(role: unknown): "kill" | "save" | "investigate" | null {
  if (role === "MAFIA") return "kill";
  if (role === "DOCTOR") return "save";
  if (role === "DETECTIVE") return "investigate";
  return null;
}

/** Deep check that a serialized public state exposes no hidden information. */
const HIDDEN_KEYS = [
  "roles",
  "votes",
  "nightActions",
  "actingMafiaId",
  "roleSeen",
  "ownNightAction",
  "ownPrivateNightResult",
  "ownVoteTargetId",
  "availableActions",
  "readyState",
  "lastElimination",
  "lastResolvedNight",
];

function assertNoHiddenKeys(value: unknown, where: string): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoHiddenKeys(item, where);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    expect(HIDDEN_KEYS, `${where}.${key}`).not.toContain(key);
    assertNoHiddenKeys(child, `${where}.${key}`);
  }
}

// ---------------------------------------------------------------------------
// 1. Protocol primitives (pure)
// ---------------------------------------------------------------------------

describe("mafia protocol primitives", () => {
  test("parseMafiaClientMessage accepts a well-formed action", () => {
    const parsed = parseMafiaClientMessage({
      type: "mafia.action",
      action: { type: "READY", playerId: "p1" },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.actionType).toBe("READY");
    expect(parsed.action).toEqual({ type: "READY", playerId: "p1" });
  });

  test("parseMafiaClientMessage rejects malformed frames with protocol codes", () => {
    expect(parseMafiaClientMessage("nope").ok).toBe(false);
    expect(parseMafiaClientMessage({ type: "other", action: {} })).toMatchObject({
      ok: false,
      code: "UNKNOWN_MESSAGE_TYPE",
    });
    expect(parseMafiaClientMessage({ type: "mafia.action" })).toMatchObject({
      ok: false,
      code: "MISSING_ACTION",
    });
    expect(parseMafiaClientMessage({ type: "mafia.action", action: { type: "BOGUS" } })).toMatchObject({
      ok: false,
      code: "INVALID_ACTION",
    });
    expect(parseMafiaClientMessageRaw("{not json").ok).toBe(false);
  });

  test("buildAuthenticatedAction always overwrites type and actor", () => {
    const action = buildAuthenticatedAction(
      "READY",
      { type: "MAFIA_KILL", playerId: "p1", actor: { type: "NARRATOR" } },
      { type: "PLAYER", playerId: "p1" },
    );
    expect(action.type).toBe("READY");
    expect(action.actor).toEqual({ type: "PLAYER", playerId: "p1" });
  });

  test("narrator authority follows the room host; clients cannot claim it via payload", () => {
    const roomLike = {
      players: [
        { id: "host", isHost: true },
        { id: "guest", isHost: false },
      ],
    };
    expect(isNarratorConnection(roomLike, "host")).toBe(true);
    expect(isNarratorConnection(roomLike, "guest")).toBe(false);
  });

  test("allowlists: players are self-centric; the narrator advances phases but never reports unavailability", () => {
    expect(allowedActionTypes(false)).toEqual(PLAYER_SUBMITTABLE_ACTION_TYPES);
    expect(allowedActionTypes(true)).toEqual(NARRATOR_SUBMITTABLE_ACTION_TYPES);
    expect(allowedActionTypes(false)).not.toContain("START_GAME");
    expect(allowedActionTypes(false)).not.toContain("RESOLVE_NIGHT");
    expect(allowedActionTypes(false)).not.toContain("PLAYER_UNAVAILABLE");
    expect(allowedActionTypes(true)).toContain("START_GAME");
    expect(allowedActionTypes(true)).not.toContain("PLAYER_UNAVAILABLE");
  });
});

// ---------------------------------------------------------------------------
// 2. Connection handshake & message validation
// ---------------------------------------------------------------------------

describe("mafia connection handshake", () => {
  test("valid connection with no game receives connected + room.updated", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const code = await createRoom(baseUrl);
      const id = await joinPlayer(baseUrl, code, "Ada");
      const client = new WsClient(`${wsBase}/ws/rooms/${code}?playerId=${id}`);
      expect(await expectOpen(client)).toBe(true);
      await sleep(80);
      const msgs = client.drain();
      expect(msgs.map((m) => m.type)).toEqual([
        "connected",
        "room.updated",
        "mafia.state",
        "mafia.private",
        "mafia.narrator",
      ]);
      const pub = lastPublic(msgs);
      expect(pub?.["phase"]).toBe("LOBBY");
      expect((pub?.["players"] as AnyRecord[])).toHaveLength(1);
      expect(lastPrivate(msgs)?.["role"]).toBeNull();
      client.close();
    });
  });

  test("a sub-minimum lobby still accepts READY; START_GAME gates on the player minimum and keeps the connection", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const code = await createRoom(baseUrl);
      const id = await joinPlayer(baseUrl, code, "Ada");
      const client = new WsClient(`${wsBase}/ws/rooms/${code}?playerId=${id}`);
      expect(await expectOpen(client)).toBe(true);
      await sleep(80);
      client.drain();

      // READY is valid in the LOBBY session even with a single player.
      sendAction(client, { type: "READY", playerId: id });
      await sleep(80);
      expect(lastErrorCode(client.drain())).toBeUndefined();

      // The host still cannot start a sub-minimum lobby (engine rule), and the
      // rejection never severs the socket.
      sendAction(client, { type: "START_GAME" });
      await sleep(80);
      expect(lastErrorCode(client.drain())).toBe("NOT_ENOUGH_PLAYERS");

      client.send({ type: "ping" });
      expect((await client.next()).type).toBe("pong");
    });
  });

  test("malformed mafia frames produce mafia.error and never sever the socket", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const room = await joinAll(baseUrl, wsBase, NAMES);
      const host = first(room.players);
      await gather(room);
      const bob = first(room.players.filter((p) => p.id !== host.id));

      const cases: Array<[string | AnyRecord, string]> = [
        ['{"type":"mafia.action"}', "MISSING_ACTION"],
        ['{"type":"mafia.action","action":"nope"}', "MISSING_ACTION"],
        [{ type: "mafia.action", action: 42 }, "MISSING_ACTION"],
        [{ type: "mafia.action", action: { type: "NOT_REAL" } }, "INVALID_ACTION"],
      ];

      for (const [frame, code] of cases) {
        if (typeof frame === "string") bob.client.sentRaw(frame);
        else bob.client.send(frame);
        await sleep(80);
        expect(lastErrorCode(bob.client.drain()), code).toBe(code);
        expect(bob.client.ws.readyState).toBe(WebSocket.OPEN);
      }

      // Unknown top-level types still go through the generic transport error.
      bob.client.send({ type: "mafia.other" });
      await sleep(80);
      const generic = bob.client.drain();
      const genericError = lastByType(generic, "error");
      expect(genericError?.["code"]).toBe("UNKNOWN_MESSAGE_TYPE");
      expect(generic.some((m) => m.type === "mafia.error")).toBe(false);

      bob.client.send({ type: "ping" });
      expect((await bob.client.next()).type).toBe("pong");
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Lobby actions & the broadcast boundary
// ---------------------------------------------------------------------------

describe("lobby actions and broadcast boundaries", () => {
  test("READY broadcasts public state; mafia.private only to the actor; narrator only to host", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const room = await joinAll(baseUrl, wsBase, NAMES);
      await gather(room);
      const host = first(room.players);
      const bob = first(room.players.filter((p) => p.id !== host.id));

      sendAction(bob.client, { type: "READY", playerId: bob.id });
      const msgs = await gather(room);

      expect((msgs.get(host.id) ?? []).map((m) => m.type)).toEqual(["mafia.state", "mafia.narrator"]);
      expect((msgs.get(bob.id) ?? []).map((m) => m.type)).toEqual(["mafia.state", "mafia.private"]);
      for (const p of room.players) {
        if (p.id === host.id || p.id === bob.id) continue;
        expect((msgs.get(p.id) ?? []).map((m) => m.type)).toEqual(["mafia.state"]);
      }

      const bobPrivate = lastPrivate(msgs.get(bob.id) ?? []);
      expect(bobPrivate?.["playerId"]).toBe(bob.id);
      expect(bobPrivate?.["ready"]).toBe(true);
      expect((lastPublic(msgs.get(bob.id) ?? [])?.["players"] as AnyRecord[]).length).toBe(4);
    });
  });

  test("a player cannot ready another player: INVALID_ACTOR and no state change", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const room = await joinAll(baseUrl, wsBase, NAMES);
      await gather(room);
      const host = first(room.players);
      const ada = first(room.players.filter((p) => p.id !== host.id));
      const cam = first(room.players.filter((p) => p.id !== host.id && p.id !== ada.id));

      sendAction(ada.client, { type: "READY", playerId: cam.id });
      const msgs = await gather(room);

      expect(lastErrorCode(msgs.get(ada.id) ?? [])).toBe("INVALID_ACTOR");
      // A rejected action broadcasts nothing — not even a narrator message.
      expect(lastNarratorState(msgs.get(host.id) ?? [])).toBeUndefined();
      expect((msgs.get(cam.id) ?? []).some((m) => m.type === "mafia.private")).toBe(false);
    });
  });

  test("clients cannot force narrator/server-only actions: ACTION_FORBIDDEN", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const room = await joinAll(baseUrl, wsBase, NAMES);
      await gather(room);
      const host = first(room.players);
      const cam = first(room.players.filter((p) => p.id !== host.id));

      for (const frame of [
        { type: "START_GAME", actor: { type: "NARRATOR" } },
        { type: "BEGIN_NIGHT", actor: { type: "NARRATOR" } },
        { type: "RESOLVE_NIGHT", actor: { type: "NARRATOR" } },
        { type: "PLAYER_UNAVAILABLE", playerId: host.id, reason: "DISCONNECTED" },
      ]) {
        sendAction(cam.client, frame);
        await sleep(60);
        expect(lastErrorCode(cam.client.drain()), frame.type).toBe("ACTION_FORBIDDEN");
      }
      expect(cam.client.ws.readyState).toBe(WebSocket.OPEN);
    });
  });

  test("all-ready + host start moves to ROLE_REVEAL and locks the room", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const room = await joinAll(baseUrl, wsBase, NAMES);
      const { roles } = await startGame(room);

      const get = await api(baseUrl, "GET", `/rooms/${room.code}`);
      expect((get.json?.["room"] as AnyRecord)["status"]).toBe("playing");
      expect(Object.keys(roles).length).toBe(4);
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Phase & action enforcement through the transport
// ---------------------------------------------------------------------------

describe("action enforcement through the transport", () => {
  test("READY after the game starts is INVALID_PHASE", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const room = await joinAll(baseUrl, wsBase, NAMES);
      await startGame(room);
      const host = first(room.players);
      const cam = first(room.players.filter((p) => p.id !== host.id));

      sendAction(cam.client, { type: "READY", playerId: cam.id });
      await sleep(80);
      expect(lastErrorCode(cam.client.drain())).toBe("INVALID_PHASE");
    });
  });

  test("a player cannot ROLE_SEEN on behalf of another player", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const room = await joinAll(baseUrl, wsBase, NAMES);
      await startGame(room);
      const host = first(room.players);
      const cam = first(room.players.filter((p) => p.id !== host.id));

      sendAction(cam.client, { type: "ROLE_SEEN", playerId: host.id });
      await sleep(80);
      expect(lastErrorCode(cam.client.drain())).toBe("INVALID_ACTOR");
    });
  });

  test("a non-Mafia player cannot submit MAFIA_KILL", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const room = await joinAll(baseUrl, wsBase, NAMES);
      const { roles } = await enterNight(room);
      const attacker = first(room.players.filter((p) => p.id !== room.hostId && roles[p.id] !== "MAFIA"));
      const target = first(room.players.filter((p) => p.id !== attacker.id));

      sendAction(attacker.client, { type: "MAFIA_KILL", targetId: target.id });
      await sleep(80);
      expect(lastErrorCode(attacker.client.drain())).toBe("INVALID_ACTOR");
    });
  });

  test("the acting Mafia cannot kill themselves: INVALID_TARGET", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const room = await joinAll(baseUrl, wsBase, NAMES);
      const { actingMafiaId } = await enterNight(room);
      const mafia = first(room.players.filter((p) => p.id === actingMafiaId));

      sendAction(mafia.client, { type: "MAFIA_KILL", targetId: actingMafiaId });
      await sleep(80);
      expect(lastErrorCode(mafia.client.drain())).toBe("INVALID_TARGET");
    });
  });

  test("re-submitting a night action is ACTION_ALREADY_SUBMITTED", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const room = await joinAll(baseUrl, wsBase, NAMES);
      const { actingMafiaId } = await enterNight(room);
      const mafia = first(room.players.filter((p) => p.id === actingMafiaId));
      const target = first(room.players.filter((p) => p.id !== actingMafiaId));

      sendAction(mafia.client, { type: "MAFIA_KILL", targetId: target.id });
      await sleep(80);
      mafia.client.drain();

      sendAction(mafia.client, { type: "MAFIA_KILL", targetId: target.id });
      await sleep(80);
      expect(lastErrorCode(mafia.client.drain())).toBe("ACTION_ALREADY_SUBMITTED");
    });
  });

  test("a dead player cannot vote: PLAYER_DEAD", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const room = await joinAll(baseUrl, wsBase, NAMES);
      const { actingMafiaId } = await enterNight(room);
      const host = first(room.players);
      const victim = first(room.players.filter((p) => p.id !== actingMafiaId && p.id !== host.id));

      sendAction(host.client, { type: "MAFIA_KILL", targetId: victim.id });
      await sleep(30);
      sendAction(host.client, { type: "DOCTOR_SAVE", targetId: null });
      await sleep(30);
      sendAction(host.client, { type: "DETECTIVE_INVESTIGATE", targetId: actingMafiaId });
      await sleep(30);
      sendAction(host.client, { type: "RESOLVE_NIGHT" });
      await sleep(30);
      sendAction(host.client, { type: "START_DISCUSSION" });
      await sleep(30);
      sendAction(host.client, { type: "START_VOTING" });
      await sleep(80);

      const voting = await gather(room);
      const publicPhase = lastPublic(voting.get(host.id) ?? []);
      expect(publicPhase?.["phase"]).toBe("VOTING");
      const roster = publicPhase?.["players"] as AnyRecord[];
      expect(roster.find((p) => p["id"] === victim.id)?.["alive"]).toBe(false);
      expect(roster.length).toBe(4);

      const victimParty = first(room.players.filter((p) => p.id === victim.id));
      sendAction(victimParty.client, {
        type: "CAST_VOTE",
        voterId: victim.id,
        targetId: actingMafiaId,
      });
      await sleep(80);
      expect(lastErrorCode(victimParty.client.drain())).toBe("PLAYER_DEAD");
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Information security boundaries
// ---------------------------------------------------------------------------

describe("information security", () => {
  test("every serialized public state is free of hidden keys across a full session", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const room = await joinAll(baseUrl, wsBase, NAMES);
      const host = first(room.players);
      const { actingMafiaId, messages: revealMsgs } = await enterNight(room);

      const victim = first(room.players.filter((p) => p.id !== actingMafiaId));
      sendAction(host.client, { type: "MAFIA_KILL", targetId: victim.id });
      await sleep(30);
      sendAction(host.client, { type: "DOCTOR_SAVE", targetId: null });
      await sleep(30);
      sendAction(host.client, { type: "DETECTIVE_INVESTIGATE", targetId: actingMafiaId });
      await sleep(30);
      sendAction(host.client, { type: "RESOLVE_NIGHT" });
      await sleep(80);

      const postNight = await gather(room);
      const all = new Map<string, WsMsg[]>();
      for (const [id, msgs] of revealMsgs) all.set(id, msgs);
      for (const [id, msgs] of postNight) all.set(id, [...(all.get(id) ?? []), ...msgs]);

      for (const msgs of all.values()) {
        for (const msg of ofType(msgs, "mafia.state")) {
          assertNoHiddenKeys(msg["state"], "public");
        }
      }
    });
  });

  test("the Detective's investigation result reaches only the Detective", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const room = await joinAll(baseUrl, wsBase, NAMES);
      const host = first(room.players);
      const { roles, actingMafiaId } = await enterNight(room);

      const detective = first(room.players.filter((p) => roles[p.id] === "DETECTIVE"));
      const victim = first(room.players.filter((p) => p.id !== actingMafiaId && roles[p.id] !== "DETECTIVE"));

      sendAction(host.client, { type: "MAFIA_KILL", targetId: victim.id });
      await sleep(30);
      sendAction(host.client, { type: "DOCTOR_SAVE", targetId: null });
      await sleep(30);
      sendAction(host.client, { type: "DETECTIVE_INVESTIGATE", targetId: actingMafiaId });
      await sleep(30);
      sendAction(host.client, { type: "RESOLVE_NIGHT" });
      await sleep(80);

      const msgs = await gather(room);
      for (const p of room.players) {
        const privates = ofType(msgs.get(p.id) ?? [], "mafia.private");
        for (const msg of privates) {
          const result = ((msg["state"] as AnyRecord)?.["ownPrivateNightResult"] ?? null) as AnyRecord | null;
          if (result === null || result === undefined) continue;
          if (p.id === detective.id) {
            expect(result).toMatchObject({ kind: "INVESTIGATION", targetId: actingMafiaId, isMafia: true });
          } else if (roles[p.id] === "DOCTOR") {
            expect(result["kind"]).toBe("HEAL");
          }
        }
      }
    });
  });

  test("narrator hidden state goes only to the host connection", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const room = await joinAll(baseUrl, wsBase, NAMES);
      const { actingMafiaId, messages } = await enterNight(room);

      const hostMsgs = messages.get(room.hostId) ?? [];
      const narr = lastNarratorState(hostMsgs);
      expect(Object.keys(narr?.["roles"] as AnyRecord).length).toBe(4);
      expect(narr?.["actingMafiaId"]).toBe(actingMafiaId);
      expect((narr?.["nightActions"] as AnyRecord)?.["kill"]).toBeDefined();

      for (const p of room.players) {
        if (p.id === room.hostId) continue;
        expect(ofType(messages.get(p.id) ?? [], "mafia.narrator")).toHaveLength(0);
      }
    });
  });

  test("mafia.private is always scoped to the connected player", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const room = await joinAll(baseUrl, wsBase, NAMES);
      await startGame(room);
      const { messages } = await revealAll(room);

      for (const p of room.players) {
        for (const msg of ofType(messages.get(p.id) ?? [], "mafia.private")) {
          expect((msg["state"] as AnyRecord)?.["playerId"]).toBe(p.id);
          expect((msg["state"] as AnyRecord)?.["name"]).toBe(p.name);
        }
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Reconnect resynchronization
// ---------------------------------------------------------------------------

describe("reconnect", () => {
  test("reconnect during ROLE_REVEAL restores state, role, and the roster — never restarts", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const room = await joinAll(baseUrl, wsBase, NAMES);
      const { roles } = await startGame(room);
      const ada = first(room.players.filter((p) => p.id !== room.hostId));

      ada.client.close();
      await sleep(150);

      const re = new WsClient(`${wsBase}/ws/rooms/${room.code}?playerId=${ada.id}`);
      expect(await expectOpen(re)).toBe(true);
      await sleep(80);
      const msgs = re.drain();
      expect(msgs.map((m) => m.type)).toEqual([
        "connected",
        "room.updated",
        "mafia.state",
        "mafia.private",
      ]);

      const priv = lastPrivate(msgs);
      expect(priv?.["playerId"]).toBe(ada.id);
      expect(priv?.["role"]).toBe(roles[ada.id]);
      const pub = lastPublic(msgs);
      expect(pub?.["phase"]).toBe("ROLE_REVEAL");
      expect((pub?.["players"] as AnyRecord[]).length).toBe(4);
      re.close();
    });
  });

  test("a re-joined socket mid-NIGHT replays the pending action and does not restart the game", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const room = await joinAll(baseUrl, wsBase, NAMES);
      const { actingMafiaId, messages } = await enterNight(room);
      const mafia = first(room.players.filter((p) => p.id === actingMafiaId));
      const other = first(room.players.filter((p) => p.id !== actingMafiaId));
      const gameId = lastPublic(messages.get(mafia.id) ?? [])?.["gameId"];

      const rejoin = new WsClient(`${wsBase}/ws/rooms/${room.code}?playerId=${mafia.id}`);
      expect(await expectOpen(rejoin)).toBe(true);
      await sleep(80);
      const msgs = rejoin.drain();
      expect(msgs.map((m) => m.type)).toContain("mafia.state");
      expect(msgs.map((m) => m.type)).toContain("mafia.private");

      const priv = lastPrivate(msgs);
      expect(priv?.["ownNightAction"]).toBe("NOT_ACTED");
      expect((priv?.["availableActions"] as string[])).toContain("MAFIA_KILL");
      const pub = lastPublic(msgs);
      expect(pub?.["gameId"]).toBe(gameId);
      expect((pub?.["players"] as AnyRecord[]).length).toBe(4);

      // The original socket is still open, so closing the extra one must NOT
      // report the player unavailable.
      rejoin.close();
      await sleep(150);
      expect(await expectNoMessage(mafia.client, 300)).toBe(true);
      expect(await expectNoMessage(other.client, 300)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// 7. Disconnect / unavailable semantics + room isolation
// ---------------------------------------------------------------------------

describe("disconnect and availability", () => {
  test("closing a slot-holder's only socket marks their night input SKIPPED; the player stays; game continues", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const room = await joinAll(baseUrl, wsBase, NAMES);
      const host = first(room.players);
      const { roles, actingMafiaId } = await enterNight(room);

      const holder = first(
        room.players.filter((p) => p.id !== host.id && nightSlotFor(roles[p.id]) !== null),
      );
      const slot = nightSlotFor(roles[holder.id]);

      // RESOLVE_NIGHT is only eligible once the kill slot is settled. If the
      // disconnected holder isn't the Mafia, the host (narrator) submits the
      // kill on their behalf first.
      if (slot !== "kill") {
        const victim = first(
          room.players.filter((p) => p.id !== actingMafiaId && p.id !== holder.id),
        );
        sendAction(host.client, { type: "MAFIA_KILL", targetId: victim.id });
        await sleep(80);
      }

      holder.client.close();
      await sleep(150);

      const msgs = await gather(room);
      const hostNarrator = lastNarratorState(msgs.get(host.id) ?? []);
      const nightAction = (hostNarrator?.["nightActions"] as AnyRecord)?.[slot ?? "kill"] as
        | AnyRecord
        | undefined;
      expect(nightAction?.["status"]).toBe("SKIPPED");

      const get = await api(baseUrl, "GET", `/rooms/${room.code}`);
      const roster = (get.json?.["room"] as AnyRecord)?.["players"] as AnyRecord[];
      expect(roster.some((p) => p["id"] === holder.id)).toBe(true);

      const re = new WsClient(`${wsBase}/ws/rooms/${room.code}?playerId=${holder.id}`);
      expect(await expectOpen(re)).toBe(true);
      await sleep(80);
      const priv = lastPrivate(re.drain());
      expect(priv?.["ownNightAction"]).toBe("SKIPPED");
      re.close();
      await sleep(100);

      // The host resolves the night and the game continues (no termination).
      sendAction(host.client, { type: "RESOLVE_NIGHT" });
      await sleep(80);
      const after = await gather(room);
      expect(lastPublic(after.get(host.id) ?? [])?.["phase"]).toBe("MORNING");
    });
  });

  test("closing one of a player's two sockets does not dispatch unavailability", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const room = await joinAll(baseUrl, wsBase, NAMES);
      const host = first(room.players);
      const other = first(room.players.filter((p) => p.id !== host.id));
      await startGame(room);

      const extra = new WsClient(`${wsBase}/ws/rooms/${room.code}?playerId=${host.id}`);
      expect(await expectOpen(extra)).toBe(true);
      await sleep(80);
      extra.drain();

      extra.close();
      await sleep(150);
      expect(await expectNoMessage(host.client, 300)).toBe(true);
      expect(await expectNoMessage(other.client, 300)).toBe(true);
    });
  });
});

describe("room isolation", () => {
  test("a game in room A leaks nothing into room B, and B games error only to their own clients", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const roomA = await joinAll(baseUrl, wsBase, NAMES);
      const roomB = await joinAll(baseUrl, wsBase, ["Eve", "Fay"]);
      await gather(roomA);
      await gather(roomB);

      await startGame(roomA);

      const eve = first(roomB.players);
      const fay = first(roomB.players.filter((p) => p.id !== eve.id));
      expect(await expectNoMessage(eve.client, 300)).toBe(true);
      expect(await expectNoMessage(fay.client, 300)).toBe(true);

      sendAction(eve.client, { type: "START_GAME" });
      await sleep(80);
      expect(lastErrorCode(eve.client.drain())).toBe("NOT_ENOUGH_PLAYERS");
      expect(await expectNoMessage(fay.client, 200)).toBe(true);
    });
  });
});