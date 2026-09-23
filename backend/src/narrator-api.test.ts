/**
 * Narrator (Mode C) HTTP integration tests.
 *
 * Exercises the real /narrator routes through a live Bun server, end to end:
 * lobby setup, role reveal, night collection, resolution, the day (discussion,
 * recorded spoken votes, elimination) and replay, exactly as the single-device
 * narrator UI drives it. The server deals with Math.random, so tests never
 * guess roles — they read the current narrator view (as the narrator does) and
 * respond to it. The view is deliberately a privileged, single-operator
 * surface; no player channel is involved.
 */
import { describe, expect, test } from "bun:test";
import { api, withServer } from "./test-server.ts";
import type { NarratorView } from "./games/mafia/adapters/narrator/types.ts";

type AnyRecord = Record<string, unknown>;
type Roles = Record<string, string>;

const NAMES = ["Ada", "Bob", "Cam", "Dea"];

function viewOf(json: AnyRecord | null): NarratorView {
  const view = json?.["view"] as NarratorView | undefined;
  if (view === undefined) throw new Error(`expected a view, got ${JSON.stringify(json)}`);
  return view;
}

function requireKind<K extends NarratorView["kind"]>(
  view: NarratorView,
  kind: K,
): Extract<NarratorView, { kind: K }> {
  expect(view.kind, `expected ${kind}`).toBe(kind);
  return view as Extract<NarratorView, { kind: K }>;
}

async function addPlayers(baseUrl: string, names: string[]): Promise<void> {
  for (const name of names) {
    const res = await api(baseUrl, "POST", "/narrator/players", { name });
    expect(res.status, `addPlayer(${name})`).toBe(200);
  }
}

/** Open a fresh 4-player game and return the dealt roles read from the reveal. */
async function openGame(baseUrl: string, names = NAMES): Promise<Roles> {
  await addPlayers(baseUrl, names);
  const start = await api(baseUrl, "POST", "/narrator/start");
  expect(start.status).toBe(200);
  const roles: Roles = {};
  for (const p of requireKind(viewOf(start.json), "ROLE_REVEAL").players) {
    roles[p.id] = p.role;
  }
  return roles;
}

function idOfRole(roles: Roles, role: string): string {
  const id = Object.keys(roles).find((k) => roles[k] === role);
  if (id === undefined) throw new Error(`no player dealt ${role}`);
  return id;
}

async function nightAction(baseUrl: string, action: string, targetId: string | null): Promise<NarratorView> {
  const res = await api(baseUrl, "POST", "/narrator/night-action", { action, targetId });
  expect(res.status).toBe(200);
  return viewOf(res.json);
}

/** Record one full night (kill/save/investigate) and resolve it. */
async function playNight(
  baseUrl: string,
  plan: { kill: string; save?: string | null; investigate?: string },
): Promise<NarratorView> {
  await nightAction(baseUrl, "MAFIA_KILL", plan.kill);
  await nightAction(baseUrl, "DOCTOR_SAVE", plan.save ?? null);
  if (plan.investigate !== undefined) await nightAction(baseUrl, "DETECTIVE_INVESTIGATE", plan.investigate);
  const res = await api(baseUrl, "POST", "/narrator/resolve-night");
  expect(res.status).toBe(200);
  return viewOf(res.json);
}

/**
 * Fast-forward through discussion + recorded voting with one vote per voter.
 * `pick(voterId, roles)` returns the target id. Ends by reading the result
 * (auto-ended when all living vote, or the engine seals to GAME_OVER).
 */
async function performVoting(
  baseUrl: string,
  pick: (voterId: string, roles: Roles) => string,
  roles: Roles,
): Promise<NarratorView> {
  await api(baseUrl, "POST", "/narrator/start-discussion");
  const started = await api(baseUrl, "POST", "/narrator/start-voting");
  expect(started.status).toBe(200);
  let view = viewOf(started.json);

  for (let guard = 0; guard < 10; guard++) {
    if (view.kind === "VOTE_RESULT" || view.kind === "GAME_OVER") return view;
    const voting = requireKind(view, "VOTING");
    const voter = voting.votersLeft[0];
    if (voter === undefined) throw new Error("no voters left but the round is still open");
    const res = await api(baseUrl, "POST", "/narrator/vote", {
      voterId: voter.id,
      targetId: pick(voter.id, roles),
    });
    expect(res.status).toBe(200);
    view = viewOf(res.json);
  }
  throw new Error("voting did not finish");
}

