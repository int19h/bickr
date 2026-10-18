import { beforeEach, describe, expect, it } from 'vitest';
import type { LanguageTag } from '@bickr/shared/model';
import type { ViewedProfileResult } from '@bickr/shared/tool-results';
import { botText } from '../localization';
import {
	providerLegacyInputPayload, providerLegacyToolResultPayload, providerSerializationContext,
	providerToolResultPayload, providerViewedProfiles,
} from './tool-results';

const text = botText('en');
const en = 'en' as LanguageTag;
let context = providerSerializationContext(text, { botId: 'reader' });
beforeEach(() => { context = providerSerializationContext(text, { botId: 'reader' }); });
const privateData = { futurePrivateField: 'PRIVATE', ownerUserId: 'PRIVATE', inferenceSettings: { key: 'PRIVATE' } };
const profile = {
	id: 'other', handle: 'alice', homeWorldId: 'world', homeWorldHandle: 'world', language: null,
	displayName: { lang: en, text: 'Alice', ...privateData }, shortBio: { lang: en, text: 'Hello', ...privateData },
	createdAt: '', updatedAt: '', isFollowedByMe: true, isFollowingMe: false, followers: 3,
	associatedNoteReaderBotId: 'reader', associatedNoteIds: ['my-note'], associatedNoteCount: 1,
	...privateData,
} satisfies ViewedProfileResult;
const thread = {
	id: 'thr_public', threadId: 'thr_public', rootCommentId: 'cmt_root', forumHandle: 'general',
	title: { lang: en, text: 'Topic', ...privateData }, authorHandle: 'alice', ...privateData,
};
const comment = {
	type: 'comment', id: 'cmt_reply', threadId: 'thr_public', parentCommentId: 'cmt_root', authorHandle: 'alice',
	body: { lang: en, text: 'Public reply', ...privateData }, ...privateData,
};

function expectPublic(value: unknown): void {
	expect(JSON.stringify(value)).not.toContain('PRIVATE');
	expect(JSON.stringify(value)).not.toContain('futurePrivateField');
}

describe('participant JSON privacy boundaries', () => {
	it('binds private profile note metadata to the reading participant', () => {
		expect(providerViewedProfiles([profile], context.self)).toEqual({ profiles: [{
			username: 'u/alice', displayName: 'Alice', shortBio: 'Hello', isFollowedByMe: true,
			isFollowingMe: false, followers: 3, myNoteIds: ['my-note'], totalMyNoteCount: 1,
		}] });
		for (const reader of ['other', undefined]) {
			const result = providerViewedProfiles([{ ...profile, associatedNoteReaderBotId: reader }], context.self);
			expect(result.profiles[0]).not.toHaveProperty('myNoteIds');
			expect(JSON.stringify(result)).not.toContain('my-note');
			expect(JSON.stringify(result)).not.toContain('NoteCount');
		}
	});

	it('selects fields across discovery, content, activity, and completion responses', () => {
		const cases: Array<[string, unknown]> = [
			['list_accessible_forums', [{ handle: 'general', description: 'Public forum', ...privateData }]],
			['list_recent_threads', [thread]], ['list_hot_threads', [thread]],
			['search_threads', [thread]], ['search_threads_semantic', [thread]],
			['search_profiles', [profile]], ['list_profiles', { profiles: [profile], ...privateData }],
			['view_profiles', { profiles: [profile], ...privateData }],
			['query_followers', { total: 1, usernames: ['alice'], ...privateData }],
			['read_thread_by_id', { thread, content: [{ ...comment, replies: [{ ...comment, id: 'cmt_child' }] }], ...privateData }],
			['view_activity', { bot: profile, activities: [
				{ type: 'thread', threadId: 'thr_public', title: thread.title, ...privateData },
				{ type: 'comment', commentId: 'cmt_reply', parentComment: comment, ...privateData },
				{ type: 'vote', commentId: 'cmt_reply', targetComment: comment, ...privateData },
				{ type: 'follow', bot: profile, ...privateData },
			], ...privateData }],
			['log_off', { ok: true, status: 'finished', message: 'PRIVATE', ...privateData }],
		];
		for (const [name, source] of cases) expectPublic(providerToolResultPayload(name, source, {}, context));
	});

	it('fails closed for unknown and malformed results instead of copying new fields', () => {
		for (const name of ['unknown', 'create_thread', 'reply_to_comment', 'follow_profile', 'unfollow_profile', 'vote', 'draw_random_integers', 'log_off', 'read_note']) {
			expect(providerToolResultPayload(name, privateData, {}, context)).toMatchObject({ ok: false, code: 'result_unavailable' });
		}
	});

	it('projects legacy failures and inputs before they enter participant memory', () => {
		expect(providerLegacyToolResultPayload('read_note', { ok: false, code: 'not_found', message: 'Missing.', ...privateData }, {}, context))
			.toEqual({ ok: false, code: 'not_found', message: 'Missing.' });
		const input = providerLegacyInputPayload({
			...privateData, injections: [{ id: 'PRIVATE', text: 'A thought', ...privateData }],
			spotlightContexts: [{ forum: { handle: 'general', ...privateData }, threads: [thread], content: [comment], ...privateData }],
			notifications: [{ kind: 'follow', type: 'profile_followed', deliveryReasons: ['profile_followed_you'], id: 'PRIVATE', createdAt: '',
				actor: { id: 'other', username: 'u/alice', ...privateData }, ...privateData }],
		}, context);
		expectPublic(input);
		expect(JSON.stringify(input)).toContain('A thought');
		expect(JSON.stringify(input)).toContain('Public reply');
	});

	it('selects note fields and link fields without sharing internal objects', () => {
		const links = [{ kind: 'participant' as const, entityId: 'PRIVATE', handle: 'alice', deleted: false, ...privateData }];
		for (const envelope of [
			{ kind: 'note_read' as const, id: 'own', content: 'My note', links, ...privateData },
			{ kind: 'note_written' as const, outcome: 'created' as const, id: 'own', content: 'My note', links, unknownReferences: [], ...privateData },
		]) {
			const name = envelope.kind === 'note_read' ? 'read_note' : 'write_note';
			expectPublic(providerToolResultPayload(name, envelope, {}, context, {}, envelope));
		}
	});
});
