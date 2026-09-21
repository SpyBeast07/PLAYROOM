<script lang="ts">
	import { GAMES } from '$lib/games';
	import Button from '$lib/components/ui/Button.svelte';
</script>

<svelte:head>
	<title>PLAYROOM — Games for the whole room</title>
	<meta
		name="description"
		content="Play simple party games together. Join from your phone or pass one around."
	/>
</svelte:head>

<section class="page-shell py-20 sm:py-28 lg:py-40">
	<div class="max-w-3xl">
		<h1
			class="text-balance text-5xl font-semibold leading-[1.05] tracking-tight text-foreground sm:text-6xl lg:text-7xl"
		>
			Games for the whole room.
		</h1>
		<p class="mt-6 max-w-xl text-lg leading-relaxed text-muted sm:text-xl">
			Pick a game. Grab your friends. Play.
		</p>
		<div class="mt-10 flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
			<Button href="/create" size="lg" class="w-full sm:w-auto">Create a game</Button>
			<Button href="/join" variant="secondary" size="lg" class="w-full sm:w-auto"
				>Join a game</Button
			>
		</div>
	</div>
</section>

<section class="border-t border-border">
	<div class="page-shell py-16 sm:py-24">
		<div class="max-w-2xl">
			<p class="eyebrow mb-6">Coming soon</p>
			<h2 class="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">The lineup</h2>
		</div>
		<ul class="mt-12 divide-y divide-border">
			{#each GAMES as game (game.name)}
				<li
					class="grid gap-2 py-6 sm:grid-cols-[minmax(0,10rem)_1fr_auto] sm:items-baseline sm:gap-6"
				>
					<h3 class="text-lg font-semibold tracking-tight sm:text-xl">{game.name}</h3>
					<p class="leading-relaxed text-muted">{game.description}</p>
					<p class="text-xs font-semibold uppercase tracking-[0.14em] text-muted">Coming soon</p>
				</li>
			{/each}
		</ul>
	</div>
</section>
