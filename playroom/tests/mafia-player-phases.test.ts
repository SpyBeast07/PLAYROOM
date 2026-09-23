/**
 * Frontend regression: the public player list must stay visible AND identical
 * for every role across the whole game lifecycle.
 *
 * Regression target: phase components previously dropped the shared
 * `<PlayerList>` — RoleReveal, Night, Morning, Voting and VoteResult rendered
 * no roster at all, so the list vanished for Mafia, Doctor, Detective and
 * villager alike the moment the game left the Lobby. These tests pin the
 * rendering contract: every role sees exactly the same public roster (names,
 * alive/dead, host, ready in the lobby) on every phase, with no hidden info in
 * the list body.
 *
 * The store is driven directly (room + public + private state are injectable
 * `$state` fields); no WebSocket is opened. `identity` is null in the node
 * test runtime, which is exactly what lets us assert that the list markup is
 * byte-identical across roles (no "(you)" suffix, no host differences).
 */
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';

import Discussion from '$lib/features/mafia/components/Discussion.svelte';
import GameOver from '$lib/features/mafia/components/GameOver.svelte';
import Lobby from '$lib/features/mafia/components/Lobby.svelte';
import Morning from '$lib/features/mafia/components/Morning.svelte';
import Night from '$lib/features/mafia/components/Night.svelte';
import RoleReveal from '$lib/features/mafia/components/RoleReveal.svelte';
import VoteResult from '$lib/features/mafia/components/VoteResult.svelte';
import Voting from '$lib/features/mafia/components/Voting.svelte';
import { MafiaStore } from '$lib/features/mafia/multiplayer/mafia-store.svelte';
import type {
	MafiaActionType,
	MafiaPhase,
	MafiaPlayerState,
	MafiaPublicPlayer,
	MafiaPublicState,
	MafiaRole,
	MafiaTeam,
	PublicRoom
} from '$lib/features/mafia/multiplayer/types';
import type { Component } from 'svelte';

type PhaseComponent = Component<{ store: MafiaStore }>;

const PLAYERS: Array<{ id: string; name: string }> = [
	{ id: 'p1', name: 'Alice' },
	{ id: 'p2', name: 'Bob' },
	{ id: 'p3', name: 'Carol' },
	{ id: 'p4', name: 'Dave' },
	{ id: 'p5', name: 'Erin' },
	{ id: 'p6', name: 'Frank' }
];

const ALL_IDS = PLAYERS.map((p) => p.id);
const HOST_ID = 'p4';
const ROLES: MafiaRole[] = ['MAFIA', 'DOCTOR', 'DETECTIVE', 'VILLAGER'];

/** p1..p3 villagers, p4 Dave the Doctor (and host), p5 Erin the Detective, p6 Frank the Mafia. */
const ROLE_OF: Record<string, MafiaRole> = {
	p1: 'VILLAGER',
	p2: 'VILLAGER',
	p3: 'VILLAGER',
	p4: 'DOCTOR',
	p5: 'DETECTIVE',
	p6: 'MAFIA'
};

function idOfRole(role: MafiaRole): string {
	return PLAYERS.find((p) => ROLE_OF[p.id] === role)?.id ?? '';
}

function makeRoom(status: 'waiting' | 'playing' = 'playing'): PublicRoom {
	return {
		code: 'ABCDEF',
		status,
		createdAt: 0,
		players: PLAYERS.map((p) => ({ id: p.id, name: p.name, isHost: p.id === HOST_ID }))
	};
}

function makePublic(
	phase: MafiaPhase,
	liveIds: string[],
	extra: Partial<MafiaPublicState> = {},
	readyMap: Record<string, boolean> | null = null
): MafiaPublicState {
	const players: MafiaPublicPlayer[] = PLAYERS.map((p) => ({
		id: p.id,
		name: p.name,
		alive: liveIds.includes(p.id),
		ready: readyMap?.[p.id] ?? true
	}));
	return {
		gameId: 'game-1',
		phase,
		nightNumber: 1,
		players,
		winner: null,
		revealedRoles: null,
		voting: null,
		morningDeaths: null,
		elimination: null,
		...extra
	};
}

