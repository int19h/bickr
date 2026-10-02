import { type ApiEnvelope } from "./client.ts";
import { localizedValueSingleLine } from "./localized.ts";

export type OutputContext = {
	human: boolean;
	json: boolean;
	raw: boolean;
};

export function outputContext(input: { format?: string; json: boolean; raw: boolean; stdoutIsTty: boolean }): OutputContext {
	const human = !input.json && !input.raw && (input.format === "human" || (!input.format && input.stdoutIsTty));
	return {
		human,
		json: input.json || !human,
		raw: input.raw,
	};
}

export function printEnvelope<T>(ctx: OutputContext, envelope: ApiEnvelope<T>, renderHuman: (data: T) => string): void {
	if (ctx.raw) {
		printJson(envelope);
		return;
	}
	if (!envelope.ok) {
		throw new Error(envelope.message);
	}
	if (ctx.human) {
		writeTerminal(`${renderHuman(envelope.data)}\n`);
	} else {
		printJson(envelope.data);
	}
}

export function printValue(ctx: OutputContext, value: unknown, renderHuman: () => string): void {
	if (ctx.human) {
		writeTerminal(`${renderHuman()}\n`);
	} else {
		printJson(value);
	}
}

export function printJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function table<T>(rows: T[], columns: { key: string; header: string; value: (row: T) => unknown }[]): string {
	if (rows.length === 0) {
		return "No results.";
	}
	const rendered = rows.map((row) => columns.map((column) => singleLine(column.value(row))));
	const widths = columns.map((column, index) =>
		Math.min(
			80,
			Math.max(column.header.length, ...rendered.map((row) => row[index]?.length ?? 0)),
		));
	const header = columns.map((column, index) => pad(column.header, widths[index] ?? column.header.length)).join("  ");
	const divider = widths.map((width) => "-".repeat(width)).join("  ");
	const body = rendered
		.map((row) => row.map((cell, index) => pad(truncate(cell, widths[index] ?? 80), widths[index] ?? 80)).join("  "))
		.join("\n");
	return `${header}\n${divider}\n${body}`;
}

export function detail(rows: [string, unknown][]): string {
	return rows
		.filter(([, value]) => value !== undefined && value !== null && value !== "")
		.map(([label, value]) => `${label}: ${singleLine(value)}`)
		.join("\n") || "No data.";
}

function singleLine(value: unknown): string {
	if (value === undefined || value === null) {
		return "";
	}
	const localized = localizedValueSingleLine(value);
	if (localized !== undefined) {
		return terminalText(localized);
	}
	if (typeof value === "object") {
		return JSON.stringify(value);
	}
	return terminalText(String(value)).replace(/\s+/g, " ").trim();
}

function truncate(value: string, width: number): string {
	return value.length <= width ? value : `${value.slice(0, Math.max(0, width - 3))}...`;
}

function pad(value: string, width: number): string {
	return `${value}${" ".repeat(Math.max(0, width - value.length))}`;
}

/** Keep formatter line breaks and tabs; show terminal commands as literal escapes. */
export function terminalText(value: string): string {
	return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
		(character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function writeTerminal(value: string, stream: Pick<NodeJS.WriteStream, "write"> = process.stdout): void {
	stream.write(terminalText(value));
}
