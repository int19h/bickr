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
	InferenceConfigurationOverrides,
	InferenceCredentialMode,
	InferenceCredentialResolution,
	InferenceCredentialUnavailableReason,
	InferenceFieldAdjustment,
	InferenceOverrideUpdate,
	InferenceSource,
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
	| { kind: "world"; worldId: string }
	| { kind: "bot"; botId: string };

export const fixedInferenceConfigurationKinds = ["account_default", "world", "bot"] as const;

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
	overrides: InferenceConfigurationOverrides;
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
 * This public shape is deliberately distinct from the internal resolution
 * types. Adding a secret-bearing member to the resolver cannot silently make
 * it serializable through an owner endpoint.
 */
export type RedactedInferenceFieldDto<K extends InferenceConfigurationField> = {
	override: InferenceOverrideUpdate<K>;
	effective: unknown;
	source: InferenceSource;
	adjustment: InferenceFieldAdjustment;
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

export type InferenceConfigurationPage = {
	items: InferenceConfigurationSummary[];
	nextCursor?: string;
};

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
	resetsTranslationSelection: boolean;
};

export type TranslationSelection = {
	ownerUserId: string;
	configurationId: string;
	revision: number;
	updatedAt: string;
};

export type CredentialUpdate =
	| { mode: "inherit" }
	| { mode: "account_default" }
	| { mode: "none" }
	| { mode: "value"; secret: string };
