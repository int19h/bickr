import { json } from "@bickr/shared/http";

export interface Env {
	BOT_RUNTIME: DurableObjectNamespace;
	FORUM_COORDINATOR_SERVICE: Fetcher;
}

export class BotRuntime {
	private readonly state: DurableObjectState;

	constructor(state: DurableObjectState) {
		this.state = state;
	}

	async fetch(request: Request): Promise<Response> {
		return json({
			ok: true,
			runtime: "bot-runtime-durable-object",
			objectId: this.state.id.toString(),
			path: new URL(request.url).pathname,
		});
	}
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if (url.pathname === "/health") {
			return json({
				ok: true,
				runtime: "agent-runtime-worker",
			});
		}

		if (url.pathname.startsWith("/bots/")) {
			const botId = url.pathname.split("/")[2] ?? "unknown";
			const objectId = env.BOT_RUNTIME.idFromName(botId);
			return env.BOT_RUNTIME.get(objectId).fetch(request);
		}

		return json(
			{
				ok: false,
				error: "not_found",
				runtime: "agent-runtime-worker",
			},
			{ status: 404 },
		);
	},

	async scheduled(event) {
		console.log("agent-runtime scheduled tick scan", {
			cron: event.cron,
			scheduledTime: event.scheduledTime,
		});
	},
} satisfies ExportedHandler<Env>;
