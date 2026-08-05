import type {
	CompactionReasoningResolution,
	CompactionReasoningSelection,
} from "@bickr/shared/openrouter-model-capabilities";
import type {
	InferenceConfigurationField,
	InferenceConfigurationOverridePatch,
	InferenceFieldAdjustment,
	InferenceOverrideUpdate,
	InferenceSource,
} from "@bickr/shared/inference-configuration";
import {
	inferenceFieldOverrideStates,
	numericInferenceFieldDomains,
	type InferenceConfigurationPathEntry,
	type NumericInferenceFieldDomain,
	type RedactedInferenceConfigurationDto,
	type RedactedInferenceFieldDtoMap,
} from "@bickr/shared/inference-configuration-owner";

/**
 * Editor state for the discriminated override protocol.
 *
 * Every control renders from and writes back to this shape, and every value is
 * carried as the text the owner sees. Nothing is inferred from truthiness: an
 * explicit `false`, `0`, empty routing object, provider default, explicit
 * absence, and image target default are each a distinct state here and stay
 * distinct all the way into the patch.
 */
export type InferenceFieldDraft =
	| { mode: "inherit" }
	| { mode: "explicit"; state: "value"; text: string }
	| { mode: "explicit"; state: "explicit_none" }
	| { mode: "explicit"; state: "target_default" }
	| { mode: "explicit"; state: "account_default" };

export type InferenceFieldDraftMap = Record<InferenceConfigurationField, InferenceFieldDraft>;

export type InferenceExplicitState = Extract<InferenceFieldDraft, { mode: "explicit" }>["state"];

export type InferenceFieldControl =
	| { control: "text"; placeholderKind: "url" | "model" | "free" }
	| { control: "number"; domain: NumericInferenceFieldDomain; step: number }
	| { control: "json" }
	| { control: "boolean" }
	| { control: "enum"; options: readonly InferenceEnumOption[] };

export type InferenceEnumOption = { value: string; label: string };

const reasoningOptions: readonly InferenceEnumOption[] = [
	{ value: "provider_default", label: "Provider default" },
	{ value: "none", label: "Disabled" },
	{ value: "minimal", label: "Minimal" },
	{ value: "low", label: "Low" },
	{ value: "medium", label: "Medium" },
	{ value: "high", label: "High" },
	{ value: "xhigh", label: "XHigh" },
];

const compactionReasoningOptions: readonly InferenceEnumOption[] = [
	{ value: "reasoning_disabled", label: "Disabled" },
	{ value: "model_default", label: "Model default" },
	{ value: "minimal", label: "Minimal" },
	{ value: "low", label: "Low" },
	{ value: "medium", label: "Medium" },
	{ value: "high", label: "High" },
	{ value: "xhigh", label: "XHigh" },
];

const toolCallOptions: readonly InferenceEnumOption[] = [
	{ value: "provider_default", label: "Provider default" },
	{ value: "require", label: "Require" },
	{ value: "railroad", label: "Railroad" },
	{ value: "at_will", label: "At will" },
];

const compactionModeOptions: readonly InferenceEnumOption[] = [
	{ value: "provider_default", label: "Provider default" },
	{ value: "structured_output", label: "Structured output" },
	{ value: "tool_call", label: "Tool call" },
	{ value: "tool_call_cache_friendly", label: "Tool call (cache-friendly)" },
];

const promptCacheOptions: readonly InferenceEnumOption[] = [
	{ value: "provider_default", label: "Provider default" },
	{ value: "off", label: "Off" },
	{ value: "openrouter_anthropic_5m", label: "Claude 5m (1.25x write)" },
	{ value: "openrouter_anthropic_1h", label: "Claude 1h (2x write)" },
];

export function inferenceFieldControl(field: InferenceConfigurationField): InferenceFieldControl {
	switch (field) {
		case "baseUrl": return { control: "text", placeholderKind: "url" };
		case "model":
		case "imageModel": return { control: "text", placeholderKind: "model" };
		case "imageAspectRatio":
		case "imageSize": return { control: "text", placeholderKind: "free" };
		case "providerRouting":
		case "imageProviderRouting": return { control: "json" };
		case "supportsPrefill": return { control: "boolean" };
		case "reasoning": return { control: "enum", options: reasoningOptions };
		case "compactionReasoning": return { control: "enum", options: compactionReasoningOptions };
		case "toolCalls": return { control: "enum", options: toolCallOptions };
		case "compactionMode": return { control: "enum", options: compactionModeOptions };
		case "promptCacheMode": return { control: "enum", options: promptCacheOptions };
		default: {
			const domain = numericInferenceFieldDomains[field];
			return { control: "number", domain, step: domain.integer ? 1 : numericStep(domain) };
		}
	}
}

