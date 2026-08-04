import type { UserDocument, UserProfile } from "./model";
import { RepositoryError } from "./repository";

export type AccountMutationResult =
	| { kind: "account_bootstrapped"; profile: UserProfile; user: UserDocument }
	| { kind: "profile_updated"; profile: UserProfile }
	| { kind: "provider_identity_linked"; profile: UserProfile }
	| { kind: "provider_identity_unlinked"; profile: UserProfile };

export function parseAccountMutationResult(value: unknown): AccountMutationResult {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResult();
	// All legacy JSON validation is confined to this wire adapter. Internal
	// consumers receive a discriminated union and switch exhaustively on kind.
	const record = value as Record<string, unknown>;
	switch (record.kind) {
		case "account_bootstrapped":
			if (!isRecord(record.profile) || !isRecord(record.user)) throw invalidResult();
			return { kind: record.kind, profile: record.profile as UserProfile, user: record.user as UserDocument };
		case "profile_updated":
		case "provider_identity_linked":
		case "provider_identity_unlinked":
			if (!isRecord(record.profile)) throw invalidResult();
			return { kind: record.kind, profile: record.profile as UserProfile };
		default:
			throw invalidResult();
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function invalidResult(): RepositoryError {
	return new RepositoryError("server_error", "Account coordinator returned an invalid mutation result.", 500);
}
