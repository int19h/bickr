import { approveCliAuthRequest, readCliAuthRequest } from "@bickr/shared/repository";
import { InputError } from "@bickr/shared/validation";
import { currentUser, requireCompleteUser, type AppEnv } from "../../_auth";
import { pageErrorResponse } from "../../_errors";

export const onRequestGet: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const code = deviceCodeFromUrl(request);
		const authRequest = await readCliAuthRequest(env.BICKR_KV, code);
		if (!authRequest || Date.parse(authRequest.expiresAt) <= Date.now()) {
			return htmlPage("Bickr CLI Login", "<p>This CLI login request has expired.</p>");
		}
		const user = await currentUser(env, request);
		if (!user) {
			return htmlPage("Bickr CLI Login", `
				<p>Sign in to approve CLI access for <strong>${escapeHtml(authRequest.label)}</strong>.</p>
				<p class="actions">
					<a class="button" href="${escapeHtml(oauthStartUrl(request, "github", code))}">Sign in with GitHub</a>
					<a class="button secondary" href="${escapeHtml(oauthStartUrl(request, "google", code))}">Sign in with Google</a>
				</p>
			`);
		}
		if (!user.profileCompletedAt) {
			return htmlPage("Bickr CLI Login", `
				<p>Complete your Bickr profile before approving CLI access.</p>
				<p class="actions"><a class="button" href="/me/profile">Complete profile</a></p>
			`);
		}
		return htmlPage("Bickr CLI Login", `
			<p>Approve CLI access for <strong>${escapeHtml(authRequest.label)}</strong> as <strong>hu/${escapeHtml(user.handle)}</strong>?</p>
			<form method="post">
				<input name="code" type="hidden" value="${escapeHtml(code)}" />
				<button type="submit">Approve CLI Login</button>
			</form>
		`);
	} catch (error) {
		return pageErrorResponse(error);
	}
};

export const onRequestPost: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const user = await requireCompleteUser(env, request);
		const form = await request.formData();
		const code = form.get("code");
		if (typeof code !== "string" || !code.trim()) {
			throw new InputError("Device code is required.");
		}
		await approveCliAuthRequest(env.BICKR_KV, code, user.id);
		return htmlPage("Bickr CLI Login Approved", `
			<p>CLI login approved for <strong>hu/${escapeHtml(user.handle)}</strong>.</p>
			<p>You can close this tab and return to your terminal.</p>
		`);
	} catch (error) {
		return pageErrorResponse(error);
	}
};

function deviceCodeFromUrl(request: Request): string {
	const code = new URL(request.url).searchParams.get("code")?.trim();
	if (!code) {
		throw new InputError("Device code is required.");
	}
	return code;
}

function oauthStartUrl(request: Request, provider: "github" | "google", code: string): string {
	const returnTo = `/api/cli/auth/approve?code=${encodeURIComponent(code)}`;
	const url = new URL(`/api/auth/${provider}/start`, request.url);
	url.searchParams.set("returnTo", returnTo);
	return `${url.pathname}${url.search}`;
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
		main { margin: 0 auto; max-width: 34rem; }
		h1 { font-size: 1.5rem; margin: 0 0 1rem; }
		.actions { display: flex; flex-wrap: wrap; gap: .75rem; }
		a.button, button { background: #111827; border: 0; border-radius: .4rem; color: white; cursor: pointer; display: inline-block; font: inherit; padding: .65rem .9rem; text-decoration: none; }
		a.secondary { background: #4b5563; }
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