function numericStep(domain: NumericInferenceFieldDomain): number {
	return domain.max - domain.min > 100 ? 1 : 0.05;
}

export function draftFromOverride<K extends InferenceConfigurationField>(
	field: K,
	override: InferenceOverrideUpdate<K>,
): InferenceFieldDraft {
	switch (override.kind) {
		case "inherit": return { mode: "inherit" };
		case "explicit_none": return { mode: "explicit", state: "explicit_none" };
		case "target_default": return { mode: "explicit", state: "target_default" };
		case "account_default": return { mode: "explicit", state: "account_default" };
		case "value": return { mode: "explicit", state: "value", text: fieldValueText(field, override.value) };
	}
}

export function draftMapFromFields(fields: RedactedInferenceFieldDtoMap): InferenceFieldDraftMap {
	return Object.fromEntries(
		inferenceEditorFields.map((field) => [field, draftFromOverride(field, fields[field].override)]),
	) as InferenceFieldDraftMap;
}

export type OverrideParseResult =
	| { ok: true; update: InferenceOverrideUpdate<InferenceConfigurationField> }
	| { ok: false; message: string };

export function overrideFromDraft(
	field: InferenceConfigurationField,
	draft: InferenceFieldDraft,
	label: string,
): OverrideParseResult {
	if (draft.mode === "inherit") return { ok: true, update: { kind: "inherit" } };
	if (draft.state !== "value") {
		return { ok: true, update: { kind: draft.state } as InferenceOverrideUpdate<InferenceConfigurationField> };
	}
	return parsedFieldValue(field, draft.text, label);
}

function parsedFieldValue(
	field: InferenceConfigurationField,
	text: string,
	label: string,
): OverrideParseResult {
	const control = inferenceFieldControl(field);
	const trimmed = text.trim();
	switch (control.control) {
		case "text": {
			if (!trimmed) return { ok: false, message: `${label} needs a value or an inherited state.` };
			return value(trimmed);
		}
		case "number": {
			if (!trimmed) return { ok: false, message: `${label} needs a number or an inherited state.` };
			const parsed = Number(trimmed);
			const { min, max, integer } = control.domain;
			if (!Number.isFinite(parsed) || parsed < min || parsed > max || (integer && !Number.isSafeInteger(parsed))) {
				return { ok: false, message: `${label} must be between ${min} and ${max}.` };
			}
			return value(parsed);
		}
		case "json": {
			if (!trimmed) return { ok: false, message: `${label} needs JSON or an inherited state.` };
			let parsed: unknown;
			try {
				parsed = JSON.parse(trimmed);
			} catch {
				return { ok: false, message: `${label} must be valid JSON.` };
			}
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				return { ok: false, message: `${label} must be a JSON object.` };
			}
			return value(parsed);
		}
		case "boolean":
			return value(trimmed === "true");
		case "enum":
			return value(enumRequestValue(field, trimmed));
	}
}

function value(parsed: unknown): OverrideParseResult {
	return { ok: true, update: { kind: "value", value: parsed } as InferenceOverrideUpdate<InferenceConfigurationField> };
}

function enumRequestValue(field: InferenceConfigurationField, option: string): unknown {
	switch (field) {
		case "reasoning":
			if (option === "provider_default") return { kind: "provider_default" };
			if (option === "none") return { kind: "reasoning_disabled" };
			return { kind: "explicit_effort", effort: option };
		case "compactionReasoning":
			if (option === "reasoning_disabled" || option === "model_default") return { kind: option };
			return { kind: "explicit_effort", effort: option };
		case "toolCalls":
			return option === "provider_default" ? { kind: "provider_default" } : { kind: "strategy", strategy: option };
		case "compactionMode":
		case "promptCacheMode":
			return option === "provider_default" ? { kind: "provider_default" } : { kind: "mode", mode: option };
		default:
			return option;
	}
}

