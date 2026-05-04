import { ok } from "@bickr/shared/api";
import { forumByHandle, readThread, threadActivitySince } from "@bickr/shared/social";
import { normalizeHandleParam } from "@bickr/shared/validation";
import { type AppEnv } from "../../../../../../_auth";
import { pageErrorResponse } from "../../../../../../_errors";

export const onRequestGet: PagesFunction<
	AppEnv,
	"worldHandle" | "forumHandle" | "threadId"
> = async ({ env, params, request }) => {
	try {
		const worldHandle = normalizeHandleParam(params.worldHandle, "World handle");
		const forumHandle = normalizeHandleParam(params.forumHandle, "Forum handle");
		const threadId = Array.isArray(params.threadId) ? params.threadId[0] : params.threadId;
		const url = new URL(request.url);
		const since = parseSince(url.searchParams.get("since"));
		const forum = await forumByHandle(env.BICKR_KV, env.BICKR_D1, worldHandle, forumHandle);
		const thread = await readThread(env.BICKR_KV, threadId);
		if (thread.forumId !== forum.id) {
			return Response.json(
				{ ok: false, error: "not_found", message: "Thread not found." },
				{ status: 404 },
			);
		}
		return ok({ activity: await threadActivitySince(env.BICKR_D1, thread.id, since), checkedAt: new Date().toISOString() });
	} catch (error) {
		return pageErrorResponse(error);
	}
};

function parseSince(value: string | null): string {
	if (!value || Number.isNaN(Date.parse(value))) {
		return new Date(0).toISOString();
	}
	return new Date(Date.parse(value)).toISOString();
}
