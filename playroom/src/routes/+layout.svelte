<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';
	import '$lib/styles/app.css';
	import Footer from '$lib/components/navigation/Footer.svelte';
	import Header from '$lib/components/navigation/Header.svelte';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>PLAYROOM — Games for the whole room</title>
</svelte:head>

<a class="skip-link" href="#main-content">Skip to content</a>

<div class="flex min-h-dvh flex-col">
	<Header />
	<main id="main-content" class="flex-1">
		{@render children()}
	</main>
	<Footer />
</div>
