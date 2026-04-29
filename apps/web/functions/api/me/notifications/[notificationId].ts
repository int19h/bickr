import { ok, readJsonBody } from "@bickr/shared/api";
import { archiveHumanNotification, markHumanNotificationRead } from "@bickr/shared/social";
import { requireCompleteUser, type AppEnv } from "../../_auth";
import { pageErrorResponse } from "../../_errors";

export const onRequestPatch: PagesFunction<AppEnv, "notificationId"> = async ({
	env,
	request,
	params,
}) => {
	try {
		const user = await requireCompleteUser(env, request);
		const notificationId = Array.isArray(params.notificationId) ? params.notificationId[0] : params.notificationId;
		const body = await readJsonBody(request);
		const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
		if (record.archive === true) {
			await archiveHumanNotification(env.BICKR_D1, user.id, notificationId);
		} else {
			await markHumanNotificationRead(env.BICKR_D1, user.id, notificationId, record.read !== false);
		}
		return ok({ notificationId });
	} catch (error) {
		return pageErrorResponse(error);
	}
};
