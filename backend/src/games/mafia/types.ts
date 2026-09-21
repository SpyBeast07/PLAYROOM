/**
 * Mafia engine — domain types and state model.
 *
 * Phase 10A: contract only. No rule logic lives here.
 * The engine is transport-agnostic: it does not know about Hono, WebSockets,
 * Bun, rooms, connections, auth, or any device/model. See docs/mafia-engine.md.
 */

export type PlayerId = string;
export type GameId = string;

export type MafiaRole = "MAFIA" | "DOCTOR" | "DETECTIVE" | "VILLAGER";

export type MafiaTeam = "MAFIA" | "TOWN";

export type MafiaGameMode = "PASS_THE_PHONE" | "MULTIPLAYER" | "NARRATOR";

export type MafiaPhase =
  | "LOBBY"
  | "ROLE_REVEAL"
  | "NIGHT"
  | "MORNING"
  | "DISCUSSION"
  | "VOTING"
  | "VOTE_RESULT"
  | "GAME_OVER";

export type NightActionType = "MAFIA_KILL" | "DOCTOR_SAVE" | "DETECTIVE_INVESTIGATE";

export type MafiaActionType =
  | "JOIN"
  | "LEAVE"
  | "READY"
  | "UNREADY"
  | "START_GAME"
  | "ROLE_SEEN"
  | "BEGIN_NIGHT"
  | "MAFIA_KILL"
  | "DOCTOR_SAVE"
  | "DETECTIVE_INVESTIGATE"
  | "RESOLVE_NIGHT"
  | "START_DISCUSSION"
  | "START_VOTING"
  | "CAST_VOTE"
  | "END_VOTING"
  | "ADVANCE_PHASE"
  | "PLAY_AGAIN"
  | "PLAYER_UNAVAILABLE";

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

/** Stable identity the engine objects are addressed by. Transport has no role here. */
export interface MafiaPlayerIdentity {
  id: PlayerId;
  name: string;
}

/**
 * Internal player record. `alive` and `ready` are runtime flags;
 * `role` lives in the `roles` map, separate from identity, never on the player
 * object. Connection/device state is an adapter concern and is intentionally
 * absent.
 */
export interface MafiaPlayer {
  id: PlayerId;
  name: string;
  alive: boolean;
  ready: boolean;
}

// ---------------------------------------------------------------------------
// Night actions
// ---------------------------------------------------------------------------

/**
 * State of one night action slot.
 * - NOT_ACTED: waiting on submission (or deliberate pass not yet made).
 * - SUBMITTED: a target choice was recorded for this night.
 * - PASSED:    the actor intentionally passed (Doctor skip; targetId is null).
 * - SKIPPED:   the actor's input was treated as "no action" because they were
 *              disconnected / timed out / force-resolved (spec 6.14, 9.3).
 *
 * `INVALID` inputs never mutate state; they are rejected at dispatch time, so
 * there is no "invalid" stored state.
 */
export type NightActionStatus = "NOT_ACTED" | "SUBMITTED" | "PASSED" | "SKIPPED";

export interface MafiaNightAction {
  status: NightActionStatus;
  /** Present when SUBMITTED; null for PASSED/SKIPPED/NOT_ACTED. */
  targetId: PlayerId | null;
}

/** All collected inputs for one night, in the fixed order Mafia -> Doctor -> Detective. */
export interface MafiaNightActions {
  nightNumber: number;
  actingMafiaId: PlayerId;
  kill: MafiaNightAction;
  save: MafiaNightAction;
  investigate: MafiaNightAction;
}

/**
 * The atomic, pure output of one night's resolution (spec 9). Stored in the
 * MORNING state so the outcome is available for announcements and views.
 * Page 10B computes this; the contract merely declares its shape.
 */
export interface ResolvedNight {
  nightNumber: number;
  killTargetId: PlayerId | null;
  saveTargetId: PlayerId | null;
  saveApplied: boolean;
  doctorAlive: boolean;
  killedPlayerIds: PlayerId[];
  investigatedTargetId: PlayerId | null;
  /** null when no investigation happened; otherwise "is the target Mafia?". */
  investigationVerdict: boolean | null;
}

// ---------------------------------------------------------------------------
// Voting
// ---------------------------------------------------------------------------

/**
 * Votes are stored as voter -> target. Only voters who have submitted appear in
 * the map (absent = has not voted yet). The tally is DERIVED from this map at
 * resolution time (spec 10); it is never stored.
 */
export type VoteMap = Partial<Record<PlayerId, PlayerId>>;

export interface MafiaElimination {
  /** null when there is no elimination (tie, or nobody voted). */
  eliminatedPlayerId: PlayerId | null;
  /** true when the top vote count was tied (spec 10.2). */
  tie: boolean;
}

