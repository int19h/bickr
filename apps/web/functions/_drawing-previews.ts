import { drawingPreviewRendererVersion } from "@bickr/shared/content-limits";
import { markdownDrawings, markdownMedia, type MarkdownMedia } from "@bickr/shared/markdown";
import { localizedTextString, type CommentDocument } from "@bickr/shared/model";
import { addInternalServiceAuthHeader, internalServiceUrl } from "@bickr/shared/internal-service";
import { RepositoryError } from "@bickr/shared/repository";
import { readThread } from "@bickr/shared/social";
import { encodeDrawingSnapshot } from "../src/markdown/drawing-snapshot-protocol";
import type { AppEnv } from "./api/_auth";
import { botAvatarUrl } from "./_bot-avatar";

/**
 * Link previews of posts and comments show their first image or drawing. A
 * drawing becomes a PNG through Browser Run in the forum coordinator.
 *
 * Results live only in the Cloudflare cache, under a key made of the renderer
 * version and the hash of the drawing. The cache evicts entries by itself, so
 * this store needs no retention rule. It is per data center and not tiered, so
 * a drawing renders once in each location that asks for it, and again after an
 * eviction; the render limits in the coordinator bound that cost. An edit that changes a drawing changes
 * its key; one that does not reuses the image. A drawing that did not draw
 * gets a short-lived failure entry, so a broken drawing does not spend browser
 * time on every request, and its card falls back to the author's avatar.
 */
const renderedMaxAgeSeconds = 30 * 24 * 60 * 60;
const failedMaxAgeSeconds = 6 * 60 * 60;
// The explicit kind of a cache entry: a rendered PNG, or a recorded failure.
const entryKindHeader = "x-bickr-drawing-preview";

export function drawingPreviewPath(commentId: string, index: number): string {
	return `/api/drawings/${encodeURIComponent(commentId)}/${index}.png`;
}

const drawingNames = { svg: "SVG drawing", mermaid: "Mermaid diagram" } as const;

export type PreviewImage = { kind: "drawing" | "image"; imageUrl: string; imageAlt: string };

/** The preview image of a comment: its first image or drawing, if any. */
export function commentPreviewImage(comment: CommentDocument): PreviewImage | null {
	for (const media of markdownMedia(localizedTextString(comment.body))) {
		const image = mediaPreviewImage(comment, media);
		if (image) return image;
	}
	return null;
}

/** The preview image of one drawing of a comment, for a viewer link. */
export function drawingPreviewImage(comment: CommentDocument, index: number): PreviewImage | null {
	const drawing = markdownDrawings(localizedTextString(comment.body))[index];
	return drawing ? mediaPreviewImage(comment, drawing) : null;
}

function mediaPreviewImage(comment: CommentDocument, media: MarkdownMedia): PreviewImage | null {
	if (media.kind === "drawing") {
		return { kind: "drawing", imageUrl: drawingPreviewPath(comment.id, media.index), imageAlt: `${drawingNames[media.language]} by u/${comment.authorHandle}` };
	}
	// Only absolute https images can be a card image. A crawler fetches it, not
	// a reader, so the click-to-load rule of the page does not apply.
	try {
		const url = new URL(media.url);
		return url.protocol === "https:" ? { kind: "image", imageUrl: url.toString(), imageAlt: media.alt || `Image by u/${comment.authorHandle}` } : null;
	} catch {
		return null;
	}
}

/** A live comment of a live thread, or a 404. */
async function liveComment(env: AppEnv, commentId: string): Promise<CommentDocument> {
	const row = await env.BICKR_D1
		.prepare(
			`SELECT c.thread_id AS threadId
			 FROM comments_index c
			 JOIN threads_index t ON t.thread_id = c.thread_id
			 WHERE c.comment_id = ? AND c.deleted_at IS NULL AND t.deleted_at IS NULL
			 LIMIT 1`,
		)
		.bind(commentId)
		.first<{ threadId: string }>();
	if (!row) throw new RepositoryError("not_found", "Comment not found.", 404);
	const thread = await readThread(env.BICKR_KV, row.threadId);
	const comment = thread.deletedAt ? undefined : thread.comments.find((item) => item.id === commentId && !item.deletedAt);
	if (!comment) throw new RepositoryError("not_found", "Comment not found.", 404);
	return comment;
}

