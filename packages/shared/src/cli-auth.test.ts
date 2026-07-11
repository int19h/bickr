import { describe, expect, it } from "vitest";
import { localizedText } from "./model";
import { type UserDocument } from "./model";
import {
	approveCliAuthRequest,
	createCliAuthRequest,
	deleteCliToken,
	pollCliAuthRequest,
	readCliAuthRequest,
	userForCliToken,
} from "./repository";
import { kvKeys, type KVNamespaceLike } from "./storage";

describe("CLI auth tokens", () => {
	it("issues one-time CLI tokens and stores only hashed token state", async () => {
		const kv = new MapKV();
		await kv.put(kvKeys.user("usr_cli"), JSON.stringify(testUser()));

		const started = await createCliAuthRequest(kv, { label: " laptop " }, new Date("2026-05-25T00:00:00.000Z"));
		expect(started.request.label).toBe("laptop");
		expect(await pollCliAuthRequest(kv, started.deviceCode, new Date("2026-05-25T00:01:00.000Z"))).toEqual({
			status: "pending",
			expiresAt: "2026-05-25T00:10:00.000Z",
		});

		await approveCliAuthRequest(kv, started.deviceCode, "usr_cli", new Date("2026-05-25T00:02:00.000Z"));
		const completed = await pollCliAuthRequest(kv, started.deviceCode, new Date("2026-05-25T00:03:00.000Z"));
		expect(completed.status).toBe("complete");
		if (completed.status !== "complete") {
			throw new Error("Expected completed CLI auth poll.");
		}
		expect(completed.token).toMatch(/^bckr_cli_/);
		expect(kv.serializedValues().some((value) => value.includes(completed.token))).toBe(false);
		expect((await userForCliToken(kv, completed.token, new Date("2026-05-25T00:04:00.000Z")))?.id).toBe("usr_cli");

		await deleteCliToken(kv, completed.token);
		expect(await userForCliToken(kv, completed.token, new Date("2026-05-25T00:05:00.000Z"))).toBeNull();
	});

	it("treats expired approval-page requests as absent without mutating timestamps on read", async () => {
		const kv = new MapKV();
		const started = await createCliAuthRequest(kv, { label: "terminal" }, new Date("2026-05-25T00:00:00.000Z"));

		expect(await readCliAuthRequest(kv, started.deviceCode, new Date("2026-05-25T00:11:00.000Z"))).toBeNull();
		expect(kv.serializedValues()[0]).toContain('"updatedAt":"2026-05-25T00:00:00.000Z"');
	});
});

class MapKV implements KVNamespaceLike {
	private readonly data = new Map<string, string>();

	async get(key: string, options?: { type: "json" }): Promise<unknown> {
		const value = this.data.get(key);
		if (value === undefined) {
			return null;
		}
		return options?.type === "json" ? JSON.parse(value) as unknown : value;
	}

	async put(key: string, value: string): Promise<void> {
		this.data.set(key, value);
	}

	async delete(key: string): Promise<void> {
		this.data.delete(key);
	}

	serializedValues(): string[] {
		return [...this.data.values()];
	}
}

function testUser(): UserDocument {
	return {
		id: "usr_cli",
		type: "user",
		schemaVersion: 1,
		revision: 1,
		handle: "cli-user",
		language: null,
		displayName: localizedText("CLI User", null),
		profileCompletedAt: "2026-05-01T00:00:00.000Z",
		createdAt: "2026-05-01T00:00:00.000Z",
		updatedAt: "2026-05-01T00:00:00.000Z",
	};
}
