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
	handleForumCoordinatorRequest,
	it,
	jsonRequest,
	kvKeys,
	pngAvatarBytes,
	readThread,
	requiredLt,
	seedWorld,
	storeAvatarImage,
	testEnv,
	threadDetail,
	updateBotAvatar,
	userIdForHandle,
	webpAvatarBytes,
} from "./helpers/index-harness";
import type { AvatarCrop, AvatarImage, CommentDocument, ThreadDocument } from "../packages/shared/src/model";
import { writeJson, type D1DatabaseLike, type KVNamespaceLike } from "../packages/shared/src/storage";
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

type CoordinatorEnv = Parameters<typeof handleForumCoordinatorRequest>[1];
type CoordinatorPayload = { thread: ServedThread; comment?: ServedComment };

/** The `bots_index` read that resolves the avatar overlay, and nothing else. */
const avatarLookupFragment = "avatar_crop AS avatarCrop";

/** Delegate every member except the one being intercepted. */
function intercept<T extends object>(target: T, member: keyof T, replacement: unknown): T {
	return new Proxy(target, {
		get(object, property, receiver) {
			if (property === member) {
				return replacement;
			}
			const value = Reflect.get(object, property, receiver) as unknown;
			return typeof value === "function" ? value.bind(object) : value;
		},
	});
}

/**
 * A coordinator env that records when the avatar overlay is resolved relative
 * to the KV write that commits a mutation, and can fail the lookup on demand.
 */
function tracedCoordinatorEnv(
	events: string[],
	options: { failAvatarLookup?: () => boolean } = {},
): CoordinatorEnv {
	const db: D1DatabaseLike = testEnv.BICKR_D1;
	const kv: KVNamespaceLike = testEnv.BICKR_KV;
	return {
		...testEnv,
		BICKR_D1: intercept(testEnv.BICKR_D1, "prepare", (query: string) => {
			if (query.includes(avatarLookupFragment)) {
				if (options.failAvatarLookup?.()) {
					throw new Error("bots_index avatar lookup failed.");
				}
				events.push("avatar-lookup");
			}
			return db.prepare(query);
		}),
		BICKR_KV: intercept(testEnv.BICKR_KV, "put", (key: string, value: string, putOptions?: { expirationTtl?: number }) => {
			if (key.startsWith(kvKeys.thread(""))) {
				events.push("thread-write");
			}
			return kv.put(key, value, putOptions);
		}),
	};
}

async function createCommentThroughCoordinator(
	threadId: string,
	botId: string,
	body: string,
	env: CoordinatorEnv = testEnv,
): Promise<{ status: number; payload: CoordinatorPayload }> {
	const response = await handleForumCoordinatorRequest(
		jsonRequest(`http://example.com/threads/${threadId}/comments`, "POST", { body: requiredLt(body) }, undefined, {
			"x-bickr-bot-id": botId,
		}),
		env,
	);
	const responseBody = (await response.json()) as { data?: CoordinatorPayload };
	return { status: response.status, payload: responseBody.data ?? { thread: { comments: [] } } };
}

