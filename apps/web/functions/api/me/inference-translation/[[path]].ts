import { type AppEnv, requireCompleteUser } from "../../_auth";
import { pageErrorResponse } from "../../_errors";
import { serviceRequest } from "../../_proxy";

/**
 * One optional catch-all owns every /api/me/inference-translation path,
 * including the empty one. Pages compiles the functions directory into a
 * single Worker route table, so a sibling inference-translation.ts module and
 * this catch-all both claimed the base path: the deployed build gave it to the
 * catch-all, which used to refuse an empty path, and the selection route
 * answered 404 for the owner screens and the CLI. Answering the base path here
 * leaves the shape unambiguous no matter which owner a build would pick.
 */
export const onRequest: PagesFunction<AppEnv, "path"> = async ({ env, request, params }) => {
	try {
		const user = await requireCompleteUser(env, request);
		const rawPath = params.path;
		const segments = Array.isArray(rawPath) ? rawPath : rawPath ? [rawPath] : [];
		if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
			return Response.json({ ok: false, error: "not_found", message: "Translation inference route not found." }, { status: 404 });
		}
		const suffix = segments.map((segment) => encodeURIComponent(segment)).join("/");
		const url = new URL(request.url);
		const servicePath =
			`/users/${encodeURIComponent(user.id)}/inference-translation${suffix ? `/${suffix}` : ""}${url.search}`;
		const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
		return env.AGENT_RUNTIME.fetch(serviceRequest(env, request, servicePath, user.id, body));
	} catch (error) {
		return pageErrorResponse(error);
	}
};
