import { readableReasoningFormat, type BotInferenceSubmissionMessage } from '@bickr/shared/model';
import { agentLogReasoningDetailKey, type AgentLogReasoningPart, type AgentLogReasoningDetail } from '@bickr/shared/model';
import { reasoningPartsForDisplay } from '@bickr/shared/reasoning-formatting';
import type { ReasoningDetail } from '../types';

type Detail = { value: ReasoningDetail; textChunks?: string[] };

/** Retains provider detail order and opaque signatures without rescanning history.
 * Text chunks are joined and Unicode-normalized only when the response settles. */
export class StreamReasoningDetails {
	private readonly details: Detail[] = [];
	private readonly readableParts: AgentLogReasoningPart[] = [];
	private readonly opaqueKeys = new Set<string>();
	private readableTextSeen = false;

	get hasReadableText(): boolean { return this.readableTextSeen; }

	appendPlain(text: string): void {
		if (!text) return;
		this.readableParts.push({ kind: 'text', text });
		this.readableTextSeen ||= text.trim().length > 0;
	}

	/** Extract once at settlement, after all adjacent runs are complete. */
	readableText(): string { return reasoningTextFromParts(this.readableParts); }

	get empty(): boolean { return this.details.length === 0; }

	append(incoming: readonly ReasoningDetail[]): void {
		for (const value of incoming) {
			const part = reasoningDetailForStream(value);
			const key = part.kind === 'opaque' ? agentLogReasoningDetailKey(part) : null;
			// Live partials also retain only the first opaque marker for each identity.
			if (key === null || !this.opaqueKeys.has(key)) this.readableParts.push(part);
			if (key !== null) this.opaqueKeys.add(key);
			if (part.kind === 'readable') this.readableTextSeen ||= part.text.trim().length > 0;
			const last = this.details[this.details.length - 1];
			if (last?.textChunks && value.type === 'reasoning.text' && typeof value.text === 'string'
				&& value.index === last.value.index && value.format === last.value.format) {
				last.textChunks.push(value.text);
			} else {
				this.details.push({
					value: { ...value },
					...(value.type === 'reasoning.text' && typeof value.text === 'string' ? { textChunks: [value.text] } : {}),
				});
			}
		}
	}

	finish(normalize: (details: readonly unknown[]) => ReasoningDetail[]): ReasoningDetail[] {
		return normalize(this.details.map(({ value, textChunks }) => textChunks ? { ...value, text: textChunks.join('') } : value));
	}
}

// This boundary permits text only for the two readable provider detail types.
export function reasoningDetailForStream(value: unknown): AgentLogReasoningDetail {
	const detail = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
	const type = typeof detail.type === 'string' ? detail.type : null;
	const identity = {
		...(typeof detail.index === 'number' && Number.isSafeInteger(detail.index) ? { index: detail.index } : {}),
		...(typeof detail.id === 'string' ? { id: detail.id } : {}),
	};
	if (type === 'reasoning.text' || type === 'reasoning.summary') {
		const value = type === 'reasoning.text' ? detail.text : detail.summary ?? detail.text;
		const text = typeof value === 'string' ? value : Array.isArray(value) ? value.map(item => {
			if (typeof item === 'string') return item;
			if (!item || typeof item !== 'object' || Array.isArray(item)) return '';
			const piece = item as Record<string, unknown>;
			return typeof piece.text === 'string' ? piece.text : typeof piece.summary === 'string' ? piece.summary : '';
		}).join('') : '';
		return { kind: 'readable', type, text, ...identity };
	}
	return { kind: 'opaque', type, ...identity };
}

/** The shared formatter applies the same mirror and separator rules. */
export function reasoningTextFromParts(parts: readonly AgentLogReasoningPart[]): string {
	// UI line normalization must not change plain text that the provider will replay.
	return reasoningPartsForDisplay(parts, text => text).text;
}

export function reasoningTextFromDetails(details: readonly unknown[]): string {
	return details.map(value => {
		const part = reasoningDetailForStream(value);
		return part.kind === 'readable' ? part.text : '';
	}).join('');
}

/** Keep display text out of provider replay and its token estimates. */
export function reasoningTextForReplay(message: Pick<BotInferenceSubmissionMessage, 'reasoning' | 'reasoning_format' | 'reasoning_details'>): string | undefined {
	return message.reasoning_format === readableReasoningFormat && (message.reasoning_details?.length || !message.reasoning?.trim())
		? undefined : message.reasoning;
}
