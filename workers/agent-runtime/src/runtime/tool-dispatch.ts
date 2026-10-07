import type { BickrFunctionToolName } from '../prompt-and-tools';
import { canonicalToolName, localizedArgumentText, normalizeToolArgs } from './tool-args';
import type { BotText } from '../localization';
import { unknownToolOutcomeMessage } from './tool-recovery';

export type ToolDispatchStage = 'prepared' | 'reading' | 'dispatched';

type RuntimeFunctionToolName = Exclude<BickrFunctionToolName, 'provide_summary' | 'save_translation' | 'save_avatar_description'> | 'check_notifications';

// Every new runtime tool must choose whether a website mutation can land.
// Local computation and logoff bookkeeping need no duplicate-write guard.
const toolEffects = {
	list_accessible_forums: 'read', list_recent_threads: 'read', list_hot_threads: 'read',
	read_thread: 'read', read_thread_by_id: 'read', read_comment_by_id: 'read',
	create_thread: 'mutation', reply_to_comment: 'mutation', make_additional_reply_to_the_same_comment: 'mutation',
	vote: 'mutation', follow_profile: 'mutation', unfollow_profile: 'mutation',
	search_threads: 'read', search_threads_semantic: 'read', search_profiles: 'read', list_profiles: 'read', view_profiles: 'read',
	list_notes: 'read', read_note: 'read', write_note: 'mutation', delete_note: 'mutation',
	query_followers: 'read', view_activity: 'read', draw_random_integers: 'read', log_off: 'read',
	check_notifications: 'read',
} as const satisfies Readonly<Record<RuntimeFunctionToolName, 'read' | 'mutation'>>;

export function toolExecutionEffect(name: string): 'read' | 'mutation' | undefined {
	return Object.hasOwn(toolEffects, name) ? toolEffects[name as keyof typeof toolEffects] : undefined;
}

export function interruptedToolSettlement(text: BotText, name: string, stage: ToolDispatchStage) {
	switch (stage) {
		case 'prepared': return {
			outcome: 'not_dispatched' as const,
			result: { ok: false, code: 'not_dispatched', message: text.format('recovery.notDispatched') },
		};
		case 'reading': return {
			outcome: 'interrupted' as const,
			result: { ok: false, code: 'interrupted', message: text.format('recovery.interrupted') },
		};
		case 'dispatched': return {
			outcome: 'unknown' as const,
			result: { kind: 'outcome_unknown', message: unknownToolOutcomeMessage(text, name) },
		};
	}
}

export type MutationIdentity =
	| { kind: 'reply'; commentId: string; body: string }
	| { kind: 'thread'; forumHandle: string; title: string };

export function mutationIdentity(name: string, normalizedArgs: Record<string, unknown>): MutationIdentity | undefined {
	const canonical = canonicalToolName(name);
	if (canonical === 'reply_to_comment' || canonical === 'make_additional_reply_to_the_same_comment') {
		const body = localizedArgumentText(normalizedArgs.body);
		if (typeof normalizedArgs.commentId === 'string' && body !== undefined) return { kind: 'reply', commentId: normalizedArgs.commentId, body: body.trim() };
	}
	if (canonical === 'create_thread') {
		const title = localizedArgumentText(normalizedArgs.title);
		if (typeof normalizedArgs.forumHandle === 'string' && title !== undefined) return { kind: 'thread', forumHandle: normalizedArgs.forumHandle, title: title.trim() };
	}
	return undefined;
}

export function storedMutationIdentity(payload: Record<string, unknown>): MutationIdentity | undefined {
	const identity = payload.mutationIdentity;
	if (identity && typeof identity === 'object') {
		const value = identity as Record<string, unknown>;
		if (value.kind === 'reply' && typeof value.commentId === 'string' && typeof value.body === 'string') return value as MutationIdentity;
		if (value.kind === 'thread' && typeof value.forumHandle === 'string' && typeof value.title === 'string') return value as MutationIdentity;
		return undefined;
	}
	// One adapter for outcome events written before typed identities shipped.
	// Retire after the retained event window and all old writers retire.
	try {
		const args = payload.args && typeof payload.args === 'object' ? payload.args as Record<string, unknown> : {};
		const name = typeof payload.name === 'string' ? payload.name : '';
		return mutationIdentity(name, normalizeToolArgs(name, args));
	} catch { return undefined; }
}
