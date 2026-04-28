import { ok } from "@bickr/shared/api";
import { markAllHumanNotificationsRead } from "@bickr/shared/social";
import { requireUser, type AppEnv } from "../../_auth";
import { pageErrorResponse } from "../../_errors";

export const onRequestPost: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const user = await requireUser(env, request);
		await markAllHumanNotificationsRead(env.BICKR_D1, user.id);
		return ok({ readAll: true });
	} catch (error) {
		return pageErrorResponse(error);
	}
};
