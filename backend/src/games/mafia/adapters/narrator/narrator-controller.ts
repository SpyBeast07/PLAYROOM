/**
 * Narrator (Mode C) Mafia adapter.
 *
 *   Narrator UI → NarratorController → MafiaEngine
 *
 * The narrator is the sole controller of a physical game: players never touch
 * a device. The controller is authoritative-human: every engine action it sends
 * is dispatched as `NARRATOR` (the engine records a player's spoken choice on
 * their behalf — target/life checks still apply), and every view is derived
 * from the engine's own privileged narrator view (`getNarratorState`).
 *
 * It is deliberately NOT a second state machine: roles, acting Mafia, night
 * inputs, verdicts, deaths, votes, eliminations and winners all come from the
 * engine. The adapter owns nothing but the roster entry (engine LOBBY, id
 * minting) — there is no handoff choreography in narrator mode.
 *
 * SECURITY: narrator state is privileged and local-only. Nothing this adapter
 * produces may be routed through the multiplayer player channels; it lives
 * purely in `adapters/narrator/` and never touches the session/protocol layers.
 */
import { createMafiaGame, type MafiaEngine } from "../../mafia-engine.ts";
import { MAX_PLAYERS, MIN_PLAYERS } from "../../constants.ts";
import type {
  MafiaEngineError,
  MafiaEngineResult,
  MafiaNarratorState,
  MafiaNightAction,
  MafiaRole,
  MafiaTeam,
  NightActionType,
  PlayerId,
} from "../../types.ts";
import type {
  NarratorInvestigation,
  NarratorNightSlot,
  NarratorPublicPlayer,
  NarratorResult,
  NarratorRoleRow,
  NarratorSetupPlayer,
  NarratorVote,
  NarratorView,
} from "./types.ts";

const NARRATOR = { type: "NARRATOR" } as const;

export interface NarratorControllerOptions {
  /** Determinism injection for role shuffling (passed straight to the engine). */
  random?: () => number;
  /** Test seam: stable player-id minting. Defaults to "p1", "p2", … */
  createId?: () => string;
}

export class NarratorController {
  private engine: MafiaEngine;
  private idCounter = 0;

  constructor(private readonly options: NarratorControllerOptions = {}) {
    this.engine = createMafiaGame({
      mode: "NARRATOR",
      players: [],
      random: options.random ?? Math.random,
    });
  }

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  /** The current narrator screen, derived exclusively from `getNarratorState()`. */
  getView(): NarratorView {
    const n = this.engine.getNarratorState();
    switch (n.publicState.phase) {
      case "LOBBY":
        return this.lobbyView(n);
      case "ROLE_REVEAL":
        return this.roleRevealView(n);
      case "NIGHT":
        return this.nightView(n);
      case "MORNING":
        return this.morningView(n);
      case "DISCUSSION":
        return this.discussionView(n);
      case "VOTING":
        return this.votingView(n);
      case "VOTE_RESULT":
        return this.voteResultView(n);
      case "GAME_OVER":
        return this.gameOverView(n);
    }
  }

  // ---------------------------------------------------------------------------
  // Lobby / setup
  // ---------------------------------------------------------------------------

