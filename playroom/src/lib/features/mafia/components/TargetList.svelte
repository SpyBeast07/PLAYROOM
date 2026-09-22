<script lang="ts">
	let {
		targets,
		onPick,
		passLabel = '',
		onPass
	}: {
		targets: Array<{ id: string; name: string }>;
		onPick: (id: string) => void;
		passLabel?: string;
		onPass?: () => void;
	} = $props();
</script>

<div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
	{#each targets as target (target.id)}
		<button
			type="button"
			onclick={() => onPick(target.id)}
			class="flex h-14 items-center justify-center rounded-md border border-border bg-surface px-4 text-base font-medium transition-colors hover:border-faint hover:bg-foreground/5"
		>
			<span class="truncate">{target.name}</span>
		</button>
	{/each}
</div>

{#if passLabel && onPass}
	<div class="mt-4">
		<button
			type="button"
			onclick={onPass}
			class="text-sm font-medium text-muted underline underline-offset-4 hover:text-foreground"
		>
			{passLabel}
		</button>
	</div>
{/if}
