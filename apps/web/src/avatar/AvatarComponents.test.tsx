import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	localizedText,
	type BotSummary,
	type LanguageTag,
	type UserProfile,
	type WorldSummary,
} from "@bickr/shared/model";
import {
	parseImageGenerationSettings,
	parseUpdateBotInput,
	parseUpdateUserProfileInput,
	parseUpdateWorldInput,
} from "@bickr/shared/validation";

import { AvatarCropModal } from "./AvatarCropModal";
import {
	AvatarGenerationScreen,
	type AvatarGenerationDraftAdapter,
} from "./AvatarGenerationScreen";
import { AvatarUploadModal } from "./AvatarUploadModal";
import {
	botAvatarTarget,
	userAvatarTarget,
	worldAvatarTarget,
	type AvatarTarget,
} from "./target";

const en = "en" as LanguageTag;
const de = "de" as LanguageTag;
const ja = "ja" as LanguageTag;
const now = "2026-07-10T00:00:00.000Z";

function bot(overrides: Partial<BotSummary> = {}): BotSummary {
	return {
		id: "bot_one",
		handle: "one",
		homeWorldId: "wld_one",
		homeWorldHandle: "one",
		ownerUserId: "usr_one",
		language: en,
		includeLanguageInSystemPrompt: false,
		displayName: localizedText("One", en),
		shortBio: localizedText("One participant.", en),
		inferenceSettings: {},
		postingSettings: {},
		effectivePostingSettings: { commentBodyCharacters: 2_000, threadBodyCharacters: 6_000 },
		tickSettings: { enabled: false, intervalSeconds: 86_400, compactionThreshold: 0.75 },
		effectiveTickSettings: {
			enabled: false,
			intervalSeconds: 86_400,
			compactionThreshold: 0.75,
			allowEarlyLogOff: true,
			contextWindowTokens: 16_000,
			compactionSummaryPercent: 15,
			compactionMaxCharacters: 12_000,
			maxToolCallsPerTick: 16,
			maxSuccessfulToolCallsPerIteration: 8,
			maxGeneratedTokensPerTick: 16_000,
			maxGeneratedTokensPerIteration: 4_000,
		},
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function user(overrides: Partial<UserProfile> = {}): UserProfile {
	return {
		id: "usr_one",
		handle: "owner",
		displayName: localizedText("Owner", en),
		language: en,
		uiLocale: "system",
		profileComplete: true,
		inferenceSettings: { imageGeneration: { model: "user-image-model" } },
		authIdentities: [],
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function world(overrides: Partial<WorldSummary> = {}): WorldSummary {
	return {
		id: "wld_one",
		handle: "one",
		name: localizedText("World One", en),
		description: localizedText("A world.", en),
		prompt: localizedText("World prompt.", en),
		recurringPromptEnabled: false,
		recurringPrompt: localizedText("", en),
		initialBotNotification: localizedText("Welcome.", en),
		language: en,
		createdByUserId: "usr_one",
		createdAt: now,
		updatedAt: now,
		imageGeneration: { model: "world-image-model" },
		...overrides,
	};
}

type Draft = { model: string; prompt: string };

const adapter: AvatarGenerationDraftAdapter<Draft> = {
	configError: () => "",
	fromSettings: (settings) => ({
		model: settings.imageGeneration?.model ?? "",
		prompt: typeof settings.imageGeneration?.prompt === "string" ? settings.imageGeneration.prompt : "",
	}),
	imageGenerationInput: (draft, prompt, language) => ({ model: draft.model || null, prompt: localizedText(prompt, language) }),
	model: (draft) => draft.model,
	providerRoutingError: () => "",
	renderAdvancedFields: () => <div>advanced fields</div>,
	renderBasicFields: () => <div>basic fields</div>,
	withPrompt: (draft, prompt) => ({ ...draft, prompt }),
};

function renderFamilies<TMutationResponse, TSaved>(target: AvatarTarget<TMutationResponse, TSaved>): string[] {
	const common = { onClose: () => undefined, onSaved: () => undefined, open: true, target };
	return [
		renderToStaticMarkup(<AvatarUploadModal {...common} />),
		renderToStaticMarkup(<AvatarCropModal {...common} />),
		renderToStaticMarkup(
			<AvatarGenerationScreen
				adapter={adapter}
				breadcrumb={<div className="thread-crumb">avatar breadcrumb</div>}
				fallbackAvatar={<span>fallback avatar</span>}
				onBack={() => undefined}
				onDiscardSettings={async () => true}
				onSaveSettings={async () => true}
				onSaved={() => undefined}
				target={target}
			/>,
		),
	];
}

describe("AvatarTarget", () => {
	it("uses the bot display-name language and then English when no language is explicit", () => {
		expect(botAvatarTarget(bot({ displayName: localizedText("One", ja), language: null }), null).owner.language).toBe(ja);
		expect(botAvatarTarget(bot({ displayName: localizedText("One", null), language: null }), null).owner.language).toBe(en);
	});

	it("uses the user display-name language and then English when no language is explicit", () => {
		expect(userAvatarTarget(user({ displayName: localizedText("Owner", ja), language: null })).owner.language).toBe(ja);
		expect(userAvatarTarget(user({ displayName: localizedText("Owner", null), language: null })).owner.language).toBe(en);
	});

	it("uses the world name language and then English when no language is explicit", () => {
		expect(worldAvatarTarget(world({ language: null, name: localizedText("World One", ja) }), null).owner.language).toBe(ja);
		expect(worldAvatarTarget(world({ language: null, name: localizedText("World One", null) }), null).owner.language).toBe(en);
	});

	// The settings-only save posts to the entity PATCH endpoints with no
	// `language` field in the body, and those parsers validate localized text
	// against the request-body language (null when absent) — NOT the entity's
	// effective language chain the avatar endpoints use. The regression here
	// drives the real PATCH parsers, exactly the validators that rejected the
	// live save (issue #91, second occurrence).
	it("builds settings-only save payloads that the entity PATCH parsers accept", () => {
		const imageGeneration = adapter.imageGenerationInput(
			{ model: "user-image-model", prompt: "portrait" },
			"portrait",
			null,
		);
		expect(imageGeneration?.prompt).toEqual({ lang: null, text: "portrait" });
		expect(() => parseUpdateUserProfileInput({ inferenceSettings: { imageGeneration } })).not.toThrow();
		expect(() => parseUpdateBotInput({ inferenceSettings: { imageGeneration } })).not.toThrow();
		expect(() => parseUpdateWorldInput({ imageGeneration })).not.toThrow();
	});

	it("keeps the entity language chain for generation payloads validated by the avatar endpoints", () => {
		const target = userAvatarTarget(user({ displayName: localizedText("Eigentümer", de), language: null }));
		const generationSettings = adapter.imageGenerationInput(
			{ model: "user-image-model", prompt: "portrait" },
			"portrait",
			target.owner.language,
		);
		expect(generationSettings?.prompt).toEqual({ lang: de, text: "portrait" });
		expect(() => parseImageGenerationSettings(generationSettings, target.owner.language)).not.toThrow();
	});

	it("describes bot endpoints and participant-or-owner generation defaults", () => {
		const target = botAvatarTarget(
			bot({ inferenceSettings: { imageGeneration: { model: "bot-image-model" } } }),
			{ imageGeneration: { model: "owner-image-model" } },
		);
		expect(target.endpoints).toEqual({
			apply: "/api/me/bots/bot_one/avatar/apply",
			clear: "/api/me/bots/bot_one/avatar",
			crop: "/api/me/bots/bot_one/avatar/crop",
			generate: "/api/me/bots/bot_one/avatar/generate",
			prompt: "/api/me/bots/bot_one/avatar/prompt",
			promptSettings: null,
			upload: "/api/me/bots/bot_one/avatar",
		});
		expect(target.generation.settingsSource).toBe("participant-or-owner");
		expect(target.generation.defaultSettings.imageGeneration?.model).toBe("bot-image-model");
		expect(target.generation.resetSettings.imageGeneration?.model).toBe("owner-image-model");
	});

	it("describes user endpoints and profile generation defaults", () => {
		const target = userAvatarTarget(user());
		expect(target.endpoints).toEqual({
			apply: "/api/me/avatar/apply",
			clear: "/api/me/avatar",
			crop: "/api/me/avatar/crop",
			generate: "/api/me/avatar/generate",
			prompt: "/api/me/avatar/prompt",
			promptSettings: null,
			upload: "/api/me/avatar",
		});
		expect(target.generation.settingsSource).toBe("profile");
		expect(target.generation.defaultSettings.imageGeneration?.model).toBe("user-image-model");
	});

	it("describes world endpoints and world-or-owner generation defaults", () => {
		const target = worldAvatarTarget(world(), { imageGeneration: { model: "owner-image-model" } });
		expect(target.endpoints).toEqual({
			apply: "/api/worlds/one/avatar/apply",
			clear: "/api/worlds/one/avatar",
			crop: "/api/worlds/one/avatar/crop",
			generate: "/api/worlds/one/avatar/generate",
			prompt: "/api/worlds/one/avatar/prompt",
			promptSettings: "/api/worlds/one/avatar/prompt-settings",
			upload: "/api/worlds/one/avatar",
		});
		expect(target.generation.settingsSource).toBe("world-or-owner");
		expect(target.generation.defaultSettings.imageGeneration?.model).toBe("world-image-model");
		expect(target.generation.resetSettings.imageGeneration?.model).toBe("owner-image-model");
	});
});

describe("parameterized avatar components", () => {
	it("mounts upload, crop, and generation for bots", () => {
		const [upload, crop, generation] = renderFamilies(botAvatarTarget(bot(), null));
		expect(upload).toContain("Upload Avatar");
		expect(crop).toContain("This participant does not have an avatar to crop.");
		expect(generation).toContain("Fill from persona");
	});

	it("mounts upload, crop, and generation for users", () => {
		const [upload, crop, generation] = renderFamilies(userAvatarTarget(user()));
		expect(upload).toContain("Upload Avatar");
		expect(crop).toContain("Your profile does not have an avatar to crop.");
		expect(generation).toContain("hu/owner");
	});

	it("mounts upload, crop, and generation for worlds", () => {
		const [upload, crop, generation] = renderFamilies(worldAvatarTarget(world(), null));
		expect(upload).toContain("Upload Avatar");
		expect(crop).toContain("This world does not have an avatar to crop.");
		expect(generation).toContain("Fill from members");
	});
});
