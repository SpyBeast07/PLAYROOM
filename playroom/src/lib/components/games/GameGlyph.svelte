<script lang="ts">
	let { name, class: className = '' }: { name: string; class?: string } = $props();
</script>

<div
	class="flex size-12 shrink-0 items-center justify-center rounded-[0.375rem] border border-border bg-surface text-faint transition-colors {className}"
>
	<svg
		class="size-6"
		viewBox="0 0 24 24"
		aria-hidden="true"
		fill="none"
		stroke="currentColor"
		stroke-width="1.5"
		stroke-linecap="round"
		stroke-linejoin="round"
	>
		{#if name === 'Mafia'}
			<rect x="4.5" y="6.5" width="15" height="7.5" rx="3.75" />
			<circle cx="9" cy="10.25" r="1.3" fill="var(--color-accent)" stroke="none" />
			<circle cx="15" cy="10.25" r="1.3" fill="var(--color-accent)" stroke="none" />
			<path d="M12 14v4.5" />
		{:else if name === 'Housie'}
			<path d="M9 4v16M15 4v16" />
			<path d="M4 9h16M4 15h16" />
			<rect
				x="5.5"
				y="5.5"
				width="3"
				height="3"
				rx="0.75"
				fill="var(--color-accent)"
				stroke="none"
			/>
			<rect
				x="10.5"
				y="10.5"
				width="3"
				height="3"
				rx="0.75"
				fill="var(--color-accent)"
				stroke="none"
			/>
			<rect
				x="15.5"
				y="15.5"
				width="3"
				height="3"
				rx="0.75"
				fill="var(--color-accent)"
				stroke="none"
			/>
		{:else if name === 'Connect 4'}
			<circle cx="8" cy="6" r="2" />
			<circle cx="8" cy="10.7" r="2" />
			<circle cx="8" cy="15.4" r="2" />
			<circle cx="8" cy="20" r="2" />
			<circle cx="16" cy="6" r="2" />
			<circle cx="16" cy="10.7" r="2" />
			<circle cx="16" cy="15.4" r="2" fill="var(--color-accent)" stroke="none" />
			<circle cx="16" cy="20" r="2" />
		{:else if name === 'Tic Tac Toe'}
			<path d="M12 4v16M4 12h16" />
			<path d="M6.5 6.5l3 3M9.5 6.5l-3 3" />
			<circle cx="16" cy="16" r="2.5" />
		{/if}
	</svg>
</div>
