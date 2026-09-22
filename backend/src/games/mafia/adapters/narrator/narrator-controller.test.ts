/**
 * Phase 13 — Narrator (Mode C) Mafia adapter transitions.
 *
 * The controller is exercised exactly like a narrator UI would: read the view,
 * record the spoken action, resolve, advance. The narrator is privileged — it
 * legitimately reads every role, night input, verdict and vote through the
 * engine's narrator view — so this suite verifies the *adapter's* flows
 * (phases, recorded actions, day/night, replay) on top of the engine, not the
 * engine's own rules (which `mafia-rules.test.ts` already owns).
 *
 * A deterministic injected RNG makes every deal repeatable; tests read the deal
 * from the ROLE_REVEAL screen exactly as the narrator does.
 */
import { describe, expect, test } from "bun:test";
import { NarratorController } from "./narrator-controller.ts";
import type { NarratorView } from "./types.ts";
import type { MafiaRole, PlayerId } from "../../types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeController(seed = 7): NarratorController {
  return new NarratorController({ random: mulberry32(seed) });
}

function addPlayers(c: NarratorController, names: string[]): void {
  for (const name of names) {
    const result = c.addPlayer(name);
    expect(result.ok, `addPlayer(${name})`).toBe(true);
  }
}

const NAMES = ["Ada", "Bob", "Cam", "Dea"];

type Roles = Record<PlayerId, MafiaRole>;

function idOf(roles: Roles, role: MafiaRole): PlayerId {
  const id = Object.keys(roles).find((k) => roles[k] === role);
  if (id === undefined) throw new Error(`no player with role ${role}`);
  return id;
}

