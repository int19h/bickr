import {
	localizedTextLang,
	localizedTextString,
	type AvatarCrop,
	type AvatarImage,
	type BotSummary,
	type LanguageTag,
	type LocalizedText,
	type UserProfile,
	type WorldSummary,
} from "@bickr/shared/model";
import type { AvatarInferenceTarget } from "@bickr/shared/inference-configuration";
import type { FixedInferenceConfigurationReference } from "@bickr/shared/inference-configuration-owner";

import { defaultLanguageTag } from "../language";

export type AvatarTargetKind = "bot" | "user" | "world";

export type AvatarPromptFillMode = "persona" | "description" | "members" | "current_avatar";

/**
 * Prompt fill runs on the target's own configuration; the world screen edits
 * those fields directly on the configuration, so no option carries its own
 * parameter dialog.
 */
export type AvatarPromptFillOption = {
	idleLabel: string;
	mode: AvatarPromptFillMode;
	requirement: "none" | "current-avatar" | "members";
	visibleWhenUnavailable: boolean;
};

export type AvatarTargetOwner = {
	avatar?: AvatarImage;
	avatarCrop?: AvatarCrop;
	avatarUrl?: string;
	displayName: string | LocalizedText;
	handle: string;
	key: string;
	language: LanguageTag;
};

export type AvatarTargetEndpoints = {
	apply: string;
	clear: string;
	crop: string;
	generate: string;
	prompt: string;
	upload: string;
};

export type AvatarTarget<TMutationResponse, TSaved> = {
	endpoints: AvatarTargetEndpoints;
	generation: {
		/** The fixed configuration whose resolved image fields this target uses. */
		configuration: FixedInferenceConfigurationReference;
		/**
		 * Worlds expose the text-inference fields their description/members
		 * prompt fill uses for direct editing on the generation screen; other
		 * targets have no text fill that takes parameters there.
		 */
		editablePromptFillSettings: boolean;
		imageTarget: AvatarInferenceTarget;
		/** Entity-owned image prompt; prompts are never reusable inference. */
		prompt: string;
		promptFillOptions: readonly AvatarPromptFillOption[];
	};
	kind: AvatarTargetKind;
	owner: AvatarTargetOwner;
	readSaved(response: TMutationResponse): { affectedBots?: BotSummary[]; saved: TSaved };
	uiText: {
		cropEmpty: string;
		discardedSettings: string;
		handlePrefix: string;
		promptId: string;
	};
};

type BotMutationResponse = { bot: BotSummary; affectedBots?: BotSummary[] };
type UserMutationResponse = { profile: UserProfile };
type WorldMutationResponse = { world: WorldSummary };

const currentAvatarPromptFill = {
	idleLabel: "Fill from current avatar",
	mode: "current_avatar",
	requirement: "current-avatar",
	visibleWhenUnavailable: true,
} as const satisfies AvatarPromptFillOption;

export function botAvatarTarget(bot: BotSummary): AvatarTarget<BotMutationResponse, BotSummary> {
	return {
		kind: "bot",
		owner: {
			avatar: bot.avatar,
			avatarCrop: bot.avatarCrop,
			avatarUrl: bot.avatarUrl,
			displayName: bot.displayName,
			handle: bot.handle,
			key: bot.id,
			language: bot.localOverrides?.language ?? bot.language ?? localizedTextLang(bot.displayName) ?? defaultLanguageTag,
		},
		endpoints: {
			upload: `/api/me/bots/${encodeURIComponent(bot.id)}/avatar`,
			crop: `/api/me/bots/${encodeURIComponent(bot.id)}/avatar/crop`,
			prompt: `/api/me/bots/${encodeURIComponent(bot.id)}/avatar/prompt`,
			generate: `/api/me/bots/${encodeURIComponent(bot.id)}/avatar/generate`,
			apply: `/api/me/bots/${encodeURIComponent(bot.id)}/avatar/apply`,
			clear: `/api/me/bots/${encodeURIComponent(bot.id)}/avatar`,
		},
		generation: {
			configuration: { kind: "bot", botId: bot.id },
			editablePromptFillSettings: false,
			imageTarget: "participant",
			prompt: localizedTextString(bot.inferenceSettings.imageGeneration?.prompt),
			promptFillOptions: [
				currentAvatarPromptFill,
				{
					idleLabel: "Fill from persona",
					mode: "persona",
					requirement: "none",
					visibleWhenUnavailable: true,
				},
			],
		},
		readSaved: (response) => ({ saved: response.bot, affectedBots: response.affectedBots }),
		uiText: {
			cropEmpty: "This participant does not have an avatar to crop.",
			discardedSettings: "Participant image generation settings reset.",
			handlePrefix: "u/",
			promptId: "avatar-generation-prompt",
		},
	};
}


