import { worldAvatarMembersPromptUserContent } from '@bickr/shared/avatar-prompts';
import { avatarContentTypeFromBytes, avatarMaxBytes, validateAvatarDataUrl } from '@bickr/shared/avatar-storage';
import { isOpenRouterProviderBaseUrl } from '@bickr/shared/inference-settings';
import {
	effectiveStructuredToolCallsForModel,
} from '@bickr/shared/openrouter-model-capabilities';
import {
	localizedTextString,
	type BotDocument,
	type BotInferenceSubmissionMessage,
	type BotInferenceSubmissionToolCall,
	type BotSummary,
	type JsonObject,
	type WorldDocument,
} from '@bickr/shared/model';
import { InputError } from '@bickr/shared/validation';
import {
	appendToolRequirementInstruction,
	providerCompactionMode,
	providerSingleStringResponseFormat,
	providerToolChoiceForMode,
	settingsUseOpenRouter,
	type ProviderCompactionMode,
	type ProviderJsonSchemaResponseFormat,
	type ProviderReasoningConfig,
	type ProviderSingleStringResponseSpec,
} from '../compaction/engine';
import {
	providerAvatarDescriptionToolDefinitions,
	providerAvatarDescriptionToolName,
	standardPrompt,
} from '../prompt-and-tools';
import { providerMessageTextContent, type ProviderSettings } from '../provider-requests';
import type { AvatarGenerationDisplayMessage, AvatarGenerationStreamSink, AvatarProvider } from './service';
import type { ImageGenerationProviderSettings } from './target';

type ChatMessage = BotInferenceSubmissionMessage;

type ProviderUsage = {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	cachedTokens: number;
	reasoningTokens: number;
	cost: number | null;
	raw: Record<string, unknown>;
};

type ProviderCompactionResponsePayload = {
	choices?: Array<{ message?: unknown }>;
};

type ProviderRequestErrorLike = Error & { body: string; status: number };

type ProviderStructuredOutputValidationError = Error & {
	outputText?: string;
	rawResponse?: string;
	repairMessage: string;
	requiredToolName: string;
	toolCalls: BotInferenceSubmissionToolCall[];
};

export type AvatarProviderRuntime = {
	chatCompletionsUrl(baseUrl: string): string;
	imagesUrl(baseUrl: string): string;
	fetchWithHeaderTimeout(endpoint: string, init: RequestInit, signal: AbortSignal, timeoutMs: number): Promise<Response>;
	readProviderErrorBody(response: Response, signal: AbortSignal): Promise<string>;
	requestErrorFromBody(status: number, model: string, endpoint: string, body: string): Error;
	readJsonResponseText(
		response: Response,
		maxBytes: number,
		signal: AbortSignal,
		timeoutMs: number,
		timeoutError: () => Error,
	): Promise<string>;
	responseBodyTimeoutError(timeoutMs: number): Error;
	requestError(
		status: number,
		model: string,
		endpoint: string,
		body: string,
		options?: { rawResponse?: string },
	): Error;
	isResponseBodySizeLimitError(error: unknown): boolean;
	isRequestError(error: unknown): error is ProviderRequestErrorLike;
	isStructuredOutputValidationError(error: unknown): error is ProviderStructuredOutputValidationError;
	sanitizeMessages(messages: readonly ChatMessage[]): ChatMessage[];
	reasoningForSettings(settings: Pick<ProviderSettings, 'model' | 'reasoningEffort'> & { baseUrl?: string }): ProviderReasoningConfig | undefined;
	structuredOutputReasoningForSettings(settings: Pick<ProviderSettings, 'baseUrl' | 'model'>): ProviderReasoningConfig | undefined;
	readSse(stream: ReadableStream<Uint8Array>, signal?: AbortSignal, idleTimeoutMs?: number): AsyncGenerator<{ data: string; raw: string }>;
	streamErrorFromChunk(chunk: Record<string, unknown>): Error | null;
	usageFromValue(value: unknown): ProviderUsage | undefined;
	metadataProviderName(payload: unknown): string | null;
	singleStringResponseFromMessage(
		message: unknown,
		spec: ProviderSingleStringResponseSpec,
		rawResponse: string,
		mode: ProviderCompactionMode,
	): string;
	isStoppedError(error: unknown): boolean;
};

export class ProviderAvatarDescriptionValidationError extends Error {
	readonly kind = 'provider_avatar_description_validation';
	readonly repairMessage: string;
	readonly rawResponse?: string;

	constructor(repairMessage: string, options: { rawResponse?: string } = {}) {
		super(`Inference provider returned schema-invalid avatar_description structured output: ${repairMessage}`);
		this.name = 'ProviderAvatarDescriptionValidationError';
		this.repairMessage = repairMessage;
		this.rawResponse = options.rawResponse;
	}
}

const providerRequestTimeoutMs = 60_000;
const providerImageRequestTimeoutMs = 240_000;
const providerBodyReadTimeoutMs = 60_000;
const providerImageBodyReadTimeoutMs = 240_000;
const providerResponseBodyMaxBytes = 2_000_000;
const providerImageResponseBodyMaxBytes = Math.ceil((avatarMaxBytes * 4) / 3) + 2_000_000;
const providerAvatarDescriptionMaxAttempts = 2;
const avatarImageGenerationSystemPrompt =
	'Create a public profile avatar image for this Bickr participant. Honor the requested visual direction and any supplied current profile image. Favor a clear, recognizable composition suitable for a square or cropped profile display. Do not include captions, watermarks, interface chrome, or explanatory text inside the image.';
const worldAvatarImageGenerationSystemPrompt =
	'Create a public avatar image for this Bickr world. Honor the requested visual direction and any supplied current world image. Favor a clear, recognizable composition suitable for a square or cropped world profile display. Do not include captions, watermarks, interface chrome, or explanatory text inside the image.';
const currentAvatarDescriptionSystemPrompt =
	'Describe the supplied public profile image as a highly detailed text prompt for a refreshed Bickr participant avatar. Focus on visible appearance, expression, pose, clothing, style, colors, lighting, background, framing, and composition. Return only the description text.';
