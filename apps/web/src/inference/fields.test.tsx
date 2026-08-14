import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { InferenceConfigurationField } from "@bickr/shared/inference-configuration";
import type {
	InferenceConfigurationPathEntry,
	RedactedInferenceFieldDto,
} from "@bickr/shared/inference-configuration-owner";
import type { AppliedPrefillPolicy } from "@bickr/shared/openrouter-model-capabilities";
import { CredentialField, InferenceField } from "./fields";
import { nextBooleanDraft, type InferenceFieldDraft } from "./field-model";

/**
 * These assertions cover the rendered accessibility contract and the rendered
 * boolean cycle. The native checkbox turns both click and Space into the same
 * change event, so one transition per step is the whole interaction; what the
 * rendered test adds over the pure transition in `field-model.test.ts` is the
 * rerender between steps, because the control re-derives its state from the
 * draft it is handed on every render.
 */

const path: InferenceConfigurationPathEntry[] = [
	{ id: "cfg_self", displayName: "Shared sampling", revision: 2, kind: "custom", identity: { kind: "custom", name: "Shared sampling" } },
	{ id: "cfg_root", displayName: "Account default", revision: 5, kind: "account_default", identity: { kind: "account_default" } },
];

type DtoOverrides = Partial<Omit<RedactedInferenceFieldDto<InferenceConfigurationField>, "inherited">> & {
	inherited?: Partial<RedactedInferenceFieldDto<InferenceConfigurationField>["inherited"]>;
};

function dto(overrides: DtoOverrides = {}): RedactedInferenceFieldDto<InferenceConfigurationField> {
	const { inherited, ...current } = overrides;
	const request = current.request ?? { value: current.effective ?? null } as RedactedInferenceFieldDto<InferenceConfigurationField>["request"];
	return {
		override: { kind: "inherit" },
		request,
		effective: null,
		provenance: { configured: { accountDefault: { configurationId: "cfg_root", depth: 1 } } },
		adjustment: null,
		inherited: {
			request: inherited?.request ?? request,
			effective: inherited?.effective ?? current.effective ?? null,
			provenance: inherited?.provenance ?? current.provenance ?? { configured: { accountDefault: { configurationId: "cfg_root", depth: 1 } } },
			adjustment: inherited?.adjustment ?? current.adjustment ?? null,
		},
		...current,
	};
}

function prefillDto(request: boolean, applied = request): RedactedInferenceFieldDto<InferenceConfigurationField> {
	const policy: AppliedPrefillPolicy = request ? {
		request: true,
		reasoningShape: "reasoning_on",
		applied,
		adjustment: !applied ? "prefill_unsupported" : null,
		capability: {
			kind: "fixed_policy" as const,
			status: applied ? "supported" as const : "unsupported" as const,
			source: "custom_provider_policy" as const,
		},
	} : {
		request: false,
		reasoningShape: "reasoning_on",
		applied: false,
		adjustment: null,
		capability: null,
	};
	return dto({
		request: { value: request },
		effective: applied,
		adjustment: { kind: "prefill_policy", policy },
		inherited: {
			request: { value: request },
			effective: applied,
			adjustment: { kind: "prefill_policy", policy },
		},
	});
}

function render(
	field: InferenceConfigurationField,
	draft: InferenceFieldDraft,
	fieldDto = dto(),
	isAccountDefault = false,
): string {
	return renderToStaticMarkup(
		<InferenceField
			draft={draft}
			dto={fieldDto}
			field={field}
			isAccountDefault={isAccountDefault}
			onChange={() => undefined}
			path={path}
		/>,
	);
}

/** The single native checkbox a boolean field renders. */
function checkboxMarkup(html: string): string {
	const input = /<input[^>]*type="checkbox"[^>]*>/.exec(html)?.[0];
	if (!input) throw new Error("The boolean field rendered no checkbox.");
	return input;
}