// ---------------------------------------------------------------------------
// Game timeline (end-of-game summary source, spec 8.5)
// ---------------------------------------------------------------------------

export type MafiaTimelineEntry =
  | { kind: "GAME_STARTED" }
  | { kind: "NIGHT_RESOLVED"; nightNumber: number; killedPlayerIds: PlayerId[] }
  | { kind: "PLAYER_ELIMINATED"; nightNumber: number; playerId: PlayerId }
  | { kind: "GAME_OVER"; winner: MafiaTeam };

// ---------------------------------------------------------------------------
// Game state (authoritative, internal)
// ---------------------------------------------------------------------------

interface MafiaGameStateBase {
  gameId: GameId;
  mode: MafiaGameMode;
  players: MafiaPlayer[];
  timeline: MafiaTimelineEntry[];
  /**
   * The most recent atomic night resolution. Carried across all phases after a
   * night so private results (Detective verdict, Doctor heal notice) and the
   * Doctor repeat-guard stay derivable; null before the first night.
   * The engine stores the Doctor's chosen save target here
   * (saveTargetId); a null save means "passed", which clears the guard.
   */
  lastResolvedNight: ResolvedNight | null;
  /** The most recent acting Mafia (survives night boundaries for carry-over). */
  lastActingMafiaId: PlayerId | null;
}

/**
 * Per-phase discriminated union. Phase-specific data only exists on its phase:
 * votes only during VOTING/VOTE_RESULT, night inputs only during NIGHT, the
 * night outcome only during MORNING. This makes illegal phase data awkward to
 * represent.
 *
 * `roles` is an empty map in LOBBY and is immutable for the rest of a game
 * (assigned on START_GAME, revealed wholesale only at GAME_OVER).
 */
export type MafiaGameState =
  | MafiaLobbyState
  | MafiaRoleRevealState
  | MafiaNightState
  | MafiaMorningState
  | MafiaDiscussionState
  | MafiaVotingState
  | MafiaVoteResultState
  | MafiaGameOverState;

export interface MafiaLobbyState extends MafiaGameStateBase {
  phase: "LOBBY";
  roles: Record<PlayerId, MafiaRole>;
  winner: null;
  nightNumber: 0;
}

export interface MafiaRoleRevealState extends MafiaGameStateBase {
  phase: "ROLE_REVEAL";
  roles: Record<PlayerId, MafiaRole>;
  /** Who has confirmed seeing their role (spec 6.6). */
  roleSeen: Record<PlayerId, boolean>;
  winner: null;
  nightNumber: 0;
}

export interface MafiaNightState extends MafiaGameStateBase {
  phase: "NIGHT";
  roles: Record<PlayerId, MafiaRole>;
  nightNumber: number;
  actingMafiaId: PlayerId;
  nightActions: MafiaNightActions;
  winner: null;
}

export interface MafiaMorningState extends MafiaGameStateBase {
  phase: "MORNING";
  roles: Record<PlayerId, MafiaRole>;
  nightNumber: number;
  winner: null;
}

export interface MafiaDiscussionState extends MafiaGameStateBase {
  phase: "DISCUSSION";
  roles: Record<PlayerId, MafiaRole>;
  nightNumber: number;
  winner: null;
}

export interface MafiaVotingState extends MafiaGameStateBase {
  phase: "VOTING";
  roles: Record<PlayerId, MafiaRole>;
  nightNumber: number;
  votes: VoteMap;
  winner: null;
}

export interface MafiaVoteResultState extends MafiaGameStateBase {
  phase: "VOTE_RESULT";
  roles: Record<PlayerId, MafiaRole>;
  nightNumber: number;
  votes: VoteMap;
  elimination: MafiaElimination;
  /** null until the winning team is known; set on the GAME_OVER transition only. */
  winner: null;
}

export interface MafiaGameOverState extends MafiaGameStateBase {
  phase: "GAME_OVER";
  /** Full assignment is eligible to reveal here (spec 8.5). */
  roles: Record<PlayerId, MafiaRole>;
  nightNumber: number;
  winner: MafiaTeam;
}

// ---------------------------------------------------------------------------
// Information boundaries (view models)
// ---------------------------------------------------------------------------

/** Safe for every player; identical for all. Never contains roles or hidden actions. */
export interface MafiaPublicPlayer {
  id: PlayerId;
  name: string;
  alive: boolean;
  /** Lobby-only; post-start it is meaningless but harmless to keep. */
  ready: boolean;
}

