import { authCookie, createBotForTest, describe, expect, it, kvKeys, seedWorld, testEnv, testCoordinatorEnv, fakeR2Bucket } from './helpers/index-harness';
import { contextWindowTokensMin, type BotDocument } from '@bickr/shared/model';
import { ExclusiveOperationQueue } from '@bickr/shared/exclusive-operation-queue';
import { LifecycleKvReadError } from '@bickr/shared/repository';
import {
	classifyLifecycleFailure, cleanupTerminalLifecycleOperations, InjectedLifecycleFailure,
	lifecycleKvRetryLimit, lifecycleKvRetryWindowMs, lifecycleOperationById,
	nextDueLifecycleOperation, nextLifecycleAlarmAt, recordRetryableLifecycleFailure,
} from '@bickr/shared/entity-lifecycle';
import { parseCreateBotInput } from '@bickr/shared/validation';
import { reserveBotCreate, runBotCreateOperation } from '../workers/agent-runtime/src/lifecycle/bot';
import { reserveAccountDelete, runAccountDeleteOperation } from '../workers/agent-runtime/src/lifecycle/account';
import { handleAgentRuntimeRequest } from '../workers/agent-runtime/src/routes';
import { internalServiceTestHeaders } from './helpers/internal-service-auth';

async function document(botId: string) { return (await testEnv.BICKR_KV.get<BotDocument>(kvKeys.bot(botId), { type: 'json' }))!; }

async function pendingCreation() {
	const cookie = await authCookie();
	await seedWorld(cookie);
	const source = await createBotForTest(cookie, 'bounds-source', { enabled: false });
	const owner = (await document(source.id)).ownerUserId;
	const env = { ...testEnv, ...testCoordinatorEnv() };
	const queue = new ExclusiveOperationQueue();
	const context = { env, coordinator: { objectId: owner, ownerUserId: owner, queue }, request: new Request('https://internal.bickr/create', { headers: { 'idempotency-key': 'bounded-creation' } }) };
	const input = parseCreateBotInput({ handle: 'bounds-pending', language: 'en', displayName: 'Pending participant', shortBio: 'A participant.', prompt: 'Keep useful memories.', inferenceSettings: { openRouterApiKey: 'test-creation-secret' }, tickSettings: { contextWindowTokens: contextWindowTokensMin } });
	const operation = await queue.run(() => reserveBotCreate(context, owner, source.homeWorldHandle, input));
	const interruption = new InjectedLifecycleFailure('bot.materialize.indexes.d1', { category: 'external_retryable', code: 'fixture_interruption', retryable: true });
	await expect(queue.run(() => runBotCreateOperation({ ...context, coordinator: { ...context.coordinator, failureInjector: { checkpoint(point) { if (point === interruption.point) throw interruption; } } } }, operation))).rejects.toBe(interruption);
	return { context, queue, owner, operation, sourceId: source.id, original: await document(operation.entityId) };
}

async function current(fixture: Awaited<ReturnType<typeof pendingCreation>>) { return (await lifecycleOperationById(testEnv.BICKR_D1, fixture.operation.operationId))!; }
function resolutionRequest(fixture: Awaited<ReturnType<typeof pendingCreation>>, kind: 'resume' | 'cancel', revision: number, headers: Record<string, string> = internalServiceTestHeaders) {
	return new Request(`https://internal.bickr/users/${fixture.owner}/lifecycle/operations/${fixture.operation.operationId}/resolve`, {
		method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'x-bickr-user-id': fixture.owner, 'x-bickr-scheduler': '1' }, body: JSON.stringify({ kind, revision }),
	});
}
async function expire(fixture: Awaited<ReturnType<typeof pendingCreation>>) {
	await fixture.queue.run(async () => recordRetryableLifecycleFailure(testEnv.BICKR_D1, await current(fixture), classifyLifecycleFailure(new LifecycleKvReadError('participant_identity')), new Date(Date.now() - lifecycleKvRetryWindowMs - 1_000).toISOString()));
}

