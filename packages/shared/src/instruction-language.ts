import type { LanguageTag } from './model';

/** Baseline languages for generated Bickr instructions. These are not speaking-language tags. */
export const instructionLocales = [
	"en", "ru", "ja", "ar", "ko", "zh", "eo", "fr", "de", "pt", "it", "da", "uk", "be", "id", "tr", "hi", "vi", "ga",
] as const;

export type InstructionLocale = typeof instructionLocales[number];

export type InstructionLanguagePreference =
	| { kind: "auto" }
	| { kind: "fixed"; locale: InstructionLocale }
	| { kind: "source" };

/** Use this default only for creation. Stored omissions retain legacy Auto behavior. */
export function defaultNewBotInstructionLanguage(): { kind: "fixed"; locale: "en" } {
	return { kind: "fixed", locale: "en" };
}

export const instructionLanguageNames: Readonly<Record<InstructionLocale, string>> = {
	en: "English", ru: "Русский", ja: "日本語", ar: "العربية", ko: "한국어", zh: "中文", eo: "Esperanto",
	fr: "Français", de: "Deutsch", pt: "Português", it: "Italiano", da: "Dansk", uk: "Українська", be: "Беларуская",
	id: "Bahasa Indonesia", tr: "Türkçe", hi: "हिन्दी", vi: "Tiếng Việt", ga: "Gaeilge",
};

export function isInstructionLocale(value: unknown): value is InstructionLocale {
	return typeof value === "string" && (instructionLocales as readonly string[]).includes(value);
}

/** Script, region, and style variants use their baseline catalog. An unset or unsupported language uses English. */
export function automaticInstructionLocale(language: string | null | undefined): InstructionLocale {
	const baseline = language?.split("-")[0]?.toLowerCase();
	return isInstructionLocale(baseline) ? baseline : "en";
}

/** The Chinese catalog uses Simplified Chinese, independent of the participant's authored-content language. */
export function instructionContentLanguage(locale: InstructionLocale): LanguageTag {
	// Every catalog locale is a fixed valid BCP 47 tag. Chinese uses one known script.
	return (locale === "zh" ? "zh-Hans" : locale) as LanguageTag;
}

export class InvalidInstructionLanguagePreferenceError extends Error {
	constructor(message: string) { super(message); this.name = "InvalidInstructionLanguagePreferenceError"; }
}

/** Omission is a valid Auto preference. It does not request inheritance from a clone source. */
export function resolveInstructionLocale(
	preference: InstructionLanguagePreference | undefined,
	primaryLanguage: string | null | undefined,
	sourceLocale: InstructionLocale | null,
): InstructionLocale {
	if (!preference) return automaticInstructionLocale(primaryLanguage);
	switch (preference.kind) {
		case "auto": return automaticInstructionLocale(primaryLanguage);
		case "fixed": {
			if (!isInstructionLocale(preference.locale)) throw new InvalidInstructionLanguagePreferenceError("Unsupported instructions language.");
			return preference.locale;
		}
		case "source": {
			if (sourceLocale === null) {
				throw new InvalidInstructionLanguagePreferenceError("Instructions can inherit a source language only for a linked clone.");
			}
			return sourceLocale;
		}
		default: throw new InvalidInstructionLanguagePreferenceError("Invalid instructions language preference.");
	}
}

export function parseInstructionLanguagePreference(value: unknown): InstructionLanguagePreference {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new InvalidInstructionLanguagePreferenceError("Instructions language must be an object.");
	}
	const input = value as Record<string, unknown>;
	const keys = Object.keys(input);
	if ((input.kind === "auto" || input.kind === "source") && keys.length === 1) return { kind: input.kind };
	if (input.kind === "fixed" && keys.length === 2 && isInstructionLocale(input.locale)) return { kind: "fixed", locale: input.locale };
	throw new InvalidInstructionLanguagePreferenceError("Instructions language must be Auto, a supported language, or Inherit source.");
}
