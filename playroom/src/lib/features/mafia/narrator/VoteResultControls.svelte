<script lang="ts">
	import Button from '$lib/components/ui/Button.svelte';
	import type { NarratorStore } from './narrator-store.svelte';
	import type { NarratorView } from './types';
	import PhaseShell from '../components/PhaseShell.svelte';
	import SayLine from './SayLine.svelte';

	let { store }: { store: NarratorStore } = $props();

	const result = $derived(store.view as Extract<NarratorView, { kind: 'VOTE_RESULT' }> | null);
</script>

{#if result}
	<PhaseShell
		eyebrow="Day {result.nightNumber} · Verdict"
		title={result.tie ? 'A tied vote' : 'The town has decided'}
		subtitle="Announce the outcome. Never reveal a role — the game will do that when it ends."
	>
		<div class="max-w-2xl">
			<SayLine
				text={result.eliminatedPlayer
					? `The town has voted to eliminate ${result.eliminatedPlayer.name}. ${result.eliminatedPlayer.name}, you're out. Take your phone-free seat outside the circle.`
					: 'The vote is tied — nobody is eliminated tonight.'}
			/>

			<ol class="mt-6 divide-y divide-border border-t border-border" aria-label="How the vote fell">
				{#each result.votes as vote (vote.voterId)}
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
				<Button size="lg" onclick={store.advance} disabled={store.busy} class="w-full sm:w-auto">
					Continue
				</Button>
			</div>
		{/snippet}
	</PhaseShell>
{/if}
