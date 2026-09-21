<script lang="ts">
	import type { RouteId } from '$app/types';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import Logo from '$lib/components/navigation/Logo.svelte';

	const navLinks: { href: RouteId; label: string }[] = [
		{ href: '/games', label: 'Games' },
		{ href: '/about', label: 'About' }
	];

	const pathname = $derived(page.url.pathname);

	function isActive(href: string) {
		return pathname === href;
	}
</script>

<header class="border-b border-border bg-background">
	<div class="page-shell flex h-14 items-center justify-between gap-6">
		<Logo />
		<nav aria-label="Primary">
			<ul class="flex items-center gap-1">
				{#each navLinks as link (link.href)}
					<li>
						<a
							href={resolve(link.href)}
							aria-current={isActive(link.href) ? 'page' : undefined}
							class="rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors {isActive(
								link.href
							)
								? 'text-foreground'
								: 'text-muted hover:text-foreground'}"
						>
							{link.label}
						</a>
					</li>
				{/each}
			</ul>
		</nav>
	</div>
</header>
