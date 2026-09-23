/**
 * Lobby → start regression tests (end to end over the real transport).
 *
 * Regression under test: a fresh room MUST present the Mafia lobby view the
 * moment a player connects, before any action is ever sent. Previously the
 * session was only created lazily on the first `mafia.action`, so the lobby
 * received no `mafia.state`, the client's phase stayed null, and the app was
 * permanently stuck on "Connecting to the game…" (the lobby UI with the Ready
 * and Start buttons was unreachable, making it impossible to send the first
 * action). The start gate is enforced by the engine (4-20 players, all ready,
 * host/narrator only), never by session existence.
 */
import { describe, expect, test } from "bun:test";
import {
  WsClient,
  api,
  expectOpen,
  sleep,
  withServer,
  type WsMsg,
} from "../../test-server.ts";

type AnyRecord = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Helpers (mirror the other Mafia WS suites)
// ---------------------------------------------------------------------------

type Party = { id: string; name: string; client: WsClient };
type GameRoom = { code: string; hostId: string; players: Party[]; initial: Map<string, WsMsg[]> };

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

async function connectPlayer(baseUrl: string, wsBase: string, code: string, name: string): Promise<Party> {
  const id = await joinPlayer(baseUrl, code, name);
  const client = new WsClient(`${wsBase}/ws/rooms/${code}?playerId=${id}`);
  expect(await expectOpen(client)).toBe(true);
  return { id, name, client };
}

async function joinAll(baseUrl: string, wsBase: string, names: string[]): Promise<GameRoom> {
  const code = await createRoom(baseUrl);
  const players: Party[] = [];
  for (const name of names) {
    players.push(await connectPlayer(baseUrl, wsBase, code, name));
  }
  const hostId = first(players).id;
  await sleep(80);
  // Each player's connect handshake carried the lobby view; keep it so tests
  // can assert the initial unready/unstarted state.
  const initial = new Map(players.map((p) => [p.id, p.client.drain()]));
  return { code, hostId, players, initial };
}

function sendAction(client: WsClient, action: AnyRecord): void {
  client.send({ type: "mafia.action", action });
}

