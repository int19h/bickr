/**
 * Owner-facing inference-graph surface that browser code may import.
 *
 * Everything here is either a wire type or an opaque address derivation. It
 * deliberately contains no D1 access, no resolver, and no credential material,
 * so an owner UI can address and render configurations without pulling the
 * secret-capable loader/resolver modules into a browser bundle.
 */
import type {
	InferenceConfigurationField,
	InferenceConfigurationKind,
	InferenceCredentialMode,
	InferenceCredentialResolution,
	InferenceCredentialUnavailableReason,
	InferenceFieldAdjustment,
	InferenceFieldEffectiveValues,
	InferenceFieldProvenance,
	InferenceFieldResolvedRequest,
	InferenceOverrideUpdate,
	InferenceSource,
	OwnerInferenceConfigurationFieldValue,
	OwnerInferenceConfigurationOverrides,
} from "./inference-configuration";
import type { EffectiveImageSettings } from "./inference-configuration";

export type { EffectiveImageSettings };

/**
 * Names which entity's fixed configuration a caller wants. It carries only the
 * entity identity a settings screen already holds; resolving it to a
 * configuration is an owner-authenticated server lookup, never a client-side
 * address derivation.
 */
export type FixedInferenceConfigurationReference =
	| { kind: "account_default" }
	| { kind: "translation" }
	| { kind: "world"; worldId: string }
	| { kind: "bot"; botId: string };

export const fixedInferenceConfigurationKinds = ["account_default", "translation", "world", "bot"] as const;

export type FixedInferenceConfigurationKind = typeof fixedInferenceConfigurationKinds[number];

export const inferenceConfigurationFields = [
	"baseUrl",
	"model",
	"providerRouting",
	"reasoning",
	"compactionReasoning",
	"toolCalls",
	"compactionMode",
	"promptCacheMode",
	"supportsPrefill",
	"temperature",
	"topK",
	"topP",
	"minP",
	"frequencyPenalty",
	"presencePenalty",
	"repetitionPenalty",
	"imageModel",
	"imageProviderRouting",
	"imageAspectRatio",
	"imageSize",
	"imageTemperature",
	"imageTopK",
	"imageTopP",
	"imageMinP",
	"imageFrequencyPenalty",
	"imagePresencePenalty",
	"imageRepetitionPenalty",
] as const satisfies readonly InferenceConfigurationField[];

/**
 * Which non-value override states each field admits. The resolver builds its
 * parsing sets from this table and owner editors build their controls from it,
 * so an editor cannot offer a state the writer would reject.
 */
export type InferenceFieldOverrideStates = {
	/** Suppresses both ancestor inheritance and any consumer default. */
	explicitNone: boolean;
	/** Defers to the avatar target's own default for this field. */
	targetDefault: boolean;
	/** Resumes raw resolution at Account default, skipping intervening parents. */
	accountDefault: boolean;
};

const valueOnly: InferenceFieldOverrideStates = { explicitNone: false, targetDefault: false, accountDefault: false };
const optionalValue: InferenceFieldOverrideStates = { explicitNone: true, targetDefault: false, accountDefault: false };
const imageTargetValue: InferenceFieldOverrideStates = { explicitNone: true, targetDefault: true, accountDefault: false };

export const inferenceFieldOverrideStates: Record<InferenceConfigurationField, InferenceFieldOverrideStates> = {
	baseUrl: { explicitNone: false, targetDefault: false, accountDefault: true },
	model: valueOnly,
	reasoning: valueOnly,
	compactionReasoning: valueOnly,
	toolCalls: valueOnly,
	compactionMode: valueOnly,
	promptCacheMode: valueOnly,
	providerRouting: optionalValue,
	supportsPrefill: optionalValue,
	temperature: optionalValue,
	topK: optionalValue,
	topP: optionalValue,
	minP: optionalValue,
	frequencyPenalty: optionalValue,
	presencePenalty: optionalValue,
	repetitionPenalty: optionalValue,
	imageModel: imageTargetValue,
	imageProviderRouting: optionalValue,
	imageAspectRatio: imageTargetValue,
	imageSize: imageTargetValue,
	imageTemperature: optionalValue,
	imageTopK: optionalValue,
	imageTopP: optionalValue,
	imageMinP: optionalValue,
	imageFrequencyPenalty: optionalValue,
	imagePresencePenalty: optionalValue,
	imageRepetitionPenalty: optionalValue,
};

