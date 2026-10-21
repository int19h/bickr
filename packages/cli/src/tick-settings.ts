import { botTickIntervalSecondsMax, contextWindowTokensMin, contextWindowTokensMax, type BotTickSettingsInput, type BotSummary } from "@bickr/shared/model";
import { CliUsageError, flagString } from "./args.ts";

type TickField = keyof BotTickSettingsInput;
type Field = { key: TickField; flag: string; label: string; nullable: boolean } & (
	| { kind: "boolean" }
	| { kind: "integer" | "number"; min: number; max: number }
);
const fields: readonly Field[] = [
	{ key: "enabled", flag: "tick-enabled", label: "Scheduled visits", kind: "boolean", nullable: false },
	{ key: "intervalSeconds", flag: "tick-interval-seconds", label: "Tick interval (seconds)", kind: "integer", min: 30, max: botTickIntervalSecondsMax, nullable: false },
	{ key: "allowEarlyLogOff", flag: "tick-allow-early-log-off", label: "Allow early log off", kind: "boolean", nullable: true },
	{ key: "contextWindowTokens", flag: "tick-context-window-tokens", label: "Context window tokens", kind: "integer", min: contextWindowTokensMin, max: contextWindowTokensMax, nullable: true },
	{ key: "compactionThreshold", flag: "tick-compaction-threshold", label: "Compaction threshold", kind: "number", min: 0.2, max: 0.95, nullable: false },
	{ key: "compactionSummaryPercent", flag: "tick-compaction-summary-percent", label: "Compaction summary percent", kind: "integer", min: 1, max: 50, nullable: true },
	{ key: "compactionMaxCharacters", flag: "tick-compaction-max-characters", label: "Compaction maximum characters", kind: "integer", min: 1, max: 1_000_000, nullable: true },
	{ key: "maxToolCallsPerTick", flag: "tick-max-tool-calls-per-tick", label: "Maximum tool calls per tick", kind: "integer", min: 1, max: 32, nullable: true },
	{ key: "maxSuccessfulToolCallsPerIteration", flag: "tick-max-successful-tool-calls-per-iteration", label: "Maximum successful tool calls per iteration", kind: "integer", min: 1, max: 32, nullable: true },
	{ key: "maxGeneratedTokensPerTick", flag: "tick-max-generated-tokens-per-tick", label: "Maximum generated tokens per tick", kind: "integer", min: 1, max: 1_000_000, nullable: true },
	{ key: "maxGeneratedTokensPerIteration", flag: "tick-max-generated-tokens-per-iteration", label: "Maximum generated tokens per iteration", kind: "integer", min: 1, max: 1_000_000, nullable: true },
];

export function tickSettingsFromFlags(flags: Map<string, string | boolean | string[]>): BotTickSettingsInput | undefined {
	const entries = fields.filter(field => flags.has(field.flag)).map(field => {
		const raw = flagString(flags, field.flag);
		if (raw === "null" && field.nullable) return [field.key, null];
		if (field.kind === "boolean") {
			if (raw === "true" || raw === "false") return [field.key, raw === "true"];
		} else {
			const value = Number(raw);
			if (raw?.trim() && Number.isFinite(value) && value >= field.min && value <= field.max && (field.kind === "number" || Number.isInteger(value))) return [field.key, value];
		}
		throw new CliUsageError(`Invalid --${field.flag}. Use ${field.kind === "boolean" ? "true or false" : `${field.min} through ${field.max}`}${field.nullable ? ", or null to clear the override" : ""}.`);
	});
	// Each entry comes from a known field and passes its domain above.
	return entries.length ? Object.fromEntries(entries) as BotTickSettingsInput : undefined;
}

export function tickSettingsDetails(bot: Pick<BotSummary, "tickSettings" | "effectiveTickSettings">): [string, unknown][] {
	return fields.flatMap(field => [
		[field.label, bot.tickSettings?.[field.key] ?? "default"],
		[`${field.label} (effective)`, bot.effectiveTickSettings?.[field.key] ?? "unavailable"],
	] as [string, unknown][]);
}

export const tickSettingsHelp = fields.map(field => `  --${field.flag} ${field.kind === "boolean" ? "true|false" : `${field.min}..${field.max}`}${field.nullable ? "|null" : ""}`).join("\n") + "\n  Use these flags with bots create/update. One year is 31536000 seconds (365 days).\n  Null clears an optional override. Omitted fields stay unchanged on update.";
