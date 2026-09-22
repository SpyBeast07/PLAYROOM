<script lang="ts">
	import Button from '$lib/components/ui/Button.svelte';
	import type { MafiaStore } from '$lib/features/mafia/multiplayer/mafia-store.svelte';
	import PhaseShell from './PhaseShell.svelte';

	let { store }: { store: MafiaStore } = $props();

	const role = $derived(store.myRole);
	const seen = $derived(store.privateState?.roleSeen ?? false);
</script>

<PhaseShell
	eyebrow="Round 1 · Secrets"
	title="Your role"
	subtitle="Keep this to yourself. Other players must not see your screen until the reveal."
>
	<div class="max-w-xl">
		<div
			class="rounded-lg border border-accent/40 bg-surface p-6 sm:p-8"
			role="status"
			aria-label="Your role"
		>
			<p class="eyebrow mb-2">You are</p>
			<p class="text-3xl font-semibold tracking-tight sm:text-4xl">{store.roleName(role)}</p>
			<p class="mt-3 text-lg leading-relaxed text-muted">{store.roleDescription(role)}</p>
		</div>

		{#if seen}
			<p class="mt-6 text-sm text-muted">
				Your role is noted. Waiting for the other players to check theirs…
			</p>
		{:else}
			<Button size="lg" onclick={store.reportRoleSeen} class="mt-6 w-full sm:w-auto">
				I've seen my role
			</Button>
		{/if}
	</div>

	{#snippet footer()}
		{#if store.isHost}
			<div class="max-w-2xl">
				<Button
					size="lg"
					onclick={store.advance}
					disabled={!store.allRolesSeen}
					class="w-full sm:w-auto"
				>
					Start the night
				</Button>
				{#if !store.allRolesSeen}
					<p class="mt-3 text-sm text-muted">Wait until every player has confirmed their role.</p>
				{/if}
			</div>
		{/if}
	{/snippet}
</PhaseShell>