type UserAvatarTargetInput = Pick<UserProfile, "avatar" | "avatarCrop" | "avatarUrl" | "displayName" | "handle" | "id" | "language"> &
	Partial<Pick<UserProfile, "inferenceSettings">>;

export function userAvatarTarget(profile: UserAvatarTargetInput): AvatarTarget<UserMutationResponse, UserProfile> {
	return {
		kind: "user",
		owner: {
			avatar: profile.avatar,
			avatarCrop: profile.avatarCrop,
			avatarUrl: profile.avatarUrl,
			displayName: profile.displayName,
			handle: profile.handle,
			key: profile.id,
			language: profile.language ?? localizedTextLang(profile.displayName) ?? defaultLanguageTag,
		},
		endpoints: {
			upload: "/api/me/avatar",
			crop: "/api/me/avatar/crop",
			prompt: "/api/me/avatar/prompt",
			generate: "/api/me/avatar/generate",
			apply: "/api/me/avatar/apply",
			clear: "/api/me/avatar",
		},
		generation: {
			configuration: { kind: "account_default" },
			editablePromptFillSettings: false,
			imageTarget: "participant",
			prompt: localizedTextString(profile.inferenceSettings?.imageGeneration?.prompt),
			promptFillOptions: [{ ...currentAvatarPromptFill, visibleWhenUnavailable: false }],
		},
		readSaved: (response) => ({ saved: response.profile }),
		uiText: {
			cropEmpty: "Your profile does not have an avatar to crop.",
			discardedSettings: "Profile image generation settings reset.",
			handlePrefix: "hu/",
			promptId: "user-avatar-generation-prompt",
		},
	};
}

export function worldAvatarTarget(world: WorldSummary): AvatarTarget<WorldMutationResponse, WorldSummary> {
	return {
		kind: "world",
		owner: {
			avatar: world.avatar,
			avatarCrop: world.avatarCrop,
			avatarUrl: world.avatarUrl,
			displayName: world.name,
			handle: world.handle,
			key: world.id,
			language: world.language ?? localizedTextLang(world.name) ?? defaultLanguageTag,
		},
		endpoints: {
			upload: `/api/worlds/${encodeURIComponent(world.handle)}/avatar`,
			crop: `/api/worlds/${encodeURIComponent(world.handle)}/avatar/crop`,
			prompt: `/api/worlds/${encodeURIComponent(world.handle)}/avatar/prompt`,
			generate: `/api/worlds/${encodeURIComponent(world.handle)}/avatar/generate`,
			apply: `/api/worlds/${encodeURIComponent(world.handle)}/avatar/apply`,
			clear: `/api/worlds/${encodeURIComponent(world.handle)}/avatar`,
		},
		generation: {
			configuration: { kind: "world", worldId: world.id },
			editablePromptFillSettings: true,
			imageTarget: "world",
			prompt: localizedTextString(world.imageGeneration?.prompt),
			promptFillOptions: [
				currentAvatarPromptFill,
				{
					idleLabel: "Fill from description",
					mode: "description",
					requirement: "none",
					visibleWhenUnavailable: true,
				},
				{
					idleLabel: "Fill from members",
					mode: "members",
					requirement: "members",
					visibleWhenUnavailable: true,
				},
			],
		},
		readSaved: (response) => ({ saved: response.world }),
		uiText: {
			cropEmpty: "This world does not have an avatar to crop.",
			discardedSettings: "World image generation settings reset.",
			handlePrefix: "w/",
			promptId: "world-avatar-generation-prompt",
		},
	};
}
