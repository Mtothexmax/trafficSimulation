import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

/**
 * The app is a static single-page site. For the export to GitHub Pages
 * (export.ps1 sets EXPORT_BASE_PATH, e.g. "/trafficSimulation") it is built
 * for that sub path with 404.html as the fallback page; in development it
 * runs at the root.
 */
const exportBase = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.EXPORT_BASE_PATH;

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
			},
			adapter: adapter({
				pages: 'build',
				assets: 'build',
				fallback: exportBase !== undefined ? '404.html' : 'index.html',
				precompress: false,
				strict: false
			}),
			paths: { base: (exportBase ?? '').replace(/\/$/, '') as '' | `/${string}` }
		})
	]
});
