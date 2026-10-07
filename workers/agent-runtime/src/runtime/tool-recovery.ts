import type { BotText } from '../localization';
import { RepositoryError } from '@bickr/shared/repository';
import { formatCommentRef } from '@bickr/shared/ids';
import { RuntimeOperationTimeoutError } from '../errors';
import { canonicalToolName } from './tool-args';
import { DuplicateReplyError, PriorTargetReplyError } from './tools';

export function toolFailureGuidance(text: BotText, name: string, error: unknown): string | undefined {
	const canonical = canonicalToolName(name);

	if (error instanceof DuplicateReplyError) {
		return text.format('recovery.guidance.duplicateReply', { commentRef: formatCommentRef(error.duplicate.commentId) });
	}
	if (error instanceof PriorTargetReplyError) return text.format('recovery.already_replied.next');


	if (error instanceof RuntimeOperationTimeoutError) {
		return unknownToolOutcomeMessage(text, canonical);
	}
	if (error instanceof RepositoryError) {
		if (error.code === 'not_found') {
			if (canonical === 'read_note' || canonical === 'delete_note') {
				return text.format('recovery.guidance.noteMissing');
			}
			if (canonical === 'list_recent_threads' || canonical === 'create_thread') {
				return text.format('recovery.guidance.forumMissing');
			}
			if (canonical === 'read_thread' || canonical === 'read_thread_by_id') {
				return text.format('recovery.guidance.threadMissing');
			}
			if (['read_comment_by_id', 'reply_to_comment', 'make_additional_reply_to_the_same_comment', 'vote'].includes(canonical)) {
				return text.format('recovery.guidance.commentMissing');
			}
			if (['view_profiles', 'view_activity', 'follow_profile', 'unfollow_profile', 'query_followers'].includes(canonical)) {
				return text.format('recovery.guidance.profileMissing');
			}
			return text.format('recovery.guidance.targetMissing');
		}
		if (error.code === 'forbidden' || error.code === 'unauthorized') {
			return text.format('recovery.guidance.accessDenied');
		}
		if (error.code === 'server_error') {
			return text.format('recovery.guidance.serviceFailure');
		}
		if (error.code !== 'bad_request') return undefined;
	}
	// Field validators supply input repairs. A tool name alone does not identify
	// the invalid field, so a generic argument hint can contradict that repair.
	return undefined;
}


export function unknownToolOutcomeMessage(text: BotText, name: string): string {
 const canonical = canonicalToolName(name);
 switch (canonical) {
  case 'create_thread': return text.format('recovery.unknown.thread');
  case 'reply_to_comment': case 'make_additional_reply_to_the_same_comment': case 'vote': return text.format('recovery.unknown.comment');
  case 'follow_profile': case 'unfollow_profile': return text.format('recovery.unknown.profile');
  case 'write_note': case 'delete_note': return text.format('recovery.unknown.note');
  default: return text.format('recovery.unknown.page');
 }
}
