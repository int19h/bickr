import {
	defaultBickrInferenceDefaults,
	inferenceGraphGlobalCredentialVersion,
	inferenceResolutionFingerprint,
	resolveImageSettingsForTarget,
	resolveInferenceConfiguration,
	type AvatarInferenceTarget,
	type BickrInferenceDefaults,
	type InferenceResolution,
} from "./inference-configuration";
import {
	accountDefaultConfigurationId,
	botConfigurationId,
	inferenceGraphReadVersion,
	loadInternalInferenceConfigurationPath,
	loadInternalInferenceCompatibilityProjectionPath,
	readCompatibilityProjectionTranslationSelection,
	readTranslationSelection,
	worldConfigurationId,
} from "./inference-configuration-repository";
import {
	isOpenRouterProviderBaseUrl,
	providerEnvironmentSettingsFromBindings,
	type ProviderEnvironmentBindings,
	type ProviderSettings,
} from "./inference-settings";
import type { TranslationInferenceAnnotation } from "./model";
import { RepositoryError } from "./repository";
import type { D1DatabaseLike } from "./storage";

export type CanonicalInferenceConsumer = "account" | "bot" | "world" | "translation";

export type CanonicalInferenceConsumerResolution = {
	consumer: CanonicalInferenceConsumer;
	resolution: InferenceResolution;
	providerSettings: ProviderSettings;
	fingerprint: string;
};

export async function canonicalBotInference(
	db: D1DatabaseLike,
	ownerUserId: string,
	botId: string,
	env: ProviderEnvironmentBindings,
): Promise<CanonicalInferenceConsumerResolution | null> {
	return canonicalFixedInference(db, ownerUserId, await botConfigurationId(botId), "bot", env);
}

export async function canonicalAccountInference(
	db: D1DatabaseLike,
	ownerUserId: string,
	env: ProviderEnvironmentBindings,
): Promise<CanonicalInferenceConsumerResolution | null> {
	return canonicalFixedInference(db, ownerUserId, await accountDefaultConfigurationId(ownerUserId), "account", env);
}

export async function canonicalWorldInference(
	db: D1DatabaseLike,
	ownerUserId: string,
	worldId: string,
	env: ProviderEnvironmentBindings,
): Promise<CanonicalInferenceConsumerResolution | null> {
	return canonicalFixedInference(db, ownerUserId, await worldConfigurationId(worldId), "world", env);
}

export async function canonicalTranslationInference(
	db: D1DatabaseLike,
	ownerUserId: string,
	env: ProviderEnvironmentBindings,
): Promise<CanonicalInferenceConsumerResolution | null> {
	const version = await inferenceGraphReadVersion(db, ownerUserId);
	if (version.cutoverVersion === 0) return null;
	const selection = version.cutoverVersion === 2
		? await readCompatibilityProjectionTranslationSelection(db, ownerUserId, version.graphRevision)
		: await readTranslationSelection(db, ownerUserId);
	return resolvedConsumer(db, ownerUserId, selection.configurationId, "translation", env, version);
}

export async function canonicalTranslationInferenceAnnotation(
	db: D1DatabaseLike,
	ownerUserId: string,
	env: ProviderEnvironmentBindings,
): Promise<TranslationInferenceAnnotation | null> {
	const version = await inferenceGraphReadVersion(db, ownerUserId);
	if (version.cutoverVersion === 0) return null;
	const selection = version.cutoverVersion === 2
		? await readCompatibilityProjectionTranslationSelection(db, ownerUserId, version.graphRevision)
		: await readTranslationSelection(db, ownerUserId);
	const consumer = await resolvedConsumer(db, ownerUserId, selection.configurationId, "translation", env, version);
	const selected = consumer.resolution.path[0];
	// The selector accepts only Account default and custom entries, and both the
	// repository writer and the migration enforce that. A world/participant
	// entry here is a corrupt selection, not a label this annotation composes.
	if (selected.kind !== "account_default" && selected.kind !== "custom") {
		throw new RepositoryError("server_error", "Translation inference selection is not an Account default or custom configuration.", 500);
	}
	return {
		selectedConfigurationId: selected.id,
		selectedDisplayName: selected.kind === "account_default" ? "Account default" : selected.name,
		selectionRevision: selection.revision,
		effectiveModel: consumer.resolution.effective.model,
		effectiveRevisionFingerprint: consumer.fingerprint,
		credentialAvailable: consumer.resolution.effective.credential.kind === "available",
	};
}

async function canonicalFixedInference(
	db: D1DatabaseLike,
	ownerUserId: string,
	configurationId: string,
	consumer: Exclude<CanonicalInferenceConsumer, "translation">,
	env: ProviderEnvironmentBindings,
): Promise<CanonicalInferenceConsumerResolution | null> {
	const version = await inferenceGraphReadVersion(db, ownerUserId);
	if (version.cutoverVersion === 0) return null;
	return resolvedConsumer(db, ownerUserId, configurationId, consumer, env, version);
}

