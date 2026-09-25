import { describe, expect, it } from 'vitest';
import { extractCanonicalEntityReferences } from '@bickr/shared/mentions';
import { deleteBot, updateBot } from './helpers/coordinator-mutations';
import { authCookie, createBotForTest, createForumForTest, seedWorld, testEnv, userIdForHandle } from './helpers/index-harness';
import { noteLinkViews, resolveNoteLinks } from '../workers/agent-runtime/src/runtime/notes';

describe('note links in the live D1 schema', () => {
	it('keeps stable entity IDs across rename, deletion, and handle reuse', async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const ownerId = await userIdForHandle('octocat');
		const original = await createBotForTest(cookie, 'alice');
		const forum = await createForumForTest(cookie, 'field');
		const worldId = original.homeWorldId;
		const resolved = await resolveNoteLinks(testEnv.BICKR_D1, worldId, extractCanonicalEntityReferences('Met u/alice in f/field.'));
		expect(resolved).toEqual({
			links: expect.arrayContaining([
				{ kind: 'participant', entityId: original.id, handle: 'alice' },
				{ kind: 'forum', entityId: forum.id, handle: 'field' },
			]),
			unknown: [],
		});

		await updateBot(testEnv.BICKR_KV, testEnv.BICKR_D1, original.id, ownerId, { handle: 'renamed' });
		await testEnv.BICKR_D1.prepare('UPDATE forums_index SET handle = ? WHERE forum_id = ?').bind('new-field', forum.id).run();
		expect(await noteLinkViews(testEnv.BICKR_D1, worldId, resolved.links)).toEqual(expect.arrayContaining([
			{ kind: 'participant', entityId: original.id, handle: 'renamed', deleted: false },
			{ kind: 'forum', entityId: forum.id, handle: 'new-field', deleted: false },
		]));

		await deleteBot(testEnv.BICKR_KV, testEnv.BICKR_D1, original.id, ownerId);
		const replacement = await createBotForTest(cookie, 'alice');
		expect(replacement.id).not.toBe(original.id);
		const oldView = await noteLinkViews(testEnv.BICKR_D1, worldId, resolved.links);
		expect(oldView.find((link) => link.entityId === original.id)).toMatchObject({ deleted: true });
		const current = await resolveNoteLinks(testEnv.BICKR_D1, worldId, extractCanonicalEntityReferences('u/alice f/missing'));
		expect(current.links).toEqual([{ kind: 'participant', entityId: replacement.id, handle: 'alice' }]);
		expect(current.unknown).toEqual(['f/missing']);
	});
});
