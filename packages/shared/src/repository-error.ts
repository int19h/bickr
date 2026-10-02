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

