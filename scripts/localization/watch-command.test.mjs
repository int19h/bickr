import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { repository } from './paths.ts';

it('restarts with edited catalog text and stops before serving invalid sources', async () => {
	const temporaryRoot = join(repository, '.wrangler/localization-watch-tests');
	mkdirSync(temporaryRoot, { recursive: true });
	const root = mkdtempSync(join(temporaryRoot, 'fixture-'));
	for (const path of ['packages/shared/src', 'workers/agent-runtime/src/localization', 'scripts/localization', 'scripts/generate-localization.ts', 'package.json']) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		cpSync(join(repository, path), join(root, path), { recursive: true });
	}
	symlinkSync(join(repository, 'node_modules'), join(root, 'node_modules'), 'dir');
	writeFileSync(join(root, 'server.mjs'), `
import { factoryText } from './packages/shared/src/localization/index.ts';
console.log('READY:' + process.pid + ':' + factoryText('en').format('factory.translationPrompt'));
process.on('SIGTERM', () => { console.log('STOP'); process.exit(0); });
setInterval(() => {}, 1000);
`);
	const wrapper = spawn(process.execPath, ['scripts/localization/watch-command.ts', '--', 'node', 'server.mjs'], {
		cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
	});
	let output = '';
	wrapper.stdout.on('data', (chunk) => { output += chunk; });
	wrapper.stderr.on('data', (chunk) => { output += chunk; });
	const exited = new Promise((resolve) => wrapper.once('exit', (code) => resolve(code)));
	const ready = (text) => output.split('\n').some((line) => /^READY:\d+:/.test(line) && line.endsWith(':' + text));
	try {
		await expect.poll(() => ready('Translate to English.'), { timeout: 15000 }).toBe(true);
		const source = join(root, 'packages/shared/src/localization/en/factory.yaml');
		const original = readFileSync(source, 'utf8');
		writeFileSync(source, original.replace('Translate to English.', 'Translate to English. Watch restart test.'));
		await expect.poll(() => ready('Translate to English. Watch restart test.'), { timeout: 15000 }).toBe(true);
		expect(output).toMatch(/STOP\n[\s\S]*READY:\d+:Translate to English\. Watch restart test\./);
		writeFileSync(source, original.replace('{{username}}', '{{invalidUsername}}'));
		expect(await Promise.race([exited, delay(15000, 'timeout', { ref: false })])).toBe(1);
		expect(output).toContain('Unknown instruction template parameter');
		expect(output.match(/^STOP$/gm)).toHaveLength(2);
	} finally {
		if (wrapper.exitCode === null) wrapper.kill('SIGTERM');
		await Promise.race([exited, delay(5000, undefined, { ref: false })]);
		// Only these process groups were spawned by this fixture.
		if (process.platform !== 'win32' && wrapper.exitCode === null) {
			const latestServer = [...output.matchAll(/^READY:(\d+):/gm)].at(-1);
			const pids = latestServer ? [Number(latestServer[1])] : [];
			if (wrapper.pid) pids.push(wrapper.pid);
			for (const pid of pids) {
				try { process.kill(-pid, 'SIGKILL'); }
				catch (error) { if (error.code !== 'ESRCH') throw error; }
			}
		}
		rmSync(root, { recursive: true, force: true });
	}
}, 45000);
