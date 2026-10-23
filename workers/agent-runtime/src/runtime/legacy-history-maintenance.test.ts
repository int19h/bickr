import { afterEach, describe, expect, it, vi } from 'vitest';
import { botById, userById } from '@bickr/shared/repository';
import type { BotDocument } from '@bickr/shared/model';
import { BotRuntime, runtimeSchema } from './bot-runtime';
import { RuntimeMessageStore } from './message-store';
import { createRuntimeTestStorage, type RuntimeTestStorage } from './sqlite-test-helper';
import { testResultContext } from './result-render-context.test-support';
import { botText } from '../localization';
import { attachToolResultView } from './result-messages';
import { resultViewBase } from './tool-result-views';
import { ProviderRequestError } from '../errors';
import { legacyHistoryCursor, legacyHistoryFleetPage, type LegacyHistoryCost } from './legacy-history-maintenance';

vi.mock('@bickr/shared/repository', async original => ({ ...await original<object>(), botById: vi.fn(), userById: vi.fn() }));
vi.mock('./result-render-context', async original => ({ ...await original<object>(), buildResultRenderContext: vi.fn(async () => testResultContext) }));
const databases: RuntimeTestStorage[] = [];
afterEach(() => { databases.splice(0).forEach(storage => storage.database.close()); vi.clearAllMocks(); });
const text = botText('en');
const settings = { text, model: 'vendor/model', baseUrl: 'https://example.test/v1', apiKey: 'key' };
const bot = { id: 'a', ownerUserId: 'owner', text, toolSettings: {}, inferenceSettings: {}, tickSettings: {} };
const emptyCost = (): LegacyHistoryCost => ({ providerCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, usageMissingCalls: 0 });

function fixture() {
	const storage = createRuntimeTestStorage();
	databases.push(storage);
	storage.database.exec(runtimeSchema);
	const store = new RuntimeMessageStore(storage);
	vi.mocked(botById).mockResolvedValue(bot as never);
	vi.mocked(userById).mockResolvedValue({ id: 'owner' } as never);
	const runtime = Object.assign(Object.create(BotRuntime.prototype), {
		state: { storage }, env: {}, activeRunId: null, activeMaintenanceOperation: null,
		liveness: { read: () => null },
		readStatus: vi.fn(async () => ({ status: 'idle' })), runtimeMessageStore: () => store,
		botWithEffectivePostingSettings: vi.fn(async value => value), effectiveProviderSettings: vi.fn(async () => settings),
		compactionPromptTokenLimit: () => 100, compactionRowsLeaveOutputBudget: () => true,
		textTokenCalibration: () => ({ tokensPerCharacter: 0.25, sampleCount: 0 }),
		renderLoopMessageRow: (_context: unknown, row: { message_json: string }) => JSON.parse(row.message_json),
	});
	const compact = vi.fn(async (_context, _bot, _settings, _run, _signal, rows, _mode, _metrics, cost) => {
		for (const row of rows) storage.sql.exec('UPDATE loop_messages SET compacted_by = 900 WHERE seq = ?', row.seq);
		cost.providerCalls += 1; cost.promptTokens += 100; cost.completionTokens += 10; cost.totalTokens += 110;
		return rows;
	});
	runtime.compactLoopMessageRows = compact;
	function old(content = '{}') {
		return store.appendLoopMessage(testResultContext, 'run', { role: 'tool', tool_call_id: 'old', content }, 'tool_result');
	}
	function modern() {
		return store.appendLoopMessage(testResultContext, 'run', attachToolResultView({ role: 'tool', tool_call_id: 'new' }, {
			...resultViewBase(text), kind: 'read_note', id: 'one', content: 'Keep me', links: [],
		}), 'tool_result');
	}
	return { runtime, storage, store, compact, old, modern };
}

