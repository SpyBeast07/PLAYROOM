<script lang="ts">
	import Button from '$lib/components/ui/Button.svelte';
	import type { MafiaStore } from '$lib/features/mafia/multiplayer/mafia-store.svelte';
	import PhaseShell from './PhaseShell.svelte';
	import PlayerList from './PlayerList.svelte';
	import TargetList from './TargetList.svelte';

	let { store }: { store: MafiaStore } = $props();

	const hostId = $derived(store.room?.players.find((player) => player.isHost)?.id ?? null);
	const nightNumber = $derived(store.publicState?.nightNumber ?? 1);
	const canKill = $derived(store.can('MAFIA_KILL'));
	const canSave = $derived(store.can('DOCTOR_SAVE'));
	const canInvestigate = $derived(store.can('DETECTIVE_INVESTIGATE'));
	const acting = $derived(canKill || canSave || canInvestigate);
	const ownNightAction = $derived(store.privateState?.ownNightAction ?? null);
	const acted = $derived(
		ownNightAction === 'SUBMITTED' || ownNightAction === 'PASSED' || ownNightAction === 'SKIPPED'
	);

	const targets = $derived(store.livingPlayers);

	const stepTitle = $derived.by<string>(() => {
		if (!store.myAlive) return "You're out of the game";
		if (!acted) {
			if (canKill) return 'Choose a player to eliminate';
			if (canSave) return 'Choose a player to save';
			if (canInvestigate) return 'Choose a player to investigate';
		}
		if (acted) return 'Choice recorded';
		return 'Keep your eyes closed';
	});

	const stepSubtitle = $derived.by<string>(() => {
		if (!store.myAlive) return 'Wait quietly through the night.';
		if (acted) return 'Waiting for the night to resolve...';
		if (acting) return '';
		return 'The night is in progress...';
	});
</script>

<PhaseShell eyebrow={`NIGHT ${nightNumber}`} title={stepTitle} subtitle={stepSubtitle}>
	<div class="max-w-2xl">
		<PlayerList players={store.players} meId={store.identity?.playerId ?? null} {hostId} />
	</div>

	{#if store.myAlive && acting && !acted}
		<div class="max-w-2xl">
			<TargetList
				{targets}
				onPick={(id) =>
					store.nightAction(
						canSave ? 'DOCTOR_SAVE' : canKill ? 'MAFIA_KILL' : 'DETECTIVE_INVESTIGATE',
						id
					)}
				passLabel={canSave ? 'Protect no one' : ''}
				onPass={canSave ? () => store.nightAction('DOCTOR_SAVE', null) : undefined}
			/>
		</div>
	{:else if store.myAlive && acted}
		<div class="max-w-2xl">
			<p class="rounded-md border border-border bg-surface p-4 text-sm text-muted">
				Waiting for the night to resolve...
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
