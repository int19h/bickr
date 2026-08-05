import {
	isAvatarContentType,
	normalizeAvatarPublicBaseUrl,
	promoteAvatarCandidate,
	storeAvatarImage,
	validateAvatarDataUrl,
	type R2BucketLike,
} from '@bickr/shared/avatar-storage';
import {
	mergeInferenceSettings,
	listWorldBots,
	botById,
	RepositoryError,
	userById,
} from '@bickr/shared/repository';
import {
	type AvatarImage,
	type BotDocument,
	type BotInferenceSettings,
	type BotInferenceSettingsInput,
	type BotSummary,
	type LanguageTag,
	type UserDocument,
	type UserProfile,
	type WorldDocument,
	type WorldSummary,
} from '@bickr/shared/model';
import { InputError, parseUpdateBotInput, requiredText } from '@bickr/shared/validation';
import type { ProviderSettings } from '../provider-requests';
import {
	effectiveProviderSettingsForAvatarImageGeneration,
	resolveAvatarTarget,
	type AvatarProviderEnvironment,
	type AvatarRepositoryEnvironment,
	type AvatarTarget,
	type AvatarTargetReference,
	type ImageGenerationProviderSettings,
	worldDocumentForAvatar,
} from './target';

export type AvatarGenerationInput = {
	prompt: string;
	includeCurrentAvatar: boolean;
	settings?: unknown;
};

export type AvatarPromptInput = {
	mode: 'persona' | 'description' | 'members' | 'current_avatar';
	prefill?: string;
	imageSettings?: unknown;
	promptSettings?: unknown;
};

export type AvatarGenerationDisplayMessage = {
	role: 'system' | 'user' | 'assistant';
	content: string;
};

export type AvatarGenerationStreamSink = {
	messages: (messages: AvatarGenerationDisplayMessage[]) => void | Promise<void>;
	assistantDelta: (text: string) => void | Promise<void>;
	assistantImage: (count: number) => void | Promise<void>;
};

export type ProviderAvatarImageStreamChunk = {
	content: string;
	dataUrls: string[];
	usage?: {
		promptTokens: number;
		completionTokens: number;
		totalTokens: number;
		cachedTokens: number;
		reasoningTokens: number;
		cost: number | null;
		raw: Record<string, unknown>;
	};
	responseId?: string;
	responseModel?: string;
	responseProviderName?: string;
};

export type AvatarProvider = {
	generateImage(
		settings: ImageGenerationProviderSettings,
		input: { prompt: string; currentAvatarUrl?: string },
		options?: { signal?: AbortSignal; stream?: AvatarGenerationStreamSink; target?: 'participant' | 'world' },
	): Promise<{ dataUrl: string; cost: number | null }>;
	describeCurrentAvatar(
		settings: ImageGenerationProviderSettings,
		currentAvatarUrl: string,
		options?: { signal?: AbortSignal; stream?: AvatarGenerationStreamSink; target?: 'participant' | 'world' },
	): Promise<string>;
	describeParticipant(
		settings: ProviderSettings,
		bot: BotDocument,
		options?: { prefill?: string; signal?: AbortSignal; stream?: AvatarGenerationStreamSink },
	): Promise<string>;
	describeWorld(
		settings: ProviderSettings,
		world: WorldDocument,
		options?: { prefill?: string; signal?: AbortSignal; stream?: AvatarGenerationStreamSink },
	): Promise<string>;
	describeWorldMembers(
		settings: ProviderSettings,
		world: WorldDocument,
		members: readonly BotSummary[],
		options?: { prefill?: string; signal?: AbortSignal; stream?: AvatarGenerationStreamSink },
	): Promise<string>;
	invalidGeneratedImage(settings: ImageGenerationProviderSettings, error: InputError): Error;
	streamChunk(chunk: unknown): ProviderAvatarImageStreamChunk;
};

