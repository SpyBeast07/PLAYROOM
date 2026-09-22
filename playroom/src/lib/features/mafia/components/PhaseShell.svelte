<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		eyebrow = '',
		title,
		subtitle = '',
		lead = '',
		children,
		footer
	}: {
		eyebrow?: string;
		title: string;
		subtitle?: string;
		lead?: string;
		children?: Snippet;
		footer?: Snippet;
	} = $props();
</script>

<section class="page-shell py-10 sm:py-14">
	<div class="max-w-2xl">
		{#if eyebrow}
			<p class="eyebrow mb-4">{eyebrow}</p>
		{/if}
		<h1 class="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
		{#if subtitle}
			<p class="mt-3 text-lg leading-relaxed text-muted">{subtitle}</p>
		{/if}
		{#if lead}
			<p
				class="mt-5 rounded-md border border-border bg-surface p-4 text-sm leading-relaxed text-muted"
			>
				{lead}
			</p>
		{/if}
	</div>

	{#if children}
		<div class="mt-8 sm:mt-10">{@render children()}</div>
	{/if}

	{#if footer}
		<div class="mt-10">{@render footer()}</div>
	{/if}
</section>
