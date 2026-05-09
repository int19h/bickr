import { fail } from "@bickr/shared/api";
import { RepositoryError } from "@bickr/shared/repository";
import { InputError } from "@bickr/shared/validation";
import { AuthRequiredError, ProfileIncompleteError } from "./_auth";

export function pageErrorResponse(error: unknown): Response {
	if (error instanceof AuthRequiredError) {
		return fail("unauthorized", error.message, 401);
	}
	if (error instanceof ProfileIncompleteError) {
		return fail("forbidden", error.message, 403);
	}
	if (error instanceof RepositoryError) {
		return fail(error.code, error.message, error.status, error.details);
	}
	if (error instanceof InputError) {
		return fail("bad_request", error.message, 400);
	}
	if (error instanceof Error && error.message.includes("application/json")) {
		return fail("bad_request", error.message, 400);
	}

	console.error("pages api error", error);
	return fail("server_error", "Unexpected API error.", 500);
}
