<script lang="ts">
	import Button from '$lib/components/ui/Button.svelte';
	import type { NarratorStore } from './narrator-store.svelte';
	import type { NarratorView } from './types';
	import PhaseShell from '../components/PhaseShell.svelte';
	import SayLine from './SayLine.svelte';

	let { store }: { store: NarratorStore } = $props();

	const discussion = $derived(store.view as Extract<NarratorView, { kind: 'DISCUSSION' }> | null);
</script>

{#if discussion}
	<PhaseShell
		eyebrow="Day {discussion.nightNumber}"
		title="Discussion"
		subtitle="Step back and listen. The players make their case; you make sure everyone gets a turn."
	>
		<div class="max-w-2xl">
			<SayLine
				text="The floor is open — discuss who you trust, who you doubt, and who the Mafia might be."
			/>

			<ol class="mt-6 divide-y divide-border border-t border-border" aria-label="Who is alive">
				{#each discussion.players as player (player.id)}
					<li class="flex items-center gap-3 py-2">
						<span
							class="grid size-9 shrink-0 place-items-center rounded-full border border-border bg-surface text-sm font-semibold"
							aria-hidden="true"
						>
							{player.name.slice(0, 1).toUpperCase()}
						</span>
						<p class="min-w-0 flex-1 truncate font-medium">{player.name}</p>
						<p class="text-sm text-muted">{player.alive ? 'Alive' : 'Out'}</p>
					</li>
				{/each}
			</ol>
		</div>

		{#snippet footer()}
			<div class="max-w-2xl">
				<Button
					size="lg"
					onclick={store.startVoting}
					disabled={store.busy}
					class="w-full sm:w-auto"
				>
					Begin voting
				</Button>
				<p class="mt-3 text-sm text-muted">
					When the talking is done and everyone knows who they want, move to the vote.
				</p>
			</div>
		{/snippet}
	</PhaseShell>
{/if}
