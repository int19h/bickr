import { describe, expect, it } from "vitest";
import {
	defaultFontScalePercent,
	decreaseFontScalePercent,
	fontScaleCssValue,
	fontScaleStorageKey,
	increaseFontScalePercent,
	parseFontScalePercent,
	readFontScalePercent,
	writeFontScalePercent,
} from "./font-scale";

describe("font scale preference", () => {
	it("parses supported scale values", () => {
		expect(parseFontScalePercent("80")).toBe(80);
		expect(parseFontScalePercent("100")).toBe(100);
		expect(parseFontScalePercent(140)).toBe(140);
	});

	it("falls back to the default for missing, invalid, or stale values", () => {
		expect(parseFontScalePercent(null)).toBe(defaultFontScalePercent);
		expect(parseFontScalePercent("")).toBe(defaultFontScalePercent);
		expect(parseFontScalePercent("95")).toBe(defaultFontScalePercent);
		expect(parseFontScalePercent("160")).toBe(defaultFontScalePercent);
		expect(parseFontScalePercent("large")).toBe(defaultFontScalePercent);
	});

	it("clamps decrement and increment at supported bounds", () => {
		expect(decreaseFontScalePercent(80)).toBe(80);
		expect(decreaseFontScalePercent(100)).toBe(90);
		expect(increaseFontScalePercent(100)).toBe(110);
		expect(increaseFontScalePercent(140)).toBe(140);
	});

	it("reads and writes local storage with default fallback", () => {
		const values = new Map<string, string>();
		const storage = {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => {
				values.set(key, value);
			},
		};

		expect(readFontScalePercent(storage)).toBe(defaultFontScalePercent);
		values.set(fontScaleStorageKey, "120");
		expect(readFontScalePercent(storage)).toBe(120);

		writeFontScalePercent(storage, 130);
		expect(values.get(fontScaleStorageKey)).toBe("130");
	});

	it("formats values for the CSS scale variable", () => {
		expect(fontScaleCssValue(80)).toBe("0.8");
		expect(fontScaleCssValue(100)).toBe("1");
		expect(fontScaleCssValue(140)).toBe("1.4");
	});
});
