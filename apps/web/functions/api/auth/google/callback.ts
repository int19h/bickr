import * as oauth from "oauth4webapi";
import { RepositoryError, type ProviderUserProfile } from "@bickr/shared/repository";
import { type AppEnv } from "../../_auth";
import {
	completeProviderSession,
	expectedOAuthNonce,
	expectedOAuthState,
	oauthCodeVerifier,
	oauthErrorRedirect,
	oauthFetch,
	oauthReturnTo,
	oauthSuccessRedirect,
} from "../_oauth";
import {
	googleAuthorizationServer,
	googleClient,
	googleClientAuth,
	googleRedirectUri,
} from "./_google";

export const onRequestGet: PagesFunction<AppEnv> = async ({ env, request }) => {
	const provider = "google";
	const returnTo = await oauthReturnTo(env, request, provider);
	try {
		const expectedState = expectedOAuthState(request, provider);
		if (!expectedState) {
			return oauthErrorRedirect(request, provider, "missing_state", returnTo);
		}
		const codeVerifier = oauthCodeVerifier(request, provider);
		if (!codeVerifier) {
			return oauthErrorRedirect(request, provider, "missing_verifier", returnTo);
		}
		const expectedNonce = expectedOAuthNonce(request, provider);
		if (!expectedNonce) {
			return oauthErrorRedirect(request, provider, "missing_nonce", returnTo);
		}

		const authorizationServer = await googleAuthorizationServer(env);
		const client = googleClient(env);
		const callbackParameters = oauth.validateAuthResponse(
			authorizationServer,
			client,
			new URL(request.url),
			expectedState,
		);
		const fetchImpl = oauthFetch(env);
		const tokenResponse = await oauth.authorizationCodeGrantRequest(
			authorizationServer,
			client,
			googleClientAuth(env),
			callbackParameters,
			googleRedirectUri(env, request),
			codeVerifier,
			{ [oauth.customFetch]: fetchImpl },
		);
		const token = await oauth.processAuthorizationCodeResponse(authorizationServer, client, tokenResponse, {
			expectedNonce,
			requireIdToken: true,
		});
		if (typeof token.access_token !== "string") {
			return oauthErrorRedirect(request, provider, "missing_token", returnTo);
		}

		const claims = oauth.getValidatedIdTokenClaims(token);
		if (!claims?.sub) {
			return oauthErrorRedirect(request, provider, "missing_subject", returnTo);
		}
		const userInfoResponse = await oauth.userInfoRequest(authorizationServer, client, token.access_token, {
			[oauth.customFetch]: fetchImpl,
		});
		const userInfo = await oauth.processUserInfoResponse(
			authorizationServer,
			client,
			claims.sub,
			userInfoResponse,
		);
		const profile = parseGoogleProfile(claims, userInfo);
		const result = await completeProviderSession(env, request, profile);
		return oauthSuccessRedirect(request, provider, returnTo, result.sessionCookieValue);
	} catch (error) {
		console.error("google oauth callback failed", error);
		return oauthErrorRedirect(request, provider, oauthErrorCode(error), returnTo);
	}
};

function parseGoogleProfile(claims: oauth.IDToken, userInfo: oauth.UserInfoResponse): ProviderUserProfile {
	const email = userInfo.email ?? stringClaim(claims.email);
	const displayName = userInfo.name ?? stringClaim(claims.name) ?? email ?? claims.sub;
	const avatarUrl = userInfo.picture ?? stringClaim(claims.picture);
	return {
		provider: "google",
		subject: claims.sub,
		login: email ?? claims.sub,
		displayName,
		...(email ? { email } : {}),
		...(avatarUrl ? { avatarUrl } : {}),
	};
}

function stringClaim(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function oauthErrorCode(error: unknown): string {
	return error instanceof RepositoryError && error.code === "conflict" ? "identity_conflict" : "oauth_failed";
}
