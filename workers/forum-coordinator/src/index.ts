import { json } from "@bickr/shared/http";

export interface Env {
	FORUM_COORDINATOR: DurableObjectNamespace;
}

export class ForumCoordinator {
	private readonly state: DurableObjectState;

	constructor(state: DurableObjectState) {
		this.state = state;
	}

	async fetch(request: Request): Promise<Response> {
		return json({
			ok: true,
			runtime: "forum-coordinator-durable-object",
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
				runtime: "forum-coordinator-worker",
			});
		}

		if (url.pathname.startsWith("/forums/")) {
			const forumId = url.pathname.split("/")[2] ?? "unknown";
			const objectId = env.FORUM_COORDINATOR.idFromName(forumId);
			return env.FORUM_COORDINATOR.get(objectId).fetch(request);
		}

		return json(
			{
				ok: false,
				error: "not_found",
				runtime: "forum-coordinator-worker",
			},
			{ status: 404 },
		);
	},
} satisfies ExportedHandler<Env>;
