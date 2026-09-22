<script lang="ts">
	import Button from '$lib/components/ui/Button.svelte';
	import type { MafiaStore } from '$lib/features/mafia/multiplayer/mafia-store.svelte';
	import PhaseShell from './PhaseShell.svelte';

	let { store }: { store: MafiaStore } = $props();

	const deathIds = $derived(store.publicState?.morningDeaths ?? []);
	const deathNames = $derived(
		deathIds.map((id) => store.players.find((player) => player.id === id)?.name ?? 'Someone')
	);
	const result = $derived(store.privateState?.ownPrivateNightResult ?? null);
</script>

<PhaseShell
	eyebrow="Night {store.publicState?.nightNumber ?? 1} · Morning"
	title="The town wakes"
	subtitle="The night is over. Here is what the town knows."
	lead={deathNames.length > 0
		? `${deathNames.join(', ')} ${deathNames.length === 1 ? 'was' : 'were'} found dead this morning.`
		: 'Nobody died during the night.'}
>
	<div class="max-w-2xl">
		{#if result?.kind === 'INVESTIGATION'}
			<div class="rounded-md border border-accent/40 bg-surface p-4 sm:p-5">
				<p class="eyebrow mb-1">Your investigation</p>
				<p class="text-base leading-relaxed">
					{store.players.find((player) => player.id === result.targetId)?.name ?? 'Your target'}
					{result.isMafia ? ' is the Mafia.' : ' is not the Mafia.'}
				</p>
			</div>
		{:else if result?.kind === 'HEAL'}
			<div class="rounded-md border border-accent/40 bg-surface p-4 sm:p-5">
				<p class="eyebrow mb-1">Your protection</p>
				<p class="text-base leading-relaxed">
					{#if result.targetId === null}
						You protected no one.
					{:else}
						{result.applied
							? `${store.players.find((player) => player.id === result.targetId)?.name ?? 'Your patient'} was saved from the night.`
							: 'Your patient survived the night untouched.'}
					{/if}
				</p>
			</div>
		{:else}
			<p class="rounded-md border border-border bg-surface p-4 text-sm text-muted">
				{store.myAlive
					? 'Look around. Remember what you saw, and who spoke.'
					: "You're out, but the town still needs your eyes and ears."}
			</p>
		{/if}
	</div>

	{#snippet footer()}
		{#if store.isHost && store.phase === 'MORNING'}
			<div class="max-w-2xl">
				<Button size="lg" onclick={store.advance} class="w-full sm:w-auto">
					Open the discussion
				</Button>
			</div>
		{/if}
	{/snippet}
</PhaseShell>