export type AvatarPromptSettingsRuntime = {
	effectiveProviderSettingsForBot(
		bot: Pick<BotDocument, 'inferenceSettings'>,
		owner: Pick<UserDocument, 'inferenceSettings'>,
		env: AvatarProviderEnvironment,
	): ProviderSettings;
	effectiveProviderSettingsForWorldPrompt(
		owner: Pick<UserDocument, 'inferenceSettings'>,
		env: AvatarProviderEnvironment,
		settingsOverride?: BotInferenceSettingsInput,
	): ProviderSettings;
	publicPromptProviderSettings(settings: ProviderSettings): BotInferenceSettings;
};

export type AvatarEnvironment = AvatarRepositoryEnvironment & {
	BICKR_R2?: R2BucketLike;
	BICKR_R2_PUBLIC_BASE_URL?: string;
};

export function parseAvatarGenerationInput(input: unknown): AvatarGenerationInput {
	const record = runtimeRecord(input);
	const prompt = typeof record.prompt === 'string' ? record.prompt : '';
	const includeCurrentAvatar = record.includeCurrentAvatar === true;
	if (prompt.length > 8_000) {
		throw new InputError('Avatar prompt must be 8000 characters or fewer.');
	}
	if (!prompt.trim() && !includeCurrentAvatar) {
		throw new InputError('Avatar prompt is required unless the current avatar is included.');
	}
	return {
		prompt,
		includeCurrentAvatar,
		...(record.settings !== undefined ? { settings: record.settings } : {}),
	};
}

export function parseImageGenerationSettingsOverride(
	value: unknown,
	language: LanguageTag | null,
): BotInferenceSettings['imageGeneration'] | undefined {
	if (value === undefined) {
		return undefined;
	}
	return mergeInferenceSettings(
		undefined,
		parseUpdateBotInput({ language, inferenceSettings: { imageGeneration: value } }).inferenceSettings,
	).imageGeneration;
}

export function parseAvatarPromptInput(input: unknown): AvatarPromptInput {
	const record = runtimeRecord(input);
	const mode =
		record.mode === 'current_avatar' ? 'current_avatar'
		: record.mode === 'description' ? 'description'
		: record.mode === 'members' ? 'members'
		: 'persona';
	const prefill = typeof record.prefill === 'string' ? record.prefill : '';
	if (prefill.length > 8_000) {
		throw new InputError('Avatar prompt prefill must be 8000 characters or fewer.');
	}
	const imageSettings = mode === 'current_avatar' ? record.settings : undefined;
	const promptSettings = mode === 'description' || mode === 'members' ? record.settings : undefined;
	// An owner client carries no image settings: the target's configuration
	// resolves them. A missing image model is still reported, by the resolution
	// below, rather than by a precondition on a request field.
	return {
		mode,
		...(prefill.trim() ? { prefill } : {}),
		...(imageSettings !== undefined ? { imageSettings } : {}),
		...(promptSettings !== undefined ? { promptSettings } : {}),
	};
}

export function parseAvatarCandidate(value: unknown): AvatarImage {
	const record = runtimeRecord(value);
	const key = requiredText(record.key, 'Avatar candidate key', 500);
	if (!key.includes('/avatar-candidates/')) {
		throw new InputError('Avatar candidate key is invalid.');
	}
	const url = requiredText(record.url, 'Avatar candidate URL', 1_000);
	const contentType = requiredText(record.contentType, 'Avatar candidate content type', 80);
	const updatedAt = requiredText(record.updatedAt, 'Avatar candidate timestamp', 80);
	if (!isAvatarContentType(contentType)) {
		throw new InputError('Avatar candidate content type is invalid.');
	}
	const sourceRecord = runtimeRecord(record.source);
	const generatedCost = numberValue(sourceRecord.cost);
	const generatedSource =
		sourceRecord.type === 'generated'
			? {
					type: 'generated' as const,
					model: requiredText(sourceRecord.model, 'Avatar generation model', 160),
					generatedAt: requiredText(sourceRecord.generatedAt, 'Avatar generation timestamp', 80),
					...(generatedCost !== undefined ? { cost: generatedCost } : {}),
					...(typeof sourceRecord.prompt === 'string' && sourceRecord.prompt.trim() ? { prompt: sourceRecord.prompt } : {}),
				}
			: undefined;
	return {
		key,
		url,
		contentType,
		updatedAt,
		...(typeof record.byteLength === 'number' ? { byteLength: record.byteLength } : {}),
		...(typeof record.width === 'number' ? { width: record.width } : {}),
		...(typeof record.height === 'number' ? { height: record.height } : {}),
		...(generatedSource ? { source: generatedSource } : {}),
	};
}

