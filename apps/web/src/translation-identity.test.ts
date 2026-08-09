import { describe, expect, it } from "vitest";
import { localizedText, type LanguageTag, type UserProfile } from "@bickr/shared/model";
import { translationContextValue } from "./app-records";

const en = "en" as LanguageTag;
const now = "2026-08-05T00:00:00.000Z";

function profile(overrides: Partial<UserProfile> = {}): UserProfile {
	return {
		id: "usr_one",
		handle: "owner",
		displayName: localizedText("Owner", en),
		language: en,
		uiLocale: "system",
		profileComplete: true,
		inferenceSettings: { translation: { enabled: true, prompt: localizedText("Translate this.", en) } },
		translationInference: {
			enabled: true,
			configurationId: "cfg_translation",
			displayName: "Translation",
			pointerRevision: 3,
			effectiveModel: "anthropic/claude-opus-4",
			effectiveRevisionFingerprint: "fingerprint-a",
			credentialAvailable: true,
		},
		authIdentities: [],
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

describe("translation cache identity", () => {
	it("takes the model from the resolved annotation, not the account document", () => {
		const context = translationContextValue(profile());
		expect(context).toMatchObject({
			enabled: true,
			identity: "cfg_translation:fingerprint-a",
			model: "anthropic/claude-opus-4",
			prompt: "Translate this.",
		});
	});

	// The whole point of the fingerprint: an inherited routing, reasoning, or
	// sampling change moves the effective result while model and prompt stay
	// equal, and a cached translation must not survive it.
	it("changes when only the effective fingerprint moves", () => {
		const before = translationContextValue(profile());
		const annotation = profile().translationInference;
		if (!annotation?.enabled) throw new Error("enabled annotation fixture required");
		const after = translationContextValue(profile({
			translationInference: { ...annotation, effectiveRevisionFingerprint: "fingerprint-b" },
		}));
		expect(after.model).toBe(before.model);
		expect(after.prompt).toBe(before.prompt);
		expect(after.identity).not.toBe(before.identity);
	});

	it("changes when the fixed role is recreated", () => {
		const before = translationContextValue(profile());
		const annotation = profile().translationInference;
		if (!annotation?.enabled) throw new Error("enabled annotation fixture required");
		const after = translationContextValue(profile({
			translationInference: { ...annotation, configurationId: "cfg_translation_new" },
		}));
		expect(after.identity).not.toBe(before.identity);
	});

	it("uses canonical enablement while keeping the account-owned prompt", () => {
		expect(translationContextValue(profile({ inferenceSettings: { translation: { enabled: false } } })).enabled).toBe(true);
		expect(translationContextValue(profile({ translationInference: { enabled: false } })).enabled).toBe(false);
		expect(translationContextValue(profile({ inferenceSettings: {} })).prompt).toContain("Translate");
	});

	it("falls back without an annotation instead of inventing an identity", () => {
		const { translationInference: _unused, ...withoutAnnotation } = profile();
		const context = translationContextValue(withoutAnnotation as UserProfile);
		expect(context.identity).toBe(context.model);
		expect(translationContextValue(null).enabled).toBe(false);
	});
});
