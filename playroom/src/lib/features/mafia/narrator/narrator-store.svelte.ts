/**
 * Narrator (Mode C) Mafia — frontend state (Svelte 5 runes store).
 *
 * One instance per narrator device. The store is nothing but a thin projection
 * of the backend's privileged `view`: every phase screen the narrator sees is
 * produced server-side, and all the store does is call the API and remember the
 * latest view. `busy` guards against double-taps while a call is in flight and
 * `error` holds the last failed call's message (auto-cleared by the next
 * success).
 *
 * The api client is injectable so tests can drive a full game without touching
 * the network.
 */
import { createNarratorApi, type NarratorApi, type ApiResult } from './api';
import type { NarratorView, NightActionType } from './types';

export class NarratorStore {
	readonly api: NarratorApi;

	view = $state<NarratorView | null>(null);
	error = $state<string | null>(null);
	busy = $state(false);

	constructor(api: NarratorApi = createNarratorApi()) {
		this.api = api;
	}

	/** Load the current narrator view (called once on the narrator route). */
	boot = async (): Promise<void> => {
		await this.run(() => this.api.getView());
	};

	addPlayer = async (name: string): Promise<void> => {
		await this.run(() => this.api.addPlayer(name));
	};

	removePlayer = async (playerId: string): Promise<void> => {
		await this.run(() => this.api.removePlayer(playerId));
	};

	startGame = async (): Promise<void> => {
		await this.run(() => this.api.startGame());
	};

	beginNight = async (): Promise<void> => {
		await this.run(() => this.api.beginNight());
	};

	recordNightAction = async (action: NightActionType, targetId: string | null): Promise<void> => {
		await this.run(() => this.api.recordNightAction(action, targetId));
	};

	resolveNight = async (): Promise<void> => {
		await this.run(() => this.api.resolveNight());
	};

	startDiscussion = async (): Promise<void> => {
		await this.run(() => this.api.startDiscussion());
	};

	startVoting = async (): Promise<void> => {
		await this.run(() => this.api.startVoting());
	};

	castVote = async (voterId: string, targetId: string): Promise<void> => {
		await this.run(() => this.api.castVote(voterId, targetId));
	};

	endVoting = async (): Promise<void> => {
		await this.run(() => this.api.endVoting());
	};

	advance = async (): Promise<void> => {
		await this.run(() => this.api.advance());
	};

	playAgain = async (): Promise<void> => {
		await this.run(() => this.api.playAgain());
	};

	reset = async (): Promise<void> => {
		await this.run(() => this.api.reset());
	};

	private run = async (task: () => Promise<ApiResult<NarratorView>>): Promise<void> => {
		this.busy = true;
		try {
			const result = await task();
			if (result.ok) {
				this.view = result.data;
				this.error = null;
			} else {
				this.error = result.message;
			}
		} finally {
			this.busy = false;
		}
	};
}