function makePrivate(role: MafiaRole, phase: MafiaPhase, liveIds: string[]): MafiaPlayerState {
	const playerId = idOfRole(role);
	const actionsFor = (phase: MafiaPhase): MafiaActionType[] => {
		if (phase === 'LOBBY') return ['READY'];
		if (phase === 'ROLE_REVEAL') return ['ROLE_SEEN'];
		if (phase === 'NIGHT') {
			if (role === 'MAFIA') return ['MAFIA_KILL'];
			if (role === 'DOCTOR') return ['DOCTOR_SAVE'];
			if (role === 'DETECTIVE') return ['DETECTIVE_INVESTIGATE'];
			return [];
		}
		if (phase === 'DISCUSSION' || phase === 'VOTING') return ['CAST_VOTE'];
		return [];
	};
	return {
		playerId,
		name: PLAYERS.find((p) => p.id === playerId)?.name ?? '',
		role,
		alive: liveIds.includes(playerId),
		ready: true,
		roleSeen: phase !== 'LOBBY',
		phase,
		nightNumber: 1,
		availableActions: actionsFor(phase),
		ownNightAction:
			phase === 'NIGHT' && (role === 'MAFIA' || role === 'DOCTOR' || role === 'DETECTIVE')
				? 'NOT_ACTED'
				: null,
		ownPrivateNightResult: null,
		ownVoteTargetId: null
	};
}

interface PhaseSeed {
	label: MafiaPhase;
	component: PhaseComponent;
	listLabel: 'Players' | 'Roles';
	liveIds: string[];
	roomStatus: 'waiting' | 'playing';
	readyVisible: boolean;
	winner: MafiaTeam | null;
	publicExtra: Partial<MafiaPublicState>;
	readyMap: Record<string, boolean> | null;
}

const VOTE_RESULT_ELIMINATION = { eliminatedPlayerId: 'p6' };

const SEEDS: PhaseSeed[] = [
	{
		label: 'LOBBY',
		component: Lobby,
		listLabel: 'Players',
		liveIds: ALL_IDS,
		roomStatus: 'waiting',
		readyVisible: true,
		winner: null,
		publicExtra: {},
		readyMap: { p2: false }
	},
	{
		label: 'ROLE_REVEAL',
		component: RoleReveal,
		listLabel: 'Players',
		liveIds: ALL_IDS,
		roomStatus: 'playing',
		readyVisible: false,
		winner: null,
		publicExtra: {},
		readyMap: null
	},
	{
		label: 'NIGHT',
		component: Night,
		listLabel: 'Players',
		liveIds: ALL_IDS,
		roomStatus: 'playing',
		readyVisible: false,
		winner: null,
		publicExtra: {},
		readyMap: null
	},
	{
		label: 'MORNING',
		component: Morning,
		listLabel: 'Players',
		liveIds: ALL_IDS.filter((id) => id !== 'p2'),
		roomStatus: 'playing',
		readyVisible: false,
		winner: null,
		publicExtra: { morningDeaths: ['p2'] },
		readyMap: null
	},
	{
		label: 'DISCUSSION',
		component: Discussion,
		listLabel: 'Players',
		liveIds: ALL_IDS.filter((id) => id !== 'p2'),
		roomStatus: 'playing',
		readyVisible: false,
		winner: null,
		publicExtra: {},
		readyMap: null
	},
	{
		label: 'VOTING',
		component: Voting,
		listLabel: 'Players',
		liveIds: ALL_IDS.filter((id) => id !== 'p2'),
		roomStatus: 'playing',
		readyVisible: false,
		winner: null,
		publicExtra: { voting: { cast: 2, total: 5 } },
		readyMap: null
	},
	{
		label: 'VOTE_RESULT',
		component: VoteResult,
		listLabel: 'Players',
		liveIds: ALL_IDS.filter((id) => id !== 'p2' && id !== 'p6'),
		roomStatus: 'playing',
		readyVisible: false,
		winner: null,
		publicExtra: { elimination: VOTE_RESULT_ELIMINATION },
		readyMap: null
	},
	{
		label: 'GAME_OVER',
		component: GameOver,
		listLabel: 'Roles',
		liveIds: ALL_IDS.filter((id) => id !== 'p2' && id !== 'p6'),
		roomStatus: 'playing',
		readyVisible: false,
		winner: 'TOWN',
		publicExtra: { winner: 'TOWN', revealedRoles: { ...ROLE_OF } },
		readyMap: null
	}
];

