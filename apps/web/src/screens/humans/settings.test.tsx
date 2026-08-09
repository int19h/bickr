import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { localizedText, type LanguageTag, type PublicUser, type UserProfile } from "@bickr/shared/model";
import {
	ProfileScreen,
	profileDraftFromProfile,
	savedTranslationConfigurationReference,
} from "./settings";

const en = "en" as LanguageTag;

// The sign-in link builder reads the current location to compose its return
// target. Server rendering has no document, so the test supplies one.
beforeAll(() => {
	(globalThis as { window?: unknown }).window ??= { location: { pathname: "/me/profile", search: "", hash: "" } };
});

function user(): PublicUser {
	return {
		id: "usr_one",
		handle: "owner",
		language: en,
		uiLocale: "system",
		displayName: localizedText("Owner", en),
		profileComplete: true,
	};
}

function render(): string {
	return renderToStaticMarkup(
		<ProfileScreen
			busy={false}
			onAuthIdentityUnlink={async () => null}
			onAvatarUpdated={() => undefined}
			onOpenAvatarGeneration={() => undefined}
			onSave={async () => null}
			onSignOut={() => undefined}
			user={user()}
		/>,
	);
}

describe("ProfileScreen inference boundary", () => {
	it("keeps profile data and the translation toggle and prompt", () => {
		const markup = render();
		expect(markup).toContain("Inline translations");
		expect(markup).toContain("Translation prompt");
		expect(markup).toContain("Account language");
	});

	it("replaces reusable inference summaries with the Account default action", () => {
		const markup = render();
		expect(markup).toContain("Account default configuration");
		expect(markup).toContain("Account default supplies provider, model, loop, compaction, and image inference");
		expect(markup).toContain("Open Account default configuration");
		expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Open Account default configuration<\/button>/);
		expect(markup).not.toContain("inference-link-card");
		expect(markup).toMatch(/<div class="kvrow"><div><div class="k">Inference<\/div><\/div><div class="v">\.\.\.<\/div><\/div>/);
		expect(markup).not.toContain("Inference Provider");
		expect(markup).not.toContain("Inference: Agentic Loop");
		expect(markup).not.toContain("Inference: Image Generation");
		expect(markup).not.toContain("OpenRouter API key");
	});

	it("keeps Translation role editing behind a saved canonical enablement", () => {
		const markup = render();
		expect(markup).toContain("Save with inline translations enabled to create and edit the Translation configuration.");
		expect(markup).not.toContain("Open Translation configuration");
		// Translation-only model, reasoning, tool-call, and sampling editors are gone.
		expect(markup).not.toContain("Inference: Translation");
		expect(markup).not.toContain("Repetition penalty");
		expect(markup).not.toContain("Top K");
	});
});

describe("canonical Translation profile identity", () => {
	function profile(enabled: boolean): UserProfile {
		return {
			...user(),
			inferenceSettings: { translation: { enabled: !enabled } },
			translationInference: enabled ? {
				enabled: true,
				configurationId: "cfg_translation",
				displayName: "Translation",
				pointerRevision: 2,
				effectiveModel: "example/model",
				effectiveRevisionFingerprint: "fingerprint",
				credentialAvailable: false,
			} : { enabled: false },
			authIdentities: [],
			createdAt: "2026-08-05T00:00:00.000Z",
			updatedAt: "2026-08-05T00:00:00.000Z",
		};
	}

	it("uses the canonical annotation instead of a stale KV mirror", () => {
		expect(profileDraftFromProfile(profile(true)).translationEnabled).toBe(true);
		expect(profileDraftFromProfile(profile(false)).translationEnabled).toBe(false);
		expect(savedTranslationConfigurationReference(profile(true))).toEqual({ kind: "translation" });
		expect(savedTranslationConfigurationReference(profile(false))).toBeNull();
	});
});
