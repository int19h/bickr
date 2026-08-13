import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { InferenceConfigurationField } from "@bickr/shared/inference-configuration";
import type {
	InferenceConfigurationSummary,
	InferenceDeleteImpact,
	InferenceImpactWarning,
	InferenceParentImpact,
	RedactedInferenceConfigurationDto,
	RedactedInferenceFieldDto,
	RedactedInferenceFieldDtoMap,
} from "@bickr/shared/inference-configuration-owner";
import {
	InferenceConfigurationEditorScreen,
	conflictingFieldLabels,
	deleteImpactLines,
	fieldSuggestions,
	impactForSelection,
	impactRequiresConfirmation,
	impactWarningText,
	orderedParentCandidates,
	refreshDecision,
	staleComparisonText,
	staleConflict,
} from "./editor";
import {
	adjustmentText,
	draftMapFromFields,
	inferenceEditorFields,
	inferenceFieldGroups,
} from "./field-model";
import { childrenPath } from "./api";

function fieldMap(): RedactedInferenceConfigurationDto["fields"] {
	const result = {} as RedactedInferenceFieldDtoMap;
	for (const field of inferenceEditorFields) {
		setField(result, field, {
			override: { kind: "inherit" },
			effective: null,
			provenance: { kind: "unset" },
			adjustment: null,
		});
	}
	return result;
}

function setField<K extends InferenceConfigurationField>(
	fields: RedactedInferenceFieldDtoMap,
	field: K,
	dto: RedactedInferenceFieldDto<K>,
): void {
	Object.assign(fields, { [field]: dto });
}

function customDto(overrides: Partial<RedactedInferenceConfigurationDto> = {}): RedactedInferenceConfigurationDto {
	return {
		id: "cfg_one",
		parentId: "cfg_root",
		displayName: "Shared sampling",
		revision: 3,
		kind: "custom",
		identity: { kind: "custom", name: "Shared sampling" },
		fields: fieldMap(),
		...overrides,
	} as RedactedInferenceConfigurationDto;
}

function parentImpact(candidateParentId: string): InferenceParentImpact {
	return {
		kind: "reparent",
		candidateParentId,
		configurationId: "cfg_one",
		immediateDependentCount: 1,
		transitiveDependentCount: 1,
		affectedConfigurationCount: 1,
		changes: { effectiveModel: 0, effectiveBaseUrl: 0, credentialAvailability: 0, credentialSource: 0, providerAccess: 0 },
		warnings: [],
	};
}

function impact(overrides: Partial<InferenceDeleteImpact> = {}): InferenceDeleteImpact {
	return {
		kind: "delete",
		configurationId: "cfg_one",
		parentId: "cfg_root",
		immediateChildren: 2,
		immediateDependentCount: 2,
		transitiveDependentCount: 5,
		affectedConfigurationCount: 5,
		changes: { effectiveModel: 0, effectiveBaseUrl: 0, credentialAvailability: 0, credentialSource: 0, providerAccess: 0 },
		warnings: [],
		...overrides,
	};
}

function candidate(id: string, kind: InferenceConfigurationSummary["kind"], displayName: string): InferenceConfigurationSummary {
	return {
		id,
		parentId: null,
		displayName,
		revision: 1,
		updatedAt: "2026-08-05T00:00:00.000Z",
		credentialMode: "inherit",
		credentialAvailability: { kind: "unavailable", source: { kind: "bickr_default" }, reason: "no_credential" },
		immediateChildCount: 0,
		effectiveModel: "openrouter/free",
		parent: null,
		kind,
		identity: kind === "account_default" ? { kind: "account_default" } : { kind: "custom", name: displayName },
	} as InferenceConfigurationSummary;
}

describe("editor field groups", () => {
	it("groups exactly the reusable fields and excludes every non-reusable control", () => {
		expect(inferenceFieldGroups.map((group) => group.title)).toEqual([
			"Provider & model",
			"Loop inference",
			"Compaction inference",
			"Image generation",
		]);
		const compaction = inferenceFieldGroups.find((group) => group.key === "compaction");
		expect(compaction?.fields).toEqual(["compactionReasoning", "compactionMode"]);
		const excluded: string[] = [
			"recurringPrompt",
			"translation",
			"contextWindowTokens",
			"compactionThreshold",
			"compactionSummaryPercent",
			"maxToolCallsPerTick",
			"allowEarlyLogOff",
			"imagePrompt",
		];
		for (const field of excluded) {
			expect(inferenceEditorFields as readonly string[]).not.toContain(field);
		}
	});

	it("starts every field draft from the loaded override map", () => {
		const fields = fieldMap();
		fields.temperature = {
			override: { kind: "value", value: 0 },
			effective: 0,
			provenance: { kind: "configured", source: { kind: "bickr_default" } },
			adjustment: null,
		};
		const drafts = draftMapFromFields(fields);
		expect(drafts.temperature).toEqual({ mode: "explicit", state: "value", text: "0" });
		expect(drafts.model).toEqual({ mode: "inherit" });
	});
});

