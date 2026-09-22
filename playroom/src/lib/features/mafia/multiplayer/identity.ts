/**
 * Persistent player identity per room code, so a refresh or a drop/reconnect
 * restores the same player instead of creating a new one (spec: reconnection
 * must not reset the game UI). Keyed by the normalized room code.
 */
import { browser } from '$app/environment';

export interface PlayerIdentity {
	playerId: string;
	name: string;
}

function storageKey(code: string): string {
	return `playroom:mafia:player:${code}`;
}

export function getIdentity(code: string): PlayerIdentity | null {
	if (!browser) return null;
	try {
		const raw = localStorage.getItem(storageKey(code));
		if (!raw) return null;
		const parsed = JSON.parse(raw) as { playerId?: unknown; name?: unknown };
		if (typeof parsed.playerId !== 'string' || typeof parsed.name !== 'string') return null;
		return { playerId: parsed.playerId, name: parsed.name };
	} catch {
		return null;
	}
}

export function saveIdentity(code: string, identity: PlayerIdentity): void {
	if (!browser) return;
	try {
		localStorage.setItem(storageKey(code), JSON.stringify(identity));
	} catch {
		// Storage unavailable (private mode); the session still works, identity just won't survive a refresh.
	}
}

export function clearIdentity(code: string): void {
	if (!browser) return;
	try {
		localStorage.removeItem(storageKey(code));
	} catch {
		// ignore
	}
}