export interface MafiaPublicState {
  gameId: GameId;
  phase: MafiaPhase;
  nightNumber: number;
  players: MafiaPublicPlayer[];
  winner: MafiaTeam | null;
  /** The full role assignment, public for everyone only at GAME_OVER (spec 8.5); null otherwise. */
  revealedRoles: Record<PlayerId, MafiaRole> | null;
  /** Aggregate vote progress during VOTING (count, not who voted for whom). */
  voting: { cast: number; total: number } | null;
  /** Deaths to announce during MORNING; null otherwise. */
  morningDeaths: PlayerId[] | null;
  /** Determined elimination during VOTE_RESULT; role is NOT included (spec 8.6). */
  elimination: { eliminatedPlayerId: PlayerId | null } | null;
}

/** Player-specific private results from a resolved night (spec 7.2 table). */
export type MafiaPrivateNightResult =
  | { kind: "INVESTIGATION"; nightNumber: number; targetId: PlayerId; isMafia: boolean }
  | { kind: "HEAL"; nightNumber: number; applied: boolean; targetId: PlayerId | null };

/** Everything the engine is allowed to tell ONE player about their own situation. */
export interface MafiaPlayerState {
  playerId: PlayerId;
  name: string;
  role: MafiaRole | null;
  alive: boolean;
  ready: boolean;
  roleSeen: boolean;
  phase: MafiaPhase;
  nightNumber: number;
  /** Actions the player may validly submit right now (Phase 10B derives this). */
  availableActions: readonly MafiaActionType[];
  /** The player's own night slot status this night, if they have one. */
  ownNightAction: NightActionStatus | null;
  /** Their latest private night result, if any. */
  ownPrivateNightResult: MafiaPrivateNightResult | null;
  /** Their own submitted vote target this voting round, if any. */
  ownVoteTargetId: PlayerId | null;
}

/** Full hidden truth for the narrator (Mode C). Includes the public view. */
export interface MafiaNarratorState {
  publicState: MafiaPublicState;
  roles: Record<PlayerId, MafiaRole>;
  readyState: Record<PlayerId, boolean>;
  roleSeen: Record<PlayerId, boolean>;
  actingMafiaId: PlayerId | null;
  nightActions: MafiaNightActions | null;
  lastResolvedNight: ResolvedNight | null;
  votes: VoteMap | null;
  lastElimination: MafiaElimination | null;
  timeline: readonly MafiaTimelineEntry[];
}

// ---------------------------------------------------------------------------
// Actor / authority model
// ---------------------------------------------------------------------------

/**
 * Every action carries an explicit actor. Authority is never expressed through
 * "host" — the host is a room concept the engine must not know about.
 *
 * - PLAYER:  the named player; actions are validated against their identity,
 *            role, aliveness, and submission status.
 * - NARRATOR: the game operator (Mode C narrator; adapters may bind the
 *            "advance authority" — e.g. the Mode B host or Mode A device
 *            holder — to this actor for lobby/phase control). Per spec 11 the
 *            narrator also records night actions and spoken votes on behalf of
 *            players, so role checks are bypassed but target/life checks stay.
 * - SYSTEM:  the engine/server performing automatic transitions (night
 *            resolution, win detection, phase advance after requirements are met).
 */
export type ActionActor =
  | { type: "PLAYER"; playerId: PlayerId }
  | { type: "NARRATOR" }
  | { type: "SYSTEM" };

// ---------------------------------------------------------------------------
// Actions (discriminated union)
// ---------------------------------------------------------------------------

interface BaseAction {
  actor: ActionActor;
}

export interface JoinAction extends BaseAction {
  type: "JOIN";
  /** Caller-supplied opaque id (the adapter's player id) + display name. */
  player: MafiaPlayerIdentity;
}
export interface LeaveAction extends BaseAction {
  type: "LEAVE";
  playerId: PlayerId;
}
export interface ReadyAction extends BaseAction {
  type: "READY";
  playerId: PlayerId;
}
export interface UnreadyAction extends BaseAction {
  type: "UNREADY";
  playerId: PlayerId;
}
export interface StartGameAction extends BaseAction {
  type: "START_GAME";
}
export interface RoleSeenAction extends BaseAction {
  type: "ROLE_SEEN";
  playerId: PlayerId;
}
export interface BeginNightAction extends BaseAction {
  type: "BEGIN_NIGHT";
}
export interface MafiaKillAction extends BaseAction {
  type: "MAFIA_KILL";
  targetId: PlayerId;
}
/** null target = Doctor intentionally passing (spec 6.8). */
export interface DoctorSaveAction extends BaseAction {
  type: "DOCTOR_SAVE";
  targetId: PlayerId | null;
}
export interface DetectiveInvestigateAction extends BaseAction {
  type: "DETECTIVE_INVESTIGATE";
  targetId: PlayerId;
}
export interface ResolveNightAction extends BaseAction {
  type: "RESOLVE_NIGHT";
}
export interface StartDiscussionAction extends BaseAction {
  type: "START_DISCUSSION";
}
export interface StartVotingAction extends BaseAction {
  type: "START_VOTING";
}
/**
 * `voterId` is required so the narrator can record another player's spoken
 * vote. For a PLAYER actor the engine requires voterId === actor.playerId.
 */
