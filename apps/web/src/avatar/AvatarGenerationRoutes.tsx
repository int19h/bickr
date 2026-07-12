import type { BotSummary, UserProfile, WorldSummary } from "@bickr/shared/model";
import {
	WorldAvatarPromptFillSettingsModal,
	avatarGenerationDraftAdapter,
} from "../components/inference-fields";
import type { InferenceDraft } from "../settings-drafts/inference-draft";
import {
	AvatarGenerationScreen,
	type AvatarGenerationScreenProps,
} from "./AvatarGenerationScreen";

type BotMutationResponse = { bot: BotSummary; affectedBots?: BotSummary[] };
type UserMutationResponse = { profile: UserProfile };
type WorldMutationResponse = { world: WorldSummary };

type BotAvatarGenerationProps = Omit<
	AvatarGenerationScreenProps<InferenceDraft, BotMutationResponse, BotSummary>,
	"adapter"
>;
type UserAvatarGenerationProps = Omit<
	AvatarGenerationScreenProps<InferenceDraft, UserMutationResponse, UserProfile>,
	"adapter"
>;
type WorldAvatarGenerationProps = Omit<
	AvatarGenerationScreenProps<InferenceDraft, WorldMutationResponse, WorldSummary>,
	"adapter" | "renderPromptFillSettingsModal"
> & { modelSuggestions: string[] };

export function BotAvatarGenerationScreen(props: BotAvatarGenerationProps) {
	return <AvatarGenerationScreen {...props} adapter={avatarGenerationDraftAdapter} />;
}

export function UserAvatarGenerationScreen(props: UserAvatarGenerationProps) {
	return <AvatarGenerationScreen {...props} adapter={avatarGenerationDraftAdapter} />;
}

export function WorldAvatarGenerationScreen({ modelSuggestions, ...props }: WorldAvatarGenerationProps) {
	return (
		<AvatarGenerationScreen
			{...props}
			adapter={avatarGenerationDraftAdapter}
			renderPromptFillSettingsModal={(modalProps) => (
				<WorldAvatarPromptFillSettingsModal {...modalProps} modelSuggestions={modelSuggestions} />
			)}
		/>
	);
}
