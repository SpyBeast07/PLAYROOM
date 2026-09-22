<script lang="ts">
	import Button from '$lib/components/ui/Button.svelte';
	import type { MafiaStore } from '$lib/features/mafia/multiplayer/mafia-store.svelte';
	import PhaseShell from './PhaseShell.svelte';
	import PlayerList from './PlayerList.svelte';

	const MIN_PLAYERS = 4;

	let { store }: { store: MafiaStore } = $props();

	let copied = $state(false);
	let copying = $state(false);

	const count = $derived(store.players.length);
	const allReady = $derived(count > 0 && store.players.every((player) => player.ready));
	const canStart = $derived(count >= MIN_PLAYERS && allReady);
	const hostId = $derived(store.room?.players.find((player) => player.isHost)?.id ?? null);

	async function copyCode() {
		if (copying) return;
		copying = true;
		try {
			await navigator.clipboard.writeText(store.roomCode);
			copied = true;
			setTimeout(() => (copied = false), 1600);
		} catch {
			// Clipboard unavailable; the code is displayed for manual sharing.
		}
		copying = false;
	}
</script>

<PhaseShell
	eyebrow="Mafia · Room {store.roomCode}"
	title={count < MIN_PLAYERS ? 'Waiting for players' : 'Lobby'}
	subtitle="Share the room code with the group. The game needs at least 4 players and up to 20."
	lead="Mark yourself ready when you\u2019re set \u2014 the host starts once everyone is ready."
>
	<div class="max-w-2xl">
		<div class="flex items-center gap-3 rounded-md border border-border bg-surface p-4 sm:p-5">
			<div>
				<p class="text-xs font-semibold uppercase tracking-[0.14em] text-muted">Room code</p>
				<p class="mt-1 text-2xl font-semibold tracking-[0.2em]">{store.roomCode}</p>
			</div>
			<Button variant="secondary" onclick={copyCode} class="ml-auto min-w-28">
				{copied ? 'Copied' : 'Copy code'}
			</Button>
		</div>

		<div class="mt-8">
			<div class="mb-3 flex items-center justify-between gap-4">
				<h2 class="text-lg font-semibold tracking-tight">{count} player{count === 1 ? '' : 's'}</h2>
				<h3 class="text-sm text-muted">
					{#if count < MIN_PLAYERS}
						{MIN_PLAYERS - count} more needed
					{:else if !allReady}
						{count - store.players.filter((player) => player.ready).length} not ready
					{:else}
						Everyone is ready
					{/if}
				</h3>
			</div>
			<PlayerList
				players={store.players}
				meId={store.identity?.playerId ?? null}
				{hostId}
				showReady
			/>
		</div>

		<div class="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
			<Button
				variant={store.myReady ? 'secondary' : 'primary'}
				size="lg"
				onclick={store.ready}
				class="w-full sm:w-auto"
			>
				{store.myReady ? "I'm not ready" : "I'm ready"}
			</Button>
			{#if store.isHost}
				<Button size="lg" onclick={store.startGame} disabled={!canStart} class="w-full sm:w-auto">
					Start game
				</Button>
			{/if}
		</div>

		{#if store.isHost && !canStart}
			<p class="mt-3 text-sm text-muted">
				{#if count < MIN_PLAYERS}
					The game needs at least {MIN_PLAYERS} players.
				{:else}
					The start button unlocks when everyone marks themselves ready.
				{/if}
			</p>
		{/if}
	</div>
</PhaseShell>
