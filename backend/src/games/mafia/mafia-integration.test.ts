/**
 * Phase 11C — multiplayer integration & adversarial tests.
 *
 * Plays PLAYROOM Mafia as a real multiplayer server: many WebSocket clients,
 * one live Bun/Hono server, complete games driven to victory, engineered
 * ties/eliminations, hostile frames, disconnects/reconnects, multi-room
 * parallelism, host-wellplay independence, and a long multi-night game.
 *
 * Determinism: roles are drawn server-side with Math.random, so tests never
 * guess who is Mafia/Doctor/Detective. They read truth from the narrator
 * channel (host = players[0], assigned by RoomManager) and drive every action
 * from that truth. Kills/saves/investigations target distinct slots, so
 * whatever order the transport delivers them in the resolved night is a pure
 * function of the submitted set — final state is deterministic.
 */
import { describe, expect, test } from "bun:test";
import {
  WsClient,
  api,
  expectNoMessage,
  expectOpen,
  expectRejected,
  sleep,
  withServer,
  type WsMsg,
} from "../../test-server.ts";

type AnyRecord = Record<string, unknown>;
type Party = { id: string; name: string; client: WsClient };
type GameRoom = { code: string; hostId: string; players: Party[]; wsBase: string };

const NAMES = ["Ada", "Bob", "Cam", "Dea", "Eve", "Fin", "Gia", "Hai", "Ivy", "Jan"];

function namesUpTo(n: number): string[] {
  return NAMES.slice(0, n);
}

function first<T>(items: T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error("expected at least one item");
  return item;
}

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

function wsUrl(wsBase: string, code: string, playerId: string): string {
  return `${wsBase}/ws/rooms/${code}?playerId=${playerId}`;
}

async function connect(wsBase: string, code: string, playerId: string): Promise<WsClient> {
  const client = new WsClient(wsUrl(wsBase, code, playerId));
  expect(await expectOpen(client)).toBe(true);
  return client;
}

async function joinAll(baseUrl: string, wsBase: string, names: string[]): Promise<GameRoom> {
  const code = await createRoom(baseUrl);
  const players: Party[] = [];
  for (const name of names) {
    const id = await joinPlayer(baseUrl, code, name);
    players.push({ id, name, client: await connect(wsBase, code, id) });
  }
  // Each HTTP join broadcasts room.updated to the earlier sockets; drain so
  // every test starts from a quiet room.
  await sleep(60);
  for (const p of players) p.client.drain();
  return { code, hostId: first(players).id, players, wsBase };
}

function hostOf(room: GameRoom): Party {
  return first(room.players);
}

function byId(room: GameRoom, playerId: string): Party {
  const p = room.players.find((x) => x.id === playerId);
  if (p === undefined) throw new Error(`no player ${playerId} in room`);
  return p;
}

function sendAction(client: WsClient, action: AnyRecord): void {
  client.send({ type: "mafia.action", action });
}

async function settle(ms = 50): Promise<void> {
  await sleep(ms);
}

