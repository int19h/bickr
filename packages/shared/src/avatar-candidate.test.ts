import { describe, expect, it, vi } from "vitest";
import { promoteAvatarCandidate, storeAvatarImage, type AvatarStorageTarget } from "./avatar-storage";
import type { AvatarImage } from "./model";

const targets: AvatarStorageTarget[] = [
	{ target: "bot", botId: "one", worldId: "world" },
	{ target: "bot", botId: "two", worldId: "world" },
	{ target: "bot", botId: "one", worldId: "other-world" },
	{ target: "world", worldId: "world" },
	{ target: "world", worldId: "other-world" },
	{ target: "user", userId: "owner" },
	{ target: "user", userId: "another-owner" },
];
const bytes = new Uint8Array([0xff, 0xd8, 0xff]);

describe("avatar candidate ownership", () => {
	it("only promotes a candidate generated for the exact destination", async () => {
		for (const source of targets) {
			const bucket = { put: vi.fn(), get: vi.fn(async () => ({ arrayBuffer: async () => bytes.buffer })), delete: vi.fn() };
			const candidate = await storeAvatarImage(bucket, {
				...source, bytes, contentType: "image/jpeg", publicBaseUrl: "https://images.example", kind: "avatar-candidates",
			});
			for (const target of targets) {
				bucket.get.mockClear();
				bucket.put.mockClear();
				const operation = promoteAvatarCandidate(bucket, { ...target, candidate, publicBaseUrl: "https://images.example" });
				if (source === target) {
					await expect(operation).resolves.toMatchObject({ contentType: "image/jpeg" });
					expect(bucket.get).toHaveBeenCalledExactlyOnceWith(candidate.key);
				} else {
					await expect(operation).rejects.toThrow("invalid for this target");
					expect(bucket.get).not.toHaveBeenCalled();
					expect(bucket.put).not.toHaveBeenCalled();
				}
			}
		}
	});

	it.each(["users/owner/avatar-candidates/", "users/owner/avatar-candidates/nested/file.jpg", "users/owner/avatars/file.jpg"])("rejects malformed or published source %s before R2 access", async (key) => {
		const bucket = { get: vi.fn(), put: vi.fn(), delete: vi.fn() };
		await expect(promoteAvatarCandidate(bucket, {
			target: "user", userId: "owner", candidate: { key } as AvatarImage, publicBaseUrl: "https://images.example",
		})).rejects.toThrow("invalid for this target");
		expect(bucket.get).not.toHaveBeenCalled();
	});
});
