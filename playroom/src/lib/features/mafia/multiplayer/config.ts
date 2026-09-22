/**
 * Backend endpoint configuration for the Mafia feature.
 *
 * The backend is a separate Bun + Hono process that defaults to
 * `http://localhost:3000` (see backend/README.md). Point the frontend at a
 * different origin with `MAFIA_BACKEND_URL`.
 */

const DEFAULT_BACKEND_URL = 'http://localhost:3000';

export function backendBase(): string {
	const fromEnv = import.meta.env.MAFIA_BACKEND_URL as string | undefined;
	return (fromEnv ?? DEFAULT_BACKEND_URL).replace(/\/+$/, '');
}

function wsBase(): string {
	return backendBase().replace(/^http/, 'ws');
}

export function httpRoomUrl(code: string): string {
	return `${backendBase()}/rooms/${encodeURIComponent(code)}`;
}

export function wsRoomUrl(code: string, playerId: string): string {
	return `${wsBase()}/ws/rooms/${encodeURIComponent(code)}?playerId=${encodeURIComponent(playerId)}`;
}
