import { bootstrapPayload } from "@bickr/shared/bootstrap";
import { json } from "./_json";

export const onRequestGet: PagesFunction<Env> = ({ env }) => {
	return json({
		app: bootstrapPayload.app.name,
		bindings: {
			agentRuntime: Boolean(env.AGENT_RUNTIME),
			botRuntime: Boolean(env.BOT_RUNTIME),
			forumCoordinator: Boolean(env.FORUM_COORDINATOR),
			forumCoordinatorService: Boolean(env.FORUM_COORDINATOR_SERVICE),
		},
		ok: true,
		runtime: "cloudflare-pages-functions",
	});
};
