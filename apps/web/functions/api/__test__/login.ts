import { ok, readJsonBody } from "@bickr/shared/api";
import {
	createSession,
	listUserAuthIdentities,
	upsertProviderUser,
	updateUserProfile,
	userProfile,
	type ProviderUserProfile,
} from "@bickr/shared/repository";
import { asRecord, parseUpdateUserProfileInput, requiredText } from "@bickr/shared/validation";
import {
	appendSetCookie,
	cookieHeader,
	sessionCookieName,
	type AppEnv,
} from "../_auth";
import { pageErrorResponse } from "../_errors";
import { testAuthFailureResponse } from "./_test-auth";

export const onRequestPost: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const authFailure = await testAuthFailureResponse(env, request);
		if (authFailure) {
			return authFailure;
		}

		const input = asRecord(await readJsonBody(request));
		const profile = testProviderProfile(input);
		const user = await upsertProviderUser(env.BICKR_KV, env.BICKR_D1, profile);
		const completedProfile =
			input.profileComplete === false ? userProfile(user, await listUserAuthIdentities(env.BICKR_D1, user.id))
			: await updateUserProfile(
					env.BICKR_KV,
					env.BICKR_D1,
					user.id,
					parseUpdateUserProfileInput({
						handle: input.handle ?? user.handle,
						displayName: input.displayName ?? user.displayName,
						...(input.avatarUrl !== undefined ? { avatarUrl: input.avatarUrl } : {}),
						...(input.inferenceSettings !== undefined ?
							{ inferenceSettings: input.inferenceSettings }
						:	{}),
					}),
				);
		const session = await createSession(env.BICKR_KV, user.id);

		return appendSetCookie(
			ok({ profile: completedProfile }, { status: 201 }),
			cookieHeader(request, sessionCookieName, session.cookieValue, { maxAge: 60 * 60 * 24 * 30 }),
		);
	} catch (error) {
		return pageErrorResponse(error);
	}
};

function testProviderProfile(input: Record<string, unknown>): ProviderUserProfile {
	const login = requiredText(input.login ?? input.handle, "Login", 80);
	return {
		provider: "github",
		subject: requiredText(input.subject ?? `test:${login}`, "Subject", 160),
		login,
		displayName:
			input.displayName === undefined ? login : requiredText(input.displayName, "Display name", 80),
		...(typeof input.email === "string" && input.email.trim() ? { email: input.email.trim() } : {}),
		...(typeof input.avatarUrl === "string" && input.avatarUrl.trim() ?
			{ avatarUrl: input.avatarUrl.trim() }
		:	{}),
	};
}
