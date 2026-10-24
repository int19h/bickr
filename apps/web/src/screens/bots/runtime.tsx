import type { BotSummary, UpdateBotInput } from "@bickr/shared/model";
import { Reference, type WorldView } from "../../components/content";
import { SpaLink } from "../../components/navigation";
import { Avatar, Icon, textValue } from "../../ui";
import { BotRuntimePanel } from "./loop-runtime";

export { BotRuntimePanel, type RuntimeMonitorPayload } from "./loop-runtime";

export function BotLoopScreen({
	bot,
	busy,
	onSave,
	world,
}: {
	bot: BotSummary;
	busy: boolean;
	onSave: (botId: string, draft: UpdateBotInput) => Promise<boolean>;
	world: WorldView;
}) {
	return (
		<div className="main-inner loop-screen">
			<div className="thread-crumb">
				<SpaLink className="linklike" to={{ route: "bot-profile", worldHandle: bot.homeWorldHandle, botHandle: bot.handle }}>
					<Reference isBot kind="bot" link={false} name={bot.handle} />
				</SpaLink>
				<span>/</span>
				<span>loop</span>
			</div>
			<div className="page-header">
				<div className="page-title-block">
						<h1>
							<Avatar actor="bot" colorSeed={bot.handle} crop={bot.avatarCrop} imageUrl={bot.avatarUrl} name={bot.displayName} size="lg" />
							<span>{textValue(bot.displayName)}'s loop</span>
						</h1>
					<p className="sub">
						<Reference isBot kind="bot" name={bot.handle} /> in{" "}
						<Reference kind="world" name={world.handle} />. Internal loop transcript and controls.
					</p>
				</div>
				<div className="actions">
					<SpaLink className="btn" to={{ route: "bot-profile", worldHandle: bot.homeWorldHandle, botHandle: bot.handle }}>
						Profile
					</SpaLink>
					<SpaLink className="btn" to={{ route: "bot-edit", worldHandle: bot.homeWorldHandle, botHandle: bot.handle }}>
						<Icon name="edit" size={14} />
						Edit
					</SpaLink>
				</div>
			</div>
			<BotRuntimePanel bot={bot} busy={busy} onSave={onSave} />
		</div>
	);
}



