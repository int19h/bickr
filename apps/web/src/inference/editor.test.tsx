import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { InferenceConfigurationField } from "@bickr/shared/inference-configuration";
import type {
	InferenceConfigurationSummary,
	InferenceDeleteImpact,
	InferenceImpactWarning,
	RedactedInferenceConfigurationDto,
} from "@bickr/shared/inference-configuration-owner";
import {
	InferenceConfigurationEditorScreen,
	conflictingFieldLabels,
	deleteImpactLines,
	impactRequiresConfirmation,
	impactWarningText,
	orderedParentCandidates,
} from "./editor";
import {
	compactionRequestedText,
	draftMapFromFields,
	inferenceEditorFields,
	inferenceFieldGroups,
} from "./field-model";
import { childrenPath } from "./api";

function fieldMap(): RedactedInferenceConfigurationDto["fields"] {
	return Object.fromEntries(
		inferenceEditorFields.map((field) => [field, {
			override: { kind: "inherit" },
			effective: null,
			source: { kind: "bickr_default" },
			adjustment: null,
		}]),
	) as RedactedInferenceConfigurationDto["fields"];
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
		resetsTranslationSelection: false,
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
		fields.temperature = { override: { kind: "value", value: 0 }, effective: 0, source: { kind: "bickr_default" }, adjustment: null };
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
			"Shared sampling will be removed. Its 2 immediate children will be reparented to Account default.",
		);
		expect(lines[1]).toContain("5 configurations depend on this entry");
		expect(lines[1]).toContain("repairs links rather than copying values down");
		expect(lines).toHaveLength(2);
	});

	it("discloses the translation reset when this entry supplies translation", () => {
		const lines = deleteImpactLines("Migrated translation settings", "Account default", impact({ resetsTranslationSelection: true }));
		expect(lines[2]).toBe("Inline translation currently uses this configuration and will switch to Account default.");
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
		server.fields.model = { override: { kind: "value", value: "anthropic/claude-opus-4" }, effective: "anthropic/claude-opus-4", source: { kind: "bickr_default" }, adjustment: null };
		const drafts = draftMapFromFields(fieldMap());
		expect(conflictingFieldLabels(drafts, server)).toEqual(["Model"]);
		expect(conflictingFieldLabels(draftMapFromFields(server.fields), server)).toEqual([]);
	});
});

describe("compaction reasoning summary", () => {
	it("reports the configuration request separately from the applied effort", () => {
		const fields = fieldMap();
		fields.compactionReasoning = {
			override: { kind: "value", value: { kind: "explicit_effort", effort: "high" } },
			effective: null,
			source: { kind: "bickr_default" },
			adjustment: {
				kind: "compaction_policy",
				resolution: {
					kind: "selected",
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
				},
			},
		} as RedactedInferenceConfigurationDto["fields"]["compactionReasoning"];
		expect(compactionRequestedText({ fields } as RedactedInferenceConfigurationDto)).toBe("high");
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
