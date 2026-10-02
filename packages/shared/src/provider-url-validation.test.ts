import { describe, expect, it } from "vitest";
import { parseUpdateBotInput } from "./validation";

describe("stored provider URL validation", () => {
	it.each(["http://provider.example/v1", "https://user:secret@example.com/v1", "not a url"])("rejects unsafe provider configuration %s", (baseUrl) => {
		expect(() => parseUpdateBotInput({ inferenceSettings: { baseUrl } })).toThrow();
	});
	it.each(["https://provider.example/v1/", "http://localhost:8080/v1"])("preserves a permitted provider URL %s", (baseUrl) => {
		expect(parseUpdateBotInput({ inferenceSettings: { baseUrl } }).inferenceSettings?.baseUrl).toBe(baseUrl);
	});
});