export type NumericInferenceConfigurationField =
	| "temperature" | "topK" | "topP" | "minP" | "frequencyPenalty" | "presencePenalty" | "repetitionPenalty"
	| "imageTemperature" | "imageTopK" | "imageTopP" | "imageMinP"
	| "imageFrequencyPenalty" | "imagePresencePenalty" | "imageRepetitionPenalty";

export type NumericInferenceFieldDomain = { min: number; max: number; integer: boolean };

/** The single accepted numeric range per field; editors and the writer share it. */
export const numericInferenceFieldDomains: Record<NumericInferenceConfigurationField, NumericInferenceFieldDomain> = {
	temperature: { min: 0, max: 2, integer: false },
	topK: { min: 0, max: 10_000, integer: false },
	topP: { min: 0, max: 1, integer: false },
	minP: { min: 0, max: 1, integer: false },
	frequencyPenalty: { min: -2, max: 2, integer: false },
	presencePenalty: { min: -2, max: 2, integer: false },
	repetitionPenalty: { min: 0, max: 2, integer: false },
	imageTemperature: { min: 0, max: 2, integer: false },
	imageTopK: { min: 0, max: 10_000, integer: false },
	imageTopP: { min: 0, max: 1, integer: false },
	imageMinP: { min: 0, max: 1, integer: false },
	imageFrequencyPenalty: { min: -2, max: 2, integer: false },
	imagePresencePenalty: { min: -2, max: 2, integer: false },
	imageRepetitionPenalty: { min: 0, max: 2, integer: false },
};

export function isNumericInferenceField(field: InferenceConfigurationField): field is NumericInferenceConfigurationField {
	return field in numericInferenceFieldDomains;
}

export type InferenceConfigurationIdentity =
	| { kind: "account_default" }
	| { kind: "translation" }
	| { kind: "world"; worldId: string; worldHandle: string }
	| { kind: "bot"; botId: string; botHandle: string; homeWorldId: string; homeWorldHandle: string }
	| { kind: "custom"; name: string };

export type InferenceConfigurationEntryIdentity = {
	[K in InferenceConfigurationKind]: {
		kind: K;
		identity: Extract<InferenceConfigurationIdentity, { kind: K }>;
	};
}[InferenceConfigurationKind];

/**
 * Named ancestry for one configuration, ordered from the selected entry up to
 * Account default. Owner clients need it to label per-field provenance and the
 * direct parent link; deriving those names by walking the graph client side
 * would be an N+1 read of the same rows the DTO already loaded.
 */
export type InferenceConfigurationPathEntry = {
	id: string;
	displayName: string;
	revision: number;
} & InferenceConfigurationEntryIdentity;

export const redactedOwnerDtoBrand: unique symbol = Symbol("redactedInferenceConfigurationOwnerDto");

type RedactedInferenceConfigurationDtoBase = {
	readonly [redactedOwnerDtoBrand]: true;
	id: string;
	parentId: string | null;
	displayName: string;
	revision: number;
	overrides: OwnerInferenceConfigurationOverrides;
	credential: {
		mode: InferenceCredentialMode;
		available: boolean;
		secretVersion: number;
		resolution: RedactedInferenceCredentialResolution;
	};
	effectiveModel: string;
	imagePreviews: { participant: EffectiveImageSettings; world: EffectiveImageSettings };
	/** Index 0 is this configuration; the last element is Account default. */
	path: InferenceConfigurationPathEntry[];
	fields: RedactedInferenceFieldDtoMap;
	graphRevision: number;
	fingerprint: string;
};

export type RedactedInferenceConfigurationDto = RedactedInferenceConfigurationDtoBase & InferenceConfigurationEntryIdentity;

export type RedactedInferenceCredentialResolution =
	| { kind: "available"; source: InferenceSource; secretVersion: number }
	| Extract<InferenceCredentialResolution, { kind: "explicit_none" | "unavailable" }>;

/**
 * Owner JSON uses single-key discriminants so portable MCP schemas can express
 * the exact union with min/maxProperties, without oneOf or optional-source
 * combinations that would weaken the contract.
 */