export async function generateAvatar(
	env: AvatarEnvironment,
	reference: AvatarTargetReference,
	input: AvatarGenerationInput,
	provider: AvatarProvider,
	options: { signal?: AbortSignal; stream?: AvatarGenerationStreamSink } = {},
): Promise<AvatarImage> {
	const target = await resolveAvatarTarget(env, reference, 'generate');
	if (input.includeCurrentAvatar && !target.avatar?.url) {
		throw new InputError(target.currentAvatarErrors.include);
	}
	const settingsOverride = parseImageGenerationSettingsOverride(input.settings, target.language);
	const settings = effectiveProviderSettingsForAvatarImageGeneration(target, env, settingsOverride);
	if (!settings) {
		throw new InputError('Choose an image generation model before generating an avatar.');
	}
	const generatedImage = await provider.generateImage(
		settings,
		{
			prompt: input.prompt,
			currentAvatarUrl: input.includeCurrentAvatar ? target.avatar?.url : undefined,
		},
		{ ...options, target: target.capabilities.providerImageTarget },
	);
	let validated: ReturnType<typeof validateAvatarDataUrl>;
	try {
		validated = validateAvatarDataUrl(generatedImage.dataUrl);
	} catch (error) {
		if (error instanceof InputError) {
			throw provider.invalidGeneratedImage(settings, error);
		}
		throw error;
	}
	return storeAvatarImage(requireAvatarBucket(env), {
		...target.storage,
		bytes: validated.bytes,
		contentType: validated.contentType,
		publicBaseUrl: normalizeAvatarPublicBaseUrl(env.BICKR_R2_PUBLIC_BASE_URL),
		source: {
			type: 'generated',
			model: settings.model,
			generatedAt: new Date().toISOString(),
			...(generatedImage.cost !== null ? { cost: generatedImage.cost } : {}),
			...(input.prompt.trim() ? { prompt: input.prompt } : {}),
		},
		kind: 'avatar-candidates',
	});
}

export function streamAvatarGeneration(
	env: AvatarEnvironment,
	reference: AvatarTargetReference,
	input: AvatarGenerationInput,
	provider: AvatarProvider,
	requestSignal: AbortSignal,
): Response {
	return streamAvatarOperation(requestSignal, 'Avatar generation aborted.', async (signal, stream) => {
		const candidate = await generateAvatar(env, reference, input, provider, { signal, stream });
		return { type: 'done', candidate };
	});
}

export async function prefillAvatarPrompt(
	env: AvatarEnvironment,
	reference: AvatarTargetReference,
	input: AvatarPromptInput,
	provider: AvatarProvider,
	runtime: AvatarPromptSettingsRuntime,
	options: { signal?: AbortSignal; stream?: AvatarGenerationStreamSink } = {},
): Promise<string> {
	const target = await resolveAvatarTarget(env, reference, 'prepare');
	if (input.mode === 'current_avatar') {
		if (!target.avatar?.url) {
			throw new InputError(target.currentAvatarErrors.describe);
		}
		const imageSettingsOverride = parseImageGenerationSettingsOverride(input.imageSettings, target.language);
		const settings = effectiveProviderSettingsForAvatarImageGeneration(target, env, imageSettingsOverride);
		if (!settings) {
			throw new InputError('Choose an image generation model before filling from the current avatar.');
		}
		return provider.describeCurrentAvatar(settings, target.avatar.url, {
			...options,
			target: target.capabilities.providerImageTarget,
		});
	}
	if (!target.capabilities.promptFill.includes(input.mode)) {
		if (target.kind === 'user') {
			throw new InputError('Human avatar prompt fill only supports the current avatar.');
		}
		throw new InputError('Avatar prompt fill mode is not supported for this target.');
	}
	return prefillTextAvatarPrompt(env, target, input, provider, runtime, options);
}

