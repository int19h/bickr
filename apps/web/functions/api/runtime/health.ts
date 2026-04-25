import { json } from "@bickr/shared/http";

async function serviceHealth(service: Fetcher, path: string): Promise<unknown> {
	const response = await service.fetch(new Request(`https://internal.bickr${path}`));

	return {
		ok: response.ok,
		status: response.status,
		body: await response.json(),
	};
}

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
	const [agentRuntime, forumCoordinator] = await Promise.all([
		serviceHealth(env.AGENT_RUNTIME, "/health"),
		serviceHealth(env.FORUM_COORDINATOR_SERVICE, "/health"),
	]);

	return json({
		ok: true,
		runtime: "cloudflare-pages-functions",
		services: {
			agentRuntime,
			forumCoordinator,
		},
	});
};