/** Drain every party after a settle — the quiet-room primitive. */
async function sip(room: GameRoom, ms = 60): Promise<Map<string, WsMsg[]>> {
  await sleep(ms);
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

function lastNarrator(msgs: WsMsg[]): AnyRecord | undefined {
  return lastByType(msgs, "mafia.narrator")?.["state"] as AnyRecord | undefined;
}

function lastErrorCode(msgs: WsMsg[]): string | undefined {
  return lastByType(msgs, "mafia.error")?.["code"] as string | undefined;
}

function phaseOf(msgs: WsMsg[]): string | undefined {
  return lastPublic(msgs)?.["phase"] as string | undefined;
}

/** Living roster ids derived from a public snapshot. */
function livingFrom(pub: AnyRecord | undefined): string[] {
  const players = pub?.["players"];
  if (!Array.isArray(players)) throw new Error("no players array in public state");
  return players
    .filter((pl) => (pl as AnyRecord)?.["alive"] === true)
    .map((pl) => (pl as AnyRecord)?.["id"] as string);
}

function removedAfter(msgs: WsMsg[]): string[] {
  const pub = lastPublic(msgs);
  const removed = new Set<string>();
  if (pub === undefined) return [];
  const deaths = pub?.["morningDeaths"];
  if (Array.isArray(deaths)) for (const id of deaths) removed.add(id as string);
  const eliminated = (pub?.["elimination"] as AnyRecord)?.["eliminatedPlayerId"];
  if (typeof eliminated === "string") removed.add(eliminated);
  return [...removed];
}

// ---------------------------------------------------------------------------
// Lobby / start / role reveal
// ---------------------------------------------------------------------------

async function readyUp(room: GameRoom): Promise<void> {
  for (const p of room.players) {
    sendAction(p.client, { type: "READY", playerId: p.id });
    await sleep(15);
  }
  await sip(room);
}

/** Start the game (narrator), have everyone confirm their role, → NIGHT. */
async function startToNight(room: GameRoom): Promise<{
  roles: AnyRecord;
  actingMafiaId: string;
  night: Map<string, WsMsg[]>;
}> {
  await readyUp(room);
  sendAction(hostOf(room).client, { type: "START_GAME" });
  const started = await sip(room, 80);
  const roles = (lastNarrator(started.get(room.hostId) ?? [])?.["roles"] as AnyRecord) ?? {};
  expect(phaseOf(started.get(room.hostId) ?? [])).toBe("ROLE_REVEAL");
  for (const p of room.players) {
    sendAction(p.client, { type: "ROLE_SEEN", playerId: p.id });
    await sleep(15);
  }
  const revealed = await sip(room, 80);
  const actingMafiaId = lastNarrator(revealed.get(room.hostId) ?? [])?.["actingMafiaId"] as
    | string
    | undefined;
  if (actingMafiaId === undefined) throw new Error("expected actingMafiaId in the NIGHT narrator state");
  return { roles, actingMafiaId, night: revealed };
}

// ---------------------------------------------------------------------------
// Night
// ---------------------------------------------------------------------------

type NightPlan = {
  kill: string | null;
  save: string | null;
  investigate: string | null;
};

/**
 * The three night contributions are submitted back-to-back (near-simultaneous).
 * They target independent slots, so resolution is a pure function of the set.
 */
async function runNight(
  room: GameRoom,
  roles: AnyRecord,
  actingMafiaId: string,
  living: string[],
  plan: NightPlan,
): Promise<Map<string, WsMsg[]>> {
  const mafia = byId(room, actingMafiaId);
  if (plan.kill !== null) sendAction(mafia.client, { type: "MAFIA_KILL", targetId: plan.kill });

  const doctor = room.players.find((p) => roles[p.id] === "DOCTOR" && living.includes(p.id));
  if (doctor !== undefined) sendAction(doctor.client, { type: "DOCTOR_SAVE", targetId: plan.save });

  const detective = room.players.find((p) => roles[p.id] === "DETECTIVE" && living.includes(p.id));
  if (detective !== undefined && plan.investigate !== null) {
    sendAction(detective.client, { type: "DETECTIVE_INVESTIGATE", targetId: plan.investigate });
  }

  await settle(60);
  return resolveHost(room);
}

/** Narrator resolves the night; falls back to force-resolution if the kill was missed. */
async function resolveHost(room: GameRoom): Promise<Map<string, WsMsg[]>> {
  const host = hostOf(room).client;
  sendAction(host, { type: "RESOLVE_NIGHT" });
  let msgs = await sip(room, 80);
  const err = lastErrorCode(msgs.get(room.hostId) ?? []);
  if (err === "MISSING_REQUIRED_ACTION") {
    sendAction(host, { type: "ADVANCE_PHASE" });
    msgs = await sip(room, 80);
  }
  return msgs;
}

// ---------------------------------------------------------------------------
// Voting
// ---------------------------------------------------------------------------

const otherLiving = (living: string[], id: string): string => {
  const other = living.find((x) => x !== id);
  if (other === undefined) throw new Error("expected at least one other living player");
  return other;
};

/**
 * Every living player votes exactly once (auto-resolves when all have voted).
 * The engine requires a player to name themselves as voterId alongside the
 * vote (a player may only cast their own vote); this is the authenticated
 * client contract the protocol tests bank on.
 */
async function runVoting(
  room: GameRoom,
  living: string[],
  pick: (voterId: string) => string,
): Promise<Map<string, WsMsg[]>> {
  for (const id of living) {
    sendAction(byId(room, id).client, { type: "CAST_VOTE", voterId: id, targetId: pick(id) });
    await sleep(10);
  }
  return sip(room, 80);
}

async function startVotingPhase(room: GameRoom): Promise<void> {
  const host = hostOf(room).client;
  sendAction(host, { type: "START_DISCUSSION" });
  await sip(room, 60);
  sendAction(host, { type: "START_VOTING" });
  await sip(room, 60);
}

// ---------------------------------------------------------------------------
// Reconnect
// ---------------------------------------------------------------------------

/**
 * Reconnect with a deterministic handshake barrier. `syncType` is the LAST
 * message the server sends during the open handshake for this socket, so after
 * awaitSync resolves, drain() is guaranteed to see the whole sync. "room.updated"
 * is last when no mafia game exists yet; mid-game it is "mafia.private" for
 * players and "mafia.narrator" for the host identity.
 */
async function reconnect(
  room: GameRoom,
  p: Party,
  syncType: "room.updated" | "mafia.private" | "mafia.narrator" = "room.updated",
): Promise<Party> {
  const client = await connect(room.wsBase, room.code, p.id);
  await client.awaitSync(syncType);
  return { id: p.id, name: p.name, client };
}

// ---------------------------------------------------------------------------
// Information-boundary auditing (serialized, not types)
// ---------------------------------------------------------------------------

/** Keys that must never appear inside a public (mafia.state) payload. */
const PUBLIC_FORBIDDEN = [
  "roles",
  "votes",
  "nightActions",
  "actingMafiaId",
  "roleSeen",
  "readyState",
  "lastResolvedNight",
  "lastElimination",
  "timeline",
  "ownVoteTargetId",
  "ownNightAction",
  "ownPrivateNightResult",
  "availableActions",
];

/** Keys that must never appear inside a player's own private payload. */
const PRIVATE_FORBIDDEN = [
  "roles",
  "votes",
  "nightActions",
  "actingMafiaId",
  "readyState",
  "lastResolvedNight",
  "lastElimination",
  "timeline",
];

function assertNoForbiddenKeys(value: unknown, where: string, forbidden: readonly string[]): void {
  if (Array.isArray(value)) {
    value.forEach((child, i) => assertNoForbiddenKeys(child, `${where}[${i}]`, forbidden));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    expect(forbidden.includes(key), `forbidden key ${where}.${key} in serialized payload`).toBe(false);
    assertNoForbiddenKeys(child, `${where}.${key}`, forbidden);
  }
}

function auditLedger(room: GameRoom, ledger: Map<string, WsMsg[]>, roles: AnyRecord): void {
  for (const p of room.players) {
    const msgs = ledger.get(p.id) ?? [];
    for (const msg of msgs) {
      if (msg.type === "mafia.state") {
        const state = msg["state"] as AnyRecord;
        assertNoForbiddenKeys(state, `public/${p.name}`, PUBLIC_FORBIDDEN);
        const players = state?.["players"];
        if (Array.isArray(players)) {
          for (const pl of players) expect((pl as AnyRecord)["role"]).toBeUndefined();
        }
      } else if (msg.type === "mafia.private") {
        assertNoForbiddenKeys(msg["state"], `private/${p.name}`, PRIVATE_FORBIDDEN);
        const state = msg["state"] as AnyRecord;
        expect(state["playerId"]).toBe(p.id);
        expect(state["name"]).toBe(p.name);
        const role = state["role"];
        if (typeof role === "string") expect(role).toBe(roles[p.id] as string);
      } else if (msg.type === "mafia.narrator") {
        expect(p.id, `narrator must only reach the host, got ${p.name}`).toBe(room.hostId);
      }
      // mafia.error carries nothing beyond a code/message addressed only to the sender.
    }
  }
  expect(ledger.get(room.hostId)?.some((m) => m.type === "mafia.narrator")).toBe(true);
}

/** The 4-player "smart town" finish the protocol tests already bank on: night-1 kill, then lynch the Mafia. */
async function driveQuickTownWin(room: GameRoom): Promise<{
  roles: AnyRecord;
  actingMafiaId: string;
  over: Map<string, WsMsg[]>;
}> {
  const { roles, actingMafiaId } = await startToNight(room);
  let living = room.players.map((p) => p.id);
  const killTarget = first(
    room.players.filter((p) => p.id !== actingMafiaId && roles[p.id] !== "DOCTOR"),
  );

  const night = await runNight(room, roles, actingMafiaId, living, {
    kill: killTarget.id,
    save: null,
    investigate: actingMafiaId,
  });
  living = living.filter((id) => !removedAfter(night.get(room.hostId) ?? []).includes(id));

  await startVotingPhase(room);
  const over = await runVoting(room, living, (voterId) =>
    roles[voterId] === "MAFIA" ? otherLiving(living, voterId) : actingMafiaId,
  );
  expect(phaseOf(over.get(room.hostId) ?? [])).toBe("GAME_OVER");
  expect(lastPublic(over.get(room.hostId) ?? [])?.["winner"]).toBe("TOWN");
  return { roles, actingMafiaId, over };
}

// ---------------------------------------------------------------------------
// 1. Complete normal game
// ---------------------------------------------------------------------------

describe("1. complete normal game", () => {
  test("full 4-player lifecycle reaches GAME_OVER with consistent state", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const room = await joinAll(baseUrl, wsBase, namesUpTo(4));
      const phasesSeen: string[] = [];

      const { roles, actingMafiaId } = await startToNight(room);
      phasesSeen.push("ROLE_REVEAL", "NIGHT");

      let living = room.players.map((p) => p.id);
      const victim = first(room.players.filter((p) => p.id !== actingMafiaId && roles[p.id] !== "DOCTOR"));

      const night = await runNight(room, roles, actingMafiaId, living, {
        kill: victim.id,
        save: null,
        investigate: actingMafiaId,
      });
      phasesSeen.push(phaseOf(night.get(room.hostId) ?? []) ?? "");
      expect(phaseOf(night.get(room.hostId) ?? [])).toBe("MORNING");
      expect(
        (lastPublic(night.get(room.hostId) ?? [])?.["morningDeaths"] as string[] | undefined)?.includes(
          victim.id,
        ),
      ).toBe(true);
      living = living.filter((id) => !removedAfter(night.get(room.hostId) ?? []).includes(id));

      await startVotingPhase(room);
      phasesSeen.push("DISCUSSION", "VOTING");
      const over = await runVoting(room, living, (voterId) =>
        roles[voterId] === "MAFIA" ? otherLiving(living, voterId) : actingMafiaId,
      );
      phasesSeen.push(phaseOf(over.get(room.hostId) ?? []) ?? "");

      expect(phaseOf(over.get(room.hostId) ?? [])).toBe("GAME_OVER");
      expect(phasesSeen).toContain("MORNING");
      expect(phasesSeen).toContain("VOTING");
      expect(phasesSeen[phasesSeen.length - 1]).toBe("GAME_OVER");

      // Every player converged on the same public truth, roles revealed.
      const winner = lastPublic(over.get(room.hostId) ?? [])?.["winner"];
      expect(winner).toBe("TOWN");
      for (const p of room.players) {
        const pub = lastPublic(over.get(p.id) ?? []);
        expect(pub?.["winner"]).toBe("TOWN");
        expect(pub?.["revealedRoles"] as AnyRecord).toEqual(roles);
        const priv = lastPrivate(over.get(p.id) ?? []);
        expect(priv?.["role"]).toBe(roles[p.id]);
        expect(priv?.["alive"]).toBe(
          p.id === actingMafiaId || p.id === victim.id ? false : true,
        );
      }

      // The narrator saw the same truth. lastElimination is null at GAME_OVER
      // (and a lynch that ends the game never broadcasts a VOTE_RESULT
      // snapshot), so read the final elimination from the timeline.
      const finalNarr = lastNarrator(over.get(room.hostId) ?? []);
      const eliminations = (finalNarr?.["timeline"] as AnyRecord[]).filter(
        (e) => e["kind"] === "PLAYER_ELIMINATED",
      );
      expect(eliminations.length).toBeGreaterThan(0);
      expect(eliminations[eliminations.length - 1]?.["playerId"]).toBe(actingMafiaId);

      // Room lock held through play (released only by PLAY_AGAIN/remove).
      const get = await api(baseUrl, "GET", `/rooms/${room.code}`);
      expect((get.json?.["room"] as AnyRecord)["status"]).toBe("playing");
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Information security — 4 / 7 / 10+ players
// ---------------------------------------------------------------------------

describe("2. information security boundaries across player counts", () => {
  for (const count of [4, 7, 10]) {
    test(`every serialized payload is public-only or own-private at ${count} players`, async () => {
      await withServer(async ({ baseUrl, wsBase }) => {
        const room = await joinAll(baseUrl, wsBase, namesUpTo(count));
        const ledger = new Map<string, WsMsg[]>();
        for (const p of room.players) ledger.set(p.id, []);

        const record = async (ms = 50): Promise<void> => {
          const msgs = await sip(room, ms);
          for (const p of room.players) (ledger.get(p.id) ?? []).push(...(msgs.get(p.id) ?? []));
        };

        // Lobby — capture ready/broadcast traffic.
        for (const p of room.players) {
          sendAction(p.client, { type: "READY", playerId: p.id });
          await sleep(12);
        }
        await record();

        // Start → role reveal → night.
        sendAction(hostOf(room).client, { type: "START_GAME" });
        await record(80);
        const roles = (lastNarrator(ledger.get(room.hostId) ?? [])?.["roles"] as AnyRecord) ?? {};
        for (const p of room.players) {
          sendAction(p.client, { type: "ROLE_SEEN", playerId: p.id });
          await sleep(12);
        }
        await record(80);
        const actingMafiaId = (lastNarrator(ledger.get(room.hostId) ?? [])?.["actingMafiaId"] as
          | string
          | undefined) ?? "";

        // One night.
        let living = room.players.map((p) => p.id);
        const killTarget = first(room.players.filter((p) => p.id !== actingMafiaId));
        const mafia = byId(room, actingMafiaId);
        sendAction(mafia.client, { type: "MAFIA_KILL", targetId: killTarget.id });
        const doctor = room.players.find((p) => roles[p.id] === "DOCTOR");
        if (doctor !== undefined) sendAction(doctor.client, { type: "DOCTOR_SAVE", targetId: null });
        const detective = room.players.find((p) => roles[p.id] === "DETECTIVE");
        if (detective !== undefined) {
          sendAction(detective.client, {
            type: "DETECTIVE_INVESTIGATE",
            targetId: otherLiving(living.map((id) => id), detective.id),
          });
        }
        await settle(60);
        const resolvedNight = await resolveHost(room);
        for (const p of room.players) {
          (ledger.get(p.id) ?? []).push(...(resolvedNight.get(p.id) ?? []));
        }
        await record(80);

        // Discussion + voting (everyone votes the first other living player).
        await startVotingPhase(room);
        const votingStart = await sip(room, 60);
        for (const p of room.players) {
          (ledger.get(p.id) ?? []).push(...(votingStart.get(p.id) ?? []));
        }
        const afterNight = lastPublic(ledger.get(room.hostId) ?? []);
        living = livingFrom(afterNight ?? {});
        const round = await runVoting(room, living, (voterId) => otherLiving(living, voterId));
        for (const p of room.players) {
          (ledger.get(p.id) ?? []).push(...(round.get(p.id) ?? []));
        }
        await record(80);

        auditLedger(room, ledger, roles);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// 3. Malicious client simulation
// ---------------------------------------------------------------------------

describe("3. malicious client simulation", () => {
  test("authority attacks fail and never corrupt game state", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const room = await joinAll(baseUrl, wsBase, namesUpTo(4));
      // Role-agnostic attackers: players[1] and players[2].
      const attacker = room.players[1];
      if (attacker === undefined) throw new Error("missing attacker");
      const victim = room.players[2];
      if (victim === undefined) throw new Error("missing victim");

      // Lobby impersonation: attacker toggles readiness FOR someone else.
      sendAction(attacker.client, { type: "READY", playerId: victim.id });
      await settle(50);
      expect(lastErrorCode(attacker.client.drain())).toBe("INVALID_ACTOR");
      const quiet0 = await sip(room, 40);
      expect(quiet0.get(victim.id) ?? []).toEqual([]);
      expect(quiet0.get(room.hostId) ?? []).toEqual([]);

      // Server-only / narrator actions from a player connection.
      for (const action of [
        { type: "START_GAME" },
        { type: "RESOLVE_NIGHT" },
        { type: "BEGIN_NIGHT" },
        { type: "END_VOTING" },
        { type: "ADVANCE_PHASE" },
        { type: "PLAY_AGAIN" },
      ]) {
        sendAction(attacker.client, action);
        await settle(50);
        expect(lastErrorCode(attacker.client.drain()), `${action.type} from a player`).toBe(
          "ACTION_FORBIDDEN",
        );
      }
      // Host cannot send the server-only action either.
      sendAction(hostOf(room).client, { type: "PLAYER_UNAVAILABLE", playerId: attacker.id });
      await settle(50);
      expect(lastErrorCode(hostOf(room).client.drain())).toBe("ACTION_FORBIDDEN");

      const quiet1 = await sip(room, 40);
      for (const p of room.players) expect(quiet1.get(p.id) ?? []).toEqual([]);

      // Start the game properly and drive to the first night.
      const { roles, actingMafiaId } = await startToNight(room);
      const mafia = byId(room, actingMafiaId);

      // A non-Mafia player (never the host, whose socket is a narrator authority)
      // cannot submit the Mafia kill / doctor save.
      const nonMafia = first(
        room.players.filter(
          (p) => p.id !== actingMafiaId && p.id !== room.hostId && roles[p.id] !== "DOCTOR",
        ),
      );
      sendAction(nonMafia.client, { type: "MAFIA_KILL", targetId: attacker.id });
      await settle(50);
      expect(lastErrorCode(nonMafia.client.drain())).toBe("INVALID_ACTOR");
      sendAction(nonMafia.client, { type: "DOCTOR_SAVE", targetId: null });
      await settle(50);
      expect(lastErrorCode(nonMafia.client.drain())).toBe("INVALID_ACTOR");
      const quiet2 = await sip(room, 40);
      expect(quiet2.get(victim.id) ?? []).toEqual([]);

      // The acting Mafia cannot kill themselves.
      sendAction(mafia.client, { type: "MAFIA_KILL", targetId: actingMafiaId });
      await settle(50);
      expect(lastErrorCode(mafia.client.drain())).toBe("INVALID_TARGET");

      // Duplicate night action. Confirm the first save landed (PASSED) before
      // asserting the duplicate is rejected — otherwise a slow broadcast for
      // the first save could race the final capture.
      const doctor = first(room.players.filter((p) => roles[p.id] === "DOCTOR"));
      sendAction(doctor.client, { type: "DOCTOR_SAVE", targetId: null });
      await settle(50);
      const saveFirst = await sip(room, 40);
      const saveNarr = lastNarrator(saveFirst.get(room.hostId) ?? []);
      const saveSlot = (saveNarr?.["nightActions"] as AnyRecord | undefined)?.["save"] as
        | AnyRecord
        | undefined;
      expect(saveSlot?.["status"]).toBe("PASSED");
      sendAction(doctor.client, { type: "DOCTOR_SAVE", targetId: attacker.id });
      await settle(50);
      expect(lastErrorCode(doctor.client.drain())).toBe("ACTION_ALREADY_SUBMITTED");

      // Game still progresses cleanly: mafia kills a villager, detective investigates, resolve.
      let living = room.players.map((p) => p.id);
      // Kill target is never the attacker, so the attacker stays alive for the
      // adversarial-voting section below regardless of the server's role draw.
      const killTarget = first(
        room.players.filter(
          (p) => p.id !== actingMafiaId && p.id !== attacker.id && roles[p.id] !== "DOCTOR",
        ),
      );
      const detective = room.players.find((p) => roles[p.id] === "DETECTIVE");
      if (detective !== undefined) {
        sendAction(detective.client, {
          type: "DETECTIVE_INVESTIGATE",
          targetId: otherLiving(living.filter((id) => id !== detective.id), detective.id),
        });
      }
      sendAction(mafia.client, { type: "MAFIA_KILL", targetId: killTarget.id });
      await settle(60);
      const night = await resolveHost(room);
      expect(phaseOf(night.get(room.hostId) ?? [])).toBe("MORNING");
      living = living.filter((id) => !removedAfter(night.get(room.hostId) ?? []).includes(id));

      // Voting: dead player cannot vote; nonexistent and duplicate targets rejected.
      await startVotingPhase(room);
      const deadPlayer = byId(room, killTarget.id);
      sendAction(deadPlayer.client, {
        type: "CAST_VOTE",
        voterId: deadPlayer.id,
        targetId: otherLiving(living, killTarget.id),
      });
      await settle(50);
      expect(lastErrorCode(deadPlayer.client.drain())).toBe("PLAYER_DEAD");

      sendAction(attacker.client, { type: "CAST_VOTE", voterId: attacker.id, targetId: "ghost" });
      await settle(50);
      expect(lastErrorCode(attacker.client.drain())).toBe("PLAYER_NOT_FOUND");

      const firstVote = otherLiving(living, attacker.id);
      sendAction(attacker.client, { type: "CAST_VOTE", voterId: attacker.id, targetId: firstVote });
      await settle(50);
      // The duplicate re-targets firstVote (a guaranteed living player): the
      // engine rejects dead/nonexistent targets before checking for duplicates,
      // so a valid target is what isolates ACTION_ALREADY_SUBMITTED.
      sendAction(attacker.client, {
        type: "CAST_VOTE",
        voterId: attacker.id,
        targetId: firstVote,
      });
      await settle(50);
      expect(lastErrorCode(attacker.client.drain())).toBe("ACTION_ALREADY_SUBMITTED");
      // Their first vote still counted.
      const quiet4 = await sip(room, 40);
      const narr4 = lastNarrator(quiet4.get(room.hostId) ?? []);
      expect((narr4?.["votes"] as AnyRecord)?.[attacker.id]).toBe(firstVote);

      // Everything still resolves: remaining living players finish the round.
      const voted = room.players.filter((p) => living.includes(p.id) && p.id !== attacker.id);
      for (const p of voted) {
        sendAction(p.client, {
          type: "CAST_VOTE",
          voterId: p.id,
          targetId: otherLiving(living, p.id),
        });
        await sleep(10);
      }
      const round = await sip(room, 80);
      expect(["VOTE_RESULT", "GAME_OVER"]).toContain(phaseOf(round.get(room.hostId) ?? []) ?? "");
    });
  });

  test("malformed JSON, unknown types and wrong-phase actions are rejected without severing the socket", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const room = await joinAll(baseUrl, wsBase, namesUpTo(4));
      const bob = room.players[1];
      if (bob === undefined) throw new Error("missing bob");
      const host = hostOf(room).client;

      // Malformed frames keep the socket OPEN and produce errors.
      bob.client.sentRaw("{not json");
      await settle(50);
      expect(lastByType(bob.client.drain(), "error")?.["code"]).toBe("INVALID_MESSAGE");

      bob.client.send(42);
      await settle(50);
      expect(lastByType(bob.client.drain(), "error")?.["code"]).toBe("INVALID_MESSAGE");

      bob.client.send({ type: "mafia.other", anything: true });
      await settle(50);
      expect(lastByType(bob.client.drain(), "error")?.["code"]).toBe("UNKNOWN_MESSAGE_TYPE");
      expect(bob.client.ws.readyState).toBe(WebSocket.OPEN);

      bob.client.sentRaw("{\"type\":\"mafia.action\"}");
      await settle(50);
      expect(lastErrorCode(bob.client.drain())).toBe("MISSING_ACTION");

      bob.client.send({ type: "mafia.action", action: { type: "NOT_A_REAL_ACTION" } });
      await settle(50);
      expect(lastErrorCode(bob.client.drain())).toBe("INVALID_ACTION");

      // Wrong-phase actions.
      await readyUp(room);
      sendAction(bob.client, { type: "START_GAME" }); // never allowed from a player
      await settle(50);
      expect(lastErrorCode(bob.client.drain())).toBe("ACTION_FORBIDDEN");

      sendAction(host, { type: "START_GAME" });
      await sip(room, 80); // → ROLE_REVEAL

      sendAction(bob.client, { type: "CAST_VOTE", targetId: room.players[0]?.id });
      await settle(50);
      expect(lastErrorCode(bob.client.drain())).toBe("INVALID_PHASE");

      sendAction(bob.client, { type: "READY", playerId: bob.id });
      await settle(50);
      expect(lastErrorCode(bob.client.drain())).toBe("INVALID_PHASE");

      // Socket still healthy, game still playable.
      expect(bob.client.ws.readyState).toBe(WebSocket.OPEN);
      for (const p of room.players) {
        sendAction(p.client, { type: "ROLE_SEEN", playerId: p.id });
        await sleep(12);
      }
      const night = await sip(room, 80);
      expect(phaseOf(night.get(room.hostId) ?? [])).toBe("NIGHT");
    });
  });

  test("identity binding: his id is that player, foreign/garbage ids are rejected, rooms are sealed", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const roomA = await joinAll(baseUrl, wsBase, namesUpTo(4));

      // Garbage id → rejected.
      const ghost = new WsClient(wsUrl(wsBase, roomA.code, "not-a-real-id"));
      expect(await expectRejected(ghost)).toBe(true);

      // A foreign id (doesn't exist in this room) → rejected.
      const otherRoom = await createRoom(baseUrl);
      const foreignId = await joinPlayer(baseUrl, otherRoom, "Zoe");
      const foreign = new WsClient(wsUrl(wsBase, roomA.code, foreignId));
      expect(await expectRejected(foreign)).toBe(true);

      // Connecting under an existing player's id creates a second socket for
      // THAT player: the server binds this socket to that identity. It carries
      // only that player's view — the actor is always derived from the id.
      // A private payload only exists once a game has started, so we start
      // room A and drive it into the first night before sampling the clone.
      await startToNight(roomA);
      const bob = roomA.players[1];
      if (bob === undefined) throw new Error("missing bob");
      const bobSocket2 = await connect(wsBase, roomA.code, bob.id);
      await bobSocket2.awaitSync("mafia.private");
      const sync = bobSocket2.drain();
      const priv = lastPrivate(sync);
      expect(priv?.["playerId"]).toBe(bob.id);
      expect(priv?.["name"]).toBe(bob.name);
      expect(sync.some((m) => m.type === "mafia.narrator")).toBe(false); // not the host identity
      bobSocket2.close();
      await settle(40);

      // Room B stays sealed from room A traffic (A is mid-game).
      const roomB = await joinAll(baseUrl, wsBase, namesUpTo(4));
      for (const p of roomB.players) {
        sendAction(p.client, { type: "READY", playerId: p.id });
        await sleep(12);
      }
      await sip(roomB);
      for (const p of roomB.players) {
        expect(await expectNoMessage(p.client, 200)).toBe(true);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Disconnect / reconnect at every phase
// ---------------------------------------------------------------------------

describe("4. disconnect and reconnect across phases", () => {
  test("a reconnecting player restores their exact phase, identity and pending action", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const room = await joinAll(baseUrl, wsBase, namesUpTo(4));
      const bob0 = room.players[1];
      if (bob0 === undefined) throw new Error("missing bob");
      let bob: Party = bob0;

      // --- Lobby ---
      bob.client.close();
      await settle(80);
      bob = await reconnect(room, bob);
      room.players[1] = bob;
      const lobby = bob.client.drain();
      expect(lobby.some((m) => m.type === "connected")).toBe(true);
      expect(lobby.some((m) => m.type === "room.updated")).toBe(true);
      // A fresh room still gets the LOBBY mafia view: the session is created
      // eagerly, so the frontend can leave the "connecting…" state.
      const lobbyPriv = lastPrivate(lobby);
      expect(lobbyPriv?.["phase"]).toBe("LOBBY");
      expect(lobbyPriv?.["role"]).toBeNull();
      expect(lobby.some((m) => m.type === "mafia.state")).toBe(true);

      await readyUp(room);
      sendAction(hostOf(room).client, { type: "START_GAME" });
      const startMsgs = await sip(room, 80);
      expect(phaseOf(startMsgs.get(room.hostId) ?? [])).toBe("ROLE_REVEAL");
      const roles = (lastNarrator(startMsgs.get(room.hostId) ?? [])?.["roles"] as AnyRecord) ?? {};

      // --- Role reveal ---
      bob = await reconnect(room, bob, "mafia.private");
      room.players[1] = bob;
      const reveal = bob.client.drain();
      const revealPriv = lastPrivate(reveal);
      expect(revealPriv?.["phase"]).toBe("ROLE_REVEAL");
      expect(revealPriv?.["role"]).toBe(roles[bob.id]);
      expect(revealPriv?.["roleSeen"]).toBe(false);
      expect(revealPriv?.["availableActions"] as string[]).toContain("ROLE_SEEN");

      // --- Night, before acting (hold a second socket so the action is not auto-skipped) ---
      for (const p of room.players) {
        sendAction(p.client, { type: "ROLE_SEEN", playerId: p.id });
        await sleep(12);
      }
      const nightMsgs = await sip(room, 80);
      expect(phaseOf(nightMsgs.get(room.hostId) ?? [])).toBe("NIGHT");
      const actingMafiaId = (lastNarrator(nightMsgs.get(room.hostId) ?? [])?.["actingMafiaId"] as
        | string
        | undefined) ?? bob.id;
      const mafia = byId(room, actingMafiaId);
      const spare = await connect(wsBase, room.code, mafia.id); // keeps them present while we reconnect
      await settle(40);
      spare.drain();
      mafia.client.close();
      await settle(80);
      const restoredClient = await reconnect(
        room,
        mafia,
        mafia.id === room.hostId ? "mafia.narrator" : "mafia.private",
      );
      const mafiaIdx = room.players.findIndex((p) => p.id === mafia.id);
      if (mafiaIdx >= 0) room.players[mafiaIdx] = restoredClient;
      const nightPriv = lastPrivate(restoredClient.client.drain());
      expect(nightPriv?.["phase"]).toBe("NIGHT");
      expect(nightPriv?.["ownNightAction"]).toBe("NOT_ACTED");
      expect(nightPriv?.["availableActions"] as string[]).toContain("MAFIA_KILL");
      // They can still act after the reconnect (never targeting Bob).
      sendAction(restoredClient.client, {
        type: "MAFIA_KILL",
        targetId: first(room.players.filter((p) => p.id !== mafia.id && p.id !== bob.id)).id,
      });
      await settle(50);
      // The spare socket shields them from a second onClose skip while we close it.
      spare.close();
      sendAction(byId(room, actingMafiaId).client, {
        type: "MAFIA_KILL",
        targetId: first(room.players.filter((p) => p.id !== actingMafiaId && p.id !== bob.id)).id,
      });
      await settle(50);
      // The duplicate kill is always rejected to its sender (no broadcast).
      expect(lastErrorCode(restoredClient.client.drain())).toBe("ACTION_ALREADY_SUBMITTED");
      // A neutral socket (never the acting party or Bob) hears nothing about it.
      const observer = room.players.find(
        (p) => p.id !== actingMafiaId && p.id !== bob.id && p.id !== room.hostId,
      );
      if (observer !== undefined) {
        observer.client.drain();
        expect(await expectNoMessage(observer.client, 150)).toBe(true);
      }

      const doctor = first(room.players.filter((p) => roles[p.id] === "DOCTOR"));
      sendAction(doctor.client, { type: "DOCTOR_SAVE", targetId: null });
      const detective = room.players.find((p) => roles[p.id] === "DETECTIVE");
      if (detective !== undefined) {
        sendAction(detective.client, { type: "DETECTIVE_INVESTIGATE", targetId: actingMafiaId });
      }
      await settle(60);
      const night = await resolveHost(room);
      expect(phaseOf(night.get(room.hostId) ?? [])).toBe("MORNING");

      // --- Discussion ---
      sendAction(hostOf(room).client, { type: "START_DISCUSSION" });
      await sip(room, 60);
      bob = await reconnect(room, bob, "mafia.private");
      room.players[1] = bob;
      expect(lastPrivate(bob.client.drain())?.["phase"]).toBe("DISCUSSION");

      // --- Voting ---
      sendAction(hostOf(room).client, { type: "START_VOTING" });
      const votingMsgs = await sip(room, 60);
      const living = livingFrom(lastPublic(votingMsgs.get(room.hostId) ?? []));
      const bobVote = otherLiving(living.filter((id) => id !== bob.id), bob.id);
      bob = await reconnect(room, bob, "mafia.private");
      room.players[1] = bob;
      expect(lastPrivate(bob.client.drain())?.["phase"]).toBe("VOTING");
      // vote still available after reconnect
      sendAction(bob.client, { type: "CAST_VOTE", voterId: bob.id, targetId: bobVote });
      await settle(50);
      expect(lastErrorCode(bob.client.drain())).toBeUndefined();

      // Everyone else votes too → VOTE_RESULT.
      for (const id of living) {
        if (id === bob.id) continue;
        sendAction(byId(room, id).client, {
          type: "CAST_VOTE",
          voterId: id,
          targetId: otherLiving(living, id),
        });
        await sleep(10);
      }
      const result = await sip(room, 80);
      const resultPhase = phaseOf(result.get(room.hostId) ?? []);
      expect(["VOTE_RESULT", "GAME_OVER"]).toContain(resultPhase ?? "");

      // --- Vote result / game over reconnect ---
      bob = await reconnect(room, bob, "mafia.private");
      room.players[1] = bob;
      const endSync = bob.client.drain();
      const endPriv = lastPrivate(endSync);
      expect(endPriv?.["phase"]).toBe(resultPhase);
      const endPub = lastPublic(endSync);
      expect(endPub?.["gameId"]).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Simultaneous actions
// ---------------------------------------------------------------------------

describe("5. near-simultaneous actions resolve deterministically", () => {
  test("night actions and mass votes in one tick collapse to one fixed outcome", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const room = await joinAll(baseUrl, wsBase, namesUpTo(4));
      const { roles, actingMafiaId } = await startToNight(room);
      let living = room.players.map((p) => p.id);
      // Kill a villager: the doctor's save then deterministically blocks it
      // regardless of which role the target drew.
      const victim = first(room.players.filter((p) => roles[p.id] === "VILLAGER"));
      const mafia = byId(room, actingMafiaId);
      const doctor = first(room.players.filter((p) => roles[p.id] === "DOCTOR"));
      const detective = first(room.players.filter((p) => roles[p.id] === "DETECTIVE"));

      // Back-to-back, no interleaved awaits: Mafia/Doctor/Detective act together.
      sendAction(mafia.client, { type: "MAFIA_KILL", targetId: victim.id });
      sendAction(doctor.client, { type: "DOCTOR_SAVE", targetId: victim.id }); // blocks the kill
      sendAction(detective.client, { type: "DETECTIVE_INVESTIGATE", targetId: actingMafiaId });
      await settle(60);
      const night = await resolveHost(room);

      const pub = lastPublic(night.get(room.hostId) ?? []);
      expect(pub?.["phase"]).toBe("MORNING");
      // Doctor's save matched the kill → no death.
      expect(pub?.["morningDeaths"]).toEqual([]);
      const doctorPriv = lastPrivate(night.get(doctor.id) ?? []);
      expect((doctorPriv?.["ownPrivateNightResult"] as AnyRecord)?.["kind"]).toBe("HEAL");
      expect((doctorPriv?.["ownPrivateNightResult"] as AnyRecord)?.["applied"]).toBe(true);
      const detectivePriv = lastPrivate(night.get(detective.id) ?? []);
      const inv = detectivePriv?.["ownPrivateNightResult"] as AnyRecord;
      expect(inv).toMatchObject({ kind: "INVESTIGATION", targetId: actingMafiaId, isMafia: true });

      // The result is fully determined by the submitted set.
      living = living.filter((id) => !removedAfter(night.get(room.hostId) ?? []).includes(id));
      expect(living).toHaveLength(4);

      // Mass voting in one tick (4 players, 2+2 tie).
      await startVotingPhase(room);
      const [a, b] = living;
      const tieA = a ?? first(living);
      const tieB = b ?? first(living);
      const pairs: Array<[string, string]> = [];
      for (let i = 0; i < living.length; i++) {
        const voter = living[i];
        if (voter === undefined) continue;
        pairs.push([voter, i % 2 === 0 ? tieA : tieB]);
      }
      for (const [voterId, targetId] of pairs) {
        sendAction(byId(room, voterId).client, { type: "CAST_VOTE", voterId, targetId });
      }
      const result = await sip(room, 80);
      expect(phaseOf(result.get(room.hostId) ?? [])).toBe("VOTE_RESULT");
      const elim = lastPublic(result.get(room.hostId) ?? [])?.["elimination"] as AnyRecord;
      expect(elim?.["eliminatedPlayerId"]).toBeNull(); // tie → no elimination
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Multiple rooms
// ---------------------------------------------------------------------------

describe("6. multiple rooms run simultaneously without leakage", () => {
  test("two games interleave with sealed, independent state", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const roomA = await joinAll(baseUrl, wsBase, namesUpTo(4));
      const roomB = await joinAll(baseUrl, wsBase, namesUpTo(4));

      const aReady = (async () => readyUp(roomA))();
      const bReady = (async () => readyUp(roomB))();
      await Promise.all([aReady, bReady]);

      // A starts first: full town win while B idles.
      const { roles: rolesA, actingMafiaId: actingA } = await startToNight(roomA);
      const victimA = first(roomA.players.filter((p) => rolesA[p.id] === "VILLAGER"));
      sendAction(byId(roomA, actingA).client, { type: "MAFIA_KILL", targetId: victimA.id });
      const docA = first(roomA.players.filter((p) => rolesA[p.id] === "DOCTOR"));
      sendAction(docA.client, { type: "DOCTOR_SAVE", targetId: null });
      await settle(60);
      const aNight = await resolveHost(roomA);
      expect(phaseOf(aNight.get(roomA.hostId) ?? [])).toBe("MORNING");
      await startVotingPhase(roomA);
      const livingA = livingFrom(lastPublic(aNight.get(roomA.hostId) ?? []));
      const overA = await runVoting(roomA, livingA, (voterId) =>
        rolesA[voterId] === "MAFIA" ? otherLiving(livingA, voterId) : actingA,
      );
      expect(phaseOf(overA.get(roomA.hostId) ?? [])).toBe("GAME_OVER");
      for (const p of roomB.players) {
        expect(await expectNoMessage(p.client, 200)).toBe(true);
      }

      // B starts and runs its own GAME_OVER.
      const { roles: rolesB, actingMafiaId: actingB } = await startToNight(roomB);
      const victimB = first(roomB.players.filter((p) => rolesB[p.id] === "VILLAGER"));
      sendAction(byId(roomB, actingB).client, { type: "MAFIA_KILL", targetId: victimB.id });
      const docB = first(roomB.players.filter((p) => rolesB[p.id] === "DOCTOR"));
      sendAction(docB.client, { type: "DOCTOR_SAVE", targetId: null });
      await settle(60);
      const bNight = await resolveHost(roomB);
      await startVotingPhase(roomB);
      const livingB = livingFrom(lastPublic(bNight.get(roomB.hostId) ?? []));
      const overB = await runVoting(roomB, livingB, (voterId) =>
        rolesB[voterId] === "MAFIA" ? otherLiving(livingB, voterId) : actingB,
      );
      expect(phaseOf(overB.get(roomB.hostId) ?? [])).toBe("GAME_OVER");
      expect(lastPublic(overB.get(roomB.hostId) ?? [])?.["winner"]).toBe("TOWN");
    });
  });
});

// ---------------------------------------------------------------------------
// 7 + 8. Host / narrator disconnect independence
// ---------------------------------------------------------------------------

describe("7. host disconnect does not stall the game", () => {
  test("the game keeps accepting actions and resumes when the host returns", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const room = await joinAll(baseUrl, wsBase, namesUpTo(4));
      const hostParty = hostOf(room);

      // --- Lobby: host away, everyone else still readies ---
      hostParty.client.close();
      await settle(80);
      const bobsReady: boolean[] = [];
      for (const p of room.players.slice(1)) {
        sendAction(p.client, { type: "READY", playerId: p.id });
      }
      const lobby = await sip(room, 80);
      for (const p of room.players.slice(1)) {
        const priv = lastPrivate(lobby.get(p.id) ?? []);
        if (priv !== undefined) bobsReady.push(priv["ready"] === true);
      }
      expect(bobsReady.length).toBeGreaterThan(0);
      expect(bobsReady.every(Boolean)).toBe(true);

       // Host returns and can still start.
      room.players[0] = await reconnect(room, hostParty);
      const { roles, actingMafiaId } = await startToNight(room);

      // --- Night: the narrator's socket goes away while Mafia/Doctor/Detective act ---
      // The host is also an ordinary player with a role. Hold a spare socket for
      // the host identity so closing the narrator socket never auto-skips the
      // host's own night contribution, and so a host-role contribution can still
      // be delivered through the spare. The spare is NOT a narrator: it cannot
      // resolve the night, so MORNING stays gated on the narrator returning.
      const hostAway = room.players[0];
      const hostProxy = await connect(wsBase, room.code, room.hostId);
      await settle(40);
      hostProxy.drain();
      hostAway.client.close();
      await settle(80);
      // The victim is never the host: if the host died, every survivor would
      // vote and the round would auto-resolve before END_VOTING, which races
      // the wrapped-phase assertion below. Keep the host alive and abstaining.
      const victim = first(
        room.players.filter((p) => p.id !== actingMafiaId && p.id !== room.hostId),
      );
      const actorSend = (id: string, action: AnyRecord): void => {
        sendAction(id === room.hostId ? hostProxy : byId(room, id).client, action);
      };
      actorSend(actingMafiaId, { type: "MAFIA_KILL", targetId: victim.id });
      const doctor = room.players.find((p) => roles[p.id] === "DOCTOR");
      if (doctor !== undefined) actorSend(doctor.id, { type: "DOCTOR_SAVE", targetId: null });
      await settle(60);

      // No narrator online → no MORNING yet; the game simply waits.

      const hostBack0 = await reconnect(room, hostAway, "mafia.narrator");
      room.players[0] = hostBack0;
      const restored = hostBack0.client.drain();
      const narrBack = lastNarrator(restored);
      expect((narrBack?.["publicState"] as AnyRecord)?.["phase"]).toBe("NIGHT");
      const narrBackActions = narrBack?.["nightActions"] as AnyRecord | undefined;
      const killResult = narrBackActions?.["kill"] as AnyRecord | undefined;
      expect(killResult?.["status"]).toBe("SUBMITTED");
      const morning = await resolveHost(room);
      expect(phaseOf(morning.get(room.hostId) ?? [])).toBe("MORNING");

      // --- Voting: host away, everyone votes; host returns and wraps up ---
      sendAction(hostOf(room).client, { type: "START_DISCUSSION" });
      await sip(room, 60);
      sendAction(hostOf(room).client, { type: "START_VOTING" });
      const votingMsgs = await sip(room, 60);
      const living2 = livingFrom(lastPublic(votingMsgs.get(room.hostId) ?? []));
      const playersToVote = room.players.filter((p) => living2.includes(p.id) && p.id !== room.hostId);
      for (const p of playersToVote) {
        sendAction(p.client, { type: "CAST_VOTE", voterId: p.id, targetId: otherLiving(living2, p.id) });
        await sleep(10);
      }
      await sip(room, 60);
      // Host (with no vote yet) returns and closes the round.
      const hostBack1 = await reconnect(room, room.players[0], "mafia.narrator");
      room.players[0] = hostBack1;
      hostBack1.client.drain();
      sendAction(hostBack1.client, { type: "END_VOTING" });
      const wrapped = await sip(room, 80);
      expect(["VOTE_RESULT", "GAME_OVER"]).toContain(phaseOf(wrapped.get(room.hostId) ?? []) ?? "");
    });
  });
});

describe("8. narrator state is restored on reconnect mid-night", () => {
  test("pending night contributions come back with the narrator", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const room = await joinAll(baseUrl, wsBase, namesUpTo(4));
      const { roles, actingMafiaId } = await startToNight(room);
      let living = room.players.map((p) => p.id);
      const victim = first(
        room.players.filter((p) => p.id !== actingMafiaId && p.id !== room.hostId),
      );

      // Everyone contributes before the narrator leaves.
      sendAction(byId(room, actingMafiaId).client, { type: "MAFIA_KILL", targetId: victim.id });
      const doctor = first(room.players.filter((p) => roles[p.id] === "DOCTOR"));
      sendAction(doctor.client, { type: "DOCTOR_SAVE", targetId: null });
      const detective = room.players.find((p) => roles[p.id] === "DETECTIVE");
      if (detective !== undefined) sendAction(detective.client, { type: "DETECTIVE_INVESTIGATE", targetId: actingMafiaId });
      await settle(60);

      // Narrator leaves mid-night; MORNING must NOT occur without them.
      hostOf(room).client.close();
      await settle(80);
      const before = await sip(room, 60);
      expect(phaseOf(before.get(room.players[1]?.id ?? room.hostId) ?? []) ?? "NIGHT").toBe("NIGHT");

      // Narrator reconnects: the pending night state (kill/save/investigate,
      // acting mafia, night number) is restored verbatim, then they resolve.
      room.players[0] = await reconnect(room, hostOf(room), "mafia.narrator");
      const synced = hostOf(room).client.drain();
      expect((lastNarrator(synced)?.["publicState"] as AnyRecord)?.["phase"]).toBe("NIGHT");
      const na = lastNarrator(synced)?.["nightActions"] as AnyRecord;
      expect(na?.["kill"]).toMatchObject({ status: "SUBMITTED", targetId: victim.id });
      expect(na?.["save"]).toMatchObject({ status: "PASSED" });
      expect(lastNarrator(synced)?.["actingMafiaId"]).toBe(actingMafiaId);

      const morning = await resolveHost(room);
      expect(phaseOf(morning.get(room.hostId) ?? [])).toBe("MORNING");
      expect((lastPublic(morning.get(room.hostId) ?? [])?.["morningDeaths"] as string[])).toEqual([
        victim.id,
      ]);
      living = living.filter((id) => !removedAfter(morning.get(room.hostId) ?? []).includes(id));
      expect(living).toHaveLength(3);
    });
  });
});

// ---------------------------------------------------------------------------
// 9. Replay
// ---------------------------------------------------------------------------

describe("9. PLAY_AGAIN replay", () => {
  test("the roster persists and every round resets", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const room = await joinAll(baseUrl, wsBase, namesUpTo(4));
      const { over } = await driveQuickTownWin(room);
      const firstGameId = lastPublic(over.get(room.hostId) ?? [])?.["gameId"];

      // Non-narrator cannot replay.
      sendAction(room.players[1]?.client ?? hostOf(room).client, { type: "PLAY_AGAIN" });
      await settle(50);
      expect(lastErrorCode((room.players[1]?.client ?? hostOf(room).client).drain())).toBe(
        "ACTION_FORBIDDEN",
      );

      // Narrator replays.
      sendAction(hostOf(room).client, { type: "PLAY_AGAIN" });
      const replayed = await sip(room, 80);
      expect(phaseOf(replayed.get(room.hostId) ?? [])).toBe("LOBBY");

      const narr = lastNarrator(replayed.get(room.hostId) ?? []);
      expect(narr?.["roles"]).toEqual({});
      expect(narr?.["votes"]).toBeNull();
      expect(narr?.["nightActions"]).toBeNull();
      expect(narr?.["lastResolvedNight"]).toBeNull();
      expect(narr?.["timeline"]).toEqual([]);

      const pub = lastPublic(replayed.get(room.hostId) ?? []);
      expect(pub?.["gameId"]).toBe(firstGameId);
      expect((pub?.["players"] as AnyRecord[]).every((pl: AnyRecord) => pl["alive"] === true)).toBe(true);

      for (const p of room.players) {
        const priv = lastPrivate(replayed.get(p.id) ?? []);
        expect(priv?.["phase"]).toBe("LOBBY");
        expect(priv?.["ready"]).toBe(false);
        expect(priv?.["role"]).toBeNull();
      }

      // Room reopens for HTTP joins after the game ended.
      const get = await api(baseUrl, "GET", `/rooms/${room.code}`);
      expect((get.json?.["room"] as AnyRecord)["status"]).toBe("waiting");

      // Start again.
      const second = await startToNight(room);
      // Roles were reassigned from the same distribution.
      const counts: Record<string, number> = {};
      for (const p of room.players) {
        const role = second.roles[p.id] as string;
        counts[role] = (counts[role] ?? 0) + 1;
      }
      // Verify counts sum to total players
      expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(room.players.length);

      // No round-1 leakage: fresh night bookkeeping (from the NIGHT-2 start sync).
      const narrNight = lastNarrator(second.night.get(room.hostId) ?? []);
      expect((narrNight?.["nightActions"] as AnyRecord)?.["kill"]).toMatchObject({ status: "NOT_ACTED" });
      expect((narrNight?.["publicState"] as AnyRecord)?.["nightNumber"]).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// 10. Long-running game
// ---------------------------------------------------------------------------

describe("10. long multi-night game", () => {
  test("several nights, eliminations, saves, ties and a changing acting Mafia stay coherent", async () => {
    await withServer(async ({ baseUrl, wsBase }) => {
      const room = await joinAll(baseUrl, wsBase, namesUpTo(8));
      const { roles, actingMafiaId } = await startToNight(room);
      const mafiaIds = room.players.filter((p) => roles[p.id] === "MAFIA").map((p) => p.id);
      expect(mafiaIds).toHaveLength(2);
      const doctor = first(room.players.filter((p) => roles[p.id] === "DOCTOR"));
      const detective = first(room.players.filter((p) => roles[p.id] === "DETECTIVE"));
      let living = room.players.map((p) => p.id);
      const actingByNight: string[] = [actingMafiaId];

      // Round 1: Mafia kills a villager, Doctor passes, Detective investigates the Mafia.
      const killTarget = (exclude: string[]) =>
        first(room.players.filter((p) => p.id !== undefined && !exclude.includes(p.id) && roles[p.id] === "VILLAGER"));
      const v1 = killTarget([actingMafiaId]);
      sendAction(byId(room, actingMafiaId).client, { type: "MAFIA_KILL", targetId: v1.id });
      sendAction(doctor.client, { type: "DOCTOR_SAVE", targetId: null });
      sendAction(detective.client, { type: "DETECTIVE_INVESTIGATE", targetId: actingMafiaId });
      await settle(60);
      // The narrator exposes the acting Mafia during NIGHT; after resolution the
      // MORNING narrator snapshot resets it to null, so assert from the night view.
      const night1In = await sip(room, 40);
      expect(
        (lastNarrator(night1In.get(room.hostId) ?? [])?.["actingMafiaId"]),
      ).toBe(actingMafiaId);
      const n1 = await resolveHost(room);
      expect((lastPublic(n1.get(room.hostId) ?? [])?.["morningDeaths"] as string[])).toEqual([v1.id]);
      living = living.filter((id) => id !== v1.id);

      // Vote round 1: the town lynches the acting Mafia.
      await startVotingPhase(room);
      const r1 = await runVoting(room, living, (voterId) =>
        roles[voterId] === "MAFIA" ? otherLiving(living, voterId) : actingMafiaId,
      );
      expect((lastPublic(r1.get(room.hostId) ?? [])?.["elimination"] as AnyRecord)?.["eliminatedPlayerId"]).toBe(
        actingMafiaId,
      );
      living = living.filter((id) => id !== actingMafiaId);
      expect(living).toHaveLength(6);

      // ADVANCE_PHASE: VOTE_RESULT → NIGHT 2 with the OTHER Mafia now acting.
      sendAction(hostOf(room).client, { type: "ADVANCE_PHASE" });
      const night2In = await sip(room, 80);
      expect(phaseOf(night2In.get(room.hostId) ?? [])).toBe("NIGHT");
      const acting2 = lastNarrator(night2In.get(room.hostId) ?? [])?.["actingMafiaId"] as string;
      actingByNight.push(acting2);
      expect(acting2).not.toBe(actingMafiaId);
      expect(mafiaIds.filter((id) => living.includes(id))).toContain(acting2);

      // Round 2: the Doctor saves the Mafia's target → the night kills nobody.
      const v2 = killTarget([actingMafiaId, acting2, v1.id]);
      sendAction(byId(room, acting2).client, { type: "MAFIA_KILL", targetId: v2.id });
      sendAction(doctor.client, { type: "DOCTOR_SAVE", targetId: v2.id });
      sendAction(detective.client, { type: "DETECTIVE_INVESTIGATE", targetId: acting2 });
      await settle(60);
      const n2 = await resolveHost(room);
      const pub2 = lastPublic(n2.get(room.hostId) ?? []);
      expect(pub2?.["morningDeaths"]).toEqual([]);
      const doctorResult = lastPrivate(n2.get(doctor.id) ?? [])?.["ownPrivateNightResult"] as AnyRecord;
      expect(doctorResult?.["kind"]).toBe("HEAL");
      expect(doctorResult?.["applied"]).toBe(true);

      // Vote round 2 is a tie → no elimination.
      await startVotingPhase(room);
      let voteData: string[] = [];
      for (const id of living) voteData.push(otherLiving(living, id));
      // Half vote X, half vote Y → tie.
      const x = voteData[0] ?? first(living);
      const y = voteData[1] ?? first(living);
      let i = 0;
      for (const id of living) {
        sendAction(byId(room, id).client, { type: "CAST_VOTE", voterId: id, targetId: i % 2 === 0 ? x : y });
        i += 1;
        await sleep(10);
      }
      const tieRound = await sip(room, 80);
      expect(phaseOf(tieRound.get(room.hostId) ?? [])).toBe("VOTE_RESULT");
      expect((lastPublic(tieRound.get(room.hostId) ?? [])?.["elimination"] as AnyRecord)?.[
        "eliminatedPlayerId"
      ]).toBeNull();
      expect(living).toHaveLength(6);

      // Night 3 — this time the kill lands (Doctor saves elsewhere).
      sendAction(hostOf(room).client, { type: "ADVANCE_PHASE" });
      const night3In = await sip(room, 80);
      const acting3 = lastNarrator(night3In.get(room.hostId) ?? [])?.["actingMafiaId"] as string;
      actingByNight.push(acting3);
      expect(acting3).toBe(acting2);
      const v3 = killTarget([actingMafiaId, acting2, acting3, v1.id]);
      const saveElsewhere = first(room.players.filter((p) => p.id !== v3.id && roles[p.id] === "VILLAGER"));
      sendAction(byId(room, acting3).client, { type: "MAFIA_KILL", targetId: v3.id });
      sendAction(doctor.client, { type: "DOCTOR_SAVE", targetId: saveElsewhere.id });
      await settle(60);
      const n3 = await resolveHost(room);
      expect((lastPublic(n3.get(room.hostId) ?? [])?.["morningDeaths"] as string[])).toEqual([v3.id]);
      living = living.filter((id) => id !== v3.id);
      expect(living).toHaveLength(5);

      // Final vote: the town finally lynches the last Mafia.
      await startVotingPhase(room);
      const finalRound = await runVoting(room, living, (voterId) =>
        roles[voterId] === "MAFIA" ? otherLiving(living, voterId) : acting3,
      );
      const finalPub = lastPublic(finalRound.get(room.hostId) ?? []);
      expect(finalPub?.["phase"]).toBe("GAME_OVER");
      expect(finalPub?.["winner"]).toBe("TOWN");

      // Consistency across the whole run. The final lynch removed acting3, so
      // derive the living roster from the GAME_OVER public state instead of the
      // stale `living` array (which predates the final elimination).
      const finalLiving = livingFrom(finalPub);
      for (const p of room.players) {
        const priv = lastPrivate(finalRound.get(p.id) ?? []);
        expect(priv?.["role"]).toBe(roles[p.id]);
        expect(priv?.["alive"]).toBe(finalLiving.includes(p.id));
      }
      const finalNarr = lastNarrator(finalRound.get(room.hostId) ?? []);
      const timeline = finalNarr?.["timeline"] as AnyRecord[];
      expect(timeline.filter((e) => e["kind"] === "GAME_OVER").length).toBeGreaterThan(0);
      expect(actingByNight.length).toBe(3);
      expect(new Set(mafiaIds.filter((id) => finalLiving.includes(id))).size).toBe(0);
    });
  });
});