export function streamAvatarPrompt(
	env: AvatarEnvironment,
	reference: AvatarTargetReference,
	input: AvatarPromptInput,
	provider: AvatarProvider,
	runtime: AvatarPromptSettingsRuntime,
	requestSignal: AbortSignal,
): Response {
	return streamAvatarOperation(requestSignal, 'Prompt fill aborted.', async (signal, stream) => {
		const prompt = await prefillAvatarPrompt(env, reference, input, provider, runtime, { signal, stream });
		return { type: 'done', prompt };
	});
}

export async function worldAvatarPromptSettings(
	env: AvatarEnvironment,
	reference: Extract<AvatarTargetReference, { kind: 'world' }>,
	runtime: AvatarPromptSettingsRuntime,
): Promise<BotInferenceSettings> {
	const target = await resolveAvatarTarget(env, reference, 'prepare');
	return runtime.publicPromptProviderSettings(
		target.canonicalProviderSettings ?? runtime.effectiveProviderSettingsForWorldPrompt(target.owner, env),
	);
}

export async function applyGeneratedAvatarForBot(
	env: AvatarEnvironment,
	userId: string,
	botId: string,
	candidate: AvatarImage,
	persist: (botId: string, avatar: AvatarImage) => Promise<BotSummary>,
): Promise<BotSummary> {
	const bot = await botById(env.BICKR_KV, env.BICKR_D1, botId);
	if (bot.ownerUserId !== userId) {
		throw new RepositoryError('forbidden', "Only this participant's owner can update its avatar.", 403);
	}
	const avatar = await promoteAvatarCandidate(requireAvatarBucket(env), {
		botId: bot.id,
		worldId: bot.homeWorldId,
		candidate,
		publicBaseUrl: normalizeAvatarPublicBaseUrl(env.BICKR_R2_PUBLIC_BASE_URL),
		source: candidate.source,
	});
	const updated = await persist(bot.id, avatar);
	await deleteAvatarCandidate(env, candidate.key);
	return updated;
}

export async function applyGeneratedAvatarForUser(
	env: AvatarEnvironment,
	userId: string,
	candidate: AvatarImage,
	persist: (userId: string, avatar: AvatarImage) => Promise<UserProfile>,
): Promise<UserProfile> {
	const user = await userById(env.BICKR_KV, userId);
	const expectedPrefix = `users/${encodeURIComponent(user.id)}/avatar-candidates/`;
	if (!candidate.key.startsWith(expectedPrefix)) {
		throw new InputError('Avatar candidate key is invalid for this profile.');
	}
	const avatar = await promoteAvatarCandidate(requireAvatarBucket(env), {
		target: 'user',
		userId: user.id,
		candidate,
		publicBaseUrl: normalizeAvatarPublicBaseUrl(env.BICKR_R2_PUBLIC_BASE_URL),
		source: candidate.source,
	});
	const profile = await persist(user.id, avatar);
	await deleteAvatarCandidate(env, candidate.key);
	return profile;
}

export async function applyGeneratedAvatarForWorld(
	env: AvatarEnvironment,
	userId: string,
	worldHandle: string,
	candidate: AvatarImage,
	persist: (world: WorldDocument, avatar: AvatarImage) => Promise<WorldSummary>,
): Promise<WorldSummary> {
	const world = await worldDocumentForAvatar(env, worldHandle, userId, 'update');
	const avatar = await promoteAvatarCandidate(requireAvatarBucket(env), {
		target: 'world',
		worldId: world.id,
		candidate,
		publicBaseUrl: normalizeAvatarPublicBaseUrl(env.BICKR_R2_PUBLIC_BASE_URL),
		source: candidate.source,
	});
	const updated = await persist(world, avatar);
	await deleteAvatarCandidate(env, candidate.key);
	return updated;
}

