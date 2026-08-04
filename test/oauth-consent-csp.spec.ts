import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
	consentCspPolicy,
	cspDirectiveOrder,
	ordinaryCspPolicy,
	serializeCspPolicy,
} from "../apps/web/functions/_csp";
import {
	contentSecurityPolicy,
	onRequest as pagesMiddleware,
} from "../apps/web/functions/_middleware";
import {
	onRequestGet as authorizeGet,
	onRequestPost as authorizePost,
} from "../apps/web/functions/oauth/authorize";
import type { PagesSecurityData } from "../apps/web/functions/oauth/_consent-csp";
import {
	exchangeMcpAuthorizationCode,
	redirectUriCspSource,
	registerMcpClient,
	type McpAuthorizationCodeDocument,
} from "../packages/shared/src/mcp-auth";
import { sha256Hex } from "../packages/shared/src/ids";
import { kvKeys } from "../packages/shared/src/storage";
import {
	authCookie,
	contextFor,
	createSession,
	sessionCookieName,
	testEnv,
	upsertProviderUser,
	type AppEnv,
} from "./helpers/index-harness";

const ordinaryPolicy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net; img-src 'self' data: blob: https:; connect-src 'self' wss:; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
const codeVerifier = "correct-horse-battery-staple-correct-horse-battery-staple";
const defaultCodeChallenge = "test-code-challenge";
const authorizationCodePrefix = "v1:mcp-authorization-code:";

type OAuthRoute = PagesFunction<AppEnv, never, PagesSecurityData>;

let infoSpy: MockInstance<typeof console.info>;

