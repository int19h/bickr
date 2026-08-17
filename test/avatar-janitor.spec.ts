import {
	authCookie,
	contextFor,
	createBotForTest,
	deleteBot,
	describe,
	expect,
	fakeR2Bucket,
	it,
	jsonRequest,
	pngAvatarBytes,
	seedWorld,
	storeAvatarImage,
	testEnv,
	updateBotAvatar,
	userIdForHandle,
} from "./helpers/index-harness";
import { runAvatarJanitor, type AvatarJanitorBucket } from "../workers/agent-runtime/src/avatar/janitor";

const publicBaseUrl = "https://test-assets.bickr.social";

/**
 * Bucket stub with the listing the janitor needs; the shared `fakeR2Bucket`
 * models only the get/put/delete an avatar upload uses.
 */
function janitorBucket(objects: { key: string; agedDays: number }[]): {
	bucket: AvatarJanitorBucket;
	deleted: string[];
} {
	const deleted: string[] = [];
	const nowMs = Date.now();
	return {
		deleted,
		bucket: {
			async list() {
				return {
					objects: objects.map((object) => ({
						key: object.key,
						uploaded: new Date(nowMs - object.agedDays * 24 * 60 * 60 * 1_000),
					})),
					truncated: false,
				};
			},
			async delete(keys: string[]) {
				deleted.push(...keys);
			},
		},
	};
}

describe("R2 avatar janitor against the real indexes", () => {
	it("keeps a live participant's avatar and reclaims the rest", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "janitor-keeper");
		const uploads = fakeR2Bucket();
		const avatar = await storeAvatarImage(uploads.bucket, {
			botId: bot.id,
			worldId: bot.homeWorldId,
			bytes: pngAvatarBytes(),
			contentType: "image/png",
			publicBaseUrl,
		});
		await updateBotAvatar(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id, await userIdForHandle("octocat"), avatar);

		const replaced = `worlds/${bot.homeWorldId}/bots/${bot.id}/avatars/replaced.png`;
		const candidate = `worlds/${bot.homeWorldId}/bots/${bot.id}/avatar-candidates/in-flight.png`;
		const bucket = janitorBucket([
			{ key: avatar.key, agedDays: 30 },
			{ key: replaced, agedDays: 30 },
			{ key: candidate, agedDays: 1 },
		]);

		const result = await runAvatarJanitor({
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: testEnv.BICKR_KV,
			BICKR_R2: bucket.bucket,
			BICKR_R2_PUBLIC_BASE_URL: publicBaseUrl,
		});

		expect(result).toMatchObject({ status: "swept", deleted: 1, retainedInGrace: 1 });
		expect(bucket.deleted).toEqual([replaced]);
	});

	it("reclaims the avatar of a deleted participant once nothing renders it", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const bot = await createBotForTest(cookie, "janitor-deleted");
		const uploads = fakeR2Bucket();
		const avatar = await storeAvatarImage(uploads.bucket, {
			botId: bot.id,
			worldId: bot.homeWorldId,
			bytes: pngAvatarBytes(),
			contentType: "image/png",
			publicBaseUrl,
		});
		await updateBotAvatar(testEnv.BICKR_KV, testEnv.BICKR_D1, bot.id, await userIdForHandle("octocat"), avatar);

		const beforeDelete = janitorBucket([{ key: avatar.key, agedDays: 30 }]);
		expect(await runAvatarJanitor({
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: testEnv.BICKR_KV,
			BICKR_R2: beforeDelete.bucket,
			BICKR_R2_PUBLIC_BASE_URL: publicBaseUrl,
		}, { force: true })).toMatchObject({ status: "swept", deleted: 0 });
		expect(beforeDelete.deleted).toEqual([]);

		const deletion = await deleteBot(
			contextFor<typeof deleteBot>(
				jsonRequest(`http://example.com/api/me/bots/${bot.id}`, "DELETE", undefined, cookie),
				{ botId: bot.id },
			),
		);
		expect(deletion.status, await deletion.clone().text()).toBe(200);

		const afterDelete = janitorBucket([{ key: avatar.key, agedDays: 30 }]);
		expect(await runAvatarJanitor({
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: testEnv.BICKR_KV,
			BICKR_R2: afterDelete.bucket,
			BICKR_R2_PUBLIC_BASE_URL: publicBaseUrl,
		}, { force: true })).toMatchObject({ status: "swept", deleted: 1 });
		expect(afterDelete.deleted).toEqual([avatar.key]);
	});
});
