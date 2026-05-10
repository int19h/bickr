import { type AvatarImage, type AvatarImageSource } from "./model";
import { InputError } from "./validation";

export const avatarMaxBytes = 10 * 1024 * 1024;
export const avatarAcceptedContentTypes = ["image/jpeg", "image/png", "image/webp"] as const;
export type AvatarContentType = (typeof avatarAcceptedContentTypes)[number];
export type AvatarKind = "avatars" | "avatar-candidates";

export type R2BucketLike = {
	get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
	put(
		key: string,
		value: ArrayBuffer | ArrayBufferView | ReadableStream,
		options?: { httpMetadata?: { contentType?: string; cacheControl?: string } },
	): Promise<unknown>;
	delete(key: string): Promise<void>;
};

export type StoredAvatarInput = {
	botId: string;
	worldId: string;
	bytes: Uint8Array;
	contentType: AvatarContentType;
	publicBaseUrl: string;
	source?: AvatarImageSource;
	now?: string;
	kind?: AvatarKind;
	key?: string;
};

export type RemoteAvatarFetch = typeof fetch;

type ValidatedAvatarBytes = {
	bytes: Uint8Array;
	contentType: AvatarContentType;
	width?: number;
	height?: number;
};

export function normalizeAvatarPublicBaseUrl(value: string | undefined): string {
	const trimmed = value?.trim().replace(/\/+$/, "");
	if (!trimmed) {
		throw new InputError("BICKR_R2_PUBLIC_BASE_URL must be configured before storing avatars.");
	}
	return trimmed;
}

export async function fetchRemoteAvatarBytes(
	url: string,
	fetcher: RemoteAvatarFetch = fetch,
): Promise<ValidatedAvatarBytes> {
	const parsed = remoteAvatarUrl(url);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 15_000);
	let response: Response;
	try {
		response = await fetcher(parsed.toString(), {
			headers: { accept: avatarAcceptedContentTypes.join(", ") },
			redirect: "follow",
			signal: controller.signal,
		});
	} catch (error) {
		if (isAbortError(error)) {
			throw new InputError("Avatar URL fetch timed out.");
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
	if (!response.ok) {
		throw new InputError(`Avatar URL returned HTTP ${response.status}.`);
	}
	const contentLength = response.headers.get("content-length");
	if (contentLength && Number(contentLength) > avatarMaxBytes) {
		throw new InputError("Avatar image must be 10 MB or smaller.");
	}
	const bytes = await readCappedBytes(response.body, avatarMaxBytes);
	return validateAvatarBytes(bytes, response.headers.get("content-type") ?? undefined);
}

export async function validateAvatarFile(file: File): Promise<ValidatedAvatarBytes> {
	if (file.size > avatarMaxBytes) {
		throw new InputError("Avatar image must be 10 MB or smaller.");
	}
	return validateAvatarBytes(new Uint8Array(await file.arrayBuffer()), file.type);
}

export function validateAvatarDataUrl(dataUrl: string): ValidatedAvatarBytes {
	const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
	if (!match) {
		throw new InputError("Generated avatar image was not returned as a data URL.");
	}
	const declaredType = match[1]?.trim().toLowerCase();
	const bytes = base64Bytes(match[2] ?? "");
	return validateAvatarBytes(bytes, declaredType);
}

export function validateAvatarBytes(bytes: Uint8Array, declaredContentType?: string): ValidatedAvatarBytes {
	if (bytes.byteLength === 0) {
		throw new InputError("Avatar image is empty.");
	}
	if (bytes.byteLength > avatarMaxBytes) {
		throw new InputError("Avatar image must be 10 MB or smaller.");
	}
	const detected = detectAvatarContentType(bytes);
	if (!detected) {
		throw new InputError("Avatar image must be JPEG, PNG, or WebP.");
	}
	const declared = declaredContentType?.split(";")[0]?.trim().toLowerCase();
	if (declared && avatarAcceptedContentTypes.includes(declared as AvatarContentType) && declared !== detected) {
		throw new InputError("Avatar image content does not match its declared type.");
	}
	return {
		bytes,
		contentType: detected,
		...avatarDimensions(bytes, detected),
	};
}

export async function storeAvatarImage(bucket: R2BucketLike, input: StoredAvatarInput): Promise<AvatarImage> {
	const now = input.now ?? new Date().toISOString();
	const publicBaseUrl = normalizeAvatarPublicBaseUrl(input.publicBaseUrl);
	const key = avatarObjectKey(input.worldId, input.botId, input.kind ?? "avatars", input.contentType);
	const dimensions = avatarDimensions(input.bytes, input.contentType);
	await bucket.put(input.key ?? key, input.bytes, {
		httpMetadata: {
			contentType: input.contentType,
			cacheControl:
				(input.kind ?? "avatars") === "avatars" ?
					"public, max-age=31536000, immutable"
				:	"public, max-age=86400",
		},
	});
	const storedKey = input.key ?? key;
	return {
		key: storedKey,
		url: `${publicBaseUrl}/${storedKey}`,
		contentType: input.contentType,
		byteLength: input.bytes.byteLength,
		...dimensions,
		...(input.source ? { source: input.source } : {}),
		updatedAt: now,
	};
}

export async function promoteAvatarCandidate(
	bucket: R2BucketLike,
	input: {
		botId: string;
		worldId: string;
		candidate: AvatarImage;
		publicBaseUrl: string;
		source?: AvatarImageSource;
		now?: string;
	},
): Promise<AvatarImage> {
	const object = await bucket.get(input.candidate.key);
	if (!object) {
		throw new InputError("Generated avatar candidate is no longer available.");
	}
	const bytes = new Uint8Array(await object.arrayBuffer());
	const validated = validateAvatarBytes(bytes, input.candidate.contentType);
	return storeAvatarImage(bucket, {
		botId: input.botId,
		worldId: input.worldId,
		bytes: validated.bytes,
		contentType: validated.contentType,
		publicBaseUrl: input.publicBaseUrl,
		source: input.source ?? input.candidate.source,
		now: input.now,
		kind: "avatars",
	});
}

function avatarObjectKey(worldId: string, botId: string, kind: AvatarKind, contentType: AvatarContentType): string {
	const extension =
		contentType === "image/png" ? "png"
		: contentType === "image/webp" ? "webp"
		: "jpg";
	return `worlds/${encodeURIComponent(worldId)}/bots/${encodeURIComponent(botId)}/${kind}/${crypto.randomUUID()}.${extension}`;
}

function remoteAvatarUrl(value: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new InputError("Avatar URL must be a valid URL.");
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new InputError("Avatar URL must use HTTP or HTTPS.");
	}
	if (parsed.username || parsed.password) {
		throw new InputError("Avatar URL must not contain credentials.");
	}
	return parsed;
}

