<script lang="ts">
	import { resolve } from '$app/paths';
	import type { RouteId } from '$app/types';
	import type { Snippet } from 'svelte';

	type Variant = 'primary' | 'secondary' | 'ghost';

	let {
		href,
		variant = 'primary',
		size = 'md',
		class: className = '',
		children,
		...rest
	}: {
		href?: RouteId;
		variant?: Variant;
		size?: 'md' | 'lg';
		class?: string;
		children: Snippet;
	} & Record<string, unknown> = $props();

	const variants: Record<Variant, string> = {
		primary: 'bg-accent text-on-accent hover:bg-accent-strong',
		secondary:
			'border border-border bg-surface text-foreground hover:border-faint hover:bg-foreground/5',
		ghost: 'text-muted hover:bg-foreground/5 hover:text-foreground'
	};

	const sizes = {
		md: 'h-10 px-4 text-sm',
		lg: 'h-12 px-6 text-base'
	};

	const classes = $derived.by(
		() =>
			`inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors active:scale-[0.99] disabled:pointer-events-none disabled:opacity-55 ${variants[variant]} ${sizes[size]} ${className}`
	);
</script>

{#if href}
	<a href={resolve(href)} class={classes} {...rest}>{@render children()}</a>
{:else}
	<button class={classes} {...rest}>{@render children()}</button>
{/if}
