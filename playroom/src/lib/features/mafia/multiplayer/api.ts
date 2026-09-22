/**
 * Typed access to the room HTTP API (backend/src/routes/rooms.ts).
 * Every call returns a discriminated result; components never throw for a
 * rejected HTTP request.
 */
import { backendBase, httpRoomUrl } from './config';
import type { PublicRoom } from './types';

export type ApiResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

interface FetchOutcome {
	status: number;
	body: { [key: string]: unknown } | null;
}

async function fetchJson(path: string, init?: RequestInit): Promise<FetchOutcome> {
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

function messageOf(outcome: FetchOutcome): string {
	if (outcome.body === null) return 'Could not reach the game server.';
	const error = outcome.body['error'];
	return typeof error === 'string' ? error : 'Something went wrong. Please try again.';
}

function ok<T>(data: T): ApiResult<T> {
	return { ok: true, data };
}

function fail(status: number, message: string, fallback: string): ApiResult<never> {
	return {
		ok: false,
		code: status === 0 ? 'NETWORK' : `HTTP_${status}`,
		message: status === 0 ? message : fallback
	};
}

const HTTP_MESSAGES: Record<number, string> = {
	400: 'Check the details you entered.',
	404: 'Room not found. Check the code your host shared.',
	409: 'The room is full or the game already started.',
	500: 'The game server hit a problem. Please try again.'
};

export function createRoom(): Promise<ApiResult<{ code: string }>> {
	return fetchJson(`${backendBase()}/rooms`, { method: 'POST' }).then((outcome) => {
		if (outcome.status === 201 && outcome.body) {
			const room = outcome.body['room'];
			const code =
				room &&
				typeof room === 'object' &&
				typeof (room as Record<string, unknown>)['code'] === 'string'
					? ((room as Record<string, unknown>)['code'] as string)
					: undefined;
			if (code) return ok({ code });
		}
		return fail(
			outcome.status,
			messageOf(outcome),
			HTTP_MESSAGES[outcome.status] ?? 'Could not create the room.'
		);
	});
}

export function joinRoom(
	code: string,
	name: string
): Promise<ApiResult<{ playerId: string; name: string; isHost: boolean; code: string }>> {
	const url = `${backendBase()}/rooms/${encodeURIComponent(code)}/players`;
	return fetchJson(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ name })
	}).then((outcome) => {
		if (outcome.status === 201 && outcome.body) {
			const player = outcome.body['player'];
			const room = outcome.body['room'];
			if (player && typeof player === 'object') {
				const p = player as Record<string, unknown>;
				const roomCode =
					room && typeof room === 'object'
						? (((room as Record<string, unknown>)['code'] ?? code) as string)
						: code;
				if (typeof p['id'] === 'string') {
					return ok({
						playerId: p['id'],
						name: typeof p['name'] === 'string' ? p['name'] : name,
						isHost: p['isHost'] === true,
						code: roomCode
					});
				}
			}
		}
		if (outcome.status === 409 && outcome.body) {
			const error = outcome.body['error'];
			if (typeof error === 'string' && error.toLowerCase().includes('started')) {
				return { ok: false, code: 'ROOM_STARTED', message: error };
			}
		}
		return fail(
			outcome.status,
			messageOf(outcome),
			HTTP_MESSAGES[outcome.status] ?? 'Could not join the room.'
		);
	});
}

export function getRoom(code: string): Promise<ApiResult<PublicRoom>> {
	return fetchJson(httpRoomUrl(code)).then((outcome) => {
		if (outcome.status === 200 && outcome.body) {
			const room = outcome.body['room'];
			if (
				room &&
				typeof room === 'object' &&
				typeof (room as Record<string, unknown>)['code'] === 'string'
			) {
				return ok(room as unknown as PublicRoom);
			}
		}
		return fail(
			outcome.status,
			messageOf(outcome),
			HTTP_MESSAGES[outcome.status] ?? 'Could not load the room.'
		);
	});
}

export function leaveRoom(code: string, playerId: string): Promise<ApiResult<null>> {
	return fetchJson(
		`${backendBase()}/rooms/${encodeURIComponent(code)}/players/${encodeURIComponent(playerId)}`,
		{
			method: 'DELETE'
		}
	).then((outcome) => {
		if (outcome.status === 204) return ok(null);
		return fail(
			outcome.status,
			messageOf(outcome),
			HTTP_MESSAGES[outcome.status] ?? 'Could not leave the room.'
		);
	});
}