function makeStore(seed: PhaseSeed, role: MafiaRole): MafiaStore {
	const store = new MafiaStore('ABCDEF');
	store.room = makeRoom(seed.roomStatus);
	store.publicState = makePublic(seed.label, seed.liveIds, seed.publicExtra, seed.readyMap);
	store.privateState = makePrivate(role, seed.label, seed.liveIds);
	return store;
}

/** The rendered `<ol>` block — the player roster (or the GAME_OVER role list). */
function rosterSlice(html: string, label: string): string {
	const start = html.indexOf(`aria-label="${label}"`);
	expect(start, `expected <ol aria-label="${label}"> in the render`).toBeGreaterThan(-1);
	const end = html.indexOf('</ol>', start);
	expect(end).toBeGreaterThan(start);
	return html.slice(start, end);
}

function countIn(html: string, token: string): number {
	const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return (html.match(new RegExp(escaped, 'g')) ?? []).length;
}

const ROLE_WORDS = ['Mafia', 'Doctor', 'Detective', 'Villager'];

describe('public player list across phase components', () => {
	for (const seed of SEEDS) {
		it(`renders the same complete roster for every role at ${seed.label}`, () => {
			const expectedPlayers = makePublic(
				seed.label,
				seed.liveIds,
				seed.publicExtra,
				seed.readyMap
			).players;
			const rendered: string[] = [];

			for (const role of ROLES) {
				const store = makeStore(seed, role);

				// Store-level: the derived public roster must be role-independent.
				expect(store.players).toEqual(expectedPlayers);

				const { html } = render(seed.component, { props: { store } });
				const slice = rosterSlice(html, seed.listLabel);

				// Component-level: every name appears exactly once in the roster.
				for (const p of PLAYERS) {
					expect(countIn(slice, p.name), `${p.name} must be listed at ${seed.label}`).toBe(1);
				}

				// The host badge is rendered once, from the public room, for every role.
				if (seed.listLabel === 'Players') {
					expect(countIn(slice, '>Host<')).toBe(1);
				}

				if (seed.readyVisible) {
					// The ready checkmark is the aria-labeled span; the status text is "Ready"/"Not ready".
					expect(countIn(slice, 'aria-label="Ready"')).toBe(PLAYERS.length - 1);
					expect(countIn(slice, '>Not ready<')).toBe(1);
				} else {
					// Alive/out markers match the public truth (dead players stay listed as Out).
					expect(countIn(slice, 'Alive')).toBe(seed.liveIds.length);
					expect(countIn(slice, 'Out')).toBe(PLAYERS.length - seed.liveIds.length);
				}

				// Before the reveal, the roster body must never leak a role.
				if (seed.listLabel === 'Players') {
					for (const word of ROLE_WORDS) {
						expect(slice.includes(word), `${word} leaked into the list at ${seed.label}`).toBe(
							false
						);
					}
				}

				rendered.push(slice);
			}

			// The Mafia, Doctor, Detective and villager all render byte-identical rosters.
			for (const other of rendered.slice(1)) {
				expect(other).toBe(rendered[0]);
			}
		});
	}
});

