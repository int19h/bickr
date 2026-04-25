import { ok } from "@bickr/shared/api";
import { listUserBots } from "@bickr/shared/repository";
import { type AppEnv, requireUser } from "../_auth";
import { pageErrorResponse } from "../_errors";

export const onRequestGet: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const user = await requireUser(env, request);
		return ok({ bots: await listUserBots(env.BICKR_KV, env.BICKR_D1, user.id) });
	} catch (error) {
		return pageErrorResponse(error);
	}
};
