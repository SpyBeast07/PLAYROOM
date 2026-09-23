<script lang="ts">
	import Button from '$lib/components/ui/Button.svelte';
	import type { MafiaStore } from '$lib/features/mafia/multiplayer/mafia-store.svelte';
	import PhaseShell from './PhaseShell.svelte';
	import PlayerList from './PlayerList.svelte';
	import TargetList from './TargetList.svelte';

	let { store }: { store: MafiaStore } = $props();

	const hostId = $derived(store.room?.players.find((player) => player.isHost)?.id ?? null);
	const canKill = $derived(store.can('MAFIA_KILL'));
	const canSave = $derived(store.can('DOCTOR_SAVE'));
	const canInvestigate = $derived(store.can('DETECTIVE_INVESTIGATE'));
	const acting = $derived(canKill || canSave || canInvestigate);
	const acted = $derived(store.privateState?.ownNightAction !== null);

	const targets = $derived(store.livingPlayers);
</script>

<PhaseShell
	eyebrow="Night {store.publicState?.nightNumber ?? 1}"
	title="The city sleeps"
	subtitle="Keep your eyes closed. Move and act without being noticed."
	lead={store.myAlive
		? canKill
			? 'Silently choose who the Mafia takes tonight.'
			: canSave
				? 'Choose who to protect tonight \u2014 or pass to protect no one.'
				: canInvestigate
					? 'Study the town. Choose one player to investigate tonight.'
					: 'You cannot act tonight. Stay quiet and wait for morning.'
		: "You're out of the game. Wait quietly through the night."}
>
	<div class="max-w-2xl">
		<PlayerList players={store.players} meId={store.identity?.playerId ?? null} {hostId} />
	</div>

	{#if store.myAlive && acting && !acted}
		<div class="max-w-2xl">
			{#if canSave}
				<p class="mb-3 text-sm text-muted">Who will you protect?</p>
				<TargetList
					{targets}
					onPick={(id) => store.nightAction('DOCTOR_SAVE', id)}
					passLabel="Protect no one"
					onPass={() => store.nightAction('DOCTOR_SAVE', null)}
				/>
			{:else}
				{#if canKill}
					<p class="mb-3 text-sm text-muted">Choose your target.</p>
				{:else}
					<p class="mb-3 text-sm text-muted">Who will you investigate?</p>
				{/if}
				<TargetList
					{targets}
					onPick={(id) => store.nightAction(canKill ? 'MAFIA_KILL' : 'DETECTIVE_INVESTIGATE', id)}
				/>
			{/if}
		</div>
	{:else if acted}
		<div class="max-w-2xl">
			<p class="rounded-md border border-border bg-surface p-4 text-sm text-muted">
				Your choice is recorded. Keep quiet and wait for the others…
			</p>
		</div>
	{/if}

	{#snippet footer()}
		{#if store.isHost && store.phase === 'NIGHT'}
			<div class="max-w-2xl">
				<Button size="lg" onclick={store.advance} class="w-full sm:w-auto">
					{store.nightPending === 0 ? 'Resolve the night' : 'Skip players who haven\u2019t acted'}
				</Button>
				{#if store.nightPending > 0}
					<p class="mt-3 text-sm text-muted">
						Resolving now will skip {store.nightPending} still-pending action{store.nightPending ===
						1
							? ''
							: 's'}.
					</p>
				{/if}
			</div>
		{/if}
	{/snippet}
</PhaseShell>
