import { markdownDrawings, markdownMedia, type MarkdownMedia } from "@bickr/shared/markdown";
import { localizedTextString, type CommentDocument } from "@bickr/shared/model";
import { addInternalServiceAuthHeader, internalServiceUrl } from "@bickr/shared/internal-service";
import { RepositoryError } from "@bickr/shared/repository";
import { readThread } from "@bickr/shared/social";
import { encodeDrawingSnapshot } from "../src/markdown/drawing-snapshot-protocol";
import { drawingPreviewObjectPrefix } from "@bickr/shared/content-limits";
import type { AppEnv } from "./api/_auth";

/**
 * Link previews of posts and comments show their first image or drawing. A
 * drawing becomes a PNG through Browser Run, once per distinct source: the
 * PNG is stored in R2 under the hash of the drawing, so an edit that changes
 * the drawing gets a new image, and one that does not reuses the old one.
 *
 * Retention: the preview prefix of the bucket has an R2 lifecycle rule that
 * deletes objects 30 days after upload, and the avatar janitor skips it. A
 * preview that a crawler asks for later is rendered again. See docs/markdown.md.
 */
const previewPrefix = `${drawingPreviewObjectPrefix}v1/`;

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
	// Only absolute web images can be a card image. A crawler fetches it, not a
	// reader, so the click-to-load rule of the page does not apply.
	if (!/^https?:\/\//i.test(media.url)) return null;
	try {
		return { kind: "image", imageUrl: new URL(media.url).toString(), imageAlt: media.alt || `Image by u/${comment.authorHandle}` };
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

async function previewKey(language: string, source: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([language, source])));
	return previewPrefix + [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("") + ".png";
}

function pngResponse(body: ReadableStream | ArrayBuffer): Response {
	return new Response(body, {
		headers: {
			"cache-control": "public, max-age=3600",
			"content-type": "image/png",
			"x-content-type-options": "nosniff",
		},
	});
}

export async function drawingPreviewResponse(env: AppEnv, request: Request, commentId: string, index: number): Promise<Response> {
	const comment = await liveComment(env, commentId);
	const drawing = markdownDrawings(localizedTextString(comment.body))[index];
	if (!drawing) throw new RepositoryError("not_found", "Drawing not found.", 404);
	if (!env.BICKR_R2) throw new RepositoryError("server_error", "Image storage is unavailable.", 503);
	const key = await previewKey(drawing.language, drawing.source);
	const stored = await env.BICKR_R2.get(key);
	if (stored) return pngResponse(stored.body);
	const rendered = await env.FORUM_COORDINATOR_SERVICE.fetch(renderRequest(env, new URL(request.url).origin, drawing));
	if (!rendered.ok || rendered.headers.get("content-type") !== "image/png") {
		await rendered.body?.cancel();
		throw new RepositoryError("server_error", "The drawing preview could not be rendered.", 502);
	}
	const png = await rendered.arrayBuffer();
	await env.BICKR_R2.put(key, png, { httpMetadata: { contentType: "image/png" } });
	return pngResponse(png);
}

function renderRequest(env: AppEnv, origin: string, drawing: { language: "svg" | "mermaid"; source: string }): Request {
	const headers = new Headers({ "content-type": "application/json" });
	addInternalServiceAuthHeader(headers, env.INTERNAL_SERVICE_SECRET);
	return new Request(internalServiceUrl("/drawing-previews/render"), {
		method: "POST",
		headers,
		body: JSON.stringify({ origin, fragment: encodeDrawingSnapshot(drawing) }),
	});
}
