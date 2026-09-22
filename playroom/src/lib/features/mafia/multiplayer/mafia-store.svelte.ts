/**
 * Mafia multiplayer — frontend state projection (Svelte 5 runes store).
 *
 * One instance per room. It owns the WebSocket transport and projects inbound
 * server frames into a small reactive model:
 *
 *   room          – public room roster (host, membership)
 *   publicState   – identical-for-everyone engine view (no hidden info)
 *   privateState  – this device's own engine view (role, pending action)
 *   narratorState – host-only engine view, used ONLY for phase-advance
 *                   affordances (advance/resolve buttons). Never rendered.
 *   connection    – transport lifecycle (connecting/open/reconnecting/gone)
 *   errors        – transient action/message errors, auto-dismissed
 *
 * Svelte components consume these derived values and call the action methods;
 * they never parse protocol frames themselves.
 */
import { SvelteSet } from 'svelte/reactivity';
import { MafiaClient } from './mafia-client';
import { getIdentity, clearIdentity, type PlayerIdentity } from './identity';
import * as api from './api';
import type {
	MafiaActionType,
	MafiaClientAction,
	MafiaNarratorState,
	MafiaPhase,
	MafiaPlayerState,
	MafiaPublicPlayer,
	MafiaPublicState,
	MafiaRole,
	MafiaTeam,
	ServerMessage,
	PublicRoom,
	ConnectionState
} from './types';

const ERROR_LABELS: Partial<Record<string, string>> = {
	ACTION_FORBIDDEN: 'That action is not allowed for your connection.',
	ACTION_ALREADY_SUBMITTED: 'You have already submitted a choice this round.',
	INVALID_PHASE: 'That action isn\u2019t available in this phase.',
	INVALID_ACTOR: 'That action belongs to someone else.',
	INVALID_TARGET: 'Choose a different player \u2014 that target isn\u2019t valid.',
	PLAYER_DEAD: 'You\u2019re out, so you can\u2019t take that action.',
	NOT_ENOUGH_PLAYERS: 'Need at least 4 players to start.',
	NOT_ALL_READY: 'Everyone must mark ready before the game starts.',
	DOCTOR_REPEAT_GUARD: 'You already protected that player last night.',
	MISSING_REQUIRED_ACTION: 'A required choice is still missing.',
	GAME_OVER: 'The game has already ended.'
} satisfies Partial<Record<string, string>>;

const GAME_OVER_LABELS: Record<MafiaTeam, string> = {
	MAFIA: 'The Mafia win.',
	TOWN: 'The Town wins.'
};

const PHASE_LABELS: Record<MafiaPhase, string> = {
	LOBBY: 'Lobby',
	ROLE_REVEAL: 'Your role',
	NIGHT: 'Night',
	MORNING: 'Morning',
	DISCUSSION: 'Discussion',
	VOTING: 'Voting',
	VOTE_RESULT: 'Vote result',
	GAME_OVER: 'Game over'
};

const ROLE_LABELS: Record<MafiaRole, string> = {
	MAFIA: 'Mafia',
	DOCTOR: 'Doctor',
	DETECTIVE: 'Detective',
	VILLAGER: 'Villager'
};

const ROLE_DESCRIPTIONS: Record<MafiaRole, string> = {
	MAFIA: 'Each night, choose who is eliminated.',
	DOCTOR: 'Each night, protect someone from elimination.',
	DETECTIVE: 'Each night, investigate whether a player is the Mafia.',
	VILLAGER: 'During the day, vote out the Mafia.'
};

export interface MafiaError {
	id: number;
	code: string;
	message: string;
}

let nextErrorId = 1;

export class MafiaStore {
	readonly roomCode: string;
	readonly identity: PlayerIdentity | null;

	room = $state<PublicRoom | null>(null);
	publicState = $state<MafiaPublicState | null>(null);
	privateState = $state<MafiaPlayerState | null>(null);
	narratorState = $state<MafiaNarratorState | null>(null);
	connection = $state<ConnectionState>('idle');
	/** Terminal, non-dismissable reason the room is unreachable for this device. */
	fatal = $state<string | null>(null);
	errors = $state<MafiaError[]>([]);

