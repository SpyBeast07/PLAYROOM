<script lang="ts">
	import Button from '$lib/components/ui/Button.svelte';
	import type { NarratorStore } from './narrator-store.svelte';
	import type { NarratorView } from './types';
	import PhaseShell from '../components/PhaseShell.svelte';
	import SayLine from './SayLine.svelte';

	let { store }: { store: NarratorStore } = $props();

	const lobby = $derived(store.view as Extract<NarratorView, { kind: 'LOBBY' }> | null);

	let name = $state('');
	let addBusy = $state(false);

	async function handleAdd() {
		const trimmed = name.trim();
		if (trimmed.length < 1) return;
		addBusy = true;
		try {
			await store.addPlayer(trimmed);
			name = '';
		} finally {
			addBusy = false;
		}
	}

	function handleNameInput(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		name = input.value.slice(0, 20);
	}
</script>

{#if lobby}
	<PhaseShell
		eyebrow="Narrator"
		title="Set up the game"
		subtitle="One phone, no cards. Add everyone, then start when the room is ready."
	>
		<div class="max-w-2xl">
			<SayLine text="Add all players and start when everyone has arrived." />

			<div class="mt-6 flex max-w-md gap-2">
				<label class="sr-only" for="narrator-new-player">Player name</label>
				<input
					id="narrator-new-player"
					type="text"
					value={name}
					oninput={handleNameInput}
					onkeydown={(event) => {
						if (event.key === 'Enter') {
							event.preventDefault();
							handleAdd();
						}
					}}
					placeholder="Player name"
					autocomplete="off"
					maxlength={20}
					class="h-12 w-full rounded-md border border-border bg-surface px-4 text-base placeholder:text-faint"
				/>
				<Button onclick={handleAdd} disabled={addBusy || name.trim().length < 1}>Add</Button>
			</div>

			<ol
				class="mt-6 divide-y divide-border border-t border-border"
				aria-label="Players in the lobby"
			>
				{#each lobby.players as player (player.id)}
					<li class="flex min-h-12 items-center gap-3 py-2">
						<span
							class="grid size-9 shrink-0 place-items-center rounded-full border border-border bg-surface text-sm font-semibold"
							aria-hidden="true"
						>
							{player.name.slice(0, 1).toUpperCase()}
						</span>
						<p class="min-w-0 flex-1 truncate font-medium">{player.name}</p>
						<button
							type="button"
							onclick={() => store.removePlayer(player.id)}
							disabled={store.busy}
							class="rounded p-1.5 text-muted transition-colors hover:bg-foreground/5 hover:text-foreground disabled:opacity-50"
							aria-label={`Remove ${player.name}`}
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
			</ol>

			{#if lobby.players.length === 0}
				<p class="mt-6 text-muted">No players yet — add the first one above.</p>
			{/if}
		</div>

		{#snippet footer()}
			<div class="max-w-2xl">
				<Button
					size="lg"
					onclick={store.startGame}
					disabled={!lobby.canStart || store.busy}
					class="w-full sm:w-auto"
				>
					Start the game
				</Button>
				<p class="mt-3 text-sm text-muted">
					{lobby.canStart
						? 'Everyone is in — start and deal the roles.'
						: `Need at least ${lobby.minPlayers} players to start.`}
				</p>
			</div>
		{/snippet}
	</PhaseShell>
{/if}
