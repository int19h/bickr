import {
	effectiveCompactionModeForModel,
	effectiveReasoningEffortForModel,
	effectiveSupportsPrefillForModel,
	effectiveToolCallsForModel,
	modelSupportsPromptCacheControl,
	compactionReasoningCapabilitiesForModel,
	compactionReasoningPolicyForModel,
	resolveCompactionReasoningSelection,
	type CompactionReasoningFloor,
	type CompactionReasoningResolution,
} from "./openrouter-model-capabilities";
import {
	defaultProviderBaseUrl,
	defaultProviderModel,
	defaultTextGenerationTemperature,
	avatarImageGenerationSettingsWithDefaults,
	worldAvatarImageGenerationSettingsWithDefaults,
	type BotImageGenerationSettings,
	type BotCompactionMode,
	type BotCompactionReasoningEffort,
	type BotCompactionReasoningRequest,
	type BotInferenceReasoningEffort,
	type BotInferenceToolCalls,
	type BotPromptCacheMode,
	type JsonObject,
} from "./model";
import {
	inferenceConfigurationFields,
	inferenceFieldOverrideStates,
	numericInferenceFieldDomains,
	type InferenceFieldOverrideStates,
	type NumericInferenceConfigurationField,
} from "./inference-configuration-owner";
import { isOpenRouterProviderBaseUrl } from "./inference-settings";
import { sha256Hex } from "./ids";

export const inferenceGraphSchemaVersion = 1;
export const inferenceGraphCapabilityVersion = 1;
export const inferenceGraphGlobalDefaultsVersion = 1;
// Public fingerprints use this non-secret deployment token for the global
// credential. Bump it with every global credential rotation.
export const inferenceGraphGlobalCredentialVersion = 1;
export const inferenceConfigurationOwnerQuota = 10_000;
export const inferenceConfigurationCorruptionSentinel = inferenceConfigurationOwnerQuota + 1;

export type InferenceConfigurationKind = "account_default" | "translation" | "world" | "bot" | "custom";
export type StoredInferenceConfigurationKind = Exclude<InferenceConfigurationKind, "translation">;
export type InferenceConfigurationFixedRole = "translation";

/**
 * The fixed Translation role intentionally reuses the physical custom shape so
 * old projection readers can traverse it. This is the only adapter where that
 * storage compatibility detail crosses into the typed graph domain.
 */
export function inferenceConfigurationKindFromStorage(
	kind: StoredInferenceConfigurationKind,
	fixedRole: InferenceConfigurationFixedRole | null,
): InferenceConfigurationKind {
	if (fixedRole === "translation") {
		if (kind !== "custom") throw new InferenceConfigurationDataError("invalid_path", "The Translation role has an invalid stored kind.");
		return "translation";
	}
	return kind;
}
export type InferenceCredentialMode = "inherit" | "account_default" | "value" | "none";

export type InferenceReasoningRequest =
	| { kind: "provider_default" }
	| { kind: "reasoning_disabled" }
	| { kind: "explicit_effort"; effort: BotCompactionReasoningEffort };

export type InferenceToolCallRequest =
	| { kind: "provider_default" }
	| { kind: "strategy"; strategy: BotInferenceToolCalls };

export type InferenceCompactionModeRequest =
	| { kind: "provider_default" }
	| { kind: "mode"; mode: BotCompactionMode };

export type InferencePromptCacheRequest =
	| { kind: "provider_default" }
	| { kind: "mode"; mode: BotPromptCacheMode };

export type InferenceConfigurationFieldValues = {
	baseUrl: string;
	model: string;
	providerRouting: JsonObject;
	reasoning: InferenceReasoningRequest;
	compactionReasoning: BotCompactionReasoningRequest;
	toolCalls: InferenceToolCallRequest;
	compactionMode: InferenceCompactionModeRequest;
	promptCacheMode: InferencePromptCacheRequest;
	supportsPrefill: boolean;
	temperature: number;
	topK: number;
	topP: number;
	minP: number;
	frequencyPenalty: number;
	presencePenalty: number;
	repetitionPenalty: number;
	imageModel: string;
	imageProviderRouting: JsonObject;
	imageAspectRatio: string;
	imageSize: string;
	imageTemperature: number;
	imageTopK: number;
	imageTopP: number;
	imageMinP: number;
	imageFrequencyPenalty: number;
	imagePresencePenalty: number;
	imageRepetitionPenalty: number;
};

export type InferenceConfigurationField = keyof InferenceConfigurationFieldValues;

type ValueOnlyField =
	| "baseUrl"
	| "model"
	| "reasoning"
	| "compactionReasoning"
	| "toolCalls"
	| "compactionMode"
	| "promptCacheMode";

type ImageTargetDefaultField = "imageModel" | "imageAspectRatio" | "imageSize";

/**
 * Exact image models that Bickr previously supplied as its own default. This
 * list is deliberately immutable and exact: aliases, case variants, provider
 * suffixes, and future models do not acquire Bickr provenance accidentally.
 */
export const historicalBickrDefaultImageModels = [
	"google/gemini-3.1-flash-image-preview",
] as const;

export type HistoricalBickrDefaultImageModel = typeof historicalBickrDefaultImageModels[number];

export function isHistoricalBickrDefaultImageModel(value: unknown): value is HistoricalBickrDefaultImageModel {
	return typeof value === "string" && (historicalBickrDefaultImageModels as readonly string[]).includes(value);
}

/**
 * Only the base URL can resume raw resolution at Account default. A linked
 * clone whose local model made its whole local bundle live never consulted its
 * source's provider fields, so it must skip intervening parents without
 * materializing (and thereby re-attributing) a resolved URL.
 */
type AccountDefaultResumableField = "baseUrl";

export type StoredInferenceOverride<K extends InferenceConfigurationField> =
	| { kind: "value"; value: InferenceConfigurationFieldValues[K] }
	| (K extends ValueOnlyField ? never : { kind: "explicit_none" })
	| (K extends ImageTargetDefaultField ? { kind: "target_default" } : never)
	| (K extends "imageModel" ? { kind: "historical_bickr_default"; value: HistoricalBickrDefaultImageModel } : never)
	| (K extends AccountDefaultResumableField ? { kind: "account_default" } : never);

export type OwnerInferenceOverride<K extends InferenceConfigurationField> =
	Exclude<StoredInferenceOverride<K>, { kind: "historical_bickr_default" }>;

export type InferenceOverrideUpdate<K extends InferenceConfigurationField> =
	| { kind: "inherit" }
	| OwnerInferenceOverride<K>;

export type InferenceConfigurationOverrides = {
	[K in InferenceConfigurationField]?: StoredInferenceOverride<K>;
};

export type OwnerInferenceConfigurationOverrides = {
	[K in InferenceConfigurationField]?: OwnerInferenceOverride<K>;
};