export type RedactedInferenceSource =
	| { configuration: Omit<Extract<InferenceSource, { kind: "configuration" }>, "kind"> }
	| { accountDefault: Omit<Extract<InferenceSource, { kind: "account_default" }>, "kind"> }
	| { bickrDefault: null };

export type RedactedInferenceFieldProvenance =
	| { unset: null }
	| { configured: RedactedInferenceSource };

export type RedactedInferenceFieldResolvedRequest<K extends InferenceConfigurationField> =
	| { value: OwnerInferenceConfigurationFieldValue<K> }
	| { explicitNone: null }
	| { targetDefault: null }
	| { unset: null };

export function redactedInferenceFieldResolvedRequest<K extends InferenceConfigurationField>(
	request: InferenceFieldResolvedRequest<K>,
): RedactedInferenceFieldResolvedRequest<K> {
	switch (request.kind) {
		case "value": return { value: request.value } as RedactedInferenceFieldResolvedRequest<K>;
		case "explicit_none": return { explicitNone: null };
		case "target_default": return { targetDefault: null };
		case "unset": return { unset: null };
	}
}

export function redactedInferenceFieldProvenance(
	provenance: InferenceFieldProvenance,
): RedactedInferenceFieldProvenance {
	if (provenance.kind === "unset") return { unset: null };
	switch (provenance.source.kind) {
		case "configuration": {
			const { kind: _kind, ...configuration } = provenance.source;
			return { configured: { configuration } };
		}
		case "account_default": {
			const { kind: _kind, ...accountDefault } = provenance.source;
			return { configured: { accountDefault } };
		}
		case "bickr_default": return { configured: { bickrDefault: null } };
	}
}

export function inferenceSourceFromRedactedProvenance(
	provenance: RedactedInferenceFieldProvenance,
): InferenceSource | null {
	if ("unset" in provenance) return null;
	const source = provenance.configured;
	if ("configuration" in source) return { kind: "configuration", ...source.configuration };
	if ("accountDefault" in source) return { kind: "account_default", ...source.accountDefault };
	return { kind: "bickr_default" };
}

/**
 * This public shape is deliberately distinct from the internal resolution
 * types. Adding a secret-bearing member to the resolver cannot silently make
 * it serializable through an owner endpoint.
 */
export type RedactedInferenceFieldDto<K extends InferenceConfigurationField> = {
	override: InferenceOverrideUpdate<K>;
	request: RedactedInferenceFieldResolvedRequest<K>;
	effective: InferenceFieldEffectiveValues[K];
	provenance: RedactedInferenceFieldProvenance;
	adjustment: InferenceFieldAdjustment;
	inherited: {
		request: RedactedInferenceFieldResolvedRequest<K>;
		effective: InferenceFieldEffectiveValues[K];
		provenance: RedactedInferenceFieldProvenance;
		adjustment: InferenceFieldAdjustment;
	};
};

export type RedactedInferenceFieldDtoMap = {
	[K in InferenceConfigurationField]: RedactedInferenceFieldDto<K>;
};

export type InferenceEffectiveCredentialAvailability =
	| { kind: "available"; source: InferenceSource }
	| { kind: "explicit_none"; source: InferenceSource }
	| { kind: "unavailable"; source: InferenceSource | { kind: "bickr_default" }; reason: InferenceCredentialUnavailableReason };

type InferenceConfigurationSummaryBase = {
	id: string;
	parentId: string | null;
	displayName: string;
	revision: number;
	updatedAt: string;
	credentialMode: InferenceCredentialMode;
	/** Resolved availability only; never a secret or a secret-derived value. */
	credentialAvailability: InferenceEffectiveCredentialAvailability;
	immediateChildCount: number;
	effectiveModel: string;
	parent: ({ id: string; displayName: string; revision: number } & InferenceConfigurationEntryIdentity) | null;
};

export type InferenceConfigurationSummary = InferenceConfigurationSummaryBase & InferenceConfigurationEntryIdentity;

export type CanonicalInferenceFixedReference =
	| { kind: "account_default" }
	| { kind: "translation" }
	| { kind: "world"; worldId: string }
	| { kind: "bot"; botId: string };

