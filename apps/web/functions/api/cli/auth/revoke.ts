import { fail, ok } from "@bickr/shared/api";
import { deleteCliToken } from "@bickr/shared/repository";
import { currentAuth, type AppEnv } from "../../_auth";
import { pageErrorResponse } from "../../_errors";

export const onRequestPost: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const auth = await currentAuth(env, request);
		if (!auth) {
			return fail("unauthorized", "Authentication is required.", 401);
		}
		if (auth.kind !== "bearer") {
			return fail("bad_request", "Current request is not authenticated with a CLI token.", 400);
		}
		await deleteCliToken(env.BICKR_KV, auth.token);
		return ok({ revoked: true });
	} catch (error) {
		return pageErrorResponse(error);
	}
};
