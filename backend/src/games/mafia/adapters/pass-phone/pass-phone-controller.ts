/**
 * Pass-the-phone (Mode A) Mafia adapter.
 *
 *   Shared-device UI → PassPhoneController → MafiaEngine
 *
 * The controller is the device holder — the Mode A "advance authority". Every
 * engine action it sends is dispatched as `NARRATOR` (the engine records a
 * player's choice on their behalf), and every view is derived from the
 * engine's own public/private views. It is deliberately NOT a second state
 * machine: who is alive, who is Mafia, who acts now, what died, who was saved,
 * eliminations and winners all come from the engine.
 *
 * Session state the adapter owns (the only things it is allowed to own):
 * - the roster (engine LOBBY, mirroring multiplayer's room roster),
 * - `interaction` — which player currently holds the phone and whether their
 *   secret is on screen (HANDOFF vs REVEAL),
 * - id minting for locally-entered names (no accounts, no joins over a wire).
 *
 * The adapter reads ONLY `getPublicState()` and `getPlayerState(id)` — never
 * `getState()` or `getNarratorState()`.
 */
import { createMafiaGame, type MafiaEngine } from "../../mafia-engine.ts";
import { MAX_PLAYERS, MIN_PLAYERS, NIGHT_ACTION_ORDER } from "../../constants.ts";
import type {
  MafiaEngineError,
  MafiaEngineResult,
  MafiaPlayerState,
  MafiaPublicState,
  MafiaRole,
  MafiaTeam,
  NightActionType,
  PlayerId,
} from "../../types.ts";
import type {
  PassPhoneInteraction,
  PassPhonePublicPlayer,
  PassPhoneResult,
  PassPhoneView,
} from "./types.ts";

const NARRATOR = { type: "NARRATOR" } as const;

export interface PassPhoneControllerOptions {
  /** Determinism injection for role shuffling (passed straight to the engine). */
  random?: () => number;
  /** Test seam: stable player-id minting. Defaults to "p1", "p2", … */
  createId?: () => string;
}

export class PassPhoneController {
  private engine: MafiaEngine;
  private interaction: PassPhoneInteraction | null = null;
  private idCounter = 0;

  constructor(private readonly options: PassPhoneControllerOptions = {}) {
    this.engine = createMafiaGame({
      mode: "PASS_THE_PHONE",
      players: [],
      random: options.random ?? Math.random,
    });
  }

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  /**
   * The current screen, guaranteed coherent: if the phone should be with a
   * specific player, the view is their HANDOFF; if the night has been fully
   * collected, the device auto-resolves it (the engine decides the outcome).
   */
  getView(): PassPhoneView {
    this.reconcile();
    let pub = this.engine.getPublicState();

    // The device is the advance authority for the one automatic night
    // transition the spec grants it: resolving a fully-collected night
    // ("the device drives the next night"). Everything else waits for a tap.
    if (pub.phase === "NIGHT" && this.pendingNightActor() === null) {
      const resolved = this.engine.dispatch({ type: "RESOLVE_NIGHT", actor: NARRATOR });
      if (resolved.success) {
        this.reconcile();
        pub = this.engine.getPublicState();
      }
    }

    switch (pub.phase) {
      case "LOBBY":
        return this.setupView();
      case "ROLE_REVEAL":
        return this.revealView();
      case "NIGHT":
        return this.nightView();
      case "MORNING":
        return this.morningView(pub);
      case "DISCUSSION":
        return this.discussionView(pub);
      case "VOTING":
        return this.votingView();
      case "VOTE_RESULT":
        return this.voteResultView(pub);
      case "GAME_OVER":
        return this.gameOverView(pub);
    }
  }

  // ---------------------------------------------------------------------------
  // Lobby / setup
  // ---------------------------------------------------------------------------