async function gather(room: Pick<GameRoom, "players">): Promise<Map<string, WsMsg[]>> {
  await sleep(80);
  return new Map(room.players.map((p) => [p.id, p.client.drain()]));
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

async function readyUp(room: GameRoom): Promise<Map<string, WsMsg[]>> {
  for (const p of room.players) {
    sendAction(p.client, { type: "READY", playerId: p.id });
    await sleep(20);
  }
  return gather(room);
}

// ---------------------------------------------------------------------------
// 1. The core regression: the lobby view exists before any action.
// ---------------------------------------------------------------------------

describe("lobby view is available on connect (regression)", () => {
  test("a solo host's fresh handshake carries the full lobby mafia view", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const code = await createRoom(baseUrl);
      const ada = await connectPlayer(baseUrl, wsBase, code, "Ada");
      await sleep(80);

      const msgs = ada.client.drain();
      expect(msgs.map((m) => m.type)).toEqual([
        "connected",
        "room.updated",
        "mafia.state",
        "mafia.private",
        "mafia.narrator",
      ]);

      const pub = lastPublic(msgs);
      expect(pub?.["phase"]).toBe("LOBBY");
      const pubPlayers = pub?.["players"] as AnyRecord[] | undefined;
      expect(pubPlayers).toHaveLength(1);
      expect(pubPlayers?.[0]?.["name"]).toBe("Ada");

      const priv = lastPrivate(msgs);
      expect(priv?.["phase"]).toBe("LOBBY");
      expect(priv?.["role"]).toBeNull();
      expect(priv?.["ready"]).toBe(false);

      ada.client.close();
    });
  });

  test("players joining later each get the lobby view reflecting the current roster", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const code = await createRoom(baseUrl);
      const ada = await connectPlayer(baseUrl, wsBase, code, "Ada");
      await sleep(80);
      ada.client.drain();

      const bob = await connectPlayer(baseUrl, wsBase, code, "Bob");
      await sleep(80);

      // Bob alone never acted; his socket still opens straight into the lobby.
      const bobMsgs = bob.client.drain();
      expect(bobMsgs.some((m) => m.type === "mafia.state")).toBe(true);
      expect((lastPublic(bobMsgs)?.["players"] as AnyRecord[])?.map((p) => p["name"])).toEqual([
        "Ada",
        "Bob",
      ]);

      // The host keeps her open socket, and every broadcast/room update stays
      // isolated to this room; nothing leaks to the other room's clients.
      expect(bobMsgs.some((m) => m.type === "mafia.narrator")).toBe(false);

      ada.client.close();
      bob.client.close();
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Ready/unready and the host-only start authority in the lobby.
// ---------------------------------------------------------------------------

describe("lobby lifecycle and host start authority", () => {
  test("READY/UNREADY broadcast publicly; host START_GAME gates on readiness", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const room = await joinAll(baseUrl, wsBase, ["Ada", "Bob", "Cam", "Dea", "Eve", "Fay"]);
      const host = first(room.players);
      const nonHost = first(room.players.filter((p) => p.id !== host.id));
      const dea = first(room.players.filter((p) => p.name === "Dea"));
      expect(host.id).toBe(room.hostId);

      // Everyone starts unready and unstarted.
      for (const p of room.players) {
        const priv = lastPrivate(room.initial.get(p.id) ?? []);
        expect(priv?.["phase"]).toBe("LOBBY");
        expect(priv?.["ready"]).toBe(false);
      }

      // Non-host cannot start the game — their own socket only.
      sendAction(nonHost.client, { type: "START_GAME" });
      await sleep(80);
      expect(lastErrorCode(nonHost.client.drain())).toBe("ACTION_FORBIDDEN");
      const quietAfterForbidden = await gather(room);
      for (const p of room.players) {
        expect(lastErrorCode(quietAfterForbidden.get(p.id) ?? [])).toBeUndefined();
      }

      // Host cannot start before everyone is ready.
      sendAction(host.client, { type: "START_GAME" });
      await sleep(80);
      expect(lastErrorCode(host.client.drain())).toBe("NOT_ALL_READY");

      // READY is visible to the whole room; UNREADY flips it back.
      sendAction(dea.client, { type: "READY", playerId: dea.id });
      await sleep(80);
      const readyMsgs = await gather(room);
      const readyWho = (lastPublic(readyMsgs.get(host.id) ?? []) as AnyRecord)?.["players"] as AnyRecord[];
      expect(readyWho?.find((p) => p.id === dea.id)?.["ready"]).toBe(true);
      const deaPriv = lastPrivate(readyMsgs.get(dea.id) ?? []);
      expect(deaPriv?.["phase"]).toBe("LOBBY");
      expect(deaPriv?.["ready"]).toBe(true);

      sendAction(dea.client, { type: "UNREADY", playerId: dea.id });
      await sleep(80);
      const unreadyMsgs = await gather(room);
      const unreadyWho = (lastPublic(unreadyMsgs.get(host.id) ?? []) as AnyRecord)?.["players"] as AnyRecord[];
      expect(unreadyWho?.find((p) => p.id === dea.id)?.["ready"]).toBe(false);

      const readyMsgsAll = await readyUp(room);
      const readyNames = (lastPublic(readyMsgsAll.get(host.id) ?? []) as AnyRecord)?.["players"] as AnyRecord[];
      expect(readyNames?.every((p) => p["ready"] === true)).toBe(true);
    });
  });

  test("a sub-minimum lobby prevents START_GAME with NOT_ENOUGH_PLAYERS (engine gate)", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const code = await createRoom(baseUrl);
      const players: Party[] = [];
      for (const name of ["Ada", "Bob", "Cam"]) {
        players.push(await connectPlayer(baseUrl, wsBase, code, name));
      }
      await sleep(80);
      for (const p of players) p.client.drain();

      // Even fully readied, the 3-player room cannot start.
      for (const p of players) {
        sendAction(p.client, { type: "READY", playerId: p.id });
        await sleep(20);
      }
      await sleep(80);
      for (const p of players) p.client.drain();

      const host = first(players);
      sendAction(host.client, { type: "START_GAME" });
      await sleep(80);
      expect(lastErrorCode(host.client.drain())).toBe("NOT_ENOUGH_PLAYERS");

      host.client.close();
    });
  });
});

// ---------------------------------------------------------------------------
// 3. The happy path: 6 players ready up, host starts, phase → ROLE_REVEAL.
// ---------------------------------------------------------------------------

describe("host starts a 6-player lobby", () => {
  test("start transitions LOBBY → ROLE_REVEAL, locks the room, and hands out roles", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const room = await joinAll(baseUrl, wsBase, ["Ada", "Bob", "Cam", "Dea", "Eve", "Fay"]);
      const host = first(room.players);

      const start = await readyUp(room);
      const preStartHost = first(room.players);
      const preStartPub = lastPublic(start.get(preStartHost.id) ?? []);
      expect(preStartPub?.["phase"]).toBe("LOBBY");

      sendAction(host.client, { type: "START_GAME" });
      await sleep(80);
      const after = await gather(room);

      // Every player receives the same public state: ROLE_REVEAL, 6 players.
      const roles = (lastNarratorState(after.get(host.id) ?? [])?.["roles"] as AnyRecord) ?? {};
      expect(Object.keys(roles).sort()).toEqual(room.players.map((p) => p.id).sort());
      for (const p of room.players) {
        const pub = lastPublic(after.get(p.id) ?? []);
        expect(pub?.["phase"]).toBe("ROLE_REVEAL");
        expect((pub?.["players"] as AnyRecord[])).toHaveLength(6);
        const priv = lastPrivate(after.get(p.id) ?? []);
        expect(priv?.["phase"]).toBe("ROLE_REVEAL");
        expect(priv?.["role"]).toBe(roles[p.id]);
        expect(priv?.["roleSeen"]).toBe(false);
      }

      // The room is now locked against new joiners.
      const late = await api(baseUrl, "POST", `/rooms/${room.code}/players`, { name: "Gus" });
      expect(late.status).toBe(409);
      expect(late.json?.["error"]).toContain("started");

      for (const p of room.players) p.client.close();
    });
  });
});