/**
 * The public origin of this environment. The snapshot page is loaded from
 * here, not from the request: an old deployment that Pages still serves at
 * its own URL must not render with its old snapshot page into the shared
 * cache.
 */
function publicOrigin(env: AppEnv): string {
	const origin = env.BICKR_PUBLIC_ORIGIN;
	if (!origin) throw new RepositoryError("server_error", "Drawing previews are not configured.", 503);
	return origin;
}

async function cacheKey(origin: string, drawing: { language: string; source: string }): Promise<Request> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([drawing.language, drawing.source])));
	const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return new Request(`${origin}/api/drawings/cache/v${drawingPreviewRendererVersion}/${hash}.png`);
}

function pngResponse(body: BodyInit): Response {
	return new Response(body, {
		headers: { "cache-control": "public, max-age=3600", "content-type": "image/png", "x-content-type-options": "nosniff" },
	});
}

/** A drawing without a preview: the card shows the author's avatar instead. */
async function fallbackResponse(env: AppEnv, comment: CommentDocument): Promise<Response> {
	const avatar = await botAvatarUrl(env.BICKR_D1, comment.authorBotId);
	return avatar ?
		new Response(null, { status: 302, headers: { location: avatar, "cache-control": "public, max-age=3600" } })
	:	new Response("No preview.", { status: 404, headers: { "cache-control": "public, max-age=3600" } });
}

type RenderOutcome = { kind: "rendered"; png: ArrayBuffer } | { kind: "rate_limited" } | { kind: "not_rendered" };

async function render(env: AppEnv, origin: string, comment: CommentDocument, drawing: { language: "svg" | "mermaid"; source: string }): Promise<RenderOutcome> {
	const headers = new Headers({ "content-type": "application/json" });
	addInternalServiceAuthHeader(headers, env.INTERNAL_SERVICE_SECRET);
	const response = await env.FORUM_COORDINATOR_SERVICE.fetch(new Request(internalServiceUrl("/drawing-previews/render"), {
		method: "POST",
		headers,
		body: JSON.stringify({ origin, fragment: encodeDrawingSnapshot(drawing), authorBotId: comment.authorBotId }),
	}));
	if (response.ok && response.headers.get("content-type") === "image/png") return { kind: "rendered", png: await response.arrayBuffer() };
	// The coordinator names its failures with `kind`; anything else is a
	// failure of the service itself.
	const body: unknown = await response.json().catch(() => null);
	const kind = body && typeof body === "object" ? (body as { kind?: unknown }).kind : undefined;
	if (kind === "rate_limited" || kind === "not_rendered") return { kind };
	throw new RepositoryError("server_error", "The drawing preview could not be rendered.", 502);
}

export async function drawingPreviewResponse(env: AppEnv, waitUntil: (promise: Promise<unknown>) => void, commentId: string, index: number): Promise<Response> {
	const comment = await liveComment(env, commentId);
	const drawing = markdownDrawings(localizedTextString(comment.body))[index];
	if (!drawing) throw new RepositoryError("not_found", "Drawing not found.", 404);
	const origin = publicOrigin(env);
	const key = await cacheKey(origin, drawing);
	const cache = caches.default;
	const cached = await cache.match(key);
	if (cached?.headers.get(entryKindHeader) === "rendered") return pngResponse(cached.body ?? "");
	if (cached?.headers.get(entryKindHeader) === "failed") {
		await cached.body?.cancel();
		return fallbackResponse(env, comment);
	}
	const outcome = await render(env, origin, comment, drawing);
	switch (outcome.kind) {
		case "rendered":
			waitUntil(cache.put(key, new Response(outcome.png, {
				headers: { "cache-control": `public, max-age=${renderedMaxAgeSeconds}`, "content-type": "image/png", [entryKindHeader]: "rendered" },
			})));
			return pngResponse(outcome.png);
		case "not_rendered":
			waitUntil(cache.put(key, new Response("", {
				headers: { "cache-control": `public, max-age=${failedMaxAgeSeconds}`, [entryKindHeader]: "failed" },
			})));
			return fallbackResponse(env, comment);
		case "rate_limited":
			return new Response("Try again later.", { status: 503, headers: { "retry-after": "60" } });
	}
}
