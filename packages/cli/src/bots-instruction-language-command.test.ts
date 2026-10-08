import { afterEach, describe, expect, it } from 'vitest';
import { runCli, startStubApi, type StubApi } from './test-harness.ts';
let stub: StubApi | undefined;
afterEach(async () => { await stub?.close(); stub = undefined; });
const bot = { id: 'bot_one', homeWorldHandle: 'example', handle: 'one', language: 'ja', displayName: { lang: 'ja', text: 'One' }, shortBio: { lang: 'ja', text: 'Bio' }, inferenceSettings: {}, instructionLanguage: { kind: 'auto' }, instructionLocale: 'ja' };
async function api() {
	stub = await startStubApi(request => {
		if (request.pathname === '/api/cli/refs') return { body: { ok: true, data: { ref: { id: 'wld_example', path: '/w/example', type: 'world' } } } };
		if (request.pathname === '/api/me/bots' && request.method === 'GET') return { body: { ok: true, data: { bots: [bot] } } };
		if (request.method === 'POST' || request.method === 'PATCH') return { body: { ok: true, data: { bot: { ...bot, ...request.body } } } };
		return undefined;
	});
	return stub;
}
describe('bot instructions language CLI', () => {
	it('creates with a fixed instructions language independently of the primary language', async () => {
		const server = await api();
		const result = await runCli(server.port, ['--json', 'bots', 'create', 'w/example', '--handle', 'one', '--language', 'ja', '--display-name', 'One', '--short-bio', 'Bio', '--prompt', 'Prompt', '--instructions-language', 'en']);
		expect(result.code, result.stderr).toBe(0);
		expect(server.requests.at(-1)).toMatchObject({ method: 'POST', body: { language: 'ja', instructionLanguage: { kind: 'fixed', locale: 'en' } } });
	}, 30_000);
	it('updates fixed, Auto, and Source preferences without changing the primary language', async () => {
		const server = await api();
		for (const [choice, preference] of [['ga', { kind: 'fixed', locale: 'ga' }], ['auto', { kind: 'auto' }], ['source', { kind: 'source' }]]) {
			const result = await runCli(server.port, ['bots', 'update', 'bot_one', '--instructions-language', choice as string]);
			expect(result.code, result.stderr).toBe(0);
			expect(server.requests.at(-1)?.body).toEqual({ instructionLanguage: preference });
		}
	}, 30_000);
	it('omits the preference when absent and retains the JSON body path', async () => {
		const server = await api();
		expect((await runCli(server.port, ['bots', 'update', 'bot_one', '--handle', 'new'])).code).toBe(0);
		expect(server.requests.at(-1)?.body).toEqual({ handle: 'new' });
		expect((await runCli(server.port, ['bots', 'update', 'bot_one', '--body', '{"instructionLanguage":{"kind":"source"}}'])).code).toBe(0);
		expect(server.requests.at(-1)?.body).toEqual({ instructionLanguage: { kind: 'source' } });
	}, 30_000);
	it('rejects bad choices, Source creation, and ambiguous body modes before any HTTP request', async () => {
		const server = await api();
		const commands = [
			['bots', 'update', 'bot_one', '--instructions-language', 'en-US'],
			['bots', 'update', 'bot_one', '--instructions-language'],
			['bots', 'create', 'w/example', '--instructions-language', 'source'],
			['bots', 'update', 'bot_one', '--body', '{}', '--instructions-language', 'en'],
			['bots', 'update', 'bot_one', '--body', '{}', '--handle', 'one'],
			['bots', 'create', 'w/example', '--body-file', 'missing.json', '--language', 'ja'],
			['bots', 'update', 'bot_one', '--body', '{}', '--body-file', 'missing.json'],
		];
		for (const command of commands) expect((await runCli(server.port, command)).code, command.join(' ')).toBe(1);
		expect(server.requests).toEqual([]);
	}, 30_000);
	it('shows the preference and resolved locale in human get/list and preserves JSON fields', async () => {
		const server = await api();
		for (const command of [['bots', 'get', 'bot_one'], ['bots', 'list']]) {
			const result = await runCli(server.port, ['--format', 'human', ...command]);
			expect(result.code, result.stderr).toBe(0);
			expect(result.stdout).toContain('Auto → ja');
			expect(result.stdout).toContain('Instructions');
		}
		const json = await runCli(server.port, ['--json', 'bots', 'get', 'bot_one']);
		expect(JSON.parse(json.stdout)).toMatchObject({ bot: { instructionLanguage: { kind: 'auto' }, instructionLocale: 'ja', language: 'ja' } });
	}, 30_000);
});
