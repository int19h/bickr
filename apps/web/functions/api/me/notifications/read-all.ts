import { ok, readJsonBody } from "@bickr/shared/api";
import { type HumanNotificationReadScope } from "@bickr/shared/model";
import { markAllHumanNotificationsRead } from "@bickr/shared/social";
import { InputError } from "@bickr/shared/validation";
import { requireCompleteUser, type AppEnv } from "../../_auth";
import { pageErrorResponse } from "../../_errors";

export const onRequestPost: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const user = await requireCompleteUser(env, request);
		const scope = parseReadScope(await optionalJsonBody(request));
		const readCount = await markAllHumanNotificationsRead(env.BICKR_D1, user.id, scope);
		return ok({ readAll: true, readCount });
	} catch (error) {
		return pageErrorResponse(error);
	}
};

async function optionalJsonBody(request: Request): Promise<unknown> {
	const contentType = request.headers.get("content-type") ?? "";
	return contentType.includes("application/json") ? readJsonBody(request) : undefined;
}

function parseReadScope(value: unknown): HumanNotificationReadScope {
	const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	const scopeType = record.scopeType;
	if (scopeType === undefined || scopeType === "all") {
		return { scopeType: "all" };
	}
	if (scopeType === "world" || scopeType === "bot") {
		const scopeId = typeof record.scopeId === "string" ? record.scopeId.trim() : "";
		if (!scopeId) {
			throw new InputError("Notification read scope is incomplete.");
		}
		return { scopeType, scopeId };
	}
	if (scopeType === "notifications") {
		const notificationIds = Array.isArray(record.notificationIds) ?
			[
				...new Set(
					record.notificationIds
						.map((id) => (typeof id === "string" ? id.trim() : ""))
						.filter(Boolean),
				),
			]
		:	[];
		if (notificationIds.length === 0) {
			throw new InputError("Notification read scope is incomplete.");
		}
		return { scopeType: "notifications", notificationIds };
	}
	throw new InputError("Notification read scope is invalid.");
}