  addPlayer(name: string): PassPhoneResult {
    if (this.engine.getPublicState().phase !== "LOBBY") {
      return this.wrongStep("Players can only be added before the game starts");
    }
    return this.resultOf(
      this.engine.dispatch({
        type: "JOIN",
        actor: NARRATOR,
        player: { id: this.mintId(), name },
      }),
    );
  }

  removePlayer(playerId: PlayerId): PassPhoneResult {
    if (this.engine.getPublicState().phase !== "LOBBY") {
      return this.wrongStep("Players can only be removed before the game starts");
    }
    return this.resultOf(this.engine.dispatch({ type: "LEAVE", actor: NARRATOR, playerId }));
  }

  /** Readiness is implicit in pass-the-phone: READY everyone, then START_GAME. */
  startGame(): PassPhoneResult {
    if (this.engine.getPublicState().phase !== "LOBBY") {
      return this.wrongStep("Only a lobby can be started");
    }
    for (const player of this.engine.getPublicState().players) {
      const ready = this.engine.dispatch({ type: "READY", actor: NARRATOR, playerId: player.id });
      if (!ready.success) return this.engineFail(ready.error);
    }
    const start = this.engine.dispatch({ type: "START_GAME", actor: NARRATOR });
    if (!start.success) return this.engineFail(start.error);
    this.interaction = null;
    return this.okResult();
  }

  /** Same roster, fresh lobby (engine's PLAY_AGAIN). */
  playAgain(): PassPhoneResult {
    const phase = this.engine.getPublicState().phase;
    if (phase !== "GAME_OVER") return this.wrongStep("Only a finished game can be replayed");
    const result = this.engine.dispatch({ type: "PLAY_AGAIN", actor: NARRATOR });
    this.interaction = null;
    return this.resultOf(result);
  }

  /** Start over completely: fresh engine, empty roster. */
  resetGame(): PassPhoneView {
    this.engine = createMafiaGame({
      mode: "PASS_THE_PHONE",
      players: [],
      random: this.options.random ?? Math.random,
    });
    this.interaction = null;
    return this.setupView();
  }

  /** Clear any secret currently on screen. Safe at any time (e.g. app blur). */
  secureClear(): PassPhoneView {
    this.interaction = null;
    return this.getView();
  }

  // ---------------------------------------------------------------------------
  // Role reveal
  // ---------------------------------------------------------------------------

  /**
   * The holder has the phone and the group has looked away: reveal the secret.
   * Pure handoff state — no engine action.
   */
  privacyReady(): PassPhoneResult {
    const current = this.interaction;
    if (current === null || current.step !== "HANDOFF") {
      return this.wrongStep("There is no private handoff waiting to be acknowledged");
    }
    this.interaction = { ...current, step: "REVEAL" };
    return this.okResult();
  }

  /** The holder has seen their role. Clears the secret and hands to the next player. */
  confirmRoleSeen(): PassPhoneResult {
    const current = this.interaction;
    if (current === null || current.step !== "REVEAL") {
      return this.wrongStep("No role reveal is on screen");
    }
    if (this.engine.getPublicState().phase !== "ROLE_REVEAL") {
      return this.wrongStep("Roles are not being revealed");
    }
    const result = this.engine.dispatch({ type: "ROLE_SEEN", actor: NARRATOR, playerId: current.playerId });
    if (!result.success) return this.engineFail(result.error);
    this.interaction = null;
    return this.okResult();
  }

  // ---------------------------------------------------------------------------
  // Night
  // ---------------------------------------------------------------------------

