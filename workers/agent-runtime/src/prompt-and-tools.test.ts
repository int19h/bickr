import { describe, expect, it } from "vitest";
import type { BotDocument } from "@bickr/shared/model";
import {
	bickrFunctionToolArgumentExamples,
	openRouterServerToolSelection,
	providerAvatarDescriptionToolDefinitions,
	providerTranslationToolDefinitions,
	standardPrompt,
	toolDefinitionsForProviderRound,
	type FunctionToolDefinition,
} from "./prompt-and-tools";

const examplePrefix = "\n\nExample arguments: ";

describe("Bickr function tools", () => {
	it("emits one complete parseable top-level argument example for every function tool", () => {
		const definitions = allFunctionToolDefinitions();
		expect(definitions.map((definition) => definition.function.name).sort()).toEqual(
			Object.keys(bickrFunctionToolArgumentExamples).sort(),
		);

		for (const definition of definitions) {
			const separator = definition.function.description.lastIndexOf(examplePrefix);
			expect(separator, definition.function.name).toBeGreaterThanOrEqual(0);
			const serialized = definition.function.description.slice(separator + examplePrefix.length);
			const example = JSON.parse(serialized) as unknown;
			expect(example, definition.function.name).toEqual(
				bickrFunctionToolArgumentExamples[definition.function.name],
			);
			expectSchemaValue(example, definition.function.parameters, definition.function.name);
		}
	});

	it("keeps native OpenRouter server tools native", () => {
		const selection = openRouterServerToolSelection("https://openrouter.ai/api/v1", {
			openRouter: { datetime: { enabled: true, timezone: "UTC" } },
		});

		expect(selection.tools).toEqual([
			{ type: "openrouter:datetime", parameters: { timezone: "UTC" } },
		]);
	});
});

describe("standard system prompt", () => {
	it("requires valid JSON objects with quoted and escaped string literals", () => {
		const participant = promptParticipant();
		const prompt = standardPrompt(participant);

		expect(prompt).toContain("Arguments for every Bickr control must be a valid JSON object.");
		expect(prompt).toContain("Every string literal, including authored prose, must be properly quoted and escaped.");
	});

	it("defines the composite self-author label without treating it as a handle argument", () => {
		const prompt = standardPrompt(promptParticipant());

		expect(prompt).toContain("Your Bickr handle is u/foo\n\nIn structured Bickr Terminal results, the author label u/foo (MYSELF) identifies content you wrote.");
		expect(prompt).toContain("When a Bickr control argument requests a participant handle or username, use only u/foo, without the (MYSELF) annotation.");
		expect(prompt.match(/author label u\/foo \(MYSELF\)/g)).toHaveLength(1);
	});
});

function promptParticipant(): BotDocument {
	return {
		id: "bot_prompt_test",
		type: "bot",
		schemaVersion: 1,
		revision: 1,
		createdAt: "2026-08-02T00:00:00.000Z",
		updatedAt: "2026-08-02T00:00:00.000Z",
		homeWorldId: "wld_test",
		homeWorldHandle: "test-world",
		ownerUserId: "usr_test",
		handle: "foo",
		language: null,
		includeLanguageInSystemPrompt: false,
		displayName: { lang: null, text: "Foo" },
		shortBio: { lang: null, text: "Short bio" },
		prompt: { lang: null, text: "Persona" },
		inferenceSettings: {},
		toolSettings: {},
		tickSettings: {
			enabled: true,
			intervalSeconds: 60,
			allowEarlyLogOff: true,
			compactionThreshold: 0.75,
		},
	};
}

function allFunctionToolDefinitions(): FunctionToolDefinition[] {
	return [
		...toolDefinitionsForProviderRound(),
		...providerTranslationToolDefinitions(),
		...providerAvatarDescriptionToolDefinitions(),
	];
}

function expectSchemaValue(value: unknown, schema: Record<string, unknown>, path: string): void {
	const type = schema.type;
	if (type === "object") {
		expect(value !== null && typeof value === "object" && !Array.isArray(value), path).toBe(true);
		const record = value as Record<string, unknown>;
		for (const required of Array.isArray(schema.required) ? schema.required : []) {
			expect(Object.hasOwn(record, String(required)), `${path}.${String(required)}`).toBe(true);
		}
		const properties = schema.properties;
		if (properties && typeof properties === "object" && !Array.isArray(properties)) {
			for (const [key, propertySchema] of Object.entries(properties)) {
				if (Object.hasOwn(record, key) && propertySchema && typeof propertySchema === "object" && !Array.isArray(propertySchema)) {
					expectSchemaValue(record[key], propertySchema as Record<string, unknown>, `${path}.${key}`);
				}
			}
		}
		return;
	}
	if (type === "array") {
		expect(Array.isArray(value), path).toBe(true);
		const items = schema.items;
		if (items && typeof items === "object" && !Array.isArray(items)) {
			for (const [index, item] of (value as unknown[]).entries()) {
				expectSchemaValue(item, items as Record<string, unknown>, `${path}[${index}]`);
			}
		}
		return;
	}
	if (type === "string") {
		expect(typeof value, path).toBe("string");
		return;
	}
	if (type === "number" || type === "integer") {
		expect(typeof value, path).toBe("number");
		if (type === "integer") {
			expect(Number.isInteger(value), path).toBe(true);
		}
		return;
	}
	if (type === "boolean") {
		expect(typeof value, path).toBe("boolean");
	}
}
