import { describe, expect, it } from "vitest";
import { toolInputFromDraft, type BotToolDraft } from "../apps/web/src/tool-settings-draft";
import { mergeToolSettings } from "@bickr/shared/repository";

describe("toolInputFromDraft", () => {
	it("serializes unchecked OpenRouter server tools as explicit disables", () => {
		expect(toolInputFromDraft(emptyToolDraft())).toEqual({
			bickrNotes: { enabled: true },
			openRouter: {
				datetime: { enabled: false, timezone: null },
				webSearch: {
					enabled: false,
					engine: null,
					maxResults: null,
					maxTotalResults: null,
					searchContextSize: null,
					userLocation: null,
					allowedDomains: null,
					excludedDomains: null,
				},
				webFetch: {
					enabled: false,
					engine: null,
					maxUses: null,
					maxContentTokens: null,
					allowedDomains: null,
					blockedDomains: null,
				},
			},
		});
	});

	it("keeps disabled tool parameters so they can be saved while access is off", () => {
		const draft = emptyToolDraft();
		draft.openRouter.datetime.timezone = "America/Los_Angeles";
		draft.openRouter.webSearch.allowedDomains = "Example.com, docs.example.com";
		draft.openRouter.webFetch.maxUses = "3";

		expect(toolInputFromDraft(draft)).toMatchObject({
			openRouter: {
				datetime: { enabled: false, timezone: "America/Los_Angeles" },
				webSearch: { enabled: false, allowedDomains: ["example.com", "docs.example.com"] },
				webFetch: { enabled: false, maxUses: 3 },
			},
		});
	});

	it("keeps the note choice when an unrelated tool setting changes", () => {
		expect(mergeToolSettings({ bickrNotes: { enabled: false } }, { openRouter: { datetime: { enabled: true, timezone: "UTC" } } }))
			.toMatchObject({ bickrNotes: { enabled: false }, openRouter: { datetime: { enabled: true } } });
		expect(mergeToolSettings(undefined)).toMatchObject({ bickrNotes: { enabled: true } });
	});
});

function emptyToolDraft(): BotToolDraft {
	return {
		notesEnabled: true,
		openRouter: {
			datetime: {
				enabled: false,
				timezone: "",
			},
			webSearch: {
				enabled: false,
				engine: "",
				maxResults: "",
				maxTotalResults: "",
				searchContextSize: "",
				userLocationCity: "",
				userLocationRegion: "",
				userLocationCountry: "",
				userLocationTimezone: "",
				allowedDomains: "",
				excludedDomains: "",
			},
			webFetch: {
				enabled: false,
				engine: "",
				maxUses: "",
				maxContentTokens: "",
				allowedDomains: "",
				blockedDomains: "",
			},
		},
	};
}
