<script lang="ts">
	import type { MafiaStore } from '$lib/features/mafia/multiplayer/mafia-store.svelte';

	let { store }: { store: MafiaStore } = $props();
</script>

{#if store.errors.length > 0}
	<div class="page-shell mt-4">
		<ul class="flex flex-col gap-2" aria-live="polite">
			{#each store.errors as error (error.id)}
				<li
					class="flex items-start justify-between gap-4 rounded-md border border-destructive/40 bg-destructive/5 p-3.5 text-sm text-foreground"
				>
					<p>{error.message}</p>
					<button
						type="button"
						onclick={() => store.dismissError(error.id)}
						aria-label="Dismiss error"
						class="shrink-0 rounded p-1 text-muted transition-colors hover:text-foreground"
					>
						<svg
							class="size-4"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
						>
							<path d="M6 6l12 12M18 6L6 18" stroke-linecap="round" />
						</svg>
					</button>
				</li>
			{/each}
		</ul>
	</div>
{/if}
