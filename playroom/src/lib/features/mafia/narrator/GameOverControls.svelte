<script lang="ts">
	import Button from '$lib/components/ui/Button.svelte';
	import { ROLE_LABELS, TEAM_LABELS } from './labels';
	import type { NarratorStore } from './narrator-store.svelte';
	import type { NarratorView } from './types';
	import PhaseShell from '../components/PhaseShell.svelte';
	import SayLine from './SayLine.svelte';

	let { store }: { store: NarratorStore } = $props();

	const over = $derived(store.view as Extract<NarratorView, { kind: 'GAME_OVER' }> | null);
</script>

{#if over}
	<PhaseShell
		eyebrow="Game over"
		title={TEAM_LABELS[over.winner]}
		subtitle="Lift the veil together — everyone may finally reveal their role."
	>
		<div class="max-w-2xl">
			<SayLine text="Thank you for playing! Go around and reveal every role." />

			<ol class="mt-6 divide-y divide-border border-t border-border" aria-label="Final roles">
				{#each over.players as player (player.id)}
					<li class="flex items-center gap-3 py-2">
						<span
							class="grid size-9 shrink-0 place-items-center rounded-full border border-border bg-surface text-sm font-semibold"
							aria-hidden="true"
						>
							{player.name.slice(0, 1).toUpperCase()}
						</span>
						<p class="min-w-0 flex-1 truncate font-medium">
							{player.name}
							<span class="ml-2 text-sm font-normal text-muted">{ROLE_LABELS[player.role]}</span>
						</p>
						<p class="text-sm text-muted">{player.alive ? 'Alive' : 'Out'}</p>
					</li>
				{/each}
			</ol>
		</div>

		{#snippet footer()}
			<div class="max-w-2xl">
				<div class="flex flex-col gap-2 sm:flex-row">
					<Button
						size="lg"
						onclick={store.playAgain}
						disabled={store.busy}
						class="w-full sm:w-auto"
					>
						Play again
					</Button>
					<Button variant="ghost" onclick={store.reset} disabled={store.busy} class="sm:w-auto">
						Reset the table
					</Button>
				</div>
				<p class="mt-3 text-sm text-muted">
					Play again keeps the same group; reset clears the table for a fresh game.
				</p>
			</div>
		{/snippet}
	</PhaseShell>
{/if}
