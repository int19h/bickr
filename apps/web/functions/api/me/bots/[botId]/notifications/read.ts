import { fail, ok, readJsonBody } from "@bickr/shared/api";
import { markOwnedBotNotificationsRead } from "@bickr/shared/social";
import { InputError } from "@bickr/shared/validation";
import { type AppEnv, requireCompleteUser } from "../../../../_auth";
import { pageErrorResponse } from "../../../../_errors";

/** Marks the named pending notifications of one owned participant read. */
export const onRequestPost: PagesFunction<AppEnv, "botId"> = async ({ env, request, params }) => {
	try {
		const user = await requireCompleteUser(env, request);
		const botId = Array.isArray(params.botId) ? params.botId[0] : params.botId;
		const outcome = await markOwnedBotNotificationsRead(env.BICKR_KV, env.BICKR_D1, {
			ownerUserId: user.id,
			botId,
			notificationIds: notificationIdsFromBody(await readJsonBody(request)),
		});
		switch (outcome.kind) {
			case "marked":
				return ok(outcome.result);
			case "rejected":
				return fail(outcome.error, outcome.message, outcome.status);
		}
	} catch (error) {
		return pageErrorResponse(error);
	}
};

function notificationIdsFromBody(body: unknown): string[] {
	const ids = body && typeof body === "object" ? (body as Record<string, unknown>).notificationIds : undefined;
	if (!Array.isArray(ids) || !ids.every((id): id is string => typeof id === "string")) {
		throw new InputError("notificationIds must be an array of strings.");
	}
	return ids.map((id) => id.trim());
}