describe("narrator API — setup, reveal & night", () => {
  test("GET /narrator starts at an empty lobby; players can be added, removed and the game started", async () => {
    await withServer(async ({ baseUrl }) => {
      const lobby = requireKind(viewOf((await api(baseUrl, "GET", "/narrator")).json), "LOBBY");
      expect(lobby.players).toEqual([]);
      expect(lobby.canStart).toBe(false);
      expect(lobby.minPlayers).toBe(4);
      expect(lobby.maxPlayers).toBe(20);

      await addPlayers(baseUrl, NAMES);
      const filled = requireKind(viewOf((await api(baseUrl, "GET", "/narrator")).json), "LOBBY");
      expect(filled.players.map((p) => p.name)).toEqual(NAMES);
      expect(filled.canStart).toBe(true);

      const duplicate = await api(baseUrl, "POST", "/narrator/players", { name: "Bob" });
      expect(duplicate.status).toBe(409);

      const bob = filled.players.find((p) => p.name === "Bob");
      expect(bob).toBeDefined();
      const removed = await api(baseUrl, "DELETE", `/narrator/players/${bob!.id}`);
      expect(removed.status).toBe(200);
      const after = requireKind(viewOf(removed.json), "LOBBY");
      expect(after.players.map((p) => p.name)).toEqual(["Ada", "Cam", "Dea"]);

      const cam = filled.players.find((p) => p.name === "Cam");
      expect(cam).toBeDefined();
      await api(baseUrl, "DELETE", `/narrator/players/${cam!.id}`);

      const tooFew = await api(baseUrl, "POST", "/narrator/start");
      expect(tooFew.status).toBe(422);

      await addPlayers(baseUrl, ["Bob", "Cam"]);
      const started = await api(baseUrl, "POST", "/narrator/start");
      expect(started.status).toBe(200);
      const reveal = requireKind(viewOf(started.json), "ROLE_REVEAL");
      expect(reveal.players).toHaveLength(4);
      expect(new Set(reveal.players.map((p) => p.role))).toEqual(
        new Set(["MAFIA", "DOCTOR", "DETECTIVE", "VILLAGER"]),
      );
    });
  });

  test("a night of recorded actions resolves to morning with deaths and the detective's verdict", async () => {
    await withServer(async ({ baseUrl }) => {
      const roles = await openGame(baseUrl);
      const mafia = idOfRole(roles, "MAFIA");
      const villager = idOfRole(roles, "VILLAGER");

      const began = await api(baseUrl, "POST", "/narrator/begin-night");
      expect(began.status).toBe(200);
      const night = requireKind(viewOf(began.json), "NIGHT");
      expect(night.nightNumber).toBe(1);
      expect(night.players).toHaveLength(4);
      expect(night.kill.status).toBe("NOT_ACTED");
      expect(night.save.status).toBe("NOT_ACTED");
      expect(night.investigate.status).toBe("NOT_ACTED");

      // The acting Mafia cannot self-target.
      const selfKill = await api(baseUrl, "POST", "/narrator/night-action", {
        action: "MAFIA_KILL",
        targetId: mafia,
      });
      expect(selfKill.status).toBe(400);

      const afterKill = await nightAction(baseUrl, "MAFIA_KILL", villager);
      expect(requireKind(afterKill, "NIGHT").kill.status).toBe("SUBMITTED");

      const afterPass = await nightAction(baseUrl, "DOCTOR_SAVE", null);
      expect(requireKind(afterPass, "NIGHT").save.status).toBe("PASSED");

      const afterInvestigate = await nightAction(baseUrl, "DETECTIVE_INVESTIGATE", mafia);
      expect(requireKind(afterInvestigate, "NIGHT").investigate.status).toBe("SUBMITTED");

      const resolved = await api(baseUrl, "POST", "/narrator/resolve-night");
      expect(resolved.status).toBe(200);
      const morning = requireKind(viewOf(resolved.json), "MORNING");
      expect(morning.nightNumber).toBe(1);
      expect(morning.deaths.map((p) => p.id)).toEqual([villager]);
      expect(morning.investigation).toMatchObject({ targetId: mafia, isMafia: true });
    });
  });
});

