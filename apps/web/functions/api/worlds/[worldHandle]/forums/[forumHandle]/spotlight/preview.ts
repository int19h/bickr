import { ok, readJsonBody } from "@bickr/shared/api";
import { buildSpotlightPreview, forumByHandle } from "@bickr/shared/social";
import { normalizeHandleParam } from "@bickr/shared/validation";
import { requireCompleteUser, type AppEnv } from "../../../../../_auth";
import { pageErrorResponse } from "../../../../../_errors";
import { parseSpotlightPreviewInput } from "./_input";

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
		const input = parseSpotlightPreviewInput(await readJsonBody(request));
		return ok({ preview: await buildSpotlightPreview(env.BICKR_KV, env.BICKR_D1, user.id, forum, input) });
	} catch (error) {
		return pageErrorResponse(error);
	}
};
