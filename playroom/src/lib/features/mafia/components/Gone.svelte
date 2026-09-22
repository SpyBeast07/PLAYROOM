<script lang="ts">
	import Button from '$lib/components/ui/Button.svelte';
	import type { MafiaStore } from '$lib/features/mafia/multiplayer/mafia-store.svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';

	let { store }: { store: MafiaStore } = $props();
</script>

<section class="page-shell py-16 sm:py-24">
	<div class="max-w-xl">
		<p class="eyebrow mb-6">Room {store.roomCode}</p>
		<h1 class="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
			This room is no longer available.
		</h1>
		<p class="mt-5 text-lg leading-relaxed text-muted">
			{store.fatal ?? 'The room may have closed, or you may have been removed from it.'}
		</p>
		<div class="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
			<Button size="lg" onclick={() => store.reconnectNow()}>Try again</Button>
			<Button variant="secondary" size="lg" onclick={() => goto(resolve('/games'))}
				>Back to games</Button
			>
		</div>
	</div>
</section>
