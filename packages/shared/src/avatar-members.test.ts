import { describe, expect, it, vi } from "vitest";
import { worldAvatarMembers } from "./avatar-members";
import type { D1DatabaseLike } from "./storage";

describe("world avatar profile projection", () => {
	it("gets one bounded set and reports when more profiles exist", async () => {
		const rows = Array.from({ length: 101 }, (_, i) => ({
			handle: `member-${i}`, displayName: `Member ${i}`, displayNameLang: null, shortBio: `Bio ${i}`, shortBioLang: null,
		}));
		const all = vi.fn().mockResolvedValue({ results: rows });
		const bind = vi.fn(() => ({ all }));
		const prepare = vi.fn(() => ({ bind }));
		const selection = await worldAvatarMembers({ prepare } as unknown as D1DatabaseLike, "world");
		expect(selection.kind).toBe("sample");
		expect(selection.members).toHaveLength(100);
		expect(selection.members[99]?.shortBio.text).toBe("Bio 99");
		expect(prepare).toHaveBeenCalledOnce();
		expect(bind).toHaveBeenCalledExactlyOnceWith("world", 101);
		expect(all).toHaveBeenCalledOnce();
	});
});
