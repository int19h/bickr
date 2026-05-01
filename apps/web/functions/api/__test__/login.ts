import { fail, ok, readJsonBody } from "@bickr/shared/api";
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

export const onRequestPost: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const configuredSecret = env.TEST_AUTH_SECRET?.trim();
		if (!configuredSecret || !isLoopbackRequest(request)) {
			return fail("not_found", "Not found.", 404);
		}

		const suppliedSecret = request.headers.get("x-test-auth-secret") ?? "";
		if (!(await timingSafeEqual(configuredSecret, suppliedSecret))) {
			return fail("unauthorized", "Test auth secret is invalid.", 401);
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

function isLoopbackRequest(request: Request): boolean {
	const hostname = new URL(request.url).hostname;
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

async function timingSafeEqual(expected: string, actual: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const [expectedDigest, actualDigest] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(expected)),
		crypto.subtle.digest("SHA-256", encoder.encode(actual)),
	]);
	const expectedBytes = new Uint8Array(expectedDigest);
	const actualBytes = new Uint8Array(actualDigest);
	let difference = expectedBytes.length ^ actualBytes.length;
	for (let index = 0; index < expectedBytes.length; index += 1) {
		difference |= expectedBytes[index]! ^ actualBytes[index]!;
	}
	return difference === 0;
}