describe('legacy history runtime maintenance', () => {
	it('counts only active, undeleted tool rows without views and exposes the count on status', async () => {
		const f = fixture();
		f.old(); f.modern();
		const deleted = f.old(); const compacted = f.old();
		f.storage.sql.exec("UPDATE loop_messages SET deleted_at = 'now' WHERE seq = ?", deleted.seq);
		f.storage.sql.exec('UPDATE loop_messages SET compacted_by = 900 WHERE seq = ?', compacted.seq);
		f.store.appendLoopMessage(testResultContext, 'run', { role: 'assistant', content: 'Text' }, 'provider_response');
		expect(f.runtime.legacyToolRowCount()).toBe(1);
		f.runtime.requireOwnerOrInternal = vi.fn();
		const url = new URL('https://internal/bots/a/status');
		const response = await f.runtime.handleRuntimeReadRequest(new Request(url), url, 'a');
		expect(await response.json()).toMatchObject({ data: { status: { legacyToolRows: 1 } } });
	});

	it.each(['activeRunId', 'activeMaintenanceOperation', 'journal', 'index'])('defers a busy runtime: %s', async busy => {
		const f = fixture(); f.old();
		if (busy === 'journal') f.runtime.liveness.read = () => ({ kind: 'active' });
		else if (busy === 'index') f.runtime.readStatus.mockResolvedValue({ status: 'running' });
		else f.runtime[busy] = 'busy';
		expect(await f.runtime.compactLegacyHistory('a')).toMatchObject({ kind: 'deferred', remaining: 1, providerCalls: 0 });
		expect(f.compact).not.toHaveBeenCalled();
		expect(f.runtime.effectiveProviderSettings).not.toHaveBeenCalled();
	});

	it('repeats oldest-first selection, stops before newer views, and does nothing on a second pass', async () => {
		const f = fixture();
		const first = f.old('x'.repeat(600));
		const second = f.old('y'.repeat(600));
		f.store.appendLoopMessage(testResultContext, 'run', { role: 'assistant', tool_calls: [{ id: 'new', type: 'function', function: { name: 'read_note', arguments: '{}' } }] }, 'provider_response');
		const kept = f.modern();
		const snapshot = f.storage.sql.exec('SELECT * FROM loop_messages WHERE seq = ?', kept.seq).one();
		expect(await f.runtime.compactLegacyHistory('a')).toMatchObject({ kind: 'compacted', before: 2, remaining: 0, providerCalls: 2, totalTokens: 220 });
		expect(f.compact.mock.calls.map(call => call[5].map((row: { seq: number }) => row.seq))).toEqual([[first.seq], [second.seq]]);
		expect(f.compact.mock.calls.every(call => call[6] === 'auto')).toBe(true);
		expect(f.compact.mock.calls[0][2]).toMatchObject(settings);
		expect(f.storage.sql.exec('SELECT * FROM loop_messages WHERE seq = ?', kept.seq).one()).toEqual(snapshot);
		expect(await f.runtime.compactLegacyHistory('a')).toMatchObject({ kind: 'unchanged', providerCalls: 0 });
		expect(f.compact).toHaveBeenCalledTimes(2);
		expect(f.runtime.activeMaintenanceOperation).toBeNull();
	});

	it('reserves maintenance across awaits so that a second request defers', async () => {
		const f = fixture(); f.old();
		let release!: () => void;
		const paused = new Promise<void>(resolve => { release = resolve; });
		f.runtime.effectiveProviderSettings.mockImplementation(async () => { await paused; return settings; });
		const first = f.runtime.compactLegacyHistory('a');
		await vi.waitFor(() => expect(f.runtime.effectiveProviderSettings).toHaveBeenCalledOnce());
		expect(await f.runtime.compactLegacyHistory('a')).toMatchObject({ kind: 'deferred', providerCalls: 0 });
		release();
		expect(await first).toMatchObject({ kind: 'compacted', remaining: 0 });
	});

	it('reports no key without deterministic fallback', async () => {
		const f = fixture(); f.old();
		f.runtime.effectiveProviderSettings.mockResolvedValue({ ...settings, apiKey: undefined });
		expect(await f.runtime.compactLegacyHistory('a')).toMatchObject({ kind: 'failed', errorKind: 'no_key', remaining: 1, providerCalls: 0 });
		expect(f.compact).not.toHaveBeenCalled();
		expect(f.runtime.activeMaintenanceOperation).toBeNull();
	});

	it('reports a provider failure once and preserves the remaining history', async () => {
		const f = fixture(); f.old();
		f.compact.mockRejectedValue(new ProviderRequestError(503, 'vendor/model', 'endpoint', 'Unavailable'));
		expect(await f.runtime.compactLegacyHistory('a')).toMatchObject({ kind: 'failed', errorKind: 'provider_request', remaining: 1 });
		expect(f.compact).toHaveBeenCalledOnce();
		expect(f.runtime.activeMaintenanceOperation).toBeNull();
	});

	it('reports an inseparable group without compacting a stored view', async () => {
		const f = fixture(); f.old(); f.modern();
		expect(await f.runtime.compactLegacyHistory('a')).toMatchObject({ kind: 'failed', errorKind: 'protected_view_group' });
		expect(f.compact).not.toHaveBeenCalled();
	});

	it.each([false, true])('counts provider calls and tokens without retrying a failure: %s', async fail => {
		const f = fixture();
		f.runtime.renewProgressLease = vi.fn(); f.runtime.throwIfStopped = vi.fn();
		f.runtime.recordInferenceAttribution = vi.fn();
		f.runtime.recordProviderTokenCalibrationSample = vi.fn();
		f.runtime.recordProviderTokenCalibrationSampleFromError = vi.fn();
		f.runtime.fetchProviderCompactionResponse = fail
			? vi.fn().mockRejectedValue(new ProviderRequestError(503, 'vendor/model', 'endpoint', 'Unavailable'))
			: vi.fn().mockResolvedValue({ content: 'Summary.', usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } });
		const cost = emptyCost();
		const call = f.runtime.callProviderForCompaction(settings, [], 'run', new AbortController().signal, undefined, undefined, undefined, 7, '2026-10-23', bot as unknown as BotDocument, undefined, 10000, cost);
		if (fail) await expect(call).rejects.toBeInstanceOf(ProviderRequestError);
		else await call;
		expect(f.runtime.fetchProviderCompactionResponse).toHaveBeenCalledOnce();
		expect(cost).toEqual(fail ? { ...emptyCost(), providerCalls: 1, usageMissingCalls: 1 } : { ...emptyCost(), providerCalls: 1, promptTokens: 100, completionTokens: 10, totalTokens: 110 });
	});
});

