import { beforeEach, describe, expect, it } from "vitest";
import { env as testEnv } from "cloudflare:test";
import {
	InjectedLifecycleFailure,
	type LifecycleFailureInjector,
	type LifecycleFailurePoint,
} from "@bickr/shared/entity-lifecycle";
import { ExclusiveOperationQueue } from "@bickr/shared/exclusive-operation-queue";
import { addInternalServiceAuthHeader, internalServiceUrl } from "@bickr/shared/internal-service";
import type { UserDocument } from "@bickr/shared/model";
import type { ProviderUserProfile } from "@bickr/shared/repository";
import agentRuntimeWorker, { handleAgentRuntimeRequest } from "../workers/agent-runtime/src/routes";
import type { Env } from "../workers/agent-runtime/src/types";
import { handleForumCoordinatorRequest } from "../workers/forum-coordinator/src/index";
import { clearKv, resetD1Schema } from "./helpers/d1-schema";

const internalSecret = "account-bootstrap-dispatch-secret";

beforeEach(async () => {
	await resetD1Schema(testEnv.BICKR_D1);
	await clearKv(testEnv.BICKR_KV);
});

describe("default Worker account bootstrap dispatch", () => {
	it("maps pre-dispatch parsing failures to the canonical JSON envelope", async () => {
		const harness = accountBootstrapHarness();
		const headers = new Headers({ "content-type": "application/json" });
		addInternalServiceAuthHeader(headers, internalSecret);
		const response = await agentRuntimeWorker.fetch(new Request(internalServiceUrl("/accounts/bootstrap"), {
			method: "POST",
			headers,
			body: "{",
		}) as Parameters<typeof agentRuntimeWorker.fetch>[0], harness.workerEnv);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ ok: false, error: "bad_request" });
	});

	it("atomically joins simultaneous first logins before routing one stable user coordinator", async () => {
		let routed = 0;
		let releaseBoth!: () => void;
		const bothRouted = new Promise<void>((resolve) => {
			releaseBoth = resolve;
		});
		const harness = accountBootstrapHarness({
			beforeUserFetch: async () => {
				routed += 1;
				if (routed === 2) releaseBoth();
				await bothRouted;
			},
		});
		const profile = githubProfile("simultaneous-first-login");

		const [first, second] = await Promise.all([
			harness.bootstrap(profile, "simultaneous-first-a"),
			harness.bootstrap(profile, "simultaneous-first-b"),
		]);
		const [firstBody, secondBody] = await Promise.all([successData(first), successData(second)]);
		const firstUser = requiredUser(firstBody);
		const secondUser = requiredUser(secondBody);

		expect(firstUser.id).toBe(secondUser.id);
		expect(harness.routedUserIds).toEqual([firstUser.id, firstUser.id]);
		await expectOneActiveAccount(profile, firstUser.id, firstUser.handle);
		const operations = await testEnv.BICKR_D1.prepare(
			"SELECT COUNT(*) AS count FROM entity_lifecycle_operations WHERE entity_kind = 'account' AND entity_id = ?",
		).bind(firstUser.id).first<{ count: number }>();
		expect(operations?.count).toBe(1);
	});

	it("canonicalizes provider fields before joining an exact pending retry", async () => {
		const injector = new FailOnce("account.materialize.kv");
		const harness = accountBootstrapHarness({ bootstrapFailureInjector: injector });
		const profile: ProviderUserProfile = {
			provider: "github",
			subject: "  subject-normalized-retry  ",
			login: "  login-normalized-retry  ",
			displayName: "  Normalized Retry  ",
			email: "  normalized@example.test  ",
			avatarUrl: "  https://example.test/avatar.png  ",
		};
		const key = "normalized-bootstrap-retry";

		const first = await harness.bootstrap(profile, key);
		expect(first.status).toBe(500);
		expect(await first.json()).toMatchObject({ ok: false, error: "server_error" });
		expect(await providerClaim(profile)).toMatchObject({ claimState: "pending" });

		const retried = await harness.bootstrap(profile, key);
		const user = requiredUser(await successData(retried));
		await expectOneActiveAccount(profile, user.id, user.handle);
		const identity = await testEnv.BICKR_D1.prepare(
			`SELECT provider_subject AS subject, provider_login AS login, email, avatar_url AS avatarUrl
			 FROM provider_identities WHERE provider = 'github' AND user_id = ?`,
		).bind(user.id).first<{ subject: string; login: string; email: string; avatarUrl: string }>();
		expect(identity).toEqual({
			subject: "subject-normalized-retry",
			login: "login-normalized-retry",
			email: "normalized@example.test",
			avatarUrl: "https://example.test/avatar.png",
		});
	});

	it("refreshes mutable provider presentation after interruption before coordinator dispatch", async () => {
		let interrupt = true;
		const harness = accountBootstrapHarness({
			beforeUserFetch: async () => {
				if (!interrupt) return;
				interrupt = false;
				throw new Error("Injected failure before UserBotsCoordinator dispatch.");
			},
		});
		const initial: ProviderUserProfile = {
			provider: "github",
			subject: "mutable-presentation-subject",
			login: "initial-reserved-login",
			displayName: "Initial Display",
			email: "initial@example.test",
			avatarUrl: "https://example.test/initial.png",
		};
		const latest: ProviderUserProfile = {
			...initial,
			login: "latest-provider-login",
			displayName: "Latest Display",
			email: "latest@example.test",
			avatarUrl: "https://example.test/latest.png",
		};
		const key = "mutable-presentation-retry";

		const first = await harness.bootstrap(initial, key);
		expect(first.status).toBe(500);
		expect(await first.json()).toMatchObject({ ok: false, error: "server_error" });
		const pending = await providerClaim(initial);
		expect(pending).toMatchObject({ claimState: "pending" });
		expect(await testEnv.BICKR_KV.get(`v1:user:${pending?.userId}`)).toBeNull();

		const retried = await harness.bootstrap(latest, key);
		const user = requiredUser(await successData(retried));
		expect(user.id).toBe(pending?.userId);
		expect(user.handle).toBe("initial-reserved-login");
		const stored = await testEnv.BICKR_KV.get<UserDocument>(`v1:user:${user.id}`, { type: "json" });
		expect(stored?.displayName).toEqual({ text: "Latest Display", lang: null });
		const identity = await testEnv.BICKR_D1.prepare(
			`SELECT provider_login AS login, email, avatar_url AS avatarUrl
			 FROM provider_identities WHERE provider = 'github' AND provider_subject = ?`,
		).bind(latest.subject).first<{ login: string; email: string; avatarUrl: string }>();
		expect(identity).toEqual({
			login: "latest-provider-login",
			email: "latest@example.test",
			avatarUrl: "https://example.test/latest.png",
		});
		await expectOneActiveAccount(latest, user.id, user.handle);
	});

	it("atomically retries an automatic handle collision for distinct provider subjects", async () => {
		const db = synchronizeFirstTwoBatches(testEnv.BICKR_D1);
		const harness = accountBootstrapHarness({ db });
		const sharedLogin = "simultaneous-shared-login";
		const firstProfile = { ...githubProfile("handle-race-a"), login: sharedLogin };
		const secondProfile = { ...githubProfile("handle-race-b"), login: sharedLogin };

		const [first, second] = await Promise.all([
			harness.bootstrap(firstProfile, "handle-race-a"),
			harness.bootstrap(secondProfile, "handle-race-b"),
		]);
		const [firstUser, secondUser] = await Promise.all([
			successData(first).then(requiredUser),
			successData(second).then(requiredUser),
		]);

		expect(firstUser.id).not.toBe(secondUser.id);
		expect(firstUser.handle).not.toBe(secondUser.handle);
		await expectOneActiveAccount(firstProfile, firstUser.id, firstUser.handle);
		await expectOneActiveAccount(secondProfile, secondUser.id, secondUser.handle);
	});

	it("reuses the pending reservation and converges on an exact retry", async () => {
		const injector = new FailOnce("account.materialize.kv");
		const harness = accountBootstrapHarness({ bootstrapFailureInjector: injector });
		const profile = githubProfile("bootstrap-retry");
		const key = "bootstrap-retry-key";

		const first = await harness.bootstrap(profile, key);
		expect(first.status).toBe(500);
		expect(await first.json()).toMatchObject({ ok: false, error: "server_error" });
		const pending = await providerClaim(profile);
		expect(pending).toMatchObject({ claimState: "pending" });

		const retried = await harness.bootstrap(profile, key);
		const user = requiredUser(await successData(retried));
		expect(user.id).toBe(pending?.userId);
		expect(harness.routedUserIds).toEqual([user.id, user.id]);
		await expectOneActiveAccount(profile, user.id, user.handle);
	});

	it("returns a typed deletion conflict and permits re-registration after claims are released", async () => {
		const harness = accountBootstrapHarness();
		const profile = githubProfile("delete-and-reregister");
		const original = requiredUser(await successData(await harness.bootstrap(profile, "register-original")));
		const deleteInjector = new FailOnce("account.delete.hide.d1");

		const interruptedDelete = await harness.userRequest(
			original.id,
			"/profile",
			"DELETE",
			{ confirmCascade: true },
			"delete-original",
			deleteInjector,
		);
		expect(interruptedDelete.status).toBe(500);

		const duringDeletion = await harness.bootstrap(profile, "login-during-delete");
		expect(duringDeletion.status).toBe(409);
		expect(await duringDeletion.json()).toMatchObject({
			ok: false,
			error: "conflict",
			message: "Provider identity is currently being deleted.",
		});

		const completedDelete = await harness.userRequest(
			original.id,
			"/profile",
			"DELETE",
			{ confirmCascade: true },
			"delete-original",
			deleteInjector,
		);
		expect(completedDelete.status).toBe(200);

		const replacement = requiredUser(await successData(await harness.bootstrap(profile, "register-replacement")));
		expect(replacement.id).not.toBe(original.id);
		await expectOneActiveAccount(profile, replacement.id, replacement.handle);
	});
});

