/**
 * Mafia WebSocket transport.
 *
 * Responsibilities (and only these):
 *  - open/close a WebSocket for one room+player
 *  - keep it alive with application pings
 *  - reconnect with capped exponential backoff after an unexpected drop
 *  - distinguish a recoverable drop from a room/player that no longer exists
 *    (liveness check against the HTTP room API), reporting `gone` in that case
 *
 * It knows nothing about game state. Parsed frames are handed to the caller;
 * the Svelte store projects them into UI state. On (re)open the server replays
 * the full public/private state, so no client-side reconstruction is needed.
 */
import { httpRoomUrl, wsRoomUrl } from './config';
import { actionEnvelope, pingFrame } from './protocol';
import type { ConnectionState, MafiaClientAction, ServerMessage } from './types';

export interface MafiaClientHandlers {
	onStatus(status: ConnectionState): void;
	onMessage(message: ServerMessage): void;
}

const PING_INTERVAL_MS = 15_000;
const MAX_BACKOFF_MS = 6_000;

export class MafiaClient {
	private ws: WebSocket | null = null;
	private intentionallyClosed = false;
	private roomCode = '';
	private playerId = '';
	private retry = 0;
	private pingTimer: ReturnType<typeof setInterval> | null = null;
	private retryTimers = new Set<ReturnType<typeof setTimeout>>();

	constructor(private readonly handlers: MafiaClientHandlers) {}

	get isOpen(): boolean {
		return this.ws?.readyState === WebSocket.OPEN;
	}

	connect(roomCode: string, playerId: string): void {
		this.roomCode = roomCode;
		this.playerId = playerId;
		this.intentionallyClosed = false;
		this.retry = 0;
		this.open();
	}

	/** Send one Mafia client action if the socket is up; otherwise drop silently. */
	send(action: MafiaClientAction): void {
		if (!this.isOpen) return;
		this.ws?.send(actionEnvelope(action));
	}

	/**
	 * Close deliberately (leaving the room). No reconnect is scheduled and any
	 * pending retry is cancelled.
	 */
	disconnect(): void {
		this.intentionallyClosed = true;
		this.stopPing();
		this.clearRetryTimers();
		const ws = this.ws;
		this.ws = null;
		ws?.close();
		this.handlers.onStatus('idle');
	}

	private open(): void {
		if (this.intentionallyClosed) return;
		this.handlers.onStatus(this.retry === 0 ? 'connecting' : 'reconnecting');

		const ws = new WebSocket(wsRoomUrl(this.roomCode, this.playerId));
		this.ws = ws;

		ws.onopen = () => {
			if (ws !== this.ws) return;
			this.retry = 0;
			this.handlers.onStatus('open');
			this.schedulePing();
		};

		ws.onmessage = (event) => {
			if (ws !== this.ws) return;
			let message: unknown;
			try {
				message = JSON.parse(String(event.data));
			} catch {
				return;
			}
			if (
				typeof message === 'object' &&
				message !== null &&
				typeof (message as { type?: unknown }).type === 'string'
			) {
				this.handlers.onMessage(message as ServerMessage);
			}
		};

		ws.onclose = () => {
			this.stopPing();
			if (ws !== this.ws) return;
			if (this.intentionallyClosed) return;

			// The server drops us deliberately when the room is deleted or this
			// player is removed. Check liveness first so those cases surface as
			// `gone` quickly; a transient network blip keeps retrying.
			this.handlers.onStatus('reconnecting');
			void this.checkStillExists().then((exists) => {
				if (this.intentionallyClosed) return;
				if (!exists) {
					this.handlers.onStatus('gone');
					return;
				}
				this.scheduleReconnect();
			});
		};

		// onerror is followed by onclose, which owns recovery.
	}

	/** Cancel any pending retry and attempt a fresh connection right now. */
	reconnectNow(): void {
		if (this.intentionallyClosed) return;
		this.clearRetryTimers();
		this.open();
	}

	private scheduleReconnect(): void {
		this.retry += 1;
		const delay = Math.min(500 * 2 ** (this.retry - 1), MAX_BACKOFF_MS);
		const timer = setTimeout(() => {
			if (this.intentionallyClosed) return;
			this.open();
		}, delay);
		this.retryTimers.add(timer);
	}

	/** Live room check: would a fresh handshake be accepted again? */
	private async checkStillExists(): Promise<boolean> {
		try {
			const response = await fetch(httpRoomUrl(this.roomCode));
			if (response.status === 404) return false;
			if (!response.ok) return true; // transient server error: keep trying
			const body = (await response.json()) as { room?: { players?: Array<{ id?: string }> } };
			return (body.room?.players ?? []).some((player) => player.id === this.playerId);
		} catch {
			return true; // network is down, not the room: keep trying
		}
	}

	private schedulePing(): void {
		this.stopPing();
		this.pingTimer = setInterval(() => {
			if (this.isOpen) {
				this.ws?.send(pingFrame());
			}
		}, PING_INTERVAL_MS);
	}

	private stopPing(): void {
		if (this.pingTimer !== null) {
			clearInterval(this.pingTimer);
			this.pingTimer = null;
		}
	}

	private clearRetryTimers(): void {
		for (const timer of this.retryTimers) {
			clearTimeout(timer);
		}
		this.retryTimers.clear();
	}
}
