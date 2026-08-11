const utf8CursorPrefix = "v1.";

/**
 * Encodes a bounded JSON pagination cursor without imposing btoa's Latin-1
 * restriction on user-controlled sort keys.
 */
export function encodeOpaqueJsonCursor(value: object): string {
	const bytes = new TextEncoder().encode(JSON.stringify(value));
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return `${utf8CursorPrefix}${btoa(binary)}`;
}

/**
 * Decodes the current tagged UTF-8 representation or an exact legacy byte
 * string. The legacy branch must not try UTF-8 first: some historical Latin-1
 * JSON also forms valid UTF-8 with a different value. Remove the unmarked
 * branch after the compatibility window tracked by #158.
 */
export function decodeOpaqueJsonCursor(value: string): unknown {
	const tagged = value.startsWith(utf8CursorPrefix);
	const binary = atob(tagged ? value.slice(utf8CursorPrefix.length) : value);
	if (!tagged) return JSON.parse(binary) as unknown;

	const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
	return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown;
}