type HarnessOptions = {
	beforeUserFetch?: (userId: string) => Promise<void>;
	bootstrapFailureInjector?: LifecycleFailureInjector;
	db?: D1Database;
};

function accountBootstrapHarness(options: HarnessOptions = {}) {
	const db = options.db ?? testEnv.BICKR_D1;
	const queues = new Map<string, ExclusiveOperationQueue>();
	const routedUserIds: string[] = [];
	let workerEnv!: Env;
	const forumService = {
		fetch: (request: Request) => handleForumCoordinatorRequest(request, testEnv, {
			objectId: "account-bootstrap-world-coordinator",
			queue: new ExclusiveOperationQueue(),
		}),
	};
	const userBots = {
		idFromName(name: string) {
			routedUserIds.push(name);
			return name as unknown as DurableObjectId;
		},
		get(id: DurableObjectId) {
			const userId = String(id);
			return {
				fetch: async (request: Request) => {
					await options.beforeUserFetch?.(userId);
					return handleAgentRuntimeRequest(request, workerEnv, {
						objectId: userId,
						ownerUserId: userId,
						queue: queueFor(queues, userId),
						failureInjector: options.bootstrapFailureInjector,
					});
				},
			} as unknown as DurableObjectStub;
		},
	} as unknown as DurableObjectNamespace;
	const botRuntime = {
		idFromName: (name: string) => name as unknown as DurableObjectId,
		get: () => ({ fetch: () => Promise.resolve(new Response(null, { status: 404 })) }) as unknown as DurableObjectStub,
	} as unknown as DurableObjectNamespace;
	workerEnv = {
		BICKR_D1: db,
		BICKR_KV: testEnv.BICKR_KV,
		BICKR_R2: testEnv.BICKR_R2,
		BICKR_R2_PUBLIC_BASE_URL: testEnv.BICKR_R2_PUBLIC_BASE_URL,
		BOT_RUNTIME: botRuntime,
		FORUM_COORDINATOR_SERVICE: forumService as Fetcher,
		INTERNAL_SERVICE_SECRET: internalSecret,
		USER_BOTS: userBots,
	};

	return {
		routedUserIds,
		workerEnv,
		bootstrap: (profile: ProviderUserProfile, key: string) => agentRuntimeWorker.fetch(
			internalRequest("/accounts/bootstrap", "POST", profile, key) as Parameters<typeof agentRuntimeWorker.fetch>[0],
			workerEnv,
		),
		userRequest: (
			userId: string,
			path: string,
			method: string,
			body: unknown,
			key: string,
			failureInjector?: LifecycleFailureInjector,
		) => handleAgentRuntimeRequest(
			internalRequest(`/users/${encodeURIComponent(userId)}${path}`, method, body, key, userId),
			workerEnv,
			{
				objectId: userId,
				ownerUserId: userId,
				queue: queueFor(queues, userId),
				failureInjector,
			},
		),
	};
}