function fleetFixture(ids: string[]) {
	const bind = vi.fn((...values: unknown[]) => ({ async all() {
		const cursor = typeof values[0] === 'string' ? values[0] : '';
		return { results: ids.filter(id => id > cursor).slice(0, 25).map(botId => ({ botId })) };
	} }));
	const fetch = vi.fn(async (_request: Request) => Response.json({ data: { status: { legacyToolRows: 2, privateKey: 'hidden' } } }));
	const env = { BICKR_D1: { prepare: () => ({ bind }) }, BOT_RUNTIME: { idFromName: (id: string) => id, get: () => ({ fetch }) }, INTERNAL_SERVICE_SECRET: 'internal-secret' };
	return { env: env as never, bind, fetch };
}

describe('legacy history fleet pages', () => {
	it('uses the shared keyset page, caps wakeups at 25, and resumes at its cursor', async () => {
		const f = fleetFixture(Array.from({ length: 26 }, (_, index) => `bot-${String(index).padStart(2, '0')}`));
		const first = await legacyHistoryFleetPage(f.env, 'census');
		expect(first).toMatchObject({ done: false, nextCursor: 'bot-24' });
		expect(first.legacyRuntimes).toHaveLength(25);
		expect(f.fetch).toHaveBeenCalledTimes(25);
		expect(JSON.stringify(first)).not.toContain('hidden');
		const second = await legacyHistoryFleetPage(f.env, 'census', first.nextCursor!);
		expect(second).toMatchObject({ done: true, nextCursor: null, legacyRuntimes: [{ botId: 'bot-25', legacyToolRows: 2 }] });
		expect(f.bind).toHaveBeenLastCalledWith('bot-24', 25);
	});

	it('reports deferred compaction and transport failures without losing the cursor', async () => {
		const f = fleetFixture(['a', 'b']);
		f.fetch.mockResolvedValueOnce(Response.json({ data: { compaction: { kind: 'deferred', before: 2, remaining: 2, ...emptyCost(), privateKey: 'hidden' } } })).mockRejectedValueOnce(new Error('Offline'));
		const page = await legacyHistoryFleetPage(f.env, 'compact');
		expect(page.results).toMatchObject([{ botId: 'a', kind: 'compaction', result: { kind: 'deferred', remaining: 2 } }, { botId: 'b', kind: 'failed', errorKind: 'dispatch_error' }]);
		expect(JSON.stringify(page)).not.toContain('hidden');
		const request = f.fetch.mock.calls[0]?.[0] as Request;
		expect(request.method).toBe('POST');
		expect(request.headers.get('x-bickr-scheduler')).toBe('1');
	});

	it('rejects invalid cursors and never treats a missing census as zero', async () => {
		expect(() => legacyHistoryCursor(5)).toThrow();
		expect(() => legacyHistoryCursor('x'.repeat(257))).toThrow();
		expect(legacyHistoryCursor('')).toBeUndefined();
		const f = fleetFixture(['a']); f.fetch.mockResolvedValueOnce(Response.json({ data: { status: {} } }));
		expect((await legacyHistoryFleetPage(f.env, 'census')).results).toEqual([{ botId: 'a', kind: 'failed', errorKind: 'invalid_response' }]);
	});
});
