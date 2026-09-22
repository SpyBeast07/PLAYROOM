<script lang="ts">
	import Button from '$lib/components/ui/Button.svelte';
	import type { MafiaStore } from '$lib/features/mafia/multiplayer/mafia-store.svelte';
	import PhaseShell from './PhaseShell.svelte';
	import TargetList from './TargetList.svelte';

	let { store }: { store: MafiaStore } = $props();

	const progress = $derived(store.publicState?.voting ?? { cast: 0, total: 0 });
	const canVote = $derived(store.can('CAST_VOTE'));
	const myVote = $derived(store.privateState?.ownVoteTargetId ?? null);
	const votedFor = $derived(store.players.find((player) => player.id === myVote)?.name ?? null);
</script>

<PhaseShell
	eyebrow="Day · Vote"
	title="Cast your vote"
	subtitle="Vote for who you believe is the Mafia."
	lead="{progress.cast} of {progress.total} votes in — votes are secret, so nothing here shows who voted for whom."
>
	{#if store.myAlive && canVote}
		<div class="max-w-2xl">
			<p class="mb-3 text-sm text-muted">Tap a player to vote them out.</p>
			<TargetList targets={store.livingPlayers} onPick={(id) => store.castVote(id)} />
		</div>
	{:else if store.myAlive && votedFor}
		<div class="max-w-2xl">
			<p class="rounded-md border border-border bg-surface p-4 text-sm text-muted">
				You voted for <span class="font-medium text-foreground">{votedFor}</span>. Waiting for the
				remaining votes…
			</p>
		</div>
	{:else}
		<div class="max-w-2xl">
			<p class="rounded-md border border-border bg-surface p-4 text-sm text-muted">
				{store.myAlive
					? 'Waiting for the other players to cast their votes…'
					: "You're out, but you still get to watch the trial."}
			</p>
		</div>
	{/if}

	{#if progress.total > 0}
		<div class="max-w-2xl">
			<div class="mt-6 h-1.5 overflow-hidden rounded-full bg-border" role="presentation">
				<div
					class="h-full rounded-full bg-accent transition-[width] duration-300"
					style="width: {progress.total > 0 ? (progress.cast / progress.total) * 100 : 0}%"
				></div>
			</div>
		</div>
	{/if}

	{#snippet footer()}
		{#if store.isHost && store.phase === 'VOTING' && !store.allVoted}
			<div class="max-w-2xl">
				<Button variant="secondary" onclick={store.advance}>End the vote now</Button>
			</div>
		{/if}
	{/snippet}
</PhaseShell>