function changed(result: { ok: true; view: NarratorView } | { ok: false; error: { code: string } }): NarratorView {
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}`);
  return result.view;
}

function requireKind<K extends NarratorView["kind"]>(
  view: NarratorView,
  kind: K,
): Extract<NarratorView, { kind: K }> {
  expect(view.kind).toBe(kind);
  return view as Extract<NarratorView, { kind: K }>;
}

/** The deal, read from the reveal screen the way the narrator reads it. */
function revealedRoles(c: NarratorController): Roles {
  return Object.fromEntries(
    requireKind(c.getView(), "ROLE_REVEAL").players.map((p) => [p.id, p.role] as const),
  );
}

/** Start a fresh 4-player game and reveal the deal. */
function openGame(c: NarratorController, names = NAMES): Roles {
  addPlayers(c, names);
  changed(c.startGame());
  return revealedRoles(c);
}

/** Record a full night (kill/save/investigate as given) and resolve it. */
function performNight(
  c: NarratorController,
  plan: { kill?: PlayerId; save?: PlayerId | null; investigate?: PlayerId },
): NarratorView {
  requireKind(c.getView(), "NIGHT");
  if (plan.kill !== undefined) changed(c.recordNightAction("MAFIA_KILL", plan.kill));
  if (plan.save !== undefined) changed(c.recordNightAction("DOCTOR_SAVE", plan.save));
  if (plan.investigate !== undefined) changed(c.recordNightAction("DETECTIVE_INVESTIGATE", plan.investigate));
  return changed(c.resolveNight());
}

/** Fast-forward through discussion + voting with one recorded vote per voter. */
function performVoting(c: NarratorController, vote: (voterId: PlayerId) => PlayerId): NarratorView {
  let view = c.getView();
  for (let guard = 0; guard < 10; guard++) {
    if (view.kind === "VOTE_RESULT" || view.kind === "GAME_OVER") return view;
    const voting = requireKind(view, "VOTING");
    const voter = voting.votersLeft[0];
    if (voter === undefined) throw new Error("no voters left but round not ended");
    changed(c.recordVote(voter.id, vote(voter.id)));
    view = c.getView();
  }
  throw new Error("voting did not finish");
}

// ---------------------------------------------------------------------------
// 1. Lobby & start
// ---------------------------------------------------------------------------

describe("1. lobby & start", () => {
  test("the narrator builds the roster and the reveal shows every role", () => {
    const c = makeController();
    addPlayers(c, NAMES);
    const lobby = requireKind(c.getView(), "LOBBY");
    expect(lobby.players.map((p) => p.name)).toEqual(NAMES);
    expect(lobby.canStart).toBe(true);

    changed(c.startGame());
    const roles = revealedRoles(c);
    expect(Object.keys(roles).length).toBe(4);
    // Each player is dealt exactly one role; the special roles always exist.
    expect(new Set(Object.values(roles)).has("MAFIA")).toBe(true);
    expect(new Set(Object.values(roles)).has("DOCTOR")).toBe(true);
    expect(new Set(Object.values(roles)).has("DETECTIVE")).toBe(true);
  });

  test("duplicate names are rejected and removal leaves a valid lobby", () => {
    const c = makeController();
    addPlayers(c, NAMES);
    const lobby = requireKind(c.getView(), "LOBBY");
    const bob = lobby.players.find((p) => p.name === "Bob");
    expect(bob).toBeDefined();

    const dup = c.addPlayer("Bob");
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error.code).toBe("NAME_TAKEN");

    changed(c.removePlayer(bob!.id));
    const after = requireKind(c.getView(), "LOBBY");
    expect(after.players.map((p) => p.name)).toEqual(["Ada", "Cam", "Dea"]);
    expect(after.canStart).toBe(false);
  });

  test("startGame validates the roster and the phase", () => {
    const c = makeController();
    addPlayers(c, ["Ada", "Bob", "Cam"]);
    const tooFew = c.startGame();
    expect(tooFew.ok).toBe(false);
    if (!tooFew.ok) expect(tooFew.error.code).toBe("NOT_ENOUGH_PLAYERS");

    addPlayers(c, ["Dea"]);
    changed(c.startGame());
    const again = c.startGame();
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe("INVALID_STEP");
  });
});

// ---------------------------------------------------------------------------
// 2. Role reveal → first night
// ---------------------------------------------------------------------------

describe("2. role reveal & begin night", () => {
  test("beginNight moves reveal to night with the acting Mafia", () => {
    const c = makeController();
    const roles = openGame(c);
    changed(c.beginNight());
    const night = requireKind(c.getView(), "NIGHT");
    expect(night.nightNumber).toBe(1);
    expect(NAMES).toContain(night.actingMafiaName);
    expect(night.kill.status).toBe("NOT_ACTED");
    expect(night.save.status).toBe("NOT_ACTED");
    expect(night.investigate.status).toBe("NOT_ACTED");
    expect(Object.values(roles)).toContain("MAFIA");
  });

  test("beginNight outside role reveal is rejected", () => {
    const c = makeController();
    const result = c.beginNight();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_STEP");
  });
});

// ---------------------------------------------------------------------------
// 3. Night actions & resolution
// ---------------------------------------------------------------------------

describe("3. night actions & resolution", () => {
  test("the narrator records kill, save/pass, and investigation", () => {
    const c = makeController();
    const roles = openGame(c);
    changed(c.beginNight());

    changed(c.recordNightAction("MAFIA_KILL", idOf(roles, "VILLAGER")));
    const afterKill = requireKind(c.getView(), "NIGHT");
    expect(afterKill.kill.status).toBe("SUBMITTED");
    expect(afterKill.kill.targetId).toBe(idOf(roles, "VILLAGER"));

    changed(c.recordNightAction("DOCTOR_SAVE", null)); // deliberate pass
    const afterPass = requireKind(c.getView(), "NIGHT");
    expect(afterPass.save.status).toBe("PASSED");

    changed(c.recordNightAction("DETECTIVE_INVESTIGATE", idOf(roles, "MAFIA")));
    const afterInvestigate = requireKind(c.getView(), "NIGHT");
    expect(afterInvestigate.investigate.status).toBe("SUBMITTED");
  });

  test("recording a night action outside the night is rejected", () => {
    const c = makeController();
    addPlayers(c, NAMES);
    changed(c.startGame()); // ROLE_REVEAL
    const result = c.recordNightAction("MAFIA_KILL", "p1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_STEP");
  });

  test("resolving without the kill is rejected", () => {
    const c = makeController();
    openGame(c);
    changed(c.beginNight());
    changed(c.recordNightAction("DOCTOR_SAVE", null));
    const result = c.resolveNight();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("MISSING_REQUIRED_ACTION");
  });

  test("dead targets, self-kills and unknown targets are rejected", () => {
    const c = makeController();
    const roles = openGame(c);
    const mafia = idOf(roles, "MAFIA");
    changed(c.beginNight());

    const ghost = c.recordNightAction("MAFIA_KILL", "ghost");
    expect(ghost.ok).toBe(false);
    if (!ghost.ok) expect(ghost.error.code).toBe("PLAYER_NOT_FOUND");

    const selfKill = c.recordNightAction("MAFIA_KILL", mafia);
    expect(selfKill.ok).toBe(false);
    if (!selfKill.ok) expect(selfKill.error.code).toBe("INVALID_TARGET");

    // A valid kill resolves; a later kill of the now-dead player is rejected.
    const villager = idOf(roles, "VILLAGER");
    changed(c.recordNightAction("MAFIA_KILL", villager));
    changed(c.recordNightAction("DOCTOR_SAVE", null));
    changed(c.recordNightAction("DETECTIVE_INVESTIGATE", mafia));
    changed(c.resolveNight());
    changed(c.advancePhase()); // MORNING → DISCUSSION
    changed(c.advancePhase()); // DISCUSSION → VOTING
    changed(c.advancePhase()); // VOTING → VOTE_RESULT (sealed, nobody voted)
    changed(c.advancePhase()); // VOTE_RESULT → NIGHT 2
    requireKind(c.getView(), "NIGHT");

    const revive = c.recordNightAction("MAFIA_KILL", villager);
    expect(revive.ok).toBe(false);
    if (!revive.ok) expect(revive.error.code).toBe("INVALID_TARGET");
  });

  test("recording a role with no living holder is rejected", () => {
    const c = makeController();
    const roles = openGame(c);
    const doctor = idOf(roles, "DOCTOR");
    changed(c.beginNight());
    // The Mafia kills the Doctor tonight.
    changed(c.recordNightAction("MAFIA_KILL", doctor));
    changed(c.recordNightAction("DOCTOR_SAVE", null));
    changed(c.recordNightAction("DETECTIVE_INVESTIGATE", idOf(roles, "MAFIA")));
    changed(c.resolveNight());

    changed(c.advancePhase()); // MORNING → DISCUSSION
    changed(c.advancePhase()); // DISCUSSION → VOTING
    changed(c.advancePhase()); // VOTING → VOTE_RESULT
    changed(c.advancePhase()); // VOTE_RESULT → NIGHT 2
    requireKind(c.getView(), "NIGHT");

    const noDoctor = c.recordNightAction("DOCTOR_SAVE", null);
    expect(noDoctor.ok).toBe(false);
    if (!noDoctor.ok) expect(noDoctor.error.code).toBe("INVALID_ACTOR");
  });

  test("a night resolves to morning with deaths and the detective's verdict", () => {
    const c = makeController(11);
    const roles = openGame(c);
    const mafia = idOf(roles, "MAFIA");
    const villager = idOf(roles, "VILLAGER");
    changed(c.beginNight());

    const morning = requireKind(performNight(c, { kill: villager, save: null, investigate: mafia }), "MORNING");
    expect(morning.nightNumber).toBe(1);
    expect(morning.deaths.map((p) => p.id)).toEqual([villager]);
    const mafiaName = morning.players.find((p) => p.id === mafia)!.name;
    expect(morning.investigation).toEqual({
      nightNumber: 1,
      targetId: mafia,
      targetName: mafiaName,
      isMafia: true,
    });
  });

  test("a doctor save blocks the kill", () => {
    const c = makeController();
    const roles = openGame(c);
    const villager = idOf(roles, "VILLAGER");
    changed(c.beginNight());

    const morning = requireKind(performNight(c, { kill: villager, save: villager, investigate: idOf(roles, "MAFIA") }), "MORNING");
    expect(morning.deaths).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Day & recorded voting
// ---------------------------------------------------------------------------

describe("4. day & recorded voting", () => {
  function toVoting(c: NarratorController): void {
    changed(c.startDiscussion());
    changed(c.startVoting());
    requireKind(c.getView(), "VOTING");
  }

  test("discussion and voting only start from their phase", () => {
    const c = makeController();
    const roles = openGame(c);
    changed(c.beginNight());
    performNight(c, { kill: idOf(roles, "VILLAGER"), save: null, investigate: idOf(roles, "MAFIA") });

    // Still in MORNING: cannot skip straight to voting.
    const earlyVote = c.startVoting();
    expect(earlyVote.ok).toBe(false);
    if (!earlyVote.ok) expect(earlyVote.error.code).toBe("INVALID_STEP");

    changed(c.startDiscussion());
    // In DISCUSSION: discussion again is wrong, voting is right.
    const reDiscussion = c.startDiscussion();
    expect(reDiscussion.ok).toBe(false);
    if (!reDiscussion.ok) expect(reDiscussion.error.code).toBe("INVALID_STEP");
    changed(c.startVoting());
  });

  test("recorded spoken votes fill the tally and the last one ends the round", () => {
    const c = makeController();
    const roles = openGame(c);
    const mafia = idOf(roles, "MAFIA");
    const doctor = idOf(roles, "DOCTOR");
    const detective = idOf(roles, "DETECTIVE");
    changed(c.beginNight());
    performNight(c, { kill: idOf(roles, "VILLAGER"), save: null, investigate: mafia });
    toVoting(c);

    let view = requireKind(c.getView(), "VOTING");
    expect(view.casts).toBe(0);
    expect(view.total).toBe(3);
    const voters = [mafia, doctor, detective];
    expect(view.votersLeft).toHaveLength(3);
    expect(view.votersLeft.map((p) => p.id).sort()).toEqual([...voters].sort());

    changed(c.recordVote(mafia, doctor));
    view = requireKind(c.getView(), "VOTING");
    expect(view.votes).toHaveLength(1);
    expect(view.votes[0]).toMatchObject({ voterId: mafia, targetId: doctor });

    changed(c.recordVote(doctor, mafia));
    // Final vote (all living have now voted): the engine auto-ends the round.
    // Lynching the last Mafia ends the game outright (engine spec §8.3).
    const end = requireKind(changed(c.recordVote(detective, mafia)), "GAME_OVER");
    expect(end.winner).toBe("TOWN");
    expect(end.players.find((p) => p.id === mafia)?.alive).toBe(false);
  });

  test("dead voters, unknown voters and duplicate votes are rejected", () => {
    const c = makeController();
    const roles = openGame(c);
    const mafia = idOf(roles, "MAFIA");
    const doctor = idOf(roles, "DOCTOR");
    const villager = idOf(roles, "VILLAGER");
    changed(c.beginNight());
    performNight(c, { kill: villager, save: null, investigate: mafia });
    toVoting(c);

    const deadVote = c.recordVote(villager, mafia);
    expect(deadVote.ok).toBe(false);
    if (!deadVote.ok) expect(deadVote.error.code).toBe("PLAYER_DEAD");

    const ghostVote = c.recordVote("ghost", mafia);
    expect(ghostVote.ok).toBe(false);
    if (!ghostVote.ok) expect(ghostVote.error.code).toBe("PLAYER_NOT_FOUND");

    changed(c.recordVote(doctor, mafia));
    const duplicate = c.recordVote(doctor, mafia);
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.code).toBe("ACTION_ALREADY_SUBMITTED");
  });

  test("a tie produces no elimination", () => {
    const c = makeController();
    const roles = openGame(c);
    const mafia = idOf(roles, "MAFIA");
    const doctor = idOf(roles, "DOCTOR");
    const detective = idOf(roles, "DETECTIVE");
    changed(c.beginNight());
    performNight(c, { kill: idOf(roles, "VILLAGER"), save: null, investigate: mafia });
    toVoting(c);

    const result = requireKind(
      performVoting(c, (voterId) => (voterId === mafia ? doctor : voterId === doctor ? detective : mafia)),
      "VOTE_RESULT",
    );
    expect(result.tie).toBe(true);
    expect(result.eliminatedPlayer).toBeNull();
  });

  test("endVoting seals a partial round", () => {
    const c = makeController();
    const roles = openGame(c);
    changed(c.beginNight());
    performNight(c, { kill: idOf(roles, "VILLAGER"), save: null, investigate: idOf(roles, "MAFIA") });
    toVoting(c);

    const result = requireKind(changed(c.endVoting()), "VOTE_RESULT");
    expect(result.tie).toBe(false);
    expect(result.eliminatedPlayer).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. Full narrated games reach GAME_OVER
// ---------------------------------------------------------------------------

describe("5. full narrated games reach GAME_OVER", () => {
  test("loyal town: night kill + unanimous lynch ends with TOWN and full reveal", () => {
    const c = makeController(11);
    const roles = openGame(c);
    const mafia = idOf(roles, "MAFIA");
    const doctor = idOf(roles, "DOCTOR");
    const villager = idOf(roles, "VILLAGER");
    changed(c.beginNight());
    performNight(c, { kill: villager, save: null, investigate: mafia });
    changed(c.startDiscussion());
    changed(c.startVoting());

    const end = requireKind(
      performVoting(c, (voterId) => (voterId === mafia ? doctor : mafia)),
      "GAME_OVER",
    );
    expect(end.winner).toBe("TOWN");

    const alive = new Map(end.players.map((p) => [p.id, p.alive] as const));
    expect(alive.get(mafia)).toBe(false);
    expect(alive.get(villager)).toBe(false);
    expect(alive.get(doctor)).toBe(true);
    // The full role assignment is public at game over (engine spec §8.5).
    const reveal = new Map(end.players.map((p) => [p.id, p.role] as const));
    expect(reveal.get(mafia)).toBe("MAFIA");
    expect(reveal.get(villager)).toBe("VILLAGER");
  });

  test("the Mafia wins via two night kills through a tied day", () => {
    const c = makeController(23);
    const roles = openGame(c);
    const mafia = idOf(roles, "MAFIA");
    const doctor = idOf(roles, "DOCTOR");
    const detective = idOf(roles, "DETECTIVE");
    const villager = idOf(roles, "VILLAGER");
    changed(c.beginNight());

    // Night 1: the villager dies.
    const morning1 = requireKind(performNight(c, { kill: villager, save: null, investigate: mafia }), "MORNING");
    expect(morning1.deaths.map((p) => p.id)).toEqual([villager]);
    expect(morning1.investigation?.isMafia).toBe(true);

    // Day 1 ends in a three-way tie: nobody is eliminated.
    changed(c.startDiscussion());
    changed(c.startVoting());
    const tied = requireKind(
      performVoting(c, (voterId) => (voterId === mafia ? doctor : voterId === doctor ? detective : mafia)),
      "VOTE_RESULT",
    );
    expect(tied.tie).toBe(true);

    // The narrator drives the next night.
    changed(c.advancePhase());
    const night2 = requireKind(c.getView(), "NIGHT");
    expect(night2.nightNumber).toBe(2);

    // Night 2: the detective dies; Mafia >= the remaining Town -> MAFIA wins.
    const end = requireKind(
      performNight(c, { kill: detective, save: null, investigate: mafia }),
      "GAME_OVER",
    );
    expect(end.winner).toBe("MAFIA");
    const alive = new Map(end.players.map((p) => [p.id, p.alive] as const));
    expect(alive.get(mafia)).toBe(true);
    expect(alive.get(doctor)).toBe(true);
    expect(alive.get(detective)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Replay & reset
// ---------------------------------------------------------------------------

describe("6. replay & reset", () => {
  test("playAgain keeps the roster and a second full game plays out", () => {
    const c = makeController(9);
    const roles1 = openGame(c);
    changed(c.beginNight());
    performNight(c, { kill: idOf(roles1, "VILLAGER"), save: null, investigate: idOf(roles1, "MAFIA") });
    changed(c.startDiscussion());
    changed(c.startVoting());
    const mafia1 = idOf(roles1, "MAFIA");
    performVoting(c, (voterId) => (voterId === mafia1 ? idOf(roles1, "DOCTOR") : mafia1));
    requireKind(c.getView(), "GAME_OVER");

    const lobby = requireKind(changed(c.playAgain()), "LOBBY");
    expect(lobby.players.map((p) => p.name)).toEqual(NAMES);
    expect(lobby.players.every((p) => p.ready === false)).toBe(true);
    expect(lobby.canStart).toBe(true);

    // A second full narrated game completes on the same roster.
    changed(c.startGame());
    const roles2 = revealedRoles(c);
    const mafia2 = idOf(roles2, "MAFIA");
    changed(c.beginNight());
    performNight(c, { kill: idOf(roles2, "VILLAGER"), save: null, investigate: mafia2 });
    changed(c.startDiscussion());
    changed(c.startVoting());
    const end = requireKind(
      performVoting(c, (voterId) => (voterId === mafia2 ? idOf(roles2, "DOCTOR") : mafia2)),
      "GAME_OVER",
    );
    expect(end.winner).toBe("TOWN");
  });

  test("resetGame returns to an empty lobby", () => {
    const c = makeController();
    openGame(c);
    const lobby = requireKind(c.resetGame(), "LOBBY");
    expect(lobby.players).toEqual([]);
    expect(lobby.canStart).toBe(false);
  });
});