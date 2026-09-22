<script lang="ts">
	import Button from '$lib/components/ui/Button.svelte';
	import type { MafiaStore } from '$lib/features/mafia/multiplayer/mafia-store.svelte';
	import PhaseShell from './PhaseShell.svelte';
	import PlayerList from './PlayerList.svelte';

	let { store }: { store: MafiaStore } = $props();

	const hostId = $derived(store.room?.players.find((player) => player.isHost)?.id ?? null);
</script>

<PhaseShell
	eyebrow="Night {store.publicState?.nightNumber ?? 1} · Day"
	title="Discussion"
	subtitle="The town talks. Find the Mafia before they find you."
	lead="Share what you saw, defend yourself, and listen. The vote comes next."
>
	<div class="max-w-2xl">
		<PlayerList players={store.players} meId={store.identity?.playerId ?? null} {hostId} />
	</div>

	{#snippet footer()}
		{#if store.isHost && store.phase === 'DISCUSSION'}
			<div class="max-w-2xl">
				<Button size="lg" onclick={store.advance} class="w-full sm:w-auto">Start the vote</Button>
			</div>
		{/if}
	{/snippet}
</PhaseShell>
