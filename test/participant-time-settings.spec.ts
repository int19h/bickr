import { authCookie, createBotForTest, seedWorld, testEnv, testCoordinatorEnv, kvKeys, describe, it, expect } from './helpers/index-harness';
import { createBot, updateBot } from './helpers/coordinator-mutations';
import { botById, publicBotSummary } from '@bickr/shared/repository';
import { exportBotDefinition } from '@bickr/shared/account-export-repository';
import { internalServiceAuthHeader } from '@bickr/shared/internal-service';
import { handleAgentRuntimeRequest } from '../workers/agent-runtime/src/routes';
import type { BotDocument } from '@bickr/shared/model';

function request(path: string, body: unknown) {
	return new Request(`https://internal.bickr${path}`, {
		method: 'POST', headers: { 'content-type': 'application/json', 'x-bickr-scheduler': '1', [internalServiceAuthHeader]: 'test-internal-service-secret' }, body: JSON.stringify(body),
	});
}

describe('participant time settings', () => {
	it('stores partial updates, defaults new accounts, and exports only selected time fields', async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const created = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, (await createBotForTest(cookie, 'time-settings')).id);
		expect(created.timeSettings).toEqual({ mode: 'relative', timezone: 'UTC' });
		await updateBot(testEnv.BICKR_KV, testEnv.BICKR_D1, created.id, created.ownerUserId, { timeSettings: { mode: 'absolute', timezone: 'Asia/Kolkata' } });
		await updateBot(testEnv.BICKR_KV, testEnv.BICKR_D1, created.id, created.ownerUserId, { timeSettings: { mode: 'relative' } });
		const bot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, created.id);
		expect(publicBotSummary(bot).timeSettings).toEqual({ mode: 'relative', timezone: 'Asia/Kolkata' });
		const polluted = { ...bot, timeSettings: { mode: 'relative' as const, timezone: 'Asia/Kolkata', secret: 'PRIVATE' } };
		expect(exportBotDefinition(polluted).timeSettings).toEqual({ mode: 'relative', timezone: 'Asia/Kolkata' });
		expect(publicBotSummary(polluted).timeSettings).toEqual({ mode: 'relative', timezone: 'Asia/Kolkata' });
	});
	it('keeps time configuration local to a linked clone', async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const source = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, (await createBotForTest(cookie, 'time-source')).id);
		await updateBot(testEnv.BICKR_KV, testEnv.BICKR_D1, source.id, source.ownerUserId, { timeSettings: { mode: 'absolute', timezone: 'Asia/Kolkata' } });
		const clone = await createBot(testEnv.BICKR_KV, testEnv.BICKR_D1, source.homeWorldHandle, {
			handle: 'time-clone', language: source.language, displayName: source.displayName, shortBio: source.shortBio,
			prompt: source.prompt, cloneSourceBotId: source.id,
		}, source.ownerUserId);
		expect(clone.timeSettings).toEqual({ mode: 'relative', timezone: 'UTC' });
		await updateBot(testEnv.BICKR_KV, testEnv.BICKR_D1, clone.id, source.ownerUserId, { timeSettings: { mode: 'absolute', timezone: 'Europe/Paris' } });
		await updateBot(testEnv.BICKR_KV, testEnv.BICKR_D1, source.id, source.ownerUserId, { timeSettings: { mode: 'relative' } });
		expect((await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, clone.id)).timeSettings).toEqual({ mode: 'absolute', timezone: 'Europe/Paris' });
	});
	it('returns 400 for invalid zones and removed datetime input', async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, (await createBotForTest(cookie, 'time-rejection')).id);
		const env = testCoordinatorEnv();
		for (const input of [{ timeSettings: { mode: 'relative', timezone: 'Mars/Olympus' } }, { toolSettings: { openRouter: { datetime: { enabled: true } } } }]) {
			const response = await env.AGENT_RUNTIME.fetch(new Request(`https://internal.bickr/users/${bot.ownerUserId}/bots/${bot.id}`, {
				method: 'PATCH', headers: { 'content-type': 'application/json', 'x-bickr-user-id': bot.ownerUserId, [internalServiceAuthHeader]: 'test-internal-service-secret' }, body: JSON.stringify(input),
			}));
			expect(response.status).toBe(400);
			if ('toolSettings' in input) expect(await response.text()).toContain('timeSettings');
		}
	});
	it('migrates stored datetime preferences through the bounded sweep and owner queue', async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const preferences = [
			{ datetime: { enabled: true, timezone: 'Asia/Kolkata' }, expected: { mode: 'absolute', timezone: 'Asia/Kolkata' } },
			{ datetime: { enabled: true }, expected: { mode: 'absolute', timezone: 'UTC' } },
			{ datetime: { enabled: false, timezone: 'Europe/Paris' }, expected: { mode: 'relative', timezone: 'UTC' } },
		];
		const bots = [];
		for (const [index, preference] of preferences.entries()) {
			const bot = await createBotForTest(cookie, `time-migration-${index}`);
			const raw = await testEnv.BICKR_KV.get<BotDocument>(kvKeys.bot(bot.id), 'json');
			const { timeSettings: _removed, ...legacy } = raw!;
			await testEnv.BICKR_KV.put(kvKeys.bot(bot.id), JSON.stringify({ ...legacy, updatedAt: '2020-01-01T00:00:00Z', toolSettings: { openRouter: { datetime: preference.datetime } } }));
			bots.push(bot);
		}
		await testEnv.BICKR_D1.prepare("UPDATE maintenance_control SET enabled = 1, activated_at = '2026-01-01T00:00:00Z' WHERE id = 1").run();
		const env = testCoordinatorEnv();
		await testEnv.BICKR_KV.put(kvKeys.kvNormalizationSweepCursor('bot'), JSON.stringify({ afterObjectId: 'zzzz' }));
		const first = await handleAgentRuntimeRequest(request('/maintenance/participant-time', {}), env);
		expect(first.status, await first.clone().text()).toBe(200);
		expect(await first.json()).toMatchObject({ data: { sweep: { rewritten: 3, done: true } } });
		for (const [index, bot] of bots.entries()) {
			const stored = await testEnv.BICKR_KV.get<BotDocument>(kvKeys.bot(bot.id), 'json');
			expect(stored?.timeSettings).toEqual(preferences[index]!.expected);
			expect(stored?.toolSettings.openRouter ?? {}).not.toHaveProperty('datetime');
		}
		const repeat = await handleAgentRuntimeRequest(request('/maintenance/participant-time', {}), env);
		expect(await repeat.json()).toMatchObject({ data: { sweep: { rewritten: 0, done: true } } });
	});
});
