import { describe, expect, it } from "vitest";
import type {
	InferenceConfigurationField,
	InferenceOverrideUpdate,
} from "@bickr/shared/inference-configuration";
import type {
	RedactedInferenceFieldDto,
	RedactedInferenceFieldDtoMap,
} from "@bickr/shared/inference-configuration-owner";

import { inferenceEditorFields } from "../inference/field-model";
import {
	avatarClearedDraft,
	avatarEffectiveDraftModel,
	avatarFieldPlaceholder,
	avatarImageSettingsFields,
	avatarPromptFillSettingsFields,
	avatarResetDrafts,
	avatarSettingsChanged,
	avatarSettingsError,
	avatarSettingsOverridden,
	avatarSettingsPatch,
	imageSettingsRequestBundle,
	promptFillSettingsRequestBundle,
	type AvatarSettingsDrafts,
} from "./generation-settings";

function fields(
	overrides: Partial<Record<InferenceConfigurationField, InferenceOverrideUpdate<InferenceConfigurationField>>> = {},
	effective: Partial<Record<InferenceConfigurationField, unknown>> = {},
	inherited: Partial<Record<InferenceConfigurationField, unknown>> = {},
): RedactedInferenceFieldDtoMap {
	const result = {} as RedactedInferenceFieldDtoMap;
	for (const field of inferenceEditorFields) {
		setField(result, field, {
			override: overrides[field] ?? { kind: "inherit" },
			effective: (effective[field] ?? null) as never,
			provenance: { unset: null },
			adjustment: null,
			...(field in inherited ? {
				inherited: {
					request: { kind: "value", value: inherited[field] } as never,
					effective: inherited[field] as never,
					provenance: { unset: null },
					adjustment: null,
				},
			} : {}),
		});
	}
	return result;
}

function setField<K extends InferenceConfigurationField>(
	fields: RedactedInferenceFieldDtoMap,
	field: K,
	dto: Omit<RedactedInferenceFieldDto<K>, "inherited" | "request"> &
		Partial<Pick<RedactedInferenceFieldDto<K>, "inherited" | "request">>,
): void {
	const request = dto.request ?? { kind: "value", value: dto.effective } as unknown as RedactedInferenceFieldDto<K>["request"];
	Object.assign(fields, { [field]: {
		...dto,
		request,
		inherited: dto.inherited ?? { request, effective: dto.effective, provenance: dto.provenance, adjustment: dto.adjustment },
	} });
}

const valueDraft = (text: string) => ({ mode: "explicit", state: "value", text }) as const;

