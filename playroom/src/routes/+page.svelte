<script lang="ts">
	import Button from '$lib/components/ui/Button.svelte';
</script>

<svelte:head>
	<title>PLAYROOM — Games for the whole room</title>
	<meta name="description" content="PLAYROOM — Games for the whole room." />
</svelte:head>

<section class="page-shell py-16 sm:py-24 lg:py-36">
	<div class="max-w-3xl">
		<p class="eyebrow mb-6">PLAYROOM</p>
		<h1
			class="text-balance text-4xl font-semibold leading-[1.05] tracking-tight text-foreground sm:text-5xl lg:text-6xl"
		>
			Games for the whole room.
		</h1>
		<p class="mt-6 max-w-xl text-lg leading-relaxed text-muted">
			PLAYROOM turns one phone and a room full of friends into the best part of the night. Pick a
			game, jump in together, and let the room do the talking.
		</p>
		<div class="mt-10 flex flex-wrap items-center gap-3">
			<Button href="/create" size="lg">Create a room</Button>
			<Button href="/join" variant="secondary" size="lg">Join a room</Button>
		</div>
	</div>
</section>
