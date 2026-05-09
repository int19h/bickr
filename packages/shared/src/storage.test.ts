import { describe, expect, it } from "vitest";
import { retryCloudflareOperation, setCloudflareRetryTestHooks } from "./cloudflare";
import { deleteKey, type KVNamespaceLike, writeJson } from "./storage";

describe("Cloudflare retry helpers", () => {
	it("retries KV writes after a rate-limit failure", async () => {
		const delays: number[] = [];
		const restore = setCloudflareRetryTestHooks({
			random: () => 0,
			sleep: async (milliseconds) => {
				delays.push(milliseconds);
			},
		});
		try {
			const kv = new ScriptedKV({ putErrors: [rateLimitError()] });

			await writeJson(kv, "v1:test:key", { ok: true });

			expect(kv.putCalls).toBe(2);
			expect(kv.putValues).toEqual([JSON.stringify({ ok: true })]);
			expect(delays).toEqual([1_100]);
		} finally {
			restore();
		}
	});

	it("does not retry non-rate-limit KV write failures", async () => {
		const delays: number[] = [];
		const restore = setCloudflareRetryTestHooks({
			sleep: async (milliseconds) => {
				delays.push(milliseconds);
			},
		});
		try {
			const kv = new ScriptedKV({ putErrors: [new Error("permission denied")] });

			await expect(writeJson(kv, "v1:test:key", { ok: false })).rejects.toThrow("permission denied");

			expect(kv.putCalls).toBe(1);
			expect(delays).toEqual([]);
		} finally {
			restore();
		}
	});

	it("stops retrying KV writes after the configured attempt limit", async () => {
		const delays: number[] = [];
		const restore = setCloudflareRetryTestHooks({
			random: () => 0,
			sleep: async (milliseconds) => {
				delays.push(milliseconds);
			},
		});
		try {
			const kv = new ScriptedKV({
				putErrors: [rateLimitError(), rateLimitError(), rateLimitError(), rateLimitError(), rateLimitError()],
			});

			await expect(writeJson(kv, "v1:test:key", { ok: false })).rejects.toThrow("Too Many Requests");

			expect(kv.putCalls).toBe(5);
			expect(delays).toEqual([1_100, 2_200, 4_400, 8_000]);
		} finally {
			restore();
		}
	});

	it("retries KV deletes after a rate-limit failure", async () => {
		const delays: number[] = [];
		const restore = setCloudflareRetryTestHooks({
			random: () => 0,
			sleep: async (milliseconds) => {
				delays.push(milliseconds);
			},
		});
		try {
			const kv = new ScriptedKV({ deleteErrors: [rateLimitError()] });

			await deleteKey(kv, "v1:test:key");

			expect(kv.deleteCalls).toBe(2);
			expect(delays).toEqual([1_100]);
		} finally {
			restore();
		}
	});

	it("supports injected sleep for idempotent Cloudflare binding retries", async () => {
		const delays: number[] = [];
		let attempts = 0;

		const result = await retryCloudflareOperation({
			operation: "Vectorize upsert",
			maxAttempts: 3,
			initialDelayMs: 10,
			maxDelayMs: 100,
			random: () => 0,
			sleep: async (milliseconds) => {
				delays.push(milliseconds);
			},
			run: async () => {
				attempts += 1;
				if (attempts < 3) {
					throw rateLimitError();
				}
				return "ok";
			},
		});

		expect(result).toBe("ok");
		expect(attempts).toBe(3);
		expect(delays).toEqual([10, 20]);
	});
});

class ScriptedKV implements KVNamespaceLike {
	readonly putValues: string[] = [];
	putCalls = 0;
	deleteCalls = 0;
	private readonly putErrors: unknown[];
	private readonly deleteErrors: unknown[];

	constructor(options: { putErrors?: unknown[]; deleteErrors?: unknown[] }) {
		this.putErrors = [...(options.putErrors ?? [])];
		this.deleteErrors = [...(options.deleteErrors ?? [])];
	}

	async get(): Promise<unknown> {
		return null;
	}

	async put(_key: string, value: string): Promise<void> {
		this.putCalls += 1;
		const error = this.putErrors.shift();
		if (error) {
			throw error;
		}
		this.putValues.push(value);
	}

	async delete(): Promise<void> {
		this.deleteCalls += 1;
		const error = this.deleteErrors.shift();
		if (error) {
			throw error;
		}
	}
}

function rateLimitError(): Error & { status: number } {
	return Object.assign(new Error("KV PUT failed: 429 Too Many Requests"), { status: 429 });
}
