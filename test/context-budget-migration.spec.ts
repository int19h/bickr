import { resumeDueUserLifecycleOperation } from '../workers/agent-runtime/src/lifecycle/recovery';
import { parseBotCreateLifecycleRequest } from '../workers/agent-runtime/src/lifecycle/bot-create-request';
import { authCookie, createBotForTest, describe, expect, it, kvKeys, seedWorld, testEnv, testCoordinatorEnv, fakeR2Bucket, webpAvatarBytes, vi } from './helpers/index-harness';
import { contextWindowTokensMin, type BotDocument } from '@bickr/shared/model';
import { defaultTickSettings, LifecycleKvReadError, userCoordinatorRepositoryMutations } from '@bickr/shared/repository';
import { beginLifecycleCompensation, lifecycleOperationById, markLifecycleMaterializing, lifecycleRetryLimit, InjectedLifecycleFailure } from '@bickr/shared/entity-lifecycle';
import { parseCreateBotInput } from '@bickr/shared/validation';
import { reserveBotCreate, runBotCreateOperation } from '../workers/agent-runtime/src/lifecycle/bot';
import { handleAgentRuntimeRequest, handleAgentRuntimeWorkerRequest } from '../workers/agent-runtime/src/routes';
import { ExclusiveOperationQueue } from '@bickr/shared/exclusive-operation-queue';
import { contextBudgetMigrationBatchSize, migrateOwnedContextBudget, type ContextBudgetMigrationCursor, type migrateContextBudgetPage } from '../workers/agent-runtime/src/context-budget-migration';
import { internalServiceTestHeaders } from './helpers/internal-service-auth';

