import { prunedLoopThreadFixture } from '../../../../test/fixtures/loop-markdown-runtime';
import { botById } from '@bickr/shared/repository';
import type { EffectiveBotDocument } from '@bickr/shared/model';
import { resultMessage } from './result-text';
import { contextWithProducedReferences } from './result-render-context';
import { failureResultView, settlementResultView, type ResultRenderContext } from './tool-result-views';
import { testViewRenderContext, testResultContext, testResultTime } from './result-render-context.test-support';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { approximateTextTokens } from '@bickr/shared/text-token-estimate';
import { botText } from '../localization';
import { BotRuntime } from './bot-runtime';
import { RuntimeMessageStore } from './message-store';
import { createRuntimeTestStorage, type RuntimeTestStorage } from './sqlite-test-helper';
import { attachToolResultView, renderStoredLoopMessage, toolResultViewFromRow } from './result-messages';
import { buildToolResultView, renderToolResultView, retainKnownProfiles, resultViewFacetArrays, resultViewBase, type ToolResultView } from './tool-result-views';
import { ResultContextScope, hydrateResultFacets } from './result-context-scope';
import { resultHandleKey } from './result-handles';

vi.mock('@bickr/shared/repository', async (original) => ({ ...await original<object>(), botById: vi.fn() }));

const text = botText('en');
const databases: RuntimeTestStorage[] = [];
afterEach(() => databases.splice(0).forEach(storage => storage.database.close()));
const context = (scope = new ResultContextScope()) => ({ time: testResultTime, text, selfId: 'reader', scope, writtenAt: '2026-10-23T10:00:00Z', references: new Map<string, string>() });
function fixture() { const storage = createRuntimeTestStorage(); databases.push(storage); return { storage, store: new RuntimeMessageStore(storage) }; }

