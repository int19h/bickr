import { ok, readJsonBody } from "@bickr/shared/api";
import { updateWorldAvatar } from "@bickr/shared/governance";
import { type AvatarCrop, type AvatarImage, type WorldDocument } from "@bickr/shared/model";
import { RepositoryError, worldByHandle } from "@bickr/shared/repository";
import { kvKeys, readJson } from "@bickr/shared/storage";
import { InputError, normalizeHandleParam } from "@bickr/shared/validation";
import { type AppEnv, requireCompleteUser } from "../../../_auth";
import { pageErrorResponse } from "../../../_errors";

const maxCropDimension = 100_000;

export const onRequestPatch: PagesFunction<AppEnv, "worldHandle"> = async ({ env, request, params }) => {
	try {
		const user = await requireCompleteUser(env, request);
		const worldHandle = normalizeHandleParam(params.worldHandle, "World handle");
		const worldRef = await worldByHandle(env.BICKR_D1, worldHandle);
		const world = await readJson<WorldDocument>(env.BICKR_KV, kvKeys.world(worldRef.id));
		if (!world || world.deletedAt) {
			throw new RepositoryError("not_found", "World not found.", 404);
		}
		if (world.createdByUserId !== user.id) {
			throw new RepositoryError("forbidden", "Only this world's owner can crop its avatar.", 403);
		}
		if (!world.avatar) {
			throw new InputError("This world does not have an avatar to crop.");
		}
		const body = await readJsonBody(request);
		const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
		if (!("crop" in record)) {
			throw new InputError("Avatar crop is required.");
		}
		const crop = record.crop === null ? null : parseAvatarCrop(record.crop, world.avatar);
		const now = new Date().toISOString();
		const avatar: AvatarImage = crop ?
			{ ...world.avatar, crop, updatedAt: now }
		:	withoutAvatarCrop({ ...world.avatar, updatedAt: now });
		const updated = await updateWorldAvatar(env.BICKR_KV, env.BICKR_D1, world.handle, user.id, avatar, now);
		return ok({ world: updated });
	} catch (error) {
		return pageErrorResponse(error);
	}
};

function parseAvatarCrop(value: unknown, avatar: AvatarImage): AvatarCrop {
	const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
	const crop = {
		x: record.x,
		y: record.y,
		size: record.size,
		imageWidth: record.imageWidth,
		imageHeight: record.imageHeight,
	};
	if (!Object.values(crop).every((part) => Number.isInteger(part))) {
		throw new InputError("Avatar crop must use integer pixel coordinates.");
	}
	const parsed = crop as AvatarCrop;
	if (
		parsed.imageWidth <= 0 ||
		parsed.imageHeight <= 0 ||
		parsed.imageWidth > maxCropDimension ||
		parsed.imageHeight > maxCropDimension
	) {
		throw new InputError("Avatar crop image dimensions are invalid.");
	}
	if (parsed.x < 0 || parsed.y < 0 || parsed.size <= 0 || parsed.size > maxCropDimension) {
		throw new InputError("Avatar crop square is invalid.");
	}
	if (parsed.x + parsed.size > parsed.imageWidth || parsed.y + parsed.size > parsed.imageHeight) {
		throw new InputError("Avatar crop square must be inside the image.");
	}
	if (
		avatar.width !== undefined &&
		avatar.height !== undefined &&
		Number.isInteger(avatar.width) &&
		Number.isInteger(avatar.height) &&
		(Math.round(avatar.width) !== parsed.imageWidth || Math.round(avatar.height) !== parsed.imageHeight)
	) {
		throw new InputError("Avatar crop dimensions do not match the current avatar.");
	}
	return parsed;
}

function withoutAvatarCrop(avatar: AvatarImage): AvatarImage {
	const { crop: _crop, ...rest } = avatar;
	return rest;
}
