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
	parseUpdateBotInput,
	parseUpdateUserProfileInput,
	parseUpdateWorldInput,
} from "@bickr/shared/validation";

import { AvatarCropModal } from "./AvatarCropModal";
import { AvatarGenerationScreen } from "./AvatarGenerationScreen";
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
		inferenceSettings: { imageGeneration: { model: "user-image-model", prompt: localizedText("A portrait.", en) } },
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
		imageGeneration: { model: "world-image-model", prompt: localizedText("A world banner.", en) },
		...overrides,
	};
}

function renderFamilies<TMutationResponse, TSaved>(target: AvatarTarget<TMutationResponse, TSaved>): string[] {
	const common = { onClose: () => undefined, onSaved: () => undefined, open: true, target };
	return [
		renderToStaticMarkup(<AvatarUploadModal {...common} />),
		renderToStaticMarkup(<AvatarCropModal {...common} />),
		renderToStaticMarkup(
			<AvatarGenerationScreen
				breadcrumb={<div className="thread-crumb">avatar breadcrumb</div>}
				fallbackAvatar={<span>fallback avatar</span>}
				onBack={() => undefined}
				onSavePrompt={async () => true}
				onSaved={() => undefined}
				returnTo={{ route: "profile-avatar" }}
				target={target}
			/>,
		),
	];
}

describe("AvatarTarget", () => {
	it("uses the bot display-name language and then English when no language is explicit", () => {
		expect(botAvatarTarget(bot({ displayName: localizedText("One", ja), language: null })).owner.language).toBe(ja);
		expect(botAvatarTarget(bot({ displayName: localizedText("One", null), language: null })).owner.language).toBe(en);
	});

	it("uses the user display-name language and then English when no language is explicit", () => {
		expect(userAvatarTarget(user({ displayName: localizedText("Owner", ja), language: null })).owner.language).toBe(ja);
		expect(userAvatarTarget(user({ displayName: localizedText("Owner", null), language: null })).owner.language).toBe(en);
	});

	it("uses the world name language and then English when no language is explicit", () => {
		expect(worldAvatarTarget(world({ language: null, name: localizedText("World One", ja) })).owner.language).toBe(ja);
		expect(worldAvatarTarget(world({ language: null, name: localizedText("World One", null) })).owner.language).toBe(en);
	});

	// The prompt-only save posts to the entity PATCH endpoints with no `language`
	// field in the body, and those parsers validate localized text against the
	// request-body language (null when absent) — NOT the entity's effective
	// language chain the avatar endpoints use (issue #91, second occurrence).
	it("builds prompt-only save payloads that the entity PATCH parsers accept", () => {
		const imageGeneration = { prompt: localizedText("portrait", null) };
		expect(() => parseUpdateUserProfileInput({ inferenceSettings: { imageGeneration } })).not.toThrow();
		expect(() => parseUpdateBotInput({ inferenceSettings: { imageGeneration } })).not.toThrow();
		expect(() => parseUpdateWorldInput({ imageGeneration })).not.toThrow();
	});

	// The compatibility adapter derives its replacement mask from the keys a
	// legacy write carries, so a prompt-only image write must carry no reusable
	// image key at all or it would replace graph overrides.
	it("keeps reusable image fields out of a prompt-only image write", () => {
		const parsed = parseUpdateWorldInput({ imageGeneration: { prompt: localizedText("portrait", null) } });
		expect(Object.keys(parsed.imageGeneration ?? {})).toEqual(["prompt"]);
	});

	it("stamps the entity language chain on the apply payload the avatar endpoint validates", () => {
		const target = userAvatarTarget(user({ displayName: localizedText("Eigentümer", de), language: null }));
		expect(target.owner.language).toBe(de);
	});

	it("addresses each target's own fixed configuration and image target", () => {
		expect(botAvatarTarget(bot()).generation).toMatchObject({
			configuration: { kind: "bot", botId: "bot_one" },
			imageTarget: "participant",
		});
		expect(userAvatarTarget(user()).generation).toMatchObject({
			configuration: { kind: "account_default", ownerUserId: "usr_one" },
			imageTarget: "participant",
			prompt: "A portrait.",
		});
		expect(worldAvatarTarget(world()).generation).toMatchObject({
			configuration: { kind: "world", worldId: "wld_one" },
			imageTarget: "world",
			prompt: "A world banner.",
		});
	});

	it("describes bot endpoints without a local prompt-settings surface", () => {
		expect(botAvatarTarget(bot()).endpoints).toEqual({
			apply: "/api/me/bots/bot_one/avatar/apply",
			clear: "/api/me/bots/bot_one/avatar",
			crop: "/api/me/bots/bot_one/avatar/crop",
			generate: "/api/me/bots/bot_one/avatar/generate",
			prompt: "/api/me/bots/bot_one/avatar/prompt",
			upload: "/api/me/bots/bot_one/avatar",
		});
	});

	it("describes user endpoints", () => {
		expect(userAvatarTarget(user()).endpoints).toEqual({
			apply: "/api/me/avatar/apply",
			clear: "/api/me/avatar",
			crop: "/api/me/avatar/crop",
			generate: "/api/me/avatar/generate",
			prompt: "/api/me/avatar/prompt",
			upload: "/api/me/avatar",
		});
	});

	it("describes world endpoints", () => {
		expect(worldAvatarTarget(world()).endpoints).toEqual({
			apply: "/api/worlds/one/avatar/apply",
			clear: "/api/worlds/one/avatar",
			crop: "/api/worlds/one/avatar/crop",
			generate: "/api/worlds/one/avatar/generate",
			prompt: "/api/worlds/one/avatar/prompt",
			upload: "/api/worlds/one/avatar",
		});
	});
});

describe("parameterized avatar components", () => {
	it("mounts upload, crop, and generation for bots", () => {
		const [upload, crop, generation] = renderFamilies(botAvatarTarget(bot()));
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
		const [upload, crop, generation] = renderFamilies(worldAvatarTarget(world()));
		expect(upload).toContain("Upload Avatar");
		expect(crop).toContain("This world does not have an avatar to crop.");
		expect(generation).toContain("Fill from members");
	});

	it("shows the linked configuration instead of an image inference editor", () => {
		const [, , generation] = renderFamilies(worldAvatarTarget(world()));
		expect(generation).toContain("Image inference configuration");
		expect(generation).toContain("resolved by the linked configuration");
		expect(generation).toContain("World avatars use this configuration");
		// No local model picker, advanced parameter panel, or settings reset.
		expect(generation).not.toContain("Advanced generation parameters");
		expect(generation).not.toContain("Choose a model");
		expect(generation).not.toContain(">Reset<");
	});

	it("keeps the entity-owned image prompt in the generation screen", () => {
		const [, , generation] = renderFamilies(userAvatarTarget(user()));
		expect(generation).toContain("A portrait.");
	});
});