beforeEach(() => {
	infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("MCP OAuth redirect URI CSP sources", () => {
	it.each([
		["https://client.example/callback", "https://client.example"],
		["https://client.example:8443/callback", "https://client.example:8443"],
		["http://localhost:5050/callback", "http://localhost:5050"],
		["http://127.0.0.1:8123/callback", "http://127.0.0.1:8123"],
		["https://user:password@client.example/a;b,c?next=/ignored", "https://client.example"],
		["https://пример.рф/callback", "https://xn--e1afmkfd.xn--p1ai"],
	])("serializes %s to the origin-only source %s", (redirectUri, expected) => {
		expect(redirectUriCspSource(redirectUri)).toBe(expected);
	});

	it.each([
		"not a URL",
		"http://client.example/callback",
		"https://client.example/callback#fragment",
		"http://[::1]:8123/callback",
		"https://[2001:db8::1]/callback",
		"custom-scheme://callback",
	])("rejects a redirect URI that CSP cannot safely express: %s", (redirectUri) => {
		expect(redirectUriCspSource(redirectUri)).toBeNull();
	});

	it("uses the same source predicate when registering clients", async () => {
		const client = await registerMcpClient(testEnv.BICKR_KV, {
			redirectUris: ["https://client.example/callback", "http://127.0.0.1:49152/callback"],
		});
		expect(client.redirectUris).toEqual([
			"https://client.example/callback",
			"http://127.0.0.1:49152/callback",
		]);

		await expect(registerMcpClient(testEnv.BICKR_KV, {
			redirectUris: ["http://[::1]:49152/callback"],
		})).rejects.toMatchObject({ code: "invalid_client_metadata" });
	});

	it("changes only form-action and deduplicates a same-origin callback", () => {
		const callbackSource = requiredCspSource("https://client.example/callback");
		const consentPolicy = consentCspPolicy(callbackSource, "https://bickr.social");
		for (const directive of cspDirectiveOrder) {
			if (directive === "form-action") {
				expect(consentPolicy[directive]).toEqual(["'self'", callbackSource]);
			} else {
				expect(consentPolicy[directive]).toEqual(ordinaryCspPolicy[directive]);
			}
		}
		expect(serializeCspPolicy(consentPolicy)).toBe(consentPolicyString(callbackSource));

		const sameOriginSource = requiredCspSource("https://bickr.social/oauth/callback");
		expect(consentCspPolicy(sameOriginSource, "https://bickr.social")["form-action"]).toEqual(["'self'"]);
		expect(contentSecurityPolicy).toBe(ordinaryPolicy);
	});
});

describe("MCP OAuth consent route CSP", () => {
	it("applies the exact specialized policy to an authenticated HTTPS consent page", async () => {
		const client = await registerClient(["https://client.example/oauth/callback"]);
		const response = await routeThroughMiddleware(
			authorizeGet,
			authorizationRequest(client.id, client.redirectUris[0], { cookie: await authCookie() }),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-security-policy")).toBe(consentPolicyString("https://client.example"));
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.text()).toContain("<form method=\"post\">");
		expect(eventLog("mcp_oauth_consent_outcome")).toEqual({
			event: "mcp_oauth_consent_outcome",
			outcome: "consent",
			clientId: client.id,
			callbackOrigin: "https://client.example",
		});
		expect(eventLog("mcp_oauth_consent_csp_applied")).toEqual({
			event: "mcp_oauth_consent_csp_applied",
			callbackOrigin: "https://client.example",
		});
	});

	it.each([
		["http://localhost:5050/callback", "http://localhost:5050"],
		["http://127.0.0.1:8123/callback", "http://127.0.0.1:8123"],
	])("includes the exact loopback port for %s", async (redirectUri, callbackSource) => {
		const client = await registerClient([redirectUri]);
		const response = await routeThroughMiddleware(
			authorizeGet,
			authorizationRequest(client.id, redirectUri, { cookie: await authCookie() }),
		);

		expect(response.headers.get("content-security-policy")).toBe(consentPolicyString(callbackSource));
	});

	it("includes only the requested origin when a client has multiple registered redirects", async () => {
		const selected = "https://selected.example/callback";
		const client = await registerClient(["https://unused.example/callback", selected]);
		const response = await routeThroughMiddleware(
			authorizeGet,
			authorizationRequest(client.id, selected, { cookie: await authCookie() }),
		);
		const policy = response.headers.get("content-security-policy");

		expect(policy).toBe(consentPolicyString("https://selected.example"));
		expect(policy).not.toContain("unused.example");
	});

	it("keeps signed-out and incomplete-profile pages on the exact ordinary policy", async () => {
		const redirectUri = "https://client.example/callback";
		const client = await registerClient([redirectUri]);
		const signedOutRequest = authorizationRequest(client.id, redirectUri);
		const signedOut = await routeThroughMiddleware(authorizeGet, signedOutRequest);
		expect(signedOut.status).toBe(200);
		expect(signedOut.headers.get("content-security-policy")).toBe(ordinaryPolicy);
		const signedOutBody = await signedOut.text();
		expect(signInReturnTos(signedOutBody)).toEqual([
			new URL(signedOutRequest.url).pathname + new URL(signedOutRequest.url).search,
			new URL(signedOutRequest.url).pathname + new URL(signedOutRequest.url).search,
		]);

		const incomplete = await routeThroughMiddleware(
			authorizeGet,
			authorizationRequest(client.id, redirectUri, { cookie: await incompleteProfileCookie() }),
		);
		expect(incomplete.status).toBe(200);
		expect(incomplete.headers.get("content-security-policy")).toBe(ordinaryPolicy);
		expect(await incomplete.text()).toContain("Complete your Bickr profile");
	});

	it("returns 400 HTML with the ordinary policy for an unknown client", async () => {
		const response = await routeThroughMiddleware(
			authorizeGet,
			authorizationRequest("missing-client", "https://client.example/callback", { cookie: await authCookie() }),
		);

		expect(response.status).toBe(400);
		expect(response.headers.get("content-security-policy")).toBe(ordinaryPolicy);
		expect(await response.text()).toContain("not registered correctly");
	});

	it("rejects exact-match near misses without widening the policy", async () => {
		const registered = "https://client.example/a/callback";
		const client = await registerClient([registered]);
		const otherClient = await registerClient(["https://other.example/callback"]);
		const cookie = await authCookie();
		const nearMisses = [
			"https://client.example/a/callback/",
			"https://client.example/a/callback-two",
			"https://client.example/a/../a/callback",
			otherClient.redirectUris[0],
		];

		for (const redirectUri of nearMisses) {
			const response = await routeThroughMiddleware(
				authorizeGet,
				authorizationRequest(client.id, redirectUri, { cookie }),
			);
			expect(response.status).toBe(400);
			expect(response.headers.get("content-security-policy")).toBe(ordinaryPolicy);
		}
	});

	it("keeps invalid authorization parameters as JSON without CSP", async () => {
		const client = await registerClient(["https://client.example/callback"]);
		const cookie = await authCookie();
		const wrongResponseType = authorizationRequest(client.id, client.redirectUris[0], {
			cookie,
			responseType: "token",
		});
		const missingChallengeUrl = new URL(authorizationRequest(client.id, client.redirectUris[0], { cookie }).url);
		missingChallengeUrl.searchParams.delete("code_challenge");
		for (const request of [wrongResponseType, new Request(missingChallengeUrl, { headers: { cookie } })]) {
			const response = await routeThroughMiddleware(authorizeGet, request);
			expect(response.status).toBe(400);
			expect(response.headers.get("content-type")).toContain("application/json");
			expect(response.headers.get("content-security-policy")).toBeNull();
		}
	});

	it("does not select the specialized policy from route shape alone", async () => {
		const syntheticHtml: OAuthRoute = async () => new Response("<!doctype html>", {
			status: 200,
			headers: {
				"content-security-policy": "form-action https://untrusted.example",
				"content-type": "text/html; charset=utf-8",
			},
		});
		for (const url of ["https://bickr.social/", "https://bickr.social/oauth/authorize"]) {
			const response = await routeThroughMiddleware(syntheticHtml, new Request(url));
			expect(response.headers.get("content-security-policy")).toBe(ordinaryPolicy);
		}
	});

	it("fails closed when middleware and route do not share the same data object", async () => {
		const redirectUri = "https://client.example/callback";
		const client = await registerClient([redirectUri]);
		const response = await routeThroughMiddleware(
			authorizeGet,
			authorizationRequest(client.id, redirectUri, { cookie: await authCookie() }),
			{ shareData: false },
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-security-policy")).toBe(ordinaryPolicy);
	});
});

describe("MCP OAuth consent POST", () => {
	it("posts the rendered fields, preserves callback query and opaque state, and correlates issue/redeem logs", async () => {
		const redirectUri = "https://client.example/callback?existing=kept";
		const originalState = "opaque &=+ space \" ✓";
		const challenge = await pkceS256(codeVerifier);
		const client = await registerClient([redirectUri]);
		const cookie = await authCookie();
		const getResponse = await routeThroughMiddleware(
			authorizeGet,
			authorizationRequest(client.id, redirectUri, {
				cookie,
				codeChallenge: challenge,
				state: originalState,
			}),
		);
		const renderedFields = hiddenFormFields(await getResponse.text());
		expect(renderedFields.get("state")).toBe(originalState);
		infoSpy.mockClear();

		const postResponse = await routeThroughMiddleware(
			authorizePost,
			new Request("https://bickr.social/oauth/authorize", {
				method: "POST",
				headers: { cookie },
				body: renderedFields,
			}),
		);

		expect(postResponse.status).toBe(302);
		expect(postResponse.headers.get("cache-control")).toBe("no-store");
		expect(postResponse.headers.get("content-security-policy")).toBeNull();
		const location = new URL(requiredHeader(postResponse, "location"));
		expect(location.origin + location.pathname).toBe("https://client.example/callback");
		expect(location.searchParams.get("existing")).toBe("kept");
		expect(location.searchParams.get("state")).toBe(originalState);
		const code = requiredSearchParam(location, "code");
		const codeHash = await sha256Hex(code);
		const document = await testEnv.BICKR_KV.get<McpAuthorizationCodeDocument>(
			kvKeys.mcpAuthorizationCode(codeHash),
			{ type: "json" },
		);
		expect(document).toMatchObject({
			clientId: client.id,
			redirectUri,
			codeChallenge: challenge,
			codeChallengeMethod: "S256",
		});
		expect(Date.parse(document?.expiresAt ?? "") - Date.parse(document?.createdAt ?? "")).toBe(10 * 60 * 1_000);
		const storedKey = (await testEnv.BICKR_KV.list({
			prefix: kvKeys.mcpAuthorizationCode(codeHash),
		})).keys[0];
		expect(storedKey?.expiration).toBeTypeOf("number");
		const storageTtlMs = (storedKey?.expiration ?? 0) * 1_000 - Date.parse(document?.createdAt ?? "");
		expect(storageTtlMs).toBeGreaterThanOrEqual(599_000);
		expect(storageTtlMs).toBeLessThanOrEqual(600_000);

		const issuedLog = eventLog("mcp_oauth_authorization_code_issued");
		expect(issuedLog).toEqual({
			event: "mcp_oauth_authorization_code_issued",
			codeDocumentId: document?.id,
			clientId: client.id,
		});
		expect(JSON.stringify(issuedLog)).not.toContain(code);
		expect(JSON.stringify(issuedLog)).not.toContain(redirectUri);
		expect(JSON.stringify(issuedLog)).not.toContain(originalState);

		await exchangeMcpAuthorizationCode(testEnv.BICKR_KV, {
			code,
			clientId: client.id,
			redirectUri,
			codeVerifier,
			resource: "https://bickr.social/mcp",
		});
		expect(eventLog("mcp_oauth_authorization_code_redeemed")).toEqual({
			event: "mcp_oauth_authorization_code_redeemed",
			codeDocumentId: document?.id,
			clientId: client.id,
		});
	});

	it("omits state when the rendered request did not contain it", async () => {
		const redirectUri = "https://client.example/callback";
		const client = await registerClient([redirectUri]);
		const cookie = await authCookie();
		const getResponse = await routeThroughMiddleware(
			authorizeGet,
			authorizationRequest(client.id, redirectUri, { cookie }),
		);
		const renderedFields = hiddenFormFields(await getResponse.text());
		expect(renderedFields.has("state")).toBe(false);

		const postResponse = await routeThroughMiddleware(
			authorizePost,
			new Request("https://bickr.social/oauth/authorize", {
				method: "POST",
				headers: { cookie },
				body: renderedFields,
			}),
		);
		expect(new URL(requiredHeader(postResponse, "location")).searchParams.has("state")).toBe(false);
	});

	it("revalidates POST parameters and writes no code for rejected requests", async () => {
		const client = await registerClient(["https://client.example/callback"]);
		const cookie = await authCookie();
		const rejected = [
			{ clientId: client.id, redirectUri: "https://client.example/other", method: "S256", status: 400 },
			{ clientId: client.id, redirectUri: client.redirectUris[0], method: "plain", status: 400 },
			{ clientId: "missing-client", redirectUri: client.redirectUris[0], method: "S256", status: 401 },
		];

		for (const testCase of rejected) {
			const form = authorizationForm(testCase.clientId, testCase.redirectUri);
			form.set("code_challenge_method", testCase.method);
			const response = await routeThroughMiddleware(
				authorizePost,
				new Request("https://bickr.social/oauth/authorize", {
					method: "POST",
					headers: { cookie },
					body: form,
				}),
			);
			expect(response.status).toBe(testCase.status);
			expect(response.headers.get("location")).toBeNull();
			expect(response.headers.get("content-security-policy")).toBeNull();
			expect((await response.json<{ error: string }>()).error).not.toBe("server_error");
			expect(await authorizationCodeKeys()).toEqual([]);
		}
	});
});

async function routeThroughMiddleware(
	route: OAuthRoute,
	request: Request,
	options: { shareData?: boolean } = {},
): Promise<Response> {
	const middlewareData: PagesSecurityData = {};
	const routeData = options.shareData === false ? {} : middlewareData;
	const envOverrides: Partial<AppEnv> = {
		BICKR_ENVIRONMENT: "production",
		TEST_ENTRY_MODE: "disabled",
	};
	const routeContext = contextFor<OAuthRoute>(request, {}, envOverrides);
	routeContext.data = routeData;
	const middlewareContext = contextFor<typeof pagesMiddleware>(request, {}, envOverrides);
	middlewareContext.data = middlewareData;
	middlewareContext.next = async () => {
		const routeResponse = await route(routeContext);
		// Cloudflare Pages clones a route response before returning it through
		// next(), while retaining the same per-request data object.
		return new Response(routeResponse.body, routeResponse);
	};
	return pagesMiddleware(middlewareContext);
}

function authorizationRequest(
	clientId: string,
	redirectUri: string,
	options: {
		cookie?: string;
		codeChallenge?: string;
		responseType?: string;
		state?: string;
	} = {},
): Request {
	const url = new URL("https://bickr.social/oauth/authorize");
	url.search = authorizationForm(clientId, redirectUri, options).toString();
	const headers = new Headers();
	if (options.cookie) {
		headers.set("cookie", options.cookie);
	}
	return new Request(url, { headers });
}

function authorizationForm(
	clientId: string,
	redirectUri: string,
	options: { codeChallenge?: string; responseType?: string; state?: string } = {},
): URLSearchParams {
	const params = new URLSearchParams({
		response_type: options.responseType ?? "code",
		client_id: clientId,
		redirect_uri: redirectUri,
		resource: "https://bickr.social/mcp",
		scope: "bickr.read bickr.runtime",
		code_challenge: options.codeChallenge ?? defaultCodeChallenge,
		code_challenge_method: "S256",
	});
	if (options.state !== undefined) {
		params.set("state", options.state);
	}
	return params;
}

async function registerClient(redirectUris: string[]) {
	return registerMcpClient(testEnv.BICKR_KV, {
		clientName: "CSP test client",
		redirectUris,
	});
}

async function incompleteProfileCookie(): Promise<string> {
	const user = await upsertProviderUser(testEnv.BICKR_KV, testEnv.BICKR_D1, {
		provider: "github",
		subject: "incomplete-csp-user",
		login: "incomplete-csp-user",
		displayName: "Incomplete CSP User",
	});
	// Provider creation assigns a handle but deliberately leaves the profile
	// incomplete until the user saves the profile form.
	const updated = await testEnv.BICKR_KV.get<{ profileCompletedAt: string | null }>(kvKeys.user(user.id), { type: "json" });
	if (updated?.profileCompletedAt) {
		throw new Error("Test setup unexpectedly completed the profile.");
	}
	const session = await createSession(testEnv.BICKR_KV, user.id);
	return `${sessionCookieName}=${encodeURIComponent(session.cookieValue)}`;
}

function hiddenFormFields(html: string): URLSearchParams {
	const fields = new URLSearchParams();
	for (const match of html.matchAll(/<input name="([^"]+)" type="hidden" value="([^"]*)" \/>/g)) {
		fields.set(decodeHtml(match[1]), decodeHtml(match[2]));
	}
	return fields;
}

function signInReturnTos(html: string): string[] {
	return [...html.matchAll(/href="([^"]*\/api\/auth\/(?:github|google)\/start[^"]*)"/g)]
		.map((match) => new URL(decodeHtml(match[1]), "https://bickr.social").searchParams.get("returnTo") ?? "");
}

function decodeHtml(value: string): string {
	return value
		.replaceAll("&quot;", "\"")
		.replaceAll("&gt;", ">")
		.replaceAll("&lt;", "<")
		.replaceAll("&amp;", "&");
}

function requiredCspSource(redirectUri: string) {
	const source = redirectUriCspSource(redirectUri);
	if (!source) {
		throw new Error(`Expected a valid CSP source for ${redirectUri}`);
	}
	return source;
}

function consentPolicyString(callbackSource: string): string {
	return ordinaryPolicy.replace("form-action 'self'", `form-action 'self' ${callbackSource}`);
}

function requiredHeader(response: Response, name: string): string {
	const value = response.headers.get(name);
	if (!value) {
		throw new Error(`Missing ${name} response header.`);
	}
	return value;
}

function requiredSearchParam(url: URL, name: string): string {
	const value = url.searchParams.get(name);
	if (!value) {
		throw new Error(`Missing ${name} URL parameter.`);
	}
	return value;
}

function eventLog(event: string): Record<string, unknown> | undefined {
	return infoSpy.mock.calls
		.map(([entry]) => entry)
		.find((entry): entry is Record<string, unknown> =>
			typeof entry === "object" && entry !== null && "event" in entry && entry.event === event
		);
}

async function authorizationCodeKeys(): Promise<string[]> {
	return (await testEnv.BICKR_KV.list({ prefix: authorizationCodePrefix })).keys.map((key) => key.name);
}

async function pkceS256(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	let binary = "";
	for (const byte of new Uint8Array(digest)) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