function internalRequest(path: string, method: string, body: unknown, key: string, userId?: string): Request {
	const headers = new Headers({ "content-type": "application/json", "idempotency-key": key });
	if (userId) headers.set("x-bickr-user-id", userId);
	addInternalServiceAuthHeader(headers, internalSecret);
	return new Request(internalServiceUrl(path), { method, headers, body: JSON.stringify(body) });
}

function queueFor(queues: Map<string, ExclusiveOperationQueue>, userId: string): ExclusiveOperationQueue {
	const existing = queues.get(userId);
	if (existing) return existing;
	const queue = new ExclusiveOperationQueue();
	queues.set(userId, queue);
	return queue;
}

class FailOnce implements LifecycleFailureInjector {
	private failed = false;
	private readonly point: LifecycleFailurePoint;
	constructor(point: LifecycleFailurePoint) {
		this.point = point;
	}
	checkpoint(point: LifecycleFailurePoint): void {
		if (point !== this.point || this.failed) return;
		this.failed = true;
		throw new InjectedLifecycleFailure(point, {
			category: "external_retryable",
			code: `injected_${point}`,
			retryable: true,
		});
	}
}

function githubProfile(suffix: string): ProviderUserProfile {
	return { provider: "github", subject: `subject-${suffix}`, login: `login-${suffix}` };
}

