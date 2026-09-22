/**
 * Client-side protocol helpers: verify incoming server frames are shaped like
 * the Mafia protocol and build the `mafia.action` envelope. Components never
 * use these directly — MafiaStore routes every decision through them.
 */
import type { MafiaClientAction, ServerMessage } from './types';

export function isServerMessage(value: unknown): value is ServerMessage {
	if (typeof value !== 'object' || value === null) return false;
	const message = value as { type?: unknown };
	return typeof message.type === 'string';
}

/** Envelope for a client action: { type: "mafia.action", action }. */
export function actionEnvelope(action: MafiaClientAction): string {
	return JSON.stringify({ type: 'mafia.action', action });
}

/** Keepalive frame the transport sends so the server can notice dead sockets. */
export function pingFrame(): string {
	return JSON.stringify({ type: 'ping' });
}
