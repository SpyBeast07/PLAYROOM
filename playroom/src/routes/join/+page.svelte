<script lang="ts">
	import Button from '$lib/components/ui/Button.svelte';

	let code = $state('');
	let error = $state(false);
	let submitted = $state(false);

	function handleInput(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		code = input.value
			.toUpperCase()
			.replace(/[^A-Z0-9]/g, '')
			.slice(0, 8);
		error = false;
	}

	function handleSubmit(event: SubmitEvent) {
		event.preventDefault();
		if (!/^[A-Z0-9]{4,8}$/.test(code)) {
			error = true;
			return;
		}
		error = false;
		submitted = true;
	}
</script>

<svelte:head>
	<title>Join a room — PLAYROOM</title>
	<meta name="description" content="Enter a room code and join a PLAYROOM game." />
</svelte:head>

<section class="page-shell py-16 sm:py-24">
	<div class="max-w-md">
		<p class="eyebrow mb-6">Player</p>
		<h1 class="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">Join a room</h1>
		<p class="mt-4 text-lg leading-relaxed text-muted">
			Type in the code your host shared and we'll take it from there.
		</p>

		<form class="mt-10" novalidate onsubmit={handleSubmit}>
			<label for="game-code" class="block text-sm font-medium">Game code</label>
			<input
				id="game-code"
				name="game-code"
				type="text"
				value={code}
				oninput={handleInput}
				placeholder="A1B2C3"
				autocomplete="off"
				autocapitalize="characters"
				spellcheck="false"
				maxlength={8}
				required
				aria-describedby={error ? 'game-code-error' : undefined}
				aria-invalid={error || undefined}
				class="mt-2 h-14 w-full rounded-md border bg-surface px-4 text-center text-xl uppercase tracking-[0.25em] placeholder:tracking-normal placeholder:text-faint {error
					? 'border-destructive'
					: 'border-border'}"
			/>
			{#if error}
				<p id="game-code-error" class="mt-2 text-sm text-destructive">
					{code ? 'Codes are 4 to 8 letters and numbers.' : 'Enter the code your host shared.'}
				</p>
			{/if}

			<Button type="submit" size="lg" class="mt-6 w-full">Join game</Button>
		</form>

		{#if submitted}
			<p
				role="status"
				class="mt-6 rounded-md border border-border bg-surface p-4 text-sm text-muted"
			>
				Joining rooms is coming soon — there is nothing to connect to yet.
			</p>
		{/if}
	</div>
</section>
