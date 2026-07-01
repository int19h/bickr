import { ok, readJsonBody } from "@bickr/shared/api";
import { type AvatarCrop, type AvatarImage } from "@bickr/shared/model";
import { updateUserAvatar } from "@bickr/shared/repository";
import { InputError } from "@bickr/shared/validation";
import { type AppEnv, requireUser } from "../../_auth";
import { pageErrorResponse } from "../../_errors";

const maxCropDimension = 100_000;

export const onRequestPatch: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const user = await requireUser(env, request);
		if (!user.avatar) {
			throw new InputError("Your profile does not have an avatar to crop.");
		}
		const body = await readJsonBody(request);
		const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
		if (!("crop" in record)) {
			throw new InputError("Avatar crop is required.");
		}
		const crop = record.crop === null ? null : parseAvatarCrop(record.crop, user.avatar);
		const now = new Date().toISOString();
		const avatar: AvatarImage = crop ?
			{ ...user.avatar, crop, updatedAt: now }
		:	withoutAvatarCrop({ ...user.avatar, updatedAt: now });
		const profile = await updateUserAvatar(env.BICKR_KV, env.BICKR_D1, user.id, avatar, now);
		return ok({ profile });
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
