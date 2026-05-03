import type { BotInferenceSubmission, BotInferenceSubmissionMessage } from "@bickr/shared/model";

export function normalizeSubmissionSearchText(value: string): string {
	return value
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase();
}

export function submissionMessageSearchText(message: BotInferenceSubmissionMessage): string {
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
	return submission.messages.some((message) => submissionMessageMatchesSearch(message, query));
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

function formatJson(value: unknown): string {
	return JSON.stringify(value, null, 2);
}
