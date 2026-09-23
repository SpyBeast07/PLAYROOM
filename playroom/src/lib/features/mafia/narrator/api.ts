/**
 * Narrator (Mode C) Mafia — typed HTTP client for the /narrator routes.
 *
 * Every call returns a discriminated result and never throws; components route
 * through the NarratorStore, which owns the single `view` the device shows.
 */
import { backendBase } from '../multiplayer/config';
import type { NarratorView, NightActionType } from './types';

export type ApiResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

export interface NarratorApi {
	getView(): Promise<ApiResult<NarratorView>>;
	addPlayer(name: string): Promise<ApiResult<NarratorView>>;
	removePlayer(playerId: string): Promise<ApiResult<NarratorView>>;
	startGame(): Promise<ApiResult<NarratorView>>;
	beginNight(): Promise<ApiResult<NarratorView>>;
	recordNightAction(
		action: NightActionType,
		targetId: string | null
	): Promise<ApiResult<NarratorView>>;
	resolveNight(): Promise<ApiResult<NarratorView>>;
	startDiscussion(): Promise<ApiResult<NarratorView>>;
	startVoting(): Promise<ApiResult<NarratorView>>;
	castVote(voterId: string, targetId: string): Promise<ApiResult<NarratorView>>;
	endVoting(): Promise<ApiResult<NarratorView>>;
	advance(): Promise<ApiResult<NarratorView>>;
	playAgain(): Promise<ApiResult<NarratorView>>;
	reset(): Promise<ApiResult<NarratorView>>;
}

interface Outcome {
	status: number;
	body: { [key: string]: unknown } | null;
}

async function fetchJson(path: string, init?: RequestInit): Promise<Outcome> {
	let response: Response;
	try {
		response = await fetch(path, init);
	} catch {
		return { status: 0, body: null };
	}
	let body: { [key: string]: unknown } | null = null;
	const text = await response.text();
	if (text.length > 0) {
		try {
			body = JSON.parse(text) as { [key: string]: unknown };
		} catch {
			body = null;
		}
	}
	return { status: response.status, body };
}

function messageOf(outcome: Outcome): string {
	if (outcome.body === null) return 'Could not reach the game server.';
	const error = outcome.body['error'];
	return typeof error === 'string' ? error : 'Something went wrong. Please try again.';
}

function viewOutcome(outcome: Outcome): ApiResult<NarratorView> {
	if (outcome.status === 200 && outcome.body) {
		const view = outcome.body['view'];
		if (view && typeof view === 'object') return { ok: true, data: view as NarratorView };
	}
	const fallbacks: Record<number, string> = {
		0: 'Could not reach the game server.',
		400: 'Check the details you entered.',
		404: 'That player is no longer in the game.',
		409: 'That choice conflicts with the current game.',
		422: 'The game is not in the right state for that.'
	};
	return {
		ok: false,
		code: outcome.status === 0 ? 'NETWORK' : `HTTP_${outcome.status}`,
		message: messageOf(outcome) || (fallbacks[outcome.status] ?? 'Something went wrong.')
	};
}

async function postView(
	path: string,
	body?: Record<string, unknown>
): Promise<ApiResult<NarratorView>> {
	return viewOutcome(
		await fetchJson(path, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		})
	);
}

export function createNarratorApi(base = backendBase()): NarratorApi {
	const narrator = `${base}/narrator`;
	return {
		getView: () => fetchJson(`${narrator}`).then(viewOutcome),
		addPlayer: (name) => postView(`${narrator}/players`, { name }),
		removePlayer: (playerId) =>
			fetchJson(`${narrator}/players/${encodeURIComponent(playerId)}`, { method: 'DELETE' }).then(
				viewOutcome
			),
		startGame: () => postView(`${narrator}/start`),
		beginNight: () => postView(`${narrator}/begin-night`),
		recordNightAction: (action, targetId) =>
			postView(`${narrator}/night-action`, { action, targetId }),
		resolveNight: () => postView(`${narrator}/resolve-night`),
		startDiscussion: () => postView(`${narrator}/start-discussion`),
		startVoting: () => postView(`${narrator}/start-voting`),
		castVote: (voterId, targetId) => postView(`${narrator}/vote`, { voterId, targetId }),
		endVoting: () => postView(`${narrator}/end-voting`),
		advance: () => postView(`${narrator}/advance`),
		playAgain: () => postView(`${narrator}/play-again`),
		reset: () => postView(`${narrator}/reset`)
	};
}
