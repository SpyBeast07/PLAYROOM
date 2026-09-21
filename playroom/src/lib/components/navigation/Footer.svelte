<script lang="ts">
	import type { RouteId } from '$app/types';
	import { resolve } from '$app/paths';

	const links: { href: RouteId; label: string }[] = [
		{ href: '/games', label: 'Games' },
		{ href: '/create', label: 'Create a room' },
		{ href: '/join', label: 'Join a room' },
		{ href: '/about', label: 'About' }
	];
</script>

<footer class="border-t border-border bg-background">
	<div class="page-shell flex flex-col gap-5 py-8 sm:flex-row sm:items-center sm:justify-between">
		<p class="text-sm text-muted">Games for the whole room.</p>
		<nav aria-label="Footer">
			<ul class="flex flex-wrap items-center gap-x-5 gap-y-2">
				{#each links as link (link.href)}
					<li>
						<a
							href={resolve(link.href)}
							class="rounded-md py-1 text-sm text-muted transition-colors hover:text-foreground"
						>
							{link.label}
						</a>
					</li>
				{/each}
			</ul>
		</nav>
	</div>
</footer>
