/**
 * Phase 11B — Mafia WebSocket protocol.
 *
 * Typed, transport-agnostic contract for the Mafia game channel, plus the pure
 * validation/authority helpers the WS transport uses. Nothing here touches
 * Hono or Bun; the transport (src/realtime/ws.ts) turns WebSocket frames into
 * these messages and back.
 *
 * Information model
 * -----------------
 * Clients never send engine state and never choose an `ActionActor`. The
 * transport derives the actor from the validated WebSocket identity:
 *
 *   player connection   -> { type: "PLAYER", playerId: <identity> }
 *   narrator connection -> { type: "NARRATOR" }
 *
 * A client cannot impersonate another player: any `playerId`/`actor` fields it
 * sends are overridden, and the engine's own residency checks (a PLAYER actor
 * may only act for itself) reject the rest.
 *
 * Narrator authority is established by the SERVER, not claimed by the client:
 * the room's host connection (isHost, assigned by RoomManager) carries narrator
 * authority for that room. This is a transport-level decision only — the engine
 * and the session layer stay host-agnostic.
 */
import { MAFIA_ACTION_TYPES } from "./constants.ts";
import type { ActionActor, MafiaAction, MafiaActionType, MafiaNarratorState, MafiaPlayerState, MafiaPublicState } from "./types.ts";

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

type Distribute<U> = U extends unknown ? Omit<U, "actor"> : never;

/** The action a client may ask to perform; the actor is always supplied server-side. */
export type MafiaClientAction = Distribute<MafiaAction>;

export type MafiaClientMessage = {
  type: "mafia.action";
  action: MafiaClientAction;
};

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

export type MafiaServerMessage =
  | { type: "mafia.state"; state: MafiaPublicState }
  | { type: "mafia.private"; state: MafiaPlayerState }
  | { type: "mafia.narrator"; state: MafiaNarratorState }
  | { type: "mafia.error"; code: string; message: string };

// ---------------------------------------------------------------------------
// Error codes (protocol-level; engine/session error codes pass through too)
// ---------------------------------------------------------------------------

export type MafiaProtocolErrorCode =
  | "INVALID_MESSAGE"
  | "UNKNOWN_MESSAGE_TYPE"
  | "MISSING_ACTION"
  | "INVALID_ACTION"
  | "ACTION_FORBIDDEN";

// ---------------------------------------------------------------------------
// Authority
// ---------------------------------------------------------------------------

/**
 * Server-assigned narrator authority: the room host's connection. RoomManager
 * assigned isHost; clients cannot claim it.
 */
export function isNarratorConnection(
  room: { players: ReadonlyArray<{ id: string; isHost: boolean }> },
  playerId: string,
): boolean {
  return room.players.some((player) => player.isHost && player.id === playerId);
}

/** Actions an ordinary player connection may submit (self-centric, PLAYER actor). */
export const PLAYER_SUBMITTABLE_ACTION_TYPES: readonly MafiaActionType[] = [
  "READY",
  "UNREADY",
  "ROLE_SEEN",
  "MAFIA_KILL",
  "DOCTOR_SAVE",
  "DETECTIVE_INVESTIGATE",
  "CAST_VOTE",
];

/** Actions the narrator authority may submit (records on behalf of any player). */
export const NARRATOR_SUBMITTABLE_ACTION_TYPES: readonly MafiaActionType[] = MAFIA_ACTION_TYPES.filter(
  (type) => type !== "PLAYER_UNAVAILABLE",
);

/** PLAYER_UNAVAILABLE is a server-only action (the transport reports disconnects). */
export function isServerOnlyAction(actionType: MafiaActionType): boolean {
  return actionType === "PLAYER_UNAVAILABLE";
}

export function allowedActionTypes(isNarrator: boolean): readonly MafiaActionType[] {
  return isNarrator ? NARRATOR_SUBMITTABLE_ACTION_TYPES : PLAYER_SUBMITTABLE_ACTION_TYPES;
}

/**
 * Build the engine action for an authenticated connection: the client's action
 * fields are kept, but `type` is reasserted and `actor` is ALWAYS overwritten
 * with the server-derived identity (an embedded `actor` is stripped).
 */
export function buildAuthenticatedAction(
  actionType: MafiaActionType,
  action: Record<string, unknown>,
  actor: ActionActor,
): MafiaAction {
  return { ...action, type: actionType, actor } as unknown as MafiaAction;
}

// ---------------------------------------------------------------------------
// Parsing / validation
// ---------------------------------------------------------------------------

export type MafiaClientParse =
  | { ok: true; actionType: MafiaActionType; action: Record<string, unknown> }
  | { ok: false; code: MafiaProtocolErrorCode; message: string };

function fail(code: MafiaProtocolErrorCode, message: string): MafiaClientParse {
  return { ok: false, code, message };
}

/**
 * Validate an already-decoded value as a Mafia client message. Pure — the
 * transport calls this after its generic JSON decode.
 */
export function parseMafiaClientMessage(value: unknown): MafiaClientParse {
  if (typeof value !== "object" || value === null) {
    return fail("INVALID_MESSAGE", "Message must be an object");
  }
  const message = value as Record<string, unknown>;
  if (message.type !== "mafia.action") {
    return fail("UNKNOWN_MESSAGE_TYPE", "Expected a mafia.action message");
  }
  const action = message.action;
  if (typeof action !== "object" || action === null) {
    return fail("MISSING_ACTION", "mafia.action requires an action object");
  }
  const actionType = (action as Record<string, unknown>).type;
  if (typeof actionType !== "string" || !isMafiaActionType(actionType)) {
    return fail("INVALID_ACTION", "Unknown or malformed action type");
  }
  return { ok: true, actionType, action: { ...(action as Record<string, unknown>) } };
}

/** Decode a raw WebSocket frame into a Mafia client message (never throws). */
export function parseMafiaClientMessageRaw(raw: string): MafiaClientParse {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return fail("INVALID_MESSAGE", "Invalid JSON");
  }
  return parseMafiaClientMessage(value);
}

function isMafiaActionType(value: string): value is MafiaActionType {
  return (MAFIA_ACTION_TYPES as readonly string[]).includes(value);
}