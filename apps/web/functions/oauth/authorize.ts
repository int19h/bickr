import {
	createMcpAuthorizationCode,
	mcpScopeString,
	normalizeMcpScopes,
	readMcpClient,
	redirectUriCspSource,
	type McpScope,
	type RedirectUriCspSource,
} from "@bickr/shared/mcp-auth";
import { InputError } from "@bickr/shared/validation";
import { currentUser, requireCompleteUser, type AppEnv } from "../api/_auth";
import {
	markConsentPagePolicy,
	type PagesSecurityData,
} from "./_consent-csp";
import { oauthErrorResponse } from "./register";

export const onRequestGet: PagesFunction<AppEnv, never, PagesSecurityData> = async (context) => {
	const { env, request } = context;
	try {
		const params = authorizationParams(new URL(request.url).searchParams, request);
		const client = await readMcpClient(env.BICKR_KV, params.clientId);
		if (!client) {
			return authorizePageResponse(context, { kind: "unknown_client", clientId: params.clientId });
		}
		const registeredRedirectUri = client.redirectUris.find((uri) => uri === params.redirectUri);
		if (!registeredRedirectUri) {
			return authorizePageResponse(context, { kind: "unregistered_redirect", clientId: client.id });
		}
		const user = await currentUser(env, request);
		if (!user) {
			return authorizePageResponse(context, {
				kind: "sign_in",
				clientId: client.id,
				clientName: client.clientName,
			});
		}
		if (!user.profileCompletedAt) {
			return authorizePageResponse(context, { kind: "incomplete_profile", clientId: client.id });
		}
		const callbackSource = redirectUriCspSource(registeredRedirectUri);
		if (!callbackSource) {
			// New registrations cannot reach this branch. Fail closed if stored data
			// is ever corrupted or predates the shared registration invariant.
			console.error({
				event: "mcp_oauth_registered_redirect_not_csp_compatible",
				clientId: client.id,
			});
			return authorizePageResponse(context, { kind: "invalid_registered_redirect", clientId: client.id });
		}
		return authorizePageResponse(context, {
			kind: "consent",
			clientId: client.id,
			clientName: client.clientName,
			userHandle: user.handle,
			params,
			callbackSource,
		});
	} catch (error) {
		console.info({ event: "mcp_oauth_consent_outcome", outcome: "error" });
		return oauthErrorResponse(error);
	}
};

export const onRequestPost: PagesFunction<AppEnv, never, PagesSecurityData> = async ({ env, request }) => {
	try {
		const user = await requireCompleteUser(env, request);
		const form = await request.formData();
		const params = authorizationParams(formParams(form), request);
		const issued = await createMcpAuthorizationCode(env.BICKR_KV, {
			clientId: params.clientId,
			redirectUri: params.redirectUri,
			resource: params.resource,
			userId: user.id,
			scopes: params.scopes,
			codeChallenge: params.codeChallenge,
			codeChallengeMethod: params.codeChallengeMethod,
		});
		const redirect = new URL(params.redirectUri);
		redirect.searchParams.set("code", issued.code);
		if (params.state !== undefined) {
			redirect.searchParams.set("state", params.state);
		}
		return new Response(null, {
			status: 302,
			headers: {
				location: redirect.toString(),
				"cache-control": "no-store",
			},
		});
	} catch (error) {
		return oauthErrorResponse(error);
	}
};

type AuthorizationParams = {
	clientId: string;
	redirectUri: string;
	resource: string;
	scopes: McpScope[];
	codeChallenge: string;
	codeChallengeMethod: string;
	state?: string;
};

type AuthorizePage =
	| { kind: "unknown_client"; clientId: string }
	| { kind: "unregistered_redirect"; clientId: string }
	| { kind: "invalid_registered_redirect"; clientId: string }
	| { kind: "sign_in"; clientId: string; clientName: string }
	| { kind: "incomplete_profile"; clientId: string }
	| {
		kind: "consent";
		clientId: string;
		clientName: string;
		userHandle: string;
		params: AuthorizationParams;
		callbackSource: RedirectUriCspSource;
	};

function authorizePageResponse(
	context: Parameters<typeof onRequestGet>[0],
	page: AuthorizePage,
): Response {
	logAuthorizePageOutcome(page);
	switch (page.kind) {
		case "unknown_client":
		case "unregistered_redirect":
		case "invalid_registered_redirect":
			return htmlPage(
				"Bickr MCP Authorization",
				"<p>This MCP client is not registered correctly.</p>",
				400,
			);
		case "sign_in":
			return htmlPage("Bickr MCP Authorization", `
				<p>Sign in to authorize <strong>${escapeHtml(page.clientName)}</strong> for Bickr.</p>
				<p class="actions">
					<a class="button" href="${escapeHtml(oauthStartUrl(context.request, "github"))}">Sign in with GitHub</a>
					<a class="button secondary" href="${escapeHtml(oauthStartUrl(context.request, "google"))}">Sign in with Google</a>
				</p>
			`);
		case "incomplete_profile":
			return htmlPage("Bickr MCP Authorization", `
				<p>Complete your Bickr profile before authorizing this MCP client.</p>
				<p class="actions"><a class="button" href="/me/profile">Complete profile</a></p>
			`);
		case "consent":
			markConsentPagePolicy(context.data, page.callbackSource);
			return htmlPage("Authorize Bickr MCP", consentForm(page.clientName, page.userHandle, page.params));
	}
}

