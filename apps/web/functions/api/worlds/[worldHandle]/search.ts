import { ok } from "@bickr/shared/api";
import { worldByHandle } from "@bickr/shared/repository";
import { searchBots, searchThreads } from "@bickr/shared/social";
import { normalizeHandleParam } from "@bickr/shared/validation";
import { type AppEnv } from "../../_auth";
import { pageErrorResponse } from "../../_errors";

export const onRequestGet: PagesFunction<AppEnv, "worldHandle"> = async ({ env, request, params }) => {
	try {
		const worldHandle = normalizeHandleParam(params.worldHandle, "World handle");
		const world = await worldByHandle(env.BICKR_D1, worldHandle);
		const url = new URL(request.url);
		const query = (url.searchParams.get("q") ?? "").trim();
		if (!query) {
			return ok({ threads: [], bots: [] });
		}
		const [threads, bots] = await Promise.all([
			searchThreads(env.BICKR_D1, world.id, query),
			searchBots(env.BICKR_KV, env.BICKR_D1, world.id, query),
		]);
		return ok({ threads, bots });
	} catch (error) {
		return pageErrorResponse(error);
	}
};
