import type { BotSummary, UserProfile, WorldSummary } from "@bickr/shared/model";
import {
	AvatarGenerationScreen,
	type AvatarGenerationScreenProps,
} from "./AvatarGenerationScreen";

type BotMutationResponse = { bot: BotSummary; affectedBots?: BotSummary[] };
type UserMutationResponse = { profile: UserProfile };
type WorldMutationResponse = { world: WorldSummary };

export function BotAvatarGenerationScreen(props: AvatarGenerationScreenProps<BotMutationResponse, BotSummary>) {
	return <AvatarGenerationScreen {...props} />;
}

export function UserAvatarGenerationScreen(props: AvatarGenerationScreenProps<UserMutationResponse, UserProfile>) {
	return <AvatarGenerationScreen {...props} />;
}

export function WorldAvatarGenerationScreen(props: AvatarGenerationScreenProps<WorldMutationResponse, WorldSummary>) {
	return <AvatarGenerationScreen {...props} />;
}
