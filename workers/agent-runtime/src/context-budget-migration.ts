import { contextWindowTokensMin, type BotDocument } from '@bickr/shared/model';
import { assertContextWindowTokens, RepositoryError } from '@bickr/shared/repository';
import { kvKeys, readJson, writeJson, objectIndexProjectionStatement, type D1DatabaseLike, type KVNamespaceLike } from '@bickr/shared/storage';
import { entityIndexVersions } from '@bickr/shared/index-versions';
import { addInternalServiceAuthHeader, internalServiceUrl } from '@bickr/shared/internal-service';
import { withStandaloneTimeout } from './provider/sse';
import { runtimeMaintenanceDispatchTimeoutMs } from './constants';
import type { Env } from './types';

export const contextBudgetMigrationVersion = 1;
export const contextBudgetMigrationBatchSize = 25;
export type ContextBudgetMigrationResult =
	| { kind: 'migrated' | 'unchanged'; documentChanged: boolean; indexChanged: boolean }
	| { kind: 'missing' };

// Run only under the owner's coordinator queue. Reads never call this writer.
// After both fleet passes report no changes or missing documents, advance the
// document schemaVersion past 2 and remove this module and its two routes.
// The operator retains the cursor and page evidence. No sweep state is stored.
export async function migrateOwnedContextBudget(
	kv: KVNamespaceLike, db: D1DatabaseLike, botId: string, ownerUserId: string,
	now = new Date().toISOString(),
): Promise<ContextBudgetMigrationResult> {
	const bot = await readJson<BotDocument>(kv, kvKeys.bot(botId));
	if (!bot) return { kind: 'missing' };
	if (bot.id !== botId || bot.type !== 'bot' || bot.ownerUserId !== ownerUserId) {
		throw new RepositoryError('conflict', 'Participant ownership does not match the migration.', 409);
	}
	const stored = bot.tickSettings?.contextWindowTokens;
	const documentChanged = typeof stored === 'number' && stored < contextWindowTokensMin;
	const value = documentChanged ? contextWindowTokensMin : stored;
	assertContextWindowTokens(value);
	const next: BotDocument = documentChanged ? {
		...bot, tickSettings: { ...bot.tickSettings, contextWindowTokens: value },
		revision: bot.revision + 1, updatedAt: now,
	} : bot;
	if (documentChanged) {
		await writeJson(kv, kvKeys.bot(botId), next);
	}
	// Keep NULL for the default. Replaying after a KV write also finishes this
	// projection without changing the document revision a second time.
	const results = await db.batch([db.prepare(`UPDATE bot_runtime_index SET context_window_tokens = ?
		WHERE bot_id = ? AND owner_user_id = ? AND context_window_tokens IS NOT ?`)
		.bind(value ?? null, botId, ownerUserId, value ?? null),
		db.prepare('UPDATE bots_index SET updated_at = ? WHERE bot_id = ? AND owner_user_id = ? AND updated_at IS NOT ?')
			.bind(next.updatedAt, botId, ownerUserId, next.updatedAt),
		objectIndexProjectionStatement(db, next, 'bot', entityIndexVersions.bot, next.homeWorldId),
	]);
	const indexChanged = (results[0]?.meta?.changes ?? 0) > 0;
	return { kind: documentChanged || indexChanged ? 'migrated' : 'unchanged', documentChanged, indexChanged };
}

type FleetResult = { botId: string; result: ContextBudgetMigrationResult };

export async function migrateContextBudgetPage(
	env: Pick<Env, 'BICKR_D1' | 'USER_BOTS' | 'INTERNAL_SERVICE_SECRET'>, cursor = '',
) {
	// Include pending and deleted participants, plus any retained runtime index.
	const page = await env.BICKR_D1.prepare(`SELECT bot_id AS botId, owner_user_id AS ownerUserId FROM bots_index WHERE bot_id > ?
		UNION SELECT bot_id AS botId, owner_user_id AS ownerUserId FROM bot_runtime_index WHERE bot_id > ?
		ORDER BY botId LIMIT ?`).bind(cursor, cursor, contextBudgetMigrationBatchSize).all<{ botId: string; ownerUserId: string }>();
	const rows = page.results ?? [];
	const results: FleetResult[] = [];
	let after = cursor;
	for (const row of rows) {
		const headers = new Headers({ 'x-bickr-scheduler': '1', 'x-bickr-user-id': row.ownerUserId });
		addInternalServiceAuthHeader(headers, env.INTERNAL_SERVICE_SECRET);
		const result = await withStandaloneTimeout('Context budget migration', runtimeMaintenanceDispatchTimeoutMs, async () => {
			const response = await env.USER_BOTS.get(env.USER_BOTS.idFromName(row.ownerUserId)).fetch(new Request(
				internalServiceUrl(`/users/${encodeURIComponent(row.ownerUserId)}/bots/${encodeURIComponent(row.botId)}/context-budget-migration`),
				{ method: 'POST', headers },
			));
			if (!response.ok) throw new RepositoryError('server_error', 'Context budget migration dispatch failed. Retry the same page.', 502);
			const payload = await response.json() as { data?: { migration?: unknown } };
			return migrationResult(payload.data?.migration);
		});
		results.push({ botId: row.botId, result });
		if (result.kind === 'missing') return { schemaVersion: contextBudgetMigrationVersion, results, done: false, nextCursor: after };
		after = row.botId;
	}
	const done = rows.length < contextBudgetMigrationBatchSize;
	return { schemaVersion: contextBudgetMigrationVersion, results, done, nextCursor: done ? null : after };
}

function migrationResult(value: unknown): ContextBudgetMigrationResult {
	if (value && typeof value === 'object' && 'kind' in value) {
		if (value.kind === 'missing') return { kind: 'missing' };
		if ((value.kind === 'migrated' || value.kind === 'unchanged') &&
			'documentChanged' in value && typeof value.documentChanged === 'boolean' &&
			'indexChanged' in value && typeof value.indexChanged === 'boolean') {
			return { kind: value.kind, documentChanged: value.documentChanged, indexChanged: value.indexChanged };
		}
	}
	throw new RepositoryError('server_error', 'Context budget migration returned an invalid result.', 502);
}