/** Inverse of {@link enumRequestValue}; also formats plain values for inputs. */
export function fieldValueText(field: InferenceConfigurationField, fieldValue: unknown): string {
	const control = inferenceFieldControl(field);
	switch (control.control) {
		case "json": return JSON.stringify(fieldValue, null, 2);
		case "boolean": return fieldValue === true ? "true" : "false";
		case "enum": return enumOptionValue(field, fieldValue);
		default: return fieldValue === null || fieldValue === undefined ? "" : String(fieldValue);
	}
}

function enumOptionValue(field: InferenceConfigurationField, request: unknown): string {
	if (!request || typeof request !== "object") return "";
	const record = request as { kind?: string; effort?: string; strategy?: string; mode?: string };
	switch (record.kind) {
		case "provider_default": return "provider_default";
		case "reasoning_disabled": return field === "reasoning" ? "none" : "reasoning_disabled";
		case "model_default": return "model_default";
		case "explicit_effort": return record.effort ?? "";
		case "strategy": return record.strategy ?? "";
		case "mode": return record.mode ?? "";
		default: return "";
	}
}

/**
 * Only fields whose draft differs from the loaded override reach the patch, so
 * an unrelated save cannot rewrite (or silently normalize) a state the owner
 * never touched — including the migrated Account-default base URL.
 */
export function overridePatchFromDrafts(
	drafts: InferenceFieldDraftMap,
	fields: RedactedInferenceFieldDtoMap,
	labels: Record<InferenceConfigurationField, string>,
): { ok: true; patch: InferenceConfigurationOverridePatch } | { ok: false; message: string } {
	const patch: Record<string, unknown> = {};
	for (const field of inferenceEditorFields) {
		const draft = drafts[field];
		if (sameDraft(draft, draftFromOverride(field, fields[field].override))) continue;
		const parsed = overrideFromDraft(field, draft, labels[field]);
		if (!parsed.ok) return parsed;
		patch[field] = parsed.update;
	}
	return { ok: true, patch: patch as InferenceConfigurationOverridePatch };
}

export function sameDraft(left: InferenceFieldDraft, right: InferenceFieldDraft): boolean {
	if (left.mode !== right.mode) return false;
	if (left.mode === "inherit" || right.mode === "inherit") return true;
	if (left.state !== right.state) return false;
	return left.state !== "value" || right.state !== "value" || left.text === right.text;
}

export function draftsChanged(drafts: InferenceFieldDraftMap, fields: RedactedInferenceFieldDtoMap): boolean {
	return inferenceEditorFields.some((field) => !sameDraft(drafts[field], draftFromOverride(field, fields[field].override)));
}

/**
 * Boolean cycle state, derived entirely from the draft the control renders.
 *
 * The position in the cycle is the relationship between the explicit value and
 * the inherited one, so nothing about the cycle has to survive outside the
 * draft: an explicit copy of the inherited value is the seeded step, and an
 * explicit opposite is the step before returning to inherit. A remembered
 * "already flipped" flag would be lost on the next render and strand the
 * checkbox between the two explicit values.
 */
export type BooleanCycleState =
	| { mode: "inherit" }
	| { mode: "explicit"; value: boolean };

export function booleanCycleFromDraft(draft: InferenceFieldDraft): BooleanCycleState {
	if (draft.mode === "inherit") return { mode: "inherit" };
	if (draft.state !== "value") return { mode: "inherit" };
	return { mode: "explicit", value: draft.text === "true" };
}

/** inherit -> explicit inherited value -> explicit opposite -> inherit. */
export function nextBooleanCycleState(current: BooleanCycleState, inheritedValue: boolean): BooleanCycleState {
	if (current.mode === "inherit") return { mode: "explicit", value: inheritedValue };
	return current.value === inheritedValue ? { mode: "explicit", value: !inheritedValue } : { mode: "inherit" };
}

/** The draft one click/Space produces from the draft the control rendered. */
export function nextBooleanDraft(draft: InferenceFieldDraft, inheritedValue: boolean): InferenceFieldDraft {
	return draftFromBooleanCycleState(nextBooleanCycleState(booleanCycleFromDraft(draft), inheritedValue));
}

