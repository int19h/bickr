export function reasoningDetailsTextForDisplay(details: unknown[]): string {
	return details.map(reasoningDetailTextForDisplay).join("");
}

export function reasoningDetailTextForDisplay(detail: unknown): string {
	if (typeof detail === "string") {
		return detail;
	}
	const record = recordValue(detail);
	return textValueForDisplay(record.text) ?? textValueForDisplay(record.content) ?? textValueForDisplay(record.reasoning) ?? "";
}

export function textValueForDisplay(value: unknown): string | undefined {
	if (typeof value === "string") {
		return value.length > 0 ? value : undefined;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return undefined;
}

function recordValue(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