describe("boolean inheritance control", () => {
	it("uses one native checkbox with no redundant aria-checked and a visible inherit reset", () => {
		const html = render("supportsPrefill", { mode: "inherit" }, prefillDto(true));
		expect(html).toContain('type="checkbox"');
		expect(html).not.toContain("aria-checked");
		expect(html).toContain(">Inherit<");
		expect(html).toContain('aria-live="polite"');
	});

	it("describes the resolved request and its source", () => {
		const html = render("supportsPrefill", { mode: "inherit" }, prefillDto(true));
		expect(html).toContain("Configured on from Account default. Applied on.");
		expect(html).toMatch(/aria-describedby="([^"]+)"/);
		const describedBy = /aria-describedby="([^"]+)"/.exec(html)?.[1];
		expect(html).toContain(`id="${describedBy}"`);
	});

	it("enables the inherit reset only once a value is explicit", () => {
		expect(render("supportsPrefill", { mode: "inherit" }, prefillDto(false))).toContain(
			'class="btn ghost compact inference-inherit-reset" disabled=""',
		);
		expect(render("supportsPrefill", { mode: "explicit", state: "value", text: "false" }, prefillDto(false))).not.toContain(
			'class="btn ghost compact inference-inherit-reset" disabled=""',
		);
	});

	/**
	 * The rendered cycle, one rerender per click. `nextBooleanDraft` is exactly
	 * what the rendered `onChange` hands to `props.onChange`, and each step is
	 * re-rendered from the draft the editor would store, so a control that
	 * rebuilt an ephemeral cycle marker per render would never reach step three.
	 */
	it("cycles the rendered checkbox from inherit through both explicit values and back", () => {
		const inherited = prefillDto(true);
		const steps: { checkbox: string; inheritDisabled: boolean }[] = [];
		let draft: InferenceFieldDraft = { mode: "inherit" };
		for (let click = 0; click < 4; click += 1) {
			const html = render("supportsPrefill", draft, inherited);
			steps.push({
				checkbox: checkboxMarkup(html),
				inheritDisabled: html.includes('class="btn ghost compact inference-inherit-reset" disabled=""'),
			});
			draft = nextBooleanDraft(draft, inherited.effective === true);
		}
		// Inherit renders unchecked with the reset disabled; the DOM mixed state
		// is the `indeterminate` property, which has no markup form.
		expect(steps[0]?.inheritDisabled).toBe(true);
		expect(steps[0]?.checkbox).not.toContain("checked");
		// Click one: an explicit copy of the inherited value.
		expect(steps[1]?.checkbox).toContain('checked=""');
		expect(steps[1]?.inheritDisabled).toBe(false);
		// Click two: the explicit opposite, still explicit.
		expect(steps[2]?.checkbox).not.toContain("checked");
		expect(steps[2]?.inheritDisabled).toBe(false);
		// Click three: back to inherit.
		expect(steps[3]?.inheritDisabled).toBe(true);
		expect(draft).toEqual({ mode: "explicit", state: "value", text: "true" });
	});

	it("cycles a false inherited value through its own explicit copy first", () => {
		const inherited = prefillDto(false);
		const first = nextBooleanDraft({ mode: "inherit" }, false);
		expect(first).toEqual({ mode: "explicit", state: "value", text: "false" });
		expect(checkboxMarkup(render("supportsPrefill", first, inherited))).not.toContain("checked");
		const second = nextBooleanDraft(first, false);
		expect(checkboxMarkup(render("supportsPrefill", second, inherited))).toContain('checked=""');
		expect(nextBooleanDraft(second, false)).toEqual({ mode: "inherit" });
	});

	it("announces an explicit On request clamped Off by capability evidence", () => {
		const html = render("supportsPrefill", { mode: "explicit", state: "value", text: "true" }, prefillDto(true, false));
		expect(html).toContain(
			"Configured on from Account default. Applied off because this provider route does not support prefill with tools.",
		);
	});
});