describe('stored tool result views', () => {
	it('marks message formats from stored evidence in the messages response', () => {
		const { store } = fixture();
		const view: ToolResultView = { ...resultViewBase(text), kind: 'read_note', id: 'PLAN', content: '- Keep the plan current.', links: [] };
		store.appendLoopMessageGroup(testResultContext, [
			{ runId: 'formats', origin: 'provider_response', message: { role: 'assistant', content: '## My narration', tool_calls: [{ id: 'stored', type: 'function', function: { name: 'read_note', arguments: '{}' } }, { id: 'legacy', type: 'function', function: { name: 'old_tool', arguments: '{}' } }] } },
			{ runId: 'formats', origin: 'tool_result', message: attachToolResultView({ role: 'tool', tool_call_id: 'stored', content: '' }, view) },
			{ runId: 'formats', origin: 'tool_result', message: { role: 'tool', tool_call_id: 'legacy', content: '{"old":true}' } },
			{ runId: 'formats', origin: 'synthetic_context', message: { role: 'assistant', content: '## Context' } },
			{ runId: 'formats', origin: 'input', message: { role: 'user', content: '## Bickr report' } },
			{ runId: 'formats', origin: 'runtime_error', message: { role: 'user', content: '## Unknown old row' } },
		]);
		const response = store.loopMessagesPage(testResultContext, { page: 1 });
		expect(response.messages.map(row => row.contentFormat)).toEqual(['text', 'markdown', 'json', 'text', 'markdown', 'json']);
		expect(store.loopMessagesAfter(testResultContext, 0).map(row => row.contentFormat)).toEqual(response.messages.map(row => row.contentFormat));
		expect(response.messages[1]?.message.content).toContain('PLAN');
	});

	it('keeps legacy synthetic tool rows as JSON and synthetic assistant rows as text', () => {
		const { storage, store } = fixture();
		const legacyJson = '{"threadId":"thr_old","content":[]}';
		store.appendLoopMessage(testResultContext, 'legacy', { role: 'tool', tool_call_id: 'old', content: legacyJson }, 'synthetic_context');
		store.appendLoopMessage(testResultContext, 'legacy', { role: 'assistant', content: legacyJson }, 'synthetic_context');
		store.appendLoopMessage(testResultContext, 'legacy', { role: 'assistant', content: '## Focus text' }, 'synthetic_context');
		const view: ToolResultView = { ...resultViewBase(text), kind: 'read_note', id: 'PLAN', content: '- Keep the plan current.', links: [] };
		store.appendLoopMessage(testResultContext, 'current', attachToolResultView({ role: 'tool', tool_call_id: 'new', content: '' }, view), 'synthetic_context');
		const response = store.loopMessagesPage(testResultContext, { page: 1 });
		expect(response.messages.map(row => row.contentFormat)).toEqual(['json', 'text', 'text', 'markdown']);
		expect(response.messages[0]?.message.content).toBe(legacyJson);
		expect(response.messages[1]?.message.content).toBe(legacyJson);
		expect(store.loopMessagesAfter(testResultContext, 0).map(row => row.contentFormat)).toEqual(['json', 'text', 'text', 'markdown']);
		const summary = store.appendLoopMessage(testResultContext, 'compaction', { role: 'assistant', content: 'Older history summary' }, 'compaction');
		storage.sql.exec('UPDATE loop_messages SET compacted_by = ? WHERE seq <= ?', summary.seq, response.messages[2]!.seq);
		expect(store.loopMessagesPage(testResultContext, { page: 2 }).messages.map(row => row.contentFormat)).toEqual(['json', 'text', 'text']);
	});

	it('keeps the browser fixture equal to the stored render', async () => {
		const fixture = await prunedLoopThreadFixture();
		const failure = failureResultView({ ok: false, code: 'refused', toolName: 'read_thread', args: {}, message: 'Old diagnostic' }, text,
			{ message: { kind: 'literal', value: '### Refused\n\n- Try later.' } });
		const settlement = settlementResultView('not_dispatched', resultMessage('recovery.notDispatched'), text);
		const data = {
			storedView: fixture.view,
			providerText: renderStoredLoopMessage({ message_json: '{"role":"tool","tool_call_id":"read"}', tool_result_view_json: JSON.stringify(fixture.view), tool_result_view_version: 1 }, fixture.context).content,
			fullBody: fixture.fullBody, hiddenBody: fixture.hiddenBody, shortenedBody: fixture.shortenedBody, display: fixture.display,
			failureText: renderToolResultView(failure, testResultContext), settlementText: renderToolResultView(settlement, testResultContext),
		};
		await expect('import type { BotLoopMessageDisplay } from "@bickr/shared/model";\n\nexport const loopMarkdownFixture: ' +
			'{ storedView: unknown; providerText: string; fullBody: string; hiddenBody: string; shortenedBody: string; display: BotLoopMessageDisplay; failureText: string; settlementText: string } = ' +
			JSON.stringify(data, null, 2) + ';\n').toMatchFileSnapshot('../../../../test/fixtures/loop-markdown.ts');
	});

	it('returns the provider text for stored pruned reads and failures', async () => {
		const { storage, store } = fixture();
		const thread = await prunedLoopThreadFixture();
		const failure = failureResultView({ ok: false, code: 'refused', toolName: 'read_thread', args: {}, message: 'Old diagnostic' }, text,
			{ message: { kind: 'literal', value: '### Refused\n\n- Try later.' } });
		for (const [index, view] of [thread.view, failure].entries()) {
			store.appendLoopMessage(thread.context, 'run', attachToolResultView({ role: 'tool', tool_call_id: String(index), content: 'STALE WRITE TIME' }, view), index === 0 ? 'tool_result' : 'tool_failure');
		}
		const runtime = Object.assign(Object.create(BotRuntime.prototype), { state: { storage } });
		const provider = runtime.activeLoopMessagesForProvider(thread.context);
		const api = runtime.loopMessagesPage(thread.context, { page: 1 }).messages;
		expect(api.map((row: import('@bickr/shared/model').BotLoopMessage) => row.message.content)).toEqual(provider.map((row: import('../types').ChatMessage) => row.content));
		expect(api[0].message.content).toContain(thread.shortenedBody);
		expect(api[0].message.content).toContain('1 more reply');
		expect(api[0].message.content).toContain('I read this text earlier');
		expect(api[0].message.content).not.toContain(thread.fullBody.trim());
		expect(api[0].message.content).not.toContain(thread.hiddenBody);
		expect(api[1].message.content).toContain('### Refused');
		expect(JSON.stringify(api)).not.toContain('STALE WRITE TIME');
	});

	it('renders current handles and language through a fresh runtime after restart', async () => {
		const { storage, store } = fixture();
		const note = await buildToolResultView({ kind: 'note_read', id: 'one', content: 'Authored u/before stays unchanged', links: [
			{ kind: 'participant', entityId: 'alice', handle: 'before', deleted: false },
			{ kind: 'forum', entityId: 'general', handle: 'before-forum', deleted: false },
		] }, context());
		const settlement = settlementResultView('not_dispatched', resultMessage('recovery.notDispatched'), text);
		const views = [note!, settlement];
		const writtenContext = contextWithProducedReferences(testResultContext, views);
		store.appendLoopMessageGroup(writtenContext, [
			{ runId: 'run', origin: 'provider_response', message: { role: 'assistant', tool_calls: views.map((_, index) => ({ id: String(index), type: 'function', function: { name: 'read_note', arguments: '{}' } })) } },
			...views.map((view, index) => ({ runId: 'run', origin: 'tool_result' as const, message: attachToolResultView({ role: 'tool' as const, tool_call_id: String(index), content: '' }, view) })),
		]);
		// Existing rows can still contain the former render fields.
		storage.sql.exec("UPDATE loop_messages SET tool_result_view_json = json_set(tool_result_view_json, '$.instructionLocale', 'en', '$.time', json(?)) WHERE role = 'tool'", JSON.stringify(testResultTime));
		const rows = store.activeLoopMessageRows();
		let participantHandle = 'after';
		const queries: { query: string; bindings: unknown[] }[] = [];
		const db = { prepare(query: string) {
			const statement = { bind(...bindings: unknown[]) { queries.push({ query, bindings }); return statement; },
				async all() { return { results: query.includes('FROM bots_index')
					? [{ id: 'alice', handle: participantHandle, handle_at_deletion: null, deleted_at: null }]
					: [{ id: 'general', handle: 'deleted-general', handle_at_deletion: 'last-forum', deleted_at: '2026-10-22' }] }; },
			};
			return statement;
		} };
		vi.mocked(botById).mockResolvedValue({ instructionLocale: 'fr', createdAt: testResultTime.createdAt, timeSettings: testResultTime.settings } as EffectiveBotDocument);
		async function restart() {
			let initialized!: Promise<void>;
			const state = { storage, getWebSockets: () => [], blockConcurrencyWhile(initialize: () => Promise<void>) { initialized = initialize(); return initialized; } };
			const fresh = new BotRuntime(state as unknown as DurableObjectState, { BICKR_D1: db, BICKR_KV: {} } as never);
			await initialized;
			return fresh as unknown as {
				resultRenderContextForRows(id: string, rows: ReturnType<RuntimeMessageStore['activeLoopMessageRows']>): Promise<ResultRenderContext>;
				activeLoopMessagesForProvider(context: ResultRenderContext): import('../types').ChatMessage[];
			};
		}
		const fresh = await restart();
		const current = await fresh.resultRenderContextForRows('reader', rows);
		const messages = fresh.activeLoopMessagesForProvider(current);
		expect(Object.isFrozen(current)).toBe(true);
		expect(Object.isFrozen(current.time)).toBe(true);
		expect(Object.isFrozen(current.time.settings)).toBe(true);
		expect(messages[1]?.content).toContain('u/after');
		expect(messages[1]?.content).toContain(`f/last-forum ${botText('fr').format('result.reference.deleted')}`);
		expect(messages[1]?.content).toContain('Authored u/before stays unchanged');
		expect(messages[2]!.content!).toBe(botText('fr').format('recovery.notDispatched'));
		expect(queries).toHaveLength(2);
		expect(queries.map(item => item.bindings)).toEqual([[JSON.stringify(['alice'])], [JSON.stringify(['general'])]]);
		expect(fresh.activeLoopMessagesForProvider(current)).toEqual(messages);
		expect(queries).toHaveLength(2);
		participantHandle = 'after-again';
		vi.mocked(botById).mockResolvedValue({ instructionLocale: 'de', createdAt: testResultTime.createdAt, timeSettings: testResultTime.settings } as EffectiveBotDocument);
		const second = await restart();
		const next = await second.resultRenderContextForRows('reader', rows);
		expect(second.activeLoopMessagesForProvider(next)[1]?.content).toContain('u/after-again');
		expect(second.activeLoopMessagesForProvider(next)[2]!.content!).toBe(botText('de').format('recovery.notDispatched'));
		expect(fresh.activeLoopMessagesForProvider(current)).toEqual(messages);
		expect(rows.every(row => row.role !== 'tool' || !JSON.parse(row.message_json).content)).toBe(true);
	});


	it('keeps produced references across a batch', () => {
		const makeView = (id: string, handle: string): ToolResultView => ({ ...resultViewBase(text), kind: 'read_note', id, content: 'A note', links: [{ ref: { kind: 'participant', entityId: id, handle }, deleted: false }] });
		const first = makeView('first', 'first-name');
		const second = makeView('second', 'second-name');
		expect(renderToolResultView(first, testResultContext)).toContain('u/first-name (deleted)');
		const once = contextWithProducedReferences(testResultContext, [first]);
		const twice = contextWithProducedReferences(once, [second]);
		expect(renderToolResultView(first, twice)).toBe(renderToolResultView(first, once));
		expect(renderToolResultView(second, twice)).toContain('second-name');
		expect(once.handles.size).toBe(1);
		expect(twice.handles.size).toBe(2);
		const renamedInput = makeView('first', 'a-later-name');
		expect(renderToolResultView(first, contextWithProducedReferences(twice, [renamedInput]))).toContain('first-name');
		expect(testResultContext.handles.size).toBe(0);
	});
	it('stores the view without content and renders it for owner history and compaction input', async () => {
		const { storage, store } = fixture();
		const view = await buildToolResultView({ kind: 'note_read', id: 'one', content: 'A note', links: [] }, context());
		const content = renderToolResultView(view!, testViewRenderContext(view!, text));
		const source = { role: 'tool' as const, tool_call_id: 'call', content, futureInternalField: 'PRIVATE' };
		const message = attachToolResultView(source, view!);
		const written = store.appendLoopMessage(testResultContext, 'run', message, 'tool_result');
		const row = store.loopMessageRow(written.seq)!;
		expect(JSON.parse(row.message_json)).toEqual({ role: 'tool', tool_call_id: 'call' });
		expect(row.tool_result_view_version).toBe(1);
		expect(JSON.parse(row.tool_result_view_json!)).not.toHaveProperty('instructionLocale');
		expect(JSON.parse(row.tool_result_view_json!)).not.toHaveProperty('time');
		expect(row.token_estimate).toBe(approximateTextTokens(content));
		expect(written.tokenEstimate).toBe(row.token_estimate);
		expect(written.message.content).toBe(content);
		expect(JSON.stringify(written.message)).not.toContain('PRIVATE');
		expect(store.loopMessagesAfter(testResultContext, 0)[0]?.message.content).toBe(content);
		expect(store.loopMessagesPage(testResultContext, { page: 1 }).messages[0]?.message.content).toBe(content);
		expect(renderStoredLoopMessage(row, testResultContext).content).toBe(content);
		expect(storage.database.prepare('SELECT COUNT(*) AS n FROM loop_messages').get()).toEqual({ n: 1 });
	});
	it('renders current handles after a storage round trip and leaves authored text unchanged', async () => {
		const { store } = fixture();
		const reference = { kind: 'participant' as const, entityId: 'alice', handle: 'before' };
		const view = await buildToolResultView({ kind: 'note_read', id: 'one', content: 'u/before stays authored', links: [{ ...reference, deleted: false }] }, context());
		const written = store.appendLoopMessage(testViewRenderContext(view!, text), 'run', attachToolResultView({ role: 'tool', tool_call_id: 'call', content: renderToolResultView(view!, testViewRenderContext(view!, text)) }, view!), 'tool_result');
		const row = store.loopMessageRow(written.seq)!;
		const handles = new Map([[resultHandleKey(reference), { kind: 'deleted' as const, handle: 'after' }]]);
		const rendered = renderStoredLoopMessage(row, testViewRenderContext(toolResultViewFromRow(row)!, text, handles));
		expect(rendered.content).toContain('u/before stays authored');
		expect(rendered.content).toContain('u/after (deleted)');
	});
	it('hydrates the newest kept view without writing text into its row', async () => {
		const { storage, store } = fixture();
		const scope = new ResultContextScope();
		const input = { kind: 'posts_searched' as const, posts: [{ threadId: 'thr_one', commentId: 'cmt_one', forumHandle: 'general', title: { text: 'Title', lang: 'en' as import('@bickr/shared/model').LanguageTag }, snippet: { text: 'A body', lang: 'en' as import('@bickr/shared/model').LanguageTag }, authorBotId: 'author', authorHandle: 'author', authorDisplayName: { text: 'Author', lang: 'en' as import('@bickr/shared/model').LanguageTag }, createdAt: '2026-10-23T00:00:00Z', score: 1 }], items: [] };
		const makeContext = () => ({ ...context(scope), references: new Map([['f/general', 'forum']]) });
		const first = await buildToolResultView(input, makeContext());
		const second = await buildToolResultView(input, makeContext());
		const third = await buildToolResultView(input, makeContext());
		const messages = [first!, second!, third!].map((view, index) => store.appendLoopMessage(testViewRenderContext(view!, text), 'run', attachToolResultView({ role: 'tool', tool_call_id: String(index), content: renderToolResultView(view, testViewRenderContext(view, text)) }, view), 'tool_result'));
		storage.sql.exec('UPDATE loop_messages SET compacted_by = 99 WHERE seq = ?', messages[0]!.seq);
		const runtime = Object.assign(Object.create(BotRuntime.prototype), { state: { storage }, activeLoopMessageRows: () => store.activeLoopMessageRows() });
		runtime.hydrateResultViewsAfterCompaction(testViewRenderContext(first!, text), first!.facets);
		const rows = store.activeLoopMessageRows();
		expect(renderStoredLoopMessage(rows[0]!, testViewRenderContext(first!, text)).content).not.toContain('A body');
		expect(renderStoredLoopMessage(rows[1]!, testViewRenderContext(first!, text)).content).toContain('A body');
		expect(JSON.parse(rows[1]!.message_json)).not.toHaveProperty('content');
		const restored = toolResultViewFromRow(rows[1]!)!;
		expect(restored.facets.some(facet => facet.state === 'shown' && facet.value === 'A body')).toBe(true);
		const current = testViewRenderContext(first!, text);
		const api = store.loopMessagesPage(current, { page: 1 }).messages;
		const provider = runtime.activeLoopMessagesForProvider(current);
		expect(api.map(row => row.message.content)).toEqual(provider.map((row: import('../types').ChatMessage) => row.content));
		expect(api.at(-1)?.message.content).toContain('A body');
	});
	it('keeps skipped profile facets on the triggering view for hydration', async () => {
		const profile = { id: 'alice', handle: 'before', homeWorldId: 'world', homeWorldHandle: 'world', language: null, displayName: { text: 'Alice', lang: null }, shortBio: { text: 'A bio', lang: null }, createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z', isFollowedByMe: false, isFollowingMe: false, followers: 0 };
		const scope = new ResultContextScope();
		const shown = await buildToolResultView({ kind: 'profile_viewed', profiles: [profile] }, context(scope));
		const anchor = await buildToolResultView({ kind: 'notifications_checked', events: [] }, context(scope));
		const before = renderToolResultView(anchor!, testViewRenderContext(anchor!, text));
		await retainKnownProfiles(anchor!, [profile], context(scope));
		expect(renderToolResultView(anchor!, testViewRenderContext(anchor!, text))).toBe(before);
		expect(anchor!.contextProfiles?.[0]?.ref).toEqual({ kind: 'participant', entityId: 'alice', handle: 'before' });
		expect(anchor!.facets.every(facet => facet.state === 'known')).toBe(true);
		expect(hydrateResultFacets(shown!.facets, resultViewFacetArrays(anchor!))).toBe(2);
		expect(anchor!.facets.every(facet => facet.state === 'shown')).toBe(true);
	});
	it('renders one stored row with the current participant time configuration', () => {
		const { store } = fixture();
		const ref = { kind: 'participant' as const, entityId: 'alice', handle: 'alice' };
		const view: ToolResultView = { ...resultViewBase(text), kind: 'view_activity', profile: ref, activities: [{ kind: 'follow', profile: ref, when: { instant: '2026-10-02T00:00:00Z', writtenAt: '2026-10-23T00:00:00Z' } }] };
		const message = store.appendLoopMessage(testViewRenderContext(view!, text), 'run', attachToolResultView({ role: 'tool', tool_call_id: 'time', content: '' }, view), 'tool_result');
		const row = store.loopMessageRow(message.seq)!;
		const time = { settings: { mode: 'relative' as const, timezone: 'UTC' }, createdAt: '2026-10-01T00:00:00Z' };
		const render = () => renderStoredLoopMessage(row, testViewRenderContext(toolResultViewFromRow(row)!, text, undefined, time)).content;
		expect(render()).toContain('1d0h0m');
		expect(render()).toBe(render());
		const absolute = renderStoredLoopMessage(row, testViewRenderContext(toolResultViewFromRow(row)!, text, undefined, { ...time, settings: { mode: 'absolute', timezone: 'America/Los_Angeles' } })).content;
		expect(absolute).toContain('2026-10-01T17:00-07:00');
	});
	it('keeps old rows unchanged and rejects unsupported view versions', () => {
		const old = { message_json: JSON.stringify({ role: 'tool', tool_call_id: 'old', content: '{"old":true}' }) };
		expect(renderStoredLoopMessage(old, testResultContext)).toEqual(JSON.parse(old.message_json));
		expect(() => renderStoredLoopMessage({ ...old, tool_result_view_json: '{}', tool_result_view_version: 2 }, testResultContext)).toThrow('schema version');
	});
});
