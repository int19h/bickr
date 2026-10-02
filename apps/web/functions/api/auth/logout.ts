import { ok } from "@bickr/shared/api";
import { deleteSession } from "@bickr/shared/repository";
import {
	currentAuth,
	appendSetCookie,
	clearCookieHeader,
	sessionCookieName,
	type AppEnv,
} from "../_auth";

export const onRequestPost: PagesFunction<AppEnv> = async ({ env, request }) => {
	const auth = await currentAuth(env, request);
	if (auth?.kind === "cookie") await deleteSession(env.BICKR_D1, auth.token);
	return appendSetCookie(
		ok({ authenticated: false, user: null }),
		clearCookieHeader(request, sessionCookieName),
	);
};
