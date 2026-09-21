<svelte:head>
	<title>Games — PLAYROOM</title>
	<meta name="description" content="Browse the PLAYROOM catalog of games for the whole room." />
</svelte:head>

<section class="page-shell py-16 sm:py-24">
	<div class="max-w-2xl">
		<p class="eyebrow mb-6">Catalog</p>
		<h1 class="text-balance text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
			Games
		</h1>
		<p class="mt-5 text-lg leading-relaxed text-muted">
			A growing collection of games built for groups, screens, and the whole room. New titles will
			land here.
		</p>
	</div>

	<ul class="mt-12 grid gap-4 sm:grid-cols-3">
		{#each ['Word games', 'Drawing games', 'Party games'] as category (category)}
			<li
				class="flex min-h-40 flex-col justify-between rounded-lg border border-dashed border-faint p-5"
			>
				<p class="text-sm font-medium text-foreground">{category}</p>
				<p class="text-sm text-faint">Coming soon</p>
			</li>
		{/each}
	</ul>
</section>
