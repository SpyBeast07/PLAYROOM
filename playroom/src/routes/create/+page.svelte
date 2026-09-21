<script lang="ts">
	import GameGlyph from '$lib/components/games/GameGlyph.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import { GAMES } from '$lib/games';

	let selectedGame = $state('');
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
			Pick a game to start your room. Every game is still in the workshop, so rooms can't open just
			yet.
		</p>

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

		<div class="mt-10">
			<Button size="lg" class="w-full sm:w-auto" disabled>Start game</Button>
			<p class="mt-3 text-sm text-muted">
				Rooms open when the first game ships. Nothing is created yet.
			</p>
		</div>
	</div>
</section>
