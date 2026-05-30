import { ok, readJsonBody } from "@bickr/shared/api";
import {
	fetchRemoteAvatarBytes,
	normalizeAvatarPublicBaseUrl,
	storeAvatarImage,
	validateAvatarFile,
	type AvatarContentType,
	type R2BucketLike,
} from "@bickr/shared/avatar-storage";
import { updateWorldAvatar } from "@bickr/shared/governance";
import { worldByHandle } from "@bickr/shared/repository";
import { InputError, requiredText } from "@bickr/shared/validation";
import { type AppEnv, requireCompleteUser } from "../../../_auth";
import { pageErrorResponse } from "../../../_errors";

export const onRequestPut: PagesFunction<AppEnv, "worldHandle"> = async ({ env, request, params }) => {
	try {
		const user = await requireCompleteUser(env, request);
		const worldHandle = singleParam(params.worldHandle);
		const world = await worldByHandle(env.BICKR_D1, worldHandle);
		const now = new Date().toISOString();
		const uploaded = await avatarUploadBytes(request);
		const avatar = await storeAvatarImage(requireAvatarBucket(env), {
			target: "world",
			worldId: world.id,
			bytes: uploaded.bytes,
			contentType: uploaded.contentType,
			publicBaseUrl: normalizeAvatarPublicBaseUrl(env.BICKR_R2_PUBLIC_BASE_URL),
			source:
				uploaded.kind === "file" ?
					{
						type: "upload",
						uploadedAt: now,
						...(uploaded.originalFilename ? { originalFilename: uploaded.originalFilename } : {}),
					}
				:	{
						type: "remote_url",
						sourceUrl: uploaded.sourceUrl,
						importedAt: now,
					},
			now,
		});
		const updated = await updateWorldAvatar(env.BICKR_KV, env.BICKR_D1, worldHandle, user.id, avatar, now);
		return ok({ world: updated });
	} catch (error) {
		return pageErrorResponse(error);
	}
};

export const onRequestDelete: PagesFunction<AppEnv, "worldHandle"> = async ({ env, request, params }) => {
	try {
		const user = await requireCompleteUser(env, request);
		const updated = await updateWorldAvatar(env.BICKR_KV, env.BICKR_D1, singleParam(params.worldHandle), user.id, undefined);
		return ok({ world: updated });
	} catch (error) {
		return pageErrorResponse(error);
	}
};

type UploadBytes =
	| {
			kind: "file";
			bytes: Uint8Array;
			contentType: AvatarContentType;
			originalFilename?: string;
	  }
	| {
			kind: "url";
			bytes: Uint8Array;
			contentType: AvatarContentType;
			sourceUrl: string;
	  };

async function avatarUploadBytes(request: Request): Promise<UploadBytes> {
	const contentType = request.headers.get("content-type") ?? "";
	if (contentType.toLowerCase().includes("multipart/form-data")) {
		const form = await request.formData();
		const file = form.get("file");
		if (!(file instanceof File)) {
			throw new InputError("Avatar upload must include a file.");
		}
		const validated = await validateAvatarFile(file);
		return {
			kind: "file",
			bytes: validated.bytes,
			contentType: validated.contentType,
			...(file.name ? { originalFilename: file.name } : {}),
		};
	}
	const body = await readJsonBody(request);
	const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
	const sourceUrl = requiredText(record.url, "Avatar URL", 1_000);
	const validated = await fetchRemoteAvatarBytes(sourceUrl);
	return {
		kind: "url",
		bytes: validated.bytes,
		contentType: validated.contentType,
		sourceUrl,
	};
}

function requireAvatarBucket(env: AppEnv): R2BucketLike {
	if (!env.BICKR_R2) {
		throw new InputError("BICKR_R2 must be configured before storing avatars.");
	}
	return env.BICKR_R2 as R2BucketLike;
}

function singleParam(value: string | string[]): string {
	return Array.isArray(value) ? (value[0] ?? "") : value;
}
