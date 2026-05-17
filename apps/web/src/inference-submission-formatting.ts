import type { BotInferenceSubmission, BotInferenceSubmissionMessage, BotRuntimeEvent } from "@bickr/shared/model";

function normalizeSubmissionSearchText(value: string): string {
	return value
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase();
}

function submissionMessageSearchText(message: BotInferenceSubmissionMessage): string {
	const parts = [
		message.role,
		message.content ?? "",
		message.tool_call_id ?? "",
		message.reasoning ?? "",
		message.reasoning_content ?? "",
		...(message.reasoning_details ? [formatJson(message.reasoning_details)] : []),
		...(message.tool_calls ?? []).flatMap((toolCall) => [
			toolCall.id,
			toolCall.function.name,
			prettyJsonText(toolCall.function.arguments),
		]),
	];
	return parts.filter(Boolean).join("\n");
}

export function submissionMessageMatchesSearch(message: BotInferenceSubmissionMessage, query: string): boolean {
	const normalizedQuery = normalizeSubmissionSearchText(query.trim());
	if (!normalizedQuery) {
		return true;
	}
	return normalizeSubmissionSearchText(submissionMessageSearchText(message)).includes(normalizedQuery);
}

export function submissionMatchesSearch(submission: BotInferenceSubmission, query: string): boolean {
	const normalizedQuery = normalizeSubmissionSearchText(query.trim());
	if (!normalizedQuery) {
		return true;
	}
	const metadata = [
		submission.purpose,
		submission.model,
		submission.providerBaseUrl,
		submission.runId,
		String(submission.seq),
	].join("\n");
	if (normalizeSubmissionSearchText(metadata).includes(normalizedQuery)) {
		return true;
	}
	return inferenceSubmissionChatMessages(submission).some((message) => submissionMessageMatchesSearch(message, query));
}

export function inferenceSubmissionChatMessages(submission: BotInferenceSubmission): BotInferenceSubmissionMessage[] {
	return submission.displayMessages && submission.displayMessages.length > 0 ? submission.displayMessages : submission.messages;
}

export function prettyJsonText(value: unknown): string {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed) {
			return "";
		}
		try {
			return formatJson(JSON.parse(trimmed) as unknown);
		} catch {
			return value;
		}
	}
	return formatJson(value);
}

export function inferenceSubmissionSeqsByRuntimeEventSeq(
	events: readonly BotRuntimeEvent[],
	retainedSubmissionSeqs: ReadonlySet<number>,
): Map<number, number> {
	const sortedEvents = [...events]
		.filter((event) => Number.isFinite(event.seq))
		.sort((left, right) => left.seq - right.seq);
	const mappedSeqs = new Map<number, number>();
	const retainedLoopRequestSeqsByRun = new Map<string, number[]>();

	for (const event of sortedEvents) {
		if (!retainedSubmissionSeqs.has(event.seq)) {
			continue;
		}
		mappedSeqs.set(event.seq, event.seq);
		if (event.type === "provider_request") {
			const runSeqs = retainedLoopRequestSeqsByRun.get(event.runId) ?? [];
			runSeqs.push(event.seq);
			retainedLoopRequestSeqsByRun.set(event.runId, runSeqs);
		}
	}

	for (const event of sortedEvents) {
		if (mappedSeqs.has(event.seq)) {
			continue;
		}
		const requestSeqs = retainedLoopRequestSeqsByRun.get(event.runId);
		if (!requestSeqs || requestSeqs.length === 0) {
			continue;
		}
		if (isInferenceResponseEvent(event)) {
			const requestSeq = previousSeq(requestSeqs, event.seq);
			if (requestSeq !== null) {
				mappedSeqs.set(event.seq, requestSeq);
			}
			continue;
		}
		if (event.type === "tool_result") {
			const requestSeq = nextSeq(requestSeqs, event.seq);
			if (requestSeq !== null) {
				mappedSeqs.set(event.seq, requestSeq);
			}
		}
	}

	return mappedSeqs;
}

function formatJson(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

function isInferenceResponseEvent(event: BotRuntimeEvent): boolean {
	return (
		event.type === "provider_delta" ||
		event.type === "reasoning_message" ||
		event.type === "assistant_message" ||
		event.type === "tool_call"
	);
}

function previousSeq(seqs: readonly number[], before: number): number | null {
	for (let index = seqs.length - 1; index >= 0; index -= 1) {
		const seq = seqs[index]!;
		if (seq < before) {
			return seq;
		}
	}
	return null;
}

function nextSeq(seqs: readonly number[], after: number): number | null {
	for (const seq of seqs) {
		if (seq > after) {
			return seq;
		}
	}
	return null;
}
