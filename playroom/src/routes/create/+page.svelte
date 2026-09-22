<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import Button from '$lib/components/ui/Button.svelte';
	import GameGlyph from '$lib/components/games/GameGlyph.svelte';
	import * as mafiaApi from '$lib/features/mafia/multiplayer/api';
	import { saveIdentity } from '$lib/features/mafia/multiplayer/identity';
	import { GAMES } from '$lib/games';

	let selectedGame = $state('');
	let name = $state('');
	let error = $state('');
	let busy = $state(false);

	const mafiaSelected = $derived(selectedGame === 'Mafia');

	function handleNameInput(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		name = input.value.slice(0, 20);
		error = '';
	}

	async function handleCreate(event: SubmitEvent) {
		event.preventDefault();
		if (!mafiaSelected) return;
		if (busy) return;

		const trimmedName = name.trim();
		if (trimmedName.length < 1) {
			error = 'Enter the name people will see in the lobby.';
			return;
		}

		busy = true;
		error = '';

		const room = await mafiaApi.createRoom();
		if (!room.ok) {
			error = room.message;
			busy = false;
			return;
		}

		const joined = await mafiaApi.joinRoom(room.data.code, trimmedName);
		if (!joined.ok) {
			error = joined.message;
			busy = false;
			return;
		}

		saveIdentity(joined.data.code, { playerId: joined.data.playerId, name: joined.data.name });
		goto(resolve('/mafia/room/[code]', { code: joined.data.code }));
	}
</script>

<svelte:head>
	<title>Create a room — PLAYROOM</title>
	<meta name="description" content="Start a new PLAYROOM game and invite the whole room." />
</svelte:head>

<section class="page-shell py-16 sm:py-24">
	<div class="max-w-2xl">
		<p class="eyebrow mb-6">Host</p>
		<h1 class="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">Create a room</h1>
		<p class="mt-5 text-lg leading-relaxed text-muted">
			Pick a game to start your room. Mafia is ready to play; the rest are still in the workshop.
		</p>

		<form novalidate onsubmit={handleCreate}>
			<fieldset class="mt-12">
				<legend class="text-lg font-semibold tracking-tight">Choose a game</legend>
				<ul class="mt-6 divide-y divide-border border-t border-border">
					{#each GAMES as game (game.name)}
						<li>
							<label
								class="group grid cursor-pointer grid-cols-[auto_1fr_auto] items-center gap-4 rounded-md px-1.5 py-3.5 transition-colors hover:bg-surface has-checked:bg-surface"
							>
								<input
									type="radio"
									name="game"
									value={game.name}
									bind:group={selectedGame}
									class="peer sr-only"
								/>
								<GameGlyph
									name={game.name}
									class="group-hover:border-faint group-hover:text-foreground peer-checked:border-faint peer-checked:text-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-accent peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background"
								/>
								<div>
									<span class="block font-semibold text-foreground">{game.name}</span>
									<span class="mt-0.5 block text-sm text-muted">{game.description}</span>
								</div>
								<span
									aria-hidden="true"
									class="size-5 rounded-full border border-faint transition-colors peer-checked:border-accent peer-checked:bg-accent"
								></span>
							</label>
						</li>
					{/each}
				</ul>
			</fieldset>

			{#if mafiaSelected}
				<div class="mt-10 max-w-md">
					<label for="host-name" class="block text-sm font-medium">Your display name</label>
					<input
						id="host-name"
						name="host-name"
						type="text"
						value={name}
						oninput={handleNameInput}
						placeholder="Alex"
						autocomplete="off"
						maxlength={20}
						aria-describedby={error ? 'create-error' : undefined}
						aria-invalid={error ? true : undefined}
						class="mt-2 h-14 w-full rounded-md border bg-surface px-4 text-base placeholder:text-faint {error
							? 'border-destructive'
							: 'border-border'}"
					/>
					{#if error}
						<p id="create-error" class="mt-2 text-sm text-destructive">{error}</p>
					{/if}
					<Button
						type="submit"
						size="lg"
						class="mt-6 w-full sm:w-auto"
						disabled={busy || name.trim().length < 1}
					>
						{busy ? 'Creating…' : 'Create room'}
					</Button>
					<p class="mt-3 text-sm text-muted">
						You'll become the host, get a room code to share, and jump straight into the lobby.
					</p>
				</div>
			{:else}
				<div class="mt-10">
					<Button size="lg" class="w-full sm:w-auto" disabled>Start game</Button>
					<p class="mt-3 text-sm text-muted">
						Only Mafia can be played right now. Pick it above to open a room.
					</p>
				</div>
			{/if}
		</form>
	</div>
</section>
