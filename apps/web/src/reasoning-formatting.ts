export function reasoningDetailsTextForDisplay(details: unknown[]): string {
	return details.map(reasoningDetailTextForDisplay).join("");
}

export function reasoningDetailTextForDisplay(detail: unknown): string {
	if (typeof detail === "string") {
		return detail;
	}
	const record = recordValue(detail);
	return firstString(record.text, record.content, record.reasoning) ?? "";
}

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string") {
			return value;
		}
	}
	return undefined;
}

function recordValue(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
