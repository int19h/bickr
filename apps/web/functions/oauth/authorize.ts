import {
	createMcpAuthorizationCode,
	mcpScopeString,
	normalizeMcpScopes,
	readMcpClient,
	type McpScope,
} from "@bickr/shared/mcp-auth";
import { InputError } from "@bickr/shared/validation";
import { currentUser, requireCompleteUser, type AppEnv } from "../api/_auth";
import { oauthErrorResponse } from "./register";

export const onRequestGet: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const params = authorizationParams(new URL(request.url).searchParams, request);
		const client = await readMcpClient(env.BICKR_KV, params.clientId);
		if (!client || !client.redirectUris.includes(params.redirectUri)) {
			return htmlPage("Bickr MCP Authorization", "<p>This MCP client is not registered correctly.</p>");
		}
		const user = await currentUser(env, request);
		if (!user) {
			return htmlPage("Bickr MCP Authorization", `
				<p>Sign in to authorize <strong>${escapeHtml(client.clientName)}</strong> for Bickr.</p>
				<p class="actions">
					<a class="button" href="${escapeHtml(oauthStartUrl(request, "github"))}">Sign in with GitHub</a>
					<a class="button secondary" href="${escapeHtml(oauthStartUrl(request, "google"))}">Sign in with Google</a>
				</p>
			`);
		}
		if (!user.profileCompletedAt) {
			return htmlPage("Bickr MCP Authorization", `
				<p>Complete your Bickr profile before authorizing this MCP client.</p>
				<p class="actions"><a class="button" href="/me/profile">Complete profile</a></p>
			`);
		}
		return htmlPage("Authorize Bickr MCP", consentForm(client.clientName, user.handle, params));
	} catch (error) {
		return oauthErrorResponse(error);
	}
};

export const onRequestPost: PagesFunction<AppEnv> = async ({ env, request }) => {
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
		if (params.state) {
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

function authorizationParams(params: URLSearchParams, request: Request): AuthorizationParams {
	if (params.get("response_type") !== "code") {
		throw new InputError("MCP authorization requires response_type=code.");
	}
	const clientId = requiredParam(params, "client_id");
	const redirectUri = requiredParam(params, "redirect_uri");
	const resource = params.get("resource")?.trim() || new URL("/mcp", request.url).toString();
	const codeChallenge = requiredParam(params, "code_challenge");
	const codeChallengeMethod = requiredParam(params, "code_challenge_method");
	const state = params.get("state")?.trim() || undefined;
	return {
		clientId,
		redirectUri,
		resource,
		scopes: normalizeMcpScopes(params.get("scope")),
		codeChallenge,
		codeChallengeMethod,
		...(state ? { state } : {}),
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
		...(params.state ? { state: params.state } : {}),
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

function htmlPage(title: string, body: string): Response {
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
