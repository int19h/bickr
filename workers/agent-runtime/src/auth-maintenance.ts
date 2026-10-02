import { ok } from "@bickr/shared/api";
import { finishLegacyAuthMigration, legacyAuthPrefixes, migrateLegacyAuthPage, type LegacyAuthPrefix } from "@bickr/shared/auth-migration";
import { cleanupAuthRecords } from "@bickr/shared/auth-store";
import { readBoundedRequest } from "@bickr/shared/bounded-body";
import { isTrustedInternalServiceRequest } from "@bickr/shared/internal-service";
import { readMaintenanceState } from "@bickr/shared/maintenance";
import { RepositoryError } from "@bickr/shared/repository";
import { InputError } from "@bickr/shared/validation";
import type { AgentRuntimeRouteContext } from "./lifecycle/types";

type Action = { kind: "status" } | { kind: "cleanup" } | { kind: "finish" }
	| { kind: "dry_run"; prefix: LegacyAuthPrefix; cursor?: string }
	| { kind: "migrate"; prefix: LegacyAuthPrefix };

function actionFromUnknown(value: unknown): Action {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("Choose an authentication maintenance action.");
	const row = value as Record<string, unknown>;
	if (row.kind === "status" || row.kind === "cleanup" || row.kind === "finish") return { kind: row.kind };
	if ((row.kind === "dry_run" || row.kind === "migrate") && typeof row.prefix === "string" && Object.hasOwn(legacyAuthPrefixes, row.prefix)) {
		if (row.cursor !== undefined && (row.kind !== "dry_run" || typeof row.cursor !== "string" || row.cursor.length > 4096)) {
			throw new InputError("Only dry runs accept a cursor of at most 4096 characters.");
		}
		return row.kind === "migrate" ? { kind: row.kind, prefix: row.prefix as LegacyAuthPrefix }
			: { kind: row.kind, prefix: row.prefix as LegacyAuthPrefix, ...(typeof row.cursor === "string" ? { cursor: row.cursor } : {}) };
	}
	throw new InputError("Choose a supported authentication maintenance action and prefix.");
}

export async function handleAuthMaintenance(context: AgentRuntimeRouteContext): Promise<Response> {
	const { request, env } = context;
	if (!isTrustedInternalServiceRequest(request, env.INTERNAL_SERVICE_SECRET) || request.headers.get("x-bickr-scheduler") !== "1") {
		throw new RepositoryError("unauthorized", "Authentication is required.", 401);
	}
	const bytes = await readBoundedRequest(request, { maxBytes: 8192, timeoutMs: 10_000 });
	let value: unknown;
	try { value = JSON.parse(new TextDecoder().decode(bytes)); }
	catch { throw new InputError("The maintenance request must contain valid JSON."); }
	const action = actionFromUnknown(value);
	if (action.kind === "status") {
		const transition = await env.BICKR_D1.prepare("SELECT schema_version AS schemaVersion, legacy_until AS legacyUntil FROM auth_storage_transition WHERE id = 1").first();
		const progress = await env.BICKR_D1.prepare("SELECT prefix, cursor, completed_at AS completedAt FROM auth_migration_progress ORDER BY prefix LIMIT 8").all();
		return ok({ transition, progress: progress.results ?? [] });
	}
	if (action.kind === "cleanup") return ok({ deleted: await cleanupAuthRecords(env.BICKR_D1) });
	if (action.kind !== "dry_run" && !(await readMaintenanceState(env.BICKR_D1)).enabled) {
		throw new RepositoryError("conflict", "Enable site maintenance before changing authentication migration state.", 409);
	}
	if (action.kind === "finish") return ok({ complete: await finishLegacyAuthMigration(env.BICKR_D1) });
	return ok(await migrateLegacyAuthPage(env.BICKR_KV, env.BICKR_D1, {
		prefix: action.prefix, dryRun: action.kind === "dry_run",
		...(action.kind === "dry_run" && action.cursor ? { cursor: action.cursor } : {}),
	}));
}
