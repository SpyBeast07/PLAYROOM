<script lang="ts">
	import Button from '$lib/components/ui/Button.svelte';
	import type { MafiaStore } from '$lib/features/mafia/multiplayer/mafia-store.svelte';
	import PhaseShell from './PhaseShell.svelte';
	import PlayerList from './PlayerList.svelte';

	let { store }: { store: MafiaStore } = $props();

	const hostId = $derived(store.room?.players.find((player) => player.isHost)?.id ?? null);
	const eliminatedId = $derived(store.publicState?.elimination?.eliminatedPlayerId ?? null);
	const eliminatedName = $derived(
		store.players.find((player) => player.id === eliminatedId)?.name ?? null
	);
</script>

<PhaseShell
	eyebrow="Day · Result"
	title="The votes are in"
	subtitle={eliminatedName
		? `${eliminatedName} was voted out.`
		: 'The vote was tied \u2014 nobody is eliminated tonight.'}
	lead={eliminatedName
		? 'The town has spoken. Night will soon fall again.'
		: 'The votes split evenly, so the town parts ways without a verdict.'}
>
	<div class="max-w-2xl">
		<PlayerList players={store.players} meId={store.identity?.playerId ?? null} {hostId} />
	</div>

	{#snippet footer()}
		{#if store.isHost && store.phase === 'VOTE_RESULT'}
			<div class="max-w-2xl">
				<Button size="lg" onclick={store.advance} class="w-full sm:w-auto">
					Continue into the night
				</Button>
			</div>
		{:else if store.phase === 'VOTE_RESULT'}
			<div class="max-w-2xl">
				<p class="text-sm text-muted">Waiting for the host to continue…</p>
			</div>
		{/if}
	{/snippet}
</PhaseShell>
