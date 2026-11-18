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
export type DrawingPreviewInput = { origin: string; fragment: string };

/**
 * A render that did not produce an image. `rate_limited`: the render budget
 * or Browser Run refused it, so a later request can succeed. `not_rendered`:
 * the drawing did not draw, for example because its source is invalid.
 */
export type DrawingPreviewFailure = { kind: "rate_limited" } | { kind: "not_rendered" };

type DrawingPreviewEnv = { BROWSER?: BrowserRun; DRAWING_PREVIEW_LIMITER?: RateLimit };

// A drawing source is at most 64 KiB, so its base64url JSON stays below this.
const maxFragmentLength = 200_000;

export function parseDrawingPreviewInput(body: unknown): DrawingPreviewInput {
	if (!body || typeof body !== "object" || Array.isArray(body)) throw new InputError("Drawing preview input must be an object.");
	const { origin, fragment } = body as Record<string, unknown>;
	if (typeof origin !== "string" || typeof fragment !== "string") throw new InputError("Drawing preview input needs an origin and a fragment.");
	let parsed: URL;
	try {
		parsed = new URL(origin);
	} catch {
		throw new InputError("Drawing preview origin is not a URL.");
	}
	if (parsed.protocol !== "https:" || parsed.origin !== origin) throw new InputError("Drawing preview origin must be an https origin.");
	if (!/^[A-Za-z0-9_-]+$/.test(fragment) || fragment.length > maxFragmentLength) throw new InputError("Drawing preview fragment is not valid.");
	return { origin, fragment };
}

function failure(status: number, body: DrawingPreviewFailure): Response {
	return Response.json(body, { status });
}

export async function renderDrawingPreview(env: DrawingPreviewEnv, input: DrawingPreviewInput): Promise<Response> {
	if (!env.BROWSER || !env.DRAWING_PREVIEW_LIMITER) {
		console.error(JSON.stringify({ event: "drawing_preview_unconfigured" }));
		return failure(503, { kind: "rate_limited" });
	}
	// Anyone can request a preview, and a post can hold many drawings, so the
	// limiter bounds the browser time that requests can spend. The limit is
	// per Cloudflare location and approximate; see wrangler.jsonc.
	const { success } = await env.DRAWING_PREVIEW_LIMITER.limit({ key: "render" });
	if (!success) return failure(429, { kind: "rate_limited" });
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
	console.error(JSON.stringify({ event: "drawing_preview_failed", status: response.status }));
	// Browser Run reports its own limits as 429; every other failure is a
	// drawing that did not draw within the wait.
	return response.status === 429 ? failure(429, { kind: "rate_limited" }) : failure(422, { kind: "not_rendered" });
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
