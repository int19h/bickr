import { ok, readJsonBody } from "@bickr/shared/api";
import { type HumanNotificationReadScope } from "@bickr/shared/model";
import { humanNotificationReadCutoff, markAllHumanNotificationsRead } from "@bickr/shared/social";
import { InputError } from "@bickr/shared/validation";
import { requireCompleteUser, type AppEnv } from "../../_auth";
import { pageErrorResponse } from "../../_errors";

export const onRequestPost: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const user = await requireCompleteUser(env, request);
		const body = await optionalJsonBody(request);
		const now = new Date().toISOString();
		// One gesture fans out into several scoped calls; the client sends the same
		// cutoff for all of them so a notification arriving mid-sweep stays unread.
		const asOf = humanNotificationReadCutoff(readCutoffValue(body), now);
		const readCount = await markAllHumanNotificationsRead(env.BICKR_D1, user.id, parseReadScope(body), now, asOf);
		return ok({ readAll: true, readCount });
	} catch (error) {
		return pageErrorResponse(error);
	}
};

async function optionalJsonBody(request: Request): Promise<unknown> {
	const contentType = request.headers.get("content-type") ?? "";
	return contentType.includes("application/json") ? readJsonBody(request) : undefined;
}

function readCutoffValue(value: unknown): unknown {
	return value && typeof value === "object" ? (value as Record<string, unknown>).asOf : undefined;
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
