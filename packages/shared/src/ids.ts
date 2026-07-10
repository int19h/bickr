export type IdPrefix =
	| "usr"
	| "sid"
	| "wld"
	| "frm"
	| "bot"
	| "pid"
	| "thr"
	| "pst"
	| "cmt"
	| "ntf"
	| "grp"
	| "spt"
	| "act"
	| "hsb"
	| "hnt";

export function makeId(prefix: IdPrefix): string {
	return `${prefix}_${crypto.randomUUID()}`;
}

const shortContentIdAlphabet = "abcdefghijklmnopqrstuvwxyz234567";
const shortContentIdPattern = /^[a-z2-7]{8}$/;

export type ContentRef =
	| { type: "thread"; id: string }
	| { type: "comment"; id: string };

export function isShortContentId(value: string): boolean {
	return shortContentIdPattern.test(value);
}

// Eight base32 characters encode 40 random bits; reserveContentId in social.ts
// owns collision handling with an INSERT OR IGNORE retry loop.
export function makeShortContentId(): string {
	const bytes = new Uint8Array(5);
	crypto.getRandomValues(bytes);
	let buffer = 0;
	let bitCount = 0;
	let id = "";
	for (const byte of bytes) {
		buffer = (buffer << 8) | byte;
		bitCount += 8;
		while (bitCount >= 5) {
			bitCount -= 5;
			id += shortContentIdAlphabet[(buffer >> bitCount) & 31];
		}
	}
	return id;
}

export function formatThreadRef(value: string): string {
	return `t/${parseThreadRef(value) ?? value}`;
}

export function formatCommentRef(value: string): string {
	return `c/${parseCommentRef(value) ?? value}`;
}

export function parseThreadRef(value: string | null | undefined): string | undefined {
	const text = value?.trim();
	if (!text) {
		return undefined;
	}
	const lower = text.toLowerCase();
	// Short display prefixes are user-facing refs, so t/ and c/ are accepted case-insensitively.
	if (lower.startsWith("t/")) {
		return parseThreadRefBody(text.slice(2));
	}
	if (lower.startsWith("c/")) {
		return undefined;
	}
	// Legacy stored IDs keep their exact lowercase prefix shape.
	if (text.startsWith("thr_")) {
		return text;
	}
	return parseShortContentIdBody(text);
}

export function parseCommentRef(value: string | null | undefined): string | undefined {
	const text = value?.trim();
	if (!text) {
		return undefined;
	}
	const lower = text.toLowerCase();
	// Short display prefixes are user-facing refs, so c/ and t/ are accepted case-insensitively.
	if (lower.startsWith("c/")) {
		return parseCommentRefBody(text.slice(2));
	}
	if (lower.startsWith("t/")) {
		return undefined;
	}
	// Legacy stored IDs keep their exact lowercase prefix shape.
	if (text.startsWith("cmt_")) {
		return text;
	}
	return parseShortContentIdBody(text);
}

export function parseObjectRef(value: string | null | undefined): ContentRef | undefined {
	const text = value?.trim();
	if (!text) {
		return undefined;
	}
	const lower = text.toLowerCase();
	if (lower.startsWith("t/")) {
		const id = parseThreadRefBody(text.slice(2));
		return id ? { type: "thread", id } : undefined;
	}
	if (lower.startsWith("c/")) {
		const id = parseCommentRefBody(text.slice(2));
		return id ? { type: "comment", id } : undefined;
	}
	if (text.startsWith("thr_")) {
		return { type: "thread", id: text };
	}
	if (text.startsWith("cmt_")) {
		return { type: "comment", id: text };
	}
	return undefined;
}

function parseThreadRefBody(value: string): string | undefined {
	return value.startsWith("thr_") ? value : parseShortContentIdBody(value);
}

function parseCommentRefBody(value: string): string | undefined {
	return value.startsWith("cmt_") ? value : parseShortContentIdBody(value);
}

function parseShortContentIdBody(value: string): string | undefined {
	const lower = value.toLowerCase();
	return shortContentIdPattern.test(lower) ? lower : undefined;
}

export async function sha256Hex(value: string): Promise<string> {
	const encoded = new TextEncoder().encode(value);
	const digest = await crypto.subtle.digest("SHA-256", encoded);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

export function randomToken(bytes = 32): string {
	const data = new Uint8Array(bytes);
	crypto.getRandomValues(data);
	return base64Url(data);
}

function base64Url(data: Uint8Array): string {
	let binary = "";
	for (const byte of data) {
		binary += String.fromCharCode(byte);
	}

	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
