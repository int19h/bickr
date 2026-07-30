import { type D1DatabaseLike, type D1PreparedStatementLike } from "./storage";

export type ObjectIndexRepairScope =
	| { kind: "forum"; forumId: string }
	| { kind: "world"; worldId: string };

export function objectIndexScopeStaleStatement(
	db: D1DatabaseLike,
	scope: ObjectIndexRepairScope,
	options: { includeScopeRoot?: boolean; requireLiveScopeRoot?: boolean } = {},
): D1PreparedStatementLike {
	const includeScopeRoot = options.includeScopeRoot ?? true;
	const requireLiveScopeRoot = options.requireLiveScopeRoot ?? false;
	if (scope.kind === "world") {
		return db
			.prepare(
				`UPDATE objects_index
				 SET index_version = 0
				 WHERE world_id = ? AND deleted_at IS NULL
				   ${includeScopeRoot ? "" : "AND object_id <> ?"}
				   ${requireLiveScopeRoot ? "AND EXISTS (SELECT 1 FROM worlds_index WHERE world_id = ? AND deleted_at IS NULL)" : ""}`,
			)
			.bind(
				scope.worldId,
				...(!includeScopeRoot ? [scope.worldId] : []),
				...(requireLiveScopeRoot ? [scope.worldId] : []),
			);
	}
	return db
		.prepare(
			`UPDATE objects_index
			 SET index_version = 0
			 WHERE deleted_at IS NULL
			   ${requireLiveScopeRoot ? "AND EXISTS (SELECT 1 FROM forums_index WHERE forum_id = ? AND deleted_at IS NULL)" : ""}
			   AND (
				${includeScopeRoot ? "object_id = ? OR" : ""} object_id IN (
					SELECT thread_id
					FROM threads_index
					WHERE forum_id = ? AND deleted_at IS NULL
				)
			   )`,
		)
		.bind(
			...(requireLiveScopeRoot ? [scope.forumId] : []),
			...(includeScopeRoot ? [scope.forumId] : []),
			scope.forumId,
		);
}
