import { ok } from "@bickr/shared/api";
import { type HumanNotificationListScope } from "@bickr/shared/model";
import { listHumanNotifications } from "@bickr/shared/social";
import { InputError } from "@bickr/shared/validation";
import { requireUser, type AppEnv } from "../_auth";
import { pageErrorResponse } from "../_errors";

export const onRequestGet: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const user = await requireUser(env, request);
		const url = new URL(request.url);
		const status = url.searchParams.get("status") === "all" ? "all" : "unread";
		const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? 30) || 30));
		const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
		const scope = parseListScope(url.searchParams);
		return ok(await listHumanNotifications(env.BICKR_D1, user.id, status, limit, offset, scope));
	} catch (error) {
		return pageErrorResponse(error);
	}
};

function parseListScope(params: URLSearchParams): HumanNotificationListScope {
	const scopeType = params.get("scopeType");
	if (scopeType === null || scopeType === "" || scopeType === "all") {
		return { scopeType: "all" };
	}
	if (scopeType === "world" || scopeType === "bot") {
		const scopeId = params.get("scopeId")?.trim() ?? "";
		if (!scopeId) {
			throw new InputError("Notification list scope is incomplete.");
		}
		return { scopeType, scopeId };
	}
	throw new InputError("Notification list scope is invalid.");
}