export function draftFromBooleanCycleState(state: BooleanCycleState): InferenceFieldDraft {
	return state.mode === "inherit"
		? { mode: "inherit" }
		: { mode: "explicit", state: "value", text: state.value ? "true" : "false" };
}

export type CheckboxDomState = { checked: boolean; indeterminate: boolean };

/** Inherit is the DOM mixed state; explicit true/false are the ordinary ones. */
export function booleanCheckboxDomState(state: BooleanCycleState): CheckboxDomState {
	return state.mode === "inherit"
		? { checked: false, indeterminate: true }
		: { checked: state.value, indeterminate: false };
}

/** Mode checkboxes never expose an unchecked meaning: inherit is mixed. */
export function modeCheckboxDomState(draft: InferenceFieldDraft): CheckboxDomState {
	return draft.mode === "inherit" ? { checked: false, indeterminate: true } : { checked: true, indeterminate: false };
}

/**
 * Applied from component state on every render and ref attachment. The DOM
 * property is an output of this state, never the place the state lives.
 */
export function applyCheckboxDomState(
	element: { checked: boolean; indeterminate: boolean } | null,
	state: CheckboxDomState,
): void {
	if (!element) return;
	element.checked = state.checked;
	element.indeterminate = state.indeterminate;
}

export function explicitStatesForField(field: InferenceConfigurationField, isAccountDefault: boolean): InferenceExplicitState[] {
	const states = inferenceFieldOverrideStates[field];
	return [
		"value" as const,
		...(states.explicitNone ? ["explicit_none" as const] : []),
		...(states.targetDefault ? ["target_default" as const] : []),
		// Account default has no ancestor to resume at, so it never offers the state.
		...(states.accountDefault && !isAccountDefault ? ["account_default" as const] : []),
	];
}

export function explicitStateLabel(state: InferenceExplicitState): string {
	switch (state) {
		case "value": return "Explicit value";
		case "explicit_none": return "Explicitly no value";
		case "target_default": return "Use the avatar target default";
		case "account_default": return "Use Account default";
	}
}

export function sourceLabel(source: InferenceSource, path: readonly InferenceConfigurationPathEntry[]): string {
	if (source.kind === "bickr_default") return "Bickr defaults";
	const entry = path.find((candidate) => candidate.id === source.configurationId);
	const name = entry?.displayName ?? (source.kind === "account_default" ? "Account default" : "an ancestor configuration");
	return source.depth === 0 ? `${name} (set here)` : name;
}

export function effectiveValueText(field: InferenceConfigurationField, effective: unknown): string {
	if (field === "compactionReasoning") {
		return compactionReasoningEffectiveText(effective as CompactionReasoningResolution);
	}
	if (effective === null || effective === undefined) return "no value";
	const control = inferenceFieldControl(field);
	if (control.control === "json") return JSON.stringify(effective);
	if (control.control === "boolean") return effective === true ? "on" : "off";
	if (control.control === "enum") {
		const option = enumOptionValue(field, effective) || String(effective);
		return control.options.find((candidate) => candidate.value === option)?.label ?? option;
	}
	return String(effective);
}

export function compactionReasoningEffectiveText(resolution: CompactionReasoningResolution | undefined): string {
	if (!resolution) return "no value";
	if (resolution.kind === "refused") return "refused by provider policy";
	return compactionSelectionText(resolution.selection);
}

export function compactionSelectionText(selection: CompactionReasoningSelection): string {
	switch (selection.kind) {
		case "reasoning_disabled": return "disabled";
		case "model_default": return selection.effort ? `model default (${selection.effort})` : "model default";
		case "explicit_effort": return selection.effort;
	}
}

export function compactionRefusalText(resolution: CompactionReasoningResolution): string | null {
	if (resolution.kind !== "refused") return null;
	switch (resolution.refusal.kind) {
		case "support_unknown_for_required_effort":
			return `This model has no published support for ${resolution.refusal.requiredEffort} compaction reasoning, so compaction would be refused.`;
		case "model_default_order_unknown_for_required_effort":
			return `This model's default reasoning effort cannot be compared with ${resolution.refusal.requiredEffort}, so compaction would be refused.`;
		case "no_supported_effort":
			return `This model supports ${resolution.refusal.supportedEfforts.join(", ") || "no"} compaction reasoning effort, which cannot satisfy ${resolution.refusal.required.effort}.`;
	}
}

