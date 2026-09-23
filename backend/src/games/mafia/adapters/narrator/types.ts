/**
 * Narrator (Mode C) Mafia adapter — view model and result contract.
 *
 * The narrator is the privileged operator of a physical game: one device, full
 * hidden truth, players participate without phones. Every `NarratorView` below
 * is derived EXCLUSIVELY from the engine's narrator view (`getNarratorState`)
 * — never from raw engine state — so the adapter stays a pure presenter over
 * the engine's own information boundary.
 *
 * Narrator views intentionally carry hidden information (roles, night inputs,
 * verdicts, vote tallies): that is the whole point of the mode. It is therefore
 * a security invariant that this state never leaves the narrator's device —
 * nothing in this adapter wires into the multiplayer player channels, and it
 * must never be routed through Mode B messages.
 */
import type {
  MafiaErrorCode,
  MafiaRole,
  MafiaTeam,
  NightActionStatus,
  NightActionType,
  PlayerId,
} from "../../types.ts";

/** Identity + aliveness, rendered anywhere the narrator needs the roster. */
export interface NarratorPublicPlayer {
  id: PlayerId;
  name: string;
  alive: boolean;
}

/** One row of the setup (lobby) roster, with ready flags. */
export interface NarratorSetupPlayer {
  id: PlayerId;
  name: string;
  ready: boolean;
}

/** One player's dealt role — the narrator reads this privately to tell them. */
export interface NarratorRoleRow {
  id: PlayerId;
  name: string;
  role: MafiaRole;
}

/** A single night slot as the narrator sees it (who was picked, did they act). */
export interface NarratorNightSlot {
  action: NightActionType;
  status: NightActionStatus;
  targetId: PlayerId | null;
  targetName: string | null;
  /** For DETECTIVE_INVESTIGATE: the verdict (is the target Mafia?). Populated immediately after the detective acts. */
  verdict: boolean | null;
}

/** One record of the vote tally: voter -> target, both named. */
export interface NarratorVote {
  voterId: PlayerId;
  voterName: string;
  targetId: PlayerId;
  targetName: string;
}

/** The Detective's private verdict, surfaced to the narrator at morning. */
export interface NarratorInvestigation {
  nightNumber: number;
  targetId: PlayerId;
  targetName: string;
  isMafia: boolean;
}

/**
 * Every screen the narrator device can be in. Ids/names are always resolved so
 * the UI never has to index a role map — the narrator reads people by name.
 */
export type NarratorView =
  | {
      kind: "LOBBY";
      players: NarratorSetupPlayer[];
      minPlayers: number;
      maxPlayers: number;
      canStart: boolean;
    }
  /** Narrator reads each role privately and tells the player (spec §2.3). */
  | { kind: "ROLE_REVEAL"; players: NarratorRoleRow[] }
  /** Night collection: the acting Mafia plus the three open/recorded slots. */
  | {
      kind: "NIGHT";
      nightNumber: number;
      actingMafiaName: string;
      /** Full roster (alive flags) so the narrator can pick night targets by name. */
      players: NarratorPublicPlayer[];
      kill: NarratorNightSlot;
      save: NarratorNightSlot;
      investigate: NarratorNightSlot;
    }
  | {
      kind: "MORNING";
      nightNumber: number;
      deaths: NarratorPublicPlayer[];
      investigation: NarratorInvestigation | null;
      players: NarratorPublicPlayer[];
    }
  | { kind: "DISCUSSION"; nightNumber: number; players: NarratorPublicPlayer[] }
  | {
      kind: "VOTING";
      nightNumber: number;
      votes: NarratorVote[];
      votersLeft: NarratorPublicPlayer[];
      casts: number;
      total: number;
    }
  | {
      kind: "VOTE_RESULT";
      nightNumber: number;
      votes: NarratorVote[];
      eliminatedPlayer: NarratorPublicPlayer | null;
      tie: boolean;
      players: NarratorPublicPlayer[];
    }
  | {
      kind: "GAME_OVER";
      winner: MafiaTeam;
      players: Array<{ id: PlayerId; name: string; role: MafiaRole; alive: boolean }>;
    };

export type NarratorErrorCode =
  | MafiaErrorCode
  /**
   * The caller asked for something the current phase cannot do (e.g. recording
   * votes outside voting, or starting discussion outside the morning).
   */
  | "INVALID_STEP";

export interface NarratorError {
  code: NarratorErrorCode;
  message: string;
}

export type NarratorResult =
  | { ok: true; view: NarratorView }
  | { ok: false; error: NarratorError };