/**
 * Narrator (Mode C) Mafia — frontend view model.
 *
 * Straight mirror of the backend adapter contract
 * (backend/src/games/mafia/adapters/narrator/types.ts). One device, one
 * narrator: every screen carries exactly what the controller computed, with
 * hidden truth by design. This state is privileged — it must never be routed
 * through the shared room/player channels.
 */
import type { MafiaRole, MafiaTeam, NightActionStatus } from '../multiplayer/types';

export type NightActionType = 'MAFIA_KILL' | 'DOCTOR_SAVE' | 'DETECTIVE_INVESTIGATE';

export interface NarratorPublicPlayer {
	id: string;
	name: string;
	alive: boolean;
}

export interface NarratorSetupPlayer {
	id: string;
	name: string;
	ready: boolean;
}

export interface NarratorRoleRow {
	id: string;
	name: string;
	role: MafiaRole;
}

export interface NarratorNightSlot {
	action: NightActionType;
	status: NightActionStatus;
	targetId: string | null;
	targetName: string | null;
	/** For DETECTIVE_INVESTIGATE: the verdict (is the target Mafia?). Populated immediately after the detective acts. */
	verdict: boolean | null;
}

export interface NarratorVote {
	voterId: string;
	voterName: string;
	targetId: string;
	targetName: string;
}

export interface NarratorInvestigation {
	nightNumber: number;
	targetId: string;
	targetName: string;
	isMafia: boolean;
}

export type NarratorView =
	| {
			kind: 'LOBBY';
			players: NarratorSetupPlayer[];
			minPlayers: number;
			maxPlayers: number;
			canStart: boolean;
	  }
	| { kind: 'ROLE_REVEAL'; players: NarratorRoleRow[] }
	| {
			kind: 'NIGHT';
			nightNumber: number;
			actingMafiaName: string;
			players: NarratorPublicPlayer[];
			kill: NarratorNightSlot;
			save: NarratorNightSlot;
			investigate: NarratorNightSlot;
	  }
	| {
			kind: 'MORNING';
			nightNumber: number;
			deaths: NarratorPublicPlayer[];
			investigation: NarratorInvestigation | null;
			players: NarratorPublicPlayer[];
	  }
	| { kind: 'DISCUSSION'; nightNumber: number; players: NarratorPublicPlayer[] }
	| {
			kind: 'VOTING';
			nightNumber: number;
			votes: NarratorVote[];
			votersLeft: NarratorPublicPlayer[];
			casts: number;
			total: number;
	  }
	| {
			kind: 'VOTE_RESULT';
			nightNumber: number;
			votes: NarratorVote[];
			eliminatedPlayer: NarratorPublicPlayer | null;
			tie: boolean;
			players: NarratorPublicPlayer[];
	  }
	| {
			kind: 'GAME_OVER';
			winner: MafiaTeam;
			players: Array<{ id: string; name: string; role: MafiaRole; alive: boolean }>;
	  };
