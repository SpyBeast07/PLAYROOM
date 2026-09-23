/**
 * Narrator (Mode C) Mafia — frontend regression.
 *
 * Pins the narrator console's rendering contract:
 *   - the lobby gates start until enough players are in;
 *   - the night screen never offers the acting Mafia themselves as a kill
 *     target and only unlocks resolution once the Mafia has acted;
 *   - the role reveal hides every role behind a tap (no secrets in the base
 *     markup);
 *   - voting asks for the next spoken vote and shows the tally;
 *   - game over announces the winner and only then reveals roles;
 *   - the store keeps a single source of truth and surfaces failures.
 *
 * The store is driven directly (its `view` is an injectable `$state` field,
 * and the api client is injectable); no network is touched.
 */
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';

import GameOverControls from '$lib/features/mafia/narrator/GameOverControls.svelte';
import LobbyControls from '$lib/features/mafia/narrator/LobbyControls.svelte';
import NarratorShell from '$lib/features/mafia/narrator/NarratorShell.svelte';
import NightControls from '$lib/features/mafia/narrator/NightControls.svelte';
import RoleRevealControls from '$lib/features/mafia/narrator/RoleRevealControls.svelte';
import VotingControls from '$lib/features/mafia/narrator/VotingControls.svelte';
import { NarratorStore } from '$lib/features/mafia/narrator/narrator-store.svelte';
import type { NarratorApi, ApiResult } from '$lib/features/mafia/narrator/api';
import type { NarratorView } from '$lib/features/mafia/narrator/types';
import type { NightActionStatus } from '$lib/features/mafia/multiplayer/types';

const LOBBY: NarratorView = {
	kind: 'LOBBY',
	players: [
		{ id: 'p1', name: 'Ada', ready: false },
		{ id: 'p2', name: 'Bob', ready: false },
		{ id: 'p3', name: 'Cam', ready: false }
	],
	minPlayers: 4,
	maxPlayers: 20,
	canStart: false
};

type NightView = Extract<NarratorView, { kind: 'NIGHT' }>;

const NIGHT = (kill: NightActionStatus = 'NOT_ACTED'): NightView => ({
	kind: 'NIGHT',
	nightNumber: 1,
	actingMafiaName: 'Frank',
	players: [
		{ id: 'p1', name: 'Ada', alive: true },
		{ id: 'p2', name: 'Bob', alive: true },
		{ id: 'p3', name: 'Cam', alive: true },
		{ id: 'p6', name: 'Frank', alive: true }
	],
	kill: { action: 'MAFIA_KILL', status: kill, targetId: null, targetName: null, verdict: null },
	save: {
		action: 'DOCTOR_SAVE',
		status: 'NOT_ACTED',
		targetId: null,
		targetName: null,
		verdict: null
	},
	investigate: {
		action: 'DETECTIVE_INVESTIGATE',
		status: 'NOT_ACTED',
		targetId: null,
		targetName: null,
		verdict: null
	}
});

const REVEAL: NarratorView = {
	kind: 'ROLE_REVEAL',
	players: [
		{ id: 'p1', name: 'Ada', role: 'VILLAGER' },
		{ id: 'p2', name: 'Bob', role: 'VILLAGER' },
		{ id: 'p3', name: 'Cam', role: 'DOCTOR' },
		{ id: 'p6', name: 'Frank', role: 'MAFIA' }
	]
};

const VOTING: NarratorView = {
	kind: 'VOTING',
	nightNumber: 1,
	votes: [{ voterId: 'p1', voterName: 'Ada', targetId: 'p6', targetName: 'Frank' }],
	votersLeft: [{ id: 'p2', name: 'Bob', alive: true }],
	casts: 1,
	total: 2
};

const GAME_OVER: NarratorView = {
	kind: 'GAME_OVER',
	winner: 'TOWN',
	players: [
		{ id: 'p1', name: 'Ada', role: 'VILLAGER', alive: true },
		{ id: 'p6', name: 'Frank', role: 'MAFIA', alive: false }
	]
};

function storeWith(view: NarratorView): NarratorStore {
	const store = new NarratorStore();
	store.view = view;
	return store;
}

/** The names shown as tap targets (TargetList renders `<span class="truncate">`). */
function targetsIn(html: string): string[] {
	return [...html.matchAll(/<span class="truncate">([^<]*)<\/span>/g)].map((match) => match[1]);
}

