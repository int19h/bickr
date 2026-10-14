import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotDocument, WorldDocument } from '@bickr/shared/model';
import { botText } from '../localization';
import { createAvatarProvider, type AvatarProviderRuntime } from './provider';
import { providerAvatarImageStreamChunk } from "../runtime/bot-runtime";
import { providerAvatarRequestedToolCalls, providerAvatarToolChoice } from "./provider";

describe('avatar request affinity', () => {
	afterEach(() => vi.unstubAllGlobals());
	const text = botText('en');
	const entity = { schemaVersion: 1, revision: 1, createdAt: '2026-10-14', updatedAt: '2026-10-14' };
	const bot: BotDocument = { ...entity, id: 'bot-avatar', type: 'bot', homeWorldId: 'world-avatar', homeWorldHandle: 'test', ownerUserId: 'user-avatar',
		handle: 'avatar-test', language: 'en', includeLanguageInSystemPrompt: false, displayName: { lang: 'en', text: 'Avatar Test' },
		shortBio: { lang: 'en', text: 'Test participant.' }, prompt: { lang: 'en', text: 'Test persona.' }, inferenceSettings: {}, toolSettings: {}, tickSettings: {} };
	const world: WorldDocument = { ...entity, id: 'world-avatar', type: 'world', handle: 'test', language: 'en', name: { lang: 'en', text: 'Test' },
		description: { lang: 'en', text: 'A test world.' }, prompt: { lang: 'en', text: '' }, recurringPromptEnabled: false,
		recurringPrompt: { lang: 'en', text: '' }, initialBotNotification: { lang: 'en', text: '' }, createdByUserId: 'user-avatar', visibility: 'public' };

	it('covers every avatar POST and uses a header for the image endpoint', async () => {
		// Catalog discovery can fail without preventing the request under test.
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('catalog unavailable')));
		const captured: { endpoint: string; init: RequestInit }[] = [];
		const runtime: AvatarProviderRuntime = {
			chatCompletionsUrl: url => `${url}/chat/completions`, imagesUrl: url => `${url}/images`,
			fetchWithHeaderTimeout: async (endpoint, init) => { captured.push({ endpoint, init }); throw new Error('captured request'); },
			readProviderErrorBody: async () => '', requestErrorFromBody: () => new Error(), readJsonResponseText: async () => '',
			responseBodyTimeoutError: () => new Error(), requestError: () => new Error(),
			isResponseBodySizeLimitError: () => false, isRequestError: (error): error is never => false,
			isStructuredOutputValidationError: (error): error is never => false, sanitizeMessages: messages => [...messages],
			reasoningForSettings: () => undefined, structuredOutputReasoningForSettings: () => undefined,
			readSse: async function* () {}, streamErrorFromChunk: () => null, usageFromValue: () => undefined,
			metadataProviderName: () => null, singleStringResponseFromMessage: () => '', isStoppedError: () => false,
		};
		const provider = createAvatarProvider(runtime);
		const settings = { text, baseUrl: 'https://openrouter.ai/api/v1', model: 'meta/muse-spark-1.3', temperature: 0.2 };
		for (const operation of [
			() => provider.describeParticipant(settings, bot),
			() => provider.describeWorld(settings, world),
			() => provider.describeWorldMembers(settings, world, { kind: 'all', members: [] }),
			() => provider.describeCurrentAvatar(settings, 'https://example.com/avatar.png'),
			() => provider.generateImage(settings, { prompt: 'Synthetic test image.' }),
		]) {
			await expect(operation()).rejects.toThrow('captured request');
		}
		expect(captured).toHaveLength(5);
		for (const { endpoint, init } of captured) {
			const body = JSON.parse(String(init.body));
			if (endpoint.endsWith('/images')) {
				expect(new Headers(init.headers).get('x-session-id')).toMatch(/^bickr:avatar-image:/);
				expect(body).not.toHaveProperty('session_id');
			} else {
				expect(body.session_id).toBeTruthy();
				expect(body.prompt_cache_key).toBe(body.session_id);
				expect(body.prompt_cache_retention).toBe('24h');
			}
		}
		expect(JSON.parse(String(captured[0]!.init.body)).session_id).toBe('bot:bot-avatar');
		expect(JSON.parse(String(captured[1]!.init.body)).session_id).toBe('world:world-avatar');
		expect(JSON.parse(String(captured[2]!.init.body)).session_id).toBe('world:world-avatar');
	});
});

