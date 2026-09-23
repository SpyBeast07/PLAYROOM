<script lang="ts">
	import Button from '$lib/components/ui/Button.svelte';
	import { ROLE_LABELS } from './labels';
	import type { NarratorStore } from './narrator-store.svelte';
	import type { NarratorRoleRow, NarratorView } from './types';
	import PhaseShell from '../components/PhaseShell.svelte';
	import SayLine from './SayLine.svelte';

	let { store }: { store: NarratorStore } = $props();

	const reveal = $derived(store.view as Extract<NarratorView, { kind: 'ROLE_REVEAL' }> | null);

	let openId = $state<string | null>(null);
	let toldIds = $state<string[]>([]);

	const allTold = $derived(reveal !== null && toldIds.length === reveal.players.length);

	function revealRow(player: NarratorRoleRow) {
		if (openId === player.id) openId = null;
		else openId = player.id;
	}

	function markTold(player: NarratorRoleRow) {
		if (!toldIds.includes(player.id)) toldIds = [...toldIds, player.id];
		if (openId === player.id) openId = null;
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

			<ol class="mt-6 divide-y divide-border border-t border-border" aria-label="Role reveal order">
				{#each reveal.players as player (player.id)}
					<li class="py-3">
						<div class="flex items-center gap-3">
							<span
								class="grid size-9 shrink-0 place-items-center rounded-full border border-border bg-surface text-sm font-semibold"
								aria-hidden="true"
							>
								{player.name.slice(0, 1).toUpperCase()}
							</span>
							<p class="min-w-0 flex-1 truncate font-medium">
								{player.name}
								{#if toldIds.includes(player.id)}
									<span class="ml-2 text-sm font-normal text-muted">told</span>
								{/if}
							</p>
							{#if toldIds.includes(player.id)}
								<span aria-label="Told" class="text-accent">
									<svg
										class="size-5"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
									>
										<path d="M4 12.5l5 5L20 6.5" stroke-linecap="round" stroke-linejoin="round" />
									</svg>
								</span>
							{:else}
								<Button variant="secondary" onclick={() => revealRow(player)}>
									{openId === player.id ? 'Hide' : 'Reveal role'}
								</Button>
							{/if}
						</div>
						{#if openId === player.id && !toldIds.includes(player.id)}
							<div
								class="mt-3 rounded-md border border-accent/40 bg-accent/5 p-4"
								aria-label={`${player.name}'s role`}
							>
								<p class="eyebrow mb-1">Whisper this</p>
								<p class="text-2xl font-semibold tracking-tight">
									{player.name}, you are the {ROLE_LABELS[player.role]}
								</p>
								<p class="mt-2 text-sm leading-relaxed text-muted">
									Keep it secret. Tell them to close their eyes again before the next person.
								</p>
								<Button size="lg" onclick={() => markTold(player)} class="mt-4">
									I've told them
								</Button>
							</div>
						{/if}
					</li>
				{/each}
			</ol>
		</div>

		{#snippet footer()}
			<div class="max-w-2xl">
				<Button
					size="lg"
					onclick={store.beginNight}
					disabled={!allTold || store.busy}
					class="w-full sm:w-auto"
				>
					Begin the night
				</Button>
				<p class="mt-3 text-sm text-muted">
					{allTold
						? 'All roles are told — dim the lights and begin the first night.'
						: 'Whisper every role before moving to night.'}
				</p>
			</div>
		{/snippet}
	</PhaseShell>
{/if}
