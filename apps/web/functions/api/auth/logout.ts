import { ok } from "@bickr/shared/api";
import { deleteSession } from "@bickr/shared/repository";
import {
	appendSetCookie,
	clearCookieHeader,
	cookieValue,
	sessionCookieName,
	type AppEnv,
} from "../_auth";

export const onRequestPost: PagesFunction<AppEnv> = async ({ env, request }) => {
	await deleteSession(env.BICKR_KV, cookieValue(request, sessionCookieName));
	return appendSetCookie(
		ok({ authenticated: false, user: null }),
		clearCookieHeader(request, sessionCookieName),
	);
};