export interface CastVoteAction extends BaseAction {
  type: "CAST_VOTE";
  voterId: PlayerId;
  targetId: PlayerId;
}
export interface EndVotingAction extends BaseAction {
  type: "END_VOTING";
}
/** Meta-action: fast-forward the current phase to its terminal transition (spec 6.14). */
export interface AdvancePhaseAction extends BaseAction {
  type: "ADVANCE_PHASE";
}
export interface PlayAgainAction extends BaseAction {
  type: "PLAY_AGAIN";
}
/**
 * The single choke-point through which adapters report connectivity so the
 * engine can mark the player's pending night input as SKIPPED (spec 6.14/14).
 */
export interface PlayerUnavailableAction extends BaseAction {
  type: "PLAYER_UNAVAILABLE";
  playerId: PlayerId;
  reason: "DISCONNECTED" | "TIMED_OUT";
}

export type MafiaAction =
  | JoinAction
  | LeaveAction
  | ReadyAction
  | UnreadyAction
  | StartGameAction
  | RoleSeenAction
  | BeginNightAction
  | MafiaKillAction
  | DoctorSaveAction
  | DetectiveInvestigateAction
  | ResolveNightAction
  | StartDiscussionAction
  | StartVotingAction
  | CastVoteAction
  | EndVotingAction
  | AdvancePhaseAction
  | PlayAgainAction
  | PlayerUnavailableAction;

// ---------------------------------------------------------------------------
// Engine result / error contract
// ---------------------------------------------------------------------------

export type MafiaErrorCode =
  | "INVALID_ACTION"
  | "INVALID_PHASE"
  | "INVALID_ACTOR"
  | "PLAYER_NOT_FOUND"
  | "PLAYER_DEAD"
  | "INVALID_TARGET"
  | "ACTION_ALREADY_SUBMITTED"
  | "GAME_OVER"
  | "GAME_FULL"
  | "NAME_TAKEN"
  | "PLAYER_ALREADY_JOINED"
  | "INVALID_PLAYER_NAME"
  | "NOT_ENOUGH_PLAYERS"
  | "NOT_ALL_READY"
  | "DOCTOR_REPEAT_GUARD"
  | "MISSING_REQUIRED_ACTION";

export interface MafiaEngineError {
  code: MafiaErrorCode;
  message: string;
}

export type MafiaEngineResult =
  | {
      success: true;
      /** false for valid but no-op actions (e.g. READY when already ready). */
      stateChanged: boolean;
      /** Internal domain events from this dispatch. Never auto-broadcast. */
      events: MafiaEvent[];
    }
  | {
      success: false;
      error: MafiaEngineError;
    };

// ---------------------------------------------------------------------------
// Domain events
// ---------------------------------------------------------------------------

/**
 * Internal domain facts emitted by a successful dispatch. They are NOT
 * transport/public messages: several carry hidden information (roles, acting
 * Mafia, verdicts, votes). Adapters must map them through the view models /
 * public-private-narrator boundaries before sending anything.
 */
export type MafiaEvent =
  | { type: "PHASE_CHANGED"; from: MafiaPhase; to: MafiaPhase }
  | { type: "PLAYER_JOINED"; playerId: PlayerId }
  | { type: "PLAYER_LEFT"; playerId: PlayerId }
  | { type: "PLAYER_READY"; playerId: PlayerId }
  | { type: "PLAYER_UNREADY"; playerId: PlayerId }
  | { type: "GAME_STARTED"; roles: Record<PlayerId, MafiaRole> }
  | { type: "ROLE_SEEN"; playerId: PlayerId }
  | { type: "NIGHT_STARTED"; nightNumber: number; actingMafiaId: PlayerId }
  | {
      type: "NIGHT_ACTION_RECORDED";
      actionType: NightActionType;
      playerId: PlayerId;
      action: MafiaNightAction;
    }
  | { type: "NIGHT_RESOLVED"; resolvedNight: ResolvedNight }
  | { type: "DISCUSSION_STARTED"; nightNumber: number }
  | { type: "VOTING_STARTED"; nightNumber: number }
  | { type: "VOTE_CAST"; voterId: PlayerId; targetId: PlayerId }
  | { type: "VOTING_RESOLVED"; elimination: MafiaElimination }
  | { type: "PLAYER_ELIMINATED"; playerId: PlayerId }
  | {
      type: "PLAYER_UNAVAILABLE";
      playerId: PlayerId;
      reason: "DISCONNECTED" | "TIMED_OUT";
    }
  | { type: "GAME_OVER"; winner: MafiaTeam };