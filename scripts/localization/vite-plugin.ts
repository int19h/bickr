import { execFileSync } from 'node:child_process';
import type { Plugin } from 'vite';
import { repository as root, sourceDirectories as directories } from './paths.ts';

/** Compile before module resolution and when a readable source changes in dev/watch. */
export function localizationPlugin(): Plugin {
	const generate = () => execFileSync(process.execPath, ['scripts/generate-localization.ts'], { cwd: root, stdio: 'inherit' });
	let sourceError: Error | undefined;
	generate();
	return {
		name: 'bickr-localization-sources',
		configureServer(server) {
			server.watcher.add(directories);
			const update = (file: string) => {
				if (!directories.some((directory) => file.startsWith(directory)) || !/\.(yaml|md)$/.test(file)) return;
				try {
					generate();
					sourceError = undefined;
				} catch (error) {
					sourceError = new Error('Localization sources are invalid. Read the compiler error in the terminal.', { cause: error });
					server.moduleGraph.invalidateAll();
					server.ws.send({ type: 'error', err: { message: sourceError.message, stack: sourceError.stack ?? '', plugin: 'bickr-localization-sources' } });
				}
			};
			// Vitest intercepts HMR. Listen to source filesystem events so both
			// Vite and Vitest regenerate, including added and removed source files.
			server.watcher.on('change', update).on('add', update).on('unlink', update);
			server.httpServer?.once('close', () => {
				server.watcher.off('change', update).off('add', update).off('unlink', update);
			});
		},
		load(id) {
			if (sourceError && id.includes('/src/.generated/localization/')) throw sourceError;
		},
	};
}