// Intercept only JSON reads. All other KV operations keep their real behavior.
function interceptJsonReads(read: (key: string, current: unknown) => unknown): KVNamespace {
	return new Proxy(testEnv.BICKR_KV, {
		get(target, property) {
			if (property === 'get') return async (key: string, options?: { type: string }) => {
				const value = await Reflect.apply(target.get, target, [key, options]);
				return options?.type === 'json' ? read(key, value) : value;
			};
			const value = Reflect.get(target, property);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
}

function sweep(cursor: ContextBudgetMigrationCursor | '' = '', headers: Record<string, string> = internalServiceTestHeaders) {
	return handleAgentRuntimeWorkerRequest(new Request('https://internal.bickr/maintenance/context-budget', {
		method: 'POST', headers: { ...headers, 'x-bickr-scheduler': '1', 'content-type': 'application/json' }, body: JSON.stringify({ cursor }),
	}), { ...testEnv, ...testCoordinatorEnv() });
}
async function stored(id: string) { return (await testEnv.BICKR_KV.get<BotDocument>(kvKeys.bot(id), { type: 'json' }))!; }
async function migrationPage(response: Response): Promise<Awaited<ReturnType<typeof migrateContextBudgetPage>>> {
	const payload = await response.json() as { data: { page: Awaited<ReturnType<typeof migrateContextBudgetPage>> } };
	return payload.data.page;
}
async function contextIndex(id: string) {
	return testEnv.BICKR_D1.prepare('SELECT context_window_tokens AS budget, next_due_at AS dueAt, status, active_run_id AS runId FROM bot_runtime_index WHERE bot_id = ?').bind(id).first();
}
async function legacyBot() {
	const cookie = await authCookie();
	await seedWorld(cookie);
	const bot = await createBotForTest(cookie, 'legacy-budget', { enabled: false });
	const document = await stored(bot.id);
	await testEnv.BICKR_KV.put(kvKeys.bot(bot.id), JSON.stringify({ ...document, tickSettings: { ...document.tickSettings, contextWindowTokens: contextWindowTokensMin - 1 } }));
	await testEnv.BICKR_D1.prepare('UPDATE bot_runtime_index SET context_window_tokens = ? WHERE bot_id = ?').bind(contextWindowTokensMin - 1, bot.id).run();
	return { ...bot, ownerUserId: document.ownerUserId };
}
function ownerRequest(bot: { ownerUserId: string; id: string }) {
	return new Request(`https://internal.bickr/users/${bot.ownerUserId}/bots/${bot.id}/context-budget-migration`, {
		method: 'POST', headers: { ...internalServiceTestHeaders, 'x-bickr-scheduler': '1', 'x-bickr-user-id': bot.ownerUserId },
	});
}
async function fullPass() {
	let cursor: ContextBudgetMigrationCursor | '' | null = '';
	const changes = { documents: 0, indexes: 0, creationRequests: 0 };
	const pages = [];
	while (cursor !== null) {
		const response = await sweep(cursor);
		expect(response.status, await response.clone().text()).toBe(200);
		const page = await migrationPage(response);
		pages.push(page);
		changes.documents += page.changes.documents;
		changes.indexes += page.changes.indexes;
		changes.creationRequests += page.changes.creationRequests;
		cursor = page.nextCursor;
		if (page.results.some(row => row.result.kind === 'missing')) throw new Error('Missing migration document.');
		if (pages.length > 100) throw new Error('Migration pass did not finish.');
	}
	return { changes, pages };
}

describe('context-budget-minimum-v1 migration', () => {
	it.each(['reserved', 'kv', 'indexed'] as const)('preserves a pending creation interrupted at %s and migrates its saved request', async stage => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const source = await createBotForTest(cookie, 'source', { enabled: false });
		const owner = (await stored(source.id)).ownerUserId;
		const env = { ...testEnv, ...testCoordinatorEnv() };
		const queue = new ExclusiveOperationQueue();
		const context = { env, coordinator: { objectId: owner, ownerUserId: owner, queue }, request: new Request('https://internal.bickr/create', { headers: { 'idempotency-key': `budget-${stage}` } }) };
		const validInput = parseCreateBotInput({ handle: `pending-${stage}`, language: 'en', displayName: 'Pending participant', shortBio: 'A participant.', prompt: 'Keep useful memories.', tickSettings: { contextWindowTokens: contextWindowTokensMin } });
		const input = { ...validInput, tickSettings: { ...validInput.tickSettings, contextWindowTokens: contextWindowTokensMin - 1 } };
		// Reserve the executable request that the previous writer accepted.
		const operation = await queue.run(() => reserveBotCreate(context, owner, source.homeWorldHandle, input));
		const request = parseBotCreateLifecycleRequest(operation.requestJson!);
		if (stage !== 'reserved') {
			// Stop the real materializer at its write boundary, then seed its old budget.
			await expect(queue.run(() => userCoordinatorRepositoryMutations.createBot(testEnv.BICKR_KV, testEnv.BICKR_D1, source.homeWorldHandle, validInput, owner, {
				now: request.createdAt, botId: request.botId, personalForumId: request.personalForumId, lifecycleState: 'pending',
				checkpoint: async point => { if (point === (stage === 'kv' ? 'bot.materialize.kv' : 'bot.materialize.indexes.d1')) throw new Error('Hard interruption.'); },
			}))).rejects.toThrow('Hard interruption.');
			const document = await stored(request.botId);
			await testEnv.BICKR_KV.put(kvKeys.bot(request.botId), JSON.stringify({ ...document, tickSettings: input.tickSettings }));
		}
		const beforeIndex = await contextIndex(request.botId);
		if (stage !== 'indexed') {
			expect(beforeIndex).toBeNull();
			expect(await testEnv.BICKR_D1.prepare('SELECT bot_id FROM bots_index WHERE bot_id = ?').bind(request.botId).first()).toBeNull();
		}
		const first = await fullPass();
		expect(first.changes.creationRequests).toBe(1);
		expect(first.changes.documents).toBe(stage === 'reserved' ? 0 : 1);
		const migrated = (await lifecycleOperationById(testEnv.BICKR_D1, operation.operationId))!;
		expect(migrated.requestHash).toBe(operation.requestHash);
		expect(migrated.phase).toBe('pending');
		expect(parseBotCreateLifecycleRequest(migrated.requestJson!).input.tickSettings?.contextWindowTokens).toBe(contextWindowTokensMin);
		expect((await fullPass()).changes).toEqual({ documents: 0, indexes: 0, creationRequests: 0 });
		await queue.run(() => runBotCreateOperation(context, operation));
		expect((await lifecycleOperationById(testEnv.BICKR_D1, operation.operationId))?.phase).toBe('terminal');
		expect((await stored(request.botId)).tickSettings.contextWindowTokens).toBe(contextWindowTokensMin);
		expect((await stored(request.botId)).deletedAt).toBeUndefined();
	});
	it.each([
		{ clone: false, stage: 'reserved' }, { clone: true, stage: 'reserved' },
		{ clone: false, stage: 'kv' }, { clone: true, stage: 'kv' },
		{ clone: false, stage: 'indexed' }, { clone: true, stage: 'indexed' },
	])('migrates a saved creation before recovery: clone=$clone stage=$stage', async ({ clone, stage }) => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const source = await createBotForTest(cookie, 'recovery-source', { enabled: false });
		const owner = (await stored(source.id)).ownerUserId;
		const env = { ...testEnv, ...testCoordinatorEnv() };
		const queue = new ExclusiveOperationQueue();
		const context = { env, coordinator: { objectId: owner, ownerUserId: owner, queue }, request: new Request('https://internal.bickr/create', { headers: { 'idempotency-key': 'recovery-budget' } }) };
		const validInput = parseCreateBotInput({ handle: 'recovered-budget', language: 'en', displayName: 'Recovered participant', shortBio: 'A participant.', prompt: 'Keep useful memories.',
			tickSettings: { contextWindowTokens: contextWindowTokensMin }, ...(clone ? { cloneSourceBotId: source.id } : {}) });
		// Model the former minimum without copying the current policy value.
		const input = { ...validInput, tickSettings: { ...validInput.tickSettings, contextWindowTokens: contextWindowTokensMin - 5_000 } };
		const operation = await queue.run(() => reserveBotCreate(context, owner, source.homeWorldHandle, input));
		const request = parseBotCreateLifecycleRequest(operation.requestJson!);
		expect(request.kind).toBe(clone ? 'clone_create' : 'bot_create');
		if (stage !== 'reserved') {
			await queue.run(() => markLifecycleMaterializing(env.BICKR_D1, operation, new Date().toISOString()));
			await expect(queue.run(() => userCoordinatorRepositoryMutations.createBot(env.BICKR_KV, env.BICKR_D1, source.homeWorldHandle, validInput, owner, {
				now: request.createdAt, botId: request.botId, personalForumId: request.personalForumId, lifecycleState: 'pending',
				checkpoint: async point => { if (point === `${clone ? 'clone' : 'bot'}.materialize.${stage === 'kv' ? 'kv' : 'indexes.d1'}`) throw new Error('Hard interruption.'); },
			}))).rejects.toThrow('Hard interruption.');
			const document = await stored(request.botId);
			await env.BICKR_KV.put(kvKeys.bot(request.botId), JSON.stringify({ ...document, tickSettings: input.tickSettings }));
		}
		const oldSnapshot = stage === 'reserved' ? null : await stored(request.botId);
		if (stage === 'kv') {
			const interruptedDb: D1Database = {
				prepare: env.BICKR_D1.prepare.bind(env.BICKR_D1),
				exec: env.BICKR_D1.exec.bind(env.BICKR_D1),
				withSession: env.BICKR_D1.withSession.bind(env.BICKR_D1),
				dump: env.BICKR_D1.dump.bind(env.BICKR_D1),
				batch: async () => { throw new Error('Migration interruption.'); },
			};
			await expect(queue.run(() => resumeDueUserLifecycleOperation({ ...context, env: { ...env, BICKR_D1: interruptedDb } }, new Date(Date.now() + 60_000).toISOString()))).rejects.toThrow('Migration interruption.');
			const interrupted = (await lifecycleOperationById(env.BICKR_D1, operation.operationId))!;
			expect(interrupted.phase).toBe('materializing');
			expect(interrupted.requestHash).toBe(operation.requestHash);
			expect(parseBotCreateLifecycleRequest(interrupted.requestJson!).input.tickSettings?.contextWindowTokens).toBe(contextWindowTokensMin);
			expect((await stored(request.botId)).tickSettings.contextWindowTokens).toBe(contextWindowTokensMin);
		}
		if (stage === 'indexed') {
			// Stop after the complete safeguard, before materialization. The next
			// recovery sees an older KV revision than the completed D1 projection.
			await queue.run(() => migrateOwnedContextBudget(env.BICKR_KV, env.BICKR_D1, request.botId, owner));
			const staleKv = interceptJsonReads((key, value) => key === kvKeys.bot(request.botId) ? oldSnapshot : value);
			await expect(queue.run(() => runBotCreateOperation({ ...context, env: { ...env, BICKR_KV: staleKv } }, operation))).rejects.toBeInstanceOf(LifecycleKvReadError);
			expect((await lifecycleOperationById(env.BICKR_D1, operation.operationId))?.phase).toBe('materializing');
			expect(await stored(request.botId)).not.toBeNull();
		}
		let participantReads = 0;
		const staleKv = interceptJsonReads((key, value) => {
			if (key === kvKeys.bot(request.botId)) {
				participantReads++;
				if (stage === 'kv' || participantReads > 1) return oldSnapshot;
			}
			return value;
		});
		// The real recovery dispatcher reaches this operation before any sweep.
		const recovered = await queue.run(() => resumeDueUserLifecycleOperation({ ...context, env: { ...env, BICKR_KV: staleKv } }, new Date(Date.now() + 60_000).toISOString()));
		expect(participantReads).toBe(1);
		expect(recovered.operationId).toBe(operation.operationId);
		const completed = (await lifecycleOperationById(env.BICKR_D1, operation.operationId))!;
		expect(completed.phase).toBe('terminal');
		expect(completed.requestHash).toBe(operation.requestHash);
		expect((await stored(request.botId)).tickSettings.contextWindowTokens).toBe(contextWindowTokensMin);
		expect((await stored(request.botId)).deletedAt).toBeUndefined();
		// Replaying the stale operation object also loads the completed state.
		await queue.run(() => runBotCreateOperation(context, operation));
		expect((await fullPass()).changes).toEqual({ documents: 0, indexes: 0, creationRequests: 0 });
	});
	it.each(['owner', 'source', 'source-owner', 'nested-source', 'nested-source-owner', 'identity', 'revision'] as const)('keeps creation recoverable after repeated stale %s reads', async target => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const root = await createBotForTest(cookie, 'stale-root', { enabled: false });
		let source: { id: string } = root;
		const owner = (await stored(root.id)).ownerUserId;
		const env = { ...testEnv, ...testCoordinatorEnv() };
		const queue = new ExclusiveOperationQueue();
		const context = { env, coordinator: { objectId: owner, ownerUserId: owner, queue }, request: new Request('https://internal.bickr/create') };
		if (target === 'nested-source' || target === 'nested-source-owner') {
			const sourceInput = parseCreateBotInput({ handle: 'stale-source', language: 'en', cloneSourceBotId: root.id });
			const sourceOperation = await queue.run(() => reserveBotCreate(context, owner, root.homeWorldHandle, sourceInput));
			await queue.run(() => runBotCreateOperation(context, sourceOperation));
			source = { id: sourceOperation.entityId };
		}
		const clone = target === 'source' || target === 'source-owner' || target === 'nested-source' || target === 'nested-source-owner';
		const input = parseCreateBotInput({ handle: 'stale-pending', language: 'en', displayName: 'Pending participant', shortBio: 'A participant.', prompt: 'Keep useful memories.', tickSettings: { contextWindowTokens: contextWindowTokensMin }, ...(clone ? { cloneSourceBotId: source.id } : {}) });
		const operation = await queue.run(() => reserveBotCreate(context, owner, root.homeWorldHandle, input));
		const request = parseBotCreateLifecycleRequest(operation.requestJson!);
		if (target === 'identity' || target === 'revision') {
			await expect(queue.run(() => userCoordinatorRepositoryMutations.createBot(env.BICKR_KV, env.BICKR_D1, root.homeWorldHandle, input, owner, {
				now: request.createdAt, botId: request.botId, personalForumId: request.personalForumId, lifecycleState: 'pending',
				checkpoint: async point => { if (point === 'bot.materialize.indexes.d1') throw new Error('Hard interruption.'); },
			}))).rejects.toThrow('Hard interruption.');
		}
		const staleKv = interceptJsonReads((key, value) => {
			if (target === 'owner' && key === kvKeys.user(owner)) return null;
			if (target === 'source' && key === kvKeys.bot(source.id)) return null;
			if (((target === 'source-owner' && key === kvKeys.bot(source.id)) || (target === 'nested-source-owner' && key === kvKeys.bot(root.id))) && value && typeof value === 'object') return { ...value, ownerUserId: 'stale-owner' };
			if (target === 'nested-source' && key === kvKeys.bot(root.id)) return null;
			if (key === kvKeys.bot(request.botId) && value && typeof value === 'object') {
				if (target === 'identity') return { ...value, handle: 'stale-handle' };
				if (target === 'revision') return { ...value, revision: 0 };
			}
			return value;
		});
		for (let attempt = 0; attempt <= lifecycleRetryLimit; attempt++) {
			await expect(queue.run(() => runBotCreateOperation({ ...context, env: { ...env, BICKR_KV: staleKv } }, operation))).rejects.toBeInstanceOf(LifecycleKvReadError);
			const waiting = (await lifecycleOperationById(env.BICKR_D1, operation.operationId))!;
			expect(['pending', 'materializing']).toContain(waiting.phase);
			expect(waiting.requestHash).toBe(operation.requestHash);
			expect(waiting.requestJson).not.toBeNull();
			expect(waiting.retryCount).toBe(0);
		}
		const ordinaryFailure = new InjectedLifecycleFailure(clone ? 'clone.materialize.kv' : 'bot.materialize.kv', { category: 'external_retryable', code: 'ordinary_failure', retryable: true });
		await expect(queue.run(() => runBotCreateOperation({ ...context, coordinator: { ...context.coordinator, failureInjector: { checkpoint(point) { if (point === ordinaryFailure.point) throw ordinaryFailure; } } } }, operation))).rejects.toBe(ordinaryFailure);
		expect((await lifecycleOperationById(env.BICKR_D1, operation.operationId))?.phase).toBe('materializing');
		expect((await lifecycleOperationById(env.BICKR_D1, operation.operationId))?.retryCount).toBe(1);
		await queue.run(() => runBotCreateOperation(context, operation));
		expect((await lifecycleOperationById(env.BICKR_D1, operation.operationId))?.phase).toBe('terminal');
		expect((await stored(request.botId)).tickSettings.contextWindowTokens).toBe(contextWindowTokensMin);
		expect((await stored(request.botId)).deletedAt).toBeUndefined();
	});
	it('carries the participant snapshot through avatar import without reading its writes back', async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const root = await createBotForTest(cookie, 'avatar-root', { enabled: false });
		const owner = (await stored(root.id)).ownerUserId;
		const r2 = fakeR2Bucket();
		const env = { ...testEnv, ...testCoordinatorEnv(), BICKR_R2: r2.bucket, BICKR_R2_PUBLIC_BASE_URL: 'https://assets.test' };
		const queue = new ExclusiveOperationQueue();
		const context = { env, coordinator: { objectId: owner, ownerUserId: owner, queue }, request: new Request('https://internal.bickr/create') };
		const input = parseCreateBotInput({ handle: 'avatar-pending', language: 'en', displayName: 'Pending participant', shortBio: 'A participant.', prompt: 'Keep useful memories.', tickSettings: { contextWindowTokens: contextWindowTokensMin },
			importSource: { provider: 'chirper', originalHandle: 'source', originalProfileUrl: 'https://chirper.ai/source', apiUrl: 'https://api.chirper.ai/source', importedAt: new Date().toISOString(), sourceAvatarUrl: 'https://images.test/source.webp' } });
		const operation = await queue.run(() => reserveBotCreate(context, owner, root.homeWorldHandle, input));
		let reads = 0;
		const staleKv = interceptJsonReads((key, value) => {
			if (key === kvKeys.bot(operation.entityId) && ++reads > 1) return null;
			return value;
		});
		const originalFetch = globalThis.fetch;
		vi.stubGlobal('fetch', async () => new Response(webpAvatarBytes(), { headers: { 'content-type': 'image/webp' } }));
		try {
			await queue.run(() => runBotCreateOperation({ ...context, env: { ...env, BICKR_KV: staleKv } }, operation));
		} finally { vi.stubGlobal('fetch', originalFetch); }
		expect(reads).toBe(1);
		expect((await lifecycleOperationById(env.BICKR_D1, operation.operationId))?.phase).toBe('terminal');
		expect((await stored(operation.entityId)).avatar?.url).toContain('https://assets.test/');
		expect((await stored(operation.entityId)).tickSettings.contextWindowTokens).toBe(contextWindowTokensMin);
	});
	it('passes cleanup interrupted after KV deletion without restoring the participant', async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const source = await createBotForTest(cookie, 'cleanup-source', { enabled: false });
		const owner = (await stored(source.id)).ownerUserId;
		const env = { ...testEnv, ...testCoordinatorEnv() };
		const queue = new ExclusiveOperationQueue();
		const context = { env, coordinator: { objectId: owner, ownerUserId: owner, queue }, request: new Request('https://internal.bickr/create') };
		const input = parseCreateBotInput({ handle: 'cleanup-budget', language: 'en', displayName: 'Pending participant', shortBio: 'A participant.', prompt: 'Keep useful memories.', tickSettings: { contextWindowTokens: contextWindowTokensMin } });
		const operation = await queue.run(() => reserveBotCreate(context, owner, source.homeWorldHandle, { ...input, tickSettings: { ...input.tickSettings, contextWindowTokens: contextWindowTokensMin - 5_000 } }));
		const request = parseBotCreateLifecycleRequest(operation.requestJson!);
		await expect(queue.run(() => userCoordinatorRepositoryMutations.createBot(env.BICKR_KV, env.BICKR_D1, source.homeWorldHandle, input, owner, {
			now: request.createdAt, botId: request.botId, personalForumId: request.personalForumId, lifecycleState: 'pending',
			checkpoint: async point => { if (point === 'bot.materialize.indexes.d1') throw new Error('Hard interruption.'); },
		}))).rejects.toThrow('Hard interruption.');
		const compensating = await beginLifecycleCompensation(env.BICKR_D1, operation, { category: 'external_terminal', code: 'test', retryable: false }, new Date().toISOString());
		const interruptedKv = {
			get: env.BICKR_KV.get.bind(env.BICKR_KV),
			delete: async (key: string) => { await env.BICKR_KV.delete(key); if (key === kvKeys.bot(request.botId)) throw new Error('Cleanup interruption.'); },
		} as KVNamespace;
		await expect(queue.run(() => runBotCreateOperation({ ...context, env: { ...env, BICKR_KV: interruptedKv } }, compensating))).rejects.toThrow('Cleanup interruption.');
		expect(await stored(request.botId)).toBeNull();
		expect((await fullPass()).changes).toEqual({ documents: 0, indexes: 0, creationRequests: 1 });
		expect((await fullPass()).changes).toEqual({ documents: 0, indexes: 0, creationRequests: 0 });
		await queue.run(() => runBotCreateOperation(context, compensating));
		expect((await lifecycleOperationById(env.BICKR_D1, operation.operationId))?.phase).toBe('terminal_failed');
		expect(await stored(request.botId)).toBeNull();
		expect(await contextIndex(request.botId)).toBeNull();
	});
	it('finds a KV participant document with neither index nor lifecycle row', async () => {
		const bot = await legacyBot();
		const document = { ...await stored(bot.id), id: 'bot_unindexed_budget' };
		await testEnv.BICKR_KV.put(kvKeys.bot(document.id), JSON.stringify(document));
		const pass = await fullPass();
		expect(pass.changes.documents).toBe(2);
		expect((await stored(document.id)).tickSettings.contextWindowTokens).toBe(contextWindowTokensMin);
		expect(await contextIndex(document.id)).toBeNull();
		expect((await fullPass()).changes).toEqual({ documents: 0, indexes: 0, creationRequests: 0 });
	});
	it('does not excuse a missing active document because a terminal creation retains a request', async () => {
		const bot = await legacyBot();
		const document = await stored(bot.id);
		const retainedRequest = { kind: 'bot_create', userId: bot.ownerUserId, worldId: bot.homeWorldId, worldHandle: bot.homeWorldHandle,
			botId: bot.id, personalForumId: 'forum', createdAt: document.createdAt, input: { tickSettings: { contextWindowTokens: contextWindowTokensMin } } };
		await testEnv.BICKR_D1.prepare("UPDATE entity_lifecycle_operations SET request_json = ? WHERE entity_kind = 'bot' AND entity_id = ? AND action = 'create' AND phase = 'terminal'")
			.bind(JSON.stringify(retainedRequest), bot.id).run();
		await testEnv.BICKR_KV.delete(kvKeys.bot(bot.id));
		const response = await sweep();
		expect(response.status).toBe(200);
		const page = await migrationPage(response);
		expect(page.done).toBe(false);
		expect(page.results.at(-1)).toEqual({ botId: bot.id, result: { kind: 'missing' } });
	});
	it('finishes a failed index write without changing the document twice', async () => {
		const bot = await legacyBot();
		const before = await stored(bot.id);
		let fail = true;
		const db = {
			prepare: (sql: string) => testEnv.BICKR_D1.prepare(sql),
			batch: (statements: D1PreparedStatement[]) => {
				if (fail) { fail = false; throw new Error('Test index failure'); }
				return testEnv.BICKR_D1.batch(statements);
			},
		} as D1Database;
		const env = { ...testEnv, BICKR_D1: db };
		const coordinator = { ownerUserId: bot.ownerUserId, objectId: 'test', queue: new ExclusiveOperationQueue() };
		expect((await handleAgentRuntimeRequest(ownerRequest(bot), env, coordinator)).status).toBe(500);
		const changed = await stored(bot.id);
		expect(changed.revision).toBe(before.revision + 1);
		expect(changed.tickSettings.contextWindowTokens).toBe(contextWindowTokensMin);
		expect(await contextIndex(bot.id)).toMatchObject({ budget: contextWindowTokensMin - 1 });
		const retry = await handleAgentRuntimeRequest(ownerRequest(bot), env, coordinator);
		expect(retry.status).toBe(200);
		expect(await retry.json()).toMatchObject({ data: { migration: { kind: 'migrated', documentChanged: false, indexChanged: true } } });
		expect(await stored(bot.id)).toEqual(changed);
		expect(await contextIndex(bot.id)).toMatchObject({ budget: contextWindowTokensMin });
	});
	it('serializes migration writes with another request on the owner queue', async () => {
		const bot = await legacyBot();
		let release!: () => void;
		let started!: () => void;
		const waiting = new Promise<void>(resolve => { started = resolve; });
		const gate = new Promise<void>(resolve => { release = resolve; });
		const kv = {
			get: testEnv.BICKR_KV.get.bind(testEnv.BICKR_KV),
			put: async (key: string, value: string) => { started(); await gate; await testEnv.BICKR_KV.put(key, value); },
		} as KVNamespace;
		const env = { ...testEnv, BICKR_KV: kv };
		const coordinator = { ownerUserId: bot.ownerUserId, objectId: 'test', queue: new ExclusiveOperationQueue() };
		const first = handleAgentRuntimeRequest(ownerRequest(bot), env, coordinator);
		await waiting;
		const second = handleAgentRuntimeRequest(ownerRequest(bot), env, coordinator);
		release();
		expect((await first).status).toBe(200);
		const response = await second;
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ data: { migration: { kind: 'unchanged', documentChanged: false, indexChanged: false } } });
	});
	it('keeps the cursor before a missing document and resumes after the document returns', async () => {
		const bot = await legacyBot();
		const document = await stored(bot.id);
		await testEnv.BICKR_KV.delete(kvKeys.bot(bot.id));
		const response = await sweep();
		expect(response.status).toBe(200);
		const page = await migrationPage(response);
		expect(page.done).toBe(false);
		expect(page.nextCursor).not.toBeNull();
		expect(page.nextCursor?.kind).toBe('indexed');
		if (page.nextCursor?.kind !== 'indexed') throw new Error('Expected an indexed cursor.');
		expect(page.nextCursor.afterId < bot.id).toBe(true);
		expect(page.results.at(-1)).toEqual({ botId: bot.id, result: { kind: 'missing' } });
		await testEnv.BICKR_KV.put(kvKeys.bot(bot.id), JSON.stringify(document));
		const resumed = await sweep(page.nextCursor!);
		expect(resumed.status).toBe(200);
		expect((await migrationPage(resumed)).results).toContainEqual({ botId: bot.id, result: { kind: 'migrated', documentChanged: true, indexChanged: true, creationRequestsChanged: 0 } });
	});
	it('requires internal authentication and scheduler authority without maintenance mode', async () => {
		expect((await sweep('', {})).status).toBe(404);
		expect((await sweep()).status).toBe(200);
		const response = await handleAgentRuntimeWorkerRequest(new Request('https://internal.bickr/maintenance/context-budget', { method: 'POST', headers: internalServiceTestHeaders }), { ...testEnv, ...testCoordinatorEnv() });
		expect(response.status).toBe(401);
		const bot = await legacyBot();
		const coordinator = { ownerUserId: bot.ownerUserId, objectId: 'test', queue: new ExclusiveOperationQueue() };
		const owned = ownerRequest(bot);
		const unauthenticated = new Request(owned, { headers: { 'x-bickr-user-id': bot.ownerUserId, 'x-bickr-scheduler': '1' } });
		expect((await handleAgentRuntimeRequest(unauthenticated, testEnv, coordinator)).status).toBe(401);
		const unscheduled = new Request(owned);
		unscheduled.headers.delete('x-bickr-scheduler');
		expect((await handleAgentRuntimeRequest(unscheduled, testEnv, coordinator)).status).toBe(401);
		const responseWithSummary = await handleAgentRuntimeRequest(owned, testEnv, coordinator);
		expect(responseWithSummary.status).toBe(200);
		expect(await responseWithSummary.json()).not.toHaveProperty('data.migration.document');
	});
	it('resumes bounded pages, raises only low overrides, restores NULL defaults, and is idempotent', async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bots = [];
		for (let i = 0; i <= contextBudgetMigrationBatchSize; i++) bots.push(await createBotForTest(cookie, `budget-${i}`, { enabled: false }));
		const [below, at, above, inherited] = bots;
		for (const [bot, value] of [[below!, contextWindowTokensMin - 1], [at!, contextWindowTokensMin], [above!, contextWindowTokensMin + 1]] as const) {
			const document = await stored(bot.id);
			// Seed the old shape that the deployed writer can no longer create.
			await testEnv.BICKR_KV.put(kvKeys.bot(bot.id), JSON.stringify({ ...document, tickSettings: { ...document.tickSettings, contextWindowTokens: value } }));
			await testEnv.BICKR_D1.prepare('UPDATE bot_runtime_index SET context_window_tokens = ? WHERE bot_id = ?').bind(value, bot.id).run();
		}
		// A stale projection must not turn the old effective default into an override.
		await testEnv.BICKR_D1.prepare('UPDATE bot_runtime_index SET context_window_tokens = ? WHERE bot_id = ?').bind(contextWindowTokensMin - 1, inherited!.id).run();
		const before = new Map(await Promise.all(bots.map(async bot => [bot.id, { document: await stored(bot.id), index: await contextIndex(bot.id) }] as const)));
		const firstResponse = await sweep();
		expect(firstResponse.status).toBe(200);
		const first = await migrationPage(firstResponse);
		expect(first.schemaVersion).toBe(1);
		expect(first.results).toHaveLength(contextBudgetMigrationBatchSize);
		expect(first.done).toBe(false);
		expect(first.nextCursor).toEqual({ kind: 'indexed', afterId: first.results.at(-1)?.botId });
		let cursor: ContextBudgetMigrationCursor | '' | null = first.nextCursor;
		while (cursor !== null) {
			const response = await sweep(cursor);
			expect(response.status).toBe(200);
			cursor = (await migrationPage(response)).nextCursor;
		}
		for (const bot of bots) {
			const document = await stored(bot.id);
			const old = before.get(bot.id)!;
			const index = await contextIndex(bot.id);
			if (bot.id === below!.id) {
				expect(document.tickSettings.contextWindowTokens).toBe(contextWindowTokensMin);
				expect(document.revision).toBe(old.document.revision + 1);
				expect(index).toEqual({ ...old.index, budget: contextWindowTokensMin });
			} else {
				expect(document).toEqual(old.document);
				expect(index).toEqual({ ...old.index, budget: document.tickSettings.contextWindowTokens ?? null });
			}
		}
		expect((await stored(inherited!.id)).tickSettings).not.toHaveProperty('contextWindowTokens');
		expect(defaultTickSettings.contextWindowTokens).toBe(contextWindowTokensMin * 2);
		const after = new Map(await Promise.all(bots.map(async bot => [bot.id, await stored(bot.id)] as const)));
		cursor = '';
		while (cursor !== null) {
			const response = await sweep(cursor);
			expect(response.status).toBe(200);
			const page = await migrationPage(response);
			expect(page.results.every(entry => entry.result.kind === 'unchanged')).toBe(true);
			expect(page.changes).toEqual({ documents: 0, indexes: 0, creationRequests: 0 });
			cursor = page.nextCursor;
		}
		for (const bot of bots) expect(await stored(bot.id)).toEqual(after.get(bot.id));
	});
});
