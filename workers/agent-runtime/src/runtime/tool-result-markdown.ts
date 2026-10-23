import { formatParticipantTime } from '@bickr/shared/participant-time';
import { formatCommentRef, formatThreadRef } from '@bickr/shared/ids';
import type { InstructionText } from '@bickr/shared/instruction-template';
import * as templates from '../.generated/localization/result-templates';
import { createInlineRenderers, type FreeText, type InlineValue, type RenderContext } from '../localization/result-template';
import type * as T from '../localization/result-template-views';
import type { messageParameters } from '../localization/messages';
import type { ResultEntityReference } from './result-handles';
import { renderResultText } from './result-text';
import type { ResultFacetValue } from './result-context-scope';
import { renderResultReference, type ToolResultView, type ResultRenderContext, type CommentView } from './tool-result-views';

type View<K extends ToolResultView['kind']> = Extract<ToolResultView, { kind: K }>;
type Author = CommentView['author'];
type Thread = View<'read_thread'>['thread'];
const free = (value: string | undefined): FreeText => (value ?? '') as FreeText;
const count = (value: number): InlineValue<'count'> => ({ kind: 'count', value });
const commentRef = (id: string): InlineValue<'commentRef'> => ({ kind: 'commentRef', value: formatCommentRef(id) });
const noteId = (id: string): InlineValue<'noteId'> => ({ kind: 'noteId', value: id });
const voteValue = (value: number): 'up' | 'down' | 'cleared' => value > 0 ? 'up' : value < 0 ? 'down' : 'cleared';

