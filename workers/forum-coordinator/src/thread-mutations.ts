import { RepositoryError } from "@bickr/shared/repository";
import { isD1UniqueConstraintError } from "@bickr/shared/d1-errors";
import type { ThreadDocument } from "@bickr/shared/model";
import { kvKeys, type D1DatabaseLike, type D1PreparedStatementLike, type D1Result, type KVNamespaceLike } from "@bickr/shared/storage";

type SqlWrite = { sql: string; bindings: unknown[] };
type KvWrite = { kind: "put"; key: string; value: string; options?: { expirationTtl?: number } } | { kind: "delete"; key: string };
type SavedResponse = { status: number; headers: [string, string][]; body: string };
export type CompactThreadMutationReply =
	| { kind: "thread"; threadId: string; commentId?: string; coordinator: string; status: number; allowDeleted: boolean }
	| { kind: "repair"; threadId: string };
export type ThreadMutationReply = CompactThreadMutationReply | { kind: "response"; response: SavedResponse };
export type ThreadMutationPlan = {
	reply?: CompactThreadMutationReply;
	id: string;
	createdAt: number;
	requestHash: string;
	receiptKey: string;
	response: SavedResponse;
	thread: ThreadDocument | null;
	sql: SqlWrite[];
	kv: KvWrite[];
	/** Creation starts at the forum writer, then commits at the new thread's writer. */
	handoffThreadId?: string;
};

type MutationReceipt = { requestHash: string; expiresAt: number; reply: ThreadMutationReply };
const pendingKey = "thread-mutation/pending";
const canonicalKey = "thread-mutation/canonical";
const receiptPrefix = "thread-mutation/receipt/";
const expiryPrefix = "thread-mutation/expiry/";
// Receipts contain result identities, not historical thread snapshots. A vote
// or reply therefore costs a fixed amount even on a large thread. Receipts
// expire after 30 days. Each mutation/alarm removes at most 25 expired
// receipts. Their indexed expiry also schedules a cleanup alarm when idle.
const receiptLifetimeMs = 30 * 24 * 60 * 60_000;
// A document/plan can exceed the SQLite 2 MB value limit. Split JSON into small
// values and publish their count in the same DO transaction as the content.
const chunkCharacters = 32_768;
type BlobStorage = Pick<DurableObjectStorage, "get" | "put" | "delete">;

export async function readLargeJson<T>(storage: BlobStorage, key: string): Promise<T | undefined> {
	const count = await storage.get<number>(key);
	if (count === undefined) return undefined;
	const parts: string[] = [];
	for (let index = 0; index < count; index += 1) {
		const part = await storage.get<string>(`${key}/${index}`);
		if (part === undefined) throw new Error("Incomplete durable mutation record.");
		parts.push(part);
	}
	return JSON.parse(parts.join("")) as T;
}

async function deleteLargeJson(storage: BlobStorage, key: string): Promise<void> {
	const count = await storage.get<number>(key);
	for (let index = 0; index < (count ?? 0); index += 1) await storage.delete(`${key}/${index}`);
	await storage.delete(key);
}

async function writeLargeJson(storage: BlobStorage, key: string, value: unknown): Promise<void> {
	await deleteLargeJson(storage, key);
	const serialized = JSON.stringify(value);
	const count = Math.ceil(serialized.length / chunkCharacters);
	for (let index = 0; index < count; index += 1) await storage.put(`${key}/${index}`, serialized.slice(index * chunkCharacters, (index + 1) * chunkCharacters));
	await storage.put(key, count);
}

export function readCanonicalThread(storage: DurableObjectStorage): Promise<ThreadDocument | undefined> {
	return readLargeJson<ThreadDocument>(storage, canonicalKey);
}

export function readPendingThreadMutation(storage: DurableObjectStorage): Promise<ThreadMutationPlan | undefined> {
	return readLargeJson<ThreadMutationPlan>(storage, pendingKey);
}