describe("impact previews", () => {
	it("describes each warning with its affected count", () => {
		const warnings: InferenceImpactWarning[] = [
			{ kind: "effective_model_changes", configurations: 1 },
			{ kind: "credential_availability_changes", configurations: 3 },
			{ kind: "provider_access_changes", configurations: 2 },
		];
		expect(warnings.map(impactWarningText)).toEqual([
			"1 configuration would resolve a different model.",
			"3 configurations would gain or lose credential availability.",
			"2 configurations would change provider authorization, so their stored model may fall back.",
		]);
	});

	it("requires confirmation only for provider or credential loss", () => {
		expect(impactRequiresConfirmation([{ kind: "effective_model_changes", configurations: 4 }])).toBe(false);
		expect(impactRequiresConfirmation([{ kind: "effective_base_url_changes", configurations: 4 }])).toBe(false);
		expect(impactRequiresConfirmation([{ kind: "credential_source_changes", configurations: 1 }])).toBe(true);
		expect(impactRequiresConfirmation([{ kind: "provider_access_changes", configurations: 1 }])).toBe(true);
	});

	/**
	 * Impact answers are asynchronous, so one requested for an earlier candidate
	 * can arrive after the owner has moved to another. It must not describe the
	 * new selection, and — because the reparent button needs the selection's own
	 * preview — it must not be able to confirm it either.
	 */
	it("shows an impact preview only for the candidate it was requested for", () => {
		const answer = { candidateId: "cfg_first", impact: parentImpact("cfg_first") };
		expect(impactForSelection(answer, "cfg_first")).toBe(answer.impact);
		expect(impactForSelection(answer, "cfg_second")).toBeNull();
		expect(impactForSelection(answer, null)).toBeNull();
		expect(impactForSelection(null, "cfg_first")).toBeNull();
	});

	it("offers the current parent and Account default before searched results", () => {
		const ordered = orderedParentCandidates(
			[
				candidate("cfg_zzz", "custom", "Zebra"),
				candidate("cfg_root", "account_default", "Account default"),
				candidate("cfg_parent", "custom", "Current parent"),
			],
			"cfg_parent",
		);
		expect(ordered.map((item) => item.id)).toEqual(["cfg_parent", "cfg_root", "cfg_zzz"]);
	});
});

describe("delete confirmation", () => {
	it("names the replacement parent, both dependent counts, and the value warning", () => {
		const lines = deleteImpactLines("Shared sampling", "Account default", impact());
		expect(lines[0]).toBe(
			"Shared sampling will be removed. Its 2 immediate children will inherit from Account default.",
		);
		expect(lines[1]).toContain("5 configurations depend on this entry");
		expect(lines[1]).toContain("repairs links rather than copying values down");
		expect(lines).toHaveLength(2);
	});

	it("uses singular wording for a single child", () => {
		const lines = deleteImpactLines("Shared", "Account default", impact({ immediateDependentCount: 1, transitiveDependentCount: 1 }));
		expect(lines[0]).toContain("1 immediate child ");
		expect(lines[1]).toContain("1 configuration depend");
	});
});

describe("stale revision comparison", () => {
	it("lists only the fields whose draft differs from the reloaded copy", () => {
		const server = { fields: fieldMap() } as RedactedInferenceConfigurationDto;
		server.fields.model = {
			override: { kind: "value", value: "anthropic/claude-opus-4" },
			effective: "anthropic/claude-opus-4",
			provenance: { kind: "configured", source: { kind: "bickr_default" } },
			adjustment: null,
		};
		const drafts = draftMapFromFields(fieldMap());
		expect(conflictingFieldLabels(drafts, server)).toEqual(["Model"]);
		expect(conflictingFieldLabels(draftMapFromFields(server.fields), server)).toEqual([]);
	});

	it("names the unsaved rename beside the differing fields", () => {
		const server = customDto({ revision: 7 });
		server.fields.model = {
			override: { kind: "value", value: "anthropic/claude-opus-4" },
			effective: "anthropic/claude-opus-4",
			provenance: { kind: "configured", source: { kind: "bickr_default" } },
			adjustment: null,
		};
		const conflict = staleConflict(server, draftMapFromFields(fieldMap()), "Renamed here");
		expect(conflict.server.revision).toBe(7);
		expect(staleComparisonText(conflict)).toBe("Differs from the saved copy: Model, Name.");
	});

	it("says only the revision moved when nothing differs", () => {
		const server = customDto({ revision: 4 });
		const conflict = staleConflict(server, draftMapFromFields(server.fields), "Shared sampling");
		expect(conflict).toEqual({ fields: [], nameChanged: false, server });
		expect(staleComparisonText(conflict)).toBe("Your edited fields match the saved copy; only the revision moved.");
	});
});

