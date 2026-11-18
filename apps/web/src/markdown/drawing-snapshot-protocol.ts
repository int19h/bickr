import type { MarkdownDrawingLanguage } from "@bickr/shared/markdown";

/**
 * The drawing that the snapshot page renders, carried in its URL fragment as
 * base64url JSON. The server encodes it and the page decodes it.
 */
export type DrawingSnapshot = { language: MarkdownDrawingLanguage; source: string };

function toBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
	const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function encodeDrawingSnapshot(drawing: DrawingSnapshot): string {
	return toBase64Url(new TextEncoder().encode(JSON.stringify({ language: drawing.language, source: drawing.source })));
}

export function decodeDrawingSnapshot(fragment: string): DrawingSnapshot | null {
	try {
		const value: unknown = JSON.parse(new TextDecoder().decode(fromBase64Url(fragment)));
		if (!value || typeof value !== "object") return null;
		const { language, source } = value as Record<string, unknown>;
		if ((language !== "svg" && language !== "mermaid") || typeof source !== "string") return null;
		return { language, source };
	} catch {
		return null;
	}
}
