import migration0001 from "../../migrations/0001_core_indexes.sql?raw";
import migration0002 from "../../migrations/0002_live_simulation.sql?raw";
import migration0003 from "../../migrations/0003_read_state_spotlight.sql?raw";
import migration0004 from "../../migrations/0004_bot_activity_indexes.sql?raw";
import migration0005 from "../../migrations/0005_human_notifications.sql?raw";
import migration0006 from "../../migrations/0006_user_profile_completion.sql?raw";
import migration0007 from "../../migrations/0007_runtime_pause_nullable_due.sql?raw";
import migration0008RootComments from "../../migrations/0008_root_comments.sql?raw";
import migration0008WorldActivity from "../../migrations/0008_world_activity_indexes.sql?raw";
import migration0009 from "../../migrations/0009_thread_title_lookup.sql?raw";
import migration0010 from "../../migrations/0010_human_profile_owner_indexes.sql?raw";
import migration0011 from "../../migrations/0011_bot_activity_events.sql?raw";
import migration0012 from "../../migrations/0012_iteration_tool_limit.sql?raw";
import migration0013 from "../../migrations/0013_generated_token_limits.sql?raw";
import migration0014 from "../../migrations/0014_compaction_summary_settings.sql?raw";
import migration0015 from "../../migrations/0015_nullable_runtime_context_window.sql?raw";
import migration0016 from "../../migrations/0016_posting_settings.sql?raw";
import migration0017 from "../../migrations/0017_search_entities_fts.sql?raw";
import migration0018 from "../../migrations/0018_exclude_personal_forums_from_search.sql?raw";
import migration0019 from "../../migrations/0019_bot_avatar_url.sql?raw";
import migration0020 from "../../migrations/0020_content_ids.sql?raw";
import migration0021 from "../../migrations/0021_thread_hot_forum_index.sql?raw";
import migration0022 from "../../migrations/0022_bot_avatar_crop.sql?raw";
import migration0023 from "../../migrations/0023_bot_clone_sources.sql?raw";
import migration0024 from "../../migrations/0024_bot_inference_usage.sql?raw";
import migration0025 from "../../migrations/0025_bot_groups.sql?raw";
import migration0026 from "../../migrations/0026_world_prompt_avatar.sql?raw";
import migration0027 from "../../migrations/0027_localized_text.sql?raw";
import migration0028 from "../../migrations/0028_bot_language_system_prompt.sql?raw";
import migration0029 from "../../migrations/0029_user_avatar_crop.sql?raw";
import migration0030 from "../../migrations/0030_global_inference_cost_stats.sql?raw";
import migration0031 from "../../migrations/0031_tombstone_deleted_handles.sql?raw";
import migration0032 from "../../migrations/0032_bot_notification_retention_index.sql?raw";
import migration0033 from "../../migrations/0033_bot_seen_content_retention_index.sql?raw";
import migration0034 from "../../migrations/0034_backfill_vote_activity_events.sql?raw";
import migration0035 from "../../migrations/0035_query_time_thread_hot_score.sql?raw";
import migration0036 from "../../migrations/0036_thread_comment_limits.sql?raw";
import migration0037 from "../../migrations/0037_world_recurring_prompt.sql?raw";
import migration0038 from "../../migrations/0038_maintenance_control.sql?raw";
import migration0039 from "../../migrations/0039_entity_lifecycle.sql?raw";
import migration0040 from "../../migrations/0040_entity_lifecycle_recovery.sql?raw";
import migration0041 from "../../migrations/0041_bot_group_members_bot.sql?raw";
import migration0042 from "../../migrations/0042_inference_configuration_graph.sql?raw";
import migration0043 from "../../migrations/0043_translation_inference_role.sql?raw";

const migrationSql = [
	migration0001,
	migration0002,
	migration0003,
	migration0004,
	migration0005,
	migration0006,
	migration0007,
	migration0008RootComments,
	migration0008WorldActivity,
	migration0009,
	migration0010,
	migration0011,
	migration0012,
	migration0013,
	migration0014,
	migration0015,
	migration0016,
	migration0017,
	migration0018,
	migration0019,
	migration0020,
	migration0021,
	migration0022,
	migration0023,
	migration0024,
	migration0025,
	migration0026,
	migration0027,
	migration0028,
	migration0029,
	migration0030,
	migration0031,
	migration0032,
	migration0033,
	migration0034,
	migration0035,
	migration0036,
	migration0037,
	migration0038,
	migration0039,
	migration0040,
	migration0041,
	migration0042,
	migration0043,
];

type D1SchemaRow = {
	name: string;
	sql: string | null;
	type: "index" | "table" | "trigger" | "view";
};

export async function resetD1Schema(db: D1Database): Promise<void> {
	await dropD1Schema(db);
	await applyD1Migrations(db);
}

export async function applyD1Migrations(db: D1Database): Promise<void> {
	for (const sql of migrationSql) {
		await execD1Statements(db, sql);
	}
}

export async function applyD1LifecycleRecoveryMigration(db: D1Database): Promise<void> {
	await execD1Statements(db, migration0040);
}

export async function execD1Statements(db: D1Database, sql: string): Promise<void> {
	for (const statement of splitD1Statements(sql)) {
		if (statement.trim()) await db.prepare(statement).run();
	}
}

