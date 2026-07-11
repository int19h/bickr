import {
	avatarImageGenerationSettingsWithDefaults,
	localizedTextLang,
	worldAvatarImageGenerationSettingsWithDefaults,
	type AvatarCrop,
	type AvatarImage,
	type BotInferenceSettings,
	type BotSummary,
	type LanguageTag,
	type LocalizedText,
	type UserProfile,
	type WorldSummary,
} from "@bickr/shared/model";

import { defaultLanguageTag } from "../language";

export type AvatarTargetKind = "bot" | "user" | "world";

export type AvatarPromptFillMode = "persona" | "description" | "members" | "current_avatar";
export type AvatarTextPromptFillMode = Extract<AvatarPromptFillMode, "description" | "members">;

type AvatarPromptFillOptionBase = {
	idleLabel: string;
	requirement: "none" | "current-avatar" | "members";
	visibleWhenUnavailable: boolean;
};

export type AvatarPromptFillOption = AvatarPromptFillOptionBase & (
	| { mode: Exclude<AvatarPromptFillMode, AvatarTextPromptFillMode>; settingsDialog: false }
	| { mode: AvatarTextPromptFillMode; settingsDialog: true }
);

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
	promptSettings: string | null;
	upload: string;
};

export type AvatarGenerationSettingsSource = "participant-or-owner" | "profile" | "world-or-owner";

export type AvatarTarget<TMutationResponse, TSaved> = {
	endpoints: AvatarTargetEndpoints;
	generation: {
		defaultSettings: BotInferenceSettings;
		hasOwnSettings: boolean;
		promptFillOptions: readonly AvatarPromptFillOption[];
		resetSettings: BotInferenceSettings;
		settingsKey: string;
		settingsSource: AvatarGenerationSettingsSource;
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

function defaultParticipantAvatarSettings(settings: BotInferenceSettings): BotInferenceSettings {
	return {
		...settings,
		imageGeneration: avatarImageGenerationSettingsWithDefaults(settings.imageGeneration),
	};
}

function defaultWorldAvatarSettings(settings: BotInferenceSettings): BotInferenceSettings {
	return {
		...settings,
		imageGeneration: worldAvatarImageGenerationSettingsWithDefaults(settings.imageGeneration),
	};
}

const currentAvatarPromptFill = {
	idleLabel: "Fill from current avatar",
	mode: "current_avatar",
	requirement: "current-avatar",
	settingsDialog: false,
	visibleWhenUnavailable: true,
} as const satisfies AvatarPromptFillOption;

export function botAvatarTarget(
	bot: BotSummary,
	ownerInferenceSettings: BotInferenceSettings | null,
): AvatarTarget<BotMutationResponse, BotSummary> {
	const ownerSettings = ownerInferenceSettings ?? {};
	const sourceSettings = bot.inferenceSettings.imageGeneration ? bot.inferenceSettings : ownerSettings;
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
			promptSettings: null,
		},
		generation: {
			defaultSettings: defaultParticipantAvatarSettings(sourceSettings),
			hasOwnSettings: Boolean(bot.inferenceSettings.imageGeneration),
			promptFillOptions: [
				currentAvatarPromptFill,
				{
					idleLabel: "Fill from persona",
					mode: "persona",
					requirement: "none",
					settingsDialog: false,
					visibleWhenUnavailable: true,
				},
			],
			resetSettings: defaultParticipantAvatarSettings(ownerSettings),
			settingsKey: JSON.stringify(sourceSettings),
			settingsSource: "participant-or-owner",
		},
		readSaved: (response) => ({ saved: response.bot, affectedBots: response.affectedBots }),
		uiText: {
			cropEmpty: "This participant does not have an avatar to crop.",
			discardedSettings: "Participant image generation settings discarded.",
			handlePrefix: "u/",
			promptId: "avatar-generation-prompt",
		},
	};
}


type UserAvatarTargetInput = Pick<UserProfile, "avatar" | "avatarCrop" | "avatarUrl" | "displayName" | "handle" | "id" | "language"> &
	Partial<Pick<UserProfile, "inferenceSettings">>;

export function userAvatarTarget(profile: UserAvatarTargetInput): AvatarTarget<UserMutationResponse, UserProfile> {
	const inferenceSettings = profile.inferenceSettings ?? {};
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
			promptSettings: null,
		},
		generation: {
			defaultSettings: defaultParticipantAvatarSettings(inferenceSettings),
			hasOwnSettings: Boolean(inferenceSettings.imageGeneration),
			promptFillOptions: [{ ...currentAvatarPromptFill, visibleWhenUnavailable: false }],
			resetSettings: defaultParticipantAvatarSettings(inferenceSettings),
			settingsKey: JSON.stringify(inferenceSettings),
			settingsSource: "profile",
		},
		readSaved: (response) => ({ saved: response.profile }),
		uiText: {
			cropEmpty: "Your profile does not have an avatar to crop.",
			discardedSettings: "Profile image generation settings discarded.",
			handlePrefix: "hu/",
			promptId: "user-avatar-generation-prompt",
		},
	};
}

export function worldAvatarTarget(
	world: WorldSummary,
	ownerInferenceSettings: BotInferenceSettings | null,
): AvatarTarget<WorldMutationResponse, WorldSummary> {
	const ownerSettings = ownerInferenceSettings ?? {};
	const sourceSettings = world.imageGeneration ? { imageGeneration: world.imageGeneration } : ownerSettings;
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
			promptSettings: `/api/worlds/${encodeURIComponent(world.handle)}/avatar/prompt-settings`,
		},
		generation: {
			defaultSettings: defaultWorldAvatarSettings(sourceSettings),
			hasOwnSettings: Boolean(world.imageGeneration),
			promptFillOptions: [
				currentAvatarPromptFill,
				{
					idleLabel: "Fill from description",
					mode: "description",
					requirement: "none",
					settingsDialog: true,
					visibleWhenUnavailable: true,
				},
				{
					idleLabel: "Fill from members",
					mode: "members",
					requirement: "members",
					settingsDialog: true,
					visibleWhenUnavailable: true,
				},
			],
			resetSettings: defaultWorldAvatarSettings(ownerSettings),
			settingsKey: JSON.stringify(sourceSettings),
			settingsSource: "world-or-owner",
		},
		readSaved: (response) => ({ saved: response.world }),
		uiText: {
			cropEmpty: "This world does not have an avatar to crop.",
			discardedSettings: "World image generation settings discarded.",
			handlePrefix: "w/",
			promptId: "world-avatar-generation-prompt",
		},
	};
}
