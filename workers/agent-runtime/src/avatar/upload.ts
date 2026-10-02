import { readJsonBody } from "@bickr/shared/api";
import { avatarMaxBytes, fetchRemoteAvatarBytes, validateAvatarFile, type AvatarContentType } from "@bickr/shared/avatar-storage";
import { BodyReadTimeoutError, BodySizeLimitError, readBoundedRequest } from "@bickr/shared/bounded-body";
import { InputError, requiredText } from "@bickr/shared/validation";

// Leave room for multipart headers while bounding all fields before parsing.
export const avatarUploadMaxBytes = avatarMaxBytes + 64 * 1024;

type AvatarUploadBytes =
	| { kind: "file"; bytes: Uint8Array; contentType: AvatarContentType; originalFilename?: string }
	| { kind: "url"; bytes: Uint8Array; contentType: AvatarContentType; sourceUrl: string };

export async function avatarUploadBytes(request: Request): Promise<AvatarUploadBytes> {
	const contentType = request.headers.get("content-type") ?? "";
	if (contentType.split(";", 1)[0]?.trim().toLowerCase() === "multipart/form-data") {
		let bytes: Uint8Array;
		try {
			bytes = await readBoundedRequest(request, { maxBytes: avatarUploadMaxBytes, timeoutMs: 15_000 });
		} catch (error) {
			if (error instanceof BodySizeLimitError) throw new InputError("Avatar upload is too large. The image must be 10 MB or smaller.");
			if (error instanceof BodyReadTimeoutError) throw new InputError("Avatar upload timed out.");
			throw error;
		}
		let form: FormData;
		try {
			form = await new Response(bytes, { headers: { "content-type": contentType } }).formData();
		} catch {
			throw new InputError("Avatar upload must be valid multipart form data.");
		}
		const entries = [...form.entries()];
		if (entries.length !== 1 || entries[0]?.[0] !== "file" || !(entries[0][1] instanceof File)) {
			throw new InputError("Avatar upload must include exactly one file field.");
		}
		const file = entries[0][1];
		const validated = await validateAvatarFile(file);
		return {
			kind: "file", bytes: validated.bytes, contentType: validated.contentType,
			...(file.name ? { originalFilename: file.name } : {}),
		};
	}
	const body = await readJsonBody(request);
	const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
	const sourceUrl = requiredText(record.url, "Avatar URL", 1_000);
	const validated = await fetchRemoteAvatarBytes(sourceUrl, fetch, { signal: request.signal });
	return { kind: "url", bytes: validated.bytes, contentType: validated.contentType, sourceUrl };
}
