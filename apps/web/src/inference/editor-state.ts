import type { RedactedInferenceConfigurationDto } from "@bickr/shared/inference-configuration-owner";
import { draftMapFromFields, inferenceEditorFields, sameDraft, draftFromOverride, inferenceFieldLabels, type InferenceFieldDraftMap } from "./field-model";

export type StaleConflict = {
	fields: string[];
	nameChanged: boolean;
	/** The server copy, held for comparison only until the owner chooses. */
	server: RedactedInferenceConfigurationDto;
};

/** What a reload may do to the drafts an owner is holding. */
export type RefreshDecision = "adopt" | "keep_drafts" | "conflict";

/**
 * A reload never resolves a conflict on the owner's behalf. Clean drafts adopt
 * the server copy; drafts held against the same revision keep their edits while
 * the refreshed effective and inherited values are adopted around them; a
 * newer revision under dirty drafts is a conflict the owner must resolve, so
 * the loaded revision — the one a save is still expected against — stays put.
 */
export function refreshDecision(input: { currentRevision: number; nextRevision: number; dirty: boolean }): RefreshDecision {
	if (!input.dirty) return "adopt";
	return input.nextRevision === input.currentRevision ? "keep_drafts" : "conflict";
}

/**
 * The comparison an owner is shown before choosing. It names every field whose
 * draft differs from the server copy, plus the name when an unsaved rename or a
 * rename made elsewhere disagrees with it.
 */
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