describe("narrator API — day, voting and both win conditions", () => {
  test("town wins by lynching the final Mafia", async () => {
    await withServer(async ({ baseUrl }) => {
      const roles = await openGame(baseUrl);
      const mafia = idOfRole(roles, "MAFIA");
      const doctor = idOfRole(roles, "DOCTOR");
      await api(baseUrl, "POST", "/narrator/begin-night");
      await playNight(baseUrl, { kill: idOfRole(roles, "VILLAGER"), save: null, investigate: mafia });

      // Doctor and Detective lynch the Mafia; the Mafia votes the Doctor.
      const end = requireKind(
        await performVoting(baseUrl, (voter) => (voter === mafia ? doctor : mafia), roles),
        "GAME_OVER",
      );
      expect(end.winner).toBe("TOWN");
      const byId = new Map(end.players.map((p) => [p.id, p] as const));
      expect(byId.get(mafia)?.alive).toBe(false);
      expect(byId.get(mafia)?.role).toBe("MAFIA");
      expect(byId.get(doctor)?.alive).toBe(true);
    });
  });

  test("the Mafia wins via two night kills through a tied day", async () => {
    await withServer(async ({ baseUrl }) => {
      const roles = await openGame(baseUrl);
      const mafia = idOfRole(roles, "MAFIA");
      const doctor = idOfRole(roles, "DOCTOR");
      const detective = idOfRole(roles, "DETECTIVE");

      await api(baseUrl, "POST", "/narrator/begin-night");
      const morning1 = requireKind(
        await playNight(baseUrl, { kill: idOfRole(roles, "VILLAGER"), save: null, investigate: mafia }),
        "MORNING",
      );
      expect(morning1.investigation?.isMafia).toBe(true);

      // Day 1 ends in a three-way tie: nobody is eliminated.
      const tied = requireKind(
        await performVoting(
          baseUrl,
          (voter) => (voter === mafia ? doctor : voter === doctor ? detective : mafia),
          roles,
        ),
        "VOTE_RESULT",
      );
      expect(tied.tie).toBe(true);
      expect(tied.eliminatedPlayer).toBeNull();

      // The narrator drives the next night and the detective dies: Mafia wins.
      const advanced = await api(baseUrl, "POST", "/narrator/advance");
      expect(requireKind(viewOf(advanced.json), "NIGHT").nightNumber).toBe(2);
      const end = requireKind(
        await playNight(baseUrl, { kill: detective, save: null, investigate: mafia }),
        "GAME_OVER",
      );
      expect(end.winner).toBe("MAFIA");
      const byId = new Map(end.players.map((p) => [p.id, p] as const));
      expect(byId.get(detective)?.alive).toBe(false);
      expect(byId.get(mafia)?.alive).toBe(true);
    });
  });
});

describe("narrator API — replay, reset & error mapping", () => {
  test("playAgain keeps the roster; reset empties the lobby", async () => {
    await withServer(async ({ baseUrl }) => {
      await openGame(baseUrl);
      await playAgainToGameOver(baseUrl);

      const playAgain = await api(baseUrl, "POST", "/narrator/play-again");
      expect(playAgain.status).toBe(200);
      const lobby = requireKind(viewOf(playAgain.json), "LOBBY");
      expect(lobby.players.map((p) => p.name)).toEqual(NAMES);
      expect(lobby.canStart).toBe(true);

      const reset = await api(baseUrl, "POST", "/narrator/reset");
      const empty = requireKind(viewOf(reset.json), "LOBBY");
      expect(empty.players).toEqual([]);
      expect(empty.canStart).toBe(false);
    });
  });

  test("domain errors map to stable HTTP statuses", async () => {
    await withServer(async ({ baseUrl }) => {
      // Vote before any game exists (still a lobby).
      const earlyVote = await api(baseUrl, "POST", "/narrator/vote", {
        voterId: "p1",
        targetId: "p2",
      });
      expect(earlyVote.status).toBe(400);
      expect(typeof earlyVote.json?.["error"]).toBe("string");

      // Night action with a bad type.
      const badAction = await api(baseUrl, "POST", "/narrator/night-action", {
        action: "TURN_OFF_THE_LIGHTS",
        targetId: null,
      });
      expect(badAction.status).toBe(400);

      // Start too early / with bad body shape.
      const noBody = await api(baseUrl, "POST", "/narrator/players", "");
      expect(noBody.status).toBe(400);
    });
  });
});

/** Just enough game to reach GAME_OVER (used by the replay test). */
async function playAgainToGameOver(baseUrl: string): Promise<void> {
  const reveal = requireKind(viewOf((await api(baseUrl, "GET", "/narrator")).json), "ROLE_REVEAL");
  const roles: Roles = {};
  for (const p of reveal.players) roles[p.id] = p.role;
  const mafia = idOfRole(roles, "MAFIA");
  const doctor = idOfRole(roles, "DOCTOR");
  await api(baseUrl, "POST", "/narrator/begin-night");
  await playNight(baseUrl, { kill: idOfRole(roles, "VILLAGER"), save: null, investigate: mafia });
  const end = await performVoting(baseUrl, (voter) => (voter === mafia ? doctor : mafia), roles);
  requireKind(end, "GAME_OVER");
}