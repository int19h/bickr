import { describe, expect, it } from "vitest";
import { automaticInstructionLocale, instructionContentLanguage, parseInstructionLanguagePreference, resolveInstructionLocale } from "./instruction-language";
import { InstructionTemplates } from "./instruction-template";

describe("instruction languages", () => {
	it("folds baseline variants without changing authored-content tags", () => {
		for (const tag of ["en-GB", "en-x-anglish", "en-US"]) expect(automaticInstructionLocale(tag)).toBe("en");
		for (const tag of ["zh-Hans", "zh-Hant-TW", "ZH-HK"]) expect(automaticInstructionLocale(tag)).toBe("zh");
		expect(automaticInstructionLocale("ru-Latn")).toBe("ru");
		expect(instructionContentLanguage("zh")).toBe("zh-Hans");
		for (const tag of [null, undefined, "non", "ckt"]) expect(automaticInstructionLocale(tag)).toBe("en");
	});
	it("keeps Auto, fixed language, and source language distinct", () => {
		expect(resolveInstructionLocale(undefined, "ja", "fr")).toBe("ja");
		expect(resolveInstructionLocale({ kind: "auto" }, "non", "fr")).toBe("en");
		expect(resolveInstructionLocale({ kind: "source" }, "ja", "fr")).toBe("fr");
		expect(resolveInstructionLocale({ kind: "fixed", locale: "en" }, "ja", "fr")).toBe("en");
		expect(() => resolveInstructionLocale({ kind: "source" }, "ja", null)).toThrow();
	});
	it("rejects unsupported and ambiguous stored preferences at the writer boundary", () => {
		for (const input of ["ja", null, { kind: "fixed", locale: "ja-JP" }, { kind: "auto", locale: "fr" }, { kind: "source", extra: true }]) {
			expect(() => parseInstructionLanguagePreference(input)).toThrow();
		}
		expect(parseInstructionLanguagePreference({ kind: "fixed", locale: "ga" })).toEqual({ kind: "fixed", locale: "ga" });
	});
});

describe("instruction templates", () => {
	const parameters = { message: { kind: "text", parameters: ["content", "count"] }, empty: { kind: "text", parameters: [] } } as const;
	it("inserts opaque content once without interpreting its syntax", () => {
		const text = new InstructionTemplates("ja", parameters, { message: "{{count}}: {{content}} / {{count}}", empty: "" });
		expect(text.format("message", { content: "{{count}} $1 \\n", count: 3 })).toBe("3: {{count}} $1 \\n / 3");
		expect(text.format("empty")).toBe("");
	});
	it("refuses incomplete catalogs and changed parameter sets", () => {
		for (const message of ["{{content}}", "{{content}} {{wrong}}", "{{content}} {{count"]) {
			expect(() => new InstructionTemplates("ja", parameters, { message, empty: "" })).toThrow();
		}
		const extraCatalog = { message: "{{count}} {{content}}", empty: "", extra: "wrong" };
		expect(() => new InstructionTemplates("ja", parameters, extraCatalog)).toThrow();
	});
	it("uses all native Arabic count categories and keeps the exact count", () => {
		const schema = { message: { kind: "plural", parameters: ["count"], count: "count" } } as const;
		const catalog = { message: {
			zero: "zero={{count}}", one: "one={{count}}", two: "two={{count}}", few: "few={{count}}", many: "many={{count}}", other: "other={{count}}",
		} };
		const text = new InstructionTemplates("ar", schema, catalog);
		for (const [count, category] of [[0, "zero"], [1, "one"], [2, "two"], [3, "few"], [11, "many"], [100, "other"]] as const) {
			expect(text.format("message", { count })).toBe(`${category}=${count}`);
		}
		expect(() => new InstructionTemplates("ar", schema, { message: { one: "{{count}}", other: "{{count}}" } })).toThrow();
		expect(() => text.format("message", { count: Number.NaN })).toThrow();
	});
	it("does not confuse Russian one-category counts with the number one", () => {
		const schema = { message: { kind: "plural", parameters: ["count"], count: "count" } } as const;
		const catalog = { message: { one: "{{count}} запись", few: "{{count}} записи", many: "{{count}} записей", other: "{{count}} записи" } };
		const text = new InstructionTemplates("ru", schema, catalog);
		expect(text.format("message", { count: 21 })).toBe("21 запись");
		expect(text.format("message", { count: 3 })).toBe("3 записи");
		expect(() => new InstructionTemplates("ru", schema, { message: { ...catalog.message, one: "Одна запись" } })).toThrow();
	});
});
