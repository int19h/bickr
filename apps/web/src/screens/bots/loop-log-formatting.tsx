import type { BotInferenceSubmissionMessage, BotLoopMessageRequestLogMessage, BotLoopMessageRequestUsage } from '@bickr/shared/model';
import { prettyJsonText } from '../../inference-submission-formatting';
import { JsonSyntaxBlock, parseJsonForDisplay } from '../../readable/loop-message-values';
import { formatNullableUsageCost, formatTokenCount } from './token-usage';

export function LoopMessageRequestUsageLine({ usage }: { usage: BotLoopMessageRequestUsage }) {
	const estimatedSplit = usage.estimatedCostSplit ? ' approx.' : '';
	return (
		<div className="request-usage-line">
			{formatTokenCount(usage.cachedInputTokens)} cached input tokens ({formatNullableUsageCost(usage.cachedInputCost)}
			{estimatedSplit}){' + '}
			{formatTokenCount(usage.uncachedInputTokens)} uncached input tokens ({formatNullableUsageCost(usage.uncachedInputCost)}
			{estimatedSplit}){' + '}
			{formatTokenCount(usage.outputTokens)} output tokens ({formatNullableUsageCost(usage.outputCost)}){' = '}
			{formatNullableUsageCost(usage.totalCost)}
		</div>
	);
}

export function RawInferenceSubmissionMessageView({
	cacheStatus,
	message,
	position,
}: {
	cacheStatus?: BotLoopMessageRequestLogMessage['cacheStatus'];
	message: BotInferenceSubmissionMessage;
	position: number;
}) {
	const toolCalls = message.tool_calls ?? [];
	return (
		<div className={`submission-message role-${message.role}`}>
			<div className="submission-message-head">
				<b>{message.role}</b>
				<span>#{position}</span>
				{message.tool_call_id && <span>{message.tool_call_id}</span>}
				{cacheStatus && <span className="cache-status">{cacheStatus === 'cached' ? 'cached' : 'partially cached'}</span>}
			</div>
			{message.content && <SubmissionJsonBlock label={message.role === 'tool' ? 'JSON result' : 'content'} value={message.content} />}
			{message.reasoning && <SubmissionJsonBlock label="reasoning" value={message.reasoning} />}
			{message.reasoning_content && <SubmissionJsonBlock label="reasoning_content" value={message.reasoning_content} />}
			{message.reasoning_details && <SubmissionJsonBlock label="reasoning_details" value={message.reasoning_details} />}
			{toolCalls.map((toolCall, index) => (
				<div className="submission-tool-call" key={`${toolCall.id}-${index}`}>
					<div className="submission-tool-name">{toolCall.function.name || 'unknown_tool'}</div>
					<SubmissionJsonBlock label="JSON arguments" value={toolCall.function.arguments} />
				</div>
			))}
		</div>
	);
}

export function SubmissionJsonBlock({ label, value }: { label: string; value: unknown }) {
	const parsed = parseJsonForDisplay(value);
	return (
		<div className="submission-json-block">
			<span>{label}</span>
			{parsed.ok ? <JsonSyntaxBlock value={parsed.value} /> : <pre>{prettyJsonText(value)}</pre>}
		</div>
	);
}
