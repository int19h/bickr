/**
 * Deletion of `human_subscriptions` rows whose scope entity no longer exists.
 *
 * `human_subscriptions` has no time-based retention: a row is a standing human
 * preference and stays valid for as long as the thing it points at does. What
 * bounds the table is therefore the delete paths, and every one of them has to
 * clear the same way — hence one helper rather than an ad-hoc statement per
 * caller.
 *
 * The helper hands back prepared statements instead of running them, because
 * every caller folds them into the same `db.batch` that tombstones the scope
 * entity. That batch is one D1 transaction, so a crash can no longer land
 * between "the thread is deleted" and "its subscription rows are gone" and
 * strand rows nothing will ever look at again. Every statement here is an
 * unconditional `DELETE`, so a retried delete path is idempotent.
 *
 * This module deliberately depends on nothing but the storage types. The callers
 * live on both sides of the `repository` → `social` import edge (participant and
 * account deletion in `repository.ts`, thread and comment deletion in
 * `social.ts`, forum and world deletion in `governance.ts`), so a home in either
 * of those modules would be a cycle.
 *
 * Rows with `active = 0` are deleted here too. An inactive row is an explicit
 * opt-out the reader wants remembered, but only for as long as there is
 * something to be opted out of; once the scope entity dies the row is dead
 * weight that nothing can ever consult again.
 *
 * ## Accepted residual: activation racing deletion
 *
 * Batching closes the crash window, not the concurrency one. A subscribe request
 * validates that its scope entity is alive (`validateHumanSubscriptionTargets`)
 * and then inserts, and the entity can be deleted in between: the delete's batch
 * finds nothing to clear, and the insert then recreates a row pointing at a dead
 * scope. Closing that would need the validation and the insert to share a
 * transaction with every delete path, which the KV-document-plus-D1-projection
 * architecture does not offer — the entity documents these rows point at live in
 * KV, outside any D1 transaction. The residual is judged acceptable: it needs a
 * sub-second interleaving of two human actions, and the surviving row is inert
 * (a subscription to a deleted entity is never resolved into a notification, and
 * the reader can see and clear it). Do not redesign activation for this.
 */

import type { HumanSubscriptionScope } from "./model";
import { d1SafeBoundParameters, type D1DatabaseLike, type D1PreparedStatementLike } from "./storage";

/** A subscription scope whose entity is being deleted. */
export type HumanSubscriptionScopeRef = {
	scopeType: HumanSubscriptionScope;
	scopeId: string;
};

/**
 * Scopes are grouped by `scope_type` and cleared with one `scope_id IN (...)`
 * statement per chunk. That shape hits `human_subscriptions_scope_active`
 * (`scope_type, scope_id, active`) head-on, and the chunk size keeps every
 * statement inside D1's bound-parameter ceiling no matter how many comments a
 * deleted thread carries.
 */
const maxScopeIdsPerStatement = d1SafeBoundParameters - 1;

function humanSubscriptionScopeDeleteSql(scopeIdCount: number): string {
	return `DELETE FROM human_subscriptions
			 WHERE scope_type = ?
			   AND scope_id IN (${Array.from({ length: scopeIdCount }, () => "?").join(", ")})`;
}

/**
 * The statements that clear every row of the given scopes. Repeated scopes
 * collapse, so a caller may pass a scope list built from overlapping sources
 * without paying for the same delete twice; an empty scope set yields no
 * statements at all.
 */
export function humanSubscriptionScopeDeleteStatements(
	db: D1DatabaseLike,
	scopes: readonly HumanSubscriptionScopeRef[],
): D1PreparedStatementLike[] {
	const scopeIdsByType = new Map<HumanSubscriptionScope, Set<string>>();
	for (const scope of scopes) {
		if (!scope.scopeId) {
			continue;
		}
		const existing = scopeIdsByType.get(scope.scopeType);
		if (existing) {
			existing.add(scope.scopeId);
			continue;
		}
		scopeIdsByType.set(scope.scopeType, new Set([scope.scopeId]));
	}
	const statements: D1PreparedStatementLike[] = [];
	for (const [scopeType, scopeIds] of scopeIdsByType) {
		const ids = [...scopeIds];
		for (let index = 0; index < ids.length; index += maxScopeIdsPerStatement) {
			const chunk = ids.slice(index, index + maxScopeIdsPerStatement);
			statements.push(db.prepare(humanSubscriptionScopeDeleteSql(chunk.length)).bind(scopeType, ...chunk));
		}
	}
	return statements;
}

/**
 * Account deletion clears the deleted owner's own rows. The scope rows of the
 * entities that account owned are cleared by the participant, forum, and world
 * deletions the account cascade already runs, so this covers exactly the
 * remainder: subscriptions the account held on entities that outlive it.
 */
export const deleteHumanSubscriptionsForUserSql = `DELETE FROM human_subscriptions WHERE user_id = ?`;