describe("enum inheritance control", () => {
	it("offers a separated inherit option naming the effective value and source", () => {
		const html = render("toolCalls", { mode: "inherit" }, dto({
			request: { value: { kind: "strategy", strategy: "railroad" } },
			effective: "railroad",
		}));
		expect(html).toContain("Inherit — Railroad from Account default");
		expect(html).toContain('<option disabled="" value="__separator">');
		expect(html).toContain(">Bickr automatic<");
		expect(html).toContain(">Provider default<");
	});

	it("selects the explicit option when one is stored", () => {
		const html = render("toolCalls", { mode: "explicit", state: "value", text: "require" }, dto({ effective: "require" }));
		expect(html).toContain('<option value="require" selected="">Require</option>');
	});

	it("keeps current applied status separate from the inherit option", () => {
		const html = render("toolCalls", { mode: "explicit", state: "value", text: "require" }, dto({
			request: { value: { kind: "strategy", strategy: "require" } },
			effective: "require",
			provenance: { configured: { configuration: {
				configurationId: "cfg_self", configurationKind: "custom", depth: 0,
			} } },
			inherited: {
				request: { value: { kind: "strategy", strategy: "railroad" } },
				effective: "railroad",
				provenance: { configured: { accountDefault: { configurationId: "cfg_root", depth: 1 } } },
				adjustment: null,
			},
		}));
		expect(html).toContain("Configured Require from Shared sampling (set here)");
		expect(html).toContain("Inherit — Railroad from Account default");
	});

	it("never relabels Provider default as the applied structured strategy", () => {
		const html = render("toolCalls", { mode: "explicit", state: "value", text: "provider_default" }, dto({
			request: { value: { kind: "provider_default" } },
			effective: "railroad",
			provenance: { configured: { configuration: {
				configurationId: "cfg_self", configurationKind: "custom", depth: 0,
			} } },
			inherited: {
				request: { value: { kind: "provider_default" } },
				effective: "require",
				provenance: { configured: { accountDefault: { configurationId: "cfg_root", depth: 1 } } },
				adjustment: null,
			},
		}));
		expect(html).toContain("Configured Provider default from Shared sampling (set here)");
		expect(html).toContain("Inherit — Provider default from Account default");
		expect(html).not.toContain("Configured Railroad");
		expect(html).not.toContain("Inherit — Require");
	});
});

describe("text and number inheritance controls", () => {
	it("names the mode checkbox for the field without nesting it in another label", () => {
		const html = render("temperature", { mode: "inherit" }, dto({ effective: 0.7 }));
		expect(html).toContain('aria-label="Override Temperature"');
		expect(html).not.toMatch(/<label[^>]*>[^<]*<input/);
	});

	it("disables the input and shows the inherited effective value while inheriting", () => {
		const html = render("temperature", { mode: "inherit" }, dto({ effective: 0 }));
		expect(html).toContain("disabled=\"\"");
		expect(html).toContain('placeholder="0"');
		expect(html).toContain("Configured 0 from Account default");
	});

	it("uses the inherited value for reset placeholders even when the current applied value differs", () => {
		const html = render("temperature", { mode: "inherit" }, dto({
			effective: 0.9,
			inherited: {
				effective: 0.3,
				provenance: { configured: { accountDefault: { configurationId: "cfg_root", depth: 1 } } },
				adjustment: null,
			},
		}));
		expect(html).toContain('placeholder="0.3"');
		expect(html).toContain("Configured 0.9 from Account default");
	});

	it("enables the input for an explicit value and keeps zero visible", () => {
		const html = render("temperature", { mode: "explicit", state: "value", text: "0" }, dto({ effective: 0 }));
		expect(html).toContain('value="0"');
		expect(html).not.toContain('type="number" disabled=""');
	});

	it("offers typed explicit absence and image target default instead of an unchecked state", () => {
		const html = render("imageSize", { mode: "explicit", state: "target_default" }, dto());
		expect(html).toContain('aria-label="Image size explicit state"');
		expect(html).toContain(">Explicitly no value<");
		expect(html).toContain(">Use the avatar target default<");
		expect(html).toContain('<option value="target_default" selected="">');
	});

	it("offers Use Account default for base URL only away from the root", () => {
		const child = render("baseUrl", { mode: "explicit", state: "account_default" }, dto({ effective: "https://openrouter.ai/api/v1" }));
		expect(child).toContain(">Use Account default<");
		expect(child).toContain('<option value="account_default" selected="">');

		const root = render("baseUrl", { mode: "explicit", state: "value", text: "https://local.example/v1" }, dto(), true);
		expect(root).not.toContain(">Use Account default<");
	});

	it("renders nonbinding completions without constraining the stored value", () => {
		const html = renderToStaticMarkup(
			<InferenceField
				draft={{ mode: "explicit", state: "value", text: "custom/model" }}
				dto={dto({ effective: "custom/model" })}
				field="model"
				isAccountDefault={false}
				onChange={() => undefined}
				path={path}
				suggestions={[{ value: "anthropic/claude-opus-4" }, { value: "openrouter/free" }]}
			/>,
		);
		expect(html).toMatch(/<input[^>]*list="([^"]+)"/);
		expect(html).toContain('<option value="anthropic/claude-opus-4"');
		// The typed value is still whatever the owner entered.
		expect(html).toContain('value="custom/model"');
	});

	it("shows a capability adjustment beside the field", () => {
		const html = render(
			"toolCalls",
			{ mode: "explicit", state: "value", text: "require" },
			dto({
				effective: "railroad",
				adjustment: { kind: "capability_adjustment", requested: "require", effective: "railroad" },
			}),
		);
		expect(html).toContain("Requested Require; this model or provider uses Railroad.");
	});

	it("shows a raised compaction request beside its effective value and source", () => {
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
		const html = render(
			"compactionReasoning",
			{ mode: "explicit", state: "value", text: "high" },
			dto({
				request: { value: { kind: "explicit_effort", effort: "high" } },
				effective: resolution,
				provenance: { configured: { accountDefault: { configurationId: "cfg_root", depth: 1 } } },
				adjustment: { kind: "compaction_policy", resolution },
			}),
		);
		expect(html).toContain("Configured high from Account default. Applied xhigh from the safety floor.");
		expect(html).toContain("Inherit — Configured high from Account default. Applied xhigh from the safety floor.");
		expect(html).not.toContain("Requested high; compaction policy applies");
	});

	it("renders unset configuration and model-default policy attribution in both compaction locations", () => {
		const resolution = {
			kind: "selected",
			decision: {
				kind: "model_default",
				modelDefault: { kind: "explicit_effort", effort: "high" },
			},
			selection: { kind: "model_default", effort: "high" },
			runtimeFallback: { kind: "none" },
			provenance: {
				configuration: null,
				modelDefault: { kind: "explicit_effort", effort: "high" },
				safetyFloor: { kind: "explicit_effort", effort: "low" },
				learnedFloor: null,
				baselineSelection: { kind: "model_default", effort: "high" },
				support: "known",
				policySource: "openrouter_semantic_override",
			},
		} as const;
		const html = render(
			"compactionReasoning",
			{ mode: "inherit" },
			dto({
				request: { unset: null },
				effective: resolution,
				provenance: { unset: null },
				adjustment: { kind: "compaction_policy", resolution },
			}),
		);
		const presentation = "Configuration unset; no configuration or Bickr default sets this field. Applied high from the model default.";
		expect(html).toContain(presentation);
		expect(html).toContain(`Inherit — ${presentation}`);
		expect(html).toContain('aria-live="polite"');
		expect(html).not.toContain("from Bickr defaults");
	});
});

