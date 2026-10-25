import type { AgentLogReasoningPart, BotInferenceSubmissionMessage } from '@bickr/shared/model';
import { readableReasoningFormat } from '@bickr/shared/model';
import { useLayoutEffect, useRef, useState } from 'react';
import { normalizeReadableText, reasoningDetailsForDisplay, reasoningOpaqueCountsForDisplay, reasoningPartsForDisplay } from '../reasoning-formatting';
import { LoopMarkdown } from './loop-markdown';
import { Icon } from '../ui';

export function LoopReasoning({ message }: { message: BotInferenceSubmissionMessage & { reasoningParts?: AgentLogReasoningPart[] } }) {
	const live = message.reasoningParts !== undefined;
	const readableSettled = !live && message.reasoning_format === readableReasoningFormat;
	// The stored marker certifies settled text. Older flat fields have no such evidence.
	const details = message.reasoningParts !== undefined ? reasoningPartsForDisplay(message.reasoningParts)
		: readableSettled ? { ...reasoningOpaqueCountsForDisplay(message.reasoning_details ?? []), text: normalizeReadableText(message.reasoning ?? ''), hasText: true, hasSummary: false }
		: reasoningDetailsForDisplay(message.reasoning_details ?? []);
	const classified = live || readableSettled || message.reasoning_details !== undefined;
	const text = classified ? details.text : message.reasoning || message.reasoning_content || '';
	const summaryOnly = details.hasSummary && !details.hasText;
	const opaqueOnly = !text && (details.opaqueParts > 0 || (!live && !readableSettled && message.reasoning_details !== undefined));
	const opaqueNote = details.encryptedParts > 0
		? `encrypted by the provider${details.opaqueParts > 1 ? ` · ${details.opaqueParts} parts` : ''}`
		: 'recorded, not readable';
	const ref = useRef<HTMLDivElement>(null);
	const [expanded, setExpanded] = useState(false);
	const [long, setLong] = useState(false);
	useLayoutEffect(() => {
		const node = ref.current;
		if (!node) return;
		const measure = () => setLong(node.scrollHeight > 126);
		measure();
		if (typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		return () => observer.disconnect();
	}, [text]);
	if (!text && !opaqueOnly) return null;
	return (
		<section
			className={`agent-log-reasoning${opaqueOnly ? ' opaque-only' : ''}`}
			title={opaqueOnly ? 'The provider returned reasoning only as encrypted data. The exact payload is in the (i) modal.' : undefined}
		>
			<div className="agent-log-reasoning-label">
				<Icon name={opaqueOnly ? 'lock' : 'think'} size={opaqueOnly ? 12 : 13} /> {summaryOnly ? 'Reasoning summary' : 'Reasoning'}
			</div>
			{opaqueOnly ? (
				<span className="agent-log-reasoning-note">{opaqueNote}</span>
			) : (
				<>
					<div className={expanded ? '' : 'agent-log-reasoning-clamp'} ref={ref}>
						<LoopMarkdown text={text} />
					</div>
					{long && (
						<button aria-expanded={expanded} onClick={() => setExpanded(!expanded)} type="button">
							{expanded ? 'less' : 'more'}
						</button>
					)}
					{details.opaqueParts > 0 && (
						<div className="agent-log-reasoning-tail">
							<Icon name="lock" size={12} /> {details.opaqueParts} more {details.opaqueParts === 1 ? 'part is' : 'parts are'} encrypted by the provider
						</div>
					)}
				</>
			)}
		</section>
	);
}