async function resolvedConsumer(
	db: D1DatabaseLike,
	ownerUserId: string,
	configurationId: string,
	consumer: CanonicalInferenceConsumer,
	env: ProviderEnvironmentBindings,
	version: Awaited<ReturnType<typeof inferenceGraphReadVersion>>,
): Promise<CanonicalInferenceConsumerResolution> {
	const path = version.cutoverVersion === 2
		? await loadInternalInferenceCompatibilityProjectionPath(db, ownerUserId, configurationId, version.graphRevision)
		: await loadInternalInferenceConfigurationPath(db, ownerUserId, configurationId);
	const resolution = resolveInferenceConfiguration(path, { defaults: await bickrInferenceDefaultsFromEnvironment(env) });
	return {
		consumer,
		resolution,
		providerSettings: providerSettingsFromResolution(resolution),
		fingerprint: await inferenceResolutionFingerprint(resolution, { selectedConfigurationId: configurationId }),
	};
}

export async function bickrInferenceDefaultsFromEnvironment(env: ProviderEnvironmentBindings): Promise<BickrInferenceDefaults> {
	const provider = providerEnvironmentSettingsFromBindings(env);
	return {
		fields: {
			...defaultBickrInferenceDefaults.fields,
			...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
			...(provider.model ? { model: provider.model } : {}),
		},
		...(provider.apiKey ? { credential: provider.apiKey } : {}),
			// This is an explicit, non-secret deployment version. It must advance when
			// the global credential rotates; public cache keys must never depend on a
			// digest (or any other transform) of secret bytes.
			credentialVersion: provider.apiKey ? inferenceGraphGlobalCredentialVersion : 0,
		};
}

export function providerSettingsFromResolution(resolution: InferenceResolution): ProviderSettings {
	const effective = resolution.effective;
	const credential = effective.credential.kind === "available" ? effective.credential.secret : undefined;
	const baseSource = resolution.raw.baseUrl.source;
	const compactionReasoning = resolution.raw.compactionReasoning.state === "value"
		? resolution.raw.compactionReasoning.value
		: undefined;
	return {
		...(credential ? { apiKey: credential } : {}),
		baseUrl: effective.baseUrl,
		model: effective.model,
		compactionMode: effective.compactionMode,
		...(compactionReasoning ? { compactionReasoning } : {}),
		...(effective.promptCacheMode !== "off" ? { promptCacheMode: effective.promptCacheMode } : {}),
		...(effective.providerRouting ? { providerRouting: effective.providerRouting } : {}),
		...(effective.reasoningEffort ? { reasoningEffort: effective.reasoningEffort } : {}),
		supportsPrefill: effective.supportsPrefill,
		toolCalls: effective.toolCalls,
		temperature: effective.temperature,
		...(baseSource.kind !== "bickr_default" ? { usesCustomBaseUrl: true } : {}),
		...(effective.topK !== undefined ? { topK: effective.topK } : {}),
		...(effective.topP !== undefined ? { topP: effective.topP } : {}),
		...(effective.minP !== undefined ? { minP: effective.minP } : {}),
		...(effective.frequencyPenalty !== undefined ? { frequencyPenalty: effective.frequencyPenalty } : {}),
		...(effective.presencePenalty !== undefined ? { presencePenalty: effective.presencePenalty } : {}),
		...(effective.repetitionPenalty !== undefined ? { repetitionPenalty: effective.repetitionPenalty } : {}),
	};
}

export function translationToolCallStrategy(
	strategy: ProviderSettings["toolCalls"],
): Exclude<NonNullable<ProviderSettings["toolCalls"]>, "at_will"> | undefined {
	return strategy === "at_will" ? "railroad" : strategy;
}

export type CanonicalAvatarImageSettings = ReturnType<typeof resolveImageSettingsForTarget> & {
	apiKey?: string;
	baseUrl: string;
	model: string;
};

export function canonicalAvatarImageSettings(
	consumer: CanonicalInferenceConsumerResolution,
	target: AvatarInferenceTarget,
): CanonicalAvatarImageSettings | null {
	const image = resolveImageSettingsForTarget(consumer.resolution.effective.image, target);
	if (!image.model) return null;
	const rawModel = consumer.resolution.effective.image.model;
	const credential = consumer.resolution.effective.credential;
	const ownerProviderAvailable = consumer.resolution.raw.baseUrl.source.kind !== "bickr_default" ||
		credential.kind === "available" && credential.source.kind !== "bickr_default";
	// Only an owner-stored model value is gated. target_default names Bickr's own
	// per-target default, so the configuration that stores it is the location of
	// the intent, not the origin of the model; treating it as owner-selected
	// would refuse image generation that the same settings always allowed.
	const ownerSelectedModel = rawModel.state === "value" && rawModel.source.kind !== "bickr_default";
	if (ownerSelectedModel && !ownerProviderAvailable) return null;
	const providerRouting = image.providerRouting && Object.keys(image.providerRouting).length > 0 &&
		isOpenRouterProviderBaseUrl(consumer.providerSettings.baseUrl)
		? image.providerRouting
		: undefined;
	const { providerRouting: _rawProviderRouting, ...normalizedImage } = image;
	return {
		...(consumer.providerSettings.apiKey ? { apiKey: consumer.providerSettings.apiKey } : {}),
		baseUrl: consumer.providerSettings.baseUrl,
		...normalizedImage,
		...(providerRouting ? { providerRouting } : {}),
		model: image.model,
	};
}
