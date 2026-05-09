import { json } from "@bickr/shared/http";
import { fetchServiceJson } from "../_proxy";

async function serviceHealth(service: Fetcher, path: string): Promise<unknown> {
	const { response, payload } = await fetchServiceJson(service, new Request(`https://internal.bickr${path}`));

	return {
		ok: response.ok,
		status: response.status,
		body: payload,
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
