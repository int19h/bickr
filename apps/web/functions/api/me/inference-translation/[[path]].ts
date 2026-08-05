import { type AppEnv, requireCompleteUser } from "../../_auth";
import { pageErrorResponse } from "../../_errors";
import { serviceRequest } from "../../_proxy";

export const onRequest: PagesFunction<AppEnv> = async ({ env, request, params }) => {
	try {
		const user = await requireCompleteUser(env, request);
		const rawPath = params.path;
		const path = Array.isArray(rawPath) ? rawPath.join("/") : typeof rawPath === "string" ? rawPath : "";
		if (!path || path.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
			return Response.json({ ok: false, error: "not_found", message: "Translation inference route not found." }, { status: 404 });
		}
		const suffix = path.split("/").map(encodeURIComponent).join("/");
		return env.AGENT_RUNTIME.fetch(serviceRequest(
			env,
			request,
			`/users/${encodeURIComponent(user.id)}/inference-translation/${suffix}${new URL(request.url).search}`,
			user.id,
		));
	} catch (error) {
		return pageErrorResponse(error);
	}
};
