import type { AccountDeletionResult } from "@bickr/shared/model";

export function applyAccountDeletionResult(
	result: AccountDeletionResult,
	clearLocalSession: () => void,
): void {
	switch (result.kind) {
		case "account_delete_pending":
		case "account_delete_complete":
			clearLocalSession();
			return;
		default:
			return exhaustiveAccountDeletionResult(result);
	}
}

function exhaustiveAccountDeletionResult(result: never): never {
	throw new Error(`Unsupported account deletion result: ${String(result)}`);
}
