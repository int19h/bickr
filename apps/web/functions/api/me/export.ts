import { type AppEnv, requireUser } from "../_auth";
import { pageErrorResponse } from "../_errors";
import { serviceRequest } from "../_proxy";
import { RepositoryError } from "@bickr/shared/repository";
import { parseAccountExportSection } from "@bickr/shared/account-export-repository";

export const onRequestGet: PagesFunction<AppEnv> = async ({ env, request }) => {
	let response: Response;
	try {
		const user = await requireUser(env, request);
		const params = new URL(request.url).searchParams;
		// Every page binds the browser's original account, even if its cookie changes mid-export.
		if (params.get("ownerUserId") !== user.id) throw new RepositoryError("conflict", "The signed-in account changed. Please restart the export.", 409);
		const section = parseAccountExportSection(params.get("section"));
		const query = new URLSearchParams({ section });
		const cursor = params.get("cursor");
		if (cursor) {
			if (cursor.length > 4096) throw new RepositoryError("bad_request", "Invalid export cursor.", 400);
			query.set("cursor", cursor);
		}
		const botId = params.get("botId");
		const path = section === "notes" && botId
			? `/bots/${encodeURIComponent(botId)}/notes/export${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`
			: `/users/${encodeURIComponent(user.id)}/export?${query}`;
		response = await env.AGENT_RUNTIME.fetch(serviceRequest(env, request, path, user.id));
	} catch (error) {
		response = pageErrorResponse(error);
	}
	const headers = new Headers(response.headers);
	headers.set("Cache-Control", "private, no-store");
	headers.set("Vary", "Cookie, Authorization");
	headers.set("X-Content-Type-Options", "nosniff");
	return new Response(response.body, { status: response.status, headers });
};
