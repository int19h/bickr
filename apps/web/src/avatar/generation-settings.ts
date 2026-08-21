import type {
	InferenceConfigurationField,
	InferenceConfigurationOverridePatch,
} from "@bickr/shared/inference-configuration";
import type { RedactedInferenceFieldDtoMap } from "@bickr/shared/inference-configuration-owner";
import type {
	BotImageGenerationSettingsInput,
	BotInferenceReasoningEffort,
	BotInferenceSettingsInput,
	JsonObject,
} from "@bickr/shared/model";

import {
	draftFromOverride,
	effectiveValueText,
	overrideFromDraft,
	sameDraft,
	inferenceFieldLabels,
	type InferenceFieldDraft,
} from "../inference/field-model";

/**
 * The avatar screen edits its target's fixed configuration directly, but only
 * these two field groups: the image request fields, and — for worlds — the
 * text fields their prompt fill request actually uses. Provider plumbing
 * (base URL, credential) stays in the configuration editor.
 */
export const avatarImageSettingsFields = [
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
] as const satisfies readonly InferenceConfigurationField[];

export const avatarPromptFillSettingsFields = [
	"model",
	"reasoning",
	"providerRouting",
	"temperature",
	"topK",
	"topP",
	"minP",
	"frequencyPenalty",
	"presencePenalty",
	"repetitionPenalty",
] as const satisfies readonly InferenceConfigurationField[];

/**
 * Unsaved edits, keyed by configuration field; a missing entry means the
 * saved override state stands. The flat avatar form can express only two
 * states — a typed value or an empty input. Typing yields a value draft. An
 * emptied input clears a value override back to inherit, but leaves any other
 * explicit state (explicit absence, target default) untouched: those states
 * render as an empty input already, and only the configuration editor can
 * change them.
 */
export type AvatarSettingsDrafts = Partial<Record<InferenceConfigurationField, InferenceFieldDraft>>;

export function avatarFieldDraft(
	drafts: AvatarSettingsDrafts,
	fields: RedactedInferenceFieldDtoMap,
	field: InferenceConfigurationField,
): InferenceFieldDraft {
	return drafts[field] ?? draftFromOverride(field, fields[field].override);
}

export function avatarDraftText(draft: InferenceFieldDraft): string {
	return draft.mode === "explicit" && draft.state === "value" ? draft.text : "";
}

/** The draft an emptied input maps to; see {@link AvatarSettingsDrafts}. */
export function avatarClearedDraft(
	fields: RedactedInferenceFieldDtoMap,
	field: InferenceConfigurationField,
): InferenceFieldDraft {
	const saved = draftFromOverride(field, fields[field].override);
	return saved.mode === "explicit" && saved.state === "value" ? { mode: "inherit" } : saved;
}

/**
 * What an empty input resolves to: the inherited value once a cleared override
 * is saved, and the current resolved value otherwise (which covers explicit
 * absence and target-default states too).
 */
export function avatarFieldPlaceholder(
	drafts: AvatarSettingsDrafts,
	fields: RedactedInferenceFieldDtoMap,
	field: InferenceConfigurationField,
): string {
	const dto = fields[field];
	const draft = avatarFieldDraft(drafts, fields, field);
	const savedDraft = draftFromOverride(field, dto.override);
	const effective = draft.mode === "inherit" && savedDraft.mode !== "inherit"
		? dto.inherited.effective
		: dto.effective;
	return effectiveValueText(field, effective);
}

/**
 * The model generation will actually use for the current draft: the typed
 * value, the inherited value after an unsaved clear, and otherwise the
 * target-resolved value the caller supplies (the DTO's image preview for
 * image fields, its effective model for prompt fill).
 */
export function avatarEffectiveDraftModel(
	drafts: AvatarSettingsDrafts,
	fields: RedactedInferenceFieldDtoMap,
	field: Extract<InferenceConfigurationField, "imageModel" | "model">,
	resolvedModel: string | undefined,
): string {
	const draft = avatarFieldDraft(drafts, fields, field);
	if (draft.mode === "explicit" && draft.state === "value" && draft.text.trim()) return draft.text.trim();
	const saved = draftFromOverride(field, fields[field].override);
	if (draft.mode === "inherit" && saved.mode !== "inherit") {
		const inherited = fields[field].inherited.effective;
		return typeof inherited === "string" ? inherited : "";
	}
	return resolvedModel ?? "";
}

export function avatarSettingsChanged(
	editableFields: readonly InferenceConfigurationField[],
	drafts: AvatarSettingsDrafts,
	fields: RedactedInferenceFieldDtoMap,
): boolean {
	return editableFields.some((field) =>
		!sameDraft(avatarFieldDraft(drafts, fields, field), draftFromOverride(field, fields[field].override)),
	);
}

export function avatarSettingsOverridden(
	editableFields: readonly InferenceConfigurationField[],
	fields: RedactedInferenceFieldDtoMap,
): boolean {
	return editableFields.some((field) => fields[field].override.kind !== "inherit");
}

/** Every editable field back to inherit; Save turns this into the reset patch. */
export function avatarResetDrafts(editableFields: readonly InferenceConfigurationField[]): AvatarSettingsDrafts {
	return Object.fromEntries(editableFields.map((field) => [field, { mode: "inherit" }]));
}

