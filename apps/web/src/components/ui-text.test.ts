import { describe, expect, it } from "vitest";
import enUiText from "./locales/en";
import esUiText from "./locales/es";
import { loadUiTextLocale, uiTextForLocale } from "./ui-text";

describe("lazy UI text", () => {
	it("renders English until the active locale has loaded", () => {
		expect(uiTextForLocale("es", { locale: "en", text: enUiText })).toBe(enUiText);
		expect(uiTextForLocale("es", { locale: "es", text: esUiText })).toBe(esUiText);
	});

	it("returns to English instead of showing a stale locale during a swap", () => {
		expect(uiTextForLocale("ja", { locale: "es", text: esUiText })).toBe(enUiText);
	});

	it.each([
		["en", "All worlds"],
		["es", "Todos los mundos"],
		["zh-Hans", "全部世界"],
		["ja", "すべてのワールド"],
		["ru", "Все миры"],
		["uk", "Усі світи"],
		["eo", "Ĉiuj mondoj"],
	] as const)("loads the %s locale from its module", async (locale, allWorlds) => {
		const text = await loadUiTextLocale(locale);
		expect(text.nav.allWorlds).toBe(allWorlds);
	});
});