export async function threadMutationIdentity(request: Request) {
	const body = request.method === "GET" ? "" : await request.clone().text();
	const identity = JSON.stringify([request.method, new URL(request.url).pathname, request.headers.get("x-bickr-bot-id"), request.headers.get("x-bickr-user-id"), body]);
	return { requestHash: await digest(identity), receiptKey: receiptPrefix + await digest(request.headers.get("x-bickr-idempotency-key") ?? crypto.randomUUID()) };
}

export async function replayThreadMutationReceipt(storage: DurableObjectStorage, identity: { requestHash: string; receiptKey: string }): Promise<ThreadMutationReply | undefined> {
	const receipt = await readLargeJson<MutationReceipt>(storage, identity.receiptKey);
	if (!receipt || receipt.expiresAt <= Date.now()) return undefined;
	if (receipt.requestHash !== identity.requestHash) throw new RepositoryError("conflict", "The mutation key was already used for a different request.", 409);
	return receipt.reply;
}

export async function commitThreadMutation(storage: DurableObjectStorage, db: D1DatabaseLike, coordinatorId: string, plan: ThreadMutationPlan): Promise<void> {
	// Non-thread operations must remain small. Thread responses always use the
	// explicit compact descriptor supplied by their response producer.
	if (!plan.reply && new TextEncoder().encode(plan.response.body).byteLength > 65_536) throw new Error("Mutation receipt exceeds its size bound.");
	// Discovery is published first. A recovery request must pass this same
	// coordinator queue, so it cannot clear the wake while commit is in flight.
	await db.prepare(`INSERT INTO thread_mutation_wakes (coordinator_id, next_attempt_at) VALUES (?, ?)
		ON CONFLICT(coordinator_id) DO UPDATE SET next_attempt_at = excluded.next_attempt_at`)
		.bind(coordinatorId, new Date().toISOString()).run();
	await storage.transaction(async (transaction) => {
		await writeLargeJson(transaction, pendingKey, plan);
		if (plan.thread && !plan.handoffThreadId) await writeLargeJson(transaction, canonicalKey, plan.thread);
		const expiresAt = plan.createdAt + receiptLifetimeMs;
		await writeLargeJson(transaction, plan.receiptKey, { requestHash: plan.requestHash, expiresAt, reply: plan.reply ?? { kind: "response", response: plan.response } } satisfies MutationReceipt);
		await transaction.put(`${expiryPrefix}${String(expiresAt).padStart(16, "0")}/${plan.id}`, plan.receiptKey);
		await transaction.setAlarm(Date.now() + 1_000);
	});
}

export async function replayThreadMutation(
	storage: DurableObjectStorage,
	db: D1DatabaseLike,
	kv: KVNamespaceLike,
	coordinatorId: string,
	handoff: (threadId: string, plan: ThreadMutationPlan) => Promise<void>,
): Promise<void> {
	const plan = await readPendingThreadMutation(storage);
	if (plan) {
		if (plan.handoffThreadId) {
			await handoff(plan.handoffThreadId, { ...plan, handoffThreadId: undefined });
		} else {
			for (const write of plan.kv) {
				if (write.kind === "put") await kv.put(write.key, write.value, write.options);
				else await kv.delete(write.key);
			}
			// D1 batch is atomic. A duplicate first receipt aborts the complete
			// batch before any statement can repeat. Other failures stay retryable.
			try {
				await db.batch([
					db.prepare(`INSERT INTO thread_projection_receipts (plan_id, coordinator_id) VALUES (?, ?)`).bind(plan.id, coordinatorId),
					...plan.sql.map((write) => db.prepare(write.sql).bind(...write.bindings)),
				]);
			} catch (error) {
				if (!isD1UniqueConstraintError(error) || !await db.prepare(`SELECT plan_id FROM thread_projection_receipts WHERE plan_id = ?`).bind(plan.id).first()) throw error;
			}
		}
		await storage.transaction(async (transaction) => deleteLargeJson(transaction, pendingKey));
	}
	await db.batch([
		db.prepare(`DELETE FROM thread_projection_receipts WHERE coordinator_id = ?`).bind(coordinatorId),
		db.prepare(`DELETE FROM thread_mutation_wakes WHERE coordinator_id = ?`).bind(coordinatorId),
	]);
}

