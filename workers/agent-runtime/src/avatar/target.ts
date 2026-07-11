import {
	avatarImageGenerationSettingsWithDefaults,
	worldAvatarImageGenerationSettingsWithDefaults,
	type AvatarImage,
	type BotDocument,
	type BotInferenceSettings,
	type JsonObject,
	type LanguageTag,
	type UserDocument,
	type WorldDocument,
	localizedTextLang,
} from '@bickr/shared/model';
import { isOpenRouterProviderBaseUrl } from '../prompt-and-tools';
import { botById, RepositoryError, userById, worldByHandle } from '@bickr/shared/repository';
import { kvKeys, readJson, type D1DatabaseLike, type KVNamespaceLike } from '@bickr/shared/storage';

export type AvatarTargetKind = 'bot' | 'user' | 'world';

export type AvatarTargetReference =
	| { kind: 'bot'; userId: string; botId: string }
	| { kind: 'user'; userId: string }
	| { kind: 'world'; userId: string; worldHandle: string };

export type AvatarTargetAction = 'generate' | 'prepare' | 'update';

type AvatarTargetSettings = {
	imageGeneration: BotInferenceSettings['imageGeneration'];
	owner: BotInferenceSettings;
	provider: BotInferenceSettings;
	withDefaults: typeof avatarImageGenerationSettingsWithDefaults;
};

type AvatarTargetBase = {
	avatar?: AvatarImage;
	capabilities: {
		promptFill: readonly ('persona' | 'description' | 'members' | 'current_avatar')[];
		providerImageTarget: 'participant' | 'world';
	};
	currentAvatarErrors: {
		describe: string;
		include: string;
	};
	language: LanguageTag | null;
	owner: UserDocument;
	settings: AvatarTargetSettings;
};

export type BotAvatarTarget = AvatarTargetBase & {
	bot: BotDocument;
	kind: 'bot';
	storage: { botId: string; worldId: string };
};

export type UserAvatarTarget = AvatarTargetBase & {
	kind: 'user';
	storage: { target: 'user'; userId: string };
	user: UserDocument;
};

export type WorldAvatarTarget = AvatarTargetBase & {
	kind: 'world';
	storage: { target: 'world'; worldId: string };
	world: WorldDocument;
};

export type AvatarTarget = BotAvatarTarget | UserAvatarTarget | WorldAvatarTarget;

export type AvatarProviderEnvironment = {
	OPENROUTER_API_KEY?: string;
	OPENROUTER_BASE_URL?: string;
	OPENROUTER_MODEL?: string;
};

export type AvatarRepositoryEnvironment = AvatarProviderEnvironment & {
	BICKR_D1: D1DatabaseLike;
	BICKR_KV: KVNamespaceLike;
};

export type ImageGenerationProviderSettings = {
	apiKey?: string;
	baseUrl: string;
	model: string;
	providerRouting?: JsonObject;
	aspectRatio?: string;
	imageSize?: string;
	temperature?: number;
	topK?: number;
	topP?: number;
	minP?: number;
	frequencyPenalty?: number;
	presencePenalty?: number;
	repetitionPenalty?: number;
};

const fallbackProviderBaseUrl = 'https://openrouter.ai/api/v1';

