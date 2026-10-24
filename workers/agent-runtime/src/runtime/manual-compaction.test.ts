import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ApiErrorPayload, ApiSuccessPayload } from '@bickr/shared/model';
import { botById, userById } from '@bickr/shared/repository';
import { fetchProviderResponse, ProviderTransportError } from '@bickr/shared/provider-transport';
import { internalServiceAuthHeader } from '@bickr/shared/internal-service';
import { BotRuntime, runtimeSchema } from './bot-runtime';
import { AgentLogStore, agentLogFailure } from './agent-log-store';
import { RuntimeMessageStore } from './message-store';
import { createRuntimeTestStorage, type RuntimeTestStorage } from './sqlite-test-helper';
import { testResultContext } from './result-render-context.test-support';
import { CompactionSummaryMissingError, PersistentCompactionReductionFailureError, ProviderStructuredOutputValidationError, ProviderCompactionRequestError, ProviderRequestError, ProviderRequestTimeoutError, TickStoppedError, type CompactionReasoningDiagnostic } from '../errors';
import { botText } from '../localization';

vi.mock('@bickr/shared/repository', async original => ({ ...await original<object>(), botById: vi.fn(), userById: vi.fn() }));
vi.mock('@bickr/shared/maintenance', async original => ({ ...await original<object>(), mutationMaintenanceResponse: async () => null }));
vi.mock('./result-render-context', async original => ({ ...await original<object>(), buildResultRenderContext: async () => testResultContext }));
const diagnostic: CompactionReasoningDiagnostic = {
	decision: { kind: 'baseline', selection: { kind: 'model_default' } }, selection: { kind: 'model_default' },
	provenance: { configuration: null, modelDefault: { kind: 'absent' }, safetyFloor: { kind: 'model_default' }, learnedFloor: null, baselineSelection: { kind: 'model_default' }, support: 'unknown', policySource: 'custom_provider' },
};
const persistent = Object.assign(new PersistentCompactionReductionFailureError(5, '{}', diagnostic), { internalSecret: 'private' });
let storage: RuntimeTestStorage;
let logs: AgentLogStore;
let messages: RuntimeMessageStore;
beforeEach(() => {
	storage = createRuntimeTestStorage(); storage.database.exec(runtimeSchema);
	logs = new AgentLogStore(storage); messages = new RuntimeMessageStore(storage);
	vi.mocked(botById).mockResolvedValue({ id: 'participant', ownerUserId: 'owner', text: botText('en'), tickSettings: {} } as never);
	vi.mocked(userById).mockResolvedValue({ id: 'owner' } as never);
});
afterEach(() => { storage.database.close(); vi.clearAllMocks(); vi.unstubAllGlobals(); });
function runtime() {
	return Object.assign(Object.create(BotRuntime.prototype), {
		state: { storage }, env: { INTERNAL_SERVICE_SECRET: 'test' }, agentLogs: logs,
		requireOwnerOrInternal: vi.fn(), beginMaintenanceOperation: vi.fn(), finishMaintenanceOperation: vi.fn(),
		botWithEffectivePostingSettings: async (bot: unknown) => bot,
		effectiveProviderSettings: async () => ({ model: 'test', baseUrl: 'https://provider.test' }),
		exportRecentProviderUsage: vi.fn(), compactLoopMessageBatchesForSession: vi.fn(),
	});
}
function post(instance: ReturnType<typeof runtime>): Promise<Response> {
	return instance.fetch(new Request('http://localhost/bots/participant/compact', { method: 'POST', headers: { [internalServiceAuthHeader]: 'test' } }));
}
function append(origin: 'provider_response' | 'compaction' = 'provider_response') {
	return messages.appendLoopMessage(testResultContext, 'old', { role: 'assistant', content: 'Retained history' }, origin);
}
function sessionId(): string { return storage.sql.exec<{ id: string }>('SELECT id FROM compaction_sessions LIMIT 1').one().id; }
function summary(runId: string) {
	const row = append('compaction');
	storage.sql.exec('UPDATE loop_messages SET session_id = ?, run_id = ? WHERE seq = ?', sessionId(), runId, row.seq);
	return row;
}

it.each([persistent, new ProviderCompactionRequestError(persistent, '{}', diagnostic)])('returns a typed 422 for %s and keeps the failed session', async error => {
	append();
	const instance = runtime();
	instance.compactLoopMessageBatchesForSession.mockImplementation(async (_context: unknown, _bot: unknown, _settings: unknown, runId: string) => {
		const request = logs.begin({ runId, eventSeq: 1, purpose: 'compaction', sessionId: sessionId() });
		for (let index = 0; index < 5; index++) logs.settle(logs.startAttempt(request, '{}'), { kind: 'validation', issue: 'non_reducing_compaction', message: 'The summary did not shrink.' });
		logs.finish(request, 'failed');
		throw error;
	});
	const response = await post(instance);
	expect(response.status).toBe(422);
	const payload = await response.json() as ApiErrorPayload;
	expect(payload).toMatchObject({ ok: false, error: 'bad_request', details: { compactionFailure: { kind: 'validation', issue: 'non_reducing_compaction' } } });
	expect(payload.message).toContain('could not produce a shorter summary');
	expect(payload.message).not.toContain('paused');
	expect(JSON.stringify(payload)).not.toContain('private');
	expect(logs.session(sessionId())).toMatchObject({ outcome: { kind: 'failed', error: { kind: 'validation', issue: 'non_reducing_compaction' } }, requests: [{ attempts: Array.from({ length: 5 }, () => ({ outcome: { kind: 'validation', issue: 'non_reducing_compaction' } })) }] });
	expect(instance.finishMaintenanceOperation).toHaveBeenCalledWith('manual_compaction');
});