	private readonly client: MafiaClient;
	private readonly errorTimeouts = new SvelteSet<ReturnType<typeof setTimeout>>();

	constructor(roomCode: string) {
		this.roomCode = roomCode.toUpperCase();
		this.identity = getIdentity(this.roomCode);
		this.client = new MafiaClient({
			onStatus: (status) => {
				this.connection = status;
				if (status === 'gone' && this.fatal === null) {
					this.fatal =
						'This room is no longer available. It may have closed, or you may have been removed.';
				}
				if (status === 'open') {
					this.fatal = null;
				}
			},
			onMessage: (message) => this.handle(message)
		});
	}

	// ---------------------------------------------------------------------------
	// Derived state (what components read)
	// ---------------------------------------------------------------------------

	phase = $derived(this.publicState?.phase ?? null);

	players = $derived.by<MafiaPublicPlayer[]>(() => {
		const roster = this.room?.players ?? [];
		if (roster.length === 0) return this.publicState?.players ?? [];
		const engine = this.publicState?.players;
		return roster.map((player) => {
			const enginePlayer = engine?.find((candidate) => candidate.id === player.id);
			return {
				id: player.id,
				name: player.name,
				alive: enginePlayer?.alive ?? true,
				ready: enginePlayer?.ready ?? false
			};
		});
	});

	livingPlayers = $derived(this.players.filter((player) => player.alive));

	me = $derived(this.room?.players.find((player) => player.id === this.identity?.playerId) ?? null);

	isHost = $derived(this.me?.isHost ?? false);

	myReady = $derived(this.privateState?.ready ?? false);

	myRole = $derived(this.privateState?.role ?? null);

	myAlive = $derived(this.privateState?.alive ?? true);

	availableActions = $derived<MafiaActionType[]>(this.privateState?.availableActions ?? []);

	can = (action: MafiaActionType): boolean => this.availableActions.includes(action);

	/** True only in-editor; minimal mix of influence for error mapping. */
	phaseLabel = $derived(
		this.phase === null ? 'Connecting' : (PHASE_LABELS[this.phase] ?? this.phase)
	);

	/** Host-only advance affordances derived from the narrator view. */
	allRolesSeen = $derived(
		this.narratorState !== null &&
			Object.keys(this.narratorState.roleSeen).length > 0 &&
			Object.values(this.narratorState.roleSeen).every(Boolean)
	);

	nightPending = $derived(
		(this.narratorState?.nightActions &&
			[
				this.narratorState.nightActions.kill,
				this.narratorState.nightActions.save,
				this.narratorState.nightActions.investigate
			].filter((slot) => slot.status === 'NOT_ACTED').length) ??
			0
	);

	allVoted = $derived(
		this.publicState?.voting !== null &&
			this.publicState?.voting !== undefined &&
			this.publicState.voting.cast === this.publicState.voting.total
	);

	winnerLabel = $derived(
		this.publicState?.winner ? GAME_OVER_LABELS[this.publicState.winner] : null
	);

	roleName = (role: MafiaRole | null): string => (role === null ? '—' : ROLE_LABELS[role]);

	roleDescription = (role: MafiaRole | null): string =>
		role === null ? '' : ROLE_DESCRIPTIONS[role];

	// ---------------------------------------------------------------------------
	// Lifecycle
	// ---------------------------------------------------------------------------

	connect(): void {
		if (this.identity === null) return;
		this.client.connect(this.roomCode, this.identity.playerId);
	}

	reconnectNow(): void {
		this.client.reconnectNow();
	}

	dispose(): void {
		this.client.disconnect();
		this.clearErrorTimeouts();
	}

	async leave(): Promise<void> {
		const identity = this.identity;
		if (identity) {
			this.dispose();
			this.clearIdentityNow();
			await api.leaveRoom(this.roomCode, identity.playerId);
		}
	}

