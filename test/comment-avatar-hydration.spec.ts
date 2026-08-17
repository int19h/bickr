import {
	authCookie,
	contextFor,
	createBotForTest,
	createCommentForTest,
	createForumForTest,
	createThreadForTest,
	deleteBot,
	describe,
	expect,
	fakeR2Bucket,
	it,
	jsonRequest,
	kvKeys,
	pngAvatarBytes,
	readThread,
	seedWorld,
	storeAvatarImage,
	testEnv,
	threadDetail,
	updateBotAvatar,
	userIdForHandle,
	vi,
	webpAvatarBytes,
} from "./helpers/index-harness";
import type { AvatarCrop, AvatarImage, CommentDocument, ThreadDocument } from "../packages/shared/src/model";
import { writeJson } from "../packages/shared/src/storage";
import {
	createMcpAuthorizationCode,
	exchangeMcpAuthorizationCode,
	registerMcpClient,
} from "../packages/shared/src/mcp-auth";
import { onRequestPost as mcpPost } from "../apps/web/functions/mcp";
import { exportThreadRef } from "../apps/web/functions/api/cli/export/_export";

const publicBaseUrl = "https://test-assets.bickr.social";
const staleAvatarUrl = "https://test-assets.bickr.social/worlds/w_gone/bots/bot_gone/avatars/stale.png";
const staleCrop: AvatarCrop = { x: 1, y: 1, size: 2, imageWidth: 4, imageHeight: 4 };

type ServedComment = { id: string; authorBotId: string; authorAvatarUrl?: string; authorAvatarCrop?: AvatarCrop };
type ServedThread = { comments: ServedComment[] };

async function botAvatar(botId: string, worldId: string, bytes: Uint8Array, contentType: "image/png" | "image/webp"): Promise<AvatarImage> {
	const r2 = fakeR2Bucket();
	const avatar = await storeAvatarImage(r2.bucket, { botId, worldId, bytes, contentType, publicBaseUrl });
	await updateBotAvatar(testEnv.BICKR_KV, testEnv.BICKR_D1, botId, await userIdForHandle("octocat"), avatar);
	return avatar;
}

/**
 * Give every stored comment the avatar shape older documents carry.
 *
 * New comments no longer persist one, so a document written by the current code
 * cannot exercise the strip on its own.
 */
async function persistLegacyAvatars(threadId: string): Promise<ThreadDocument> {
	const thread = await readThread(testEnv.BICKR_KV, threadId);
	const legacy: ThreadDocument = {
		...thread,
		comments: thread.comments.map((comment): CommentDocument => ({
			...comment,
			authorAvatarUrl: staleAvatarUrl,
			authorAvatarCrop: staleCrop,
		})),
	};
	await writeJson(testEnv.BICKR_KV, kvKeys.thread(threadId), legacy);
	return legacy;
}

async function mcpAccessToken(userId: string): Promise<string> {
	const now = new Date();
	const client = await registerMcpClient(testEnv.BICKR_KV, {
		clientName: "Avatar hydration client",
		redirectUris: ["http://localhost:5173/callback"],
	}, now);
	const codeVerifier = "correct-horse-battery-staple-correct-horse-battery-staple";
	const encoded = new TextEncoder().encode(codeVerifier);
	const digest = await crypto.subtle.digest("SHA-256", encoded);
	const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	const issued = await createMcpAuthorizationCode(testEnv.BICKR_KV, {
		clientId: client.id,
		redirectUri: "http://localhost:5173/callback",
		resource: "https://bickr.social/mcp",
		userId,
		scopes: ["bickr.read"],
		codeChallenge,
		codeChallengeMethod: "S256",
	}, now);
	const tokens = await exchangeMcpAuthorizationCode(testEnv.BICKR_KV, {
		code: issued.code,
		clientId: client.id,
		redirectUri: "http://localhost:5173/callback",
		codeVerifier,
		resource: "https://bickr.social/mcp",
	}, now);
	return tokens.accessToken;
}

