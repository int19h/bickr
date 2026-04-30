import { ok } from "@bickr/shared/api";
import { listHumanNotifications } from "@bickr/shared/social";
import { requireUser, type AppEnv } from "../_auth";
import { pageErrorResponse } from "../_errors";

export const onRequestGet: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const user = await requireUser(env, request);
		const url = new URL(request.url);
		const status = url.searchParams.get("status") === "all" ? "all" : "unread";
		const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? 30) || 30));
		const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
		return ok(await listHumanNotifications(env.BICKR_D1, user.id, status, limit, offset));
	} catch (error) {
		return pageErrorResponse(error);
	}
};
