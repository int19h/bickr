import { type AppEnv, requireCompleteUser } from "../../_auth";
import { pageErrorResponse } from "../../_errors";
import { serviceRequest } from "../../_proxy";

export const onRequest: PagesFunction<AppEnv, "path"> = async ({ env, request, params }) => {
	try {
		const user = await requireCompleteUser(env, request);
		const path = Array.isArray(params.path) ? params.path : params.path ? [params.path] : [];
		const suffix = path.map((part) => encodeURIComponent(part)).join("/");
		const url = new URL(request.url);
		const servicePath = `/users/${encodeURIComponent(user.id)}/inference-configurations${suffix ? `/${suffix}` : ""}${url.search}`;
		const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
		return env.AGENT_RUNTIME.fetch(serviceRequest(env, request, servicePath, user.id, body));
	} catch (error) {
		return pageErrorResponse(error);
	}
};
