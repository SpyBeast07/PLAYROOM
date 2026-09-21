/**
 * Mafia engine — genuine domain constants.
 * No speculative configuration systems. Values come from docs/mafia-spec.md §3-4.
 */
import type {
  MafiaActionType,
  MafiaGameMode,
  MafiaPhase,
  MafiaRole,
  MafiaTeam,
  NightActionType,
} from "./types.ts";

export const MIN_PLAYERS = 4;
export const MAX_PLAYERS = 20;
/** Engine-level display-name rule (mirrors the room layer). */
export const MAX_PLAYER_NAME_LENGTH = 20;

export const MAFIA_ROLES: readonly MafiaRole[] = [
  "MAFIA",
  "DOCTOR",
  "DETECTIVE",
  "VILLAGER",
];

export const MAFIA_PHASES: readonly MafiaPhase[] = [
  "LOBBY",
  "ROLE_REVEAL",
  "NIGHT",
  "MORNING",
  "DISCUSSION",
  "VOTING",
  "VOTE_RESULT",
  "GAME_OVER",
];

export const MAFIA_TEAMS: readonly MafiaTeam[] = ["MAFIA", "TOWN"];

export const MAFIA_MODES: readonly MafiaGameMode[] = [
  "PASS_THE_PHONE",
  "MULTIPLAYER",
  "NARRATOR",
];

export const MAFIA_ACTION_TYPES: readonly MafiaActionType[] = [
  "JOIN",
  "LEAVE",
  "READY",
  "UNREADY",
  "START_GAME",
  "ROLE_SEEN",
  "BEGIN_NIGHT",
  "MAFIA_KILL",
  "DOCTOR_SAVE",
  "DETECTIVE_INVESTIGATE",
  "RESOLVE_NIGHT",
  "START_DISCUSSION",
  "START_VOTING",
  "CAST_VOTE",
  "END_VOTING",
  "ADVANCE_PHASE",
  "PLAY_AGAIN",
  "PLAYER_UNAVAILABLE",
];

/** Fixed conceptual order of night contributions (spec 9.1): Mafia -> Doctor -> Detective. */
export const NIGHT_ACTION_ORDER: readonly NightActionType[] = [
  "MAFIA_KILL",
  "DOCTOR_SAVE",
  "DETECTIVE_INVESTIGATE",
];

export interface MafiaRoleCounts {
  mafia: number;
  doctor: number;
  detective: number;
  villager: number;
}

/**
 * Role distribution by player count (spec 4). Deterministic; the engine shuffles
 * these slots across players at START_GAME (Phase 10B). Formula for reference:
 * Mafia = 1 for 4-7, else floor(count/4); Doctor/Detective = 1; rest Villager.
 */
export const ROLE_DISTRIBUTION: Readonly<Record<number, MafiaRoleCounts>> = {
  4: { mafia: 1, doctor: 1, detective: 1, villager: 1 },
  5: { mafia: 1, doctor: 1, detective: 1, villager: 2 },
  6: { mafia: 1, doctor: 1, detective: 1, villager: 3 },
  7: { mafia: 1, doctor: 1, detective: 1, villager: 4 },
  8: { mafia: 2, doctor: 1, detective: 1, villager: 4 },
  9: { mafia: 2, doctor: 1, detective: 1, villager: 5 },
  10: { mafia: 2, doctor: 1, detective: 1, villager: 6 },
  11: { mafia: 2, doctor: 1, detective: 1, villager: 7 },
  12: { mafia: 3, doctor: 1, detective: 1, villager: 7 },
  13: { mafia: 3, doctor: 1, detective: 1, villager: 8 },
  14: { mafia: 3, doctor: 1, detective: 1, villager: 9 },
  15: { mafia: 3, doctor: 1, detective: 1, villager: 10 },
  16: { mafia: 4, doctor: 1, detective: 1, villager: 10 },
  17: { mafia: 4, doctor: 1, detective: 1, villager: 11 },
  18: { mafia: 4, doctor: 1, detective: 1, villager: 12 },
  19: { mafia: 5, doctor: 1, detective: 1, villager: 12 },
  20: { mafia: 5, doctor: 1, detective: 1, villager: 13 },
};

export function roleCountsForPlayerCount(playerCount: number): MafiaRoleCounts {
  const counts = ROLE_DISTRIBUTION[playerCount];
  if (counts === undefined) {
    throw new RangeError(
      `No role distribution for ${playerCount} players (must be in [${MIN_PLAYERS}, ${MAX_PLAYERS}])`,
    );
  }
  return { ...counts };
}

export function totalPlayerCount(counts: MafiaRoleCounts): number {
  return counts.mafia + counts.doctor + counts.detective + counts.villager;
}