/** The thread document the coordinator serves for its own read route. */
async function coordinatorThreadDocument(threadId: string): Promise<ServedThread> {
	const response = await handleForumCoordinatorRequest(
		new Request(`http://example.com/threads/${threadId}`),
		testEnv,
	);
	expect(response.status, await response.clone().text()).toBe(200);
	const payload = (await response.json()) as { data: { thread: ServedThread } };
	return payload.data.thread;
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

/**
 * Read a thread the way the web app does, through the KV path or, with
 * `fresh`, through the real forum coordinator.
 *
 * The fresh path deliberately uses the coordinator service rather than a stub:
 * hydration lives in the coordinator's response boundary and the web function
 * no longer repeats it, so a stubbed coordinator would only test the stub.
 */
async function servedThread(
	forumHandle: string,
	threadId: string,
	options: { fresh?: boolean } = {},
): Promise<ServedThread> {
	const response = await threadDetail(
		contextFor<typeof threadDetail>(
			new Request(
				`http://example.com/api/worlds/patch-notes/forums/${forumHandle}/threads/${threadId}${options.fresh ? "?fresh=1" : ""}`,
			),
			{ worldHandle: "patch-notes", forumHandle, threadId },
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
		await persistLegacyAvatars(thread.id);

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
		const fresh = await servedThread(forum.handle, thread.id, { fresh: true });
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
		await persistLegacyAvatars(thread.id);

		const served = await servedThread(forum.handle, thread.id, { fresh: true });
		expect(served.comments[0]?.authorAvatarUrl).toBe(avatar.url);
		expect(served.comments[0]?.authorAvatarCrop).toBeUndefined();
	});

	it("hydrates the fresh path once, in the coordinator", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "avatar-fresh-once");
		const author = await createBotForTest(cookie, "fresh-once-author");
		const avatar = await botAvatar(author.id, author.homeWorldId, pngAvatarBytes(), "image/png");
		const thread = await createThreadForTest(forum.id, author.id, "Fresh once", "One hydration is enough.");
		await persistLegacyAvatars(thread.id);

		// The web function must add nothing of its own to the document the
		// coordinator hands it: a second hydration would be a second `bots_index`
		// read per fresh thread view, for a document that is already hydrated.
		const coordinatorThread = await coordinatorThreadDocument(thread.id);
		expect(coordinatorThread.comments[0]?.authorAvatarUrl).toBe(avatar.url);
		const served = await servedThread(forum.handle, thread.id, { fresh: true });
		expect(served.comments.map((comment) => comment.authorAvatarUrl)).toEqual(
			coordinatorThread.comments.map((comment) => comment.authorAvatarUrl),
		);
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

	it("hydrates the comment a mutation names, not just its copy inside the thread", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "avatar-sibling");
		const author = await createBotForTest(cookie, "sibling-author");
		const avatar = await botAvatar(author.id, author.homeWorldId, pngAvatarBytes(), "image/png");
		const thread = await createThreadForTest(forum.id, author.id, "Sibling avatars", "Both representations agree.");
		await persistLegacyAvatars(thread.id);

		const { status, payload } = await createCommentThroughCoordinator(thread.id, author.id, "A reply.");
		expect(status).toBe(201);
		const named = payload.comment;
		expect(named?.authorAvatarUrl).toBe(avatar.url);
		expect(named?.authorAvatarCrop).toBeUndefined();
		// The same comment, reached through the thread, must be the same document.
		const inThread = payload.thread.comments.find((comment) => comment.id === named?.id);
		expect(inThread).toEqual(named);
		// And the root comment's stale stored avatar is gone from both.
		for (const comment of payload.thread.comments) {
			expect(comment.authorAvatarUrl).toBe(avatar.url);
		}
	});

	it("resolves a mutation's avatars before it commits, so no lookup can fail after the write", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "avatar-precommit");
		const author = await createBotForTest(cookie, "precommit-author");
		const avatar = await botAvatar(author.id, author.homeWorldId, pngAvatarBytes(), "image/png");
		const thread = await createThreadForTest(forum.id, author.id, "Pre-commit avatars", "The lookup precedes the write.");

		// The lookup starts failing the moment the mutation's own document write
		// lands. A coordinator that hydrated afterwards would turn a committed
		// comment into a 500, and its caller would retry the post into a duplicate.
		const events: string[] = [];
		const env = tracedCoordinatorEnv(events, { failAvatarLookup: () => events.includes("thread-write") });
		const { status, payload } = await createCommentThroughCoordinator(thread.id, author.id, "A committed reply.", env);

		expect(status).toBe(201);
		expect(payload.comment?.authorAvatarUrl).toBe(avatar.url);
		expect(events.indexOf("avatar-lookup")).toBeGreaterThanOrEqual(0);
		expect(events.indexOf("avatar-lookup")).toBeLessThan(events.indexOf("thread-write"));
		// Exactly one comment was written, and it is the one the response named.
		const stored = await readThread(testEnv.BICKR_KV, thread.id);
		expect(stored.comments).toHaveLength(2);
		expect(stored.comments.map((comment) => comment.id)).toContain(payload.comment?.id);
	});

	it("fails a mutation before it commits when the avatar lookup is unavailable", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const forum = await createForumForTest(cookie, "avatar-precommit-fail");
		const author = await createBotForTest(cookie, "precommit-fail-author");
		await botAvatar(author.id, author.homeWorldId, pngAvatarBytes(), "image/png");
		const thread = await createThreadForTest(forum.id, author.id, "Failed lookup", "A failure here is retryable.");

		const events: string[] = [];
		const env = tracedCoordinatorEnv(events, { failAvatarLookup: () => true });
		const { status } = await createCommentThroughCoordinator(thread.id, author.id, "Never posted.", env);

		// The failure is a plain 500, but nothing was written, so the caller's
		// retry posts the comment once rather than twice.
		expect(status).toBe(500);
		expect(events).not.toContain("thread-write");
		const stored = await readThread(testEnv.BICKR_KV, thread.id);
		expect(stored.comments).toHaveLength(1);
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