/**
 * A window refocus reloads the server copy, but it is not allowed to resolve a
 * conflict for the owner: adopting a newer revision under dirty drafts would
 * make the next save overwrite the other copy silently, and the typed
 * stale-revision surface would never be reached.
 */
describe("refresh decision", () => {
	it("adopts the server copy whenever no draft is held", () => {
		expect(refreshDecision({ currentRevision: 3, nextRevision: 9, dirty: false })).toBe("adopt");
		expect(refreshDecision({ currentRevision: 3, nextRevision: 3, dirty: false })).toBe("adopt");
	});

	it("keeps drafts while the revision the save expects is unchanged", () => {
		expect(refreshDecision({ currentRevision: 3, nextRevision: 3, dirty: true })).toBe("keep_drafts");
	});

	it("surfaces a conflict when a newer revision arrives under dirty drafts", () => {
		expect(refreshDecision({ currentRevision: 3, nextRevision: 4, dirty: true })).toBe("conflict");
	});
});

describe("compaction reasoning adjustment", () => {
	it("leaves selected-decision presentation to the shared field presentation", () => {
		const fields = fieldMap();
		const resolution = {
			kind: "selected",
			decision: { kind: "safety_floor", floor: { kind: "explicit_effort", effort: "xhigh" } },
			selection: { kind: "explicit_effort", effort: "xhigh" },
			runtimeFallback: { kind: "none" },
			provenance: {
				configuration: { kind: "explicit_effort", effort: "high" },
				modelDefault: { kind: "absent" },
				safetyFloor: { kind: "explicit_effort", effort: "xhigh" },
				learnedFloor: null,
				baselineSelection: { kind: "model_default" },
				support: "known",
				policySource: "openrouter_generated",
			},
		} as const;
		fields.compactionReasoning = {
			override: { kind: "value", value: { kind: "explicit_effort", effort: "high" } },
			effective: resolution,
			provenance: { kind: "configured", source: { kind: "bickr_default" } },
			adjustment: {
				kind: "compaction_policy",
				resolution,
			},
		};
		const policy = fields.compactionReasoning.adjustment;
		if (!policy || policy.kind !== "compaction_policy") throw new Error("Expected compaction policy fixture.");
		expect(adjustmentText("compactionReasoning", policy)).toBeNull();
	});
});

describe("model completions", () => {
	const dto = {
		effectiveModel: "anthropic/claude-opus-4",
		imagePreviews: { participant: { model: "google/gemini-image" }, world: { model: "google/gemini-image" } },
	} as RedactedInferenceConfigurationDto;

	// Nonbinding completions from the owner's existing participants, exactly the
	// catalogue the previous participant editor offered.
	it("offers the owner's participant models and the current effective model", () => {
		const suggestions = fieldSuggestions(dto, [], ["z/model", "a/model", "z/model"]);
		expect(suggestions.model?.map((item) => item.value)).toEqual([
			"a/model",
			"anthropic/claude-opus-4",
			"z/model",
		]);
	});

	it("retains image previews as the source for image-field suggestions", () => {
		const suggestions = fieldSuggestions(dto, [{ id: "img/one", name: "Image One" }]);
		expect(suggestions.imageModel).toEqual([{ value: "img/one", label: "Image One (img/one)" }]);
		expect(suggestions.imageAspectRatio?.length).toBeGreaterThan(0);
		expect(suggestions.imageSize?.length).toBeGreaterThan(0);
	});
});

describe("children pagination", () => {
	it("requests immediate children with the current search and cursor", () => {
		expect(childrenPath("cfg_one")).toBe("/api/me/inference-configurations/cfg_one/children");
		expect(childrenPath("cfg_one", { query: "scout", cursor: "next" })).toBe(
			"/api/me/inference-configurations/cfg_one/children?q=scout&cursor=next",
		);
	});
});

describe("editor rendering", () => {
	it("shows a loading state before the redacted configuration arrives", () => {
		const html = renderToStaticMarkup(
			<InferenceConfigurationEditorScreen configurationId="cfg_one" onNavigate={() => undefined} />,
		);
		expect(html).toContain("Loading configuration");
		expect(html).toContain("Reading the current effective values.");
	});
});

// Field labels are the editor's only field vocabulary, so an unlabelled field
// would silently ship an empty accessible name.
describe("field labels", () => {
	it("labels every editable field", () => {
		for (const field of inferenceEditorFields as readonly InferenceConfigurationField[]) {
			expect(typeof field).toBe("string");
		}
		expect(new Set(inferenceEditorFields).size).toBe(inferenceEditorFields.length);
	});
});
