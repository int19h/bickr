import { ok, readJsonBody } from "@bickr/shared/api";
import {
	fetchRemoteAvatarBytes,
	normalizeAvatarPublicBaseUrl,
	storeAvatarImage,
	validateAvatarFile,
	type AvatarContentType,
	type R2BucketLike,
} from "@bickr/shared/avatar-storage";
import { botById, RepositoryError, updateBotAvatar } from "@bickr/shared/repository";
import { InputError, requiredText } from "@bickr/shared/validation";
import { type AppEnv, requireCompleteUser } from "../../../../_auth";
import { pageErrorResponse } from "../../../../_errors";

export const onRequestPut: PagesFunction<AppEnv, "botId"> = async ({ env, request, params }) => {
	try {
		const user = await requireCompleteUser(env, request);
		const botId = singleParam(params.botId);
		const bot = await botById(env.BICKR_KV, env.BICKR_D1, botId);
		if (bot.ownerUserId !== user.id) {
			throw new RepositoryError("forbidden", "Only this participant's owner can update its avatar.", 403);
		}
		const now = new Date().toISOString();
		const uploaded = await avatarUploadBytes(request);
		const avatar = await storeAvatarImage(requireAvatarBucket(env), {
			botId: bot.id,
			worldId: bot.homeWorldId,
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
		const updated = await updateBotAvatar(env.BICKR_KV, env.BICKR_D1, bot.id, user.id, avatar, now);
		return ok({ bot: updated });
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
