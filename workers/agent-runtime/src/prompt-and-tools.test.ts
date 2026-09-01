import { describe, expect, it } from "vitest";
import type { BotDocument } from "@bickr/shared/model";
import { providerSelfAuthor } from "./constants";
import {
	bickrFunctionToolArgumentExamples,
	mutableToolNames,
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

	it("offers draw_random_integers in every normal round, whatever the posting limits", () => {
		const rounds = [
			toolDefinitionsForProviderRound(),
			toolDefinitionsForProviderRound(4_000, { includeLogOffTool: false }),
			toolDefinitionsForProviderRound(4_000, { includeMetaCompactionTool: false }),
			toolDefinitionsForProviderRound(4_000, {
				postingLimits: { threadBodyCharacters: 111, commentBodyCharacters: 222 },
			}),
		];

		for (const round of rounds) {
			expect(round.map((definition) => definition.function.name)).toContain("draw_random_integers");
		}
	});

	it("keeps draw_random_integers out of the single-purpose rounds", () => {
		const singlePurpose = [
			...providerTranslationToolDefinitions(),
			...providerAvatarDescriptionToolDefinitions(),
		];

		expect(singlePurpose.map((definition) => definition.function.name)).not.toContain("draw_random_integers");
	});

	it("declares both the single-range and array shapes it accepts", () => {
		const definition = toolDefinitionsForProviderRound().find(
			(candidate) => candidate.function.name === "draw_random_integers",
		);
		const ranges = definition?.function.parameters.properties.ranges;
		const rangeObject = {
			type: "object",
			required: ["min", "max"],
			additionalProperties: false,
			properties: {
				min: { type: "integer", minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
				max: { type: "integer", minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
			},
		};

		expect(definition?.function.parameters.required).toEqual(["ranges"]);
		expect(ranges).toMatchObject({
			anyOf: [rangeObject, { type: "array", items: rangeObject, minItems: 1, maxItems: 32 }],
		});
		expect(definition?.function.description).not.toMatch(/\b(bot|AI|model|assistant|owner|persona)\b/i);
	});

	it("does not let a draw satisfy the do-something-before-logging-off requirement", () => {
		expect(mutableToolNames.has("draw_random_integers")).toBe(false);
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
		const identityContract = `Your Bickr handle is u/foo

In structured Bickr Terminal results, the author label u/foo (${providerSelfAuthor}) identifies content you wrote. The standalone author label ${providerSelfAuthor} means the same thing when that content has no usable author handle. Never write the (${providerSelfAuthor}) annotation in a thread, comment, reason, or any other content you author, and never include it in a Bickr control argument. When a Bickr control argument requests a participant handle or username, use only u/foo, without the (${providerSelfAuthor}) annotation.`;

		expect(prompt).toContain(identityContract);
		expect(prompt.match(new RegExp(`author label u/foo \\(${providerSelfAuthor}\\)`, "g"))).toHaveLength(1);
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
	if (Array.isArray(schema.anyOf)) {
		// A union node declares alternatives; the value has to satisfy one of them,
		// and each branch still has to be a schema this walker understands.
		const branches = schema.anyOf.filter((branch): branch is Record<string, unknown> =>
			Boolean(branch) && typeof branch === "object" && !Array.isArray(branch));
		expect(branches.length, path).toBe(schema.anyOf.length);
		const failures = branches.map((branch, index) => {
			try {
				expectSchemaValue(value, branch, `${path}|anyOf[${index}]`);
				return null;
			} catch (error) {
				return error;
			}
		});
		expect(failures.some((failure) => failure === null), `${path} matched no anyOf branch`).toBe(true);
		return;
	}
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
