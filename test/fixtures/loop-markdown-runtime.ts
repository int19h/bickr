import { localizedText, type BotLoopMessageDisplay } from '@bickr/shared/model';
import type { ToolResultReadContentItem } from '@bickr/shared/tool-results';
import { botText } from '../../workers/agent-runtime/src/localization';
import { ResultContextScope } from '../../workers/agent-runtime/src/runtime/result-context-scope';
import { testResultTime, testViewRenderContext } from '../../workers/agent-runtime/src/runtime/result-render-context.test-support';
import { buildToolResultView } from '../../workers/agent-runtime/src/runtime/tool-result-views';

export async function prunedLoopThreadFixture() {
	const text = botText('en');
	const fullBody = 'Visible reply starts here. '.repeat(200);
	const hiddenBody = 'This hidden reply must never appear.';
	const scope = new ResultContextScope();
	await scope.observe({ entityId: 'cmt_root', facet: 'comment_body' }, 'Opening body.');
	const comment: ToolResultReadContentItem = {
		type: 'comment', id: 'cmt_root', commentId: 'cmt_root', threadId: 'thr_review',
		worldId: 'world', worldHandle: 'primary', forumId: 'forum', forumHandle: 'general',
		authorBotId: 'alice', authorHandle: 'alice', authorDisplayName: localizedText('Alice', null),
		body: localizedText('Opening body.', null), createdAt: '2026-10-23T10:00:00Z', replies: [],
	};
	const view = await buildToolResultView({
		kind: 'posts_read', items: [], read: {
			operation: 'read_thread', context: '', contextGuidance: { collapsedReplies: false, trimmedBodies: false },
			thread: {
				id: 'thr_review', rootCommentId: 'cmt_root', worldId: 'world', worldHandle: 'primary',
				forumId: 'forum', forumHandle: 'general', authorBotId: 'alice', authorHandle: 'alice',
				authorDisplayName: localizedText('Alice', null), title: localizedText('A pruned conversation', null),
				voteScore: 0, commentCount: 3,
				lastActivityAt: comment.createdAt,
			},
			content: [{ ...comment, replies: [{
				...comment, id: 'cmt_reply', commentId: 'cmt_reply', parentCommentId: 'cmt_root',
				body: localizedText(fullBody, null), replies: [{
					...comment, id: 'cmt_hidden', commentId: 'cmt_hidden', parentCommentId: 'cmt_reply',
					body: localizedText(hiddenBody, null),
				}],
			}] }],
			contextDecision: { operation: 'read_thread', tokenBudget: 300, omittedReplyCount: 0, trimmedBodyCount: 0 },
		},
	}, {
		text, time: testResultTime, selfId: 'reader', scope, writtenAt: comment.createdAt,
		references: new Map([['f/general', 'forum']]),
	});
	if (!view || view.kind !== 'read_thread') throw new Error('The fixture needs a thread view.');
	const shortened = view.facets.find(facet => facet.entityId === 'cmt_reply' && facet.facet === 'comment_body');
	if (!shortened?.value || !shortened.shortened) throw new Error('The fixture needs a shortened body.');
	const display: BotLoopMessageDisplay = {
		kind: 'tool_result', eventSeq: 1, name: 'read_thread', args: {}, result: {},
		envelope: { kind: 'content_read', items: [
			{ kind: 'thread', id: 'thr_review', title: localizedText('Full event data', null), body: localizedText(fullBody, null) },
			{ kind: 'comment', id: 'cmt_hidden', threadId: 'thr_review', body: localizedText(hiddenBody, null) },
		] }, context: { worldHandle: 'primary' },
	};
	return { view, context: testViewRenderContext(view, text), fullBody, hiddenBody, shortenedBody: shortened.value, display };
}