export function avatarSettingsPatch(
	editableFields: readonly InferenceConfigurationField[],
	drafts: AvatarSettingsDrafts,
	fields: RedactedInferenceFieldDtoMap,
): { ok: true; patch: InferenceConfigurationOverridePatch } | { ok: false; message: string } {
	const patch: Record<string, unknown> = {};
	for (const field of editableFields) {
		const draft = avatarFieldDraft(drafts, fields, field);
		if (sameDraft(draft, draftFromOverride(field, fields[field].override))) continue;
		const parsed = overrideFromDraft(field, draft, inferenceFieldLabels[field]);
		if (!parsed.ok) return parsed;
		patch[field] = parsed.update;
	}
	return { ok: true, patch: patch as InferenceConfigurationOverridePatch };
}

/** First value-parse failure across the editable fields, or an empty string. */
export function avatarSettingsError(
	editableFields: readonly InferenceConfigurationField[],
	drafts: AvatarSettingsDrafts,
	fields: RedactedInferenceFieldDtoMap,
): string {
	const parsed = avatarSettingsPatch(editableFields, drafts, fields);
	return parsed.ok ? "" : parsed.message;
}

function draftJsonValue(text: string): JsonObject | undefined {
	try {
		const parsed: unknown = JSON.parse(text);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonObject) : undefined;
	} catch {
		return undefined;
	}
}

function draftNumberValue(text: string): number | undefined {
	const parsed = Number(text.trim());
	return text.trim() && Number.isFinite(parsed) ? parsed : undefined;
}

function draftValues(
	editableFields: readonly InferenceConfigurationField[],
	drafts: AvatarSettingsDrafts,
	fields: RedactedInferenceFieldDtoMap,
): Partial<Record<InferenceConfigurationField, string>> {
	const values: Partial<Record<InferenceConfigurationField, string>> = {};
	for (const field of editableFields) {
		const draft = avatarFieldDraft(drafts, fields, field);
		if (draft.mode === "explicit" && draft.state === "value" && draft.text.trim()) {
			values[field] = draft.text.trim();
		}
	}
	return values;
}

/**
 * The one-shot generation bundle: every explicitly valued field as the form
 * shows it. The request overlays the bundle on the canonical resolution, so
 * fields left inherited (or in a non-value explicit state) resolve exactly as
 * the placeholders display them. Returns undefined when nothing is unsaved —
 * the request then omits the bundle and resolves purely canonically.
 */
export function imageSettingsRequestBundle(
	drafts: AvatarSettingsDrafts,
	fields: RedactedInferenceFieldDtoMap,
): BotImageGenerationSettingsInput | undefined {
	if (!avatarSettingsChanged(avatarImageSettingsFields, drafts, fields)) return undefined;
	const values = draftValues(avatarImageSettingsFields, drafts, fields);
	const providerRouting = values.imageProviderRouting ? draftJsonValue(values.imageProviderRouting) : undefined;
	return {
		...(values.imageModel ? { model: values.imageModel } : {}),
		...(values.imageAspectRatio ? { aspectRatio: values.imageAspectRatio } : {}),
		...(values.imageSize ? { imageSize: values.imageSize } : {}),
		...(providerRouting ? { providerRouting } : {}),
		...(numberEntry("temperature", values.imageTemperature)),
		...(numberEntry("topK", values.imageTopK)),
		...(numberEntry("topP", values.imageTopP)),
		...(numberEntry("minP", values.imageMinP)),
		...(numberEntry("frequencyPenalty", values.imageFrequencyPenalty)),
		...(numberEntry("presencePenalty", values.imagePresencePenalty)),
		...(numberEntry("repetitionPenalty", values.imageRepetitionPenalty)),
	};
}

/**
 * The one-shot prompt fill bundle for world description/members fills; same
 * overlay contract as {@link imageSettingsRequestBundle}. The bickr_automatic
 * reasoning option has no legacy request encoding, so an unsaved automatic
 * choice is omitted and applies only once saved.
 */
export function promptFillSettingsRequestBundle(
	drafts: AvatarSettingsDrafts,
	fields: RedactedInferenceFieldDtoMap,
): BotInferenceSettingsInput | undefined {
	if (!avatarSettingsChanged(avatarPromptFillSettingsFields, drafts, fields)) return undefined;
	const values = draftValues(avatarPromptFillSettingsFields, drafts, fields);
	const providerRouting = values.providerRouting ? draftJsonValue(values.providerRouting) : undefined;
	const reasoningEffort = legacyReasoningEffort(values.reasoning);
	return {
		...(values.model ? { model: values.model } : {}),
		...(reasoningEffort ? { reasoningEffort } : {}),
		...(providerRouting ? { providerRouting } : {}),
		...(numberEntry("temperature", values.temperature)),
		...(numberEntry("topK", values.topK)),
		...(numberEntry("topP", values.topP)),
		...(numberEntry("minP", values.minP)),
		...(numberEntry("frequencyPenalty", values.frequencyPenalty)),
		...(numberEntry("presencePenalty", values.presencePenalty)),
		...(numberEntry("repetitionPenalty", values.repetitionPenalty)),
	};
}

function numberEntry(key: string, text: string | undefined): Record<string, number> {
	const parsed = text === undefined ? undefined : draftNumberValue(text);
	return parsed === undefined ? {} : { [key]: parsed };
}

function legacyReasoningEffort(option: string | undefined): BotInferenceReasoningEffort | undefined {
	switch (option) {
		case "provider_default": return "default";
		case "none":
		case "minimal":
		case "low":
		case "medium":
		case "high":
		case "xhigh":
			return option;
		default: return undefined;
	}
}
