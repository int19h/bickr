import { type AppEnv, requireUser } from "../../_auth";
import { pageErrorResponse } from "../../_errors";
import { botById, rawBotById, RepositoryError } from "@bickr/shared/repository";
import { kvKeys, readJson } from "@bickr/shared/storage";
import { avatarMaxBytes, isAvatarContentType } from "@bickr/shared/avatar-storage";
import type { AvatarImage, WorldDocument } from "@bickr/shared/model";

export const onRequestGet: PagesFunction<AppEnv> = async ({ env, request }) => {
	let response: Response;
	try {
		const user = await requireUser(env, request);
		const params = new URL(request.url).searchParams;
		if (params.get("ownerUserId") !== user.id) throw new RepositoryError("conflict", "The signed-in account changed. Please restart the export.", 409);
		const kind = params.get("kind");
		const id = params.get("entityId");
		const slot = params.get("slot");
		if (!id || (slot !== "avatar" && slot !== "localAvatar" && slot !== "storedAvatar")) throw new RepositoryError("bad_request", "Invalid export image reference.", 400);
		let image: AvatarImage | undefined;
		if (kind === "user" && id === user.id && slot === "avatar") image = user.avatar;
		else if (kind === "world" && slot === "avatar") {
			const owned = await env.BICKR_D1.prepare(`SELECT world_id FROM worlds_index
				WHERE world_id = ? AND created_by_user_id = ? AND deleted_at IS NULL AND lifecycle_state = 'active' LIMIT 1`).bind(id, user.id).first();
			if (!owned) throw new RepositoryError("forbidden", "Export image does not belong to this account.", 403);
			const world = await readJson<WorldDocument>(env.BICKR_KV, kvKeys.world(id));
			if (!world || world.deletedAt || world.createdByUserId !== user.id) throw new RepositoryError("conflict", "World changed during export. Please retry.", 409);
			image = world.avatar;
		} else if (kind === "bot") {
			const bot = await rawBotById(env.BICKR_KV, env.BICKR_D1, id);
			if (bot.ownerUserId !== user.id) throw new RepositoryError("forbidden", "Export image does not belong to this account.", 403);
			image = slot === "localAvatar" ? bot.localOverrides?.avatar
				: slot === "storedAvatar" ? bot.avatar
				: (await botById(env.BICKR_KV, env.BICKR_D1, id)).avatar;
		} else throw new RepositoryError("forbidden", "Export image does not belong to this account.", 403);
		if (!image || params.get("expectedKey") !== image.key) throw new RepositoryError("conflict", "Image changed during export. Please retry or choose image URLs.", 409);
		// Only referenced, managed avatar assets are eligible. Never fetch a caller-supplied URL or arbitrary bucket key.
		if (!/^(?:users\/[^/]+|worlds\/[^/]+\/(?:world|bots\/[^/]+))\/avatars\/[^/]+$/.test(image.key) || image.key.split("/").some((part) => part === "." || part === "..")) {
			throw new RepositoryError("conflict", "This image is not a stored avatar asset. Choose image URLs to export its reference.", 409);
		}
		if (!env.BICKR_R2) throw new RepositoryError("server_error", "Image storage is unavailable. Retry or choose image URLs.", 503);
		const object = await env.BICKR_R2.get(image.key);
		if (!object) throw new RepositoryError("conflict", "A selected image file is missing. Retry or choose image URLs.", 409);
		if (object.size > avatarMaxBytes || !isAvatarContentType(image.contentType)) {
			void object.body.cancel();
			throw new RepositoryError("conflict", "A selected image is too large or unsupported. Choose image URLs.", 409);
		}
		response = new Response(object.body, { headers: { "Content-Type": image.contentType, "Content-Length": String(object.size) } });
	} catch (error) { response = pageErrorResponse(error); }
	const headers = new Headers(response.headers);
	headers.set("Cache-Control", "private, no-store");
	headers.set("Vary", "Cookie, Authorization");
	headers.set("X-Content-Type-Options", "nosniff");
	return new Response(response.body, { status: response.status, headers });
};