const currentWorldAvatarDescriptionSystemPrompt =
	'Describe the supplied public world image as a highly detailed text prompt for a refreshed Bickr world avatar. Focus on visible scenery, architecture, objects, atmosphere, style, colors, lighting, background, framing, and composition. Return only the description text.';

export function createAvatarProvider(runtime: AvatarProviderRuntime): AvatarProvider {
	async function fetchProviderWorldAvatarMembersDescription(
		settings: ProviderSettings,
		world: WorldDocument,
		members: readonly BotSummary[],
		options: ProviderAvatarDescriptionOptions = {},
	): Promise<string> {
		return fetchProviderWorldAvatarDescriptionFromUserContent(
			settings,
			worldAvatarMembersPromptUserContent(world, members),
			options,
		);
	}

	async function fetchProviderWorldAvatarDescription(
		settings: ProviderSettings,
		world: WorldDocument,
		options: ProviderAvatarDescriptionOptions = {},
	): Promise<string> {
		const sourceDescription = [localizedTextString(world.description).trim(), localizedTextString(world.prompt).trim()]
			.filter(Boolean)
			.join('\n\nAdditional setting detail:\n');
		if (!sourceDescription) {
			throw new InputError('Short description or prompt is required before filling from description.');
		}
		return fetchProviderWorldAvatarDescriptionFromUserContent(
			settings,
			`World name: ${localizedTextString(world.name)}\nShort description:\n${sourceDescription}`,
			options,
		);
	}

	async function fetchProviderWorldAvatarDescriptionFromUserContent(
		settings: ProviderSettings,
		userContent: string,
		options: ProviderAvatarDescriptionOptions = {},
	): Promise<string> {
		const endpoint = runtime.chatCompletionsUrl(settings.baseUrl);
		const signal = options.signal ?? new AbortController().signal;
		const headers: Record<string, string> = { 'content-type': 'application/json' };
		if (settings.apiKey) {
			headers.authorization = `Bearer ${settings.apiKey}`;
		}
		const prefill = options.prefill?.trim();
		const messages: ChatMessage[] = [
			{
				role: 'system',
				content:
					'Write a detailed visual prompt for a public Bickr world avatar. Synthesize the setting and member profiles into one coherent image illustrating the world. Focus on concrete setting details, landmarks, scenery, atmosphere, lighting, colors, texture, composition, and camera framing. Do not include captions, text overlays, interface chrome, watermarks, or process commentary. Return only the prompt text.',
			},
			...(prefill ? [{ role: 'assistant' as const, content: prefill }] : []),
			{
				role: 'user',
				content: userContent,
			},
		];
		await options.stream?.messages(
			messages.flatMap((message): AvatarGenerationDisplayMessage[] => {
				if (message.role !== 'system' && message.role !== 'user' && message.role !== 'assistant') {
					return [];
				}
				return [{ role: message.role, content: message.content ?? '' }];
			}),
		);
		const requestBody = {
			model: settings.model,
			messages: runtime.sanitizeMessages(messages),
			...(settings.providerRouting ? { provider: settings.providerRouting } : {}),
			stream: Boolean(options.stream),
			temperature: settings.temperature,
			...(runtime.reasoningForSettings(settings) ? { reasoning: runtime.reasoningForSettings(settings) } : {}),
			...(settings.topK !== undefined ? { top_k: settings.topK } : {}),
			...(settings.topP !== undefined ? { top_p: settings.topP } : {}),
			...(settings.minP !== undefined ? { min_p: settings.minP } : {}),
			...(settings.frequencyPenalty !== undefined ? { frequency_penalty: settings.frequencyPenalty } : {}),
			...(settings.presencePenalty !== undefined ? { presence_penalty: settings.presencePenalty } : {}),
			...(settings.repetitionPenalty !== undefined ? { repetition_penalty: settings.repetitionPenalty } : {}),
		};
		const response = await runtime.fetchWithHeaderTimeout(
			endpoint,
			{ method: 'POST', headers, body: JSON.stringify(requestBody) },
			signal,
			providerRequestTimeoutMs,
		);
		if (!response.ok) {
			const bodyText = await runtime.readProviderErrorBody(response, signal);
			throw runtime.requestErrorFromBody(response.status, settings.model, endpoint, bodyText);
		}
		if (options.stream) {
			return fetchProviderWorldAvatarDescriptionFromStream(settings, endpoint, response, signal, options.stream, Boolean(prefill));
		}
		const rawResponse = await runtime.readJsonResponseText(
			response,
			providerResponseBodyMaxBytes,
			signal,
			providerBodyReadTimeoutMs,
			() => runtime.responseBodyTimeoutError(providerBodyReadTimeoutMs),
		);
		let payload: unknown;
		try {
			payload = JSON.parse(rawResponse) as unknown;
		} catch {
			throw runtime.requestError(502, settings.model, endpoint, 'Provider world avatar description response was not valid JSON.', {
				rawResponse,
			});
		}
		const payloadRecord = runtimeRecord(payload);
		const choices = Array.isArray(payloadRecord.choices) ? payloadRecord.choices : [];
		const text = normalizeAvatarDescriptionText(providerMessageTextContent(runtimeRecord(runtimeRecord(choices[0]).message).content));
		if (!text) {
			throw runtime.requestError(502, settings.model, endpoint, 'Provider world avatar description response did not include text.', {
				rawResponse,
			});
		}
		return text;
	}

	async function fetchProviderWorldAvatarDescriptionFromStream(
		settings: ProviderSettings,
		endpoint: string,
		response: Response,
		signal: AbortSignal,
		stream: AvatarGenerationStreamSink,
		hasPrefill: boolean,
	): Promise<string> {
		if (!response.body) {
			throw runtime.requestError(502, settings.model, endpoint, 'Inference provider did not return a streaming response body.');
		}
		let text = '';
		try {
			for await (const event of runtime.readSse(response.body, signal, providerBodyReadTimeoutMs)) {
				if (event.data === '[DONE]') {
					break;
				}
				let chunk: unknown;
				try {
					chunk = JSON.parse(event.data) as unknown;
				} catch {
					continue;
				}
				const parsed = providerAvatarImageStreamChunk(chunk);
				if (parsed.content) {
					text += parsed.content;
					await stream.assistantDelta(hasPrefill && text === parsed.content ? `\n\n${parsed.content}` : parsed.content);
				}
			}
		} catch (error) {
			if (runtime.isResponseBodySizeLimitError(error)) {
				throw runtime.requestError(502, settings.model, endpoint, 'Provider world avatar description response was too large.');
			}
			throw error;
		}
		const normalized = normalizeAvatarDescriptionText(text);
		if (!normalized) {
			throw runtime.requestError(502, settings.model, endpoint, 'Provider world avatar description response did not include text.');
		}
		return normalized;
	}

	type ProviderImageContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

	type ProviderImageMessage =
		| { role: 'system'; content: string }
		| { role: 'user'; content: ProviderImageContentPart[] };

	type ProviderAvatarImageStreamChunk = {
		content: string;
		dataUrls: string[];
		usage?: ProviderUsage;
		responseId?: string;
		responseModel?: string;
		responseProviderName?: string;
	};

	async function fetchProviderAvatarImage(
		settings: ImageGenerationProviderSettings,
		input: { prompt: string; currentAvatarUrl?: string },
		options: { signal?: AbortSignal; stream?: AvatarGenerationStreamSink; target?: 'participant' | 'world' } = {},
	): Promise<{ dataUrl: string; cost: number | null }> {
		const openRouterImageApi = isOpenRouterProviderBaseUrl(settings.baseUrl);
		const endpoint = openRouterImageApi ? runtime.imagesUrl(settings.baseUrl) : runtime.chatCompletionsUrl(settings.baseUrl);
		const signal = options.signal ?? new AbortController().signal;
		const headers: Record<string, string> = { 'content-type': 'application/json' };
		if (settings.apiKey) {
			headers.authorization = `Bearer ${settings.apiKey}`;
		}
		const requestMessages = avatarImageGenerationMessages(input, options.target);
		await options.stream?.messages(requestMessages.displayMessages);
		if (openRouterImageApi) {
			const upstreamStream = Boolean(
				options.stream &&
				!input.currentAvatarUrl &&
				await openRouterImageApiSupportsStreaming(settings, signal),
			);
			const requestBody = openRouterAvatarImageRequest(settings, requestMessages, input, upstreamStream);
			const response = await runtime.fetchWithHeaderTimeout(
				endpoint,
				{ method: 'POST', headers, body: JSON.stringify(requestBody) },
				signal,
				providerImageRequestTimeoutMs,
			);
			if (!response.ok) {
				const bodyText = await runtime.readProviderErrorBody(response, signal);
				throw runtime.requestErrorFromBody(response.status, settings.model, endpoint, bodyText);
			}
			if (upstreamStream && options.stream && isEventStreamResponse(response)) {
				return fetchOpenRouterAvatarImageFromStream(settings, endpoint, response, signal, options.stream);
			}
			let rawResponse: string;
			try {
				rawResponse = await runtime.readJsonResponseText(
					response,
					providerImageResponseBodyMaxBytes,
					signal,
					providerImageBodyReadTimeoutMs,
					() => runtime.responseBodyTimeoutError(providerImageBodyReadTimeoutMs),
				);
			} catch (error) {
				if (runtime.isResponseBodySizeLimitError(error)) {
					throw runtime.requestError(502, settings.model, endpoint, 'Provider image response was larger than the supported avatar size.');
				}
				throw error;
			}
			let payload: unknown;
			try {
				payload = JSON.parse(rawResponse) as unknown;
			} catch {
				throw runtime.requestError(502, settings.model, endpoint, 'Provider image response was not valid JSON.', { rawResponse });
			}
			const dataUrl = openRouterImageApiDataUrl(payload);
			if (!dataUrl) {
				throw runtime.requestError(502, settings.model, endpoint, 'Provider image response did not include an image.', { rawResponse });
			}
			if (options.stream) {
				await options.stream.assistantImage(1);
			}
			const usageRecord = runtimeRecord(payload).usage;
			return {
				dataUrl,
				cost: runtime.usageFromValue(usageRecord)?.cost ?? numberValue(runtimeRecord(usageRecord).cost) ?? null,
			};
		}
		const imageConfig: JsonObject = {
			...(settings.aspectRatio ? { aspect_ratio: settings.aspectRatio } : {}),
			...(settings.imageSize ? { image_size: settings.imageSize } : {}),
		};
		const requestBody = {
			model: settings.model,
			messages: requestMessages.providerMessages,
			modalities: await providerImageOutputModalities(settings, signal),
			stream: Boolean(options.stream),
			...(Object.keys(imageConfig).length > 0 ? { image_config: imageConfig } : {}),
			...(settings.providerRouting ? { provider: settings.providerRouting } : {}),
			...(settings.temperature !== undefined ? { temperature: settings.temperature } : {}),
			...(settings.topK !== undefined ? { top_k: settings.topK } : {}),
			...(settings.topP !== undefined ? { top_p: settings.topP } : {}),
			...(settings.minP !== undefined ? { min_p: settings.minP } : {}),
			...(settings.frequencyPenalty !== undefined ? { frequency_penalty: settings.frequencyPenalty } : {}),
			...(settings.presencePenalty !== undefined ? { presence_penalty: settings.presencePenalty } : {}),
			...(settings.repetitionPenalty !== undefined ? { repetition_penalty: settings.repetitionPenalty } : {}),
		};
		const response = await runtime.fetchWithHeaderTimeout(
			endpoint,
			{ method: 'POST', headers, body: JSON.stringify(requestBody) },
			signal,
			providerImageRequestTimeoutMs,
		);
		if (!response.ok) {
			const bodyText = await runtime.readProviderErrorBody(response, signal);
			throw runtime.requestErrorFromBody(response.status, settings.model, endpoint, bodyText);
		}
		if (options.stream) {
			return fetchProviderAvatarImageFromStream(settings, endpoint, response, signal, options.stream);
		}
		let rawResponse: string;
		try {
			rawResponse = await runtime.readJsonResponseText(
				response,
				providerImageResponseBodyMaxBytes,
				signal,
				providerImageBodyReadTimeoutMs,
				() => runtime.responseBodyTimeoutError(providerImageBodyReadTimeoutMs),
			);
		} catch (error) {
			if (runtime.isResponseBodySizeLimitError(error)) {
				throw runtime.requestError(502, settings.model, endpoint, 'Provider image response was larger than the supported avatar size.');
			}
			throw error;
		}
		let payload: unknown;
		try {
			payload = JSON.parse(rawResponse) as unknown;
		} catch {
			throw runtime.requestError(502, settings.model, endpoint, 'Provider image response was not valid JSON.', { rawResponse });
		}
		const dataUrl = providerImageDataUrl(payload);
		if (!dataUrl) {
			throw runtime.requestError(502, settings.model, endpoint, 'Provider image response did not include an image.', { rawResponse });
		}
		const usageRecord = runtimeRecord(payload).usage;
		return {
			dataUrl,
			cost: runtime.usageFromValue(usageRecord)?.cost ?? numberValue(runtimeRecord(usageRecord).cost) ?? null,
		};
	}

	function openRouterAvatarImageRequest(
		settings: ImageGenerationProviderSettings,
		requestMessages: ReturnType<typeof avatarImageGenerationMessages>,
		input: { currentAvatarUrl?: string },
		stream: boolean,
	): JsonObject {
		const prompt = openRouterAvatarImagePrompt(requestMessages);
		return {
			model: settings.model,
			prompt,
			stream,
			...(input.currentAvatarUrl ? { input_references: [{ type: 'image_url', image_url: { url: input.currentAvatarUrl } }] } : {}),
			...(settings.aspectRatio ? { aspect_ratio: settings.aspectRatio } : {}),
			...(settings.imageSize ? { size: settings.imageSize } : {}),
			...(settings.providerRouting ? { provider: settings.providerRouting } : {}),
		};
	}

	function openRouterAvatarImagePrompt(requestMessages: ReturnType<typeof avatarImageGenerationMessages>): string {
		return requestMessages.displayMessages
			.map((message) => message.content.trim())
			.filter(Boolean)
			.join('\n\n');
	}

	function avatarImageGenerationMessages(input: { prompt: string; currentAvatarUrl?: string }, target: 'participant' | 'world' = 'participant'): {
		displayMessages: AvatarGenerationDisplayMessage[];
		providerMessages: ProviderImageMessage[];
	} {
		const prompt = input.prompt.trim();
		const systemPrompt = target === 'world' ? worldAvatarImageGenerationSystemPrompt : avatarImageGenerationSystemPrompt;
		const userText = prompt || (target === 'world'
			? 'Use the supplied current world image as visual input for a refreshed public world avatar.'
			: 'Use the supplied current profile image as visual input for a refreshed public profile avatar.');
		const displayUserMessage = [userText, ...(input.currentAvatarUrl ? ['[current avatar image included]'] : [])].join('\n\n');
		const content: ProviderImageContentPart[] = [{ type: 'text', text: userText }];
		if (input.currentAvatarUrl) {
			content.push({ type: 'image_url', image_url: { url: input.currentAvatarUrl } });
		}
		return {
			displayMessages: [
				{ role: 'system', content: systemPrompt },
				{ role: 'user', content: displayUserMessage },
			],
			providerMessages: [
				{ role: 'system', content: systemPrompt },
				{ role: 'user', content },
			],
		};
	}

	function currentAvatarDescriptionMessages(currentAvatarUrl: string, target: 'participant' | 'world' = 'participant'): {
		displayMessages: AvatarGenerationDisplayMessage[];
		providerMessages: ProviderImageMessage[];
	} {
		const systemPrompt = target === 'world' ? currentWorldAvatarDescriptionSystemPrompt : currentAvatarDescriptionSystemPrompt;
		const userText = target === 'world'
			? 'Bickr Terminal needs a complete visual description of the supplied current world image for a refreshed public world avatar prompt.'
			: 'Bickr Terminal needs a complete visual description of the supplied current profile image for a refreshed public avatar prompt.';
		return {
			displayMessages: [
				{ role: 'system', content: systemPrompt },
				{ role: 'user', content: `${userText}\n\n[current avatar image included]` },
			],
			providerMessages: [
				{ role: 'system', content: systemPrompt },
				{
					role: 'user',
					content: [
						{ type: 'text', text: userText },
						{ type: 'image_url', image_url: { url: currentAvatarUrl } },
					],
				},
			],
		};
	}

	async function fetchProviderCurrentAvatarDescription(
		settings: ImageGenerationProviderSettings,
		currentAvatarUrl: string,
		options: { signal?: AbortSignal; stream?: AvatarGenerationStreamSink; target?: 'participant' | 'world' } = {},
	): Promise<string> {
		const endpoint = runtime.chatCompletionsUrl(settings.baseUrl);
		const signal = options.signal ?? new AbortController().signal;
		const modalities = await openRouterImageModelModalities(settings, signal);
		if (modalities) {
			if (!modalities.input.includes('image')) {
				throw new InputError('The selected image generation model cannot use the current avatar as image input.');
			}
			if (!modalities.output.includes('text')) {
				throw new InputError('The selected image generation model cannot return a text prompt.');
			}
		}
		const headers: Record<string, string> = { 'content-type': 'application/json' };
		if (settings.apiKey) {
			headers.authorization = `Bearer ${settings.apiKey}`;
		}
		const requestMessages = currentAvatarDescriptionMessages(currentAvatarUrl, options.target);
		await options.stream?.messages(requestMessages.displayMessages);
		const requestBody = {
			model: settings.model,
			messages: requestMessages.providerMessages,
			modalities: ['text'],
			stream: Boolean(options.stream),
			...(settings.providerRouting ? { provider: settings.providerRouting } : {}),
			...(settings.temperature !== undefined ? { temperature: settings.temperature } : {}),
			...(settings.topK !== undefined ? { top_k: settings.topK } : {}),
			...(settings.topP !== undefined ? { top_p: settings.topP } : {}),
			...(settings.minP !== undefined ? { min_p: settings.minP } : {}),
			...(settings.frequencyPenalty !== undefined ? { frequency_penalty: settings.frequencyPenalty } : {}),
			...(settings.presencePenalty !== undefined ? { presence_penalty: settings.presencePenalty } : {}),
			...(settings.repetitionPenalty !== undefined ? { repetition_penalty: settings.repetitionPenalty } : {}),
		};
		const response = await runtime.fetchWithHeaderTimeout(
			endpoint,
			{ method: 'POST', headers, body: JSON.stringify(requestBody) },
			signal,
			providerRequestTimeoutMs,
		);
		if (!response.ok) {
			const bodyText = await runtime.readProviderErrorBody(response, signal);
			throw runtime.requestErrorFromBody(response.status, settings.model, endpoint, bodyText);
		}
		if (options.stream) {
			return fetchProviderCurrentAvatarDescriptionFromStream(settings, endpoint, response, signal, options.stream);
		}
		const rawResponse = await runtime.readJsonResponseText(
			response,
			providerResponseBodyMaxBytes,
			signal,
			providerBodyReadTimeoutMs,
			() => runtime.responseBodyTimeoutError(providerBodyReadTimeoutMs),
		);
		let payload: unknown;
		try {
			payload = JSON.parse(rawResponse) as unknown;
		} catch {
			throw runtime.requestError(502, settings.model, endpoint, 'Provider current avatar description response was not valid JSON.', {
				rawResponse,
			});
		}
		const payloadRecord = runtimeRecord(payload);
		const choices = Array.isArray(payloadRecord.choices) ? payloadRecord.choices : [];
		const text = normalizeAvatarDescriptionText(providerMessageTextContent(runtimeRecord(runtimeRecord(choices[0]).message).content));
		if (!text) {
			throw runtime.requestError(502, settings.model, endpoint, 'Provider current avatar description response did not include text.', {
				rawResponse,
			});
		}
		return text;
	}

	async function fetchProviderCurrentAvatarDescriptionFromStream(
		settings: ImageGenerationProviderSettings,
		endpoint: string,
		response: Response,
		signal: AbortSignal,
		stream: AvatarGenerationStreamSink,
	): Promise<string> {
		if (!response.body) {
			throw runtime.requestError(502, settings.model, endpoint, 'Inference provider did not return a streaming response body.');
		}
		let text = '';
		try {
			for await (const event of runtime.readSse(response.body, signal, providerBodyReadTimeoutMs)) {
				if (event.data === '[DONE]') {
					break;
				}
				let chunk: unknown;
				try {
					chunk = JSON.parse(event.data) as unknown;
				} catch {
					continue;
				}
				const parsed = providerAvatarImageStreamChunk(chunk);
				if (parsed.content) {
					text += parsed.content;
					await stream.assistantDelta(parsed.content);
				}
			}
		} catch (error) {
			if (runtime.isResponseBodySizeLimitError(error)) {
				throw runtime.requestError(502, settings.model, endpoint, 'Provider current avatar description response was too large.');
			}
			throw error;
		}
		const normalized = normalizeAvatarDescriptionText(text);
		if (!normalized) {
			throw runtime.requestError(502, settings.model, endpoint, 'Provider current avatar description response did not include text.');
		}
		return normalized;
	}

	async function fetchProviderAvatarImageFromStream(
		settings: ImageGenerationProviderSettings,
		endpoint: string,
		response: Response,
		signal: AbortSignal,
		stream: AvatarGenerationStreamSink,
	): Promise<{ dataUrl: string; cost: number | null }> {
		if (!response.body) {
			throw runtime.requestError(502, settings.model, endpoint, 'Inference provider did not return a streaming response body.');
		}
		let dataUrl: string | null = null;
		let cost: number | null = null;
		let imageCount = 0;
		try {
			for await (const event of runtime.readSse(response.body, signal, providerImageBodyReadTimeoutMs)) {
				if (event.data === '[DONE]') {
					break;
				}
				let chunk: unknown;
				try {
					chunk = JSON.parse(event.data) as unknown;
				} catch {
					continue;
				}
				const parsed = providerAvatarImageStreamChunk(chunk);
				if (parsed.usage) {
					cost = parsed.usage.cost ?? numberValue(parsed.usage.raw.cost) ?? cost;
				}
				if (parsed.content) {
					await stream.assistantDelta(parsed.content);
				}
				for (const candidateUrl of parsed.dataUrls) {
					imageCount += 1;
					if (!dataUrl) {
						try {
							validateAvatarDataUrl(candidateUrl);
							dataUrl = candidateUrl;
						} catch {
							// Keep streaming markers for all returned images, but only promote the first valid avatar image.
						}
					}
					await stream.assistantImage(imageCount);
				}
			}
		} catch (error) {
			if (runtime.isResponseBodySizeLimitError(error)) {
				throw runtime.requestError(502, settings.model, endpoint, 'Provider image response was larger than the supported avatar size.');
			}
			throw error;
		}
		if (!dataUrl) {
			throw runtime.requestError(502, settings.model, endpoint, 'Provider image response did not include a valid image.');
		}
		return { dataUrl, cost };
	}

	async function fetchOpenRouterAvatarImageFromStream(
		settings: ImageGenerationProviderSettings,
		endpoint: string,
		response: Response,
		signal: AbortSignal,
		stream: AvatarGenerationStreamSink,
	): Promise<{ dataUrl: string; cost: number | null }> {
		if (!response.body) {
			throw runtime.requestError(502, settings.model, endpoint, 'Inference provider did not return a streaming response body.');
		}
		let dataUrl: string | null = null;
		let cost: number | null = null;
		let imageCount = 0;
		try {
			for await (const event of runtime.readSse(response.body, signal, providerImageBodyReadTimeoutMs)) {
				if (event.data === '[DONE]') {
					break;
				}
				let chunk: unknown;
				try {
					chunk = JSON.parse(event.data) as unknown;
				} catch {
					continue;
				}
				const record = runtimeRecord(chunk);
				const providerError = runtime.streamErrorFromChunk(record);
				if (providerError) {
					throw providerError;
				}
				const usage = runtime.usageFromValue(record.usage);
				if (usage) {
					cost = usage.cost ?? numberValue(usage.raw.cost) ?? cost;
				}
				const type = stringValue(record.type);
				const eventDataUrl = openRouterImageApiDataUrl({ data: [record] });
				if (eventDataUrl) {
					imageCount += 1;
					await stream.assistantImage(imageCount);
					if (type === 'image_generation.completed' && !dataUrl) {
						dataUrl = eventDataUrl;
					}
				}
			}
		} catch (error) {
			if (runtime.isResponseBodySizeLimitError(error)) {
				throw runtime.requestError(502, settings.model, endpoint, 'Provider image response was larger than the supported avatar size.');
			}
			throw error;
		}
		if (!dataUrl) {
			throw runtime.requestError(502, settings.model, endpoint, 'Provider image response did not include a valid image.');
		}
		return { dataUrl, cost };
	}

	function providerAvatarImageStreamChunk(chunk: unknown): ProviderAvatarImageStreamChunk {
		const record = runtimeRecord(chunk);
		const providerError = runtime.streamErrorFromChunk(record);
		if (providerError) {
			throw providerError;
		}
		const dataUrls: string[] = [];
		let content = '';
		const choices = Array.isArray(record.choices) ? record.choices : [];
		for (const choice of choices) {
			const delta = runtimeRecord(runtimeRecord(choice).delta);
			content += providerStreamTextDelta(delta.content);
			dataUrls.push(...providerImageDataUrlsFromImages(delta.images));
		}
		const usage = runtime.usageFromValue(record.usage);
		const responseId = stringValue(record.id);
		const responseModel = stringValue(record.model);
		const responseProviderName = runtime.metadataProviderName(record.openrouter_metadata) ?? undefined;
		return {
			content,
			dataUrls,
			...(usage ? { usage } : {}),
			...(responseId ? { responseId } : {}),
			...(responseModel ? { responseModel } : {}),
			...(responseProviderName ? { responseProviderName } : {}),
		};
	}

	function providerStreamTextDelta(value: unknown): string {
		return typeof value === 'string' ? value : '';
	}

	function isEventStreamResponse(response: Response): boolean {
		return response.headers.get('content-type')?.toLowerCase().includes('text/event-stream') === true;
	}

	async function providerImageOutputModalities(
		settings: Pick<ImageGenerationProviderSettings, 'baseUrl' | 'model'>,
		signal?: AbortSignal,
	): Promise<['image'] | ['image', 'text']> {
		const modalities = await openRouterImageModelModalities(settings, signal);
		if (modalities) {
			return modalities.output.includes('text') ? ['image', 'text'] : ['image'];
		}
		return ['image', 'text'];
	}

	type ProviderImageModelModalities = {
		input: string[];
		output: string[];
	};

	type ProviderImageModelCapabilities = ProviderImageModelModalities & {
		supportsStreaming: boolean;
	};

	async function openRouterImageApiSupportsStreaming(
		settings: Pick<ImageGenerationProviderSettings, 'baseUrl' | 'model'>,
		signal?: AbortSignal,
	): Promise<boolean> {
		const capabilities = await openRouterImageModelCapabilities(settings, signal);
		return capabilities?.supportsStreaming === true;
	}

	async function openRouterImageModelModalities(
		settings: Pick<ImageGenerationProviderSettings, 'baseUrl' | 'model'>,
		signal?: AbortSignal,
	): Promise<ProviderImageModelModalities | null> {
		const capabilities = await openRouterImageModelCapabilities(settings, signal);
		return capabilities ? { input: capabilities.input, output: capabilities.output } : null;
	}

	async function openRouterImageModelCapabilities(
		settings: Pick<ImageGenerationProviderSettings, 'baseUrl' | 'model'>,
		signal?: AbortSignal,
	): Promise<ProviderImageModelCapabilities | null> {
		if (!isOpenRouterProviderBaseUrl(settings.baseUrl)) {
			return null;
		}
		try {
			const response = await fetch('https://openrouter.ai/api/v1/images/models', {
				headers: { accept: 'application/json' },
				...(signal ? { signal } : {}),
			});
			if (!response.ok) {
				return null;
			}
			const payload = (await response.json()) as { data?: unknown };
			const data = Array.isArray(payload.data) ? payload.data : [];
			const requestedModel = normalizedProviderModelId(settings.model);
			if (!requestedModel) {
				return null;
			}
			for (const item of data) {
				const record = runtimeRecord(item);
				if (normalizedProviderModelId(stringValue(record.id)) !== requestedModel) {
					continue;
				}
				const architecture = runtimeRecord(record.architecture);
				return {
					input: stringArrayValue(architecture.input_modalities),
					output: stringArrayValue(architecture.output_modalities),
					supportsStreaming: record.supports_streaming === true,
				};
			}
		} catch (error) {
			if (signal?.aborted || runtime.isStoppedError(error) || isAbortError(error)) {
				throw error;
			}
			return null;
		}
		return null;
	}

	function normalizedProviderModelId(model: string | undefined): string {
		return model?.trim().toLowerCase().split(':')[0] ?? '';
	}

	function providerImageDataUrl(payload: unknown): string | null {
		const imageApiUrl = openRouterImageApiDataUrl(payload);
		if (imageApiUrl) {
			return imageApiUrl;
		}
		const choices = Array.isArray((payload as { choices?: unknown }).choices) ? (payload as { choices: unknown[] }).choices : [];
		for (const choice of choices) {
			const message = runtimeRecord(runtimeRecord(choice).message);
			const [url] = providerImageDataUrlsFromImages(message.images);
			if (url) {
				return url;
			}
		}
		return null;
	}

	function openRouterImageApiDataUrl(payload: unknown): string | null {
		const data = Array.isArray((payload as { data?: unknown }).data) ? (payload as { data: unknown[] }).data : [];
		for (const item of data) {
			const record = runtimeRecord(item);
			const url = dataUrlFromBase64Image(record.b64_json, record.media_type);
			if (url) {
				return url;
			}
		}
		return null;
	}

	function dataUrlFromBase64Image(base64: unknown, mediaTypeValue: unknown): string | null {
		if (typeof base64 !== 'string' || !base64.trim()) {
			return null;
		}
		const normalizedBase64 = base64.trim();
		if (/^data:image\/[^;,]+;base64,/i.test(normalizedBase64)) {
			return normalizedBase64;
		}
		const mediaType = avatarContentTypeFromBase64Image(normalizedBase64) ?? stringValue(mediaTypeValue) ?? 'image/png';
		if (!mediaType.startsWith('image/')) {
			return null;
		}
		return `data:${mediaType};base64,${normalizedBase64}`;
	}

	function avatarContentTypeFromBase64Image(base64: string): ReturnType<typeof avatarContentTypeFromBytes> {
		try {
			const binary = atob(base64);
			const bytes = new Uint8Array(binary.length);
			for (let index = 0; index < binary.length; index += 1) {
				bytes[index] = binary.charCodeAt(index);
			}
			return avatarContentTypeFromBytes(bytes);
		} catch {
			return null;
		}
	}

	function providerImageDataUrlsFromImages(value: unknown): string[] {
		const images = Array.isArray(value) ? value : [];
		const urls: string[] = [];
		for (const image of images) {
			const imageRecord = runtimeRecord(image);
			const url =
				stringValue(runtimeRecord(imageRecord.image_url).url) ??
				stringValue(runtimeRecord(imageRecord.imageUrl).url);
			if (url?.startsWith('data:image/')) {
				urls.push(url);
			}
		}
		return urls;
	}

	function providerAvatarDescriptionSpec(): ProviderSingleStringResponseSpec {
		return {
			kind: 'avatar_description',
			property: 'description',
			label: 'profile image description',
			maxCharacters: 8_000,
			toolName: providerAvatarDescriptionToolName,
		};
	}

	function providerAvatarDescriptionResponseFormat(mode: ProviderCompactionMode): ProviderJsonSchemaResponseFormat | undefined {
		return providerSingleStringResponseFormat('avatar_description', providerAvatarDescriptionSpec(), mode);
	}

	type ProviderAvatarDescriptionOptions = {
		prefill?: string;
		signal?: AbortSignal;
		stream?: AvatarGenerationStreamSink;
	};

	async function fetchProviderAvatarDescription(
		settings: ProviderSettings,
		bot: BotDocument,
		options: ProviderAvatarDescriptionOptions = {},
	): Promise<string> {
		const mode = providerCompactionMode(settings);
		try {
			return await fetchProviderAvatarDescriptionWithMode(settings, bot, mode, options);
		} catch (error) {
			if (mode === 'structured_output' && providerAvatarDescriptionCanFallbackToToolCall(error)) {
				return fetchProviderAvatarDescriptionWithMode(settings, bot, 'tool_call', options);
			}
			throw error;
		}
	}

	function providerAvatarDescriptionCanFallbackToToolCall(error: unknown): boolean {
		if (error instanceof ProviderAvatarDescriptionValidationError) {
			return true;
		}
		if (!(runtime.isRequestError(error))) {
			return false;
		}
		return error.status === 400 && /\b(response_format|json_schema|structured)\b/i.test(error.body);
	}

	async function fetchProviderAvatarDescriptionWithMode(
		settings: ProviderSettings,
		bot: BotDocument,
		mode: ProviderCompactionMode,
		options: ProviderAvatarDescriptionOptions = {},
	): Promise<string> {
		const endpoint = runtime.chatCompletionsUrl(settings.baseUrl);
		const signal = options.signal ?? new AbortController().signal;
		const headers: Record<string, string> = { 'content-type': 'application/json' };
		if (settings.apiKey) {
			headers.authorization = `Bearer ${settings.apiKey}`;
		}
		const tools = mode === 'structured_output' ? [] : providerAvatarDescriptionToolDefinitions();
		const requestedToolCalls = settings.toolCalls === 'railroad' ? 'railroad' : 'require';
		const toolCalls = effectiveStructuredToolCallsForModel(settings.model, settingsUseOpenRouter(settings), requestedToolCalls);
		const toolChoice = mode === 'structured_output' ? undefined : providerToolChoiceForMode(toolCalls);
		const responseFormat = providerAvatarDescriptionResponseFormat(mode);
		const reasoning = mode === 'structured_output'
			? runtime.structuredOutputReasoningForSettings(settings)
			: runtime.reasoningForSettings(settings);
		const finalInstruction =
			mode === 'structured_output'
				? 'Bickr Terminal needs a profile image description. I should return the required JSON object with a first-person, in-character description that is highly verbose and full of concrete visual detail. The description should focus only on visible appearance, style, scene, lighting, and composition.'
				: `Bickr Terminal needs a profile image description. I should call ${providerAvatarDescriptionToolName} with a first-person, in-character description that is highly verbose and full of concrete visual detail. The description should focus only on visible appearance, style, scene, lighting, and composition.`;
		const prefill = options.prefill?.trim();
		const messages: ChatMessage[] = [
			{
				role: 'system',
				content: mode === 'structured_output' ? standardPrompt(bot) : appendToolRequirementInstruction(standardPrompt(bot), tools),
			},
			...(prefill ? [{ role: 'assistant' as const, content: prefill }] : []),
			{
				role: 'user',
				content: finalInstruction,
			},
		];
		await options.stream?.messages(
			messages.flatMap((message): AvatarGenerationDisplayMessage[] => {
				if (message.role !== 'system' && message.role !== 'user' && message.role !== 'assistant') {
					return [];
				}
				return [{ role: message.role, content: message.content ?? '' }];
			}),
		);
		let lastValidationError: ProviderStructuredOutputValidationError | undefined;
		let fallbackDescription: string | null = null;
		for (let attempt = 1; attempt <= providerAvatarDescriptionMaxAttempts; attempt += 1) {
			const requestBody = {
				model: settings.model,
				messages: runtime.sanitizeMessages(messages),
				...(settings.providerRouting ? { provider: settings.providerRouting } : {}),
				stream: false,
				...(tools.length > 0 ? { tools } : {}),
				...(toolChoice ? { tool_choice: toolChoice } : {}),
				...(tools.length > 0 ? { parallel_tool_calls: false } : {}),
					...(responseFormat ? { response_format: responseFormat } : {}),
					max_completion_tokens: 1400,
					...(reasoning ? { reasoning } : {}),
					temperature: settings.temperature,
				...(settings.topK !== undefined ? { top_k: settings.topK } : {}),
				...(settings.topP !== undefined ? { top_p: settings.topP } : {}),
				...(settings.minP !== undefined ? { min_p: settings.minP } : {}),
				...(settings.frequencyPenalty !== undefined ? { frequency_penalty: settings.frequencyPenalty } : {}),
				...(settings.presencePenalty !== undefined ? { presence_penalty: settings.presencePenalty } : {}),
				...(settings.repetitionPenalty !== undefined ? { repetition_penalty: settings.repetitionPenalty } : {}),
			};
			const response = await runtime.fetchWithHeaderTimeout(
				endpoint,
				{ method: 'POST', headers, body: JSON.stringify(requestBody) },
				signal,
				providerRequestTimeoutMs,
			);
			if (!response.ok) {
				const bodyText = await runtime.readProviderErrorBody(response, signal);
				throw runtime.requestErrorFromBody(response.status, settings.model, endpoint, bodyText);
			}
			const rawResponse = await runtime.readJsonResponseText(
				response,
				providerResponseBodyMaxBytes,
				signal,
				providerBodyReadTimeoutMs,
				() => runtime.responseBodyTimeoutError(providerBodyReadTimeoutMs),
			);
			let payload: ProviderCompactionResponsePayload;
			try {
				payload = JSON.parse(rawResponse) as ProviderCompactionResponsePayload;
			} catch {
				throw runtime.requestError(502, settings.model, endpoint, 'Provider avatar description response was not valid JSON.', {
					rawResponse,
				});
			}
			try {
				const description = providerAvatarDescriptionFromResponseMessage(payload.choices?.[0]?.message, rawResponse, mode);
				await options.stream?.assistantDelta(prefill ? `\n\n${description}` : description);
				return description;
			} catch (error) {
				if (!(runtime.isStructuredOutputValidationError(error))) {
					throw error;
				}
				lastValidationError = error;
				fallbackDescription ??= normalizeAvatarDescriptionText(error.outputText);
				if (attempt < providerAvatarDescriptionMaxAttempts) {
					messages.push(...avatarDescriptionRepairMessages(error, mode));
					continue;
				}
				const fallback = normalizeAvatarDescriptionText(error.outputText) ?? fallbackDescription;
				if (fallback) {
					await options.stream?.assistantDelta(prefill ? `\n\n${fallback}` : fallback);
					return fallback;
				}
			}
		}
			const repairMessage = lastValidationError?.repairMessage ?? 'Provider avatar description response did not call the required tool.';
			if (mode === 'structured_output') {
				throw new ProviderAvatarDescriptionValidationError(
					repairMessage,
					lastValidationError ? { rawResponse: lastValidationError.rawResponse } : {},
				);
			}
			throw runtime.requestError(
				502,
				settings.model,
				endpoint,
				repairMessage,
				lastValidationError ? { rawResponse: lastValidationError.rawResponse } : {},
			);
		}

	function providerAvatarDescriptionFromResponseMessage(message: unknown, rawResponse: string, mode: ProviderCompactionMode): string {
		return runtime.singleStringResponseFromMessage(message, providerAvatarDescriptionSpec(), rawResponse, mode).trim();
	}

	function normalizeAvatarDescriptionText(value: unknown): string | null {
		if (typeof value !== 'string') {
			return null;
		}
		const trimmed = value.trim();
		if (!trimmed) {
			return null;
		}
		if (trimmed.length > 8_000) {
			return trimmed.slice(0, 8_000).trim();
		}
		return trimmed;
	}

	function avatarDescriptionRepairMessages(error: ProviderStructuredOutputValidationError, mode: ProviderCompactionMode): ChatMessage[] {
		if (mode === 'structured_output') {
			return [
				...(error.outputText ? [{ role: 'assistant' as const, content: error.outputText }] : []),
				{
					role: 'user',
					content:
						'Bickr Terminal still needs the profile image description as the required JSON object with exactly one field named description. The description must be first person, in character, and focused only on visible appearance, style, scene, lighting, and composition.',
				},
			];
		}
		if (error.toolCalls.length === 0) {
			return [
				...(error.outputText ? [{ role: 'assistant' as const, content: error.outputText }] : []),
				{
					role: 'user',
					content: `Bickr Terminal still needs me to call ${providerAvatarDescriptionToolName}. The description must be first person, in character, and focused only on visible appearance, style, scene, lighting, and composition.`,
				},
			];
		}
		const content = JSON.stringify({
			ok: false,
			message: error.repairMessage,
		});
		return [
			{
				role: 'assistant',
				content: '',
				tool_calls: error.toolCalls,
			},
			...error.toolCalls.map(
				(toolCall): ChatMessage => ({
					role: 'tool',
					tool_call_id: toolCall.id,
					content,
				}),
			),
		];
	}


	return {
		generateImage: fetchProviderAvatarImage,
		describeCurrentAvatar: fetchProviderCurrentAvatarDescription,
		describeParticipant: fetchProviderAvatarDescription,
		describeWorld: fetchProviderWorldAvatarDescription,
		describeWorldMembers: fetchProviderWorldAvatarMembersDescription,
		invalidGeneratedImage(settings, error) {
			return runtime.requestError(
				502,
				settings.model,
				runtime.chatCompletionsUrl(settings.baseUrl),
				`Provider returned an invalid generated avatar image. ${error.message}`,
			);
		},
		streamChunk: providerAvatarImageStreamChunk,
	};
}

function runtimeRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value : undefined;
}

function stringArrayValue(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function numberValue(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isAbortError(error: unknown): boolean {
	return Boolean(error && typeof error === 'object' && 'name' in error && (error as { name?: unknown }).name === 'AbortError');
}
