<script lang="ts">
	import GameGlyph from '$lib/components/games/GameGlyph.svelte';

	const games = [
		{
			name: 'Mafia',
			description: 'A social deduction game of secrets, suspicion and survival.'
		},
		{
			name: 'Housie',
			description: 'Classic housie, built for the whole room.'
		},
		{
			name: 'Connect 4',
			description: 'Four in a row. Two players. One winner.'
		},
		{
			name: 'Tic Tac Toe',
			description: 'The classic, without the paper.'
		}
	];
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
			The first four games for PLAYROOM. All of them are in the workshop — nothing to play just yet.
		</p>
	</div>

	<ul class="mt-12 divide-y divide-border border-t border-border" aria-label="Games coming soon">
		{#each games as game (game.name)}
			<li
				class="group grid grid-cols-1 gap-3 py-6 sm:grid-cols-[3rem_1fr_auto] sm:items-center sm:gap-x-8 sm:py-8"
			>
				<GameGlyph name={game.name} class="group-hover:border-faint group-hover:text-foreground" />
				<div>
					<h2 class="text-xl font-semibold tracking-tight sm:text-2xl">{game.name}</h2>
					<p class="mt-1.5 max-w-xl leading-relaxed text-muted">{game.description}</p>
				</div>
				<p class="text-xs font-semibold uppercase tracking-[0.14em] text-muted">Coming soon</p>
			</li>
		{/each}
	</ul>
</section>
