import { ok } from "@bickr/shared/api";
import { type AppEnv, sessionPayload } from "./_auth";

export const onRequestGet: PagesFunction<AppEnv> = async ({ env, request }) => {
	return ok(await sessionPayload(env, request));
};
