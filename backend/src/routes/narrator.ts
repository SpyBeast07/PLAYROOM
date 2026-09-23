/**
 * Narrator (Mode C) HTTP surface.
 *
 * Wraps the existing NarratorController (adapters/narrator/narrator-controller.ts)
 * with a minimal REST shape so a single-device narrator UI can drive the whole
 * game. No game logic lives here and nothing new is computed: every endpoint
 * just forwards to the controller, which forwards to the Mafia engine. All
 * responses carry the narrator's current `view` (or the controller's error),
 * so the frontend is purely presentational.
 *
 * The controller is in-memory and single-player by design (one narrator, one
 * device). There is deliberately no room code: nobody else joins in this mode.
 */
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { NarratorController } from "../games/mafia/adapters/narrator/narrator-controller.ts";
import type { NarratorResult, NarratorView } from "../games/mafia/adapters/narrator/types.ts";

export function createNarratorRouter(narrator: NarratorController): Hono {
  const api = new Hono();

  api.get("/", (c) => c.json({ view: narrator.getView() }, 200));

  api.post("/players", async (c) => {
    const name = await readStringField(c.req, "name");
    if (name === undefined) return c.json({ error: "Invalid request body" }, 400);
    return send(c, narrator.addPlayer(name));
  });

  api.delete("/players/:playerId", (c) => {
    const playerId = c.req.param("playerId");
    return playerId.length === 0
      ? c.json({ error: "Invalid request body" }, 400)
      : send(c, narrator.removePlayer(playerId));
  });

  api.post("/start", (_c) => send(_c, narrator.startGame()));

  api.post("/begin-night", (_c) => send(_c, narrator.beginNight()));

  api.post("/night-action", async (c) => {
    const body = await readJson(c.req);
    const actionType = toNightActionType(stringField(body, "action"));
    if (actionType === undefined) {
      return c.json({ error: "Unknown or missing night action" }, 400);
    }
    const rawTargetId = body["targetId"];
    const targetId = (typeof rawTargetId === "string" ? rawTargetId : rawTargetId === null ? null : undefined) ?? null;
    return send(c, narrator.recordNightAction(actionType, targetId));
  });

  api.post("/resolve-night", (_c) => send(_c, narrator.resolveNight()));

  api.post("/start-discussion", (_c) => send(_c, narrator.startDiscussion()));

  api.post("/start-voting", (_c) => send(_c, narrator.startVoting()));

  api.post("/vote", async (c) => {
    const body = await readJson(c.req);
    const voterId = stringField(body, "voterId");
    const targetId = stringField(body, "targetId");
    if (voterId === undefined || targetId === undefined) {
      return c.json({ error: "A vote needs a voter and a target" }, 400);
    }
    return send(c, narrator.recordVote(voterId, targetId));
  });

  api.post("/end-voting", (_c) => send(_c, narrator.endVoting()));

  api.post("/advance", (_c) => send(_c, narrator.advancePhase()));

  api.post("/play-again", (_c) => send(_c, narrator.playAgain()));

  api.post("/reset", (c) => c.json({ view: narrator.resetGame() }, 200));

  return api;
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function send(c: Context, result: NarratorResult) {
  if (result.ok) return c.json({ view: result.view }, 200);
  return toErrorResponse(c, result.error.code, result.error.message);
}

function toErrorResponse(c: Context, code: string, message: string) {
  const status = NARRATOR_ERROR_STATUS[code] ?? 400;
  return c.json({ error: message }, status);
}

const NARRATOR_ERROR_STATUS: Record<string, ContentfulStatusCode> = {
  INVALID_STEP: 400,
  INVALID_ACTION: 400,
  INVALID_PHASE: 400,
  INVALID_ACTOR: 400,
  INVALID_TARGET: 400,
  INVALID_PLAYER_NAME: 400,
  PLAYER_NOT_FOUND: 404,
  PLAYER_DEAD: 400,
  ACTION_ALREADY_SUBMITTED: 409,
  GAME_FULL: 409,
  NAME_TAKEN: 409,
  PLAYER_ALREADY_JOINED: 409,
  NOT_ENOUGH_PLAYERS: 422,
  NOT_ALL_READY: 422,
  DOCTOR_REPEAT_GUARD: 409,
  MISSING_REQUIRED_ACTION: 422,
  GAME_OVER: 409,
};

// ---------------------------------------------------------------------------
// Body parsing
// ---------------------------------------------------------------------------

async function readJson(req: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  try {
    const value = await req.json();
    if (typeof value === "object" && value !== null) return value as Record<string, unknown>;
  } catch {
    // fall through
  }
  return {};
}

async function readStringField(
  req: { json: () => Promise<unknown> },
  field: string,
): Promise<string | undefined> {
  const body = await readJson(req);
  return stringField(body, field);
}

function stringField(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === "string" ? value : undefined;
}

function toNightActionType(
  value: string | undefined,
): "MAFIA_KILL" | "DOCTOR_SAVE" | "DETECTIVE_INVESTIGATE" | undefined {
  if (value === "MAFIA_KILL" || value === "DOCTOR_SAVE" || value === "DETECTIVE_INVESTIGATE") {
    return value;
  }
  return undefined;
}

export type { NarratorView };