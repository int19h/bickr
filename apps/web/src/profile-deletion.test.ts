import { describe, expect, it, vi } from "vitest";
import { localizedText, type AccountDeletionResult } from "@bickr/shared/model";
import { applyAccountDeletionResult } from "./profile-deletion";

describe("account deletion client state", () => {
	it.each<AccountDeletionResult>([
		{
			kind: "account_delete_pending",
			deleted: { worlds: 9, forums: 9, bots: 9 },
		},
		{
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
	])("clears local authenticated state for $kind", (result) => {
		const clearLocalSession = vi.fn();

		applyAccountDeletionResult(result, clearLocalSession);

		expect(clearLocalSession).toHaveBeenCalledOnce();
	});
});
