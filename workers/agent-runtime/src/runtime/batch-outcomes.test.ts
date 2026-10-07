import { describe, expect, it } from 'vitest';
import { botText } from '../localization';
import { RuntimeTools, type RuntimeToolsRuntime } from './tools';
import { ToolBatchOutcomeError, type ToolBatchOutcomeItem, ToolCommittedOutcomeError, ToolOutcomeUnknownError } from '../errors';
import { botServiceIssue } from '@bickr/shared/bot-service-issues';
import { RepositoryError } from '@bickr/shared/repository';
import { providerBatchOutcome } from './batch-outcomes';
import { providerSerializationContext } from './tool-results';
import { toolFailurePayload } from './bot-runtime';
import type { BotDocument, RequiredLocalizedText, ThreadDocument } from '@bickr/shared/model';

const text = botText('en');
const reason = { lang: 'en', text: 'A reason' } as RequiredLocalizedText;

describe('per-target batch outcomes', () => {
	async function run(failure: unknown): Promise<ToolBatchOutcomeError> {
		let calls = 0;
		const runtime = { throwIfStopped() {}, forumService: async () => {
			calls += 1;
			if (calls === 2) throw failure;
			return { thread: { id: 'thr_test', comments: [] } as unknown as ThreadDocument };
		} } as unknown as RuntimeToolsRuntime;
		const tools = new RuntimeTools(runtime) as unknown as { voteTool: (bot: BotDocument, runId: string, votes: { commentId: string; value: 1 }[], reason: RequiredLocalizedText, signal: AbortSignal, spotlightId: string, scope: { commentIds: Set<string> }) => Promise<unknown> };
		try {
			await tools.voteTool({ id: 'bot_test' } as BotDocument, 'run_test',
				[{ commentId: 'first', value: 1 }, { commentId: 'second', value: 1 }, { commentId: 'third', value: 1 }],
				reason, new AbortController().signal, 'spt_test', { commentIds: new Set(['first', 'second']) });
			expect.fail('Expected the second target to stop the batch.');
		} catch (error) {
			expect(calls).toBe(2);
			expect(error).toBeInstanceOf(ToolBatchOutcomeError);
			return error as ToolBatchOutcomeError;
		}
	}

	it('retains an earlier vote and names a refused and an unattempted target', async () => {
		const failure = new RepositoryError('not_found', 'Comment gone', 404, { botIssue: botServiceIssue('issue.service.commentMissing', {}) });
		const error = await run(failure);
		expect(error.items.map((item) => [item.target, item.kind])).toEqual([['c/first', 'recorded'], ['c/second', 'refused'], ['c/third', 'not_attempted']]);
		expect(error.items[0]).toMatchObject({ scope: { related: true, unrelated: false } });
	});

	it('retains the spotlight scope for a completed target whose result is unavailable', async () => {
		const error = await run(new ToolCommittedOutcomeError(botServiceIssue('issue.service.mutationResultDeleted', {}), 'Deleted receipt'));
		expect(error.items[1]).toMatchObject({ kind: 'committed', target: 'c/second', scope: { related: true } });
	});

	it('keeps the failed target unknown when a response is lost', async () => {
		const error = await run(new ToolOutcomeUnknownError(new Error('Lost response')));
		expect(error.items.map((item) => item.kind)).toEqual(['recorded', 'unknown', 'not_attempted']);
	});

	it('keeps diagnostics out of the model result and preserves the target-specific repair', () => {
		const items: ToolBatchOutcomeItem[] = [
			{ kind: 'refused', target: 'c/a', args: {}, error: new RepositoryError('not_found', 'Secret backend diagnostic', 404, { botIssue: botServiceIssue('issue.service.commentMissing', {}) }) },
			{ kind: 'unknown', target: 'c/b', scope: { related: false, unrelated: false }, error: new Error('Secret transport diagnostic') },
			{ kind: 'not_attempted', target: 'c/c' },
		];
		const result = providerBatchOutcome(text, 'vote', items, providerSerializationContext(text, { botId: 'bot_test' }), (args, error) => toolFailurePayload(text, 'vote', args, error));
		expect(result.items[0]).toMatchObject({ target: 'c/a', message: 'Comment not found.' });
		expect(JSON.stringify(result)).not.toContain('Secret');
		expect(result.items[1]).toMatchObject({ target: 'c/b', message: expect.stringContaining('do not repeat') });
		expect(result.items[2]).toMatchObject({ target: 'c/c', message: expect.stringContaining('did not attempt') });
	});
});
