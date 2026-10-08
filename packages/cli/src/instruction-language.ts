import { instructionLanguagePreferenceFromChoice, newBotInstructionLanguagePreferenceFromChoice, InvalidInstructionLanguagePreferenceError, type InstructionLanguagePreference } from "@bickr/shared/instruction-language";
import type { BotSummary } from "@bickr/shared/model";
import { CliUsageError, flagString } from "./args.ts";

type Flags = Map<string, string | boolean | string[]>;
export function instructionsLanguageFlag(flags: Flags, operation: "create" | "update"): InstructionLanguagePreference | undefined {
	if (!flags.has("instructions-language")) return undefined;
	try {
		const value = flagString(flags, "instructions-language");
		return operation === "create" ? newBotInstructionLanguagePreferenceFromChoice(value) : instructionLanguagePreferenceFromChoice(value);
	} catch (error) {
		if (!(error instanceof InvalidInstructionLanguagePreferenceError)) throw error;
		const usage = new CliUsageError(error.message);
		usage.cause = error;
		throw usage;
	}
}

export function assertBotBodyMode(flags: Flags): void {
	const modes = ["body", "body-file"].filter(flag => flags.has(flag));
	if (modes.length > 1) throw new CliUsageError("Use either --body or --body-file.");
	if (modes.length && [...flags.keys()].some(flag => flag !== modes[0])) {
		throw new CliUsageError("Use a JSON body or field flags for a bot mutation. Do not combine them.");
	}
}

export function instructionsLanguageLabel(bot: Pick<BotSummary, "instructionLanguage" | "instructionLocale">): string {
	const preference = bot.instructionLanguage;
	if (!preference) return bot.instructionLocale ?? "unavailable";
	const selected = preference.kind === "fixed" ? preference.locale : preference.kind === "auto" ? "Auto" : "Source";
	return `${selected} → ${bot.instructionLocale ?? "unavailable"}`;
}
