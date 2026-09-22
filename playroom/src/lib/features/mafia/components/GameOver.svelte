<script lang="ts">
	import Button from '$lib/components/ui/Button.svelte';
	import type { MafiaRole } from '$lib/features/mafia/multiplayer/types';
	import type { MafiaStore } from '$lib/features/mafia/multiplayer/mafia-store.svelte';
	import PhaseShell from './PhaseShell.svelte';

	let { store }: { store: MafiaStore } = $props();

	const revealed = $derived(store.publicState?.revealedRoles ?? {});
	const rows = $derived(
		store.players.map((player) => ({
			...player,
			role: (revealed[player.id] ?? null) as MafiaRole | null
		}))
	);
</script>

<PhaseShell
	eyebrow="Game over"
	title={store.winnerLabel ?? 'Game over'}
	subtitle="Every role is now public. Thanks for playing."
>
	<div class="max-w-2xl">
		<ol class="divide-y divide-border border-t border-border" aria-label="Roles">
			{#each rows as player (player.id)}
				<li class="flex min-h-14 items-center gap-3 py-2">
					<span
						class="grid size-9 shrink-0 place-items-center rounded-full border border-border bg-surface text-sm font-semibold"
						aria-hidden="true"
					>
						{player.name.slice(0, 1).toUpperCase()}
					</span>
					<div class="min-w-0 flex-1">
						<p class="truncate font-medium">
							{player.name}
							{#if player.id === store.identity?.playerId}<span class="font-normal text-muted">
									(you)</span
								>{/if}
						</p>
						<p class="text-xs text-muted">{player.alive ? 'Alive' : 'Out'}</p>
					</div>
					<span
						class="rounded-sm border border-border px-2 py-1 text-xs font-semibold {player.role ===
						'MAFIA'
							? 'text-destructive'
							: 'text-foreground'}"
					>
						{store.roleName(player.role)}
					</span>
				</li>
			{/each}
		</ol>
	</div>

	{#snippet footer()}
		<div class="max-w-2xl">
			{#if store.isHost}
				<Button size="lg" onclick={store.playAgain} class="w-full sm:w-auto">Play again</Button>
			{:else}
				<p class="text-sm text-muted">Waiting for the host to start another round…</p>
			{/if}
		</div>
	{/snippet}
</PhaseShell>
