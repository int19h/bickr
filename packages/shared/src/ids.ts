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
	| "spt"
	| "hsb"
	| "hnt";

export function makeId(prefix: IdPrefix): string {
	return `${prefix}_${crypto.randomUUID()}`;
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
