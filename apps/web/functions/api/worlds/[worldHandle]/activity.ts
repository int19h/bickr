import { ok } from "@bickr/shared/api";
import { worldByHandle } from "@bickr/shared/repository";
import { worldActivityFeedByHandle } from "@bickr/shared/social";
import { normalizeHandleParam } from "@bickr/shared/validation";
import { type AppEnv } from "../../_auth";
import { pageErrorResponse } from "../../_errors";
import { boundedLimit } from "../../_query";

export const onRequestGet: PagesFunction<AppEnv, "worldHandle"> = async ({ env, params, request }) => {
	try {
		const worldHandle = normalizeHandleParam(params.worldHandle, "World handle");
		const world = await worldByHandle(env.BICKR_D1, worldHandle);
		const url = new URL(request.url);
		const limit = boundedLimit(url.searchParams.get("limit"));
		return ok({
			feed: await worldActivityFeedByHandle(env.BICKR_D1, world.id, world.handle, limit),
		});
	} catch (error) {
		return pageErrorResponse(error);
	}
};