describe("avatar generation settings drafts", () => {
	it("clears a value override to inherit but keeps other explicit states", () => {
		const map = fields({
			imageModel: { kind: "value", value: "owner/image" },
			imageAspectRatio: { kind: "explicit_none" },
		});
		expect(avatarClearedDraft(map, "imageModel")).toEqual({ mode: "inherit" });
		expect(avatarClearedDraft(map, "imageAspectRatio")).toEqual({ mode: "explicit", state: "explicit_none" });
		expect(avatarClearedDraft(map, "imageSize")).toEqual({ mode: "inherit" });
	});

	it("shows the inherited value only once a value override is cleared", () => {
		const map = fields(
			{ imageAspectRatio: { kind: "value", value: "16:9" } },
			{ imageAspectRatio: "16:9" },
			{ imageAspectRatio: "1:1" },
		);
		expect(avatarFieldPlaceholder({}, map, "imageAspectRatio")).toBe("16:9");
		expect(avatarFieldPlaceholder({ imageAspectRatio: { mode: "inherit" } }, map, "imageAspectRatio")).toBe("1:1");
	});

	it("patches only the fields whose drafts differ from the stored overrides", () => {
		const map = fields({ imageModel: { kind: "value", value: "owner/image" } });
		const drafts: AvatarSettingsDrafts = {
			imageModel: valueDraft("owner/image"),
			imageAspectRatio: valueDraft("21:9"),
			imageTemperature: valueDraft("0.4"),
		};
		expect(avatarSettingsChanged(avatarImageSettingsFields, drafts, map)).toBe(true);
		const parsed = avatarSettingsPatch(avatarImageSettingsFields, drafts, map);
		expect(parsed).toEqual({
			ok: true,
			patch: {
				imageAspectRatio: { kind: "value", value: "21:9" },
				imageTemperature: { kind: "value", value: 0.4 },
			},
		});
	});

	it("reports value parse failures for save and generation gating", () => {
		const map = fields();
		const drafts: AvatarSettingsDrafts = { imageProviderRouting: valueDraft("{ not json") };
		const parsed = avatarSettingsPatch(avatarImageSettingsFields, drafts, map);
		expect(parsed.ok).toBe(false);
		expect(avatarSettingsError(avatarImageSettingsFields, drafts, map)).toContain("Image provider routing");
	});

	it("resets every overridden editable field back to inherit", () => {
		const map = fields({
			imageModel: { kind: "value", value: "owner/image" },
			imageSize: { kind: "target_default" },
		});
		expect(avatarSettingsOverridden(avatarImageSettingsFields, map)).toBe(true);
		const parsed = avatarSettingsPatch(avatarImageSettingsFields, avatarResetDrafts(avatarImageSettingsFields), map);
		expect(parsed).toEqual({
			ok: true,
			patch: {
				imageModel: { kind: "inherit" },
				imageSize: { kind: "inherit" },
			},
		});
		expect(avatarSettingsOverridden(avatarImageSettingsFields, fields())).toBe(false);
	});

	it("prefers the typed model, then the inherited value after a clear, then the resolved preview", () => {
		const map = fields(
			{ imageModel: { kind: "value", value: "owner/image" } },
			{ imageModel: "owner/image" },
			{ imageModel: "owner/inherited-image" },
		);
		// An untouched value override renders filled, so it is the draft model.
		expect(avatarEffectiveDraftModel({}, map, "imageModel", "preview/image")).toBe("owner/image");
		expect(avatarEffectiveDraftModel({}, fields(), "imageModel", "preview/image")).toBe("preview/image");
		expect(avatarEffectiveDraftModel(
			{ imageModel: valueDraft("owner/typed") }, map, "imageModel", "preview/image",
		)).toBe("owner/typed");
		expect(avatarEffectiveDraftModel(
			{ imageModel: { mode: "inherit" } }, map, "imageModel", "preview/image",
		)).toBe("owner/inherited-image");
	});
});

describe("avatar one-shot request bundles", () => {
	it("omits the bundle while the drafts match the stored overrides", () => {
		const map = fields({ imageModel: { kind: "value", value: "owner/image" } });
		expect(imageSettingsRequestBundle({}, map)).toBeUndefined();
		expect(imageSettingsRequestBundle({ imageModel: valueDraft("owner/image") }, map)).toBeUndefined();
		expect(promptFillSettingsRequestBundle({}, map)).toBeUndefined();
	});

	it("carries every explicitly valued image field once any draft is dirty", () => {
		const map = fields({ imageModel: { kind: "value", value: "owner/image" } });
		expect(imageSettingsRequestBundle({
			imageAspectRatio: valueDraft("16:9"),
			imageTemperature: valueDraft("0.4"),
			imageProviderRouting: valueDraft('{"order":["p"]}'),
		}, map)).toEqual({
			model: "owner/image",
			aspectRatio: "16:9",
			temperature: 0.4,
			providerRouting: { order: ["p"] },
		});
	});

	it("maps prompt fill reasoning options onto the legacy request encoding", () => {
		const map = fields();
		expect(promptFillSettingsRequestBundle({
			model: valueDraft("owner/prompt"),
			reasoning: valueDraft("low"),
		}, map)).toEqual({ model: "owner/prompt", reasoningEffort: "low" });
		expect(promptFillSettingsRequestBundle({
			reasoning: valueDraft("provider_default"),
		}, map)).toEqual({ reasoningEffort: "default" });
		// bickr_automatic has no legacy encoding; the dirty draft still sends a
		// bundle so the other fields apply, and reasoning stays canonical.
		expect(promptFillSettingsRequestBundle({
			reasoning: valueDraft("bickr_automatic"),
			temperature: valueDraft("0.3"),
		}, map)).toEqual({ temperature: 0.3 });
	});

	it("keeps prompt fill and image fields in separate bundles", () => {
		const map = fields();
		const drafts: AvatarSettingsDrafts = {
			imageAspectRatio: valueDraft("16:9"),
			temperature: valueDraft("0.3"),
		};
		expect(imageSettingsRequestBundle(drafts, map)).toEqual({ aspectRatio: "16:9" });
		expect(promptFillSettingsRequestBundle(drafts, map)).toEqual({ temperature: 0.3 });
		expect(avatarPromptFillSettingsFields).not.toContain("imageAspectRatio");
	});
});
