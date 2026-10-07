import { describe, expect, it } from 'vitest';
import { botServiceIssue, botServiceIssueManifest, isCommittedBotServiceIssue } from '@bickr/shared/bot-service-issues';
import { parseInstructionIssue } from '@bickr/shared/instruction-issues';
import { parseCreateCommentInput, InputError } from '@bickr/shared/validation';
import { RepositoryError } from '@bickr/shared/repository';
import { maintenanceFailureResponse } from '@bickr/shared/maintenance';
import { BotRuntime, apiErrorPayload, toolFailurePayload } from './bot-runtime';
import { ToolCommittedOutcomeError, ToolOutcomeUnknownError } from '../errors';
import { botText } from '../localization';

const text = botText('en');

// Exercise the service boundary with real response decoding but no persistent state.
function request(response: Response | Error): Promise<unknown> {
	const runtime = Object.create(BotRuntime.prototype) as BotRuntime;
	Object.assign(runtime, { env: { FORUM_COORDINATOR_SERVICE: { fetch: async () => {
		if (response instanceof Error) throw response;
		return response;
	} } } });
	return (runtime as unknown as { forumService(path: string, botId: string, body: unknown, signal: AbortSignal, onDispatch: () => void): Promise<unknown> })
		.forumService('/votes', 'bot_test', {}, new AbortController().signal, () => {});
}
function refused(status: number, issue?: unknown): Response {
	return Response.json({ ok: false, error: 'server_error', message: 'Owner-only provider detail', ...(issue ? { details: { botIssue: issue } } : {}) }, { status });
}

describe('bot service errors', () => {
	it('rejects unknown keys, extra fields, and invalid parameters at the boundary', () => {
		const issue = botServiceIssue('issue.service.textTooLong', { field: 'body.text', count: 4 });
		expect(parseInstructionIssue(botServiceIssueManifest, issue)).toEqual(issue);
		for (const invalid of [
			{ ...issue, key: 'issue.args.readOnly' }, { ...issue, extra: true },
			{ ...issue, parameters: { field: 'body.text', count: -1 } },
			{ ...issue, parameters: { field: 'body text', count: 4 } },
			{ ...issue, parameters: { field: 'body.text', count: 4, secret: 'ignored' } },
		]) expect(parseInstructionIssue(botServiceIssueManifest, invalid)).toBeNull();
	});

	it('retains opaque authored text and never interprets it as a template', () => {
		const title = '{{field}} $` <script> 日本語';
		const issue = botServiceIssue('issue.service.duplicateTitle', { title, forumRef: 'f/a', threadRef: 't/b' });
		expect(text.formatDescriptor(issue)).toContain(title);
	});

	it('gives writer validation a technical field and a typed issue', () => {
		let error: unknown;
		try { parseCreateCommentInput({ body: { lang: 'en', text: '' } }); } catch (caught) { error = caught; }
		expect(error).toBeInstanceOf(InputError);
		expect((error as InputError).botIssue).toEqual(botServiceIssue('issue.service.textRequired', { field: 'body.text' }));
	});

	it('renders a typed issue while keeping owner diagnostics out of the result', () => {
		const error = new RepositoryError('bad_request', 'Private transport diagnostic', 400, { botIssue: botServiceIssue('issue.service.textRequired', { field: 'body.text' }) });
		expect(toolFailurePayload(text, 'reply_to_comment', {}, error).message).toBe('body.text is required.');
		expect(JSON.stringify(toolFailurePayload(text, 'reply_to_comment', {}, new Error('Secret provider diagnostic')))).not.toContain('Secret');
	});

	it('classifies a typed maintenance refusal as not committed despite HTTP 503', async () => {
		await expect(request(maintenanceFailureResponse(new Error('unavailable')))).rejects.toBeInstanceOf(RepositoryError);
	});

	it('classifies an acknowledged write with a deleted result as completed', async () => {
		const issue = botServiceIssue('issue.service.mutationResultDeleted', {});
		expect(isCommittedBotServiceIssue(issue)).toBe(true);
		await expect(request(refused(410, issue))).rejects.toBeInstanceOf(ToolCommittedOutcomeError);
	});

	it('keeps an untyped server failure or a lost response unknown', async () => {
		await expect(request(refused(503))).rejects.toBeInstanceOf(ToolOutcomeUnknownError);
		await expect(request(new Error('connection lost'))).rejects.toBeInstanceOf(ToolOutcomeUnknownError);
	});

	it('does not trust a forged known refusal with an invalid shape', async () => {
		const issue = { ...botServiceIssue('issue.service.searchRebuilding', {}), parameters: { extra: true } };
		await expect(request(refused(503, issue))).rejects.toBeInstanceOf(ToolOutcomeUnknownError);
		expect(apiErrorPayload({ ok: false, error: 'bad_request', message: 'bad', details: { botIssue: issue } })?.details).toBeUndefined();
	});
});