/**
 * Caller-facing resolution of one fixed consumer. Canonical annotations carry
 * only redacted owner data. Pre-cutover compatibility intentionally carries no
 * graph identity because no canonical entry is active yet; Agent Runtime
 * computes its model with the same fallback used by the provider loop.
 */
export type CanonicalInferenceAnnotation =
	| {
		kind: "canonical";
		reference: CanonicalInferenceFixedReference;
		configuration: InferenceConfigurationSummary;
	}
	| {
		kind: "legacy_compatibility";
		reference: CanonicalInferenceFixedReference;
		effectiveModel: string;
		reason: "graph_not_migrated";
	};

export type CanonicalInferenceAnnotationRequest = {
	accountDefault?: boolean;
	translation?: boolean;
	botIds?: string[];
	worldIds?: string[];
};

export type CanonicalInferenceAnnotationSet = {
	annotations: CanonicalInferenceAnnotation[];
	graphRevision: number;
};

export const maximumCanonicalInferenceAnnotationBatch = 100;

export type InferenceConfigurationPage = {
	items: InferenceConfigurationSummary[];
	nextCursor?: string;
};

/**
 * The canonical effective model of one owned participant, resolved by the
 * server from the graph exactly as the runtime resolves it. It is the whole
 * payload owner surfaces need to label a participant's current model, so no
 * caller has to reconstruct one from a stored legacy settings cascade, and it
 * carries nothing else about the configuration — no credential state, no base
 * URL, no override map.
 */
export type InferenceBotEffectiveModel = { botId: string; effectiveModel: string };

/**
 * Answered for a bounded set of participants in one request. Owner screens hold
 * the participants they render, so they ask for that set instead of reading a
 * configuration per row.
 */
export type InferenceBotEffectiveModelSet = { models: InferenceBotEffectiveModel[] };

/** One request resolves at most this many participants; clients chunk to it. */
export const maximumInferenceBotEffectiveModelBatch = 100;

/**
 * Library sections are paginated independently so an editor never has to read
 * a whole owner library to render one column. Each section keeps its own sort
 * order, and cursors are tagged with that order so a cursor can never be
 * replayed against a different one.
 */
export const inferenceLibrarySections = ["account", "custom", "world", "bot"] as const;

export type InferenceLibrarySection = typeof inferenceLibrarySections[number];

export type InferenceBotHomeWorldGroup = {
	homeWorldId: string;
	homeWorldHandle: string;
	displayName: string;
	botConfigurationCount: number;
};

export type InferenceLibraryPage = InferenceConfigurationPage & {
	section: InferenceLibrarySection;
	/** Non-empty only for the bot section, which groups by home world. */
	groups: InferenceBotHomeWorldGroup[];
};

export type ParentCandidatePage = InferenceConfigurationPage;

export type InferenceImmediateChildrenPage = InferenceConfigurationPage & {
	/** Immediate children before `q` filtering, so a filtered page can say so. */
	totalImmediateChildren: number;
};

export type InferenceImpactChangeCounts = {
	effectiveModel: number;
	effectiveBaseUrl: number;
	credentialAvailability: number;
	credentialSource: number;
	providerAccess: number;
};

export type InferenceImpactWarning =
	| { kind: "effective_model_changes"; configurations: number }
	| { kind: "effective_base_url_changes"; configurations: number }
	| { kind: "credential_availability_changes"; configurations: number }
	| { kind: "credential_source_changes"; configurations: number }
	| { kind: "provider_access_changes"; configurations: number };

type InferenceDependentImpact = {
	configurationId: string;
	immediateDependentCount: number;
	transitiveDependentCount: number;
	affectedConfigurationCount: number;
	changes: InferenceImpactChangeCounts;
	warnings: InferenceImpactWarning[];
};

export type InferenceParentImpact = InferenceDependentImpact & {
	kind: "reparent";
	candidateParentId: string;
};

export type InferenceDeleteImpact = InferenceDependentImpact & {
	kind: "delete";
	parentId: string;
	/** Compatibility alias for clients shipped with the first Phase-3 draft. */
	immediateChildren: number;
};

export type CredentialUpdate =
	| { mode: "inherit" }
	| { mode: "account_default" }
	| { mode: "none" }
	| { mode: "value"; secret: string };
