<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import Button from '$lib/components/ui/Button.svelte';
	import * as mafiaApi from '$lib/features/mafia/multiplayer/api';
	import { getIdentity, saveIdentity } from '$lib/features/mafia/multiplayer/identity';

	const initialCode = (page.url.searchParams.get('code') ?? '')
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, '');

	let code = $state(initialCode);
	let name = $state('');
	let error = $state('');
	let busy = $state(false);

	function handleCodeInput(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		code = input.value
			.toUpperCase()
			.replace(/[^A-Z0-9]/g, '')
			.slice(0, 8);
		error = '';
	}

	function handleNameInput(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		name = input.value.slice(0, 20);
		error = '';
	}

	async function handleSubmit(event: SubmitEvent) {
		event.preventDefault();
		if (busy) return;

		if (!/^[A-Z0-9]{4,8}$/.test(code)) {
			error = code ? 'Codes are 4 to 8 letters and numbers.' : 'Enter the code your host shared.';
			return;
		}

		const trimmedName = name.trim();
		if (trimmedName.length < 1) {
			error = 'Enter the name people will see in the lobby.';
			return;
		}

		busy = true;
		error = '';

		// Rejoin path: this device already plays in this room, so drop back into
		// the same game exactly where it is (no name prompt, no new player).
		const saved = getIdentity(code);
		if (saved) {
			const room = await mafiaApi.getRoom(code);
			if (room.ok && room.data.players.some((player) => player.id === saved.playerId)) {
				goto(resolve('/mafia/room/[code]', { code }));
				return;
			}
		}

		const joined = await mafiaApi.joinRoom(code, trimmedName);
		if (!joined.ok) {
			error = joined.message;
			busy = false;
			return;
		}

		saveIdentity(joined.data.code, {
			playerId: joined.data.playerId,
			name: joined.data.name
		});
		goto(resolve('/mafia/room/[code]', { code: joined.data.code }));
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
		<p class="mt-5 text-lg leading-relaxed text-muted">
			Type in the code your host shared, pick your name, and jump in.
		</p>

		<form class="mt-10" novalidate onsubmit={handleSubmit}>
			<label for="game-code" class="block text-sm font-medium">Game code</label>
			<input
				id="game-code"
				name="game-code"
				type="text"
				value={code}
				oninput={handleCodeInput}
				placeholder="A1B2C3"
				autocomplete="off"
				autocapitalize="characters"
				spellcheck="false"
				maxlength={8}
				required
				aria-describedby={error ? 'join-error' : undefined}
				aria-invalid={error ? true : undefined}
				class="mt-2 h-14 w-full rounded-md border bg-surface px-4 text-center text-xl uppercase tracking-[0.25em] placeholder:tracking-normal placeholder:text-faint {error
					? 'border-destructive'
					: 'border-border'}"
			/>

			<label for="player-name" class="mt-5 block text-sm font-medium">Your display name</label>
			<input
				id="player-name"
				name="player-name"
				type="text"
				value={name}
				oninput={handleNameInput}
				placeholder="Alex"
				autocomplete="off"
				maxlength={20}
				required
				class="mt-2 h-14 w-full rounded-md border border-border bg-surface px-4 text-base placeholder:text-faint"
			/>

			{#if error}
				<p id="join-error" class="mt-2 text-sm text-destructive">{error}</p>
			{/if}

			<Button
				type="submit"
				size="lg"
				class="mt-6 w-full"
				disabled={busy || code.length < 4 || name.trim().length < 1}
			>
				{busy ? 'Joining…' : 'Join game'}
			</Button>
		</form>

		<p class="mt-5 text-sm text-muted">
			Joining again from this device drops you back into the same game where it is.
		</p>
	</div>
</section>
