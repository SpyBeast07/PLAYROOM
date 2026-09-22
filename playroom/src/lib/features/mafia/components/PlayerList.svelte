<script lang="ts">
	import type { MafiaPublicPlayer } from '$lib/features/mafia/multiplayer/types';

	let {
		players,
		meId,
		hostId = null,
		showReady = false
	}: {
		players: MafiaPublicPlayer[];
		meId: string | null;
		hostId?: string | null;
		showReady?: boolean;
	} = $props();
</script>

<ol class="divide-y divide-border border-t border-border" aria-label="Players">
	{#each players as player (player.id)}
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
					{#if player.id === meId}<span class="font-normal text-muted"> (you)</span>{/if}
				</p>
				<p class="text-xs text-muted">
					{#if showReady}
						{player.ready ? 'Ready' : 'Not ready'}
					{:else}
						{player.alive ? 'Alive' : 'Out'}
					{/if}
				</p>
			</div>
			{#if player.id === hostId}
				<span
					class="rounded-sm border border-border px-1.5 py-0.5 text-[0.7rem] font-semibold uppercase tracking-wider text-muted"
				>
					Host
				</span>
			{/if}
			{#if showReady && player.ready}
				<span class="text-accent" aria-label="Ready">
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
			{/if}
		</li>
	{/each}
</ol>