describe('ready flow reads, more people also use it', () => {
	it('myReady reflects the private state that drives the Ready button', () => {
		const lobby = makeStore(SEEDS[0]!, 'VILLAGER');
		expect(lobby.myReady).toBe(true);
		lobby.privateState = { ...(lobby.privateState as MafiaPlayerState), ready: false };
		expect(lobby.myReady).toBe(false);
		lobby.privateState = { ...(lobby.privateState as MafiaPlayerState), ready: true };
		expect(lobby.myReady).toBe(true);
	});

	it('the Ready button handler still works when the DOM passes `this` = undefined', () => {
		const store = makeStore(SEEDS[0]!, 'VILLAGER');
		const detached = store.ready;
		expect(() => detached()).not.toThrow();
	});

	it('public action methods are bound arrow fields, not prototype methods', () => {
		const store = makeStore(SEEDS[0]!, 'VILLAGER');
		const methods = [
			'connect',
			'reconnectNow',
			'dispose',
			'leave',
			'ready',
			'reportRoleSeen',
			'advance',
			'startGame',
			'playAgain',
			'nightAction',
			'castVote',
			'dismissError'
		];
		for (const name of methods) {
			expect(Object.hasOwn(store, name), `${name} should be an own arrow field`).toBe(true);
		}
	});
});

describe('night acting panel with real private state', () => {
	const NIGHT_SEED = SEEDS.find((seed) => seed.label === 'NIGHT')!;

	function nightStore(
		role: MafiaRole,
		ownNightAction: MafiaPlayerState['ownNightAction']
	): MafiaStore {
		const store = makeStore(NIGHT_SEED, role);
		store.privateState = { ...(store.privateState as MafiaPlayerState), ownNightAction };
		return store;
	}

	const STEP_TEXT: Record<'MAFIA' | 'DOCTOR' | 'DETECTIVE', string> = {
		MAFIA: 'Choose a player to eliminate',
		DOCTOR: 'Choose a player to save',
		DETECTIVE: 'Choose a player to investigate'
	};

	for (const role of ['MAFIA', 'DOCTOR', 'DETECTIVE'] as const) {
		it(`${role} sees the selectable target list while their action is NOT_ACTED`, () => {
			const { html } = render(Night, { props: { store: nightStore(role, 'NOT_ACTED') } });

			expect(html).toContain('NIGHT 1');
			expect(html).toContain(STEP_TEXT[role]);
			expect(html).not.toContain('Choice recorded');
			expect(html).not.toContain('Keep your eyes closed');
			for (const p of PLAYERS) {
				expect(html, `${p.name} must be selectable by ${role}`).toContain(p.name);
			}
			// No more than the target buttons (+ the Doctor pass link).
			expect(countIn(html, '<button')).toBe(PLAYERS.length + (role === 'DOCTOR' ? 1 : 0));
			expect(countIn(html, 'aria-label="Players"')).toBe(1);
		});
	}

	it('a villager gets no acting panel at night (no targets, no recorded notice)', () => {
		const { html } = render(Night, { props: { store: nightStore('VILLAGER', null) } });
		expect(html).toContain('NIGHT 1');
		expect(html).toContain('Keep your eyes closed');
		expect(html).toContain('The night is in progress...');
		expect(html).not.toContain('Choice recorded');
		expect(html).not.toContain('<button');
	});

	it('an acting role with a recorded action sees the confirmation, not the target list', () => {
		for (const [role, status] of [
			['MAFIA', 'SUBMITTED'],
			['DOCTOR', 'PASSED'],
			['DETECTIVE', 'SUBMITTED'],
			['MAFIA', 'SKIPPED']
		] as const) {
			const { html } = render(Night, { props: { store: nightStore(role, status) } });
			expect(html).toContain('NIGHT 1');
			expect(html).toContain('Choice recorded');
			expect(html).toContain('Waiting for the night to resolve...');
			expect(countIn(html, '<button')).toBe(0);
			expect(countIn(html, 'aria-label="Players"')).toBe(1);
		}
	});
});
