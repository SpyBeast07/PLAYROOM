<script lang="ts">
	import Button from '$lib/components/ui/Button.svelte';
	import type { NarratorStore } from './narrator-store.svelte';
	import type { NarratorView } from './types';
	import PhaseShell from '../components/PhaseShell.svelte';
	import SayLine from './SayLine.svelte';

	let { store }: { store: NarratorStore } = $props();

	const morning = $derived(store.view as Extract<NarratorView, { kind: 'MORNING' }> | null);

	function names(players: Array<{ name: string }>): string {
		return players.map((player) => player.name).join(', ');
	}
</script>

{#if morning}
	<PhaseShell
		eyebrow="Morning {morning.nightNumber}"
		title="The town wakes"
		subtitle="Ask everyone to open their eyes. Announce what the night brought, no roles, no details."
	>
		<div class="max-w-2xl">
			<SayLine
				text={morning.deaths.length > 0
					? `Good morning. The town woke to find ${names(morning.deaths)} no longer with us.`
					: 'Good morning, everyone. The night was quiet — nobody died.'}
			/>

			{#if morning.investigation}
				<div
					class="mt-6 rounded-md border border-accent/40 bg-surface p-4"
					aria-label="Detective's verdict"
				>
					<p class="eyebrow mb-1">Detective's verdict — tell them in private</p>
					<p class="text-lg leading-relaxed">
						{morning.investigation.targetName}
						{morning.investigation.isMafia ? 'is' : 'is not'} the Mafia.
					</p>
				</div>
			{/if}

			<ol class="mt-6 divide-y divide-border border-t border-border" aria-label="Who is alive">
				{#each morning.players as player (player.id)}
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
					onclick={store.startDiscussion}
					disabled={store.busy}
					class="w-full sm:w-auto"
				>
					Start the discussion
				</Button>
			</div>
		{/snippet}
	</PhaseShell>
{/if}
