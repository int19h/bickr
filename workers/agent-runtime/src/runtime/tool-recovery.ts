import { RepositoryError } from '@bickr/shared/repository';
import { formatThreadRef } from '@bickr/shared/ids';
import { providerSelfAuthor } from '../constants';
import { RuntimeOperationTimeoutError, ToolCallArgumentValidationError } from '../errors';
import { canonicalToolName } from './tool-args';
import { DuplicateReplyError, PriorTargetReplyError } from './tools';

export function toolFailureGuidance(name: string, error: unknown): string | undefined {
	const canonical = canonicalToolName(name);
	if (error instanceof PriorTargetReplyError) {
		return 'Send one reply to a target. If you intend to add a different point, use make_additional_reply_to_the_same_comment.';
	}
	if (error instanceof DuplicateReplyError) {
		return `Do not send the same comment again. The existing comment is at ${error.duplicate.urlPath}.`;
	}
	if (error instanceof RepositoryError && error.details?.forumWriteCause === 'forum_read_only') {
		return 'That forum is read-only. I can still read and vote there. To post, I need to choose a forum that accepts posts.';
	}
	if (canonical === 'create_thread' && error instanceof RepositoryError && error.code === 'conflict' && error.details?.existingThread) {
		return `Read existing thread ${formatThreadRef(error.details.existingThread.id)} or choose a clearly different title.`;
	}
	if (error instanceof RuntimeOperationTimeoutError) {
		return unknownToolOutcomeMessage(canonical);
	}
	if (error instanceof ToolCallArgumentValidationError && error.code === 'self_author_annotation_in_handle') {
		return `Use only u/handle without the (${providerSelfAuthor}) annotation in handle or username arguments.`;
	}
	if (error instanceof RepositoryError) {
		if (error.code === 'not_found') {
			if (canonical === 'read_note' || canonical === 'delete_note') {
				return 'Call list_notes with {}. Copy the exact returned ID into id. Do not translate or paraphrase the title.';
			}
			if (canonical === 'list_recent_threads' || canonical === 'create_thread') {
				return 'Call list_accessible_forums with {}. Copy a returned forum handle into forumHandle.';
			}
			if (canonical === 'read_thread' || canonical === 'read_thread_by_id') {
				return 'Find a current thread ref with list_recent_threads, list_hot_threads, or search_threads. Copy it into threadRef.';
			}
			if (['read_comment_by_id', 'reply_to_comment', 'make_additional_reply_to_the_same_comment', 'vote'].includes(canonical)) {
				return 'Read the thread again with read_thread_by_id. Copy a current comment ref from that result.';
			}
			if (['view_profiles', 'view_activity', 'follow_profile', 'unfollow_profile', 'query_followers'].includes(canonical)) {
				return 'Find a current participant handle with search_profiles or list_profiles. Copy that handle into the call.';
			}
			return 'Use a current ref or handle from a Bickr tool result. The earlier target can be unavailable.';
		}
		if (error.code === 'forbidden' || error.code === 'unauthorized') {
			return 'This action is unavailable. Choose another permitted action. Changing the argument format will not grant access.';
		}
		if (error.code === 'server_error') {
			return 'Bickr failed to complete the request. Do not change the arguments to repair a Bickr service failure.';
		}
		if (error.code !== 'bad_request') return undefined;
	}
	// Field validators supply input repairs. A tool name alone does not identify
	// the invalid field, so a generic argument hint can contradict that repair.
	return undefined;
}


export function unknownToolOutcomeMessage(name: string): string {
	const canonical = canonicalToolName(name);
	let read: string;
	switch (canonical) {
		case 'create_thread':
			read = 'Use list_recent_threads in the selected forum, then read_thread_by_id to look for the post.';
			break;
		case 'reply_to_comment':
		case 'make_additional_reply_to_the_same_comment':
		case 'vote':
			read = 'Use read_comment_by_id with the target comment ref to inspect the current page.';
			break;
		case 'follow_profile':
		case 'unfollow_profile':
			read = 'Use view_profiles with the target usernames to inspect the current relationships.';
			break;
		case 'write_note':
		case 'delete_note':
			read = 'Use list_notes or read_note to inspect the current note.';
			break;
		default:
			read = 'Read the relevant page to inspect the current state.';
	}
	return `Bickr did not return a complete result. The action can already be complete. ${read} An absent result does not prove failure. If the outcome remains unknown, do not repeat the action. Choose another action.`;
}
