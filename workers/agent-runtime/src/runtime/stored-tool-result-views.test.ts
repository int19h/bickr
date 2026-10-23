import { afterEach, describe, expect, it } from 'vitest';
import { approximateTextTokens } from '@bickr/shared/text-token-estimate';
import { botText } from '../localization';
import { BotRuntime } from './bot-runtime';
import { RuntimeMessageStore } from './message-store';
import { createRuntimeTestStorage, type RuntimeTestStorage } from './sqlite-test-helper';
import { attachToolResultView, renderStoredLoopMessage, toolResultViewFromRow } from './result-messages';
import { buildToolResultView, renderToolResultView, retainKnownProfiles, resultViewFacetArrays, resultViewBase, type ToolResultView } from './tool-result-views';
import { ResultContextScope, hydrateResultFacets } from './result-context-scope';
import { resultHandleKey } from './result-handles';

const text = botText('en');
const databases: RuntimeTestStorage[] = [];
afterEach(() => databases.splice(0).forEach(storage => storage.database.close()));
const context = (scope = new ResultContextScope()) => ({ text, selfId: 'reader', scope, writtenAt: '2026-10-23T10:00:00Z', references: new Map<string, string>() });
function fixture() { const storage = createRuntimeTestStorage(); databases.push(storage); return { storage, store: new RuntimeMessageStore(storage) }; }

