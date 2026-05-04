import { ok } from "@bickr/shared/api";
import { worldByHandle } from "@bickr/shared/repository";
import { botActivityFeedByHandle } from "@bickr/shared/social";
import { normalizeHandleParam } from "@bickr/shared/validation";
import { type AppEnv } from "../../../../_auth";
import { pageErrorResponse } from "../../../../_errors";

export const onRequestGet: PagesFunction<AppEnv, "worldHandle" | "botHandle"> = async ({ env, params, request }) => {
	try {
		const worldHandle = normalizeHandleParam(params.worldHandle, "World handle");
		const botHandle = normalizeHandleParam(params.botHandle, "Bot handle");
		const world = await worldByHandle(env.BICKR_D1, worldHandle);
		const url = new URL(request.url);
		const limit = boundedLimit(url.searchParams.get("limit"));
		return ok({
			feed: await botActivityFeedByHandle(env.BICKR_KV, env.BICKR_D1, world.id, botHandle, limit),
		});
	} catch (error) {
		return pageErrorResponse(error);
	}
};

function boundedLimit(value: string | null): number {
	const parsed = Number(value ?? 30);
	if (!Number.isFinite(parsed)) {
		return 30;
	}
	return Math.min(100, Math.max(1, Math.floor(parsed)));
}
