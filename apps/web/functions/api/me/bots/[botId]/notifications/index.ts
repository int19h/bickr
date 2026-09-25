import { ok } from "@bickr/shared/api";
import { listOwnedBotPendingNotifications } from "@bickr/shared/social";
import { InputError } from "@bickr/shared/validation";
import { type AppEnv, requireCompleteUser } from "../../../../_auth";
import { pageErrorResponse } from "../../../../_errors";

/**
 * The owner's view of what this participant will be handed next, newest first.
 * Read-only by construction: see listOwnedBotPendingNotifications.
 */
export const onRequestGet: PagesFunction<AppEnv, "botId"> = async ({ env, request, params }) => {
	try {
		const user = await requireCompleteUser(env, request);
		const botId = Array.isArray(params.botId) ? params.botId[0] : params.botId;
		const limit = new URL(request.url).searchParams.get("limit");
		return ok(await listOwnedBotPendingNotifications(env.BICKR_KV, env.BICKR_D1, {
			ownerUserId: user.id,
			botId,
			...(limit === null ? {} : { limit: parseLimit(limit) }),
		}));
	} catch (error) {
		return pageErrorResponse(error);
	}
};

// Strict rather than clamped: an out-of-range limit is the caller's mistake, and
// the shared function reports the published bounds.
function parseLimit(value: string): number {
	if (!/^\d+$/.test(value)) {
		throw new InputError("Notification limit must be an integer.");
	}
	return Number(value);
}