async function successData(response: Response): Promise<Record<string, unknown>> {
	const payload = await response.json() as { ok: boolean; data?: Record<string, unknown>; message?: string };
	expect(response.status, JSON.stringify(payload)).toBe(201);
	expect(payload, JSON.stringify(payload)).toMatchObject({ ok: true });
	if (!payload.data) throw new Error("Expected account bootstrap data.");
	return payload.data;
}

function requiredUser(data: Record<string, unknown>): { id: string; handle: string } {
	if (!data.user || typeof data.user !== "object" || Array.isArray(data.user)) throw new Error("Expected user.");
	const user = data.user as Record<string, unknown>;
	if (typeof user.id !== "string" || typeof user.handle !== "string") throw new Error("Expected typed user identity.");
	return { id: user.id, handle: user.handle };
}

async function providerClaim(profile: ProviderUserProfile) {
	return testEnv.BICKR_D1.prepare(
		`SELECT entity_id AS userId, claim_state AS claimState, operation_id AS operationId
		 FROM entity_lifecycle_identity_claims
		 WHERE key_kind = 'provider_subject' AND key_scope = ? AND key_value = ?`,
	).bind(profile.provider, profile.subject.trim()).first<{
		userId: string;
		claimState: "pending" | "active";
		operationId: string | null;
	}>();
}

async function expectOneActiveAccount(profile: ProviderUserProfile, userId: string, handle: string): Promise<void> {
	const providerClaims = await testEnv.BICKR_D1.prepare(
		`SELECT entity_id AS userId, claim_state AS claimState, operation_id AS operationId
		 FROM entity_lifecycle_identity_claims
		 WHERE key_kind = 'provider_subject' AND key_scope = ? AND key_value = ?`,
	).bind(profile.provider, profile.subject.trim()).all<{
		userId: string;
		claimState: "pending" | "active";
		operationId: string | null;
	}>();
	expect(providerClaims.results).toEqual([{ userId, claimState: "active", operationId: null }]);
	const handleClaims = await testEnv.BICKR_D1.prepare(
		`SELECT entity_id AS userId, claim_state AS claimState, operation_id AS operationId
		 FROM entity_lifecycle_identity_claims
		 WHERE key_kind = 'user_handle' AND key_scope = 'global' AND key_value = ?`,
	).bind(handle).all<{
		userId: string;
		claimState: "pending" | "active";
		operationId: string | null;
	}>();
	expect(handleClaims.results).toEqual([{ userId, claimState: "active", operationId: null }]);
	const projection = await testEnv.BICKR_D1.prepare(
		"SELECT COUNT(*) AS count FROM users_index WHERE user_id = ? AND lifecycle_state = 'active' AND deleted_at IS NULL",
	).bind(userId).first<{ count: number }>();
	expect(projection?.count).toBe(1);
}

function synchronizeFirstTwoBatches(db: D1Database): D1Database {
	let arrivals = 0;
	let release!: () => void;
	const bothArrived = new Promise<void>((resolve) => {
		release = resolve;
	});
	const batch = db.batch.bind(db);
	return new Proxy(db, {
		get(target, property) {
			if (property === "batch") {
				return async (...args: Parameters<D1Database["batch"]>) => {
					if (arrivals < 2) {
						arrivals += 1;
						if (arrivals === 2) release();
						await bothArrived;
					}
					return batch(...args);
				};
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
