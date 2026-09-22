<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import MafiaGame from '$lib/features/mafia/components/MafiaGame.svelte';
	import { getIdentity } from '$lib/features/mafia/multiplayer/identity';
	import { MafiaStore } from '$lib/features/mafia/multiplayer/mafia-store.svelte';

	const roomCode = $derived((page.params.code ?? '').toUpperCase());
	let store = $state<MafiaStore | null>(null);

	$effect(() => {
		if (!browser) return;
		if (store) return;
		if (getIdentity(roomCode)) {
			store = new MafiaStore(roomCode);
		} else {
			goto(resolve(`/join?code=${roomCode}`), { replaceState: true });
		}
	});

	$effect(() => {
		const active = store;
		if (!active) return;
		active.connect();
		return () => active.dispose();
	});
</script>

<svelte:head>
	<title>Mafia · {roomCode} — PLAYROOM</title>
</svelte:head>

{#if store}
	<MafiaGame {store} />
{:else}
	<section class="page-shell py-16 sm:py-20">
		<p class="text-lg text-muted">Getting your seat back…</p>
	</section>
{/if}