describe('stored tool result views', () => {
	it('stores the view without content and renders it for owner history and compaction input', async () => {
		const { storage, store } = fixture();
		const view = await buildToolResultView({ kind: 'note_read', id: 'one', content: 'A note', links: [] }, context());
		const content = renderToolResultView(view!, text);
		const source = { role: 'tool' as const, tool_call_id: 'call', content, futureInternalField: 'PRIVATE' };
		const message = attachToolResultView(source, view!);
		const written = store.appendLoopMessage('run', message, 'tool_result');
		const row = store.loopMessageRow(written.seq)!;
		expect(JSON.parse(row.message_json)).toEqual({ role: 'tool', tool_call_id: 'call' });
		expect(row.tool_result_view_version).toBe(1);
		expect(row.token_estimate).toBe(approximateTextTokens(content));
		expect(written.tokenEstimate).toBe(row.token_estimate);
		expect(written.message.content).toBe(content);
		expect(JSON.stringify(written.message)).not.toContain('PRIVATE');
		expect(store.loopMessagesAfter(0)[0]?.message.content).toBe(content);
		expect(store.loopMessagesPage({ page: 1 }).messages[0]?.message.content).toBe(content);
		expect(renderStoredLoopMessage(row).content).toBe(content);
		expect(storage.database.prepare('SELECT COUNT(*) AS n FROM loop_messages').get()).toEqual({ n: 1 });
	});
	it('renders current handles after a storage round trip and leaves authored text unchanged', async () => {
		const { store } = fixture();
		const reference = { kind: 'participant' as const, entityId: 'alice', handle: 'before' };
		const view = await buildToolResultView({ kind: 'note_read', id: 'one', content: 'u/before stays authored', links: [{ ...reference, deleted: false }] }, context());
		const written = store.appendLoopMessage('run', attachToolResultView({ role: 'tool', tool_call_id: 'call', content: renderToolResultView(view!, text) }, view!), 'tool_result');
		const row = store.loopMessageRow(written.seq)!;
		const handles = new Map([[resultHandleKey(reference), { handle: 'after', deleted: true }]]);
		const rendered = renderStoredLoopMessage(row, view => renderToolResultView(view, text, handles));
		expect(rendered.content).toContain('u/before stays authored');
		expect(rendered.content).toContain('"handle":"after","deleted":true');
	});
	it('hydrates the newest kept view without writing text into its row', async () => {
		const { storage, store } = fixture();
		const scope = new ResultContextScope();
		const input = { kind: 'posts_searched' as const, posts: [{ threadId: 'thr_one', commentId: 'cmt_one', forumHandle: 'general', title: { text: 'Title', lang: 'en' as import('@bickr/shared/model').LanguageTag }, snippet: { text: 'A body', lang: 'en' as import('@bickr/shared/model').LanguageTag }, authorBotId: 'author', authorHandle: 'author', authorDisplayName: { text: 'Author', lang: 'en' as import('@bickr/shared/model').LanguageTag }, createdAt: '2026-10-23T00:00:00Z', score: 1 }], items: [] };
		const makeContext = () => ({ ...context(scope), references: new Map([['f/general', 'forum']]) });
		const first = await buildToolResultView(input, makeContext());
		const second = await buildToolResultView(input, makeContext());
		const third = await buildToolResultView(input, makeContext());
		const messages = [first!, second!, third!].map((view, index) => store.appendLoopMessage('run', attachToolResultView({ role: 'tool', tool_call_id: String(index), content: renderToolResultView(view, text) }, view), 'tool_result'));
		storage.sql.exec('UPDATE loop_messages SET compacted_by = 99 WHERE seq = ?', messages[0]!.seq);
		const runtime = Object.assign(Object.create(BotRuntime.prototype), { state: { storage }, activeLoopMessageRows: () => store.activeLoopMessageRows() });
		runtime.hydrateResultViewsAfterCompaction(first!.facets);
		const rows = store.activeLoopMessageRows();
		expect(renderStoredLoopMessage(rows[0]!).content).not.toContain('A body');
		expect(renderStoredLoopMessage(rows[1]!).content).toContain('A body');
		expect(JSON.parse(rows[1]!.message_json)).not.toHaveProperty('content');
		const restored = toolResultViewFromRow(rows[1]!)!;
		expect(restored.facets.some(facet => facet.state === 'shown' && facet.value === 'A body')).toBe(true);
	});
	it('keeps skipped profile facets on the triggering view for hydration', async () => {
		const profile = { id: 'alice', handle: 'before', homeWorldId: 'world', homeWorldHandle: 'world', language: null, displayName: { text: 'Alice', lang: null }, shortBio: { text: 'A bio', lang: null }, createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z', isFollowedByMe: false, isFollowingMe: false, followers: 0 };
		const scope = new ResultContextScope();
		const shown = await buildToolResultView({ kind: 'profile_viewed', profiles: [profile] }, context(scope));
		const anchor = await buildToolResultView({ kind: 'notifications_checked', events: [] }, context(scope));
		const before = renderToolResultView(anchor!, text);
		await retainKnownProfiles(anchor!, [profile], context(scope));
		expect(renderToolResultView(anchor!, text)).toBe(before);
		expect(anchor!.contextProfiles?.[0]?.ref).toEqual({ kind: 'participant', entityId: 'alice', handle: 'before' });
		expect(anchor!.facets.every(facet => facet.state === 'known')).toBe(true);
		expect(hydrateResultFacets(shown!.facets, resultViewFacetArrays(anchor!))).toBe(2);
		expect(anchor!.facets.every(facet => facet.state === 'shown')).toBe(true);
	});
	it('renders one stored row with the current participant time configuration', () => {
		const { store } = fixture();
		const ref = { kind: 'participant' as const, entityId: 'alice', handle: 'alice' };
		const view: ToolResultView = { ...resultViewBase(text), kind: 'view_activity', profile: ref, activities: [{ kind: 'follow', profile: ref, when: { instant: '2026-10-02T00:00:00Z', writtenAt: '2026-10-23T00:00:00Z' } }] };
		const message = store.appendLoopMessage('run', attachToolResultView({ role: 'tool', tool_call_id: 'time', content: '' }, view), 'tool_result');
		const row = store.loopMessageRow(message.seq)!;
		const time = { settings: { mode: 'relative' as const, timezone: 'UTC' }, createdAt: '2026-10-01T00:00:00Z' };
		const render = () => renderStoredLoopMessage(row, view => renderToolResultView(view, text, new Map(), time)).content;
		expect(render()).toContain('1d0h0m');
		expect(render()).toBe(render());
		const absolute = renderStoredLoopMessage(row, view => renderToolResultView(view, text, new Map(), { ...time, settings: { mode: 'absolute', timezone: 'America/Los_Angeles' } })).content;
		expect(absolute).toContain('2026-10-01T17:00-07:00');
	});
	it('keeps old rows unchanged and rejects unsupported view versions', () => {
		const old = { message_json: JSON.stringify({ role: 'tool', tool_call_id: 'old', content: '{"old":true}' }) };
		expect(renderStoredLoopMessage(old)).toEqual(JSON.parse(old.message_json));
		expect(() => renderStoredLoopMessage({ ...old, tool_result_view_json: '{}', tool_result_view_version: 2 })).toThrow('schema version');
	});
});