export function adjustmentText(field: InferenceConfigurationField, adjustment: InferenceFieldAdjustment): string | null {
	if (!adjustment) return null;
	switch (adjustment.kind) {
		case "model_fell_back":
			return `${adjustment.requestedModel} cannot use the resolved provider credential, so ${adjustment.effectiveModel} is in effect.`;
		case "provider_or_model_default":
			return null;
		case "capability_adjustment":
			return `Requested ${effectiveValueText(field, adjustment.requested)}; this model or provider uses ${effectiveValueText(field, adjustment.effective)}.`;
		case "compaction_policy":
			return compactionRefusalText(adjustment.resolution);
	}
}

/** Requested value for compaction reasoning, independent of the applied policy. */
export function compactionRequestedText(dto: RedactedInferenceConfigurationDto): string {
	const adjustment = dto.fields.compactionReasoning.adjustment;
	if (!adjustment || adjustment.kind !== "compaction_policy") return "inherited";
	const configuration = adjustment.resolution.provenance.configuration;
	return configuration ? compactionSelectionText(configuration as CompactionReasoningSelection) : "not requested";
}

/**
 * The editor's field order. Groups mirror the spec's four sections; prompts,
 * translation behaviour, and bot/world runtime controls are absent by
 * construction because they are not reusable inference fields.
 */
export const inferenceFieldGroups = [
	{
		key: "provider",
		title: "Provider & model",
		description: "Credential intent, endpoint, model, and provider routing.",
		fields: ["baseUrl", "model", "providerRouting"],
	},
	{
		key: "loop",
		title: "Loop inference",
		description: "Normal-loop request shape and sampling.",
		fields: [
			"reasoning",
			"toolCalls",
			"promptCacheMode",
			"supportsPrefill",
			"temperature",
			"topK",
			"topP",
			"minP",
			"frequencyPenalty",
			"presencePenalty",
			"repetitionPenalty",
		],
	},
	{
		key: "compaction",
		title: "Compaction inference",
		description: "Compaction request shape only; budgets stay on the participant editor.",
		fields: ["compactionReasoning", "compactionMode"],
	},
	{
		key: "image",
		title: "Image generation",
		description:
			"Non-prompt image request fields. Aspect ratio and size defaults are target-specific, so the same configuration can end up with different participant and world results.",
		fields: [
			"imageModel",
			"imageAspectRatio",
			"imageSize",
			"imageProviderRouting",
			"imageTemperature",
			"imageTopK",
			"imageTopP",
			"imageMinP",
			"imageFrequencyPenalty",
			"imagePresencePenalty",
			"imageRepetitionPenalty",
		],
	},
] as const satisfies readonly {
	key: string;
	title: string;
	description: string;
	fields: readonly InferenceConfigurationField[];
}[];

export const inferenceEditorFields: readonly InferenceConfigurationField[] =
	inferenceFieldGroups.flatMap((group) => [...group.fields]);

export const inferenceFieldLabels: Record<InferenceConfigurationField, string> = {
	baseUrl: "Base URL",
	model: "Model",
	providerRouting: "Provider routing",
	reasoning: "Reasoning",
	compactionReasoning: "Compaction reasoning",
	toolCalls: "Tool calls",
	compactionMode: "Compaction request mode",
	promptCacheMode: "Prompt cache",
	supportsPrefill: "Supports prefill",
	temperature: "Temperature",
	topK: "Top K",
	topP: "Top P",
	minP: "Min P",
	frequencyPenalty: "Frequency penalty",
	presencePenalty: "Presence penalty",
	repetitionPenalty: "Repetition penalty",
	imageModel: "Image model",
	imageProviderRouting: "Image provider routing",
	imageAspectRatio: "Image aspect ratio",
	imageSize: "Image size",
	imageTemperature: "Image temperature",
	imageTopK: "Image top K",
	imageTopP: "Image top P",
	imageMinP: "Image min P",
	imageFrequencyPenalty: "Image frequency penalty",
	imagePresencePenalty: "Image presence penalty",
	imageRepetitionPenalty: "Image repetition penalty",
};
