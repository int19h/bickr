import { json } from "@bickr/shared/http";
import { addInternalServiceAuthHeader, internalServiceUrl } from "@bickr/shared/internal-service";
import { type AppEnv } from "../_auth";
import { fetchServiceJson } from "../_proxy";

async function serviceHealth(service: Fetcher, env: Pick<AppEnv, "INTERNAL_SERVICE_SECRET">, path: string): Promise<unknown> {
	const headers = new Headers();
	addInternalServiceAuthHeader(headers, env.INTERNAL_SERVICE_SECRET);
	const { response, payload } = await fetchServiceJson(service, new Request(internalServiceUrl(path), { headers }));

	return {
		ok: response.ok,
		status: response.status,
		body: payload,
	};
}

export const onRequestGet: PagesFunction<AppEnv> = async ({ env }) => {
	const [agentRuntime, forumCoordinator] = await Promise.all([
		serviceHealth(env.AGENT_RUNTIME, env, "/health"),
		serviceHealth(env.FORUM_COORDINATOR_SERVICE, env, "/health"),
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
