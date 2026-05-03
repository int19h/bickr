import { ok } from "@bickr/shared/api";
import { worldByHandle } from "@bickr/shared/repository";
import { botFollowGraphByHandle } from "@bickr/shared/social";
import { normalizeHandle } from "@bickr/shared/validation";
import { type AppEnv } from "../../../../_auth";
import { pageErrorResponse } from "../../../../_errors";

export const onRequestGet: PagesFunction<AppEnv, "worldHandle" | "botHandle"> = async ({ env, params }) => {
	try {
		const worldHandle = normalizeHandle(params.worldHandle);
		const botHandle = normalizeHandle(params.botHandle);
		const world = await worldByHandle(env.BICKR_D1, worldHandle);
		return ok({
			graph: await botFollowGraphByHandle(env.BICKR_KV, env.BICKR_D1, world.id, botHandle),
		});
	} catch (error) {
		return pageErrorResponse(error);
	}
};
