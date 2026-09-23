import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [svelte()],
	resolve: {
		alias: [
			{ find: /^\$lib/, replacement: fileURLToPath(new URL('./src/lib', import.meta.url)) },
			{
				find: /^\$app\/environment$/,
				replacement: fileURLToPath(new URL('./tests/app/environment.ts', import.meta.url))
			},
			{
				find: /^\$app\/paths$/,
				replacement: fileURLToPath(new URL('./tests/app/paths.ts', import.meta.url))
			}
		]
	},
	test: {
		include: ['tests/**/*.test.ts'],
		environment: 'node'
	}
});
