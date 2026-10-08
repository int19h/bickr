import { execFileSync, spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { repository, sourceDirectories } from './paths.ts';

const { values, positionals: [command, ...args] } = parseArgs({
	options: { cwd: { type: 'string', default: '.' } }, allowPositionals: true,
});
if (!command) throw new Error('Usage: node scripts/localization/watch-command.ts [--cwd directory] -- command [arguments]');
const generate = () => execFileSync(process.execPath, ['scripts/generate-localization.ts'], { cwd: repository, stdio: 'inherit' });
generate();
const isolatedGroup = process.platform !== 'win32';
const watchers = sourceDirectories.map((directory) => {
	const watcher = watch(directory, { recursive: true }, (_event, file) => {
		if (!file || !/\.(yaml|md)$/.test(String(file))) return;
		try { generate(); }
		catch (error) {
			console.error('Localization source compilation failed. The development server will stop.', error);
			process.exitCode = 1;
			stop();
		}
	});
	watcher.on('error', (error) => { console.error(error); process.exitCode = 1; stop(); });
	return watcher;
});
const child = spawn(command === 'node' ? process.execPath : command, args, {
	cwd: resolve(repository, values.cwd), stdio: 'inherit', detached: isolatedGroup,
});
function stop(): void {
	for (const watcher of watchers) watcher.close();
	if (child.pid && child.exitCode === null && child.signalCode === null) {
		try {
			// This group contains only the command that this wrapper spawned.
			if (isolatedGroup) process.kill(-child.pid, 'SIGTERM');
			else child.kill('SIGTERM');
		} catch (error) {
			if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
		}
	}
}
const interrupt = () => { process.exitCode = 130; stop(); };
const terminate = () => { process.exitCode = 143; stop(); };
process.once('SIGINT', interrupt);
process.once('SIGTERM', terminate);
try {
	await new Promise<void>((complete) => {
		child.once('error', (error) => { console.error(error); process.exitCode = 1; complete(); });
		child.once('exit', (code) => { process.exitCode ??= code ?? 1; complete(); });
	});
} finally {
	stop();
	process.off('SIGINT', interrupt);
	process.off('SIGTERM', terminate);
}
