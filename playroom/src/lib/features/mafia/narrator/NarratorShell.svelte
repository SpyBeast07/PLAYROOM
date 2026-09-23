<script lang="ts">
	import Button from '$lib/components/ui/Button.svelte';
	import type { NarratorStore } from './narrator-store.svelte';
	import DiscussionControls from './DiscussionControls.svelte';
	import GameOverControls from './GameOverControls.svelte';
	import LobbyControls from './LobbyControls.svelte';
	import MorningControls from './MorningControls.svelte';
	import NightControls from './NightControls.svelte';
	import RoleRevealControls from './RoleRevealControls.svelte';
	import VoteResultControls from './VoteResultControls.svelte';
	import VotingControls from './VotingControls.svelte';

	let { store }: { store: NarratorStore } = $props();

	const view = $derived(store.view);

	let confirmingReset = $state(false);

	function handleReset() {
		confirmingReset = !confirmingReset;
	}
</script>

<section aria-label="Narrator console">
	<div class="border-b border-border bg-background">
		<div class="page-shell flex h-14 items-center justify-between gap-4">
			<div class="flex min-w-0 items-center gap-3">
				<span class="eyebrow">Mafia</span>
				<span
					class="rounded-sm border border-border bg-surface px-2 py-1 text-xs font-semibold tracking-[0.12em] text-muted"
				>
					Narrator
				</span>
				<span class="hidden truncate text-sm text-muted sm:inline">
					One phone · no phones for the players
				</span>
			</div>
			<Button variant="ghost" onclick={handleReset}>
				{confirmingReset ? 'Reset for sure?' : 'Reset'}
			</Button>
		</div>
	</div>

	{#if store.error !== null || confirmingReset}
		{#if store.error !== null}
			<div class="page-shell mt-4">
				<div
					class="flex items-start justify-between gap-4 rounded-md border border-destructive/40 bg-destructive/5 p-3.5 text-sm"
					role="alert"
				>
					<p>{store.error}</p>
					<button
						type="button"
						onclick={() => (store.error = null)}
						class="shrink-0 rounded p-1 text-muted"
						aria-label="Dismiss error"
					>
						<svg
							class="size-4"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
						>
							<path d="M6 6l12 12M18 6L6 18" stroke-linecap="round" />
						</svg>
					</button>
				</div>
			</div>
		{/if}

		{#if confirmingReset}
			<div class="page-shell mt-4">
				<div
					class="flex flex-col gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-4 sm:flex-row sm:items-center sm:justify-between"
				>
					<p class="text-sm">
						<span class="font-semibold">This clears the whole table.</span>
						<span class="text-muted"> All players and the current game are wiped.</span>
					</p>
					<div class="flex gap-2">
						<Button variant="secondary" onclick={() => (confirmingReset = false)}
							>Keep playing</Button
						>
						<Button
							type="button"
							onclick={() => {
								confirmingReset = false;
								store.reset();
							}}
							disabled={store.busy}
						>
							Yes, reset
						</Button>
					</div>
				</div>
			</div>
		{/if}
	{/if}

	{#if view === null}
		<section class="page-shell py-16 sm:py-20">
			<p class="text-lg text-muted">Loading the narrator…</p>
		</section>
	{:else if view.kind === 'LOBBY'}
		<LobbyControls {store} />
	{:else if view.kind === 'ROLE_REVEAL'}
		<RoleRevealControls {store} />
	{:else if view.kind === 'NIGHT'}
		<NightControls {store} />
	{:else if view.kind === 'MORNING'}
		<MorningControls {store} />
	{:else if view.kind === 'DISCUSSION'}
		<DiscussionControls {store} />
	{:else if view.kind === 'VOTING'}
		<VotingControls {store} />
	{:else if view.kind === 'VOTE_RESULT'}
		<VoteResultControls {store} />
	{:else if view.kind === 'GAME_OVER'}
		<GameOverControls {store} />
	{/if}
</section>
