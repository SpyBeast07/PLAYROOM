<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import Button from '$lib/components/ui/Button.svelte';
	import type { MafiaStore } from '$lib/features/mafia/multiplayer/mafia-store.svelte';
	import Discussion from './Discussion.svelte';
	import ErrorList from './ErrorList.svelte';
	import GameOver from './GameOver.svelte';
	import Gone from './Gone.svelte';
	import Lobby from './Lobby.svelte';
	import Morning from './Morning.svelte';
	import Night from './Night.svelte';
	import RoleReveal from './RoleReveal.svelte';
	import VoteResult from './VoteResult.svelte';
	import Voting from './Voting.svelte';

	let { store }: { store: MafiaStore } = $props();

	const phase = $derived(store.phase);
	const connection = $derived(store.connection);
	const playerCount = $derived(store.players.length);

	async function handleLeave() {
		await store.leave();
		goto(resolve('/games'));
	}
</script>

<svelte:head>
	<title>Mafia · {store.roomCode} — PLAYROOM</title>
	<meta name="description" content="Mafia, playable with the whole room." />
</svelte:head>

{#if connection === 'gone'}
	<Gone {store} />
{:else}
	<section aria-label="Game room">
		<div class="border-b border-border bg-background">
			<div class="page-shell flex h-14 items-center justify-between gap-4">
				<div class="flex min-w-0 items-center gap-3">
					<span class="eyebrow">Mafia</span>
					<span
						class="rounded-sm border border-border bg-surface px-2 py-1 text-xs font-semibold tracking-[0.12em] text-muted"
					>
						{store.roomCode}
					</span>
					<span class="hidden truncate text-sm text-muted sm:inline">
						{playerCount} player{playerCount === 1 ? '' : 's'}
					</span>
				</div>
				<div class="flex items-center gap-3">
					<p class="flex items-center gap-2 text-sm text-muted" role="status">
						<span
							class="size-2 rounded-full {connection === 'open'
								? 'bg-accent'
								: connection === 'reconnecting'
									? 'bg-destructive'
									: 'bg-faint'}"
							aria-hidden="true"
						></span>
						<span class="hidden sm:inline">
							{connection === 'open'
								? 'Connected'
								: connection === 'reconnecting'
									? 'Reconnecting'
									: 'Connecting'}
						</span>
					</p>
					<Button variant="ghost" onclick={handleLeave}>Leave</Button>
				</div>
			</div>
		</div>

		<ErrorList {store} />

		{#if connection === 'reconnecting'}
			<div class="page-shell mt-4">
				<div
					class="flex flex-col gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-4 sm:flex-row sm:items-center sm:justify-between"
					role="status"
				>
					<p class="text-sm">
						<span class="font-semibold">Connection lost — reconnecting.&nbsp;</span>
						<span class="text-muted">Hold on; your place in the game is saved.</span>
					</p>
					<div>
						<Button variant="secondary" onclick={store.reconnectNow}>Reconnect now</Button>
					</div>
				</div>
			</div>
		{/if}

		{#if phase === null}
			<section class="page-shell py-16 sm:py-20">
				<p class="text-lg text-muted">Connecting to the game…</p>
			</section>
		{:else if phase === 'LOBBY'}
			<Lobby {store} />
		{:else if phase === 'ROLE_REVEAL'}
			<RoleReveal {store} />
		{:else if phase === 'NIGHT'}
			<Night {store} />
		{:else if phase === 'MORNING'}
			<Morning {store} />
		{:else if phase === 'DISCUSSION'}
			<Discussion {store} />
		{:else if phase === 'VOTING'}
			<Voting {store} />
		{:else if phase === 'VOTE_RESULT'}
			<VoteResult {store} />
		{:else if phase === 'GAME_OVER'}
			<GameOver {store} />
		{/if}
	</section>
{/if}
