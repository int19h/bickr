import type { AccountDeletionResult } from "@bickr/shared/model";

export function applyAccountDeletionResult(
	result: AccountDeletionResult,
	clearLocalSession: () => void,
): "Profile deletion accepted." | "Deleted profile." {
	switch (result.kind) {
		case "account_delete_pending":
			clearLocalSession();
			return "Profile deletion accepted.";
		case "account_delete_complete":
			clearLocalSession();
			return "Deleted profile.";
		default:
			return exhaustiveAccountDeletionResult(result);
	}
}

function exhaustiveAccountDeletionResult(result: never): never {
	throw new Error(`Unsupported account deletion result: ${String(result)}`);
}