async function servedThread(
	forumHandle: string,
	threadId: string,
	options: { fresh?: ThreadDocument } = {},
): Promise<ServedThread> {
	const freshDocument = options.fresh;
	const coordinator = {
		fetch: vi.fn(async () => Response.json({ ok: true, data: { thread: freshDocument } })),
	} as unknown as Fetcher;
	const response = await threadDetail(
		contextFor<typeof threadDetail>(
			new Request(
				`http://example.com/api/worlds/patch-notes/forums/${forumHandle}/threads/${threadId}${freshDocument ? "?fresh=1" : ""}`,
			),
			{ worldHandle: "patch-notes", forumHandle, threadId },
			freshDocument ? { FORUM_COORDINATOR_SERVICE: coordinator } : {},
		),
	);
	expect(response.status, await response.clone().text()).toBe(200);
	const payload = (await response.json()) as { data: { thread: ServedThread } };
	return payload.data.thread;
}

describe("comment avatar hydration", () => {
	it("never persists an author avatar into a stored thread document", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "avatar-storage");
		const author = await createBotForTest(cookie, "storage-author");
		await botAvatar(author.id, author.homeWorldId, pngAvatarBytes(), "image/png");

		const thread = await createThreadForTest(forum.id, author.id, "Stored avatars", "The document keeps no avatar.");
		await createCommentForTest(thread.id, author.id, "A reply keeps none either.");

		const stored = await readThread(testEnv.BICKR_KV, thread.id);
		expect(stored.comments).toHaveLength(2);
		for (const comment of stored.comments) {
			expect(comment.authorAvatarUrl).toBeUndefined();
			expect(comment.authorAvatarCrop).toBeUndefined();
		}
	});

	it("serves the author's current avatar and drops the one stored on the comment", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "avatar-current");
		const author = await createBotForTest(cookie, "current-author");
		await botAvatar(author.id, author.homeWorldId, pngAvatarBytes(), "image/png");
		const thread = await createThreadForTest(forum.id, author.id, "Current avatars", "Historical comments follow the author.");
		await persistLegacyAvatars(thread.id);

		// The avatar the author has *now*, replacing the one the comment stored.
		const replacement = await botAvatar(author.id, author.homeWorldId, webpAvatarBytes(), "image/webp");
		const served = await servedThread(forum.handle, thread.id);

		expect(served.comments).toHaveLength(1);
		expect(served.comments[0]?.authorAvatarUrl).toBe(replacement.url);
		expect(served.comments[0]?.authorAvatarUrl).not.toBe(staleAvatarUrl);
		expect(served.comments[0]?.authorAvatarCrop).toBeUndefined();
	});

	it("shows no avatar for a deleted author instead of the one frozen into the comment", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "avatar-deleted");
		const author = await createBotForTest(cookie, "deleted-author");
		await botAvatar(author.id, author.homeWorldId, pngAvatarBytes(), "image/png");
		const thread = await createThreadForTest(forum.id, author.id, "Deleted authors", "A deleted author keeps no avatar.");
		const legacy = await persistLegacyAvatars(thread.id);

		const deletion = await deleteBot(
			contextFor<typeof deleteBot>(
				jsonRequest(`http://example.com/api/me/bots/${author.id}`, "DELETE", undefined, cookie),
				{ botId: author.id },
			),
		);
		expect(deletion.status, await deletion.clone().text()).toBe(200);

		const served = await servedThread(forum.handle, thread.id);
		expect(served.comments[0]?.authorAvatarUrl).toBeUndefined();
		expect(served.comments[0]?.authorAvatarCrop).toBeUndefined();

		// Same document, served through the coordinator-fresh path.
		const fresh = await servedThread(forum.handle, thread.id, { fresh: legacy });
		expect(fresh.comments[0]?.authorAvatarUrl).toBeUndefined();
		expect(fresh.comments[0]?.authorAvatarCrop).toBeUndefined();
	});

	it("hydrates the coordinator-fresh path, which serves the coordinator document directly", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "avatar-fresh");
		const author = await createBotForTest(cookie, "fresh-author");
		const avatar = await botAvatar(author.id, author.homeWorldId, pngAvatarBytes(), "image/png");
		const thread = await createThreadForTest(forum.id, author.id, "Fresh avatars", "The fresh path hydrates too.");
		const legacy = await persistLegacyAvatars(thread.id);

		const served = await servedThread(forum.handle, thread.id, { fresh: legacy });
		expect(served.comments[0]?.authorAvatarUrl).toBe(avatar.url);
		expect(served.comments[0]?.authorAvatarCrop).toBeUndefined();
	});

	it("hydrates comments returned by the coordinator's own mutation responses", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "avatar-mutation");
		const author = await createBotForTest(cookie, "mutation-author");
		const avatar = await botAvatar(author.id, author.homeWorldId, pngAvatarBytes(), "image/png");

		const thread = await createThreadForTest(forum.id, author.id, "Mutation avatars", "Creation responses hydrate.");
		const created = thread as unknown as ServedThread;
		expect(created.comments[0]?.authorAvatarUrl).toBe(avatar.url);
	});

	it("hydrates MCP thread reads", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "avatar-mcp");
		const author = await createBotForTest(cookie, "mcp-author");
		const avatar = await botAvatar(author.id, author.homeWorldId, pngAvatarBytes(), "image/png");
		const thread = await createThreadForTest(forum.id, author.id, "MCP avatars", "MCP reads hydrate too.");
		await persistLegacyAvatars(thread.id);

		const accessToken = await mcpAccessToken(await userIdForHandle("octocat"));
		const response = await mcpPost(contextFor<typeof mcpPost>(
			jsonRequest("https://bickr.social/mcp", "POST", {
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "get_thread",
					arguments: { worldHandle: "patch-notes", forumHandle: forum.handle, threadId: thread.id },
				},
			}, undefined, { authorization: `Bearer ${accessToken}` }),
		));
		expect(response.status, await response.clone().text()).toBe(200);
		const body = (await response.json()) as {
			result: { structuredContent: { thread: ServedThread } };
		};
		const comments = body.result.structuredContent.thread.comments;
		expect(comments[0]?.authorAvatarUrl).toBe(avatar.url);
		expect(comments[0]?.authorAvatarCrop).toBeUndefined();
	});

	it("hydrates exported comments", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "avatar-export");
		const author = await createBotForTest(cookie, "export-author");
		const avatar = await botAvatar(author.id, author.homeWorldId, pngAvatarBytes(), "image/png");
		const guest = await createBotForTest(cookie, "export-guest");
		const thread = await createThreadForTest(forum.id, author.id, "Exported avatars", "The export hydrates too.");
		await createCommentForTest(thread.id, guest.id, "A reply from an author with no avatar.");
		await persistLegacyAvatars(thread.id);

		const env = contextFor<typeof threadDetail>(new Request("http://example.com/api/worlds")).env;
		const exported = await exportThreadRef(env, `/w/patch-notes/f/${forum.handle}/t/${thread.id}`);
		const comments = exported.records
			.filter((record): record is { type: "comment"; data: CommentDocument } => record.type === "comment")
			.map((record) => record.data);
		expect(comments).toHaveLength(2);
		expect(comments.find((comment) => comment.authorBotId === author.id)?.authorAvatarUrl).toBe(avatar.url);
		// The guest never had an avatar, so the one its comment stored is dropped
		// with nothing to replace it.
		expect(comments.find((comment) => comment.authorBotId === guest.id)?.authorAvatarUrl).toBeUndefined();
		for (const comment of comments) {
			expect(comment.authorAvatarCrop).toBeUndefined();
		}
	});
});
