<script lang="ts">
	import { browser } from '$app/environment';
	import NarratorShell from '$lib/features/mafia/narrator/NarratorShell.svelte';
	import { NarratorStore } from '$lib/features/mafia/narrator/narrator-store.svelte';

	let store = $state<NarratorStore | null>(null);

	$effect(() => {
		if (!browser) return;
		if (store) return;
		store = new NarratorStore();
	});

	$effect(() => {
		const active = store;
		if (!active) return;
		active.boot();
	});
</script>

<svelte:head>
	<title>Mafia · Narrator — PLAYROOM</title>
	<meta name="description" content="Run Mafia with one phone — no phones for the players." />
</svelte:head>

{#if store}
	<NarratorShell {store} />
{:else}
	<section class="page-shell py-16 sm:py-20">
		<p class="text-lg text-muted">Starting the narrator…</p>
	</section>
{/if}
