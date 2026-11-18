import { RepositoryError } from "@bickr/shared/repository";
import { InputError } from "@bickr/shared/validation";

/**
 * Renders one drawing to a 1200x630 PNG for a link preview card. Browser Run
 * opens the static snapshot page of the app, which reads the drawing from its
 * URL fragment and draws it with the same SVG policy and Mermaid settings as a
 * post. That page has no network or same-origin access, and Browser Run may
 * load nothing outside the app origin.
 *
 * The caller passes the public origin of its environment and the encoded
 * drawing. Only the Pages app calls this route, through the authenticated
 * internal service binding.
 */
export type DrawingPreviewInput = { origin: string; fragment: string; authorBotId: string };

/**
 * A render that did not produce an image. `rate_limited`: the render budget
 * or Browser Run refused it, so a later request can succeed. `not_rendered`:
 * the drawing did not draw, for example because its source is invalid.
 */
export type DrawingPreviewFailure = { kind: "rate_limited" } | { kind: "not_rendered" };

type DrawingPreviewEnv = { BROWSER?: BrowserRun; DRAWING_PREVIEW_LIMITER?: RateLimit; DRAWING_PREVIEW_AUTHOR_LIMITER?: RateLimit };

// A drawing source is at most 64 KiB, so its base64url JSON stays below this.
const maxFragmentLength = 200_000;

export function parseDrawingPreviewInput(body: unknown): DrawingPreviewInput {
	if (!body || typeof body !== "object" || Array.isArray(body)) throw new InputError("Drawing preview input must be an object.");
	const { origin, fragment, authorBotId } = body as Record<string, unknown>;
	if (typeof origin !== "string" || typeof fragment !== "string" || typeof authorBotId !== "string") throw new InputError("Drawing preview input needs an origin, a fragment, and an author.");
	if (!/^[A-Za-z0-9_-]{1,80}$/.test(authorBotId)) throw new InputError("Drawing preview author is not valid.");
	let parsed: URL;
	try {
		parsed = new URL(origin);
	} catch {
		throw new InputError("Drawing preview origin is not a URL.");
	}
	if (parsed.protocol !== "https:" || parsed.origin !== origin) throw new InputError("Drawing preview origin must be an https origin.");
	if (!/^[A-Za-z0-9_-]+$/.test(fragment) || fragment.length > maxFragmentLength) throw new InputError("Drawing preview fragment is not valid.");
	return { origin, fragment, authorBotId };
}

function failure(status: number, body: DrawingPreviewFailure): Response {
	return Response.json(body, { status });
}

export async function renderDrawingPreview(env: DrawingPreviewEnv, input: DrawingPreviewInput): Promise<Response> {
	if (!env.BROWSER || !env.DRAWING_PREVIEW_LIMITER || !env.DRAWING_PREVIEW_AUTHOR_LIMITER) {
		console.error(JSON.stringify({ event: "drawing_preview_unconfigured" }));
		throw new RepositoryError("server_error", "Drawing previews are not configured.", 503);
	}
	// Anyone can request a preview, and a post can hold many drawings, so the
	// limiters bound the browser time that requests can spend. The author limit
	// comes first, so the drawings of one author cannot spend the budget of
	// everyone else. Both limits are per Cloudflare location and approximate;
	// see wrangler.jsonc.
	if (!(await env.DRAWING_PREVIEW_AUTHOR_LIMITER.limit({ key: `author:${input.authorBotId}` })).success) return failure(429, { kind: "rate_limited" });
	if (!(await env.DRAWING_PREVIEW_LIMITER.limit({ key: "render" })).success) return failure(429, { kind: "rate_limited" });
	const response = await env.BROWSER.quickAction("screenshot", {
		url: `${input.origin}/drawing-snapshot#${input.fragment}`,
		viewport: { width: 1200, height: 630 },
		// The page loads only its own script; nothing else may load.
		allowRequestPattern: [`^${escapeRegExp(input.origin)}/`],
		gotoOptions: { waitUntil: "load", timeout: 10_000 },
		// The page marks the root "ready" only after it drew the drawing. A
		// drawing that fails marks "error" instead, so the wait times out and
		// the action fails rather than returning a blank card.
		waitForSelector: { selector: 'html[data-snapshot="ready"]', timeout: 10_000 },
		screenshotOptions: { type: "png" },
	});
	if (response.ok && response.headers.get("content-type")?.startsWith("image/png")) {
		return new Response(response.body, { headers: { "content-type": "image/png" } });
	}
	await response.body?.cancel();
	// Browser Run answers 422 when the page could not complete the action: here,
	// the drawing did not draw within the wait. 429 is its own limit. Every
	// other answer is a failure of the service or of this request, which must
	// not be remembered as a broken drawing.
	switch (response.status) {
		case 422:
			console.warn(JSON.stringify({ event: "drawing_preview_not_rendered" }));
			return failure(422, { kind: "not_rendered" });
		case 429:
			return failure(429, { kind: "rate_limited" });
		default:
			console.error(JSON.stringify({ event: "drawing_preview_service_failed", status: response.status, contentType: response.headers.get("content-type") }));
			throw new RepositoryError("server_error", "Browser Run could not render the drawing preview.", 502);
	}
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
