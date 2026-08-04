import { ok, readJsonBody } from "@bickr/shared/api";
import { parseAccountMutationResult } from "@bickr/shared/account-mutation-protocol";
import {
	createSession,
	listUserAuthIdentities,
	RepositoryError,
	userProfile,
	type ProviderUserProfile,
} from "@bickr/shared/repository";
import { type UserDocument } from "@bickr/shared/model";
import { asRecord, parseUpdateUserProfileInput, requiredText } from "@bickr/shared/validation";
import {
	appendSetCookie,
	cookieHeader,
	sessionCookieName,
	type AppEnv,
} from "../_auth";
import { pageErrorResponse } from "../_errors";
import { testAuthFailureResponse } from "./_test-auth";
import { fetchServiceJson, serviceRequest } from "../_proxy";

export const onRequestPost: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const authFailure = await testAuthFailureResponse(env, request);
		if (authFailure) {
			return authFailure;
		}

		const input = asRecord(await readJsonBody(request));
		const profile = testProviderProfile(input);
		const user = await bootstrapTestAccount(env, request, profile);
		const completedProfile =
			input.profileComplete === false ? userProfile(user, await listUserAuthIdentities(env.BICKR_D1, user.id))
			: await updateTestProfile(
					env,
					request,
					user,
					parseUpdateUserProfileInput({
						handle: input.handle ?? user.handle,
						language: input.language ?? user.language ?? "en",
						displayName: input.displayName ?? user.displayName.text,
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

async function bootstrapTestAccount(
	env: AppEnv,
	request: Request,
	profile: ProviderUserProfile,
): Promise<UserDocument> {
	const { response, payload } = await fetchServiceJson(
		env.AGENT_RUNTIME,
		serviceRequest(env, request, "/accounts/bootstrap", "bootstrap", JSON.stringify(profile)),
	);
	return serviceUser(response, payload);
}

async function updateTestProfile(
	env: AppEnv,
	request: Request,
	user: UserDocument,
	input: ReturnType<typeof parseUpdateUserProfileInput>,
): Promise<ReturnType<typeof userProfile>> {
	const { response, payload } = await fetchServiceJson(
		env.AGENT_RUNTIME,
		serviceRequest(
			env,
			new Request(request.url, {
				method: "PATCH",
				headers: request.headers,
				signal: request.signal,
			}),
			`/users/${encodeURIComponent(user.id)}/profile`,
			user.id,
			JSON.stringify(input),
		),
	);
	const result = parseAccountMutationResult(serviceData(response, payload));
	switch (result.kind) {
		case "profile_updated":
			return result.profile;
		case "account_bootstrapped":
		case "provider_identity_linked":
		case "provider_identity_unlinked":
			throw new RepositoryError("server_error", "Account coordinator returned the wrong profile mutation result.", 500);
	}
}

function serviceUser(response: Response, payload: unknown): UserDocument {
	const result = parseAccountMutationResult(serviceData(response, payload));
	switch (result.kind) {
		case "account_bootstrapped":
			return result.user;
		case "profile_updated":
		case "provider_identity_linked":
		case "provider_identity_unlinked":
			throw new RepositoryError("server_error", "Account coordinator returned the wrong bootstrap result.", 500);
	}
}

function serviceData(response: Response, payload: unknown): Record<string, unknown> {
	const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
	if (!response.ok || record.ok === false) {
		const code = typeof record.error === "string" && ["bad_request", "conflict", "forbidden", "not_found", "server_error", "unauthorized"].includes(record.error)
			? record.error as RepositoryError["code"]
			: "server_error";
		throw new RepositoryError(code, typeof record.message === "string" ? record.message : "Account coordinator request failed.", response.status || 500);
	}
	return record.data && typeof record.data === "object" && !Array.isArray(record.data)
		? record.data as Record<string, unknown>
		: {};
}

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