  /**
   * Record the current holder's night action. `targetId = null` means the
   * Doctor deliberately passes (engine `DOCTOR_SAVE` with no target).
   */
  submitNightAction(targetId: PlayerId | null): PassPhoneResult {
    const current = this.interaction;
    if (current === null || current.step !== "REVEAL") {
      return this.wrongStep("No night action is on screen");
    }
    if (this.engine.getPublicState().phase !== "NIGHT") {
      return this.wrongStep("It is not night");
    }
    const action = this.pendingNightActionFor(this.engine.getPlayerState(current.playerId));
    if (action === null) {
      return this.wrongStep("The phone holder has no pending night action");
    }
    if (action !== "DOCTOR_SAVE" && targetId === null) {
      return this.engineFail({ code: "INVALID_TARGET", message: "This action requires a target" });
    }
    const result = this.dispatchNightAction(action, targetId);
    if (!result.success) return this.engineFail(result.error);
    this.interaction = null;
    return this.okResult();
  }

  /** Device escape hatch: skip every still-pending night slot and resolve. */
  endNightNow(): PassPhoneResult {
    if (this.engine.getPublicState().phase !== "NIGHT") {
      return this.wrongStep("It is not night");
    }
    const result = this.engine.dispatch({ type: "ADVANCE_PHASE", actor: NARRATOR });
    this.interaction = null;
    return this.resultOf(result);
  }

  // ---------------------------------------------------------------------------
  // Day: announcements, discussion, voting
  // ---------------------------------------------------------------------------

  startDiscussion(): PassPhoneResult {
    if (this.engine.getPublicState().phase !== "MORNING") {
      return this.wrongStep("Discussion starts from the morning announcement");
    }
    return this.resultOf(this.engine.dispatch({ type: "START_DISCUSSION", actor: NARRATOR }));
  }

  startVoting(): PassPhoneResult {
    if (this.engine.getPublicState().phase !== "DISCUSSION") {
      return this.wrongStep("Voting starts from discussion");
    }
    return this.resultOf(this.engine.dispatch({ type: "START_VOTING", actor: NARRATOR }));
  }

  /** Cast the current holder's vote (the engine presents voters one at a time). */
  castVote(targetId: PlayerId): PassPhoneResult {
    const current = this.interaction;
    if (current === null || current.step !== "REVEAL") {
      return this.wrongStep("No vote card is on screen");
    }
    if (this.engine.getPublicState().phase !== "VOTING") {
      return this.wrongStep("No voting round is open");
    }
    const result = this.engine.dispatch({
      type: "CAST_VOTE",
      actor: NARRATOR,
      voterId: current.playerId,
      targetId,
    });
    if (!result.success) return this.engineFail(result.error);
    this.interaction = null;
    return this.okResult();
  }

  /** Device escape hatch: end voting early (sealed by END_VOTING). */
  endVoting(): PassPhoneResult {
    if (this.engine.getPublicState().phase !== "VOTING") {
      return this.wrongStep("No voting round is open");
    }
    return this.resultOf(this.engine.dispatch({ type: "END_VOTING", actor: NARRATOR }));
  }

  /** The group has read the result; the device drives the next night. */
  continueAfterResult(): PassPhoneResult {
    if (this.engine.getPublicState().phase !== "VOTE_RESULT") {
      return this.wrongStep("There is no result to continue from");
    }
    return this.resultOf(this.engine.dispatch({ type: "ADVANCE_PHASE", actor: NARRATOR }));
  }

  // ---------------------------------------------------------------------------
  // Engine helpers
  // ---------------------------------------------------------------------------

  private mintId(): PlayerId {
    if (this.options.createId) return this.options.createId();
    this.idCounter += 1;
    return `p${this.idCounter}`;
  }

  private okResult(): PassPhoneResult {
    return { ok: true, view: this.getView() };
  }

  private resultOf(result: MafiaEngineResult): PassPhoneResult {
    if (!result.success) return this.engineFail(result.error);
    return this.okResult();
  }

  private engineFail(error: MafiaEngineError): PassPhoneResult {
    return { ok: false, error };
  }

  private wrongStep(message: string): PassPhoneResult {
    return { ok: false, error: { code: "INVALID_STEP", message } };
  }

