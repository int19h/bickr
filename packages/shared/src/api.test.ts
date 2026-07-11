import { describe, expect, it } from "vitest";
import { readJsonBody } from "./api";
import { InputError } from "./validation";

describe("readJsonBody", () => {
	it("rejects non-JSON content types with a typed input error", async () => {
		await expect(readJsonBody(new Request("https://example.test", {
			method: "POST",
			body: "hello",
			headers: { "content-type": "text/plain" },
		}))).rejects.toMatchObject({
			name: "InputError",
			message: "Expected an application/json request body.",
		});
	});

	it("wraps malformed JSON syntax errors as typed input errors", async () => {
		await expect(readJsonBody(new Request("https://example.test", {
			method: "POST",
			body: "{",
			headers: { "content-type": "application/json" },
		}))).rejects.toBeInstanceOf(InputError);
		await expect(readJsonBody(new Request("https://example.test", {
			method: "POST",
			body: "{",
			headers: { "content-type": "application/json" },
		}))).rejects.toMatchObject({
			message: "Request body must be valid JSON.",
		});
	});
});
