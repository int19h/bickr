import { ok, readJsonBody } from "@bickr/shared/api";
import { buildSpotlightPreview, forumByHandle } from "@bickr/shared/social";
import { type SpotlightPreviewInput } from "@bickr/shared/model";
import { normalizeHandleParam } from "@bickr/shared/validation";
import { requireCompleteUser, type AppEnv } from "../../../../../_auth";
import { pageErrorResponse } from "../../../../../_errors";

export const onRequestPost: PagesFunction<AppEnv, "worldHandle" | "forumHandle"> = async ({
	env,
	request,
	params,
}) => {
	try {
		const user = await requireCompleteUser(env, request);
		const worldHandle = normalizeHandleParam(params.worldHandle, "World handle");
		const forumHandle = normalizeHandleParam(params.forumHandle, "Forum handle");
		const forum = await forumByHandle(env.BICKR_KV, env.BICKR_D1, worldHandle, forumHandle);
		const input = parseSpotlightInput(await readJsonBody(request));
		return ok({ preview: await buildSpotlightPreview(env.BICKR_KV, env.BICKR_D1, user.id, forum, input) });
	} catch (error) {
		return pageErrorResponse(error);
	}
};

function parseSpotlightInput(value: unknown): SpotlightPreviewInput {
	const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	const targetType = record.targetType === "comments" ? "comments" : "threads";
	return {
		targetType,
		threadIds: Array.isArray(record.threadIds) ? record.threadIds.filter(isString) : undefined,
		threadId: typeof record.threadId === "string" ? record.threadId : undefined,
		commentIds: Array.isArray(record.commentIds) ? record.commentIds.filter(isString) : undefined,
		botIds: Array.isArray(record.botIds) ? record.botIds.filter(isString) : [],
		focusText: typeof record.focusText === "string" ? record.focusText : undefined,
	};
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}
