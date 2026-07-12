import { type D1DatabaseLike, type D1PreparedStatementLike } from "./storage";

export type ObjectIndexRepairScope =
	| { kind: "forum"; forumId: string }
	| { kind: "world"; worldId: string };

export function objectIndexScopeStaleStatement(
	db: D1DatabaseLike,
	scope: ObjectIndexRepairScope,
	options: { includeScopeRoot?: boolean } = {},
): D1PreparedStatementLike {
	const includeScopeRoot = options.includeScopeRoot ?? true;
	if (scope.kind === "world") {
		return db
			.prepare(
				`UPDATE objects_index
				 SET index_version = 0
				 WHERE world_id = ? AND deleted_at IS NULL
				   ${includeScopeRoot ? "" : "AND object_id <> ?"}`,
			)
			.bind(scope.worldId, ...(!includeScopeRoot ? [scope.worldId] : []));
	}
	return db
		.prepare(
			`UPDATE objects_index
			 SET index_version = 0
			 WHERE deleted_at IS NULL
			   AND (
				${includeScopeRoot ? "object_id = ? OR" : ""} object_id IN (
					SELECT thread_id
					FROM threads_index
					WHERE forum_id = ? AND deleted_at IS NULL
				)
			   )`,
		)
		.bind(...(includeScopeRoot ? [scope.forumId] : []), scope.forumId);
}
