<script lang="ts">
	let { text }: { text: string } = $props();
</script>

<div
	class="rounded-md border border-accent/40 bg-surface p-4 text-lg leading-relaxed"
	role="status"
>
	<span
		class="mr-3 inline-block rounded-sm bg-accent px-1.5 py-0.5 align-middle text-xs font-semibold uppercase tracking-wider text-on-accent"
		>Say</span
	>
	{text}
</div>
