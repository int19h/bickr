import { InputError } from "@bickr/shared/validation";
import { RepositoryError } from "@bickr/shared/repository";

/**
 * Renders one drawing to a 1200x630 PNG for a link preview card. Browser Run
 * opens the static snapshot page of the app, which reads the drawing from its
 * URL fragment and draws it with the same SVG policy and Mermaid settings as a
 * post. That page has no network or same-origin access, so the browser runs
 * nothing that a reader of the post would not run.
 *
 * The caller passes its own origin and the encoded drawing. Only the Pages
 * app calls this route, through the authenticated internal service binding.
 */
export type DrawingPreviewInput = { origin: string; fragment: string };

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

export async function renderDrawingPreview(browser: BrowserRun | undefined, input: DrawingPreviewInput): Promise<Response> {
	if (!browser) throw new RepositoryError("server_error", "Drawing previews are not configured.", 503);
	const response = await browser.quickAction("screenshot", {
		url: `${input.origin}/drawing-snapshot#${input.fragment}`,
		viewport: { width: 1200, height: 630 },
		// The page loads only its own script; nothing else may load.
		allowRequestPattern: [`^${escapeRegExp(input.origin)}/`],
		gotoOptions: { waitUntil: "load", timeout: 15_000 },
		// The page marks the root when it has drawn, or failed to draw.
		waitForSelector: { selector: "html[data-snapshot]", timeout: 15_000 },
		screenshotOptions: { type: "png" },
	});
	if (!response.ok) {
		await response.body?.cancel();
		console.error(JSON.stringify({ event: "drawing_preview_failed", status: response.status }));
		throw new RepositoryError("server_error", "The drawing preview could not be rendered.", 502);
	}
	return new Response(response.body, { headers: { "content-type": "image/png" } });
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