async function readCappedBytes(body: ReadableStream | null, maxBytes: number): Promise<Uint8Array> {
	if (!body) {
		throw new InputError("Avatar URL did not return an image body.");
	}
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel("Avatar image byte limit reached.");
			throw new InputError("Avatar image must be 10 MB or smaller.");
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

function detectAvatarContentType(bytes: Uint8Array): AvatarContentType | null {
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return "image/jpeg";
	}
	if (
		bytes.length >= 8 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	) {
		return "image/png";
	}
	if (
		bytes.length >= 12 &&
		ascii(bytes, 0, 4) === "RIFF" &&
		ascii(bytes, 8, 12) === "WEBP"
	) {
		return "image/webp";
	}
	return null;
}

function avatarDimensions(bytes: Uint8Array, contentType: AvatarContentType): { width?: number; height?: number } {
	if (contentType === "image/png" && bytes.length >= 24) {
		return { width: readUint32(bytes, 16), height: readUint32(bytes, 20) };
	}
	if (contentType === "image/jpeg") {
		return jpegDimensions(bytes);
	}
	if (contentType === "image/webp") {
		return webpDimensions(bytes);
	}
	return {};
}

function jpegDimensions(bytes: Uint8Array): { width?: number; height?: number } {
	let index = 2;
	while (index + 9 < bytes.length) {
		if (bytes[index] !== 0xff) {
			index += 1;
			continue;
		}
		const marker = bytes[index + 1];
		const length = (bytes[index + 2] << 8) | bytes[index + 3];
		if (length < 2) {
			return {};
		}
		if (marker >= 0xc0 && marker <= 0xc3) {
			return {
				height: (bytes[index + 5] << 8) | bytes[index + 6],
				width: (bytes[index + 7] << 8) | bytes[index + 8],
			};
		}
		index += 2 + length;
	}
	return {};
}

function webpDimensions(bytes: Uint8Array): { width?: number; height?: number } {
	const chunk = ascii(bytes, 12, 16);
	if (chunk === "VP8X" && bytes.length >= 30) {
		return {
			width: 1 + readUint24Little(bytes, 24),
			height: 1 + readUint24Little(bytes, 27),
		};
	}
	if (chunk === "VP8 " && bytes.length >= 30) {
		return {
			width: bytes[26] | ((bytes[27] & 0x3f) << 8),
			height: bytes[28] | ((bytes[29] & 0x3f) << 8),
		};
	}
	if (chunk === "VP8L" && bytes.length >= 25) {
		const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
		return {
			width: (bits & 0x3fff) + 1,
			height: ((bits >> 14) & 0x3fff) + 1,
		};
	}
	return {};
}

function readUint32(bytes: Uint8Array, offset: number): number {
	return ((bytes[offset] ?? 0) * 0x1000000) + (((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0));
}

function readUint24Little(bytes: Uint8Array, offset: number): number {
	return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
	return String.fromCharCode(...bytes.slice(start, end));
}

function base64Bytes(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

function isAbortError(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "name" in error && (error as { name?: unknown }).name === "AbortError");
}