describe('bounded KV creation recovery', () => {
	it('blocks a permanent identity mismatch at the attempt limit and preserves all data', async () => {
		const fixture = await pendingCreation();
		const mismatch = { ...fixture.original, handle: 'different-saved-handle' };
		await testEnv.BICKR_KV.put(kvKeys.bot(mismatch.id), JSON.stringify(mismatch));
		for (let attempt = 1; attempt <= lifecycleKvRetryLimit; attempt++) {
			await expect(fixture.queue.run(() => runBotCreateOperation(fixture.context, fixture.operation))).rejects.toMatchObject({ code: attempt === lifecycleKvRetryLimit ? 'conflict' : 'server_error' });
			const waiting = await current(fixture);
			expect(waiting.kvRetryCount).toBe(attempt);
			expect(waiting.retryCount).toBe(1);
		}
		const blocked = await current(fixture);
		expect(blocked).toMatchObject({ phase: 'terminal_failed', kvRetryState: 'blocked', nextRetryAt: null, failureCategory: 'retry_exhausted', failureCode: 'creation_kv_participant_identity', terminalCleanupAt: null });
		expect(blocked.requestJson).not.toBeNull();
		expect(blocked.requestHash).toBe(fixture.operation.requestHash);
		expect(await document(mismatch.id)).toEqual(mismatch);
		expect(await testEnv.BICKR_D1.prepare('SELECT lifecycle_state AS state FROM bots_index WHERE bot_id = ?').bind(mismatch.id).first()).toEqual({ state: 'pending' });
		expect(await testEnv.BICKR_D1.prepare('SELECT bot_id FROM bot_runtime_index WHERE bot_id = ?').bind(mismatch.id).first()).not.toBeNull();
		expect(await testEnv.BICKR_D1.prepare('SELECT entity_id FROM entity_lifecycle_identity_claims WHERE operation_id = ?').bind(blocked.operationId).first()).not.toBeNull();
		expect(await testEnv.BICKR_D1.prepare('SELECT operation_id FROM entity_lifecycle_secrets WHERE operation_id = ?').bind(blocked.operationId).first()).not.toBeNull();
		expect(await nextDueLifecycleOperation(testEnv.BICKR_D1, fixture.owner, new Date(Date.now() + 86_400_000).toISOString())).toBeNull();
		expect(await nextLifecycleAlarmAt(testEnv.BICKR_D1, fixture.owner)).toBeNull();
		await cleanupTerminalLifecycleOperations(testEnv.BICKR_D1, '2100-01-01T00:00:00Z');
		expect(await current(fixture)).toEqual(blocked);
	}, 60_000);

	it('succeeds when a stale read clears before the bound', async () => {
		const fixture = await pendingCreation();
		const stale = { ...fixture.original, handle: 'stale-handle' };
		await testEnv.BICKR_KV.put(kvKeys.bot(stale.id), JSON.stringify(stale));
		await expect(fixture.queue.run(() => runBotCreateOperation(fixture.context, fixture.operation))).rejects.toBeInstanceOf(LifecycleKvReadError);
		const waiting = await current(fixture);
		expect(waiting.kvRetryState).toBe('retrying');
		expect(waiting.kvRetryCount).toBe(1);
		expect(Date.parse(waiting.kvRetryDeadlineAt!)).toBeGreaterThan(Date.now());
		await testEnv.BICKR_KV.put(kvKeys.bot(stale.id), JSON.stringify(fixture.original));
		await fixture.queue.run(() => runBotCreateOperation(fixture.context, fixture.operation));
		expect((await current(fixture)).phase).toBe('terminal');
		expect((await document(stale.id)).deletedAt).toBeUndefined();
	});

	it('records migration failures with a fixed deadline and blocks when time expires', async () => {
		const fixture = await pendingCreation();
		const stale = { ...fixture.original, revision: 0 };
		await testEnv.BICKR_KV.put(kvKeys.bot(stale.id), JSON.stringify(stale));
		await expect(fixture.queue.run(() => runBotCreateOperation(fixture.context, fixture.operation))).rejects.toBeInstanceOf(LifecycleKvReadError);
		const first = await current(fixture);
		expect(first).toMatchObject({ kvRetryState: 'retrying', kvRetryCount: 1, failureCode: 'creation_kv_participant_revision' });
		await expect(fixture.queue.run(() => runBotCreateOperation(fixture.context, fixture.operation))).rejects.toBeInstanceOf(LifecycleKvReadError);
		expect((await current(fixture)).kvRetryDeadlineAt).toBe(first.kvRetryDeadlineAt);
		// Move the clock boundary in stored test state, without changing the data.
		await testEnv.BICKR_D1.prepare('UPDATE entity_lifecycle_operations SET kv_retry_deadline_at = ? WHERE operation_id = ?').bind(new Date(Date.now() - 1).toISOString(), first.operationId).run();
		await expect(fixture.queue.run(() => runBotCreateOperation(fixture.context, fixture.operation))).rejects.toMatchObject({ code: 'conflict' });
		expect(await current(fixture)).toMatchObject({ phase: 'terminal_failed', kvRetryState: 'blocked', failureCode: first.failureCode });
		expect(await document(stale.id)).toEqual(stale);
	});

	it('guards operator actions, fences stale revisions, and resumes a held creation', async () => {
		const fixture = await pendingCreation();
		await expire(fixture);
		await expect(fixture.queue.run(() => runBotCreateOperation(fixture.context, fixture.operation))).rejects.toMatchObject({ code: 'conflict' });
		const blocked = await current(fixture);
		await testEnv.BICKR_D1.prepare("UPDATE maintenance_control SET enabled = 1, activated_at = ? WHERE id = 1").bind(new Date().toISOString()).run();
		const dispatch = (request: Request) => handleAgentRuntimeRequest(request, fixture.context.env, fixture.context.coordinator);
		expect((await dispatch(resolutionRequest(fixture, 'resume', blocked.revision, {}))).status).toBe(401);
		const unscheduled = resolutionRequest(fixture, 'resume', blocked.revision);
		unscheduled.headers.delete('x-bickr-scheduler');
		expect((await dispatch(unscheduled)).status).toBe(401);
		expect((await dispatch(resolutionRequest(fixture, 'resume', blocked.revision - 1))).status).toBe(409);
		const resumed = await dispatch(resolutionRequest(fixture, 'resume', blocked.revision));
		expect(resumed.status).toBe(200);
		expect(await resumed.json()).toMatchObject({ data: { resolution: { kind: 'resumed' } } });
		expect(await current(fixture)).toMatchObject({ phase: 'materializing', kvRetryState: 'none', kvRetryCount: 0, kvRetryDeadlineAt: null });
		const replay = await dispatch(resolutionRequest(fixture, 'resume', blocked.revision));
		expect(await replay.json()).toMatchObject({ data: { resolution: { kind: 'not_blocked' } } });
		await testEnv.BICKR_D1.prepare('UPDATE maintenance_control SET enabled = 0, activated_at = NULL WHERE id = 1').run();
		await fixture.queue.run(() => runBotCreateOperation(fixture.context, fixture.operation));
		expect((await current(fixture)).phase).toBe('terminal');
	});

	it.each([false, true])('never cancels a foreign avatar through a mismatched reference: misfiled=%s', async misfiled => {
		const fixture = await pendingCreation();
		const r2 = fakeR2Bucket();
		const foreignKey = `worlds/${fixture.original.homeWorldId}/bots/${fixture.sourceId}/avatars/foreign.png`;
		await r2.bucket.put(foreignKey, new Uint8Array([1, 2, 3]));
		await testEnv.BICKR_KV.put(kvKeys.bot(fixture.operation.entityId), JSON.stringify({ ...fixture.original,
			...(misfiled ? { id: fixture.sourceId, ownerUserId: 'another-owner' } : {}), avatar: { key: foreignKey },
		}));
		await expire(fixture);
		await expect(fixture.queue.run(() => runBotCreateOperation(fixture.context, fixture.operation))).rejects.toMatchObject({ code: 'conflict' });
		const blocked = await current(fixture);
		const cancelled = await handleAgentRuntimeRequest(resolutionRequest(fixture, 'cancel', blocked.revision), { ...fixture.context.env, BICKR_R2: r2.bucket }, fixture.context.coordinator);
		expect(cancelled.status, await cancelled.clone().text()).toBe(200);
		expect(r2.objects.has(foreignKey)).toBe(true);
		expect(await document(fixture.sourceId)).not.toBeNull();
	});

	it('refuses cancellation when the saved request targets another participant', async () => {
		const fixture = await pendingCreation();
		await expire(fixture);
		await expect(fixture.queue.run(() => runBotCreateOperation(fixture.context, fixture.operation))).rejects.toMatchObject({ code: 'conflict' });
		const blocked = await current(fixture);
		await testEnv.BICKR_D1.prepare('UPDATE entity_lifecycle_operations SET request_json = ? WHERE operation_id = ?')
			.bind(JSON.stringify({ ...JSON.parse(blocked.requestJson!), botId: fixture.sourceId }), blocked.operationId).run();
		const cancelled = await handleAgentRuntimeRequest(resolutionRequest(fixture, 'cancel', blocked.revision), fixture.context.env, fixture.context.coordinator);
		expect(cancelled.status).toBe(409);
		expect((await current(fixture)).kvRetryState).toBe('blocked');
		expect(await document(fixture.operation.entityId)).toEqual(fixture.original);
		expect(await document(fixture.sourceId)).not.toBeNull();
	});

	it('keeps account deletion visible until an operator cancels the blocked creation', async () => {
		const fixture = await pendingCreation();
		await expire(fixture);
		await expect(fixture.queue.run(() => runBotCreateOperation(fixture.context, fixture.operation))).rejects.toMatchObject({ code: 'conflict' });
		const blocked = await current(fixture);
		const accountContext = { ...fixture.context, request: new Request('https://internal.bickr/delete', { headers: { 'idempotency-key': 'delete-after-cancel' } }) };
		await expect(fixture.queue.run(() => reserveAccountDelete(accountContext, fixture.owner))).rejects.toMatchObject({ code: 'conflict' });
		expect(await testEnv.BICKR_D1.prepare('SELECT lifecycle_state AS state FROM users_index WHERE user_id = ?').bind(fixture.owner).first()).toEqual({ state: 'active' });
		expect(await document(fixture.operation.entityId)).toEqual(fixture.original);
		const cancelled = await handleAgentRuntimeRequest(resolutionRequest(fixture, 'cancel', blocked.revision), fixture.context.env, fixture.context.coordinator);
		expect(cancelled.status, await cancelled.clone().text()).toBe(200);
		expect(await cancelled.json()).toMatchObject({ data: { resolution: { kind: 'cancelled' } } });
		const replay = await handleAgentRuntimeRequest(resolutionRequest(fixture, 'cancel', blocked.revision), fixture.context.env, fixture.context.coordinator);
		expect(await replay.json()).toMatchObject({ data: { resolution: { kind: 'not_blocked' } } });
		expect(await document(fixture.operation.entityId)).toBeNull();
		expect((await current(fixture)).requestJson).toBeNull();
		expect((await current(fixture)).terminalCleanupAt).not.toBeNull();
		const account = await fixture.queue.run(() => reserveAccountDelete(accountContext, fixture.owner));
		let result = await fixture.queue.run(() => runAccountDeleteOperation(accountContext, account));
		for (let attempt = 0; result.kind === 'account_delete_pending' && attempt < 5; attempt++) result = await fixture.queue.run(() => runAccountDeleteOperation(accountContext, account));
		expect(result.kind).toBe('account_delete_complete');
	});
});
