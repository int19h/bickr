import type { ApiErrorDetails } from "./model";

export class RepositoryError extends Error {
	readonly code: "bad_request" | "conflict" | "forbidden" | "not_found" | "server_error" | "unauthorized";
	readonly status: number;
	readonly details?: RepositoryErrorDetails;

	constructor(
		code: "bad_request" | "conflict" | "forbidden" | "not_found" | "server_error" | "unauthorized",
		message: string,
		status: number,
		details?: RepositoryErrorDetails,
	) {
		super(message);
		this.name = "RepositoryError";
		this.code = code;
		this.status = status;
		this.details = details;
	}
}

export type RepositoryErrorDetails = ApiErrorDetails;

// A KV mismatch cannot prove that a saved creation is invalid. Keep the
// creation recoverable even when repeated reads exceed the normal retry limit.
export type LifecycleKvReadIssue = 'participant_identity' | 'participant_revision' | 'participant_budget' | 'owner_document' | 'clone_source_document' | 'avatar_document';

export class LifecycleKvReadError extends RepositoryError {
	readonly issue: LifecycleKvReadIssue;
	constructor(issue: LifecycleKvReadIssue) {
		super('server_error', 'A stored document is not ready for creation recovery. Retry later.', 503);
		this.name = 'LifecycleKvReadError';
		this.issue = issue;
	}
}
