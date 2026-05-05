export function reasoningDetailsTextForDisplay(details: unknown[]): string {
	return normalizeReadableText(details.map(reasoningDetailTextForDisplay).join(""));
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
		return value.length > 0 ? normalizeReadableText(value) : undefined;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return undefined;
}

export function normalizeReadableText(text: string): string {
	const normalized = text.replace(/\r\n?/g, "\n");
	return normalized
		.split(/(\n{2,})/)
		.map((part) => part.startsWith("\n") ? part : collapseTinyLineRun(part))
		.join("");
}

function collapseTinyLineRun(text: string): string {
	const lines = text.split("\n");
	const meaningful = lines.filter((line) => line.trim().length > 0);
	if (meaningful.length < 6) {
		return text;
	}
	const lengths = meaningful.map((line) => Array.from(line.trim()).length);
	const shortCount = lengths.filter((length) => length <= 6).length;
	const veryShortCount = lengths.filter((length) => length <= 3).length;
	const averageLength = lengths.reduce((total, length) => total + length, 0) / lengths.length;
	const mostlyTiny =
		shortCount / lengths.length >= 0.75 &&
		veryShortCount >= 4 &&
		averageLength <= 6;
	const heavilyFragmented =
		meaningful.length >= 10 &&
		shortCount / lengths.length >= 0.6 &&
		averageLength <= 8;
	return mostlyTiny || heavilyFragmented ? lines.join("") : text;
}

function recordValue(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
