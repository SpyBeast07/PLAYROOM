/**
 * Mafia multiplayer — wire types.
 *
 * Mirrors the backend Mafia protocol (backend/src/games/mafia/types.ts,
 * mafia-protocol.ts) plus the room API. The Svelte components never touch
 * these directly through the WebSocket: MafiaClient transports them and
 * MafiaStore projects them into component state.
 */

// -----------------------------------------------------------------------------
// Room (backend/src/rooms/types.ts, public slice)
// -----------------------------------------------------------------------------

export type RoomStatus = 'waiting' | 'playing';

export interface PublicPlayer {
	id: string;
	name: string;
	isHost: boolean;
}

export interface PublicRoom {
	code: string;
	status: RoomStatus;
	players: PublicPlayer[];
	createdAt: number;
}

// -----------------------------------------------------------------------------
// Mafia engine views (backend/src/games/mafia/types.ts)
// -----------------------------------------------------------------------------

export type MafiaPhase =
	| 'LOBBY'
	| 'ROLE_REVEAL'
	| 'NIGHT'
	| 'MORNING'
	| 'DISCUSSION'
	| 'VOTING'
	| 'VOTE_RESULT'
	| 'GAME_OVER';

export type MafiaRole = 'MAFIA' | 'DOCTOR' | 'DETECTIVE' | 'VILLAGER';

export type MafiaTeam = 'MAFIA' | 'TOWN';

export interface MafiaPublicPlayer {
	id: string;
	name: string;
	alive: boolean;
	ready: boolean;
}

export interface MafiaPublicState {
	gameId: string;
	phase: MafiaPhase;
	nightNumber: number;
	players: MafiaPublicPlayer[];
	winner: MafiaTeam | null;
	revealedRoles: Record<string, MafiaRole> | null;
	voting: { cast: number; total: number } | null;
	morningDeaths: string[] | null;
	elimination: { eliminatedPlayerId: string | null } | null;
}

export type NightActionStatus = 'NOT_ACTED' | 'SUBMITTED' | 'PASSED' | 'SKIPPED';

export type MafiaPrivateNightResult =
	| { kind: 'INVESTIGATION'; nightNumber: number; targetId: string; isMafia: boolean }
	| { kind: 'HEAL'; nightNumber: number; applied: boolean; targetId: string | null };

export interface MafiaPlayerState {
	playerId: string;
	name: string;
	role: MafiaRole | null;
	alive: boolean;
	ready: boolean;
	roleSeen: boolean;
	phase: MafiaPhase;
	nightNumber: number;
	availableActions: MafiaActionType[];
	ownNightAction: NightActionStatus | null;
	ownPrivateNightResult: MafiaPrivateNightResult | null;
	ownVoteTargetId: string | null;
}

// -----------------------------------------------------------------------------
// Actions a client may submit (actor is always supplied server-side)
// -----------------------------------------------------------------------------

export type MafiaActionType =
	| 'READY'
	| 'UNREADY'
	| 'ROLE_SEEN'
	| 'START_GAME'
	| 'BEGIN_NIGHT'
	| 'MAFIA_KILL'
	| 'DOCTOR_SAVE'
	| 'DETECTIVE_INVESTIGATE'
	| 'RESOLVE_NIGHT'
	| 'START_DISCUSSION'
	| 'START_VOTING'
	| 'CAST_VOTE'
	| 'END_VOTING'
	| 'ADVANCE_PHASE'
	| 'PLAY_AGAIN';

export type MafiaClientAction =
	| { type: 'READY'; playerId: string }
	| { type: 'UNREADY'; playerId: string }
	| { type: 'ROLE_SEEN'; playerId: string }
	| { type: 'START_GAME' }
	| { type: 'BEGIN_NIGHT' }
	| { type: 'MAFIA_KILL'; targetId: string }
	| { type: 'DOCTOR_SAVE'; targetId: string | null }
	| { type: 'DETECTIVE_INVESTIGATE'; targetId: string }
	| { type: 'RESOLVE_NIGHT' }
	| { type: 'START_DISCUSSION' }
	| { type: 'START_VOTING' }
	| { type: 'CAST_VOTE'; voterId: string; targetId: string }
	| { type: 'END_VOTING' }
	| { type: 'ADVANCE_PHASE' }
	| { type: 'PLAY_AGAIN' };

// -----------------------------------------------------------------------------
// Narrator view (host connection only) — used for phase-advance affordances.
// Never rendered; never reveals hidden information through shared components.
// -----------------------------------------------------------------------------

export interface MafiaNightAction {
	status: NightActionStatus;
	targetId: string | null;
}

export interface MafiaNarratorState {
	publicState: MafiaPublicState;
	roles: Record<string, MafiaRole>;
	readyState: Record<string, boolean>;
	roleSeen: Record<string, boolean>;
	actingMafiaId: string | null;
	nightActions: {
		nightNumber: number;
		actingMafiaId: string;
		kill: MafiaNightAction;
		save: MafiaNightAction;
		investigate: MafiaNightAction;
	} | null;
	votes: Record<string, string> | null;
}

// -----------------------------------------------------------------------------
// WebSocket messages (backend/src/realtime/types.ts + mafia-protocol.ts)
// -----------------------------------------------------------------------------

export type ServerMessage =
	| { type: 'connected'; playerId: string }
	| { type: 'room.updated'; room: PublicRoom }
	| { type: 'pong' }
	| { type: 'error'; code: string; message: string }
	| { type: 'mafia.state'; state: MafiaPublicState }
	| { type: 'mafia.private'; state: MafiaPlayerState }
	| { type: 'mafia.narrator'; state: MafiaNarratorState }
	| { type: 'mafia.error'; code: string; message: string };

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'gone';
