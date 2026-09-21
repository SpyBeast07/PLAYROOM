<script lang="ts">
	import { resolve } from '$app/paths';

	let { class: className = '' } = $props();
</script>

<a
	href={resolve('/')}
	aria-label="PLAYROOM — home"
	class="inline-flex items-center gap-2.5 {className}"
>
	<svg class="size-6 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
		<rect width="24" height="24" rx="5" fill="var(--color-foreground)" />
		<rect x="15" y="15" width="6" height="6" rx="1.5" fill="var(--color-accent)" />
	</svg>
	<span class="text-sm font-semibold uppercase tracking-[0.14em] text-foreground">PLAYROOM</span>
</a>
