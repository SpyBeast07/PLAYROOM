<script lang="ts">
	import Button from '$lib/components/ui/Button.svelte';
	import GameGlyph from '$lib/components/games/GameGlyph.svelte';
	import { GAMES } from '$lib/games';
</script>

<svelte:head>
	<title>Games — PLAYROOM</title>
	<meta name="description" content="Browse the PLAYROOM catalog of games for the whole room." />
</svelte:head>

<section class="page-shell py-16 sm:py-24">
	<div class="max-w-2xl">
		<p class="eyebrow mb-6">Catalog</p>
		<h1 class="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">Games</h1>
		<p class="mt-5 text-lg leading-relaxed text-muted">
			Mafia is ready to play — either with the whole room on their own phones, or with a single
			device driving the game as a narrator. The rest are still in the workshop.
		</p>
	</div>

	<ul class="mt-12 divide-y divide-border border-t border-border">
		{#each GAMES as game (game.name)}
			<li
				class="group grid grid-cols-1 gap-3 py-6 sm:grid-cols-[3rem_1fr_auto] sm:items-center sm:gap-x-8 sm:py-8"
			>
				<GameGlyph name={game.name} class="group-hover:border-faint group-hover:text-foreground" />
				<div>
					<h2 class="text-xl font-semibold tracking-tight sm:text-2xl">{game.name}</h2>
					<p class="mt-1.5 max-w-xl leading-relaxed text-muted">{game.description}</p>
				</div>
				{#if game.name === 'Mafia'}
					<div class="flex flex-wrap gap-2">
						<Button href="/create" variant="secondary">Create</Button>
						<Button href="/join" variant="secondary">Join</Button>
						<Button href="/mafia/narrator" variant="secondary">Narrator</Button>
					</div>
				{:else}
					<p class="text-xs font-semibold uppercase tracking-[0.14em] text-muted">Coming soon</p>
				{/if}
			</li>
		{/each}
	</ul>
</section>
