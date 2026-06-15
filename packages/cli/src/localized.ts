import {
	localizedText,
	type LanguageTag,
	type LocalizedText,
} from "@bickr/shared/model";
import { CliUsageError, flagString } from "./args.ts";

export function languageFlag(flags: Map<string, string | boolean | string[]>): LanguageTag | undefined {
	const language = optionalLanguageFlag(flags, "language");
	const lang = optionalLanguageFlag(flags, "lang");
	if (language !== undefined && lang !== undefined && language !== lang) {
		throw new CliUsageError("--language and --lang must match when both are provided.");
	}
	return language ?? lang;
}

export function requiredLanguageFlag(flags: Map<string, string | boolean | string[]>, operation: string): LanguageTag {
	const language = languageFlag(flags);
	if (language === undefined) {
		throw new CliUsageError(`${operation} requires --language LANG or --lang LANG.`);
	}
	return language;
}

export function localizedInput(text: string, language: LanguageTag | null): LocalizedText {
	return localizedText(text, language);
}

export function optionalLocalizedInput(
	text: string | undefined,
	language: LanguageTag | null | undefined,
	label: string,
): LocalizedText | undefined {
	if (text === undefined) {
		return undefined;
	}
	if (language === undefined) {
		throw new CliUsageError(`${label} requires --language LANG or --lang LANG.`);
	}
	return localizedInput(text, language);
}

export function languageForTextUpdate(
	explicitLanguage: LanguageTag | undefined,
	currentLanguage: LanguageTag | null,
	hasTextUpdate: boolean,
): LanguageTag | null | undefined {
	return explicitLanguage ?? (hasTextUpdate ? currentLanguage : undefined);
}

export function localizedValueText(value: unknown): string | undefined {
	if (typeof value === "string") {
		return value;
	}
	if (isLocalizedObject(value)) {
		return value.text;
	}
	return undefined;
}

export function localizedValueLang(value: unknown): LanguageTag | null | undefined {
	if (!isLocalizedObject(value)) {
		return undefined;
	}
	return typeof value.lang === "string" && value.lang.trim() ? value.lang as LanguageTag : null;
}

export function localizedValueSingleLine(value: unknown): string | undefined {
	const text = localizedValueText(value);
	return text === undefined ? undefined : text.replace(/\s+/g, " ").trim();
}

export function languageLabel(language: LanguageTag | null | undefined): string {
	return language ?? "";
}

export function flagPresent(flags: Map<string, string | boolean | string[]>, name: string): boolean {
	return flags.has(name);
}

export function anyFlagPresent(flags: Map<string, string | boolean | string[]>, names: string[]): boolean {
	return names.some((name) => flagPresent(flags, name));
}

function optionalLanguageFlag(flags: Map<string, string | boolean | string[]>, name: "language" | "lang"): LanguageTag | undefined {
	const value = flagString(flags, name);
	if (value === undefined) {
		return undefined;
	}
	const trimmed = value.trim();
	if (!trimmed) {
		throw new CliUsageError(`--${name} must not be empty.`);
	}
	return trimmed as LanguageTag;
}

function isLocalizedObject(value: unknown): value is { lang?: unknown; text: string } {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value) && typeof (value as { text?: unknown }).text === "string";
}