export type InferenceConfigurationOverridePatch = {
	[K in InferenceConfigurationField]?: InferenceOverrideUpdate<K>;
};

type ConfigurationNodeBase = {
	id: string;
	ownerUserId: string;
	parentId: string | null;
	overrides: InferenceConfigurationOverrides;
	revision: number;
	createdAt: string;
	updatedAt: string;
	credential: InferenceConfigurationCredential;
};

export type InferenceConfigurationNode =
	| (ConfigurationNodeBase & { kind: "account_default" })
	| (ConfigurationNodeBase & { kind: "translation" })
	| (ConfigurationNodeBase & { kind: "world"; worldId: string })
	| (ConfigurationNodeBase & { kind: "bot"; botId: string })
	| (ConfigurationNodeBase & { kind: "custom"; name: string; nameKey: string });

export type InferenceConfigurationCredential =
	| { mode: "inherit"; secretVersion: 0 }
	| { mode: "account_default"; secretVersion: 0 }
	| { mode: "none"; secretVersion: 0 }
	| { mode: "value"; secretVersion: number; secret?: string };

export type InferenceConfigurationPath = readonly [InferenceConfigurationNode, ...InferenceConfigurationNode[]];

export type InferenceSource =
	| { kind: "configuration"; configurationId: string; configurationKind: Exclude<InferenceConfigurationKind, "account_default">; depth: number }
	| { kind: "account_default"; configurationId: string; depth: number }
	| { kind: "bickr_default" };

/**
 * Raw configuration provenance is intentionally distinct from runtime policy
 * provenance. An unset field has no source; assigning Bickr as its source
 * would falsely claim that Bickr supplied a value.
 */
export type InferenceFieldProvenance =
	| { kind: "unset" }
	| { kind: "configured"; source: InferenceSource };

export type ResolvedRawInferenceField<K extends InferenceConfigurationField> =
	| {
			state: "value";
			value: InferenceConfigurationFieldValues[K];
			provenance: Extract<InferenceFieldProvenance, { kind: "configured" }>;
			override: StoredInferenceOverride<K> | null;
	  }
	| {
			state: "explicit_none";
			provenance: Extract<InferenceFieldProvenance, { kind: "configured" }>;
			override: Extract<StoredInferenceOverride<K>, { kind: "explicit_none" }>;
	  }
	| {
			state: "target_default";
			provenance: Extract<InferenceFieldProvenance, { kind: "configured" }>;
			override: Extract<StoredInferenceOverride<K>, { kind: "target_default" }>;
	  }
	| { state: "absent"; provenance: Extract<InferenceFieldProvenance, { kind: "unset" }>; override: null };

export type ResolvedRawInferenceFields = {
	[K in InferenceConfigurationField]: ResolvedRawInferenceField<K>;
};

export type InferenceCredentialUnavailableReason =
	| "missing_saved_secret"
	| "no_credential"
	| "deployment_credential_suppressed_for_owner_base_url";

export type InferenceCredentialResolution =
	| { kind: "available"; source: InferenceSource; secretVersion: number; secret?: string }
	| { kind: "explicit_none"; source: InferenceSource }
	| { kind: "unavailable"; source: InferenceSource | { kind: "bickr_default" }; reason: InferenceCredentialUnavailableReason };

export type InferenceProviderAuthorizationAdjustment =
	| {
			kind: "model_fell_back";
			requestedModel: string;
			requestedSource: InferenceSource;
			effectiveModel: string;
			effectiveSource: InferenceSource;
			reason: "owner_provider_unavailable";
	  }
	| null;

export type EffectiveInferenceSettings = {
	baseUrl: string;
	model: string;
	credential: InferenceCredentialResolution;
	providerRouting?: JsonObject;
	reasoningEffort?: Exclude<BotInferenceReasoningEffort, "default">;
	compactionReasoning: CompactionReasoningResolution;
	toolCalls: BotInferenceToolCalls;
	compactionMode: BotCompactionMode;
	promptCacheMode: BotPromptCacheMode;
	supportsPrefill: boolean;
	temperature: number;
	topK?: number;
	topP?: number;
	minP?: number;
	frequencyPenalty?: number;
	presencePenalty?: number;
	repetitionPenalty?: number;
	image: ResolvedRawImageSettings;
};

export type ResolvedRawImageSettings = {
	model: ResolvedRawInferenceField<"imageModel">;
	providerRouting: ResolvedRawInferenceField<"imageProviderRouting">;
	aspectRatio: ResolvedRawInferenceField<"imageAspectRatio">;
	imageSize: ResolvedRawInferenceField<"imageSize">;
	temperature: ResolvedRawInferenceField<"imageTemperature">;
	topK: ResolvedRawInferenceField<"imageTopK">;
	topP: ResolvedRawInferenceField<"imageTopP">;
	minP: ResolvedRawInferenceField<"imageMinP">;
	frequencyPenalty: ResolvedRawInferenceField<"imageFrequencyPenalty">;
	presencePenalty: ResolvedRawInferenceField<"imagePresencePenalty">;
	repetitionPenalty: ResolvedRawInferenceField<"imageRepetitionPenalty">;
};

export type InferenceResolution = {
	selectedConfigurationId: string;
	path: InferenceConfigurationPath;
	raw: ResolvedRawInferenceFields;
	effective: EffectiveInferenceSettings;
	providerAuthorizationAdjustment: InferenceProviderAuthorizationAdjustment;
};

export type InferenceFieldAdjustment =
	| InferenceProviderAuthorizationAdjustment
	| { kind: "provider_or_model_default"; effective: unknown }
	| { kind: "capability_adjustment"; requested: unknown; effective: unknown }
	| { kind: "compaction_policy"; resolution: CompactionReasoningResolution };

export type InferenceFieldEffectiveValues = {
	baseUrl: string;
	model: string;
	providerRouting: JsonObject | null;
	reasoning: Exclude<BotInferenceReasoningEffort, "default"> | null;
	compactionReasoning: CompactionReasoningResolution;
	toolCalls: BotInferenceToolCalls;
	compactionMode: BotCompactionMode;
	promptCacheMode: BotPromptCacheMode;
	supportsPrefill: boolean;
	temperature: number;
	topK: number | null;
	topP: number | null;
	minP: number | null;
	frequencyPenalty: number | null;
	presencePenalty: number | null;
	repetitionPenalty: number | null;
	imageModel: string | null;
	imageProviderRouting: JsonObject | null;
	imageAspectRatio: string | null;
	imageSize: string | null;
	imageTemperature: number | null;
	imageTopK: number | null;
	imageTopP: number | null;
	imageMinP: number | null;
	imageFrequencyPenalty: number | null;
	imagePresencePenalty: number | null;
	imageRepetitionPenalty: number | null;
};