// D1Database.exec currently splits on newlines, so it cannot execute the
// repository's formatted multi-line CREATE statements. This lexer splits only
// at statement-level semicolons and tracks BEGIN/CASE ... END inside triggers;
// it does not guess trigger bodies with a regex.
function splitD1Statements(sql: string): string[] {
	const statements: string[] = [];
	let start = 0;
	let wordStart = -1;
	let quote: "'" | '"' | "`" | "]" | null = null;
	let lineComment = false;
	let blockComment = false;
	let trigger = false;
	const triggerBlocks: Array<"begin" | "case"> = [];
	const leadingTokens: string[] = [];

	const flushWord = (end: number): void => {
		if (wordStart < 0) return;
		const token = sql.slice(wordStart, end).toUpperCase();
		wordStart = -1;
		if (!trigger && leadingTokens.length < 3) {
			leadingTokens.push(token);
			trigger = leadingTokens[0] === "CREATE" && (
				leadingTokens[1] === "TRIGGER" ||
				(["TEMP", "TEMPORARY"].includes(leadingTokens[1] ?? "") && leadingTokens[2] === "TRIGGER")
			);
		}
		if (!trigger) return;
		if (token === "BEGIN") triggerBlocks.push("begin");
		else if (token === "CASE") triggerBlocks.push("case");
		else if (token === "END") triggerBlocks.pop();
	};

	const resetStatement = (nextStart: number): void => {
		start = nextStart;
		trigger = false;
		triggerBlocks.length = 0;
		leadingTokens.length = 0;
	};

	for (let index = 0; index < sql.length; index += 1) {
		const character = sql[index] ?? "";
		const next = sql[index + 1] ?? "";
		if (lineComment) {
			if (character === "\n") lineComment = false;
			continue;
		}
		if (blockComment) {
			if (character === "*" && next === "/") {
				blockComment = false;
				index += 1;
			}
			continue;
		}
		if (quote) {
			if (quote === "]" && character === "]") quote = null;
			else if (quote !== "]" && character === quote) {
				if (next === quote) index += 1;
				else quote = null;
			}
			continue;
		}
		if (character === "-" && next === "-") {
			flushWord(index);
			lineComment = true;
			index += 1;
			continue;
		}
		if (character === "/" && next === "*") {
			flushWord(index);
			blockComment = true;
			index += 1;
			continue;
		}
		if (character === "'" || character === '"' || character === "`" || character === "[") {
			flushWord(index);
			quote = character === "[" ? "]" : character;
			continue;
		}
		if (/[A-Za-z_]/u.test(character)) {
			if (wordStart < 0) wordStart = index;
			continue;
		}
		flushWord(index);
		if (character === ";" && (!trigger || triggerBlocks.length === 0)) {
			statements.push(sql.slice(start, index));
			resetStatement(index + 1);
		}
	}
	flushWord(sql.length);
	statements.push(sql.slice(start));
	return statements;
}

export async function clearKv(kv: KVNamespace): Promise<void> {
	let cursor: string | undefined;
	do {
		const list = await kv.list({ cursor });
		await Promise.all(list.keys.map((key) => kv.delete(key.name)));
		cursor = list.list_complete ? undefined : list.cursor;
	} while (cursor);
}

async function dropD1Schema(db: D1Database): Promise<void> {
	const result = await db
		.prepare(
			`SELECT type, name, sql
			 FROM sqlite_schema
			 WHERE type IN ('table', 'view', 'trigger', 'index')
			   AND name NOT LIKE 'sqlite_%'`,
		)
		.all<D1SchemaRow>();
	const rows = (result.results ?? []).filter((row) => !row.name.toLowerCase().startsWith("_cf_"));
	const virtualTables = rows
		.filter((row) => row.type === "table" && row.sql?.toUpperCase().startsWith("CREATE VIRTUAL TABLE"))
		.map((row) => row.name);
	const shadowTablePrefixes = virtualTables.map((name) => `${name}_`);

	for (const row of rows.filter((item) => item.type === "trigger")) {
		await db.prepare(`DROP TRIGGER IF EXISTS ${sqlIdentifier(row.name)}`).run();
	}
	for (const row of rows.filter((item) => item.type === "view")) {
		await db.prepare(`DROP VIEW IF EXISTS ${sqlIdentifier(row.name)}`).run();
	}
	for (const table of virtualTables) {
		await db.prepare(`DROP TABLE IF EXISTS ${sqlIdentifier(table)}`).run();
	}
	// Migrations create referenced parent tables before referencing children.
	// Reverse schema creation order so restrictive foreign keys remain valid
	// while resetting the isolated test database.
	for (const row of rows.filter((item) => item.type === "table").reverse()) {
		if (virtualTables.includes(row.name) || shadowTablePrefixes.some((prefix) => row.name.startsWith(prefix))) {
			continue;
		}
		if (row.name === "inference_configurations" || row.name === "inference_graph_legacy_projection_entries") {
			// This table deliberately has a restrictive self-FK. D1 enforces it
			// even for DROP TABLE when rows remain, so peel leaves before dropping
			// the test-only schema. Production deletion always uses coordinator
			// transactions and never reaches this teardown path.
			let deleted: number;
			do {
				const result = await db.prepare(
					`DELETE FROM ${sqlIdentifier(row.name)} AS configuration
					 WHERE NOT EXISTS (
						SELECT 1 FROM ${sqlIdentifier(row.name)} AS child
						WHERE child.parent_id = configuration.configuration_id
					 )`,
				).run();
				deleted = result.meta.changes;
			} while (deleted > 0);
		}
		try {
			await db.prepare(`DROP TABLE IF EXISTS ${sqlIdentifier(row.name)}`).run();
		} catch (error) {
			throw new Error(`Failed to drop test table ${row.name}.`, { cause: error });
		}
	}
}

function sqlIdentifier(name: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
		throw new Error(`Unsafe SQL identifier in test schema reset: ${name}`);
	}
	return `"${name}"`;
}