  addPlayer(name: string): NarratorResult {
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

  removePlayer(playerId: PlayerId): NarratorResult {
    if (this.engine.getPublicState().phase !== "LOBBY") {
      return this.wrongStep("Players can only be removed before the game starts");
    }
    return this.resultOf(this.engine.dispatch({ type: "LEAVE", actor: NARRATOR, playerId }));
  }

  /** Readiness is implicit in narrator mode: READY everyone, then START_GAME. */
  startGame(): NarratorResult {
    if (this.engine.getPublicState().phase !== "LOBBY") {
      return this.wrongStep("Only a lobby can be started");
    }
    for (const player of this.engine.getPublicState().players) {
      const ready = this.engine.dispatch({ type: "READY", actor: NARRATOR, playerId: player.id });
      if (!ready.success) return this.engineFail(ready.error);
    }
    const start = this.engine.dispatch({ type: "START_GAME", actor: NARRATOR });
    if (!start.success) return this.engineFail(start.error);
    return this.okResult();
  }

  /** Same roster, fresh lobby (engine's PLAY_AGAIN). */
  playAgain(): NarratorResult {
    if (this.engine.getPublicState().phase !== "GAME_OVER") {
      return this.wrongStep("Only a finished game can be replayed");
    }
    return this.resultOf(this.engine.dispatch({ type: "PLAY_AGAIN", actor: NARRATOR }));
  }

  /** Start over completely: fresh engine, empty roster. */
  resetGame(): NarratorView {
    this.engine = createMafiaGame({
      mode: "NARRATOR",
      players: [],
      random: this.options.random ?? Math.random,
    });
    return this.getView();
  }

  // ---------------------------------------------------------------------------
  // Role reveal → night
  // ---------------------------------------------------------------------------

  /** The narrator has told every player their role; begin the first night. */
  beginNight(): NarratorResult {
    if (this.engine.getPublicState().phase !== "ROLE_REVEAL") {
      return this.wrongStep("The night begins from role reveal");
    }
    return this.resultOf(this.engine.dispatch({ type: "BEGIN_NIGHT", actor: NARRATOR }));
  }

  // ---------------------------------------------------------------------------
  // Night
  // ---------------------------------------------------------------------------

  /**
   * Record the narrator's reading of a player's spoken night choice.
   * `targetId = null` is only valid for the Doctor deliberately passing
   * (engine `DOCTOR_SAVE` with no target).
   */
  recordNightAction(action: NightActionType, targetId: PlayerId | null): NarratorResult {
    if (this.engine.getPublicState().phase !== "NIGHT") {
      return this.wrongStep("Night actions can only be recorded during the night");
    }
    if (action !== "DOCTOR_SAVE" && targetId === null) {
      return this.engineFail({ code: "INVALID_TARGET", message: "This action requires a target" });
    }
    const result = this.dispatchNightAction(action, targetId);
    if (!result.success) return this.engineFail(result.error);
    return this.okResult();
  }

  /** Resolve the night normally (kill required; engine computes the outcome). */
  resolveNight(): NarratorResult {
    if (this.engine.getPublicState().phase !== "NIGHT") {
      return this.wrongStep("There is no night to resolve");
    }
    return this.resultOf(this.engine.dispatch({ type: "RESOLVE_NIGHT", actor: NARRATOR }));
  }

  // ---------------------------------------------------------------------------
  // Day: announcements, discussion, recorded votes
  // ---------------------------------------------------------------------------

  startDiscussion(): NarratorResult {
    if (this.engine.getPublicState().phase !== "MORNING") {
      return this.wrongStep("Discussion starts from the morning announcement");
    }
    return this.resultOf(this.engine.dispatch({ type: "START_DISCUSSION", actor: NARRATOR }));
  }

  startVoting(): NarratorResult {
    if (this.engine.getPublicState().phase !== "DISCUSSION") {
      return this.wrongStep("Voting starts from discussion");
    }
    return this.resultOf(this.engine.dispatch({ type: "START_VOTING", actor: NARRATOR }));
  }

  /** Record one living player's spoken vote (the engine validates voter/target). */
  recordVote(voterId: PlayerId, targetId: PlayerId): NarratorResult {
    if (this.engine.getPublicState().phase !== "VOTING") {
      return this.wrongStep("Votes can only be recorded during voting");
    }
    return this.resultOf(
      this.engine.dispatch({ type: "CAST_VOTE", actor: NARRATOR, voterId, targetId }),
    );
  }

  /** End voting early (sealed by END_VOTING). */
  endVoting(): NarratorResult {
    if (this.engine.getPublicState().phase !== "VOTING") {
      return this.wrongStep("No voting round is open");
    }
    return this.resultOf(this.engine.dispatch({ type: "END_VOTING", actor: NARRATOR }));
  }

  // ---------------------------------------------------------------------------
  // Generic phase advance
  // ---------------------------------------------------------------------------

  /**
   * The narrator's "next" button: whatever the engine's meta-action supports
   * from the current phase — MORNING→DISCUSSION, DISCUSSION→VOTING,
   * VOTING→VOTE_RESULT, VOTE_RESULT→NIGHT, NIGHT→force-resolved (skipping any
   * still-pending slot), and ROLE_REVEAL→NIGHT.
   */
  advancePhase(): NarratorResult {
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

  private okResult(): NarratorResult {
    return { ok: true, view: this.getView() };
  }

  private resultOf(result: MafiaEngineResult): NarratorResult {
    if (!result.success) return this.engineFail(result.error);
    return this.okResult();
  }

  private engineFail(error: MafiaEngineError): NarratorResult {
    return { ok: false, error };
  }

  private wrongStep(message: string): NarratorResult {
    return { ok: false, error: { code: "INVALID_STEP", message } };
  }

  private dispatchNightAction(action: NightActionType, targetId: PlayerId | null): MafiaEngineResult {
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
  // View builders (all purely derived from getNarratorState)
  // ---------------------------------------------------------------------------

  private lobbyView(n: MafiaNarratorState): NarratorView {
    const players: NarratorSetupPlayer[] = n.publicState.players.map((p) => ({
      id: p.id,
      name: p.name,
      ready: p.ready,
    }));
    return {
      kind: "LOBBY",
      players,
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      canStart: players.length >= MIN_PLAYERS && players.length <= MAX_PLAYERS,
    };
  }

  private roleRevealView(n: MafiaNarratorState): NarratorView {
    const players: NarratorRoleRow[] = n.publicState.players.map((p) => ({
      id: p.id,
      name: p.name,
      role: n.roles[p.id] as MafiaRole,
    }));
    return { kind: "ROLE_REVEAL", players };
  }

  private nightView(n: MafiaNarratorState): NarratorView {
    const slots = n.nightActions;
    if (slots === null) return this.lobbyView(n); // defensive; unreachable mid-night
    const slot = (action: NightActionType, s: MafiaNightAction): NarratorNightSlot => ({
      action,
      status: s.status,
      targetId: s.targetId,
      targetName: s.targetId !== null ? this.nameOf(n, s.targetId) : null,
    });
    return {
      kind: "NIGHT",
      nightNumber: n.publicState.nightNumber,
      actingMafiaName: this.nameOf(n, n.actingMafiaId ?? ""),
      players: this.publicPlayers(n),
      kill: slot("MAFIA_KILL", slots.kill),
      save: slot("DOCTOR_SAVE", slots.save),
      investigate: slot("DETECTIVE_INVESTIGATE", slots.investigate),
    };
  }

  private morningView(n: MafiaNarratorState): NarratorView {
    const deaths = (n.publicState.morningDeaths ?? [])
      .map((id) => this.publicPlayerOf(n, id))
      .filter((p): p is NarratorPublicPlayer => p !== null);
    const resolved = n.lastResolvedNight;
    const investigation: NarratorInvestigation | null =
      resolved !== null && resolved.investigatedTargetId !== null && resolved.investigationVerdict !== null
        ? {
            nightNumber: resolved.nightNumber,
            targetId: resolved.investigatedTargetId,
            targetName: this.nameOf(n, resolved.investigatedTargetId),
            isMafia: resolved.investigationVerdict,
          }
        : null;
    return {
      kind: "MORNING",
      nightNumber: n.publicState.nightNumber,
      deaths,
      investigation,
      players: this.publicPlayers(n),
    };
  }

  private discussionView(n: MafiaNarratorState): NarratorView {
    return {
      kind: "DISCUSSION",
      nightNumber: n.publicState.nightNumber,
      players: this.publicPlayers(n),
    };
  }

  private votingView(n: MafiaNarratorState): NarratorView {
    const voting = n.publicState.voting;
    const votersLeft = n.publicState.players.filter(
      (p) => p.alive && (n.votes ?? {})[p.id] === undefined,
    );
    return {
      kind: "VOTING",
      nightNumber: n.publicState.nightNumber,
      votes: this.votes(n),
      votersLeft: votersLeft.map((p) => ({ id: p.id, name: p.name, alive: p.alive })),
      casts: voting?.cast ?? 0,
      total: voting?.total ?? 0,
    };
  }

  private voteResultView(n: MafiaNarratorState): NarratorView {
    const eliminatedId = n.lastElimination?.eliminatedPlayerId ?? null;
    return {
      kind: "VOTE_RESULT",
      nightNumber: n.publicState.nightNumber,
      votes: this.votes(n),
      eliminatedPlayer: eliminatedId !== null ? this.publicPlayerOf(n, eliminatedId) : null,
      tie: n.lastElimination?.tie ?? false,
      players: this.publicPlayers(n),
    };
  }

  private gameOverView(n: MafiaNarratorState): NarratorView {
    const revealed = n.publicState.revealedRoles ?? n.roles;
    return {
      kind: "GAME_OVER",
      winner: n.publicState.winner as MafiaTeam,
      players: n.publicState.players.map((p) => ({
        id: p.id,
        name: p.name,
        role: revealed[p.id] as MafiaRole,
        alive: p.alive,
      })),
    };
  }

  private publicPlayers(n: MafiaNarratorState): NarratorPublicPlayer[] {
    return n.publicState.players.map((p) => ({ id: p.id, name: p.name, alive: p.alive }));
  }

  private publicPlayerOf(n: MafiaNarratorState, id: PlayerId): NarratorPublicPlayer | null {
    const player = n.publicState.players.find((p) => p.id === id);
    if (player === undefined) return null;
    return { id: player.id, name: player.name, alive: player.alive };
  }

  private nameOf(n: MafiaNarratorState, id: PlayerId): string {
    return n.publicState.players.find((p) => p.id === id)?.name ?? id;
  }

  private votes(n: MafiaNarratorState): NarratorVote[] {
    return Object.entries(n.votes ?? {}).map(([voterId, targetId]) => ({
      voterId,
      voterName: this.nameOf(n, voterId),
      targetId: targetId as PlayerId,
      targetName: this.nameOf(n, targetId as PlayerId),
    }));
  }
}