export type InferenceFieldAnnotation<K extends InferenceConfigurationField> = {
	override: InferenceOverrideUpdate<K>;
	effective: InferenceFieldEffectiveValues[K];
	provenance: InferenceFieldProvenance;
	adjustment: InferenceFieldAdjustment;
};

export type InferenceFieldAnnotationMap = {
	[K in InferenceConfigurationField]: InferenceFieldAnnotation<K>;
};

export type BickrInferenceDefaults = {
	fields: Partial<InferenceConfigurationFieldValues> & Pick<InferenceConfigurationFieldValues, "baseUrl" | "model" | "temperature">;
	credential?: string;
	credentialVersion: number;
};

export const defaultBickrInferenceDefaults: BickrInferenceDefaults = {
	fields: {
		baseUrl: defaultProviderBaseUrl,
		model: defaultProviderModel,
		temperature: defaultTextGenerationTemperature,
	},
	credentialVersion: 0,
};

export type ResolveInferenceConfigurationOptions = {
	defaults?: BickrInferenceDefaults;
	learnedCompactionFloor?: CompactionReasoningFloor;
};

export class InferenceConfigurationDataError extends Error {
	readonly kind:
		| "invalid_overrides"
		| "invalid_path"
		| "path_cycle"
		| "path_over_limit";

	constructor(kind: InferenceConfigurationDataError["kind"], message: string) {
		super(message);
		this.name = "InferenceConfigurationDataError";
		this.kind = kind;
	}
}

export function resolveInferenceConfiguration(
	path: InferenceConfigurationPath,
	options: ResolveInferenceConfigurationOptions = {},
): InferenceResolution {
	validateInferenceConfigurationPath(path);
	const defaults = options.defaults ?? defaultBickrInferenceDefaults;
	const raw = resolveRawInferenceFields(path, defaults.fields);
	const baseUrl = requiredRawValue(raw.baseUrl, "base URL");
	const credential = credentialAuthorizedForBaseUrl(raw.baseUrl, resolveCredential(path, defaults));
	const authorization = authorizedModel(raw.model, raw.baseUrl, credential, defaults);
	const effectiveModel = authorization.model;
	const openRouter = isOpenRouterProviderBaseUrl(baseUrl);
	const providerRouting = optionalRawValue(raw.providerRouting);
	const reasoningRequest = optionalRawValue(raw.reasoning);
	const reasoningEffort = effectiveReasoningEffortForModel(
		effectiveModel,
		openRouter,
		legacyReasoningRequest(reasoningRequest),
		providerRouting,
	);
	const toolCallRequest = optionalRawValue(raw.toolCalls);
	const toolCalls = effectiveToolCallsForModel(
		effectiveModel,
		openRouter,
		toolCallRequest?.kind === "strategy" ? toolCallRequest.strategy : undefined,
		providerRouting,
	);
	const compactionModeRequest = optionalRawValue(raw.compactionMode);
	const compactionMode = effectiveCompactionModeForModel(
		effectiveModel,
		openRouter,
		compactionModeRequest?.kind === "mode" ? compactionModeRequest.mode : undefined,
		providerRouting,
	);
	const promptCacheRequest = optionalRawValue(raw.promptCacheMode);
	const requestedPromptCacheMode = promptCacheRequest?.kind === "mode" ? promptCacheRequest.mode : "off";
	const promptCacheMode = modelSupportsPromptCacheControl(effectiveModel, openRouter)
		? requestedPromptCacheMode
		: "off";
	const supportsPrefill = effectiveSupportsPrefillForModel(
		effectiveModel,
		openRouter,
		optionalRawValue(raw.supportsPrefill),
		providerRouting,
	);
	const compactionPolicy = compactionReasoningPolicyForModel(effectiveModel, openRouter, providerRouting);
	const compactionReasoning = resolveCompactionReasoningSelection({
		policy: compactionPolicy,
		capabilities: compactionReasoningCapabilitiesForModel(effectiveModel, openRouter, providerRouting),
		...(optionalRawValue(raw.compactionReasoning)
			? { request: optionalRawValue(raw.compactionReasoning) }
			: {}),
		...(options.learnedCompactionFloor ? { learnedFloor: options.learnedCompactionFloor } : {}),
	});
	return {
		selectedConfigurationId: path[0].id,
		path,
		raw,
		effective: {
			baseUrl,
			model: effectiveModel,
			credential,
			...(providerRouting ? { providerRouting } : {}),
			...(reasoningEffort ? { reasoningEffort } : {}),
			compactionReasoning,
			toolCalls,
			compactionMode,
			promptCacheMode,
			supportsPrefill,
			temperature: optionalRawValue(raw.temperature) ?? defaultTextGenerationTemperature,
			...(optionalNumber(raw.topK) !== undefined ? { topK: optionalNumber(raw.topK) } : {}),
			...(optionalNumber(raw.topP) !== undefined ? { topP: optionalNumber(raw.topP) } : {}),
			...(optionalNumber(raw.minP) !== undefined ? { minP: optionalNumber(raw.minP) } : {}),
			...(optionalNumber(raw.frequencyPenalty) !== undefined ? { frequencyPenalty: optionalNumber(raw.frequencyPenalty) } : {}),
			...(optionalNumber(raw.presencePenalty) !== undefined ? { presencePenalty: optionalNumber(raw.presencePenalty) } : {}),
			...(optionalNumber(raw.repetitionPenalty) !== undefined ? { repetitionPenalty: optionalNumber(raw.repetitionPenalty) } : {}),
			image: {
				model: raw.imageModel,
				providerRouting: raw.imageProviderRouting,
				aspectRatio: raw.imageAspectRatio,
				imageSize: raw.imageSize,
				temperature: raw.imageTemperature,
				topK: raw.imageTopK,
				topP: raw.imageTopP,
				minP: raw.imageMinP,
				frequencyPenalty: raw.imageFrequencyPenalty,
				presencePenalty: raw.imagePresencePenalty,
				repetitionPenalty: raw.imageRepetitionPenalty,
			},
		},
		providerAuthorizationAdjustment: authorization.adjustment,
	};
}

export type AvatarInferenceTarget = "participant" | "world";

