<script lang="ts">
	import Button from '$lib/components/ui/Button.svelte';
	import type { NarratorStore } from './narrator-store.svelte';
	import type {
		NarratorNightSlot,
		NarratorPublicPlayer,
		NarratorView,
		NightActionType
	} from './types';
	import PhaseShell from '../components/PhaseShell.svelte';
	import SayLine from './SayLine.svelte';
	import TargetList from '../components/TargetList.svelte';

	let { store }: { store: NarratorStore } = $props();

	const night = $derived(store.view as Extract<NarratorView, { kind: 'NIGHT' }> | null);

	interface Step {
		key: NightActionType;
		label: string;
		openSay: string;
		slot: NarratorNightSlot;
	}

	const steps = $derived.by<Step[]>(() => {
		if (night === null) return [];
		return [
			{
				key: 'MAFIA_KILL',
				label: 'Mafia',
				openSay: `${night.actingMafiaName} — open your eyes. Show me who to eliminate tonight.`,
				slot: night.kill
			},
			{
				key: 'DOCTOR_SAVE',
				label: 'Doctor',
				openSay:
					'Doctor — open your eyes. Who do you protect tonight? You may also protect no one.',
				slot: night.save
			},
			{
				key: 'DETECTIVE_INVESTIGATE',
				label: 'Detective',
				openSay: 'Detective — open your eyes. Look closely at one player.',
				slot: night.investigate
			}
		];
	});

	const current = $derived(steps.find((step) => step.slot.status === 'NOT_ACTED') ?? null);
	const killDone = $derived(night !== null && night.kill.status !== 'NOT_ACTED');

	const targets = $derived.by<NarratorPublicPlayer[]>(() => {
		if (night === null || current === null) return [];
		const alive = night.players.filter((player) => player.alive);
		if (current.key === 'MAFIA_KILL')
			return alive.filter((player) => player.name !== night.actingMafiaName);
		return alive;
	});

	function record(targetId: string | null) {
		if (current === null) return;
		store.recordNightAction(current.key, targetId);
	}
</script>

{#if night}
	<PhaseShell
		eyebrow="Night {night.nightNumber}"
		title="Collect the night actions"
		subtitle="Say each line aloud, record what they show you, then move to the next."
	>
		<div class="max-w-2xl">
			<p
				class="mb-3 flex flex-wrap items-center gap-2 text-sm font-medium text-muted"
				aria-live="polite"
			>
				{#each steps as step (step.key)}
					<span
						class="rounded-sm border border-border px-2 py-1 {current?.key === step.key
							? 'border-accent text-foreground'
							: ''}"
					>
						{step.label}
						{step.slot.status === 'NOT_ACTED'
							? '— waiting'
							: step.slot.status === 'PASSED'
								? '— passed'
								: step.slot.status === 'SKIPPED'
									? '— skipped'
									: `— ${step.slot.targetName ?? 'no one'}`}
					</span>
				{/each}
			</p>

			<SayLine
				text={current
					? current.openSay
					: 'All eyes are closed again — everyone, open your eyes when I say.'}
			/>

			{#if current}
				<div class="mt-6">
					<p class="mb-3 text-base font-medium">
						Who does the {current.label.toLowerCase()} pick?
						{#if current.key === 'MAFIA_KILL'}
							<span class="text-muted"> (not {night.actingMafiaName} themselves)</span>
						{/if}
					</p>
					<TargetList {targets} onPick={(id) => record(id)} />
					{#if current.key === 'DOCTOR_SAVE'}
						<div class="mt-4">
							<p class="text-sm text-muted">
								They may say they protect no one.
								<button
									type="button"
									onclick={() => record(null)}
									disabled={store.busy}
									class="ml-1 font-medium text-accent underline underline-offset-4 hover:text-foreground disabled:opacity-50"
								>
									Protect no one
								</button>
							</p>
						</div>
					{/if}
				</div>
			{/if}
		</div>

		{#snippet footer()}
			<div class="max-w-2xl">
				<Button
					size="lg"
					onclick={store.resolveNight}
					disabled={!killDone || store.busy}
					class="w-full sm:w-auto"
				>
					Resolve the night
				</Button>
				<p class="mt-3 text-sm text-muted">
					{!killDone
						? 'Wait for the Mafia to pick a target before resolving.'
						: current
							? 'Any remaining role below just sits out this night.'
							: "All three roles have chosen — resolve with everyone's eyes still closed."}
				</p>
			</div>
		{/snippet}
	</PhaseShell>
{/if}
