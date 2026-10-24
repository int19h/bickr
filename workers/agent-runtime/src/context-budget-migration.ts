import { contextWindowTokensMin, type BotDocument } from '@bickr/shared/model';
import { assertContextWindowTokens, RepositoryError } from '@bickr/shared/repository';
import { kvKeys, readJson, writeJson, type D1DatabaseLike, type KVNamespaceLike } from '@bickr/shared/storage';
import { InputError } from '@bickr/shared/validation';
import { parseBotCreateLifecycleRequest } from './lifecycle/bot-create-request';
import { addInternalServiceAuthHeader, internalServiceUrl } from '@bickr/shared/internal-service';
import { withStandaloneTimeout } from './provider/sse';
import { runtimeMaintenanceDispatchTimeoutMs } from './constants';
import type { Env } from './types';

export const contextBudgetMigrationVersion = 1;
export const contextBudgetMigrationBatchSize = 25;
export type ContextBudgetMigrationResult =
	| { kind: 'migrated' | 'unchanged'; documentChanged: boolean; indexChanged: boolean; creationRequestsChanged: number }
	| { kind: 'missing' };

export type ContextBudgetMigrationCursor =
	| { kind: 'indexed'; afterId: string }
	| { kind: 'creations'; afterId: string }
	| { kind: 'documents'; afterCursor: string };

export function contextBudgetMigrationCursor(value: unknown): ContextBudgetMigrationCursor {
	if (value === undefined || value === '') return { kind: 'indexed', afterId: '' };
	if (value && typeof value === 'object' && 'kind' in value) {
		if ((value.kind === 'indexed' || value.kind === 'creations') && 'afterId' in value && typeof value.afterId === 'string' && value.afterId.length <= 256) return { kind: value.kind, afterId: value.afterId };
		if (value.kind === 'documents' && 'afterCursor' in value && typeof value.afterCursor === 'string' && value.afterCursor.length <= 4096) return { kind: 'documents', afterCursor: value.afterCursor };
	}
	throw new InputError('The migration cursor must identify an indexed, creations, or documents page.');
}

// Run only under the owner's coordinator queue. Reads never call this writer.
// After both fleet passes report no changes or missing documents, advance the
// document schemaVersion past 2 and remove this module, its two routes,
// and the execution safeguard in runBotCreateOperation.
// The operator retains the cursor and page evidence. No sweep state is stored.
export async function migrateOwnedContextBudget(
	kv: KVNamespaceLike, db: D1DatabaseLike, botId: string, ownerUserId: string,
	now = new Date().toISOString(),
): Promise<ContextBudgetMigrationResult> {
	// Saved creation input is executable state. Keep its original request hash
	// as the client identity, but migrate the input that recovery will execute.
	const operations = (await db.prepare(`SELECT operation_id AS id, owner_user_id AS owner, request_json AS request, revision, phase
		FROM entity_lifecycle_operations WHERE entity_kind = 'bot' AND entity_id = ? AND action = 'create' AND request_json IS NOT NULL
		ORDER BY operation_id LIMIT ?`).bind(botId, contextBudgetMigrationBatchSize + 1)
		.all<{ id: string; owner: string; request: string; revision: number; phase: string }>()).results ?? [];
	if (operations.length > contextBudgetMigrationBatchSize) throw new RepositoryError('conflict', 'Participant creation records exceed the migration batch bound.', 409);
	const bot = await readJson<BotDocument>(kv, kvKeys.bot(botId));
	if (!bot) {
		const entity = await db.prepare("SELECT owner_user_id AS owner, phase, active_operation_id AS operationId FROM entity_lifecycle_entities WHERE entity_kind = 'bot' AND entity_id = ?")
			.bind(botId).first<{ owner: string; phase: string; operationId: string }>();
		const operation = operations.find(operation => operation.id === entity?.operationId);
		// Creation can stop before KV exists. Compensation can stop after KV
		// deletion. Neither state permits restoring a document during the sweep.
		const expectedAbsence = entity?.owner === ownerUserId && operation && (
			((entity.phase === 'pending' || entity.phase === 'materializing') && (operation.phase === 'pending' || operation.phase === 'materializing')) ||
			(entity.phase === 'compensating' && operation.phase === 'compensating'));
		if (!expectedAbsence) return { kind: 'missing' };
	}
	let creationRequestsChanged = 0;
	for (const operation of operations) {
		const request = parseBotCreateLifecycleRequest(operation.request);
		if (operation.owner !== ownerUserId || request.userId !== ownerUserId || request.botId !== botId) throw new RepositoryError('conflict', 'Creation ownership does not match the migration.', 409);
		const budget = request.input.tickSettings?.contextWindowTokens;
		if (typeof budget !== 'number' || budget >= contextWindowTokensMin) { assertContextWindowTokens(budget); continue; }
		const migrated = { ...request, input: { ...request.input, tickSettings: { ...request.input.tickSettings, contextWindowTokens: contextWindowTokensMin } } };
		const result = await db.prepare(`UPDATE entity_lifecycle_operations SET request_json = ?, revision = revision + 1, updated_at = ?
			WHERE operation_id = ? AND owner_user_id = ? AND revision = ? AND request_json = ?`)
			.bind(JSON.stringify(migrated), now, operation.id, ownerUserId, operation.revision, operation.request).run();
		// D1 also counts writes from the lifecycle recovery trigger.
		if ((result.meta?.changes ?? 0) < 1) throw new RepositoryError('conflict', 'Participant creation changed during migration. Retry the same page.', 409);
		creationRequestsChanged++;
	}
	if (!bot) return { kind: creationRequestsChanged ? 'migrated' : 'unchanged', documentChanged: false, indexChanged: false, creationRequestsChanged };
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
		db.prepare('UPDATE objects_index SET revision = ?, updated_at = ? WHERE object_id = ? AND object_type = ?')
			.bind(next.revision, next.updatedAt, botId, 'bot'),
	]);
	const indexChanged = (results[0]?.meta?.changes ?? 0) > 0;
	return { kind: documentChanged || indexChanged || creationRequestsChanged ? 'migrated' : 'unchanged', documentChanged, indexChanged, creationRequestsChanged };
}

