import { describe, expect, it, vi } from "vitest";
import { localizedText, type AccountDeletionResult } from "@bickr/shared/model";
import { applyAccountDeletionResult } from "./profile-deletion";

describe("account deletion client state", () => {
	it.each<{ result: AccountDeletionResult; message: string }>([
		{
			result: {
				kind: "account_delete_pending",
				planned: { worlds: 9, forums: 9, bots: 9 },
			},
			message: "Profile deletion accepted.",
		},
		{
			result: {
				kind: "account_delete_complete",
				profile: {
					id: "usr_deleted",
					handle: "deleted-usr_deleted",
					language: null,
					displayName: localizedText("Deleted profile", null),
					profileComplete: true,
				},
				deleted: { worlds: 0, forums: 0, bots: 0 },
			},
			message: "Deleted profile.",
		},
	])("clears local authenticated state and reports $result.kind", ({ result, message }) => {
		const clearLocalSession = vi.fn();

		expect(applyAccountDeletionResult(result, clearLocalSession)).toBe(message);

		expect(clearLocalSession).toHaveBeenCalledOnce();
	});
});
