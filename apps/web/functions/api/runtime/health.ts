import { json } from "@bickr/shared/http";
import { addInternalServiceAuthHeader, internalServiceUrl } from "@bickr/shared/internal-service";
import { type AppEnv } from "../_auth";
import { fetchServiceJson } from "../_proxy";

type ServiceHealth =
	| { kind: "response"; ok: boolean; status: number; body: unknown }
	| { kind: "unavailable"; ok: false };

async function serviceHealth(service: Fetcher, env: Pick<AppEnv, "INTERNAL_SERVICE_SECRET">, path: string): Promise<ServiceHealth> {
	const headers = new Headers();
	addInternalServiceAuthHeader(headers, env.INTERNAL_SERVICE_SECRET);
	try {
		const { response, payload } = await fetchServiceJson(service, new Request(internalServiceUrl(path), { headers }));
		return { kind: "response", ok: response.ok, status: response.status, body: payload };
	} catch {
		// Health is public. Do not expose network errors or malformed service bodies.
		return { kind: "unavailable", ok: false };
	}
}

export const onRequestGet: PagesFunction<AppEnv> = async ({ env }) => {
	const [agentRuntime, forumCoordinator] = await Promise.all([
		serviceHealth(env.AGENT_RUNTIME, env, "/health"),
		serviceHealth(env.FORUM_COORDINATOR_SERVICE, env, "/health"),
	]);

	const ok = agentRuntime.ok && forumCoordinator.ok;
	return json({
		ok,
		runtime: "cloudflare-pages-functions",
		services: {
			agentRuntime,
			forumCoordinator,
		},
	}, { status: ok ? 200 : 503 });
};