type FleetResult = { botId: string; result: ContextBudgetMigrationResult };

export async function migrateContextBudgetPage(
	env: Pick<Env, 'BICKR_D1' | 'BICKR_KV' | 'USER_BOTS' | 'INTERNAL_SERVICE_SECRET'>,
	cursor: ContextBudgetMigrationCursor = { kind: 'indexed', afterId: '' },
) {
	let rows: { botId: string; ownerUserId: string; afterId: string }[];
	let nextCursor: ContextBudgetMigrationCursor | null;
	switch (cursor.kind) {
		case 'indexed': {
			const page = await env.BICKR_D1.prepare(`SELECT bot_id AS botId, owner_user_id AS ownerUserId FROM bots_index WHERE bot_id > ?
				UNION SELECT bot_id AS botId, owner_user_id AS ownerUserId FROM bot_runtime_index WHERE bot_id > ?
				UNION SELECT entity_id AS botId, owner_user_id AS ownerUserId FROM entity_lifecycle_entities WHERE entity_kind = 'bot' AND entity_id > ?
				ORDER BY botId LIMIT ?`).bind(cursor.afterId, cursor.afterId, cursor.afterId, contextBudgetMigrationBatchSize).all<{ botId: string; ownerUserId: string }>();
			rows = (page.results ?? []).map(row => ({ botId: row.botId, ownerUserId: row.ownerUserId, afterId: row.botId }));
			nextCursor = rows.length < contextBudgetMigrationBatchSize ? { kind: 'creations', afterId: '' } : { kind: 'indexed', afterId: rows.at(-1)!.afterId };
			break;
		}
		case 'creations': {
			const page = await env.BICKR_D1.prepare(`SELECT entity_id AS botId, owner_user_id AS ownerUserId, operation_id AS afterId
				FROM entity_lifecycle_operations WHERE operation_id > ? AND entity_kind = 'bot' AND action = 'create' AND request_json IS NOT NULL
				ORDER BY operation_id LIMIT ?`).bind(cursor.afterId, contextBudgetMigrationBatchSize).all<{ botId: string; ownerUserId: string; afterId: string }>();
			rows = page.results ?? [];
			nextCursor = rows.length < contextBudgetMigrationBatchSize ? { kind: 'documents', afterCursor: '' } : { kind: 'creations', afterId: rows.at(-1)!.afterId };
			break;
		}
		case 'documents': {
			const page = await env.BICKR_KV.list({ prefix: kvKeys.bot(''), limit: contextBudgetMigrationBatchSize, ...(cursor.afterCursor ? { cursor: cursor.afterCursor } : {}) });
			rows = [];
			for (const key of page.keys) {
				const bot = await readJson<BotDocument>(env.BICKR_KV, key.name);
				if (!bot || bot.type !== 'bot' || kvKeys.bot(bot.id) !== key.name || typeof bot.ownerUserId !== 'string') throw new RepositoryError('conflict', 'Participant document is missing or invalid. Retry the same page.', 409);
				rows.push({ botId: bot.id, ownerUserId: bot.ownerUserId, afterId: '' });
			}
			nextCursor = page.list_complete ? null : { kind: 'documents', afterCursor: page.cursor };
			break;
		}
	}
	const results: FleetResult[] = [];
	const changes = { documents: 0, indexes: 0, creationRequests: 0 };
	let after: ContextBudgetMigrationCursor = cursor;
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
		if (result.kind === 'missing') return { schemaVersion: contextBudgetMigrationVersion, changes, results, done: false, nextCursor: after };
		changes.documents += Number(result.documentChanged);
		changes.indexes += Number(result.indexChanged);
		changes.creationRequests += result.creationRequestsChanged;
		if (cursor.kind !== 'documents') after = { kind: cursor.kind, afterId: row.afterId };
	}
	return { schemaVersion: contextBudgetMigrationVersion, changes, results, done: nextCursor === null, nextCursor };
}

function migrationResult(value: unknown): ContextBudgetMigrationResult {
	if (value && typeof value === 'object' && 'kind' in value) {
		if (value.kind === 'missing') return { kind: 'missing' };
		if ((value.kind === 'migrated' || value.kind === 'unchanged') &&
			'documentChanged' in value && typeof value.documentChanged === 'boolean' &&
			'indexChanged' in value && typeof value.indexChanged === 'boolean' &&
			'creationRequestsChanged' in value && typeof value.creationRequestsChanged === 'number' && Number.isSafeInteger(value.creationRequestsChanged) && value.creationRequestsChanged >= 0 && value.creationRequestsChanged <= contextBudgetMigrationBatchSize) {
			return { kind: value.kind, documentChanged: value.documentChanged, indexChanged: value.indexChanged, creationRequestsChanged: value.creationRequestsChanged };
		}
	}
	throw new RepositoryError('server_error', 'Context budget migration returned an invalid result.', 502);
}