function logAuthorizePageOutcome(page: AuthorizePage): void {
	if (page.kind === "consent") {
		console.info({
			event: "mcp_oauth_consent_outcome",
			outcome: page.kind,
			clientId: page.clientId,
			callbackOrigin: page.callbackSource,
		});
		return;
	}
	console.info({
		event: "mcp_oauth_consent_outcome",
		outcome: page.kind,
		clientId: page.clientId,
	});
}

function authorizationParams(params: URLSearchParams, request: Request): AuthorizationParams {
	if (params.get("response_type") !== "code") {
		throw new InputError("MCP authorization requires response_type=code.");
	}
	const clientId = requiredParam(params, "client_id");
	const redirectUri = requiredParam(params, "redirect_uri");
	const resource = params.get("resource")?.trim() || new URL("/mcp", request.url).toString();
	const codeChallenge = requiredParam(params, "code_challenge");
	const codeChallengeMethod = requiredParam(params, "code_challenge_method");
	const state = params.has("state") ? params.get("state") ?? "" : undefined;
	return {
		clientId,
		redirectUri,
		resource,
		scopes: normalizeMcpScopes(params.get("scope")),
		codeChallenge,
		codeChallengeMethod,
		...(state !== undefined ? { state } : {}),
	};
}

function consentForm(clientName: string, userHandle: string, params: AuthorizationParams): string {
	const fields: Record<string, string> = {
		response_type: "code",
		client_id: params.clientId,
		redirect_uri: params.redirectUri,
		resource: params.resource,
		scope: mcpScopeString(params.scopes),
		code_challenge: params.codeChallenge,
		code_challenge_method: params.codeChallengeMethod,
		...(params.state !== undefined ? { state: params.state } : {}),
	};
	return `
		<p>Authorize <strong>${escapeHtml(clientName)}</strong> to use Bickr as <strong>hu/${escapeHtml(userHandle)}</strong>?</p>
		<ul>${params.scopes.map((scope) => `<li>${escapeHtml(scopeDescription(scope))}</li>`).join("")}</ul>
		<form method="post">
			${Object.entries(fields).map(([name, value]) => `<input name="${escapeHtml(name)}" type="hidden" value="${escapeHtml(value)}" />`).join("")}
			<button type="submit">Authorize MCP Client</button>
		</form>
	`;
}

function scopeDescription(scope: McpScope): string {
	switch (scope) {
		case "bickr.read":
			return "Read Bickr profile, world, forum, thread, bot, search, export, notification, subscription, and runtime data.";
		case "bickr.write":
			return "Create, update, and delete Bickr worlds, forums, bots, groups, notifications, and subscriptions.";
		case "bickr.runtime":
			return "Run Bickr bot runtime actions such as tick, stop, compact, and inject.";
	}
}

function oauthStartUrl(request: Request, provider: "github" | "google"): string {
	const current = new URL(request.url);
	const returnTo = `${current.pathname}${current.search}`;
	const url = new URL(`/api/auth/${provider}/start`, request.url);
	url.searchParams.set("returnTo", returnTo);
	return `${url.pathname}${url.search}`;
}

function formParams(form: FormData): URLSearchParams {
	const params = new URLSearchParams();
	for (const [name, value] of form.entries()) {
		if (typeof value === "string") {
			params.set(name, value);
		}
	}
	return params;
}

function requiredParam(params: URLSearchParams, name: string): string {
	const value = params.get(name)?.trim();
	if (!value) {
		throw new InputError(`${name} is required.`);
	}
	return value;
}

function htmlPage(title: string, body: string, status = 200): Response {
	return new Response(`<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>${escapeHtml(title)}</title>
	<style>
		body { color: #111827; font: 16px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; margin: 0; padding: 3rem 1.25rem; }
		main { margin: 0 auto; max-width: 38rem; }
		h1 { font-size: 1.5rem; margin: 0 0 1rem; }
		.actions { display: flex; flex-wrap: wrap; gap: .75rem; }
		a.button, button { background: #111827; border: 0; border-radius: .4rem; color: white; cursor: pointer; display: inline-block; font: inherit; padding: .65rem .9rem; text-decoration: none; }
		a.secondary { background: #4b5563; }
		li { margin: .35rem 0; }
	</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1>${body}</main></body>
</html>`, {
		status,
		headers: {
			"cache-control": "no-store",
			"content-type": "text/html; charset=utf-8",
		},
	});
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}
