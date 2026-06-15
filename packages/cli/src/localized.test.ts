import { describe, expect, it } from "vitest";
import { type LanguageTag } from "@bickr/shared/model";
import { CliUsageError, parseCommandOptions } from "./args.ts";
import {
	languageFlag,
	languageForTextUpdate,
	localizedInput,
	localizedValueLang,
	localizedValueSingleLine,
	optionalLocalizedInput,
	requiredLanguageFlag,
} from "./localized.ts";

describe("CLI localized text helpers", () => {
	it("parses canonical language and lang alias flags", () => {
		const language = parseCommandOptions(["--language", "ja"]).flags;
		expect(languageFlag(language)).toBe("ja");

		const lang = parseCommandOptions(["--lang", "uk"]).flags;
		expect(languageFlag(lang)).toBe("uk");

		const both = parseCommandOptions(["--language", "eo", "--lang", "eo"]).flags;
		expect(languageFlag(both)).toBe("eo");
	});

	it("rejects conflicting language aliases", () => {
		const flags = parseCommandOptions(["--language", "ja", "--lang", "ko"]).flags;
		expect(() => languageFlag(flags)).toThrow(CliUsageError);
	});

	it("requires language for convenience create payloads", () => {
		const flags = parseCommandOptions(["--name", "No language"]).flags;
		expect(() => requiredLanguageFlag(flags, "World creation")).toThrow("World creation requires --language LANG or --lang LANG.");
	});

	it("builds localized payload objects with lang before text", () => {
		expect(Object.keys(localizedInput("将軍家", "ja" as LanguageTag))).toEqual(["lang", "text"]);
		expect(localizedInput("将軍家", "ja" as LanguageTag)).toEqual({ lang: "ja", text: "将軍家" });
		expect(optionalLocalizedInput("hello", "en" as LanguageTag, "Greeting")).toEqual({ lang: "en", text: "hello" });
	});

	it("infers update text language from the current entity only for text updates", () => {
		expect(languageForTextUpdate(undefined, "ar" as LanguageTag, true)).toBe("ar");
		expect(languageForTextUpdate("uk" as LanguageTag, "ar" as LanguageTag, true)).toBe("uk");
		expect(languageForTextUpdate(undefined, "ar" as LanguageTag, false)).toBeUndefined();
		expect(languageForTextUpdate(undefined, null, true)).toBeNull();
	});

	it("renders localized values as text and exposes their language", () => {
		expect(localizedValueSingleLine({ lang: "uk", text: " Перший\nрядок " })).toBe("Перший рядок");
		expect(localizedValueLang({ lang: "uk", text: "Текст" })).toBe("uk");
		expect(localizedValueLang("plain string")).toBeUndefined();
	});
});
