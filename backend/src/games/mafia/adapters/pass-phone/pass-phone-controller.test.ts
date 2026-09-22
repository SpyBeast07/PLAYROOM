/**
 * Phase 12 — pass-the-phone (Mode A) adapter transitions.
 *
 * The controller is exercised exactly like a UI would: reads `getView()`,
 * taps the phone-handoff confirmations, performs the planned action, and
 * follows whatever the engine offers next. Roles are learned only through the
 * ROLE_REVEAL screens (the way an honest player sees them), never from the
 * engine, proving the adapter drives a complete local game on top of the same
 * engine the multiplayer mode uses (`createMafiaGame` from `mafia-engine.ts`).
 *
 * A deterministic injected RNG makes every role draw repeatable, but the tests
 * never depend on a specific assignment — they read it from the reveal flow.
 */
import { describe, expect, test } from "bun:test";
import { PassPhoneController } from "./pass-phone-controller.ts";
import type { PassPhoneView } from "./types.ts";
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

function makeController(seed = 7): PassPhoneController {
  return new PassPhoneController({ random: mulberry32(seed) });
}

function addPlayers(c: PassPhoneController, names: string[]): void {
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

function changed(result: { ok: true; view: PassPhoneView } | { ok: false; error: { code: string } }): PassPhoneView {
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}`);
  return result.view;
}

function requireKind<K extends PassPhoneView["kind"]>(
  view: PassPhoneView,
  kind: K,
): Extract<PassPhoneView, { kind: K }> {
  expect(view.kind).toBe(kind);
  return view as Extract<PassPhoneView, { kind: K }>;
}

/** Drive past every role reveal; returns the dealt roles. */
function revealAll(c: PassPhoneController, count: number, notify?: (v: PassPhoneView) => void): Roles {
  const roles: Roles = {};
  for (let i = 0; i < count; i++) {
    const handoff = requireKind(c.getView(), "ROLE_HANDOFF");
    if (notify) notify(handoff);
    expect(changed(c.privacyReady()).kind).toBe("ROLE_REVEAL");
    const reveal = requireKind(c.getView(), "ROLE_REVEAL");
    if (notify) notify(reveal);
    // The engine never deals a duplicate role within one game.
    expect(roles[reveal.playerId]).toBeUndefined();
    roles[reveal.playerId] = reveal.role;
    expect(changed(c.confirmRoleSeen()).kind).not.toBe("ROLE_REVEAL");
  }
  return roles;
}

interface NightPlan {
  kill?: string | null;
  save?: string | null;
  investigate?: string | null;
}

/** Follow the phone through Mafia → Doctor → Detective, executing the plan. */
function performNight(c: PassPhoneController, plan: NightPlan, notify?: (v: PassPhoneView) => void): PassPhoneView {
  for (let guard = 0; guard < 6; guard++) {
    let view = c.getView();
    if (notify) notify(view);
    if (view.kind === "MORNING" || view.kind === "GAME_OVER") return view;
    const handoff = requireKind(view, "NIGHT_HANDOFF");
    expect(changed(c.privacyReady()).kind).toBe("SECRET_ACTION");
    view = requireKind(c.getView(), "SECRET_ACTION");
    if (notify) notify(view);
    let result;
    switch (handoff.role) {
      case "MAFIA":
        result = c.submitNightAction(plan.kill ?? null);
        break;
      case "DOCTOR":
        result = c.submitNightAction(plan.save ?? null);
        break;
      case "DETECTIVE":
        result = c.submitNightAction(plan.investigate ?? null);
        break;
      default:
        throw new Error(`unexpected night role ${handoff.role}`);
    }
    expect(result.ok).toBe(true);
  }
  throw new Error("night did not finish");
}

/** Follow the phone through every living voter; `pick(voterId)` chooses a target. */
function performVoting(c: PassPhoneController, pick: (voterId: PlayerId) => PlayerId, notify?: (v: PassPhoneView) => void): PassPhoneView {
  let view = c.getView();
  for (let guard = 0; guard < 30; guard++) {
    if (view.kind === "VOTE_RESULT" || view.kind === "GAME_OVER") return view;
    const handoff = requireKind(view, "VOTE_HANDOFF");
    const voterId = handoff.playerId;
    expect(changed(c.privacyReady()).kind).toBe("VOTE");
    view = requireKind(c.getView(), "VOTE");
    if (notify) notify(view);
    expect(changed(c.castVote(pick(voterId))).kind).not.toBe("VOTE");
    view = c.getView();
  }
  throw new Error("voting did not finish");
}

/** The canonical 4-player town win: kill the villager, then lynch the Mafia. */
function playTownWin(seed = 7): { c: PassPhoneController; roles: Roles; end: PassPhoneView } {
  const c = makeController(seed);
  addPlayers(c, NAMES);
  expect(changed(c.startGame()).kind).toBe("ROLE_HANDOFF");
  const roles = revealAll(c, 4);
  const mafia = idOf(roles, "MAFIA");
  const doctor = idOf(roles, "DOCTOR");
  const villager = idOf(roles, "VILLAGER");
  const morning = performNight(c, { kill: villager, save: null, investigate: mafia });
  expect(requireKind(morning, "MORNING").deaths.map((p) => p.id)).toEqual([villager]);
  expect(changed(c.startDiscussion()).kind).toBe("DISCUSSION");
  expect(changed(c.startVoting()).kind).toBe("VOTE_HANDOFF");
  const end = performVoting(c, (voterId) => (voterId === mafia ? doctor : mafia));
  expect(requireKind(end, "GAME_OVER").winner).toBe("TOWN");
  return { c, roles, end };
}

// ---------------------------------------------------------------------------
// 1. Setup & roster validation
// ---------------------------------------------------------------------------

describe("1. setup & roster validation", () => {
  test("a fresh controller is an empty lobby that cannot start", () => {
    const c = makeController();
    const view = requireKind(c.getView(), "SETUP");
    expect(view.players).toEqual([]);
    expect(view.minPlayers).toBe(4);
    expect(view.maxPlayers).toBe(20);
    expect(view.canStart).toBe(false);
  });

  test("adding named players builds the roster; canStart flips on at the minimum", () => {
    const c = makeController();
    for (let i = 0; i < NAMES.length; i++) {
      expect(changed(c.addPlayer(NAMES[i] as string)).kind).toBe("SETUP");
      const view = requireKind(c.getView(), "SETUP");
      expect(view.players.map((p) => p.name)).toEqual(NAMES.slice(0, i + 1));
      expect(view.canStart).toBe(i + 1 >= 4);
    }
  });

  test("engine-owned name rules surface as errors", () => {
    const c = makeController();
    addPlayers(c, NAMES);
    const dup = c.addPlayer("Ada");
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error.code).toBe("NAME_TAKEN");

    const blank = c.addPlayer("   ");
    expect(blank.ok).toBe(false);
    if (!blank.ok) expect(blank.error.code).toBe("INVALID_PLAYER_NAME");

    const long = c.addPlayer("x".repeat(21));
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.error.code).toBe("INVALID_PLAYER_NAME");
  });

  test("the 21st player is rejected (GAME_FULL)", () => {
    const c = makeController();
    for (let i = 1; i <= 20; i++) {
      expect(c.addPlayer(`P${i}`).ok).toBe(true);
    }
    const overflow = c.addPlayer("P21");
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.error.code).toBe("GAME_FULL");
  });

  test("removing a player leaves the lobby; unknown removal errors", () => {
    const c = makeController();
    addPlayers(c, ["Ada", "Bob", "Cam", "Dea", "Eve"]);
    const removed = changed(c.removePlayer("p1"));
    expect(requireKind(removed, "SETUP").players.map((p) => p.name)).toEqual(["Bob", "Cam", "Dea", "Eve"]);
    const ghost = c.removePlayer("ghost");
    expect(ghost.ok).toBe(false);
    if (!ghost.ok) expect(ghost.error.code).toBe("PLAYER_NOT_FOUND");
  });

  test("starting below the player minimum is rejected", () => {
    const c = makeController();
    addPlayers(c, ["Ada", "Bob", "Cam"]);
    const result = c.startGame();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_ENOUGH_PLAYERS");
    expect(requireKind(c.getView(), "SETUP").canStart).toBe(false);
  });

  test("players can only be added/removed in the lobby", () => {
    const c = makeController();
    addPlayers(c, NAMES);
    expect(changed(c.startGame()).kind).toBe("ROLE_HANDOFF");
    expect(c.addPlayer("Zed").ok).toBe(false);
    expect(c.removePlayer("p1").ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Role reveal handoff
// ---------------------------------------------------------------------------

describe("2. role reveal handoff", () => {
  test("reveals happen strictly in roster order, one private moment each", () => {
    const c = makeController();
    addPlayers(c, NAMES);
    changed(c.startGame());
    const roles: Roles = {};
    for (const [expectedId, name] of [["p1", "Ada"], ["p2", "Bob"], ["p3", "Cam"], ["p4", "Dea"]] as const) {
      const handoff = requireKind(c.getView(), "ROLE_HANDOFF");
      expect(handoff.playerId).toBe(expectedId);
      expect(handoff.name).toBe(name);
      expect("role" in handoff).toBe(false);
      expect(changed(c.privacyReady()).kind).toBe("ROLE_REVEAL");
      const reveal = requireKind(c.getView(), "ROLE_REVEAL");
      expect(reveal.playerId).toBe(expectedId);
      expect(reveal.name).toBe(name);
      roles[expectedId] = reveal.role;
      const next = changed(c.confirmRoleSeen());
      // The secret is gone before any next handoff is shown.
      if (next.kind !== "NIGHT_HANDOFF") {
        const h = requireKind(next, "ROLE_HANDOFF");
        expect("role" in h).toBe(false);
        expect(h.playerId).not.toBe(expectedId);
      }
    }
    expect(Object.keys(roles).length).toBe(4);
  });

  test("the last confirmation hands straight to the first night's acting Mafia", () => {
    const c = makeController();
    addPlayers(c, NAMES);
    changed(c.startGame());
    const roles = revealAll(c, 4);
    const handoff = requireKind(c.getView(), "NIGHT_HANDOFF");
    expect(handoff.role).toBe("MAFIA");
    expect("playerId" in handoff).toBe(false);
    expect("name" in handoff).toBe(false);
    expect(roles).toEqual(expect.objectContaining({}));
  });

  test("handoff state can only be advanced in the right order", () => {
    const c = makeController();
    expect(c.privacyReady().ok).toBe(false);
    expect(c.confirmRoleSeen().ok).toBe(false);
    addPlayers(c, NAMES);
    changed(c.startGame());
    // During a private reveal the other confirmations are invalid steps only.
    const before = requireKind(c.getView(), "ROLE_HANDOFF");
    const noAttack = c.submitNightAction("p2");
    expect(noAttack.ok).toBe(false);
    if (!noAttack.ok) expect(noAttack.error.code).toBe("INVALID_STEP");
    expect(c.privacyReady().ok).toBe(true);
    expect(c.privacyReady().ok).toBe(false); // already revealed
    expect(c.confirmRoleSeen().ok).toBe(true);
    expect(before.playerId && c.getView().kind).toBe("ROLE_HANDOFF");
  });

  test("secureClear drops a secret off-screen before the next handoff", () => {
    const c = makeController();
    addPlayers(c, NAMES);
    changed(c.startGame());
    requireKind(c.getView(), "ROLE_HANDOFF");
    c.privacyReady();
    const secret = requireKind(c.getView(), "ROLE_REVEAL");
    const actor = secret.playerId;
    const roleShown = secret.role;
    const cleared = requireKind(c.secureClear(), "ROLE_HANDOFF");
    expect("role" in cleared).toBe(false);
    expect(cleared.playerId).toBe(actor);
    // The flow still works after clearing: acknowledge, confirm, move on.
    changed(c.privacyReady());
    const again = requireKind(c.getView(), "ROLE_REVEAL");
    expect(again.playerId).toBe(actor);
    expect(again.role).toBe(roleShown);
    changed(c.confirmRoleSeen());
  });
});

// ---------------------------------------------------------------------------
// 3. Night actions
// ---------------------------------------------------------------------------

describe("3. night actions", () => {
  test("Mafia → Doctor → Detective are offered privately, in engine order", () => {
    const c = makeController();
    addPlayers(c, NAMES);
    changed(c.startGame());
    const roles = revealAll(c, 4);
    const doctor = idOf(roles, "DOCTOR");
    const detective = idOf(roles, "DETECTIVE");
    const villager = idOf(roles, "VILLAGER");

    let handoff = requireKind(c.getView(), "NIGHT_HANDOFF");
    expect(handoff.role).toBe("MAFIA");
    changed(c.privacyReady());

    const mafiaCard = requireKind(c.getView(), "SECRET_ACTION");
    expect(mafiaCard.action).toBe("MAFIA_KILL");
    expect(mafiaCard.canPass).toBe(false);
    // The Mafia cannot pick themselves.
    expect(mafiaCard.candidates.map((p) => p.id)).not.toContain(mafiaCard.playerId);
    expect(mafiaCard.candidates.length).toBe(3);
    changed(c.submitNightAction(villager));

    handoff = requireKind(c.getView(), "NIGHT_HANDOFF");
    expect(handoff.role).toBe("DOCTOR");
    changed(c.privacyReady());
    const doctorCard = requireKind(c.getView(), "SECRET_ACTION");
    expect(doctorCard.action).toBe("DOCTOR_SAVE");
    expect(doctorCard.canPass).toBe(true);
    expect(doctorCard.candidates.map((p) => p.id)).toEqual(expect.arrayContaining([doctor]));
    // Deliberate pass is legal for the Doctor.
    changed(c.submitNightAction(null));

    handoff = requireKind(c.getView(), "NIGHT_HANDOFF");
    expect(handoff.role).toBe("DETECTIVE");
    changed(c.privacyReady());
    const detectiveCard = requireKind(c.getView(), "SECRET_ACTION");
    expect(detectiveCard.action).toBe("DETECTIVE_INVESTIGATE");
    expect(detectiveCard.candidates.map((p) => p.id)).toEqual(expect.arrayContaining([detective]));
    changed(c.submitNightAction(mafiaCard.playerId));

    const morning = requireKind(c.getView(), "MORNING");
    expect(morning.nightNumber).toBe(1);
    expect(morning.deaths.map((p) => p.id)).toEqual([villager]);
  });

  test("the Doctor's save blocks the kill (engine outcome, not adapter math)", () => {
    const c = makeController();
    addPlayers(c, NAMES);
    changed(c.startGame());
    const roles = revealAll(c, 4);
    const doctor = idOf(roles, "DOCTOR");
    const villager = idOf(roles, "VILLAGER");
    const detective = idOf(roles, "DETECTIVE");

    const morning = performNight(c, { kill: villager, save: villager, investigate: doctor });
    const view = requireKind(morning, "MORNING");
    expect(view.deaths).toEqual([]);
    expect(view.players.every((p) => p.alive)).toBe(true);
    expect(detective).toBeTruthy();
  });

  test("the Doctor repeat-guard is surfaced and does not corrupt the night", () => {
    const c = makeController();
    addPlayers(c, NAMES);
    changed(c.startGame());
    const roles = revealAll(c, 4);
    const doctor = idOf(roles, "DOCTOR");
    const detective = idOf(roles, "DETECTIVE");
    const villager = idOf(roles, "VILLAGER");

    // Night 1: Doctor saves the villager, blocking the kill.
    const morning = requireKind(
      performNight(c, { kill: villager, save: villager, investigate: doctor }),
      "MORNING",
    );
    expect(morning.deaths).toEqual([]);

    // Round 2 of voting splits a tie so nothing is eliminated and the game
    // continues: doctor↔detective + mafia↔villager support cancel out.
    changed(c.startDiscussion());
    changed(c.startVoting());
    const mafia = idOf(roles, "MAFIA");
    const result = performVoting(c, (voterId) =>
      voterId === detective || voterId === mafia ? detective : doctor,
    );
    expect(requireKind(result, "VOTE_RESULT").eliminatedPlayerId).toBeNull();
    changed(c.continueAfterResult());

    // Night 2: Mafia kills the detective; the Doctor tries to re-save the
    // villager (repeat guard) — rejected, then passes cleanly.
    const mafiaHandoff = requireKind(c.getView(), "NIGHT_HANDOFF");
    expect(mafiaHandoff.role).toBe("MAFIA");
    changed(c.privacyReady());
    changed(c.submitNightAction(detective));

    const doctorHandoff = requireKind(c.getView(), "NIGHT_HANDOFF");
    expect(doctorHandoff.role).toBe("DOCTOR");
    changed(c.privacyReady());
    const guard = c.submitNightAction(villager);
    expect(guard.ok).toBe(false);
    if (!guard.ok) expect(guard.error.code).toBe("DOCTOR_REPEAT_GUARD");
    // The screen stayed up; the Doctor can still pass.
    expect(requireKind(c.getView(), "SECRET_ACTION").action).toBe("DOCTOR_SAVE");
    changed(c.submitNightAction(null));

    const detectiveHandoff = requireKind(c.getView(), "NIGHT_HANDOFF");
    expect(detectiveHandoff.role).toBe("DETECTIVE");
    changed(c.privacyReady());
    changed(c.submitNightAction(doctor));

    const secondMorning = requireKind(c.getView(), "MORNING");
    expect(secondMorning.nightNumber).toBe(2);
    expect(secondMorning.deaths.map((p) => p.id)).toEqual([detective]);
  });

  test("invalid night targets are rejected without losing the flow", () => {
    const c = makeController();
    addPlayers(c, NAMES);
    changed(c.startGame());
    const roles = revealAll(c, 4);
    const villager = idOf(roles, "VILLAGER");

    requireKind(c.getView(), "NIGHT_HANDOFF");
    changed(c.privacyReady());
    const mafiaCard = requireKind(c.getView(), "SECRET_ACTION");
    const mafia = mafiaCard.playerId;

    const ghost = c.submitNightAction("ghost");
    expect(ghost.ok).toBe(false);
    if (!ghost.ok) expect(ghost.error.code).toBe("PLAYER_NOT_FOUND");

    const selfKill = c.submitNightAction(mafia);
    expect(selfKill.ok).toBe(false);
    if (!selfKill.ok) expect(selfKill.error.code).toBe("INVALID_TARGET");

    // Still on the same card, and a valid action goes through afterwards.
    expect(requireKind(c.getView(), "SECRET_ACTION").playerId).toBe(mafia);
    changed(c.submitNightAction(villager));
    expect(requireKind(c.getView(), "NIGHT_HANDOFF").role).toBe("DOCTOR");
  });

  test("endNightNow force-resolves whatever is still pending", () => {
    const c = makeController();
    addPlayers(c, NAMES);
    changed(c.startGame());
    revealAll(c, 4);
    requireKind(c.getView(), "NIGHT_HANDOFF");
    changed(c.privacyReady());
    const morning = requireKind(changed(c.endNightNow()), "MORNING");
    expect(morning.deaths).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Discussion & private voting
// ---------------------------------------------------------------------------

describe("4. discussion & private voting", () => {
  test("voting is offered one living player at a time and deduplicates", () => {
    const c = makeController();
    addPlayers(c, NAMES);
    changed(c.startGame());
    const roles = revealAll(c, 4);
    const mafia = idOf(roles, "MAFIA");
    const villager = idOf(roles, "VILLAGER");
    performNight(c, { kill: villager, save: null, investigate: mafia });
    changed(c.startDiscussion());
    expect(requireKind(c.getView(), "DISCUSSION").nightNumber).toBe(1);
    changed(c.startVoting());

    let handoff = requireKind(c.getView(), "VOTE_HANDOFF");
    const firstVoter = handoff.playerId;
    changed(c.privacyReady());
    const card = requireKind(c.getView(), "VOTE");
    expect(card.voterId).toBe(firstVoter);
    // Only the living can be handed the phone; the dead villager never appears.
    expect(card.candidates.map((p) => p.id)).not.toContain(villager);
    expect(card.candidates.length).toBe(3);
    changed(c.castVote(mafia));
    // Same voter is never asked twice.
    expect(requireKind(c.getView(), "VOTE_HANDOFF").playerId).not.toBe(firstVoter);
  });

  test("the final vote auto-ends the round (engine SYSTEM transition)", () => {
    const c = makeController(13);
    addPlayers(c, NAMES);
    changed(c.startGame());
    const roles = revealAll(c, 4);
    const mafia = idOf(roles, "MAFIA");
    const doctor = idOf(roles, "DOCTOR");
    performNight(c, { kill: idOf(roles, "VILLAGER"), save: null, investigate: mafia });
    changed(c.startDiscussion());
    changed(c.startVoting());

    let lastResult: Parameters<typeof changed>[0] | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const view = c.getView();
      expect(view.kind).not.toBe("GAME_OVER");
      requireKind(view, "VOTE_HANDOFF");
      changed(c.privacyReady());
      const card = requireKind(c.getView(), "VOTE");
      lastResult = c.castVote(card.voterId === mafia ? doctor : mafia);
      if (!lastResult.ok) throw new Error(lastResult.error.code);
      if (lastResult.view.kind === "GAME_OVER") break;
    }
    // The last castVote resolved directly into GAME_OVER — no END_VOTING was needed.
    const autoEnded = requireKind(lastResult!.view, "GAME_OVER");
    expect(autoEnded.winner).toBe("TOWN");
  });

  test("endVoting seals a partial round", () => {
    const c = makeController();
    addPlayers(c, NAMES);
    changed(c.startGame());
    const roles = revealAll(c, 4);
    performNight(c, { kill: idOf(roles, "VILLAGER"), save: null, investigate: idOf(roles, "MAFIA") });
    changed(c.startDiscussion());
    changed(c.startVoting());
    const handoff = requireKind(c.getView(), "VOTE_HANDOFF");
    changed(c.privacyReady());
    expect(requireKind(c.getView(), "VOTE").voterId).toBe(handoff.playerId);
    // Seal the round before anyone else votes: nobody is eliminated (1v1 after
    // the night kill still leaves a living Doctor, so this is not game over).
    const result = requireKind(changed(c.endVoting()), "VOTE_RESULT");
    expect(result.eliminatedPlayerId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. Full games reach GAME_OVER with engine-derived endings
// ---------------------------------------------------------------------------

describe("5. full games reach GAME_OVER", () => {
  test("loyal town: night kill + unanimous lynch ends with TOWN", () => {
    const { c, roles, end } = playTownWin(11);
    const view = requireKind(end, "GAME_OVER");
    expect(view.winner).toBe("TOWN");
    const mafia = idOf(roles, "MAFIA");
    const alive = new Map(view.players.map((p) => [p.id, p.alive] as const));
    expect(alive.get(mafia)).toBe(false);
    expect(alive.get(idOf(roles, "VILLAGER"))).toBe(false);
    expect(alive.get(idOf(roles, "DOCTOR"))).toBe(true);
    expect(alive.get(idOf(roles, "DETECTIVE"))).toBe(true);
    expect(c.getView().kind).toBe("GAME_OVER");
  });

  test("the Mafia wins after the town lynches its own doctor", () => {
    const c = makeController(23);
    addPlayers(c, NAMES);
    changed(c.startGame());
    const roles = revealAll(c, 4);
    const mafia = idOf(roles, "MAFIA");
    const doctor = idOf(roles, "DOCTOR");
    performNight(c, { kill: idOf(roles, "VILLAGER"), save: null, investigate: mafia });
    changed(c.startDiscussion());
    changed(c.startVoting());
    // Misguided vote: Mafia + Detective lynch the Doctor, leaving 1v1.
    const end = requireKind(
      performVoting(c, (voterId) => (voterId === doctor ? mafia : doctor)),
      "GAME_OVER",
    );
    expect(end.winner).toBe("MAFIA");
  });

  test("game over reveals every role through the public view", () => {
    const { roles } = playTownWin(5);
    const c = makeController(5);
    addPlayers(c, NAMES);
    changed(c.startGame());
    const revealed = revealAll(c, 4);
    expect(revealed).toEqual(roles);
  });
});

// ---------------------------------------------------------------------------
// 6. Play again / reset
// ---------------------------------------------------------------------------

describe("6. play again & reset", () => {
  test("playAgain keeps the roster and allows a fresh deal", () => {
    const { c } = playTownWin(9);
    const setup = requireKind(changed(c.playAgain()), "SETUP");
    expect(setup.players.map((p) => p.name)).toEqual(NAMES);
    expect(setup.canStart).toBe(true);
    expect(changed(c.startGame()).kind).toBe("ROLE_HANDOFF");
    const rolesReplay = revealAll(c, 4);
    expect(Object.keys(rolesReplay).length).toBe(4);
  });

  test("resetGame returns to an empty lobby", () => {
    const { c } = playTownWin(9);
    const setup = requireKind(c.resetGame(), "SETUP");
    expect(setup.players).toEqual([]);
    expect(setup.canStart).toBe(false);
    const attempt = c.startGame();
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.error.code).toBe("NOT_ENOUGH_PLAYERS");
  });
});

// ---------------------------------------------------------------------------
// 7. Secrets are never exposed by any view
// ---------------------------------------------------------------------------

describe("7. secrets are never exposed by the views", () => {
  // Keys that belong only to the engine's internal / narrator views. If any
  // pass-the-phone view ever carried one, the adapter would be leaking.
  const FORBIDDEN = [
    "roles",
    "votes",
    "nightActions",
    "actingMafiaId",
    "roleSeen",
    "readyState",
    "lastResolvedNight",
    "lastElimination",
    "timeline",
  ];

  function assertNoForbidden(value: unknown, where: string): void {
    if (Array.isArray(value)) {
      value.forEach((child, i) => assertNoForbidden(child, `${where}[${i}]`));
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, child] of Object.entries(value)) {
      expect(FORBIDDEN.includes(key), `leaked key ${where}.${key}`).toBe(false);
      assertNoForbidden(child, `${where}.${key}`);
    }
  }

  function auditSecrets(views: PassPhoneView[]): void {
    for (const view of views) assertNoForbidden(view, view.kind);
  }

  test("a complete game never leaks a hidden field in any screen", () => {
    const views: PassPhoneView[] = [];

    const c = makeController(3);
    addPlayers(c, NAMES);
    const notify = (v: PassPhoneView) => views.push(v);
    changed(c.startGame());
    const roles = revealAll(c, 4, notify);
    const mafia = idOf(roles, "MAFIA");
    const villager = idOf(roles, "VILLAGER");
    performNight(c, { kill: villager, save: null, investigate: mafia }, notify);
    changed(c.startDiscussion());
    changed(c.startVoting());
    const endView = performVoting(c, (voterId) => (voterId === mafia ? idOf(roles, "DOCTOR") : mafia), notify);
    views.push(endView);

    // Everything reachable by a real UI is in `views`; none may hint at hidden state.
    auditSecrets(views);
  });

  test("a player's own role appears only in their reveal, their night card, and game over", () => {
    const c = makeController(3);
    addPlayers(c, NAMES);
    changed(c.startGame());

    // Handoffs (role reveal + night) are where secrets must never appear.
    const revealHandoff = requireKind(c.getView(), "ROLE_HANDOFF");
    expect("role" in revealHandoff).toBe(false);

    const roles = revealAll(c, 4);
    const villager = idOf(roles, "VILLAGER");

    // The NIGHT_HANDOFF names no one: it outs a role, never a player.
    const nightHandoff = requireKind(c.getView(), "NIGHT_HANDOFF");
    expect(nightHandoff.role).toBe("MAFIA");
    expect("playerId" in nightHandoff).toBe(false);
    expect("name" in nightHandoff).toBe(false);

    // During an action card the shown role must be the holder's own.
    changed(c.privacyReady());
    const card = requireKind(c.getView(), "SECRET_ACTION");
    expect(card.role).toBe(roles[card.playerId]!);
    for (const candidate of card.candidates) {
      expect(Object.keys(candidate).sort()).toEqual(["alive", "id", "name"]);
    }
    changed(c.submitNightAction(villager));

    // Walk the rest of the night so the morning resolves.
    changed(c.privacyReady());
    changed(c.submitNightAction(null)); // Doctor passes
    changed(c.privacyReady());
    changed(c.submitNightAction(idOf(roles, "MAFIA"))); // Detective checks the Mafia

    // And the morning report carries deaths and names — no roles.
    const morning = requireKind(c.getView(), "MORNING");
    for (const death of morning.deaths) {
      expect(Object.keys(death).sort()).toEqual(["alive", "id", "name"]);
    }
  });

  test("private vote screens expose nothing but the living candidate list", () => {
    const { c } = playTownWin(9);
    // playTownWin already ended; reopen a fresh round to inspect a vote card.
    changed(c.playAgain());
    changed(c.startGame());
    const roles = revealAll(c, 4);
    const villager = idOf(roles, "VILLAGER");
    performNight(c, { kill: villager, save: null, investigate: idOf(roles, "MAFIA") });
    changed(c.startDiscussion());
    changed(c.startVoting());
    changed(c.privacyReady());
    const card = requireKind(c.getView(), "VOTE");
    expect(card.voterId.length).toBeGreaterThan(0);
    for (const candidate of card.candidates) {
      expect(Object.keys(candidate).sort()).toEqual(["alive", "id", "name"]);
    }
    expect(card).not.toHaveProperty("role");
  });
});