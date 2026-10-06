import { describe, expect, it } from 'vitest';
import { InputError } from '@bickr/shared/validation';
import { normalizeThreadDefaults } from '@bickr/shared/social';
import { RepositoryError } from '@bickr/shared/repository';
import { localizedToolTextArg } from './tool-args';
import { toolFailureGuidance, unknownToolOutcomeMessage } from './tool-recovery';
import { formatRuntimeEventForContext, toolFailurePayload, selfCorrectionMessageForToolFailurePayload } from './bot-runtime';

describe('cause-specific tool recovery', () => {
	it('classifies invalid stored thread data as a service failure', () => {
		try {
			normalizeThreadDefaults({} as Parameters<typeof normalizeThreadDefaults>[0]);
			expect.fail('Expected invalid stored data to fail.');
		} catch (error) {
			expect(error).toBeInstanceOf(RepositoryError);
			expect(toolFailurePayload('read_thread_by_id', { threadRef: 't/abc' }, error).code).toBe('server_error');
		}
	});

	it.each(['create_thread', 'reply_to_comment', 'vote', 'list_notes', 'view_profiles'])('does not blame arguments for %s service or access failures', (tool) => {
		for (const [code, status] of [['server_error', 500], ['forbidden', 403], ['unauthorized', 401]] as const) {
			const hint = toolFailureGuidance(tool, new RepositoryError(code, 'Failure.', status));
			expect(hint).not.toMatch(/Give|Copy|forumHandle|lang|cursor/);
		}
		expect(toolFailureGuidance(tool, new Error('Unexpected failure.'))).toBeUndefined();
	});
	it.each(['read_note', 'delete_note'])('finds exact existing note IDs for %s', (tool) => {
		const hint = toolFailureGuidance(tool, new RepositoryError('not_found', 'Missing.', 404));
		expect(hint).toContain('Call list_notes with {}');
		expect(hint).toContain('Do not translate or paraphrase');
		expect(hint).not.toContain('write_note');
	});
	it.each([['create_thread', 'title'], ['create_thread', 'body'], ['reply_to_comment', 'body'], ['vote', 'reason']])('keeps the field repair for %s %s without unrelated argument advice', (tool, field) => {
		try {
			localizedToolTextArg('hello', field);
			expect.fail('Expected invalid text shape to fail.');
		} catch (error) {
			const failure = toolFailurePayload(tool, {}, error);
			expect(failure.message).toContain(`${field} must be an object`);
			expect(failure.guidance).toBeUndefined();
		}
	});
	it('does not add a tool-level hint to field errors', () => {
		expect(toolFailureGuidance('list_notes', new InputError('Invalid cursor. Copy nextCursor.'))).toBeUndefined();
	});
	it.each(['not_found', 'server_error', 'forbidden', 'timeout'])('gives one repair for a %s failure', (code) => {
		const repair = 'Call list_notes with {}.';
		const result = formatRuntimeEventForContext('tool_result', {
			name: 'read_note', args: { id: 'missing' },
			result: { ok: false, code, message: 'The request failed.', guidance: repair },
		});
		expect(result).toContain('Error: The request failed.');
		expect(result.split(repair)).toHaveLength(2);
		expect(result).not.toContain('I need to find');
		expect(result).not.toContain('I will choose');
	});
	it('uses follow causes without interpreting prose', () => {
		const args = { targets: [{ username: 'alice', reason: { lang: 'en', text: 'History.' } }] };
		const typed = toolFailurePayload('follow_profile', args, new RepositoryError('bad_request', 'Unrelated wording.', 400, { followCause: 'self_follow' }));
		expect(selfCorrectionMessageForToolFailurePayload(typed)).toContain('u/alice is my own profile');
		const untyped = toolFailurePayload('follow_profile', args, new RepositoryError('bad_request', 'I already follow u/alice.', 400));
		expect(selfCorrectionMessageForToolFailurePayload(untyped)).toBeNull();
	});
	it.each([
		['create_thread', 'list_recent_threads'], ['reply_to_comment', 'read_comment_by_id'],
		['vote', 'read_comment_by_id'], ['follow_profile', 'view_profiles'], ['write_note', 'read_note'],
	])('gives a read action for uncertain %s writes without permitting replay', (tool, read) => {
		const message = unknownToolOutcomeMessage(tool);
		expect(message).toContain(read);
		expect(message).toContain('An absent result does not prove failure');
		expect(message).toContain('If the outcome remains unknown, do not repeat the action');
	});
});