export async function resolveAvatarTarget(
	env: AvatarRepositoryEnvironment,
	reference: Extract<AvatarTargetReference, { kind: 'bot' }>,
	action: AvatarTargetAction,
): Promise<BotAvatarTarget>;
export async function resolveAvatarTarget(
	env: AvatarRepositoryEnvironment,
	reference: Extract<AvatarTargetReference, { kind: 'user' }>,
	action: AvatarTargetAction,
): Promise<UserAvatarTarget>;
export async function resolveAvatarTarget(
	env: AvatarRepositoryEnvironment,
	reference: Extract<AvatarTargetReference, { kind: 'world' }>,
	action: AvatarTargetAction,
): Promise<WorldAvatarTarget>;
export async function resolveAvatarTarget(
	env: AvatarRepositoryEnvironment,
	reference: AvatarTargetReference,
	action: AvatarTargetAction,
): Promise<AvatarTarget>;
export async function resolveAvatarTarget(
	env: AvatarRepositoryEnvironment,
	reference: AvatarTargetReference,
	action: AvatarTargetAction,
): Promise<AvatarTarget> {
	switch (reference.kind) {
		case 'bot': {
			const bot = await botById(env.BICKR_KV, env.BICKR_D1, reference.botId);
			if (bot.ownerUserId !== reference.userId) {
				const verb = action === 'generate' ? 'generate an avatar' : action === 'prepare' ? 'prepare an avatar prompt' : 'update its avatar';
				throw new RepositoryError('forbidden', `Only this participant's owner can ${verb}.`, 403);
			}
			const owner = await userById(env.BICKR_KV, reference.userId);
			return {
				kind: 'bot',
				bot,
				owner,
				avatar: bot.avatar,
				language: effectiveAvatarSettingsLanguage(bot.language, bot.displayName),
				settings: {
					imageGeneration: bot.inferenceSettings.imageGeneration,
					owner: owner.inferenceSettings ?? {},
					provider: bot.inferenceSettings,
					withDefaults: avatarImageGenerationSettingsWithDefaults,
				},
				storage: { botId: bot.id, worldId: bot.homeWorldId },
				capabilities: {
					promptFill: ['persona', 'current_avatar'],
					providerImageTarget: 'participant',
				},
				currentAvatarErrors: {
					include: 'The current avatar cannot be included because this participant does not have one.',
					describe: 'The current avatar cannot be described because this participant does not have one.',
				},
			};
		}
		case 'user': {
			const user = await userById(env.BICKR_KV, reference.userId);
			const settings = user.inferenceSettings ?? {};
			return {
				kind: 'user',
				user,
				owner: user,
				avatar: user.avatar,
				language: effectiveAvatarSettingsLanguage(user.language, user.displayName),
				settings: {
					imageGeneration: settings.imageGeneration,
					owner: settings,
					provider: {},
					withDefaults: avatarImageGenerationSettingsWithDefaults,
				},
				storage: { target: 'user', userId: user.id },
				capabilities: {
					promptFill: ['current_avatar'],
					providerImageTarget: 'participant',
				},
				currentAvatarErrors: {
					include: 'The current avatar cannot be included because your profile does not have one.',
					describe: 'The current avatar cannot be described because your profile does not have one.',
				},
			};
		}
		case 'world': {
			const world = await worldDocumentForAvatar(env, reference.worldHandle, reference.userId, action);
			const owner = await userById(env.BICKR_KV, reference.userId);
			return {
				kind: 'world',
				world,
				owner,
				avatar: world.avatar,
				language: effectiveAvatarSettingsLanguage(world.language, world.name),
				settings: {
					imageGeneration: world.imageGeneration,
					owner: owner.inferenceSettings ?? {},
					provider: {},
					withDefaults: worldAvatarImageGenerationSettingsWithDefaults,
				},
				storage: { target: 'world', worldId: world.id },
				capabilities: {
					promptFill: ['description', 'members', 'current_avatar'],
					providerImageTarget: 'world',
				},
				currentAvatarErrors: {
					include: 'The current avatar cannot be included because this world does not have one.',
					describe: 'The current avatar cannot be described because this world does not have one.',
				},
			};
		}
	}
}

