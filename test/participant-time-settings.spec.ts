import { authCookie, createBotForTest, seedWorld, testEnv, testCoordinatorEnv, kvKeys, describe, it, expect } from './helpers/index-harness';
import { createBot, updateBot, userCoordinatorMutation } from './helpers/coordinator-mutations';
import { botById, publicBotSummary } from '@bickr/shared/repository';
import { exportBotDefinition } from '@bickr/shared/account-export-repository';
import { internalServiceAuthHeader } from '@bickr/shared/internal-service';
import { handleAgentRuntimeRequest } from '../workers/agent-runtime/src/routes';
import { repairOwnedObjectIndex } from '@bickr/shared/index-repair';
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
		await updateBot(testEnv.BICKR_KV, testEnv.BICKR_D1, created.id, created.ownerUserId, { timeSettings: { mode: 'absolute', timezone: 'America/Los_Angeles' } });
		await updateBot(testEnv.BICKR_KV, testEnv.BICKR_D1, created.id, created.ownerUserId, { timeSettings: { mode: 'relative' } });
		const bot = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, created.id);
		expect(publicBotSummary(bot).timeSettings).toEqual({ mode: 'relative', timezone: 'America/Los_Angeles' });
		const polluted = { ...bot, timeSettings: { mode: 'relative' as const, timezone: 'America/Los_Angeles', secret: 'PRIVATE' } };
		expect(exportBotDefinition(polluted).timeSettings).toEqual({ mode: 'relative', timezone: 'America/Los_Angeles' });
		expect(publicBotSummary(polluted).timeSettings).toEqual({ mode: 'relative', timezone: 'America/Los_Angeles' });
	});
	it('preserves an unswept datetime preference on reads and owner edits', async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const created = await createBotForTest(cookie, 'time-unswept');
		const raw = (await testEnv.BICKR_KV.get<BotDocument>(kvKeys.bot(created.id), 'json'))!;
		const { timeSettings: _removed, ...legacy } = raw;
		const stored = JSON.stringify({ ...legacy, toolSettings: { ...legacy.toolSettings, openRouter: { datetime: { enabled: true, timezone: 'america/los_angeles' } } } });
		await testEnv.BICKR_KV.put(kvKeys.bot(created.id), stored);
		const read = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, created.id);
		expect(publicBotSummary(read).timeSettings).toEqual({ mode: 'absolute', timezone: 'america/los_angeles' });
		expect(exportBotDefinition(read).timeSettings).toEqual({ mode: 'absolute', timezone: 'america/los_angeles' });
		expect(await testEnv.BICKR_KV.get(kvKeys.bot(created.id))).toBe(stored);
		await updateBot(testEnv.BICKR_KV, testEnv.BICKR_D1, created.id, raw.ownerUserId, { handle: 'time-unswept-renamed' });
		const updated = await testEnv.BICKR_KV.get<BotDocument>(kvKeys.bot(created.id), 'json');
		expect(updated?.timeSettings).toEqual({ mode: 'absolute', timezone: 'America/Los_Angeles' });
		expect(updated?.toolSettings.openRouter ?? {}).not.toHaveProperty('datetime');
	});

	it('keeps time configuration local to a linked clone', async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const source = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, (await createBotForTest(cookie, 'time-source')).id);
		await updateBot(testEnv.BICKR_KV, testEnv.BICKR_D1, source.id, source.ownerUserId, { timeSettings: { mode: 'absolute', timezone: 'America/Los_Angeles' } });
		const clone = await createBot(testEnv.BICKR_KV, testEnv.BICKR_D1, source.homeWorldHandle, {
			handle: 'time-clone', language: source.language, displayName: source.displayName, shortBio: source.shortBio,
			prompt: source.prompt, cloneSourceBotId: source.id,
		}, source.ownerUserId);
		expect(clone.timeSettings).toEqual({ mode: 'relative', timezone: 'UTC' });
		await updateBot(testEnv.BICKR_KV, testEnv.BICKR_D1, clone.id, source.ownerUserId, { timeSettings: { mode: 'absolute', timezone: 'Europe/Paris' } });
		await updateBot(testEnv.BICKR_KV, testEnv.BICKR_D1, source.id, source.ownerUserId, { timeSettings: { mode: 'relative' } });
		expect((await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, clone.id)).timeSettings).toEqual({ mode: 'absolute', timezone: 'Europe/Paris' });
	});
	it.each(['profile', 'avatar-delete', 'delete', 'unlink', 'relink', 'world-handle'])('migrates the document before a %s write', async operation => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const source = await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, (await createBotForTest(cookie, 'time-write-source')).id);
		const created = operation === 'unlink' || operation === 'relink'
			? await createBot(testEnv.BICKR_KV, testEnv.BICKR_D1, source.homeWorldHandle, {
				handle: 'time-write-clone', language: source.language, displayName: source.displayName,
				shortBio: source.shortBio, prompt: source.prompt, cloneSourceBotId: source.id,
			}, source.ownerUserId) : source;
		const raw = (await testEnv.BICKR_KV.get<BotDocument>(kvKeys.bot(created.id), 'json'))!;
		const { timeSettings: _removed, ...legacy } = raw;
		await testEnv.BICKR_KV.put(kvKeys.bot(created.id), JSON.stringify({ ...legacy,
			...(operation === 'world-handle' ? { homeWorldHandle: 'stale-world' } : {}),
			toolSettings: { ...legacy.toolSettings, openRouter: { datetime: { enabled: true, timezone: 'america/los_angeles' } } },
		}));
		const env = { BICKR_KV: testEnv.BICKR_KV, BICKR_D1: testEnv.BICKR_D1 };
		if (operation === 'world-handle') {
			await testEnv.BICKR_D1.prepare('UPDATE objects_index SET index_version = 0 WHERE object_id = ?').bind(created.id).run();
			await repairOwnedObjectIndex(env, { entityType: 'bot', id: created.id });
		} else if (operation === 'profile') {
			await updateBot(testEnv.BICKR_KV, testEnv.BICKR_D1, created.id, raw.ownerUserId, { timeSettings: { mode: 'relative' } });
		} else {
			const suffix = operation === 'avatar-delete' ? '/avatar' : operation === 'delete' ? '' : `/clone/${operation}`;
			await userCoordinatorMutation(env, raw.ownerUserId, `/bots/${created.id}${suffix}`,
				operation === 'delete' || operation === 'avatar-delete' ? 'DELETE' : 'POST',
				operation === 'unlink' || operation === 'relink' ? {} : undefined,
				operation === 'delete' ? { 'idempotency-key': 'time-writer-delete' } : {});
		}
		const updated = await testEnv.BICKR_KV.get<BotDocument>(kvKeys.bot(created.id), 'json');
		expect(updated?.timeSettings).toEqual({ mode: operation === 'profile' ? 'relative' : 'absolute', timezone: 'America/Los_Angeles' });
		expect(updated?.toolSettings.openRouter ?? {}).not.toHaveProperty('datetime');
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
	it('defers a recent legacy document and converts it on a later pass without maintenance', async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const created = await createBotForTest(cookie, 'time-recent');
		const raw = (await testEnv.BICKR_KV.get<BotDocument>(kvKeys.bot(created.id), 'json'))!;
		const { timeSettings: _removed, ...legacy } = raw;
		const document = { ...legacy, toolSettings: { openRouter: { datetime: { enabled: true, timezone: 'Europe/Paris' } } } };
		await testEnv.BICKR_KV.put(kvKeys.bot(created.id), JSON.stringify(document));
		const env = testCoordinatorEnv();
		const first = await handleAgentRuntimeRequest(request('/maintenance/participant-time', {}), env);
		expect(await first.json()).toMatchObject({ data: { sweep: { rewritten: 0, skippedRecentlyUpdated: 1, done: false } } });
		expect(publicBotSummary(await botById(testEnv.BICKR_KV, testEnv.BICKR_D1, created.id)).timeSettings).toEqual({ mode: 'absolute', timezone: 'Europe/Paris' });
		expect(await testEnv.BICKR_KV.get(kvKeys.bot(created.id))).toBe(JSON.stringify(document));
		await testEnv.BICKR_KV.put(kvKeys.bot(created.id), JSON.stringify({ ...document, updatedAt: '2020-01-01T00:00:00Z' }));
		const later = await handleAgentRuntimeRequest(request('/maintenance/participant-time', {}), env);
		expect(await later.json()).toMatchObject({ data: { sweep: { rewritten: 1, done: true } } });
		const migrated = await testEnv.BICKR_KV.get<BotDocument>(kvKeys.bot(created.id), 'json');
		expect(migrated?.timeSettings).toEqual({ mode: 'absolute', timezone: 'Europe/Paris' });
		expect(migrated?.toolSettings.openRouter ?? {}).not.toHaveProperty('datetime');
	});

	it('migrates stored datetime preferences through the bounded sweep and owner queue', async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const preferences = [
			{ datetime: { enabled: true, timezone: 'America/Los_Angeles' }, expected: { mode: 'absolute', timezone: 'America/Los_Angeles' } },
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
		expect(await testEnv.BICKR_D1.prepare("SELECT enabled FROM maintenance_control WHERE id = 1").first()).toMatchObject({ enabled: 0 });
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