export async function pruneThreadMutationReceipts(storage: DurableObjectStorage): Promise<void> {
	const expired = await storage.list<string>({ prefix: expiryPrefix, end: `${expiryPrefix}${String(Date.now()).padStart(16, "0")}/~`, limit: 25 });
	if (expired.size === 0) return;
	await storage.transaction(async (transaction) => {
		for (const [key, receiptKey] of expired) {
			const receipt = await readLargeJson<MutationReceipt>(transaction, receiptKey);
			const indexedExpiry = Number(key.slice(expiryPrefix.length).split("/")[0]);
			if (receipt?.expiresAt === indexedExpiry) await deleteLargeJson(transaction, receiptKey);
			await transaction.delete(key);
		}
	});
}

export async function nextThreadMutationAlarm(storage: DurableObjectStorage): Promise<number | undefined> {
	if (await storage.get(pendingKey) !== undefined) return Date.now() + 1_000;
	const first = (await storage.list<string>({ prefix: expiryPrefix, limit: 1 })).keys().next().value as string | undefined;
	return first ? Math.max(Date.now() + 1_000, Number(first.slice(expiryPrefix.length).split("/")[0])) : undefined;
}

export async function saveResponse(response: Response): Promise<SavedResponse> {
	return { status: response.status, headers: [...response.headers.entries()], body: await response.text() };
}

export function restoreResponse(response: SavedResponse): Response {
	return new Response(response.body, { status: response.status, headers: response.headers });
}

async function digest(value: string): Promise<string> {
	return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Builds a bounded write plan while every validation/read still uses real D1. */
export function stageThreadMutation(kv: KVNamespaceLike, db: D1DatabaseLike) {
	const sql: SqlWrite[] = [];
	const writes: KvWrite[] = [];
	let thread: ThreadDocument | null = null;
	class Statement implements D1PreparedStatementLike {
		readonly query: string;
		readonly bindings: unknown[];
		constructor(query: string, bindings: unknown[] = []) { this.query = query; this.bindings = bindings; }
		bind(...bindings: unknown[]) { return new Statement(this.query, bindings); }
		first<T>() { return db.prepare(this.query).bind(...this.bindings).first<T>(); }
		all<T>() { return db.prepare(this.query).bind(...this.bindings).all<T>(); }
		async run(): Promise<D1Result> {
			sql.push({ sql: this.query, bindings: this.bindings });
			return { success: true, meta: { changes: 1 } };
		}
	}
	const database: D1DatabaseLike = {
		writesDeferred: true,
		prepare: (query) => new Statement(query),
		batch: async (statements) => {
			const results: D1Result[] = [];
			for (const statement of statements) {
				if (!(statement instanceof Statement)) throw new Error("A staged batch contained an external statement.");
				results.push(await statement.run());
			}
			return results;
		},
	};
	const stagedKv: KVNamespaceLike = {
		get: async (key, options) => {
			const pending = writes.findLast((write) => write.key === key);
			if (!pending) return kv.get(key, options);
			return pending.kind === "delete" ? null : options?.type === "json" ? JSON.parse(pending.value) : pending.value;
		},
		put: async (key, value, options) => {
			writes.push({ kind: "put", key, value, ...(options ? { options } : {}) });
			if (key.startsWith(kvKeys.thread(""))) thread = JSON.parse(value) as ThreadDocument;
		},
		delete: async (key) => { writes.push({ kind: "delete", key }); },
	};
	return { database, kv: stagedKv, sql, writes, thread: () => thread };
}
