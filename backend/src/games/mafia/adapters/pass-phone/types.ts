/**
 * Pass-the-phone (Mode A) Mafia adapter — view model and result contract.
 *
 * The adapter is the shared-device holder: it orchestrates the handoff but
 * never computes game rules. Every `PassPhoneView` below is derived exclusively
 * from the engine's public and per-player private views
 * (`getPublicState` / `getPlayerState`). Hidden facts — other players' roles,
 * night inputs, verdicts, the votes map — never appear in a view.
 *
 * "Private" means private-to-the-current-holder: exactly one player's own
 * secret is rendered at a time, and only after an explicit HANDOFF step. Views
 * named `*_HANDOFF` are deliberately secret-free so a cleared phone can be
 * handed to the next player without leaking the previous holder's reveal.
 */
import type {
  MafiaErrorCode,
  MafiaRole,
  MafiaTeam,
  NightActionType,
  PlayerId,
} from "../../types.ts";

/** A player as it is safe to show at any time (identity + aliveness only). */
export interface PassPhonePublicPlayer {
  id: PlayerId;
  name: string;
  alive: boolean;
}

/** One row of the setup (lobby) roster. */
export interface PassPhoneSetupPlayer {
  id: PlayerId;
  name: string;
}

/**
 * The private interaction currently being orchestrated for exactly one player.
 * - `HANDOFF` — the phone must be handed to this player; nothing secret is shown.
 * - `REVEAL`  — the holder is looking at their own secret (role / action / vote).
 *
 * An interaction is cleared the moment the holder acknowledges it, so the next
 * handoff never inherits the previous holder's secret.
 */
export type PassPhoneInteractionStep = "HANDOFF" | "REVEAL";

export interface PassPhoneInteraction {
  playerId: PlayerId;
  step: PassPhoneInteractionStep;
}

/**
 * Every screen the shared device can be in. The SvelteKit UI renders this union
 * verbatim — it contains no rules, no tallies, no hidden state beyond the
 * current holder's own secret.
 */
export type PassPhoneView =
  | {
      kind: "SETUP";
      players: PassPhoneSetupPlayer[];
      minPlayers: number;
      maxPlayers: number;
      canStart: boolean;
    }
  /** Public: pass the phone to this named player to privately view their role. */
  | { kind: "ROLE_HANDOFF"; playerId: PlayerId; name: string }
  /** Private to <playerId>: their role. Cleared before the next handoff. */
  | { kind: "ROLE_REVEAL"; playerId: PlayerId; name: string; role: MafiaRole }
  /**
   * Public-ish: "The <role> takes the phone." Names no one, so the phone never
   * outs a player; the role-holder steps forward on their own.
   */
  | { kind: "NIGHT_HANDOFF"; role: MafiaRole }
  /** Private to <playerId>: the night action card + its legal targets. */
  | {
      kind: "SECRET_ACTION";
      playerId: PlayerId;
      name: string;
      role: MafiaRole;
      action: NightActionType;
      candidates: PassPhonePublicPlayer[];
      /** Doctor may deliberately pass instead of saving. */
      canPass: boolean;
      /** Device may force-end the night, skipping every pending slot. */
      canEndNight: boolean;
    }
  | {
      kind: "MORNING";
      nightNumber: number;
      deaths: PassPhonePublicPlayer[];
      players: PassPhonePublicPlayer[];
    }
  | { kind: "DISCUSSION"; nightNumber: number; players: PassPhonePublicPlayer[] }
  /** Public: pass to this named living player to privately cast a vote. */
  | { kind: "VOTE_HANDOFF"; playerId: PlayerId; name: string }
  /** Private to <voterId>: the vote card. Candidates are the living roster. */
  | { kind: "VOTE"; voterId: PlayerId; name: string; candidates: PassPhonePublicPlayer[] }
  | {
      kind: "VOTE_RESULT";
      nightNumber: number;
      eliminatedPlayerId: PlayerId | null;
      players: PassPhonePublicPlayer[];
    }
  | {
      kind: "GAME_OVER";
      winner: MafiaTeam;
      players: PassPhonePublicPlayer[];
      /** Full role assignment — public precisely at game over (engine spec 8.5). */
      revealedRoles: Array<{
        playerId: PlayerId;
        name: string;
        role: MafiaRole;
        alive: boolean;
      }>;
    };

export type PassPhoneErrorCode =
  | MafiaErrorCode
  /**
   * The caller asked for something the current step cannot do (e.g. confirming
   * a role that is not on screen, or acting outside the night).
   */
  | "INVALID_STEP";

export interface PassPhoneError {
  code: PassPhoneErrorCode;
  message: string;
}

export type PassPhoneResult =
  | { ok: true; view: PassPhoneView }
  | { ok: false; error: PassPhoneError };