  /**
   * Keep `interaction` aligned with what the engine actually needs next. This
   * is the adapter's only "state machine", and it tracks just one thing: which
   * player the physical device should be with. No engine dispatch happens here.
   */
  private reconcile(): void {
    const phase = this.engine.getPublicState().phase;
    switch (phase) {
      case "ROLE_REVEAL": {
        const nextId = this.nextUnrevealedPlayerId();
        if (nextId === null) {
          this.interaction = null;
        } else if (this.interaction === null || this.interaction.playerId !== nextId) {
          this.interaction = { playerId: nextId, step: "HANDOFF" };
        }
        break;
      }
      case "NIGHT": {
        const actor = this.pendingNightActor();
        if (actor === null) {
          this.interaction = null;
        } else if (this.interaction === null || this.interaction.playerId !== actor.id) {
          this.interaction = { playerId: actor.id, step: "HANDOFF" };
        }
        break;
      }
      case "VOTING": {
        const voter = this.nextVoterId();
        if (voter === null) {
          this.interaction = null;
        } else if (this.interaction === null || this.interaction.playerId !== voter) {
          this.interaction = { playerId: voter, step: "HANDOFF" };
        }
        break;
      }
      default:
        this.interaction = null;
    }
  }

  private publicPlayers(): PassPhonePublicPlayer[] {
    return this.engine
      .getPublicState()
      .players.map((p) => ({ id: p.id, name: p.name, alive: p.alive }));
  }

  private livingPlayers(): PassPhonePublicPlayer[] {
    return this.publicPlayers().filter((p) => p.alive);
  }

  /** First un-confirmed player in roster order (drives the reveal sequence). */
  private nextUnrevealedPlayerId(): PlayerId | null {
    for (const player of this.engine.getPublicState().players) {
      if (!this.engine.getPlayerState(player.id).roleSeen) return player.id;
    }
    return null;
  }

  /**
   * The next player who still owns a pending night slot, in the engine's fixed
   * order (Mafia → Doctor → Detective). Fully engine-derived: a player counts
   * as pending exactly when the engine offers them a night action.
   */
  private pendingNightActor(): { id: PlayerId; action: NightActionType } | null {
    const holders: Array<{ id: PlayerId; action: NightActionType; rank: number }> = [];
    for (const player of this.engine.getPublicState().players) {
      if (!player.alive) continue;
      const action = this.pendingNightActionFor(this.engine.getPlayerState(player.id));
      if (action !== null) {
        holders.push({ id: player.id, action, rank: NIGHT_ACTION_ORDER.indexOf(action) });
      }
    }
    if (holders.length === 0) return null;
    holders.sort((a, b) => a.rank - b.rank);
    const first = holders[0];
    if (first === undefined) return null;
    return { id: first.id, action: first.action };
  }

  /** The one night action a player may still submit right now, per the engine. */
  private pendingNightActionFor(priv: MafiaPlayerState): NightActionType | null {
    for (const action of NIGHT_ACTION_ORDER) {
      if (priv.availableActions.includes(action)) return action;
    }
    return null;
  }

  /** First living player who has not yet voted (drives the vote round). */
  private nextVoterId(): PlayerId | null {
    for (const player of this.engine.getPublicState().players) {
      if (!player.alive) continue;
      if (this.engine.getPlayerState(player.id).ownVoteTargetId === null) return player.id;
    }
    return null;
  }

  /** Legal targets for the current secret action. The engine remains the judge. */
  private candidatesFor(playerId: PlayerId, action: NightActionType | null): PassPhonePublicPlayer[] {
    const living = this.livingPlayers();
    if (action === "MAFIA_KILL") return living.filter((p) => p.id !== playerId);
    return living;
  }

