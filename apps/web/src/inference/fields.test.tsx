import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { InferenceConfigurationField } from "@bickr/shared/inference-configuration";
import type {
	InferenceConfigurationPathEntry,
	RedactedInferenceFieldDto,
} from "@bickr/shared/inference-configuration-owner";
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

function dto(overrides: Partial<RedactedInferenceFieldDto<InferenceConfigurationField>> = {}): RedactedInferenceFieldDto<InferenceConfigurationField> {
	return {
		override: { kind: "inherit" },
		effective: null,
		source: { kind: "account_default", configurationId: "cfg_root", depth: 1 },
		adjustment: null,
		...overrides,
	};
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
		const html = render("supportsPrefill", { mode: "inherit" }, dto({ effective: true }));
		expect(html).toContain('type="checkbox"');
		expect(html).not.toContain("aria-checked");
		expect(html).toContain(">Inherit<");
		expect(html).toContain('aria-live="polite"');
	});

	it("describes the effective value and its source", () => {
		const html = render("supportsPrefill", { mode: "inherit" }, dto({ effective: true }));
		expect(html).toContain("Effective on from Account default");
		expect(html).toMatch(/aria-describedby="([^"]+)"/);
		const describedBy = /aria-describedby="([^"]+)"/.exec(html)?.[1];
		expect(html).toContain(`id="${describedBy}"`);
	});

	it("enables the inherit reset only once a value is explicit", () => {
		expect(render("supportsPrefill", { mode: "inherit" }, dto({ effective: false }))).toContain(
			'class="btn ghost compact inference-inherit-reset" disabled=""',
		);
		expect(render("supportsPrefill", { mode: "explicit", state: "value", text: "false" }, dto({ effective: false }))).not.toContain(
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
		const inherited = dto({ effective: true });
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
		const inherited = dto({ effective: false });
		const first = nextBooleanDraft({ mode: "inherit" }, false);
		expect(first).toEqual({ mode: "explicit", state: "value", text: "false" });
		expect(checkboxMarkup(render("supportsPrefill", first, inherited))).not.toContain("checked");
		const second = nextBooleanDraft(first, false);
		expect(checkboxMarkup(render("supportsPrefill", second, inherited))).toContain('checked=""');
		expect(nextBooleanDraft(second, false)).toEqual({ mode: "inherit" });
	});
});

describe("enum inheritance control", () => {
	it("offers a separated inherit option naming the effective value and source", () => {
		const html = render("toolCalls", { mode: "inherit" }, dto({ effective: "railroad" }));
		expect(html).toContain("Inherit — Railroad from Account default");
		expect(html).toContain('<option disabled="" value="__separator">');
		expect(html).toContain(">Provider default<");
	});

	it("selects the explicit option when one is stored", () => {
		const html = render("toolCalls", { mode: "explicit", state: "value", text: "require" }, dto({ effective: "require" }));
		expect(html).toContain('<option value="require" selected="">Require</option>');
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
		expect(html).toContain("Effective 0 from Account default");
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