export type EffectiveImageSettings = {
	model?: string;
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

export function resolveImageSettingsForTarget(
	image: ResolvedRawImageSettings,
	target: AvatarInferenceTarget,
): EffectiveImageSettings {
	const model = optionalRawValue(image.model);
	const providerRouting = optionalRawValue(image.providerRouting);
	const aspectRatio = optionalRawValue(image.aspectRatio);
	const imageSize = optionalRawValue(image.imageSize);
	const temperature = optionalRawValue(image.temperature);
	const topK = optionalRawValue(image.topK);
	const topP = optionalRawValue(image.topP);
	const minP = optionalRawValue(image.minP);
	const frequencyPenalty = optionalRawValue(image.frequencyPenalty);
	const presencePenalty = optionalRawValue(image.presencePenalty);
	const repetitionPenalty = optionalRawValue(image.repetitionPenalty);
	const raw: BotImageGenerationSettings = {
		...(model ? { model } : {}),
		...(providerRouting ? { providerRouting } : {}),
		...(aspectRatio ? { aspectRatio } : {}),
		...(imageSize ? { imageSize } : {}),
		...(temperature !== undefined ? { temperature } : {}),
		...(topK !== undefined ? { topK } : {}),
		...(topP !== undefined ? { topP } : {}),
		...(minP !== undefined ? { minP } : {}),
		...(frequencyPenalty !== undefined ? { frequencyPenalty } : {}),
		...(presencePenalty !== undefined ? { presencePenalty } : {}),
		...(repetitionPenalty !== undefined ? { repetitionPenalty } : {}),
	};
	const withDefaults = target === "world"
		? worldAvatarImageGenerationSettingsWithDefaults(raw)
		: avatarImageGenerationSettingsWithDefaults(raw);
	return {
		...(image.model.state !== "explicit_none" && withDefaults.model ? { model: withDefaults.model } : {}),
		...(withDefaults.providerRouting ? { providerRouting: withDefaults.providerRouting } : {}),
		...(image.aspectRatio.state !== "explicit_none" && withDefaults.aspectRatio
			? { aspectRatio: withDefaults.aspectRatio }
			: {}),
		...(image.imageSize.state !== "explicit_none" && withDefaults.imageSize ? { imageSize: withDefaults.imageSize } : {}),
		...(withDefaults.temperature !== undefined ? { temperature: withDefaults.temperature } : {}),
		...(withDefaults.topK !== undefined ? { topK: withDefaults.topK } : {}),
		...(withDefaults.topP !== undefined ? { topP: withDefaults.topP } : {}),
		...(withDefaults.minP !== undefined ? { minP: withDefaults.minP } : {}),
		...(withDefaults.frequencyPenalty !== undefined ? { frequencyPenalty: withDefaults.frequencyPenalty } : {}),
		...(withDefaults.presencePenalty !== undefined ? { presencePenalty: withDefaults.presencePenalty } : {}),
		...(withDefaults.repetitionPenalty !== undefined ? { repetitionPenalty: withDefaults.repetitionPenalty } : {}),
	};
}

export function parseInferenceConfigurationOverrides(value: string | unknown): OwnerInferenceConfigurationOverrides {
	return parseInferenceConfigurationOverridesWithAccess(value, false) as OwnerInferenceConfigurationOverrides;
}

/** Stored graph rows may contain migration-only provenance states. */
export function parseStoredInferenceConfigurationOverrides(value: string | unknown): InferenceConfigurationOverrides {
	return parseInferenceConfigurationOverridesWithAccess(value, true);
}

function parseInferenceConfigurationOverridesWithAccess(
	value: string | unknown,
	allowHistoricalBickrDefault: boolean,
): InferenceConfigurationOverrides {
	let parsed: unknown = value;
	if (typeof value === "string") {
		try {
			parsed = JSON.parse(value) as unknown;
		} catch {
			throw new InferenceConfigurationDataError("invalid_overrides", "Stored inference configuration overrides are not valid JSON.");
		}
	}
	if (!isRecord(parsed)) {
		throw new InferenceConfigurationDataError("invalid_overrides", "Inference configuration overrides must be an object.");
	}
	const result: Record<string, unknown> = {};
	for (const [key, override] of Object.entries(parsed)) {
		if (!isInferenceConfigurationField(key)) {
			throw new InferenceConfigurationDataError("invalid_overrides", `Unknown inference configuration field ${JSON.stringify(key)}.`);
		}
		result[key] = parseInferenceOverride(key, override, allowHistoricalBickrDefault);
	}
	return result as InferenceConfigurationOverrides;
}

export function applyInferenceOverridePatch(
	current: InferenceConfigurationOverrides,
	patch: InferenceConfigurationOverridePatch,
): InferenceConfigurationOverrides {
	const next: Record<string, unknown> = { ...current };
	for (const field of inferenceConfigurationFields) {
		const update = patch[field];
		if (!update) continue;
		if (update.kind === "inherit") {
			delete next[field];
		} else {
			const parsed = parseInferenceOverride(field, update, false);
			if (field === "imageModel" &&
				current.imageModel?.kind === "historical_bickr_default" &&
				parsed.kind === "value" && parsed.value === current.imageModel.value) {
				// Owner surfaces intentionally project the internal state as an
				// ordinary value. Re-submitting that unchanged projection must not
				// silently re-attribute the model to the owner.
				continue;
			}
			next[field] = parsed;
		}
	}
	return next as InferenceConfigurationOverrides;
}

export function parseInferenceConfigurationOverridePatch(value: unknown): InferenceConfigurationOverridePatch {
	if (!isRecord(value)) {
		throw new InferenceConfigurationDataError("invalid_overrides", "Inference configuration patch must be an object.");
	}
	const result: Record<string, unknown> = {};
	for (const [key, update] of Object.entries(value)) {
		if (!isInferenceConfigurationField(key)) {
			throw new InferenceConfigurationDataError("invalid_overrides", `Unknown inference configuration field ${JSON.stringify(key)}.`);
		}
		if (!isRecord(update) || typeof update.kind !== "string") {
			throw new InferenceConfigurationDataError("invalid_overrides", `Inference configuration field ${key} has invalid update intent.`);
		}
		if (update.kind === "inherit") {
			if (Object.keys(update).length !== 1) throw invalidOverride(key);
			result[key] = { kind: "inherit" };
		} else {
			result[key] = parseInferenceOverride(key, update, false);
		}
	}
	return result as InferenceConfigurationOverridePatch;
}

/**
 * Account default has no ancestor to resume at, so it can never store the
 * Account-default state. Every writer that persists overrides for a known
 * configuration kind runs this check; the resolver rejects the same shape
 * independently so a side-door write cannot produce a silently wrong path.
 */
export function assertInferenceOverridesAllowedForKind(
	kind: InferenceConfigurationKind,
	overrides: InferenceConfigurationOverrides | InferenceConfigurationOverridePatch,
): void {
	if (kind === "account_default" && overrides.baseUrl?.kind === "account_default") {
		throw new InferenceConfigurationDataError(
			"invalid_overrides",
			"Account default cannot use the Account-default state for baseUrl.",
		);
	}
}

export function normalizedInferenceConfigurationName(name: string): { name: string; key: string } {
	const normalizedName = name.normalize("NFKC").trim();
	if (!normalizedName) {
		throw new InferenceConfigurationDataError("invalid_overrides", "Configuration name cannot be empty.");
	}
	return { name: normalizedName, key: normalizedName.toLocaleLowerCase("en-US") };
}

export async function inferenceResolutionFingerprint(
	resolution: InferenceResolution,
	options: { selectedConfigurationId?: string } = {},
): Promise<string> {
	const credential = resolution.effective.credential;
	const fingerprintInput = {
		selectedConfigurationId: options.selectedConfigurationId ?? resolution.selectedConfigurationId,
		path: resolution.path.map((entry) => ({ id: entry.id, revision: entry.revision })),
		provider: {
			baseUrl: resolution.effective.baseUrl,
			model: resolution.effective.model,
			providerRouting: resolution.effective.providerRouting ?? null,
			reasoningEffort: resolution.effective.reasoningEffort ?? null,
			toolCalls: resolution.effective.toolCalls,
			compactionMode: resolution.effective.compactionMode,
			promptCacheMode: resolution.effective.promptCacheMode,
			supportsPrefill: resolution.effective.supportsPrefill,
			temperature: resolution.effective.temperature,
			topK: resolution.effective.topK ?? null,
			topP: resolution.effective.topP ?? null,
			minP: resolution.effective.minP ?? null,
			frequencyPenalty: resolution.effective.frequencyPenalty ?? null,
			presencePenalty: resolution.effective.presencePenalty ?? null,
			repetitionPenalty: resolution.effective.repetitionPenalty ?? null,
		},
		credential: credential.kind === "available"
			? { kind: credential.kind, secretVersion: credential.secretVersion }
			: { kind: credential.kind },
		capabilityVersion: inferenceGraphCapabilityVersion,
		globalDefaultsVersion: inferenceGraphGlobalDefaultsVersion,
	};
	return sha256Hex(canonicalJson(fingerprintInput));
}

export function inferenceFieldAnnotations(
	selectedOverrides: InferenceConfigurationOverrides,
	resolution: InferenceResolution,
): InferenceFieldAnnotationMap {
	const effectiveFields = effectiveInferenceFields(resolution);
	return Object.fromEntries(inferenceConfigurationFields.map((field) => {
		const raw = resolution.raw[field];
		const effective = effectiveFields[field];
		return [field, {
			override: ownerInferenceOverride(selectedOverrides[field]),
			effective,
			provenance: raw.provenance,
			adjustment: inferenceFieldAdjustment(resolution, field, raw, effective),
		}];
	})) as InferenceFieldAnnotationMap;
}

export function ownerInferenceOverride<K extends InferenceConfigurationField>(
	override: StoredInferenceOverride<K> | undefined,
): InferenceOverrideUpdate<K> {
	if (!override) return { kind: "inherit" };
	if (override.kind === "historical_bickr_default") {
		return { kind: "value", value: override.value } as InferenceOverrideUpdate<K>;
	}
	return override as InferenceOverrideUpdate<K>;
}

export function ownerInferenceConfigurationOverrides(
	overrides: InferenceConfigurationOverrides,
): OwnerInferenceConfigurationOverrides {
	return Object.fromEntries(inferenceConfigurationFields.flatMap((field) => {
		const override = overrides[field];
		return override ? [[field, ownerInferenceOverride(override)]] : [];
	})) as OwnerInferenceConfigurationOverrides;
}

function effectiveInferenceFields(resolution: InferenceResolution): InferenceFieldEffectiveValues {
	return {
		baseUrl: resolution.effective.baseUrl,
		model: resolution.effective.model,
		providerRouting: resolution.effective.providerRouting ?? null,
		reasoning: resolution.effective.reasoningEffort ?? null,
		compactionReasoning: resolution.effective.compactionReasoning,
		toolCalls: resolution.effective.toolCalls,
		compactionMode: resolution.effective.compactionMode,
		promptCacheMode: resolution.effective.promptCacheMode,
		supportsPrefill: resolution.effective.supportsPrefill,
		temperature: resolution.effective.temperature,
		topK: resolution.effective.topK ?? null,
		topP: resolution.effective.topP ?? null,
		minP: resolution.effective.minP ?? null,
		frequencyPenalty: resolution.effective.frequencyPenalty ?? null,
		presencePenalty: resolution.effective.presencePenalty ?? null,
		repetitionPenalty: resolution.effective.repetitionPenalty ?? null,
		imageModel: rawEffectiveValue(resolution.raw.imageModel),
		imageProviderRouting: rawEffectiveValue(resolution.raw.imageProviderRouting),
		imageAspectRatio: rawEffectiveValue(resolution.raw.imageAspectRatio),
		imageSize: rawEffectiveValue(resolution.raw.imageSize),
		imageTemperature: rawEffectiveValue(resolution.raw.imageTemperature),
		imageTopK: rawEffectiveValue(resolution.raw.imageTopK),
		imageTopP: rawEffectiveValue(resolution.raw.imageTopP),
		imageMinP: rawEffectiveValue(resolution.raw.imageMinP),
		imageFrequencyPenalty: rawEffectiveValue(resolution.raw.imageFrequencyPenalty),
		imagePresencePenalty: rawEffectiveValue(resolution.raw.imagePresencePenalty),
		imageRepetitionPenalty: rawEffectiveValue(resolution.raw.imageRepetitionPenalty),
	};
}

function rawEffectiveValue<K extends InferenceConfigurationField>(
	raw: ResolvedRawInferenceField<K>,
): InferenceConfigurationFieldValues[K] | null {
	return raw.state === "value" ? raw.value : null;
}

function inferenceFieldAdjustment(
	resolution: InferenceResolution,
	field: InferenceConfigurationField,
	raw: AnyResolvedRawInferenceField,
	effective: unknown,
): InferenceFieldAdjustment {
	if (field === "model" && resolution.providerAuthorizationAdjustment) return resolution.providerAuthorizationAdjustment;
	if (field === "compactionReasoning") {
		return { kind: "compaction_policy", resolution: resolution.effective.compactionReasoning };
	}
	const requested = normalizedRawRequest(field, raw);
	if (requested.kind === "provider_default") return { kind: "provider_or_model_default", effective };
	return canonicalJson(requested.value) === canonicalJson(effective)
		? null
		: { kind: "capability_adjustment", requested: requested.value, effective };
}

function normalizedRawRequest(
	field: InferenceConfigurationField,
	raw: AnyResolvedRawInferenceField,
): { kind: "value"; value: unknown } | { kind: "provider_default" } {
	if (raw.state !== "value") return { kind: "value", value: null };
	if (field === "reasoning") {
		const request = raw.value as InferenceReasoningRequest;
		if (request.kind === "provider_default") return { kind: "provider_default" };
		return { kind: "value", value: request.kind === "reasoning_disabled" ? "none" : request.effort };
	}
	if (field === "toolCalls") {
		const request = raw.value as InferenceToolCallRequest;
		return request.kind === "provider_default" ? { kind: "provider_default" } : { kind: "value", value: request.strategy };
	}
	if (field === "compactionMode") {
		const request = raw.value as InferenceCompactionModeRequest;
		return request.kind === "provider_default" ? { kind: "provider_default" } : { kind: "value", value: request.mode };
	}
	if (field === "promptCacheMode") {
		const request = raw.value as InferencePromptCacheRequest;
		return request.kind === "provider_default" ? { kind: "provider_default" } : { kind: "value", value: request.mode };
	}
	return { kind: "value", value: raw.value };
}

const inferenceConfigurationFieldSet = new Set<string>(inferenceConfigurationFields);
// The parser and every owner editor read the same capability table, so a state
// an editor can offer is exactly a state this parser accepts.
const explicitNoneFields = overrideStateFields("explicitNone");
const imageTargetDefaultFields = overrideStateFields("targetDefault");
const accountDefaultResumableFields = overrideStateFields("accountDefault");

function overrideStateFields(state: keyof InferenceFieldOverrideStates): Set<InferenceConfigurationField> {
	return new Set(inferenceConfigurationFields.filter((field) => inferenceFieldOverrideStates[field][state]));
}

function resolveRawInferenceFields(
	path: InferenceConfigurationPath,
	defaults: BickrInferenceDefaults["fields"],
): ResolvedRawInferenceFields {
	const resolved: Record<string, unknown> = {};
	for (const field of inferenceConfigurationFields) {
		resolved[field] = resolveRawInferenceField(path, field, defaults[field]);
	}
	return resolved as ResolvedRawInferenceFields;
}

type AnyStoredInferenceOverride =
	| { kind: "value"; value: InferenceConfigurationFieldValues[InferenceConfigurationField] }
	| { kind: "explicit_none" }
	| { kind: "target_default" }
	| { kind: "historical_bickr_default"; value: HistoricalBickrDefaultImageModel }
	| { kind: "account_default" };

type AnyResolvedRawInferenceField =
	| {
			state: "value";
			value: InferenceConfigurationFieldValues[InferenceConfigurationField];
			provenance: Extract<InferenceFieldProvenance, { kind: "configured" }>;
			override: AnyStoredInferenceOverride | null;
	  }
	| {
			state: "explicit_none";
			provenance: Extract<InferenceFieldProvenance, { kind: "configured" }>;
			override: { kind: "explicit_none" };
	  }
	| {
			state: "target_default";
			provenance: Extract<InferenceFieldProvenance, { kind: "configured" }>;
			override: { kind: "target_default" };
	  }
	| { state: "absent"; provenance: Extract<InferenceFieldProvenance, { kind: "unset" }>; override: null };

function resolveRawInferenceField(
	path: InferenceConfigurationPath,
	field: InferenceConfigurationField,
	defaultValue: InferenceConfigurationFieldValues[InferenceConfigurationField] | undefined,
): AnyResolvedRawInferenceField {
	return resolveRawInferenceFieldFromDepth(path, field, defaultValue, 0);
}

function resolveRawInferenceFieldFromDepth(
	path: InferenceConfigurationPath,
	field: InferenceConfigurationField,
	defaultValue: InferenceConfigurationFieldValues[InferenceConfigurationField] | undefined,
	startDepth: number,
): AnyResolvedRawInferenceField {
	for (let depth = startDepth; depth < path.length; depth += 1) {
		const entry = path[depth];
		if (!entry) continue;
		const override = entry.overrides[field];
		if (!override) continue;
		if (override.kind === "account_default") {
			if (entry.kind === "account_default") {
				throw new InferenceConfigurationDataError(
					"invalid_path",
					`Account default cannot use the Account-default state for ${field}.`,
				);
			}
			// The jump only skips intervening parents. Whatever Account default or
			// the Bickr default then supplies keeps its own provenance, so a hidden
			// deployment value is never relabelled as owner-selected.
			return resolveRawInferenceFieldFromDepth(path, field, defaultValue, path.length - 1);
		}
		if (override.kind === "historical_bickr_default") {
			return {
				state: "value",
				value: override.value,
				provenance: { kind: "configured", source: { kind: "bickr_default" } },
				override,
			};
		}
		const source = sourceForEntry(entry, depth);
		if (override.kind === "explicit_none") {
			return { state: "explicit_none", provenance: { kind: "configured", source }, override };
		}
		if (override.kind === "target_default") {
			return { state: "target_default", provenance: { kind: "configured", source }, override };
		}
		return { state: "value", value: override.value, provenance: { kind: "configured", source }, override };
	}
	return defaultValue === undefined
		? { state: "absent", provenance: { kind: "unset" }, override: null }
		: {
				state: "value",
				value: defaultValue,
				provenance: { kind: "configured", source: { kind: "bickr_default" } },
				override: null,
			};
}

function resolveCredential(
	path: InferenceConfigurationPath,
	defaults: BickrInferenceDefaults,
): InferenceCredentialResolution {
	return resolveCredentialFromDepth(path, defaults, 0);
}

function resolveCredentialFromDepth(
	path: InferenceConfigurationPath,
	defaults: BickrInferenceDefaults,
	startDepth: number,
): InferenceCredentialResolution {
	for (let depth = startDepth; depth < path.length; depth += 1) {
		const entry = path[depth];
		if (!entry || entry.credential.mode === "inherit") continue;
		if (entry.credential.mode === "account_default") {
			if (entry.kind === "account_default") {
				throw new InferenceConfigurationDataError("invalid_path", "Account default cannot use Account-default credential mode.");
			}
			return resolveCredentialFromDepth(path, defaults, path.length - 1);
		}
		const source = sourceForEntry(entry, depth);
		if (entry.credential.mode === "none") {
			return { kind: "explicit_none", source };
		}
		if (entry.credential.secretVersion <= 0) {
			return { kind: "unavailable", source, reason: "missing_saved_secret" };
		}
		return {
			kind: "available",
			source,
			secretVersion: entry.credential.secretVersion,
			...(entry.credential.secret ? { secret: entry.credential.secret } : {}),
		};
	}
	return defaults.credential || defaults.credentialVersion > 0
		? {
			kind: "available",
			source: { kind: "bickr_default" },
			secretVersion: defaults.credentialVersion,
			...(defaults.credential ? { secret: defaults.credential } : {}),
		}
		: { kind: "unavailable", source: { kind: "bickr_default" }, reason: "no_credential" };
}

function credentialAuthorizedForBaseUrl(
	baseUrl: ResolvedRawInferenceField<"baseUrl">,
	credential: InferenceCredentialResolution,
): InferenceCredentialResolution {
	const baseUrlSource = configuredRawInferenceFieldSource(baseUrl, "base URL");
	// Source provenance, not URL-string equality, defines the trust boundary.
	// A deployment key must never be sent to a base URL selected by an owner.
	if (baseUrlSource.kind !== "bickr_default" &&
		credential.kind === "available" && credential.source.kind === "bickr_default") {
		return {
			kind: "unavailable",
			source: credential.source,
			reason: "deployment_credential_suppressed_for_owner_base_url",
		};
	}
	return credential;
}

function authorizedModel(
	model: ResolvedRawInferenceField<"model">,
	baseUrl: ResolvedRawInferenceField<"baseUrl">,
	credential: InferenceCredentialResolution,
	defaults: BickrInferenceDefaults,
): {
	model: string;
	source: InferenceSource;
	adjustment: InferenceProviderAuthorizationAdjustment;
} {
	const requestedModel = requiredRawValue(model, "model");
	const modelSource = configuredRawInferenceFieldSource(model, "model");
	if (modelSource.kind === "bickr_default" || ownerProviderIsAvailable(baseUrl, credential)) {
		return { model: requestedModel, source: modelSource, adjustment: null };
	}
	// Provider authorization is resolved for the effective base URL and
	// credential pair. If that pair cannot authorize the nearest owner-defined
	// model, a more distant owner-defined model is not authorized by it either.
	// Falling all the way back preserves raw intent while preventing an account
	// default model from bypassing the same provider-availability rule.
	return {
		model: defaults.fields.model,
		source: { kind: "bickr_default" },
		adjustment: {
			kind: "model_fell_back",
			requestedModel,
			requestedSource: modelSource,
			effectiveModel: defaults.fields.model,
			effectiveSource: { kind: "bickr_default" },
			reason: "owner_provider_unavailable",
		},
	};
}

function ownerProviderIsAvailable(
	baseUrl: ResolvedRawInferenceField<"baseUrl">,
	credential: InferenceCredentialResolution,
): boolean {
	return configuredRawInferenceFieldSource(baseUrl, "base URL").kind !== "bickr_default" ||
		(credential.kind === "available" && credential.source.kind !== "bickr_default");
}

function sourceForEntry(entry: InferenceConfigurationNode, depth: number): InferenceSource {
	return entry.kind === "account_default"
		? { kind: "account_default", configurationId: entry.id, depth }
		: { kind: "configuration", configurationId: entry.id, configurationKind: entry.kind, depth };
}

function validateInferenceConfigurationPath(path: InferenceConfigurationPath): void {
	if (path.length > inferenceConfigurationOwnerQuota) {
		throw new InferenceConfigurationDataError("path_over_limit", "Inference configuration path exceeds the owner quota.");
	}
	const ids = new Set<string>();
	for (let depth = 0; depth < path.length; depth += 1) {
		const entry = path[depth];
		if (!entry) continue;
		if (ids.has(entry.id)) {
			throw new InferenceConfigurationDataError("path_cycle", "Inference configuration path contains a cycle.");
		}
		ids.add(entry.id);
		const next = path[depth + 1];
		if (next && (entry.parentId !== next.id || entry.ownerUserId !== next.ownerUserId)) {
			throw new InferenceConfigurationDataError("invalid_path", "Inference configuration path has a broken parent edge.");
		}
		if (!next && (entry.kind !== "account_default" || entry.parentId !== null)) {
			throw new InferenceConfigurationDataError("invalid_path", "Inference configuration path does not end at Account default.");
		}
	}
}

function legacyReasoningRequest(
	request: InferenceReasoningRequest | undefined,
): BotInferenceReasoningEffort | undefined {
	switch (request?.kind) {
		case undefined:
		case "provider_default": return undefined;
		case "reasoning_disabled": return "none";
		case "explicit_effort": return request.effort;
	}
}

function requiredRawValue<K extends Extract<ValueOnlyField, "baseUrl" | "model">>(
	field: ResolvedRawInferenceField<K>,
	label: string,
): InferenceConfigurationFieldValues[K] {
	if (field.state !== "value") {
		throw new InferenceConfigurationDataError("invalid_path", `Resolved inference ${label} is absent.`);
	}
	return field.value;
}

export function configuredRawInferenceFieldSource<K extends InferenceConfigurationField>(
	field: ResolvedRawInferenceField<K>,
	label: string,
): InferenceSource {
	if (field.provenance.kind !== "configured") {
		throw new InferenceConfigurationDataError("invalid_path", `Resolved inference ${label} is unset.`);
	}
	return field.provenance.source;
}

function optionalRawValue<K extends InferenceConfigurationField>(
	field: ResolvedRawInferenceField<K>,
): InferenceConfigurationFieldValues[K] | undefined {
	return field.state === "value" ? field.value : undefined;
}

function optionalNumber<K extends InferenceConfigurationField>(
	field: ResolvedRawInferenceField<K>,
): number | undefined {
	const value = optionalRawValue(field);
	return typeof value === "number" ? value : undefined;
}

function parseInferenceOverride<K extends InferenceConfigurationField>(
	field: K,
	value: unknown,
	allowHistoricalBickrDefault: boolean,
): StoredInferenceOverride<K> {
	if (!isRecord(value) || typeof value.kind !== "string") {
		throw invalidOverride(field);
	}
	if (value.kind === "explicit_none") {
		if (!explicitNoneFields.has(field) || Object.keys(value).length !== 1) throw invalidOverride(field);
		return { kind: "explicit_none" } as StoredInferenceOverride<K>;
	}
	if (value.kind === "target_default") {
		if (!imageTargetDefaultFields.has(field) || Object.keys(value).length !== 1) throw invalidOverride(field);
		return { kind: "target_default" } as StoredInferenceOverride<K>;
	}
	if (value.kind === "historical_bickr_default") {
		if (!allowHistoricalBickrDefault || field !== "imageModel" ||
			Object.keys(value).some((key) => key !== "kind" && key !== "value") ||
			!isHistoricalBickrDefaultImageModel(value.value)) throw invalidOverride(field);
		return { kind: "historical_bickr_default", value: value.value } as StoredInferenceOverride<K>;
	}
	if (value.kind === "account_default") {
		if (!accountDefaultResumableFields.has(field) || Object.keys(value).length !== 1) throw invalidOverride(field);
		return { kind: "account_default" } as StoredInferenceOverride<K>;
	}
	if (value.kind !== "value" || Object.keys(value).some((key) => key !== "kind" && key !== "value")) {
		throw invalidOverride(field);
	}
	const parsed = parseFieldValue(field, value.value);
	return { kind: "value", value: parsed } as StoredInferenceOverride<K>;
}

function parseFieldValue<K extends InferenceConfigurationField>(
	field: K,
	value: unknown,
): InferenceConfigurationFieldValues[K] {
	if (stringFields.has(field)) {
		if (typeof value !== "string" || !value.trim()) throw invalidOverride(field);
		return value.trim() as InferenceConfigurationFieldValues[K];
	}
	if (numberFields.has(field)) {
		const domain = numericInferenceFieldDomains[field as NumericInferenceConfigurationField];
		if (typeof value !== "number" || !Number.isFinite(value) || value < domain.min || value > domain.max ||
			domain.integer && !Number.isSafeInteger(value)) {
			throw invalidOverride(field);
		}
		return value as InferenceConfigurationFieldValues[K];
	}
	if (jsonFields.has(field)) {
		if (!isJsonObject(value)) throw invalidOverride(field);
		return structuredClone(value) as InferenceConfigurationFieldValues[K];
	}
	if (field === "supportsPrefill") {
		if (typeof value !== "boolean") throw invalidOverride(field);
		return value as InferenceConfigurationFieldValues[K];
	}
	if (field === "reasoning") return parseReasoningRequest(value) as InferenceConfigurationFieldValues[K];
	if (field === "compactionReasoning") return parseCompactionReasoning(value) as InferenceConfigurationFieldValues[K];
	if (field === "toolCalls") return parseToolCallRequest(value) as InferenceConfigurationFieldValues[K];
	if (field === "compactionMode") return parseCompactionModeRequest(value) as InferenceConfigurationFieldValues[K];
	if (field === "promptCacheMode") return parsePromptCacheRequest(value) as InferenceConfigurationFieldValues[K];
	throw invalidOverride(field);
}

function parseReasoningRequest(value: unknown): InferenceReasoningRequest {
	if (!isRecord(value) || typeof value.kind !== "string") throw invalidNestedValue("reasoning");
	switch (value.kind) {
		case "provider_default":
		case "reasoning_disabled":
			if (Object.keys(value).length !== 1) throw invalidNestedValue("reasoning");
			return { kind: value.kind };
		case "explicit_effort":
			if (Object.keys(value).some((key) => key !== "kind" && key !== "effort") || !compactionEfforts.has(value.effort)) {
				throw invalidNestedValue("reasoning");
			}
			return { kind: "explicit_effort", effort: value.effort as BotCompactionReasoningEffort };
		default: throw invalidNestedValue("reasoning");
	}
}

function parseCompactionReasoning(value: unknown): BotCompactionReasoningRequest {
	if (!isRecord(value) || typeof value.kind !== "string") throw invalidNestedValue("compaction reasoning");
	switch (value.kind) {
		case "reasoning_disabled":
		case "model_default":
			if (Object.keys(value).length !== 1) throw invalidNestedValue("compaction reasoning");
			return { kind: value.kind };
		case "explicit_effort":
			if (Object.keys(value).some((key) => key !== "kind" && key !== "effort") || !compactionEfforts.has(value.effort)) {
				throw invalidNestedValue("compaction reasoning");
			}
			return { kind: "explicit_effort", effort: value.effort as BotCompactionReasoningEffort };
		default: throw invalidNestedValue("compaction reasoning");
	}
}

function parseToolCallRequest(value: unknown): InferenceToolCallRequest {
	if (!isRecord(value) || typeof value.kind !== "string") throw invalidNestedValue("tool calls");
	if (value.kind === "provider_default" && Object.keys(value).length === 1) return { kind: "provider_default" };
	if (value.kind === "strategy" && Object.keys(value).every((key) => key === "kind" || key === "strategy") && toolCallStrategies.has(value.strategy)) {
		return { kind: "strategy", strategy: value.strategy as BotInferenceToolCalls };
	}
	throw invalidNestedValue("tool calls");
}

function parseCompactionModeRequest(value: unknown): InferenceCompactionModeRequest {
	if (!isRecord(value) || typeof value.kind !== "string") throw invalidNestedValue("compaction mode");
	if (value.kind === "provider_default" && Object.keys(value).length === 1) return { kind: "provider_default" };
	if (value.kind === "mode" && Object.keys(value).every((key) => key === "kind" || key === "mode") && compactionModes.has(value.mode)) {
		return { kind: "mode", mode: value.mode as BotCompactionMode };
	}
	throw invalidNestedValue("compaction mode");
}

function parsePromptCacheRequest(value: unknown): InferencePromptCacheRequest {
	if (!isRecord(value) || typeof value.kind !== "string") throw invalidNestedValue("prompt cache mode");
	if (value.kind === "provider_default" && Object.keys(value).length === 1) return { kind: "provider_default" };
	if (value.kind === "mode" && Object.keys(value).every((key) => key === "kind" || key === "mode") && promptCacheModes.has(value.mode)) {
		return { kind: "mode", mode: value.mode as BotPromptCacheMode };
	}
	throw invalidNestedValue("prompt cache mode");
}

function invalidOverride(field: InferenceConfigurationField): InferenceConfigurationDataError {
	return new InferenceConfigurationDataError("invalid_overrides", `Invalid override for inference field ${field}.`);
}

function invalidNestedValue(label: string): InferenceConfigurationDataError {
	return new InferenceConfigurationDataError("invalid_overrides", `Invalid canonical ${label} request.`);
}

function isInferenceConfigurationField(value: string): value is InferenceConfigurationField {
	return inferenceConfigurationFieldSet.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isJsonObject(value: unknown): value is JsonObject {
	return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): boolean {
	return value === null || typeof value === "string" || typeof value === "number" && Number.isFinite(value) ||
		typeof value === "boolean" || Array.isArray(value) && value.every(isJsonValue) || isJsonObject(value);
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalJsonValue(value));
}

function canonicalJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalJsonValue);
	if (isRecord(value)) {
		return Object.fromEntries(Object.entries(value)
			.filter(([, child]) => child !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => [key, canonicalJsonValue(child)]));
	}
	return value;
}

const stringFields = new Set<InferenceConfigurationField>([
	"baseUrl", "model", "imageModel", "imageAspectRatio", "imageSize",
]);
const numberFields = new Set<InferenceConfigurationField>(
	Object.keys(numericInferenceFieldDomains) as NumericInferenceConfigurationField[],
);
const jsonFields = new Set<InferenceConfigurationField>(["providerRouting", "imageProviderRouting"]);
const compactionEfforts = new Set<unknown>(["minimal", "low", "medium", "high", "xhigh"]);
const toolCallStrategies = new Set<unknown>(["require", "railroad", "at_will"]);
const compactionModes = new Set<unknown>(["structured_output", "tool_call", "tool_call_cache_friendly"]);
const promptCacheModes = new Set<unknown>(["off", "openrouter_anthropic_5m", "openrouter_anthropic_1h"]);