/** Whether the button containing the given label is rendered disabled. */
function buttonDisabled(html: string, label: string): boolean {
	const buttons = [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map(
		(match) => match[0]
	);
	const found = buttons.find((button) => button.includes(label));
	if (!found) throw new Error(`no button labelled "${label}" in render`);
	return /\sdisabled(="|>|\s)/.test(found);
}

describe('narrator console — rendered screens', () => {
	it('lobby shows the roster, the add field, and start gated below the minimum', () => {
		const { body } = render(LobbyControls, { props: { store: storeWith(LOBBY) } });
		expect(body).toContain('Set up the game');
		expect(body).toContain('Player name');
		expect(body).toContain('Ada');
		expect(body).toContain('Need at least 4 players to start.');
		expect(buttonDisabled(body, 'Start the game')).toBe(true);
	});

	it('night never offers the acting Mafia as a kill target and hides no other roles', () => {
		const { body } = render(NightControls, { props: { store: storeWith(NIGHT()) } });
		expect(body).toContain('Frank — open your eyes. Show me who to eliminate tonight.');
		expect(targetsIn(body)).toEqual(['Ada', 'Bob', 'Cam']);
		expect(buttonDisabled(body, 'Resolve the night')).toBe(true);
	});

	it('night unlocks resolution once the Mafia has acted, then opens the doctor step with a pass', () => {
		const view: NightView = {
			...NIGHT('SUBMITTED'),
			kill: {
				action: 'MAFIA_KILL',
				status: 'SUBMITTED',
				targetId: 'p2',
				targetName: 'Bob',
				verdict: null
			}
		};
		const { body } = render(NightControls, { props: { store: storeWith(view) } });
		expect(body).toContain('Who does the doctor pick?');
		expect(body).toContain('Protect no one');
		// The doctor may protect anyone, the acting Mafia included.
		expect(targetsIn(body)).toEqual(['Ada', 'Bob', 'Cam', 'Frank']);
		expect(buttonDisabled(body, 'Resolve the night')).toBe(false);
	});

	it('role reveal keeps every role hidden until the single reveal-all toggle is pressed', () => {
		const { body } = render(RoleRevealControls, { props: { store: storeWith(REVEAL) } });
		expect(body).toContain('Reveal all roles');
		expect(body).not.toContain('Villager');
		expect(body).not.toContain('Doctor');
		expect(body).not.toContain('Mafia');
		// The night cannot start until the narrator has actually revealed roles.
		expect(buttonDisabled(body, 'Begin the night')).toBe(true);
	});

	it('voting asks for the next spoken vote and shows the running tally', () => {
		const { body } = render(VotingControls, { props: { store: storeWith(VOTING) } });
		expect(body).toContain('Who does Bob vote for?');
		expect(body).toContain('1 of 2 votes cast');
		expect(body).toContain('Ada');
		expect(body).toContain('Frank');
	});

	it('game over announces the winner and reveals the roles', () => {
		const { body } = render(GameOverControls, { props: { store: storeWith(GAME_OVER) } });
		expect(body).toContain('The Town wins.');
		expect(body).toContain('Villager');
		expect(body).toContain('Mafia');
		expect(body).toContain('Play again');
		expect(body).toContain('Reset the table');
	});

	it('shell dispatches by view kind (lobby through game over)', () => {
		const lobby = render(NarratorShell, { props: { store: storeWith(LOBBY) } });
		expect(lobby.body).toContain('Set up the game');

		const over = storeWith(GAME_OVER);
		const end = render(NarratorShell, { props: { store: over } });
		expect(end.body).toContain('The Town wins.');
	});
});

describe('narrator store — view projection and failures', () => {
	it('boot loads the current view into `view`', async () => {
		const store = new NarratorStore(
			new (class implements NarratorApi {
				async getView(): Promise<ApiResult<NarratorView>> {
					return { ok: true, data: LOBBY };
				}
				async addPlayer(): Promise<ApiResult<NarratorView>> {
					return { ok: true, data: LOBBY };
				}
				async removePlayer(): Promise<ApiResult<NarratorView>> {
					return { ok: true, data: LOBBY };
				}
				async startGame(): Promise<ApiResult<NarratorView>> {
					return { ok: false, code: 'HTTP_422', message: 'Too few' };
				}
				async beginNight(): Promise<ApiResult<NarratorView>> {
					return { ok: true, data: NIGHT() };
				}
				async recordNightAction(): Promise<ApiResult<NarratorView>> {
					return { ok: true, data: NIGHT() };
				}
				async resolveNight(): Promise<ApiResult<NarratorView>> {
					return { ok: true, data: NIGHT() };
				}
				async startDiscussion(): Promise<ApiResult<NarratorView>> {
					return { ok: true, data: NIGHT() };
				}
				async startVoting(): Promise<ApiResult<NarratorView>> {
					return { ok: true, data: VOTING };
				}
				async castVote(): Promise<ApiResult<NarratorView>> {
					return { ok: true, data: VOTING };
				}
				async endVoting(): Promise<ApiResult<NarratorView>> {
					return { ok: true, data: VOTING };
				}
				async advance(): Promise<ApiResult<NarratorView>> {
					return { ok: true, data: NIGHT() };
				}
				async playAgain(): Promise<ApiResult<NarratorView>> {
					return { ok: true, data: LOBBY };
				}
				async reset(): Promise<ApiResult<NarratorView>> {
					return { ok: true, data: LOBBY };
				}
			})()
		);

		expect(store.view).toBeNull();
		await store.boot();
		expect(store.view?.kind).toBe('LOBBY');
	});

	it('a rejected call surfaces the message and the next success clears it', async () => {
		let calls = 0;
		const flaky = {
			async getView(): Promise<ApiResult<NarratorView>> {
				calls += 1;
				if (calls === 1) return { ok: false, code: 'HTTP_500', message: 'Server hiccup' };
				return { ok: true, data: LOBBY };
			}
		};
		const store = new NarratorStore(flaky as NarratorApi);
		await store.boot();
		expect(store.error).toBe('Server hiccup');
		await store.boot();
		expect(store.error).toBeNull();
		expect(store.view?.kind).toBe('LOBBY');
	});
});
