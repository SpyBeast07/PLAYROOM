<script lang="ts">
	import Button from '$lib/components/ui/Button.svelte';
	import { ROLE_LABELS } from './labels';
	import type { NarratorStore } from './narrator-store.svelte';
	import type { NarratorView } from './types';
	import PhaseShell from '../components/PhaseShell.svelte';
	import SayLine from './SayLine.svelte';

	let { store }: { store: NarratorStore } = $props();

	const reveal = $derived(store.view as Extract<NarratorView, { kind: 'ROLE_REVEAL' }> | null);

	let showing = $state(false);
	let hasRevealed = $state(false);

	function toggleReveal() {
		showing = !showing;
		if (showing) hasRevealed = true;
	}
</script>

{#if reveal}
	<PhaseShell
		eyebrow="Deal the roles"
		title="Tell every player their role"
		subtitle="Everyone keeps their eyes closed — you whisper each role, one person at a time."
	>
		<div class="max-w-2xl">
			<SayLine
				text="Everyone, close your eyes. I'll walk the room and whisper each role — keep it secret until I say otherwise."
			/>

			<div class="mt-6">
				<Button size="lg" onclick={toggleReveal} variant={showing ? 'secondary' : 'primary'}>
					{showing ? 'Hide roles' : 'Reveal all roles'}
				</Button>

				{#if showing}
					<ol class="mt-6 divide-y divide-border border-t border-border" aria-label="Dealt roles">
						{#each reveal.players as player (player.id)}
							<li class="flex items-center gap-3 py-2">
								<span
									class="grid size-9 shrink-0 place-items-center rounded-full border border-border bg-surface text-sm font-semibold"
									aria-hidden="true"
								>
									{player.name.slice(0, 1).toUpperCase()}
								</span>
								<p class="min-w-0 flex-1 truncate font-medium">{player.name}</p>
								<p class="text-sm font-semibold text-muted">{ROLE_LABELS[player.role]}</p>
							</li>
						{/each}
					</ol>
				{:else}
					<p class="mt-4 text-sm text-muted">
						Roles stay hidden until you reveal them all together.
					</p>
				{/if}
			</div>
		</div>

		{#snippet footer()}
			<div class="max-w-2xl">
				<Button
					size="lg"
					onclick={store.beginNight}
					disabled={!hasRevealed || store.busy}
					class="w-full sm:w-auto"
				>
					Begin the night
				</Button>
				<p class="mt-3 text-sm text-muted">
					{hasRevealed
						? 'Dim the lights and begin the first night.'
						: 'Reveal the roles before moving to night.'}
				</p>
			</div>
		{/snippet}
	</PhaseShell>
{/if}
