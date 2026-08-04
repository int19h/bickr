import type { CreateWorldInput, WorldSummary } from "./model";
import { RepositoryError } from "./repository";

export type WorldLifecycleMutation =
	| {
			kind: "world_materialize";
			userId: string;
			introForumId: string;
			createdAt: string;
			input: CreateWorldInput;
	  }
	| { kind: "world_compensate"; introForumId: string }
	| { kind: "world_delete"; worldHandle: string };

export type WorldLifecycleMutationResult =
	| { kind: "world_materialized"; world: WorldSummary }
	| { kind: "world_compensated" }
	| { kind: "world_deleted"; world: WorldSummary };

export function parseWorldLifecycleMutationResult(value: unknown): WorldLifecycleMutationResult {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw invalidResult();
	}
	// This is the single wire-format adapter. Consumers receive the
	// discriminated union and must switch on kind rather than infer an internal
	// subsystem result from whichever properties happen to be present.
	const record = value as Record<string, unknown>;
	switch (record.kind) {
		case "world_materialized":
		case "world_deleted":
			if (!record.world || typeof record.world !== "object" || Array.isArray(record.world)) {
				throw invalidResult();
			}
			return { kind: record.kind, world: record.world as WorldSummary };
		case "world_compensated":
			return { kind: record.kind };
		default:
			throw invalidResult();
	}
}

function invalidResult(): RepositoryError {
	return new RepositoryError("server_error", "World lifecycle coordinator returned an invalid result.", 500);
}
