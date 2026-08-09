import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { localizedText, type LanguageTag, type PublicUser } from "@bickr/shared/model";
import { ProfileScreen, profileDraftAfterReload, type ProfileDraft } from "./settings";
import { TranslationConfigurationSelector } from "../../inference/translation-selector";

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
			onProfileLoaded={() => undefined}
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
		expect(markup).not.toContain("Effective model");
		expect(markup).not.toContain('<span class="label">Inference</span>');
		expect(markup).not.toContain("Inference Provider");
		expect(markup).not.toContain("Inference: Agentic Loop");
		expect(markup).not.toContain("Inference: Image Generation");
		expect(markup).not.toContain("OpenRouter API key");
	});

	it("offers a translation inference configuration selector and no translation-only inference fields", () => {
		const markup = render();
		expect(markup).toContain("Translation inference configuration");
		expect(markup).toContain("Account default or a custom configuration");
		// Translation-only model, reasoning, tool-call, and sampling editors are gone.
		expect(markup).not.toContain("Inference: Translation");
		expect(markup).not.toContain("Repetition penalty");
		expect(markup).not.toContain("Top K");
	});
});

/**
 * Saving a translation configuration selection rereads the profile so the
 * account's translation annotation and fingerprint follow it. That reread must
 * not cost the owner an unsaved profile edit — including the translation toggle
 * and prompt, which live on the profile rather than in the configuration graph.
 */
describe("profile refresh after a translation selection", () => {
	const loaded: ProfileDraft = {
		handle: "owner",
		language: "en",
		uiLocale: "system",
		displayName: "Owner",
		translationEnabled: false,
		translationPrompt: "Saved prompt",
	};

	it("keeps every field the owner has edited", () => {
		const draft: ProfileDraft = {
			...loaded,
			handle: "renamed-owner",
			displayName: "Edited name",
			translationEnabled: true,
			translationPrompt: "Unsaved prompt",
		};
		expect(profileDraftAfterReload(draft, loaded, loaded)).toEqual(draft);
	});

	it("adopts the reloaded values for fields the owner has not touched", () => {
		const next: ProfileDraft = { ...loaded, displayName: "Renamed elsewhere", translationPrompt: "Prompt from elsewhere" };
		const draft: ProfileDraft = { ...loaded, translationPrompt: "Unsaved prompt" };
		expect(profileDraftAfterReload(draft, loaded, next)).toEqual({
			...next,
			translationPrompt: "Unsaved prompt",
		});
	});
});

describe("translation configuration selector", () => {
	it("explains the candidate restriction and owns no translation inference fields", () => {
		const markup = renderToStaticMarkup(<TranslationConfigurationSelector onSelectionSaved={() => undefined} />);
		expect(markup).toContain("Only Account default and your custom configurations can be selected");
		expect(markup).toContain("fully resolved provider, model, routing, reasoning, tool-call, and\n\t\t\t\tsampling values".replace(/\s+/g, " "));
		expect(markup).not.toContain("Reasoning");
		expect(markup).not.toContain("Temperature");
		expect(markup).toContain("Search Account default and custom configurations");
	});
});