it('keeps the compact POST pending while a session GET returns 200, then returns its failure', async () => {
	append();
	const instance = runtime();
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	instance.compactLoopMessageBatchesForSession.mockImplementation(async () => { await gate; throw persistent; });
	let finished = false;
	const pending = post(instance).then(response => { finished = true; return response; });
	await vi.waitFor(() => expect(instance.compactLoopMessageBatchesForSession).toHaveBeenCalledOnce());
	const status = await instance.fetch(new Request(`http://localhost/bots/participant/compaction-sessions/${sessionId()}`, { headers: { [internalServiceAuthHeader]: 'test' } }));
	expect(status.status).toBe(200);
	expect((await status.json()).data.session.outcome).toEqual({ kind: 'pending' });
	expect(finished).toBe(false);
	release();
	expect((await pending).status).toBe(422);
	expect(logs.session(sessionId()).outcome).toMatchObject({ kind: 'failed', error: { issue: 'non_reducing_compaction' } });
});

it('returns an error after a later batch fails while retaining the earlier summary', async () => {
	append();
	const instance = runtime();
	instance.compactLoopMessageBatchesForSession.mockImplementation(async (_context: unknown, _bot: unknown, _settings: unknown, runId: string) => { summary(runId); throw persistent; });
	expect((await post(instance)).status).toBe(422);
	expect(logs.session(sessionId()).outcome).toMatchObject({ kind: 'partial', failedBatchCount: 1, error: { issue: 'non_reducing_compaction' } });
	expect(messages.activeLoopMessageRows().some(row => row.origin === 'compaction')).toBe(true);
});

it('rejects a manual batch run that returns without a summary', async () => {
	append();
	const instance = runtime();
	const response = await post(instance);
	expect(response.status).toBe(422);
	expect(await response.json()).toMatchObject({ ok: false, details: { compactionFailure: { kind: 'validation', issue: 'missing_compaction_summary' } } });
	expect(logs.session(sessionId()).outcome).toMatchObject({ kind: 'failed', error: { kind: 'validation', issue: 'missing_compaction_summary' } });
});

it.each(['empty', 'summary'] as const)('skips provider work for %s history', async history => {
	if (history === 'summary') append('compaction');
	const instance = runtime();
	const response = await post(instance);
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ ok: true, data: { compacted: { messageCount: 0 } } });
	expect(instance.compactLoopMessageBatchesForSession).not.toHaveBeenCalled();
	expect(storage.sql.exec('SELECT id FROM compaction_sessions').toArray()).toEqual([]);
});

it.each([false, true])('compacts new history after a summary: %s', hasSummary => {
	if (hasSummary) append('compaction');
	append();
	const instance = runtime();
	instance.compactLoopMessageBatchesForSession.mockImplementation(async (_context: unknown, _bot: unknown, _settings: unknown, runId: string) => { summary(runId); });
	return post(instance).then(async response => {
		expect(response.status).toBe(200);
		const payload = await response.json() as ApiSuccessPayload<{ compacted: { messageCount: number } }>;
		expect(payload.data.compacted.messageCount).toBe(hasSummary ? 2 : 1);
		expect(logs.session(sessionId()).outcome.kind).toBe('succeeded');
	});
});

it('keeps a provider transport failure distinct from a compaction validation failure', async () => {
	append();
	const instance = runtime();
	const error = new ProviderRequestError(503, 'test', 'https://provider.test', 'Unavailable.');
	instance.compactLoopMessageBatchesForSession.mockRejectedValue(error);
	expect((await post(instance)).status).toBe(502);
	expect(logs.session(sessionId()).outcome).toEqual({ kind: 'failed', error: agentLogFailure(error) });
});


it.each([
	{ error: new ProviderRequestTimeoutError(1000), status: 408, kind: 'timeout' },
	{ error: new TickStoppedError(), status: 409, kind: 'interrupted' },
])('returns a typed $status for a $kind failure', async ({ error, status, kind }) => {
	append();
	const instance = runtime();
	instance.compactLoopMessageBatchesForSession.mockRejectedValue(error);
	const response = await post(instance);
	expect(response.status).toBe(status);
	expect(await response.json()).toMatchObject({ ok: false, details: { compactionFailure: { kind } } });
});