	// ---------------------------------------------------------------------------
	// Actions (components call these; protocol internals stay here)
	// ---------------------------------------------------------------------------

	ready(): void {
		const identity = this.identity;
		if (!identity) return;
		this.send(
			this.myReady
				? { type: 'UNREADY', playerId: identity.playerId }
				: { type: 'READY', playerId: identity.playerId }
		);
	}

	reportRoleSeen(): void {
		const identity = this.identity;
		if (!identity) return;
		this.send({ type: 'ROLE_SEEN', playerId: identity.playerId });
	}

	advance(): void {
		if (this.phase === 'ROLE_REVEAL') this.send({ type: 'BEGIN_NIGHT' });
		else if (this.phase === 'NIGHT')
			this.send(this.nightPending === 0 ? { type: 'RESOLVE_NIGHT' } : { type: 'ADVANCE_PHASE' });
		else if (this.phase === 'MORNING') this.send({ type: 'START_DISCUSSION' });
		else if (this.phase === 'DISCUSSION') this.send({ type: 'START_VOTING' });
		else if (this.phase === 'VOTING') this.send({ type: 'END_VOTING' });
		else if (this.phase === 'VOTE_RESULT') this.send({ type: 'ADVANCE_PHASE' });
	}

	startGame(): void {
		this.send({ type: 'START_GAME' });
	}

	playAgain(): void {
		this.send({ type: 'PLAY_AGAIN' });
	}

	nightAction(
		kind: 'MAFIA_KILL' | 'DOCTOR_SAVE' | 'DETECTIVE_INVESTIGATE',
		targetId: string | null
	): void {
		if (kind === 'DOCTOR_SAVE') {
			this.send({ type: 'DOCTOR_SAVE', targetId });
		} else {
			this.send({ type: kind, targetId: targetId ?? this.identity?.playerId ?? '' });
		}
	}

	castVote(targetId: string): void {
		const identity = this.identity;
		if (identity) this.send({ type: 'CAST_VOTE', voterId: identity.playerId, targetId });
	}

	dismissError(id: number): void {
		this.errors = this.errors.filter((error) => error.id !== id);
	}

	// ---------------------------------------------------------------------------
	// Internals
	// ---------------------------------------------------------------------------

	private send(action: MafiaClientAction): void {
		this.client.send(action);
	}

	private handle(message: ServerMessage): void {
		switch (message.type) {
			case 'connected':
				break;
			case 'room.updated': {
				const updatedRoom = message.room;
				if (!updatedRoom) {
					this.connection = 'gone';
					this.fatal = 'This room has closed.';
					return;
				}
				this.room = updatedRoom;
				const playerId = this.identity?.playerId;
				if (playerId && !updatedRoom.players.some((player) => player.id === playerId)) {
					this.connection = 'gone';
					this.fatal = 'You have been removed from this room.';
				}
				break;
			}
			case 'mafia.state':
				this.publicState = message.state;
				break;
			case 'mafia.private':
				this.privateState = message.state;
				break;
			case 'mafia.narrator':
				this.narratorState = message.state;
				break;
			case 'mafia.error':
				this.raiseError(message.code, ERROR_LABELS[message.code] ?? message.message);
				break;
			case 'error':
				this.raiseError(message.code, message.message);
				break;
			case 'pong':
				break;
		}
	}

	private raiseError(code: string, message: string): void {
		const id = nextErrorId++;
		this.errors = [...this.errors, { id, code, message }];
		const timer = setTimeout(() => {
			this.dismissError(id);
			this.errorTimeouts.delete(timer);
		}, 5000);
		this.errorTimeouts.add(timer);
	}

	private clearIdentityNow(): void {
		clearIdentity(this.roomCode);
	}

	private clearErrorTimeouts(): void {
		for (const timer of this.errorTimeouts) {
			clearTimeout(timer);
		}
		this.errorTimeouts.clear();
	}
}
