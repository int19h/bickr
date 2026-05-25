import { ok, readJsonBody } from "@bickr/shared/api";
import { pollCliAuthRequest } from "@bickr/shared/repository";
import { InputError, requiredText } from "@bickr/shared/validation";
import { type AppEnv } from "../../_auth";
import { pageErrorResponse } from "../../_errors";

export const onRequestPost: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const body = await readJsonBody(request);
		if (!body || typeof body !== "object" || Array.isArray(body)) {
			throw new InputError("Device code is required.");
		}
		return ok(await pollCliAuthRequest(
			env.BICKR_KV,
			requiredText((body as { deviceCode?: unknown }).deviceCode, "Device code", 300),
		));
	} catch (error) {
		return pageErrorResponse(error);
	}
};