export function effectiveProviderSettingsForAvatarImageGeneration(
	target: AvatarTarget,
	env: AvatarProviderEnvironment,
	settingsOverride?: BotInferenceSettings['imageGeneration'],
): ImageGenerationProviderSettings | null {
	const ownerSettings = target.settings.owner;
	const targetProviderSettings = target.settings.provider;
	const imageGeneration = target.settings.withDefaults(settingsOverride ?? target.settings.imageGeneration ?? ownerSettings.imageGeneration);
	const model = trimmed(imageGeneration?.model);
	if (!model) {
		return null;
	}
	const ownerBaseUrl = trimmed(ownerSettings.baseUrl);
	const targetBaseUrl = trimmed(targetProviderSettings.baseUrl);
	const envBaseUrl = trimmed(env.OPENROUTER_BASE_URL);
	const ownerApiKey = trimmed(ownerSettings.openRouterApiKey);
	const targetApiKey = trimmed(targetProviderSettings.openRouterApiKey);
	const envApiKey = trimmed(env.OPENROUTER_API_KEY);
	const hasCustomBaseUrl = Boolean(targetBaseUrl || ownerBaseUrl);
	const baseUrl = targetBaseUrl ?? ownerBaseUrl ?? envBaseUrl ?? fallbackProviderBaseUrl;
	const providerRouting = openRouterProviderRouting(baseUrl, imageGeneration.providerRouting);
	return {
		apiKey: targetApiKey ?? ownerApiKey ?? (hasCustomBaseUrl ? undefined : envApiKey),
		baseUrl,
		model,
		...(providerRouting ? { providerRouting } : {}),
		...(trimmed(imageGeneration.aspectRatio) ? { aspectRatio: trimmed(imageGeneration.aspectRatio) } : {}),
		...(trimmed(imageGeneration.imageSize) ? { imageSize: trimmed(imageGeneration.imageSize) } : {}),
		...(imageGeneration.temperature !== undefined ? { temperature: imageGeneration.temperature } : {}),
		...(imageGeneration.topK !== undefined ? { topK: imageGeneration.topK } : {}),
		...(imageGeneration.topP !== undefined ? { topP: imageGeneration.topP } : {}),
		...(imageGeneration.minP !== undefined ? { minP: imageGeneration.minP } : {}),
		...(imageGeneration.frequencyPenalty !== undefined ? { frequencyPenalty: imageGeneration.frequencyPenalty } : {}),
		...(imageGeneration.presencePenalty !== undefined ? { presencePenalty: imageGeneration.presencePenalty } : {}),
		...(imageGeneration.repetitionPenalty !== undefined ? { repetitionPenalty: imageGeneration.repetitionPenalty } : {}),
	};
}

export async function worldDocumentForAvatar(
	env: Pick<AvatarRepositoryEnvironment, 'BICKR_KV' | 'BICKR_D1'>,
	worldHandle: string,
	userId: string,
	action: AvatarTargetAction,
): Promise<WorldDocument> {
	const worldRef = await worldByHandle(env.BICKR_D1, worldHandle);
	const world = await readJson<WorldDocument>(env.BICKR_KV, kvKeys.world(worldRef.id));
	if (!world || world.deletedAt) {
		throw new RepositoryError('not_found', 'World not found.', 404);
	}
	if (world.createdByUserId !== userId) {
		const verb = action === 'generate' ? 'generate an avatar for' : action === 'prepare' ? 'prepare an avatar prompt for' : 'update';
		throw new RepositoryError('forbidden', `Only this world's owner can ${verb} it.`, 403);
	}
	return { ...world, prompt: world.prompt ?? '' };
}

function effectiveAvatarSettingsLanguage(language: LanguageTag | null | undefined, fallback: BotDocument['displayName']): LanguageTag | null {
	return language ?? localizedTextLang(fallback) ?? ('en' as LanguageTag);
}

function openRouterProviderRouting(baseUrl: string, providerRouting: JsonObject | undefined): JsonObject | undefined {
	if (!providerRouting || Object.keys(providerRouting).length === 0 || !isOpenRouterProviderBaseUrl(baseUrl)) {
		return undefined;
	}
	return providerRouting;
}

function trimmed(value: string | undefined): string | undefined {
	const result = value?.trim();
	return result ? result : undefined;
}