it('preserves a wrapped provider failure as a typed upstream error', async () => {
	append();
	const instance = runtime();
	instance.compactLoopMessageBatchesForSession.mockRejectedValue(new ProviderCompactionRequestError(new ProviderRequestError(503, 'test', 'https://provider.test', 'Unavailable.'), '{}', diagnostic));
	const response = await post(instance);
	expect(response.status).toBe(502);
	expect(await response.json()).toMatchObject({ ok: false, details: { compactionFailure: { kind: 'provider_error', status: 503 } } });
});


it.each(['connection', 'redirect'] as const)('maps a real provider boundary %s failure to a typed 502', async kind => {
	append();
	const instance = runtime();
	vi.stubGlobal('fetch', kind === 'connection'
		? vi.fn().mockRejectedValue(new TypeError('Private connection diagnostic.'))
		: vi.fn().mockResolvedValue(new Response(null, { status: 302 })));
	instance.compactLoopMessageBatchesForSession.mockImplementation(async () => { await fetchProviderResponse('https://provider.test/v1'); });
	const response = await post(instance);
	expect(response.status).toBe(502);
	const payload = await response.json() as ApiErrorPayload;
	expect(payload.details?.compactionFailure).toMatchObject({ kind: 'provider_error', status: null, errorType: kind });
	expect(JSON.stringify(payload)).not.toContain('Private connection diagnostic.');
	expect(logs.session(sessionId()).outcome).toMatchObject({ kind: 'failed', error: { kind: 'provider_error', errorType: kind } });
});

it.each([
	{ wrapped: false, status: 200 }, { wrapped: true, status: 200 },
	{ wrapped: false, status: 503 }, { wrapped: true, status: 503 },
])('records a connection failure from the real compaction body reader (HTTP $status, wrapped: $wrapped)', async ({ wrapped, status }) => {
	append();
	const instance = runtime();
	const diagnosticError = new TypeError('Private body connection diagnostic.');
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({
		pull(controller) { controller.error(diagnosticError); },
	}), { status })));
	instance.compactLoopMessageBatchesForSession.mockImplementation(async (_context: unknown, _bot: unknown, settings: unknown, runId: string, signal: AbortSignal) => {
		const request = logs.begin({ runId, eventSeq: 1, purpose: 'compaction', sessionId: sessionId() });
		const attempt = logs.startAttempt(request, '{}');
		try {
			await instance.fetchProviderCompactionResponse(settings, 'https://provider.test/v1', '{}', signal);
		} catch (error) {
			logs.settle(attempt, agentLogFailure(error));
			logs.finish(request, 'failed');
			throw wrapped ? new ProviderCompactionRequestError(error, '{}', diagnostic) : error;
		}
	});
	const response = await post(instance);
	expect(response.status).toBe(502);
	const payload = await response.json() as ApiErrorPayload;
	expect(payload.details?.compactionFailure).toMatchObject({ kind: 'provider_error', status: null, errorType: 'connection' });
	expect(JSON.stringify(payload)).not.toContain(diagnosticError.message);
	const failure = { kind: 'provider_error', status: null, errorType: 'connection', message: diagnosticError.message };
	expect(logs.session(sessionId())).toMatchObject({ outcome: { kind: 'failed', error: failure }, requests: [{ attempts: [{ outcome: failure }] }] });
});

it.each([
	{ name: 'provider status', create: () => new ProviderRequestError(503, 'test', 'https://provider.test', 'Unavailable.') },
	{ name: 'validation', create: () => new ProviderStructuredOutputValidationError(botText('en'), 'compaction', botText('en').issue('structured_output.nonreducing.before', { compactedTokens: 100 }), { validationIssue: 'transcript_like_compaction' }) },
	{ name: 'redirect', create: () => new ProviderTransportError('redirect', 'Diagnostic') },
	{ name: 'connection', create: () => new ProviderTransportError('connection', 'Diagnostic') },
	{ name: 'missing summary', create: () => new CompactionSummaryMissingError() },
])('builds the owner response from the $name cause instead of diagnostic text', async ({ create }) => {
	append();
	const instance = runtime();
	const payloads: ApiErrorPayload[] = [];
	for (const diagnostic of ['Private diagnostic A.', 'Private diagnostic B.']) {
		const error = create();
		error.message = diagnostic;
		instance.compactLoopMessageBatchesForSession.mockRejectedValue(error);
		const response = await post(instance);
		expect(response.status).toBeGreaterThanOrEqual(400);
		payloads.push(await response.json() as ApiErrorPayload);
	}
	expect(payloads[0]).toEqual(payloads[1]);
	expect(JSON.stringify(payloads)).not.toContain('Private diagnostic');
	const outcomes = storage.sql.exec<{ outcome_json: string }>('SELECT outcome_json FROM compaction_sessions ORDER BY rowid').toArray();
	expect(outcomes.map(row => JSON.parse(row.outcome_json).error.message)).toEqual(['Private diagnostic A.', 'Private diagnostic B.']);
});
