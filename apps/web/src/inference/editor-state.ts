import type { RedactedInferenceConfigurationDto } from "@bickr/shared/inference-configuration-owner";
import { draftMapFromFields, inferenceEditorFields, sameDraft, draftFromOverride, inferenceFieldLabels, type InferenceFieldDraftMap } from "./field-model";

export type StaleConflict = {
	fields: string[];
	nameChanged: boolean;
	/** The server copy, held for comparison only until the owner chooses. */
	server: RedactedInferenceConfigurationDto;
};

/** How a reload handles the current drafts. */
export type RefreshDecision = "adopt" | "keep_drafts" | "conflict";

/**
 * Clean drafts adopt the server copy. If the revision is unchanged, keep the
 * edits and refresh the inherited values. If the revision changed, keep the
 * loaded revision until the user resolves the conflict.
 */
export function refreshDecision(input: { currentRevision: number; nextRevision: number; dirty: boolean }): RefreshDecision {
	if (!input.dirty) return "adopt";
	return input.nextRevision === input.currentRevision ? "keep_drafts" : "conflict";
}

/** List fields and the name that differ from the saved copy. */
export function staleConflict(
	server: RedactedInferenceConfigurationDto,
	drafts: InferenceFieldDraftMap | null,
	nameDraft: string,
): StaleConflict {
	return {
		fields: conflictingFieldLabels(drafts, server),
		nameChanged: server.kind === "custom" && nameDraft.trim() !== server.identity.name,
		server,
	};
}

export function staleComparisonText(stale: Pick<StaleConflict, "fields" | "nameChanged">): string {
	const differing = [...stale.fields, ...(stale.nameChanged ? ["Name"] : [])];
	return differing.length > 0
		? `Differs from the saved copy: ${differing.join(", ")}.`
		: "Your edited fields match the saved copy; only the revision moved.";
}

export function conflictingFieldLabels(
	drafts: InferenceFieldDraftMap | null,
	server: RedactedInferenceConfigurationDto,
): string[] {
	if (!drafts) return [];
	return inferenceEditorFields
		.filter((field) => !sameDraft(drafts[field], draftFromOverride(field, server.fields[field].override)))
		.map((field) => inferenceFieldLabels[field]);
}

/** Adopt normalized saved fields while keeping edits made after submission. */
export function draftsAfterSave(server: RedactedInferenceConfigurationDto, submitted: InferenceFieldDraftMap, current: InferenceFieldDraftMap): InferenceFieldDraftMap {
	const next = draftMapFromFields(server.fields);
	for (const field of inferenceEditorFields) {
		if (!sameDraft(submitted[field], current[field])) next[field] = current[field];
	}
	return next;
}