function streamAvatarOperation(
	requestSignal: AbortSignal,
	abortMessage: string,
	run: (signal: AbortSignal, stream: AvatarGenerationStreamSink) => Promise<unknown>,
): Response {
	const encoder = new TextEncoder();
	const abortController = new AbortController();
	const abortFromRequest = () => abortController.abort();
	if (requestSignal.aborted) {
		abortController.abort();
	} else {
		requestSignal.addEventListener('abort', abortFromRequest, { once: true });
	}
	let closed = false;
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (event: unknown): void => {
				if (closed || abortController.signal.aborted) {
					return;
				}
				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
				} catch {
					closed = true;
					abortController.abort();
				}
			};
			try {
				send(await run(abortController.signal, {
					messages: (messages) => send({ type: 'messages', messages }),
					assistantDelta: (text) => send({ type: 'assistant_delta', text }),
					assistantImage: (count) => send({ type: 'assistant_image', count }),
				}));
			} catch (error) {
				if (abortController.signal.aborted || isStoppedError(error)) {
					send({ type: 'aborted', message: abortMessage });
				} else {
					send({ type: 'error', message: avatarGenerationStreamErrorMessage(error) });
				}
			} finally {
				requestSignal.removeEventListener('abort', abortFromRequest);
				if (!closed) {
					try {
						closed = true;
						controller.close();
					} catch {
						// The client may already have disconnected.
					}
				}
			}
		},
		cancel() {
			closed = true;
			abortController.abort();
			requestSignal.removeEventListener('abort', abortFromRequest);
		},
	});
	return new Response(stream, {
		headers: {
			'cache-control': 'no-store',
			'content-type': 'text/event-stream; charset=utf-8',
			'x-accel-buffering': 'no',
		},
	});
}

async function prefillTextAvatarPrompt(
	env: AvatarEnvironment,
	target: AvatarTarget,
	input: AvatarPromptInput,
	provider: AvatarProvider,
	runtime: AvatarPromptSettingsRuntime,
	options: { signal?: AbortSignal; stream?: AvatarGenerationStreamSink },
): Promise<string> {
	switch (target.kind) {
		case 'bot':
			return provider.describeParticipant(
				target.canonicalProviderSettings ?? runtime.effectiveProviderSettingsForBot(target.bot, target.owner, env),
				target.bot,
				{
				prefill: input.prefill,
				...options,
				},
			);
		case 'user':
			throw new InputError('Human avatar prompt fill only supports the current avatar.');
		case 'world': {
			const promptSettingsOverride = parseInferenceSettingsOverride(input.promptSettings, target.language);
			const settings = target.canonicalProviderSettings ??
				runtime.effectiveProviderSettingsForWorldPrompt(target.owner, env, promptSettingsOverride);
			if (input.mode === 'members') {
				const members = await listWorldBots(env.BICKR_KV, env.BICKR_D1, target.world.handle);
				return provider.describeWorldMembers(settings, target.world, members, { prefill: input.prefill, ...options });
			}
			return provider.describeWorld(settings, target.world, { prefill: input.prefill, ...options });
		}
	}
}

function parseInferenceSettingsOverride(value: unknown, language: LanguageTag | null): BotInferenceSettingsInput | undefined {
	if (value === undefined) {
		return undefined;
	}
	return parseUpdateBotInput({ language, inferenceSettings: value }).inferenceSettings;
}

function requireAvatarBucket(env: Pick<AvatarEnvironment, 'BICKR_R2'>): R2BucketLike {
	if (!env.BICKR_R2) {
		throw new InputError('BICKR_R2 must be configured before storing avatars.');
	}
	return env.BICKR_R2;
}

async function deleteAvatarCandidate(env: AvatarEnvironment, key: string): Promise<void> {
	await requireAvatarBucket(env)
		.delete(key)
		.catch(() => undefined);
}

function avatarGenerationStreamErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'Could not generate avatar.';
}

function isStoppedError(error: unknown): boolean {
	return Boolean(
		error &&
			typeof error === 'object' &&
			'name' in error &&
			((error as { name?: unknown }).name === 'AbortError' || (error as { name?: unknown }).name === 'TickStoppedError'),
	);
}

function runtimeRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function numberValue(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
