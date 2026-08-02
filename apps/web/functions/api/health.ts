import { bootstrapPayload } from "@bickr/shared/bootstrap";
import { readMaintenanceState } from "@bickr/shared/maintenance";
import type { AppEnv } from "./_auth";
import { json } from "./_json";

export const onRequestGet: PagesFunction<AppEnv> = async ({ env }) => {
	return json({
		app: bootstrapPayload.app.name,
		bindings: {
			agentRuntime: Boolean(env.AGENT_RUNTIME),
			botRuntime: Boolean(env.BOT_RUNTIME),
			forumCoordinator: Boolean(env.FORUM_COORDINATOR),
			forumCoordinatorService: Boolean(env.FORUM_COORDINATOR_SERVICE),
		},
		maintenance: await readMaintenanceState(env.BICKR_D1),
		ok: true,
		runtime: "cloudflare-pages-functions",
	});
};
