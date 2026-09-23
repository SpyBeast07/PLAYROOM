<script lang="ts">
	import Button from '$lib/components/ui/Button.svelte';
	import type { NarratorStore } from './narrator-store.svelte';
	import type { NarratorPublicPlayer, NarratorView } from './types';
	import PhaseShell from '../components/PhaseShell.svelte';
	import SayLine from './SayLine.svelte';
	import TargetList from '../components/TargetList.svelte';

	let { store }: { store: NarratorStore } = $props();

	const voting = $derived(store.view as Extract<NarratorView, { kind: 'VOTING' }> | null);

	const nextVoter = $derived(voting?.votersLeft[0] ?? null);

	const living = $derived.by<NarratorPublicPlayer[]>(() => {
		if (voting === null) return [];
		const index: Record<string, NarratorPublicPlayer> = {};
		for (const vote of voting.votes) {
			index[vote.voterId] = { id: vote.voterId, name: vote.voterName, alive: true };
		}
		for (const player of voting.votersLeft) index[player.id] = player;
		return Object.values(index);
	});
</script>

{#if voting}
	<PhaseShell
		eyebrow="Voting · Day {voting.nightNumber}"
		title="Record the vote"
		subtitle="Go around the room, one voter at a time. Everyone votes by pointing — you tap who they point at."
	>
		<div class="max-w-2xl">
			<p class="mb-3 text-sm text-muted" aria-live="polite">
				{voting.casts} of {voting.total} votes cast
			</p>

			{#if nextVoter}
				<p class="mb-3 text-base font-medium">Who does {nextVoter.name} vote for?</p>
				<TargetList targets={living} onPick={(id) => store.castVote(nextVoter.id, id)} />
			{:else}
				<SayLine text="All votes are in." />
			{/if}

			<ol class="mt-6 divide-y divide-border border-t border-border" aria-label="Recorded votes">
				{#each voting.votes as vote (vote.voterId)}
					<li class="flex items-center gap-3 py-2 text-sm">
						<span class="font-medium">{vote.voterName}</span>
						<svg
							class="size-4 text-muted"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							aria-hidden="true"
						>
							<path d="M5 12h14M13 5l7 7-7 7" stroke-linecap="round" stroke-linejoin="round" />
						</svg>
						<span class="text-muted">{vote.targetName}</span>
					</li>
				{/each}
			</ol>
		</div>

		{#snippet footer()}
			<div class="max-w-2xl">
				<Button
					variant="secondary"
					onclick={store.endVoting}
					disabled={store.busy}
					class="w-full sm:w-auto"
				>
					End the vote
				</Button>
				<p class="mt-3 text-sm text-muted">
					Skip the rest and resolve, or wait for the last vote to count itself.
				</p>
			</div>
		{/snippet}
	</PhaseShell>
{/if}