describe("credential control", () => {
	it("renders status and typed actions with no credential material", () => {
		const html = renderToStaticMarkup(
			<CredentialField
				busy={false}
				isAccountDefault={false}
				mode="inherit"
				onAction={() => undefined}
				path={path}
				resolution={{ kind: "available", source: { kind: "account_default", configurationId: "cfg_root", depth: 1 }, secretVersion: 4 }}
			/>,
		);
		expect(html).toContain("A saved key from Account default is in effect.");
		expect(html).toContain(">Replace<");
		expect(html).toContain(">Inherit<");
		expect(html).toContain(">Use Account default<");
		expect(html).toContain(">Use no key<");
		// Nothing about the value itself: no masked text, length, or version.
		expect(html).not.toContain("sk-");
		expect(html).not.toContain("secretVersion");
		expect(html).not.toContain("4");
	});

	it("hides Use Account default on Account default itself", () => {
		const html = renderToStaticMarkup(
			<CredentialField
				busy={false}
				isAccountDefault
				mode="value"
				onAction={() => undefined}
				path={path}
				resolution={{ kind: "unavailable", source: { kind: "bickr_default" }, reason: "no_credential" }}
			/>,
		);
		expect(html).not.toContain(">Use Account default<");
		expect(html).toContain("No key is available");
	});

	it("explains a suppressed deployment credential", () => {
		const html = renderToStaticMarkup(
			<CredentialField
				busy={false}
				isAccountDefault={false}
				mode="inherit"
				onAction={() => undefined}
				path={path}
				resolution={{
					kind: "unavailable",
					source: { kind: "bickr_default" },
					reason: "deployment_credential_suppressed_for_owner_base_url",
				}}
			/>,
		);
		expect(html).toContain("deployment key is not sent to an owner-selected base URL.");
	});
});