  private dispatchNightAction(
    action: NightActionType,
    targetId: PlayerId | null,
  ): MafiaEngineResult {
    switch (action) {
      case "MAFIA_KILL":
        return this.engine.dispatch({ type: "MAFIA_KILL", actor: NARRATOR, targetId: targetId as PlayerId });
      case "DOCTOR_SAVE":
        return this.engine.dispatch({ type: "DOCTOR_SAVE", actor: NARRATOR, targetId });
      case "DETECTIVE_INVESTIGATE":
        return this.engine.dispatch({
          type: "DETECTIVE_INVESTIGATE",
          actor: NARRATOR,
          targetId: targetId as PlayerId,
        });
    }
  }

  // ---------------------------------------------------------------------------
  // View builders
  // ---------------------------------------------------------------------------

  private setupView(): PassPhoneView {
    const players = this.publicPlayers().map((p) => ({ id: p.id, name: p.name }));
    return {
      kind: "SETUP",
      players,
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      canStart: players.length >= MIN_PLAYERS && players.length <= MAX_PLAYERS,
    };
  }

  private revealView(): PassPhoneView {
    const current = this.interaction;
    if (current === null) return this.setupView(); // defensive; unreachable mid-reveal
    const priv = this.engine.getPlayerState(current.playerId);
    if (current.step === "HANDOFF") {
      return { kind: "ROLE_HANDOFF", playerId: current.playerId, name: priv.name };
    }
    return {
      kind: "ROLE_REVEAL",
      playerId: current.playerId,
      name: priv.name,
      role: priv.role as NonNullable<MafiaPlayerState["role"]>,
    };
  }

  private nightView(): PassPhoneView {
    const current = this.interaction;
    if (current === null) return this.setupView(); // defensive; unreachable mid-night
    const priv = this.engine.getPlayerState(current.playerId);
    const role = priv.role as NonNullable<MafiaPlayerState["role"]>;
    if (current.step === "HANDOFF") {
      return { kind: "NIGHT_HANDOFF", role };
    }
    const action = this.pendingNightActionFor(priv) ?? "DETECTIVE_INVESTIGATE";
    return {
      kind: "SECRET_ACTION",
      playerId: current.playerId,
      name: priv.name,
      role,
      action,
      candidates: this.candidatesFor(current.playerId, action),
      canPass: action === "DOCTOR_SAVE",
      canEndNight: true,
    };
  }

  private morningView(pub: MafiaPublicState): PassPhoneView {
    const players = this.publicPlayers();
    const deaths = (pub.morningDeaths ?? [])
      .map((id) => players.find((p) => p.id === id))
      .filter((p): p is PassPhonePublicPlayer => p !== undefined);
    return { kind: "MORNING", nightNumber: pub.nightNumber, deaths, players };
  }

  private discussionView(pub: MafiaPublicState): PassPhoneView {
    return { kind: "DISCUSSION", nightNumber: pub.nightNumber, players: this.publicPlayers() };
  }

  private votingView(): PassPhoneView {
    const current = this.interaction;
    if (current === null) return this.setupView(); // defensive; unreachable mid-vote
    const priv = this.engine.getPlayerState(current.playerId);
    if (current.step === "HANDOFF") {
      return { kind: "VOTE_HANDOFF", playerId: current.playerId, name: priv.name };
    }
    return {
      kind: "VOTE",
      voterId: current.playerId,
      name: priv.name,
      candidates: this.livingPlayers(),
    };
  }

  private voteResultView(pub: MafiaPublicState): PassPhoneView {
    return {
      kind: "VOTE_RESULT",
      nightNumber: pub.nightNumber,
      eliminatedPlayerId: pub.elimination?.eliminatedPlayerId ?? null,
      players: this.publicPlayers(),
    };
  }

  private gameOverView(pub: MafiaPublicState): PassPhoneView {
    const revealedRoles = pub.revealedRoles ?? {};
    return {
      kind: "GAME_OVER",
      winner: pub.winner as MafiaTeam,
      players: this.publicPlayers(),
      revealedRoles: pub.players.map((p) => ({
        playerId: p.id,
        name: p.name,
        role: revealedRoles[p.id] as MafiaRole,
        alive: p.alive,
      })),
    };
  }
}