import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { watch, type FSWatcher } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { repository, sourceDirectories } from './paths.ts';

const { values, positionals: [command, ...args] } = parseArgs({
	options: { cwd: { type: 'string', default: '.' } }, allowPositionals: true,
});
if (!command) throw new Error('Usage: node scripts/localization/watch-command.ts [--cwd directory] -- command [arguments]');
const generate = () => execFileSync(process.execPath, ['scripts/generate-localization.ts'], { cwd: repository, stdio: 'inherit' });
const isolatedGroup = process.platform !== 'win32';
type Running = { child: ChildProcess; finished: Promise<number> };
let changed = false;
let stopped = false;
let notify: () => void = () => {};
const watchers: FSWatcher[] = [];

function requestStop(code: number): void {
	process.exitCode = code;
	stopped = true;
	notify();
}
function start(): Running {
	const child = spawn(command === 'node' ? process.execPath : command!, args, {
		cwd: resolve(repository, values.cwd), stdio: 'inherit', detached: isolatedGroup,
	});
	const finished = new Promise<number>((complete) => {
		child.once('error', (error) => { console.error(error); complete(1); });
		child.once('exit', (code) => complete(code ?? 1));
	});
	return { child, finished };
}
function signal(child: ChildProcess, value: NodeJS.Signals): void {
	if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
	try {
		// This group contains only the command that this wrapper spawned.
		if (isolatedGroup) process.kill(-child.pid, value);
		else child.kill(value);
	} catch (error) {
		if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
	}
}
async function stop(run: Running): Promise<void> {
	signal(run.child, 'SIGTERM');
	const timer = setTimeout(() => signal(run.child, 'SIGKILL'), 5000);
	try { await run.finished; }
	finally { clearTimeout(timer); }
}
function sourceChange(): Promise<void> {
	if (changed || stopped) return Promise.resolve();
	return new Promise((complete) => { notify = complete; });
}
const interrupt = () => requestStop(130);
const terminate = () => requestStop(143);
process.once('SIGINT', interrupt);
process.once('SIGTERM', terminate);
let current: Running | undefined;
try {
	for (const directory of sourceDirectories) {
		const watcher = watch(directory, { recursive: true }, (_event, file) => {
			if (file && !/\.(yaml|md)$/.test(String(file))) return;
			changed = true;
			notify();
		});
		watcher.on('error', (error) => { console.error(error); requestStop(1); });
		watchers.push(watcher);
	}
	while (!stopped) {
		changed = false;
		generate();
		if (stopped) break;
		current = start();
		const result = await Promise.race([
			current.finished.then((code) => ({ kind: 'exit' as const, code })),
			sourceChange().then(() => ({ kind: 'change' as const })),
		]);
		if (result.kind === 'exit') { process.exitCode ??= result.code; break; }
		await stop(current);
		current = undefined;
		if (!stopped) console.log('Localization source changed. Restarting the development server.');
	}
} catch (error) {
	console.error('Localization source compilation failed. The development server will stop.', error);
	process.exitCode = 1;
} finally {
	for (const watcher of watchers) watcher.close();
	if (current) await stop(current);
	process.off('SIGINT', interrupt);
	process.off('SIGTERM', terminate);
}