describe("provider avatar tool policy", () => {
	it("covers every stored request strategy without losing provider omission intent", () => {
		const settings = { baseUrl: "https://provider.example/v1", model: "provider/model" };
		expect(providerAvatarRequestedToolCalls(
			{ ...settings, toolCallRequest: { kind: "provider_default" } }, "reasoning_on",
		)).toBe("railroad");
		expect(providerAvatarRequestedToolCalls(
			{ ...settings, toolCallRequest: { kind: "inherit" } }, "reasoning_on",
		)).toBe("require");
		expect(providerAvatarRequestedToolCalls(
			{ ...settings, toolCallRequest: { kind: "bickr_automatic" } }, "reasoning_on",
		)).toBe("require");
		for (const [strategy, expected] of [
			["require", "require"],
			["railroad", "railroad"],
			["at_will", "require"],
		] as const) {
			expect(providerAvatarRequestedToolCalls(
				{ ...settings, toolCallRequest: { kind: "strategy", strategy } }, "reasoning_on",
			)).toBe(expected);
		}
	});

	it("resolves avatar automatic tool policy from the avatar reasoning shape", () => {
		const settings = {
			baseUrl: "https://openrouter.ai/api/v1",
			model: "deepseek/deepseek-v3.2",
			providerRouting: { only: ["atlas-cloud/fp8"], allow_fallbacks: false },
			toolCallRequest: { kind: "bickr_automatic" as const },
		};

		expect(providerAvatarRequestedToolCalls(settings, "reasoning_off")).toBe("require");
		expect(providerAvatarRequestedToolCalls(settings, "reasoning_on")).toBe("railroad");
		expect(providerAvatarRequestedToolCalls({
			...settings,
			toolCallRequest: { kind: "strategy", strategy: "at_will" },
		}, "reasoning_off")).toBe("require");
		expect(providerAvatarRequestedToolCalls({
			...settings,
			toolCallRequest: { kind: "strategy", strategy: "at_will" },
		}, "reasoning_on")).toBe("railroad");
	});

	it("covers every avatar response mode and structured tool strategy", () => {
		const automatic = { toolCallRequest: { kind: "bickr_automatic" as const } };
		const providerDefault = { toolCallRequest: { kind: "provider_default" as const } };
		for (const mode of ["structured_output", "tool_call", "tool_call_cache_friendly"] as const) {
			for (const strategy of ["require", "railroad"] as const) {
				const expected = mode === "structured_output" ? undefined : strategy === "require" ? "required" : undefined;
				expect(providerAvatarToolChoice(mode, automatic, strategy)).toBe(expected);
				expect(providerAvatarToolChoice(mode, providerDefault, strategy)).toBeUndefined();
			}
		}
	});
});

describe("provider avatar image streaming", () => {
	it("extracts streamed assistant text, image URLs, usage, and provider metadata", () => {
		const result = providerAvatarImageStreamChunk({
			id: "gen_123",
			model: "google/gemini-2.5-flash-image",
			usage: {
				prompt_tokens: 11,
				completion_tokens: 7,
				total_tokens: 18,
				cost: 0.0123,
			},
			openrouter_metadata: { provider_name: "Google AI Studio" },
			choices: [{
				delta: {
					content: "Here is the avatar.",
					images: [{
						type: "image_url",
						image_url: { url: "data:image/png;base64,abcd" },
					}],
				},
			}],
		});

		expect(result).toMatchObject({
			content: "Here is the avatar.",
			dataUrls: ["data:image/png;base64,abcd"],
			responseId: "gen_123",
			responseModel: "google/gemini-2.5-flash-image",
			responseProviderName: "Google AI Studio",
		});
		expect(result.usage?.cost).toBe(0.0123);
	});

	it("preserves whitespace in streamed assistant text chunks", () => {
		const result = providerAvatarImageStreamChunk({
			choices: [{
				delta: {
					content: " wide-angle ",
				},
			}],
		});

		expect(result.content).toBe(" wide-angle ");
	});

	it("accepts the imageUrl alias used by some OpenRouter SDK examples", () => {
		const result = providerAvatarImageStreamChunk({
			choices: [{
				delta: {
					images: [{
						type: "image_url",
						imageUrl: { url: "data:image/webp;base64,abcd" },
					}],
				},
			}],
		});

		expect(result.dataUrls).toEqual(["data:image/webp;base64,abcd"]);
	});

	it("throws provider stream errors", () => {
		expect(() => providerAvatarImageStreamChunk({
			error: { code: 429, message: "Rate limited", metadata: { error_type: "rate_limit" } },
		})).toThrow("Rate limited");
	});
});