/** One instance owns the first mentions of one result, including nested batch results. */
class MarkdownResultRenderer {
	private readonly mentions = new Set<string>();
	private readonly shownFacets = new WeakMap<ToolResultView, Map<string, ResultFacetValue>>();
	private readonly context: RenderContext<typeof messageParameters>;
	private readonly renderContext: ResultRenderContext;
	constructor(renderContext: ResultRenderContext) {
		this.renderContext = renderContext;
		const catalog = renderContext.text;
		const quotationMarks = { open: catalog.format('result.quote.open'), close: catalog.format('result.quote.close') };
		const inline = createInlineRenderers({ catalog, quotationMarks });
		this.context = { catalog, quotationMarks, inline: { ...inline, author: value => `${inline.author(value)}${value.person === 'self' ? ` ${catalog.format('result.author.self_mark')}` : ''}` } };
	}
	private get text() { return this.renderContext.text; }
	private reference(ref: ResultEntityReference): string {
		return renderResultReference(ref, this.renderContext.handles, ` ${this.text.format('result.reference.deleted')}`);
	}
	private profileRef(ref: ResultEntityReference): InlineValue<'profileRef'> { return { kind: 'profileRef', value: this.reference(ref) }; }
	private forumRef(ref: ResultEntityReference): InlineValue<'forumRef'> { return { kind: 'forumRef', value: this.reference(ref) }; }
	private timestamp(instant?: string): InlineValue<'timestamp'> {
		return { kind: 'timestamp', value: instant && Number.isFinite(Date.parse(instant)) ? formatParticipantTime(instant, this.renderContext.time.settings, this.renderContext.time.createdAt) : '' };
	}
	private facetSource(view: ToolResultView, index: number | undefined): ResultFacetValue | undefined {
		const reference = index === undefined ? undefined : view.facets[index];
		if (!reference) return undefined;
		if (reference.state === 'shown') return reference;
		let shown = this.shownFacets.get(view);
		if (!shown) {
			shown = new Map();
			for (const item of view.facets) {
				if (item.state === 'shown') shown.set(this.facetKey(item), item);
			}
			this.shownFacets.set(view, shown);
		}
		return shown.get(this.facetKey(reference));
	}
	private facetKey(facet: ResultFacetValue): string {
		return JSON.stringify([facet.entityId, facet.facet, facet.fingerprint]);
	}
	private facet(view: ToolResultView, index: number | undefined): FreeText | undefined {
		const facet = this.facetSource(view, index);
		if (facet?.state !== 'shown') return undefined;
		const key = this.facetKey(facet);
		if (this.mentions.has(key)) return undefined;
		this.mentions.add(key);
		return free(facet.value);
	}
	private author(view: ToolResultView, author?: Author): InlineValue<'author'> {
		return { kind: 'author', value: { ref: author ? this.reference(author.ref) : '', person: author?.self ? 'self' : 'other', displayName: author ? this.facet(view, author.displayName) : undefined } };
	}
	private threadRef(view: ToolResultView, id: string, title?: number): InlineValue<'threadRef'> {
		return { kind: 'threadRef', value: { ref: formatThreadRef(id), title: this.facet(view, title) } };
	}
	private body(view: ToolResultView, index?: number): T.ResultBodyTemplate['body'] {
		if (index === undefined) return { kind: 'absent' };
		const value = this.facet(view, index);
		const shortened = this.facetSource(view, index)?.shortened;
		return value === undefined ? { kind: 'known' } : { kind: 'shown', value, trimmed: Boolean(shortened) };
	}
	private post(view: ToolResultView, item: CommentView, parent?: string): T.ResultPostTemplate {
		return { ref: commentRef(item.id), author: this.author(view, item.author), when: this.timestamp(item.createdAt), parent: item.parentCommentId || parent ? commentRef(item.parentCommentId ?? parent!) : undefined,
			body: this.body(view, item.body), focused: item.focused, ancestorOnly: item.ancestorOnly, hiddenReplies: count(typeof item.replies === 'number' ? item.replies : 0) };
	}
	private thread(view: ToolResultView, item: Thread, list = false, includeForum = false): T.ResultThreadTemplate {
		const title = this.facet(view, item.title);
		const comments = item.commentCount ?? 0;
		const lockedComments = item.lock ? this.text.format('result.threads.locked_count', { count: comments, reason: this.text.format(`result.thread.lock.reason.${item.lock.kind}`) }) : undefined;
		const lastActivity = this.timestamp(item.lastActivity?.instant);
		const forum = this.forumRef(item.forum);
		return { ref: { kind: 'threadRef', value: { ref: formatThreadRef(item.id), title: list ? undefined : title } }, title: free(title), forum, listForum: includeForum ? forum : undefined,
			author: list ? this.author(view, item.author) : this.author(view), comments: count(comments), lockedComments,
			facts: this.text.format('result.thread.facts', { forum: forum.value, comments: { kind: 'plural', count: comments, text: lockedComments ?? this.context.inline.count(comments) }, score: this.context.inline.score(item.voteScore ?? 0), lastActivity: lastActivity.value }),
			score: { kind: 'score', value: item.voteScore ?? 0 }, lastActivity };
	}
	private forums(view: View<'list_accessible_forums'>): T.ResultForumListTemplate {
		return { forums: view.forums.map(item => ({ ref: this.forumRef(item.ref), description: free(this.facet(view, item.description)), readOnly: item.readOnly })), omitted: count(view.omittedCount) };
	}
	private threads(view: View<'list_threads'>): T.ResultThreadListTemplate {
		return { threads: view.threads.map(item => this.thread(view, item, true, view.includeForum)), includeForum: view.includeForum, omitted: count(view.omittedCount) };
	}
	private read(view: View<'read_thread' | 'read_comment_by_id'>): T.ResultReadTemplate {
		const thread = this.thread(view, view.thread);
		const posts: T.ResultPostTemplate[] = [];
		const walk = (items: CommentView[], parent?: string): void => { for (const item of items) { posts.push(this.post(view, item, parent)); if (Array.isArray(item.replies)) walk(item.replies, item.id); } };
		walk(view.content);
		return { thread, posts, tokenBudget: view.pruning && (view.pruning.omittedReplyCount || view.pruning.trimmedBodyCount) ? count(view.pruning.tokenBudget) : undefined };
	}
	private search(view: View<'search_threads'>): T.ResultSearchTemplate {
		return { posts: view.posts.map(item => { const thread = this.threadRef(view, item.threadId, item.title); const snippet = this.facet(view, item.snippet); return { ref: item.commentId ? commentRef(item.commentId) : this.threadRef(view, item.threadId), thread, title: free(thread.value.title), forum: this.forumRef(item.forum), author: this.author(view, item.author), snippet: free(snippet), known: item.snippet !== undefined && snippet === undefined, when: this.timestamp(item.when.instant) }; }), omitted: count(view.omittedCount) };
	}
	private profiles(view: View<'profiles'>): T.ResultProfilesTemplate {
		const page = view.page;
		return { profiles: view.profiles.map(item => ({ ref: this.author(view, { ref: item.ref, displayName: item.displayName, self: false }), bio: free(this.facet(view, item.bio)), followers: count(item.followers), relation: item.isFollowedByMe ? item.isFollowingMe ? 'mutual' : 'i_follow' : item.isFollowingMe ? 'follows_me' : 'none', notes: (item.myNoteIds ?? []).map(noteId), moreNotes: count(item.omittedMyNoteIdCount ?? 0) })), omitted: count(view.omittedCount),
			page: page ? page.mode === 'window' ? this.text.format('result.profiles.window', { from: page.offset + (view.profiles.length ? 1 : 0), to: page.offset + view.profiles.length, total: page.total }) : this.text.format('result.profiles.random', { count: view.profiles.length, total: page.total }) : undefined,
			next: page?.mode === 'window' && page.hasMore ? this.text.format('result.profiles.next_offset', { offset: page.offset + page.limit }) : undefined };
	}
	private links(links: View<'read_note'>['links']): T.ResultNoteLinksTemplate {
		return { links: links.map(item => item.ref.kind === 'participant' ? this.profileRef(item.ref) : this.forumRef(item.ref)) };
	}
	private readNote(view: View<'read_note'>): T.ResultReadNoteTemplate { return { id: noteId(view.id), content: free(view.content), links: this.links(view.links).links }; }
	private writeNote(view: View<'write_note'>): T.ResultWriteNoteTemplate { return { id: noteId(view.id), outcome: view.outcome, links: this.links(view.links).links, unknownReferences: view.unknownReferences.map(free) }; }
	private listNotes(view: View<'list_notes'>): T.ResultListNotesTemplate { return { ids: view.ids.map(noteId), cursor: view.nextCursor ? { kind: 'cursor', value: view.nextCursor } : undefined, shown: count(view.ids.length), total: count(view.total), unknownFilters: view.unknownFilters.map(free), omitted: count(view.omittedCount) }; }
	private deleteNote(view: View<'delete_note'>): T.ResultDeleteNoteTemplate { return { outcome: view.outcome.kind === 'deleted' ? { kind: 'deleted', id: noteId(view.outcome.id) } : { kind: 'reset', id: noteId(view.outcome.id), content: free(view.outcome.content) } }; }
	private create(view: View<'create_thread'>): T.ResultCreateTemplate { return { thread: this.threadRef(view, view.thread.id, view.thread.title), forum: this.forumRef(view.forum), post: commentRef(view.thread.rootCommentId ?? '') }; }
	private reply(view: View<'reply_to_comment'>): T.ResultReplyTemplate { return { comment: commentRef(view.commentId), parent: commentRef(view.parentCommentId ?? ''), thread: this.threadRef(view, view.threadId, view.threadTitle) }; }
	private votes(view: View<'vote'>): T.ResultVoteTemplate { return { votes: view.votes.map(item => ({ comment: commentRef(item.commentId), thread: this.threadRef(view, item.threadId, item.threadTitle), value: voteValue(item.value) })), omitted: count(view.omittedCount) }; }
	private follows(view: View<'follow_profile'>): T.ResultFollowTemplate { return { profiles: view.profiles.map(item => ({ ref: this.profileRef(item.ref), following: item.following })), omitted: count(view.omittedCount) }; }
	private random(view: View<'draw_random_integers'>): T.ResultRandomTemplate { return { draws: view.numbers.map((number, index) => ({ number: count(number), min: count(view.ranges[index]?.min ?? number), max: count(view.ranges[index]?.max ?? number) })) }; }
	private failure(view: View<'failure'>): T.ResultFailureTemplate {
		const fields = view.fields;
		return { message: renderResultText(view.message, this.text) as InstructionText, guidance: view.guidance ? renderResultText(view.guidance, this.text) as InstructionText : undefined,
			thread: fields.existingThreadId || fields.existingThreadRef ? { kind: 'threadRef', value: { ref: fields.existingThreadRef ?? formatThreadRef(fields.existingThreadId!), title: fields.existingThreadTitle ? free(fields.existingThreadTitle) : undefined } } : undefined,
			forum: view.existingForum ? this.forumRef(view.existingForum) : fields.existingForumHandle ? { kind: 'forumRef', value: `f/${fields.existingForumHandle}` } : undefined,
			comment: fields.existingCommentRef || fields.existingCommentId ? commentRef(fields.existingCommentRef ?? fields.existingCommentId!) : undefined,
			replies: (fields.existingReplies ?? []).map(item => ({ ref: commentRef(item.commentRef ?? item.commentId ?? ''), body: { kind: 'shown', value: free(item.body), trimmed: false }, when: this.timestamp(item.createdAt), author: { kind: 'author', value: { ref: '', person: 'self' } }, parent: fields.targetCommentRef || fields.targetCommentId ? commentRef(fields.targetCommentRef ?? fields.targetCommentId!) : undefined, hiddenReplies: count(0), focused: false, ancestorOnly: false })) };
	}
	private settlement(view: View<'settlement'>): T.ResultSettlementTemplate { return { message: renderResultText(view.outcome.message, this.text) as InstructionText }; }
	private batch(view: View<'batch_outcome'>): T.ResultBatchTemplate {
		return { items: view.items.map(item => { const target = item.targetRef ? this.reference(item.targetRef) : item.target.replace(/\r\n|\r|\n/g, ' '); if (item.kind === 'recorded') return { message: this.render(item.view) as InstructionText };
			return { heading: this.text.format(`result.batch.${item.kind}`, { target }), message: renderResultText(item.message, this.text) as InstructionText, guidance: item.kind === 'refused' && item.guidance ? renderResultText(item.guidance, this.text) as InstructionText : undefined }; }), guidance: renderResultText(view.guidance, this.text) as InstructionText };
	}
	private followers(view: View<'query_followers'>): T.ResultFollowersTemplate { return { profile: this.profileRef(view.profile), direction: view.direction, total: count(view.total), shown: count(view.participants.length), participants: view.participants.map(item => this.profileRef(item)), omitted: count(view.omittedCount) }; }
	private activity(view: View<'view_activity'>): T.ResultActivityTemplate {
		return { profile: this.profileRef(view.profile), omitted: count(view.omittedCount), activities: view.activities.map(item => {
			const when = this.timestamp(item.when.instant).value;
			const forum = 'forum' in item && item.forum ? this.reference(item.forum) : '';
			switch (item.kind) {
				case 'thread': { const thread = this.threadRef(view, item.id, item.title); return { message: this.text.format('result.activity.thread', { when, thread: this.context.inline.threadRef(thread.value), forum, comments: item.commentCount, score: this.context.inline.score(item.voteScore) }), preview: item.bodyPreview ? free(item.bodyPreview) : undefined }; }
				case 'comment': return { message: item.replyTo?.author ? this.text.format('result.activity.reply', { when, comment: formatCommentRef(item.id), forum, parentAuthor: this.reference(item.replyTo.author) }) : this.text.format('result.activity.comment', { when, comment: formatCommentRef(item.id), forum }), preview: item.bodyPreview ? free(item.bodyPreview) : undefined, parentPreview: item.replyTo?.bodyPreview ? free(item.replyTo.bodyPreview) : undefined };
				case 'vote': return { message: this.text.format('result.activity.vote', { when, value: voteValue(item.value), comment: formatCommentRef(item.id), thread: item.threadId ? formatThreadRef(item.threadId) : '' }), reason: item.reason ? free(item.reason) : undefined, targetPreview: item.targetComment?.bodyPreview ? free(item.targetComment.bodyPreview) : undefined, targetAuthor: item.targetComment?.author ? this.profileRef(item.targetComment.author) : undefined };
				case 'follow': case 'unfollow': return { message: this.text.format(`result.activity.${item.kind}`, { when, profile: this.reference(item.profile) }), reason: item.reason ? free(item.reason) : undefined };
			}
		}) };
	}
	private notifications(view: View<'check_notifications'>): T.ResultNotificationsTemplate {
		const events: T.ResultNotificationEntryTemplate[] = [];
		for (const item of view.events) {
			const when = this.timestamp(item.when.instant);
			const actor = item.kind !== 'legacy' && item.kind !== 'coalesced_comment_notice' && 'actor' in item && item.actor ? this.context.inline.author(this.author(view, { ref: item.actor, displayName: item.actorName, self: false }).value) : '';
			const thread = 'thread' in item && item.thread ? this.threadRef(view, item.thread.id, item.thread.title) : undefined;
			const threadText = thread ? this.context.inline.threadRef(thread.value) : '';
			const makePost = (post: { id: string; body?: number; author?: Author; when?: { instant: string } }, parent?: string): T.ResultPostTemplate => ({ ref: commentRef(post.id), author: this.author(view, post.author), when: this.timestamp(post.when?.instant ?? item.when.instant), parent: parent ? commentRef(parent) : undefined, body: this.body(view, post.body), focused: false, ancestorOnly: false, hiddenReplies: count(0) });
			switch (item.kind) {
				case 'bootstrap': events.push({ kind: 'bootstrap', when, message: free(item.message.kind === 'authored' ? item.message.text : [item.message.customMessage ?? this.text.format('factory.bootstrap'), ...(item.message.introForum ? [this.text.format('factory.introAdvice', { forum: this.reference(item.message.introForum) })] : [])].join('\n\n')) }); break;
				case 'thread_post': events.push({ kind: 'thread_post', thread: thread!, message: this.text.format(item.deliveryReasons.includes('personal_forum_post') ? 'result.notifications.thread_post.personal_forum' : 'result.notifications.thread_post.followed', { actor, when: when.value, forum: item.thread.forum ? this.reference(item.thread.forum) : '' }), post: { ref: thread!, body: this.body(view, item.thread.body) } }); break;
				case 'reply': { const posts: T.ResultPostTemplate[] = []; if (item.replyTo.body !== undefined) posts.push(makePost(item.replyTo)); posts.push(makePost(item.comment, item.replyTo.id)); events.push({ kind: 'post', message: this.text.format('result.notifications.reply', { actor, when: when.value, parent: formatCommentRef(item.replyTo.id), thread: threadText }), posts }); break; }
				case 'mention': events.push({ kind: 'post', message: this.text.format('result.notifications.mention', { actor, when: when.value, thread: threadText }), posts: [makePost(item.comment)] }); break;
				case 'comment_notice': events.push({ kind: 'notice', message: this.text.format('result.notifications.notice.comment', { actor, when: when.value, comment: formatCommentRef(item.comment.id), thread: threadText }) }); break;
				case 'coalesced_comment_notice': for (const notice of item.comments) events.push({ kind: 'notice', message: this.text.format('result.notifications.notice.comment', { actor: this.context.inline.author(this.author(view, { ref: item.actor, displayName: item.actorName, self: false }).value), when: this.timestamp(notice.when.instant).value, comment: formatCommentRef(notice.comment.id), thread: this.context.inline.threadRef(this.threadRef(view, notice.comment.threadId, notice.title).value) }) }); break;
				case 'vote': events.push({ kind: 'notice', message: this.text.format('result.notifications.notice.vote', { actor, when: when.value, value: voteValue(item.value), comment: formatCommentRef(item.commentId) }) }); break;
				case 'follow': case 'unfollow': events.push({ kind: 'notice', message: this.text.format(`result.notifications.notice.${item.kind}`, { actor, when: when.value }) }); break;
				case 'follower_activity_digest': events.push({ kind: 'digest', message: this.text.format('result.notifications.digest.heading', { actor, when: when.value }), olderOmitted: item.olderActivityOmitted, titlesOmitted: item.titlesOmitted, activities: item.activities.map(activity => ({ ref: activity.commentId ? commentRef(activity.commentId) : this.threadRef(view, activity.threadId), thread: this.threadRef(view, activity.threadId, item.titlesOmitted ? undefined : activity.title), when: this.timestamp(activity.when.instant) })) }); break;
				case 'legacy': { const posts: T.ResultPostTemplate[] = []; if (item.replyTo?.kind === 'comment' && item.replyTo.comment.body !== undefined) posts.push(makePost(item.replyTo.comment)); if (item.comment) posts.push(makePost(item.comment, item.replyTo?.kind === 'comment' ? item.replyTo.comment.id : undefined)); else if (item.thread?.body !== undefined) posts.push({ ...makePost(item.thread), ref: thread! }); events.push({ kind: 'post', heading: thread, message: this.text.format('result.notifications.legacy', { when: when.value }), posts }); break; }
				case 'unavailable': events.push({ kind: 'notice', message: this.text.format('result.notifications.unavailable', { when: when.value }) }); break;
			}
		}
		return { events, omitted: count(view.omittedCount) };
	}
	render(view: ToolResultView): string {
		let result: string;
		switch (view.kind) {
			case 'list_accessible_forums': result = templates.list_accessible_forums(this.forums(view), this.context); break;
			case 'list_threads': result = templates.list_threads(this.threads(view), this.context); break;
			case 'read_thread': result = templates.read_thread(this.read(view), this.context); break;
			case 'read_comment_by_id': result = templates.read_comment_by_id(this.read(view), this.context); break;
			case 'search_threads': result = templates.search_threads(this.search(view), this.context); break;
			case 'profiles': result = templates.profiles(this.profiles(view), this.context); break;
			case 'read_note': return templates.read_note(this.readNote(view), this.context);
			case 'write_note': result = templates.write_note(this.writeNote(view), this.context); break;
			case 'list_notes': result = templates.list_notes(this.listNotes(view), this.context); break;
			case 'delete_note': return templates.delete_note(this.deleteNote(view), this.context);
			case 'create_thread': result = templates.create_thread(this.create(view), this.context); break;
			case 'reply_to_comment': result = templates.reply_to_comment(this.reply(view), this.context); break;
			case 'vote': result = templates.vote(this.votes(view), this.context); break;
			case 'follow_profile': result = templates.follow_profile(this.follows(view), this.context); break;
			case 'draw_random_integers': result = templates.draw_random_integers(this.random(view), this.context); break;
			case 'log_off': result = templates.log_off({}, this.context); break;
			case 'failure': result = templates.failure(this.failure(view), this.context); break;
			case 'settlement': result = templates.settlement(this.settlement(view), this.context); break;
			case 'batch_outcome': result = templates.batch_outcome(this.batch(view), this.context); break;
			case 'query_followers': result = templates.query_followers(this.followers(view), this.context); break;
			case 'view_activity': result = templates.view_activity(this.activity(view), this.context); break;
			case 'check_notifications': result = templates.check_notifications(this.notifications(view), this.context); break;
			default: { const unhandled: never = view; void unhandled; return this.text.format('result.unavailable'); }
		}
		// Hydrated profiles can live on the result that triggered a synthetic lookup.
		if (view.contextProfiles?.some(profile => [profile.displayName, profile.bio].some(index => index !== undefined && view.facets[index]?.state === 'shown'))) {
			result += `\n\n${templates.profiles(this.profiles({ ...view, kind: 'profiles', source: 'view', profiles: view.contextProfiles }), this.context)}`;
		}
		return result.trimEnd();
	}
}

export function renderMarkdownToolResult(view: ToolResultView, context: ResultRenderContext): string {
	return new MarkdownResultRenderer(context).render(view);
}
