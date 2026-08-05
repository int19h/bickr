import { isD1UniqueConstraintError } from "./d1-errors";
import { deterministicId, makeId } from "./ids";
import {
	applyInferenceOverridePatch,
	inferenceConfigurationCorruptionSentinel,
	inferenceConfigurationFields,
	inferenceConfigurationOwnerQuota,
	inferenceFieldAnnotations,
	inferenceResolutionFingerprint,
	normalizedInferenceConfigurationName,
	parseInferenceConfigurationOverrides,
	resolveInferenceConfiguration,
	resolveImageSettingsForTarget,
	type EffectiveImageSettings,
	type InferenceConfigurationCredential,
	type InferenceConfigurationField,
	type InferenceConfigurationKind,
	type InferenceConfigurationNode,
	type InferenceConfigurationOverridePatch,
	type InferenceConfigurationOverrides,
	type InferenceConfigurationPath,
	type InferenceFieldAdjustment,
	type InferenceCredentialMode,
	type InferenceCredentialResolution,
	type InferenceOverrideUpdate,
	type InferenceSource,
	type BickrInferenceDefaults,
} from "./inference-configuration";
import { RepositoryError } from "./repository";
import type { D1DatabaseLike, D1PreparedStatementLike } from "./storage";

const maximumPageSize = 100;
const defaultPageSize = 50;

export type InferenceGraphConflictCause =
	| "stale_revision"
	| "duplicate_name"
	| "quota_exceeded"
	| "self_parent"
	| "descendant_parent"
	| "cross_owner"
	| "invalid_parent"
	| "fixed_entry_requires_lifecycle"
	| "account_default_required"
	| "unexpected_unique_conflict";

export class InferenceGraphRepositoryError extends RepositoryError {
	readonly causeKind: InferenceGraphConflictCause | "corrupt_graph";

	constructor(
		causeKind: InferenceGraphRepositoryError["causeKind"],
		message: string,
		status: 400 | 409 | 500 = causeKind === "corrupt_graph" ? 500 : 409,
	) {
		super(status === 500 ? "server_error" : status === 400 ? "bad_request" : "conflict", message, status);
		this.name = "InferenceGraphRepositoryError";
		this.causeKind = causeKind;
	}
}

type ConfigurationPathRow = {
	id: string;
	ownerUserId: string;
	kind: InferenceConfigurationKind;
	parentId: string | null;
	worldId: string | null;
	botId: string | null;
	customName: string | null;
	customNameKey: string | null;
	overridesJson: string;
	revision: number;
	createdAt: string;
	updatedAt: string;
	credentialMode: InferenceCredentialMode;
	secretVersion: number;
	secretValue?: string | null;
	depth: number;
};

const pathColumns = `
	configuration.configuration_id AS id,
	configuration.owner_user_id AS ownerUserId,
	configuration.kind,
	configuration.parent_id AS parentId,
	configuration.world_id AS worldId,
	configuration.bot_id AS botId,
	configuration.custom_name AS customName,
	configuration.custom_name_key AS customNameKey,
	configuration.overrides_json AS overridesJson,
	configuration.revision,
	configuration.created_at AS createdAt,
	configuration.updated_at AS updatedAt,
	credentials.mode AS credentialMode,
	credentials.secret_version AS secretVersion`;

function pathSql(includeSecret: boolean): string {
	return `WITH RECURSIVE configuration_path (
		id, ownerUserId, kind, parentId, worldId, botId, customName,
		customNameKey, overridesJson, revision, createdAt, updatedAt,
		credentialMode, secretVersion${includeSecret ? ", secretValue" : ""}, depth
	) AS (
		SELECT ${pathColumns}${includeSecret ? ", credentials.secret_value AS secretValue" : ""}, 0
		FROM inference_configurations AS configuration
		JOIN inference_configuration_credentials AS credentials
			ON credentials.configuration_id = configuration.configuration_id
			AND credentials.owner_user_id = configuration.owner_user_id
		WHERE configuration.configuration_id = ? AND configuration.owner_user_id = ?
		UNION ALL
		SELECT ${pathColumns}${includeSecret ? ", credentials.secret_value AS secretValue" : ""}, path.depth + 1
		FROM configuration_path AS path
		JOIN inference_configurations AS configuration
			ON configuration.configuration_id = path.parentId
			AND configuration.owner_user_id = path.ownerUserId
		JOIN inference_configuration_credentials AS credentials
			ON credentials.configuration_id = configuration.configuration_id
			AND credentials.owner_user_id = configuration.owner_user_id
		WHERE path.depth < ?
	)
	SELECT * FROM configuration_path
	ORDER BY depth ASC
	LIMIT ?`;
}

const publicPathSql = pathSql(false);
const internalPathSql = pathSql(true);

/**
 * Loads a secret-free path. This is the only path loader available to owner
 * APIs and annotation/list code; its SELECT text cannot retrieve plaintext.
 */
export async function loadInferenceConfigurationPath(
	db: D1DatabaseLike,
	ownerUserId: string,
	configurationId: string,
): Promise<InferenceConfigurationPath> {
	return loadPath(db, ownerUserId, configurationId, false);
}

/** Server-runtime loader. Callers must never serialize the returned path. */
export async function loadInternalInferenceConfigurationPath(
	db: D1DatabaseLike,
	ownerUserId: string,
	configurationId: string,
): Promise<InferenceConfigurationPath> {
	return loadPath(db, ownerUserId, configurationId, true);
}

/**
 * Loads the revision-matched compatibility snapshot used only by cutover
 * version 2. Plaintext still comes from the canonical secret table and is
 * admitted only when its version matches the projected credential envelope.
 */
export async function loadInternalInferenceCompatibilityProjectionPath(
	db: D1DatabaseLike,
	ownerUserId: string,
	configurationId: string,
	expectedGraphRevision: number,
): Promise<InferenceConfigurationPath> {
	const result = await db.prepare(
		`WITH RECURSIVE projection_path (
			id, ownerUserId, kind, parentId, worldId, botId, customName,
			customNameKey, overridesJson, revision, createdAt, updatedAt,
			credentialMode, secretVersion, secretValue, depth
		) AS (
			SELECT entry.configuration_id, entry.owner_user_id, entry.kind,
				entry.parent_id, entry.world_id, entry.bot_id, entry.custom_name,
				entry.custom_name_key, entry.overrides_json,
				entry.configuration_revision, projection.created_at, projection.updated_at,
				entry.credential_mode, entry.credential_secret_version,
				CASE WHEN credentials.secret_version = entry.credential_secret_version
					THEN credentials.secret_value ELSE NULL END,
				0
			FROM inference_graph_legacy_projection_entries AS entry
			JOIN inference_graph_legacy_projections AS projection
				ON projection.owner_user_id = entry.owner_user_id AND projection.graph_revision = ?
			LEFT JOIN inference_configuration_credentials AS credentials
				ON credentials.configuration_id = entry.configuration_id
				AND credentials.owner_user_id = entry.owner_user_id
			WHERE entry.configuration_id = ? AND entry.owner_user_id = ?
			UNION ALL
			SELECT entry.configuration_id, entry.owner_user_id, entry.kind,
				entry.parent_id, entry.world_id, entry.bot_id, entry.custom_name,
				entry.custom_name_key, entry.overrides_json,
				entry.configuration_revision, projection.created_at, projection.updated_at,
				entry.credential_mode, entry.credential_secret_version,
				CASE WHEN credentials.secret_version = entry.credential_secret_version
					THEN credentials.secret_value ELSE NULL END,
				path.depth + 1
			FROM projection_path AS path
			JOIN inference_graph_legacy_projection_entries AS entry
				ON entry.configuration_id = path.parentId AND entry.owner_user_id = path.ownerUserId
			JOIN inference_graph_legacy_projections AS projection
				ON projection.owner_user_id = entry.owner_user_id AND projection.graph_revision = ?
			LEFT JOIN inference_configuration_credentials AS credentials
				ON credentials.configuration_id = entry.configuration_id
				AND credentials.owner_user_id = entry.owner_user_id
			WHERE path.depth < ?
		)
		SELECT * FROM projection_path ORDER BY depth ASC LIMIT ?`,
	).bind(
		expectedGraphRevision,
		configurationId,
		ownerUserId,
		expectedGraphRevision,
		inferenceConfigurationCorruptionSentinel - 1,
		inferenceConfigurationCorruptionSentinel,
	).all<ConfigurationPathRow>();
	const rows = result.results ?? [];
	if (rows.length === 0) {
		throw new InferenceGraphRepositoryError("corrupt_graph", "Current inference compatibility projection entry is missing.");
	}
	if (rows.length >= inferenceConfigurationCorruptionSentinel) {
		throw new InferenceGraphRepositoryError("corrupt_graph", "Inference compatibility projection path exceeds the corruption sentinel.");
	}
	const path = rows.map((row) => configurationNodeFromRow(row, true));
	const root = path.at(-1);
	if (!root || root.kind !== "account_default" || root.parentId !== null) {
		throw new InferenceGraphRepositoryError("corrupt_graph", "Inference compatibility projection path has no Account default.");
	}
	return [path[0]!, ...path.slice(1)];
}

async function loadPath(
	db: D1DatabaseLike,
	ownerUserId: string,
	configurationId: string,
	includeSecret: boolean,
): Promise<InferenceConfigurationPath> {
	const result = await db.prepare(includeSecret ? internalPathSql : publicPathSql)
		.bind(
			configurationId,
			ownerUserId,
			inferenceConfigurationCorruptionSentinel - 1,
			inferenceConfigurationCorruptionSentinel,
		)
		.all<ConfigurationPathRow>();
	const rows = result.results ?? [];
	if (rows.length === 0) {
		const foreignOwner = await db.prepare(
			`SELECT owner_user_id AS ownerUserId FROM inference_configurations WHERE configuration_id = ? LIMIT 1`,
		).bind(configurationId).first<{ ownerUserId: string }>();
		if (foreignOwner && foreignOwner.ownerUserId !== ownerUserId) {
			throw new InferenceGraphRepositoryError("cross_owner", "Inference configuration belongs to another owner.");
		}
		throw new RepositoryError("not_found", "Inference configuration not found.", 404);
	}
	if (rows.length >= inferenceConfigurationCorruptionSentinel) {
		throw new InferenceGraphRepositoryError("corrupt_graph", "Inference configuration path exceeds the corruption sentinel.");
	}
	const path = rows.map((row) => configurationNodeFromRow(row, includeSecret));
	const root = path.at(-1);
	if (!root || root.kind !== "account_default" || root.parentId !== null) {
		throw new InferenceGraphRepositoryError("corrupt_graph", "Inference configuration path does not terminate at Account default.");
	}
	return [path[0]!, ...path.slice(1)];
}

function configurationNodeFromRow(row: ConfigurationPathRow, includeSecret: boolean): InferenceConfigurationNode {
	const credential = credentialFromRow(row, includeSecret);
	const common = {
		id: row.id,
		ownerUserId: row.ownerUserId,
		parentId: row.parentId,
		overrides: parseInferenceConfigurationOverrides(row.overridesJson),
		revision: row.revision,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		credential,
	};
	switch (row.kind) {
		case "account_default":
			if (row.parentId !== null) throw corruptKind(row);
			return { ...common, kind: row.kind };
		case "world":
			if (!row.worldId) throw corruptKind(row);
			return { ...common, kind: row.kind, worldId: row.worldId };
		case "bot":
			if (!row.botId) throw corruptKind(row);
			return { ...common, kind: row.kind, botId: row.botId };
		case "custom":
			if (!row.customName || !row.customNameKey) throw corruptKind(row);
			return { ...common, kind: row.kind, name: row.customName, nameKey: row.customNameKey };
	}
}

function credentialFromRow(row: ConfigurationPathRow, includeSecret: boolean): InferenceConfigurationCredential {
	switch (row.credentialMode) {
		case "inherit": return { mode: "inherit", secretVersion: 0 };
		case "account_default":
			if (row.kind === "account_default") {
				throw new InferenceGraphRepositoryError("corrupt_graph", "Account default has an invalid credential mode.");
			}
			return { mode: "account_default", secretVersion: 0 };
		case "none": return { mode: "none", secretVersion: 0 };
		case "value":
			if (row.secretVersion <= 0 || includeSecret && !row.secretValue) {
				throw new InferenceGraphRepositoryError("corrupt_graph", "Inference configuration credential row is invalid.");
			}
			return includeSecret
				? { mode: "value", secretVersion: row.secretVersion, secret: row.secretValue ?? undefined }
				: { mode: "value", secretVersion: row.secretVersion };
	}
}

function corruptKind(row: ConfigurationPathRow): InferenceGraphRepositoryError {
	return new InferenceGraphRepositoryError("corrupt_graph", `Inference configuration ${row.id} has an invalid stored kind shape.`);
}

const redactedOwnerDtoBrand: unique symbol = Symbol("redactedInferenceConfigurationOwnerDto");

type RedactedInferenceConfigurationDtoBase = {
	readonly [redactedOwnerDtoBrand]: true;
	id: string;
	parentId: string | null;
	displayName: string;
	revision: number;
	overrides: InferenceConfigurationOverrides;
	credential: {
		mode: InferenceCredentialMode;
		available: boolean;
		secretVersion: number;
		resolution: RedactedInferenceCredentialResolution;
	};
	effectiveModel: string;
	imagePreviews: { participant: EffectiveImageSettings; world: EffectiveImageSettings };
	fields: RedactedInferenceFieldDtoMap;
	graphRevision: number;
	fingerprint: string;
};

export type RedactedInferenceConfigurationDto = RedactedInferenceConfigurationDtoBase & InferenceConfigurationEntryIdentity;

export type RedactedInferenceCredentialResolution =
	| { kind: "available"; source: InferenceSource; secretVersion: number }
	| Extract<InferenceCredentialResolution, { kind: "explicit_none" | "unavailable" }>;

/**
 * This public shape is deliberately distinct from the internal resolution
 * types. Adding a secret-bearing member to the resolver cannot silently make
 * it serializable through an owner endpoint.
 */
export type RedactedInferenceFieldDto<K extends InferenceConfigurationField> = {
	override: InferenceOverrideUpdate<K>;
	effective: unknown;
	source: InferenceSource;
	adjustment: InferenceFieldAdjustment;
};

export type RedactedInferenceFieldDtoMap = {
	[K in InferenceConfigurationField]: RedactedInferenceFieldDto<K>;
};

export async function inferenceConfigurationOwnerDto(
	db: D1DatabaseLike,
	ownerUserId: string,
	configurationId: string,
	defaults?: BickrInferenceDefaults,
): Promise<RedactedInferenceConfigurationDto> {
	const path = await loadInferenceConfigurationPath(db, ownerUserId, configurationId);
	const selected = path[0];
	const resolution = resolveInferenceConfiguration(path, { ...(defaults ? { defaults } : {}) });
	const internalAnnotations = inferenceFieldAnnotations(selected.overrides, resolution);
	const control = await inferenceGraphReadVersion(db, ownerUserId);
	const identity = await loadInferenceConfigurationIdentity(db, ownerUserId, selected.id);
	return {
		[redactedOwnerDtoBrand]: true,
		id: selected.id,
		...entryIdentity(identity),
		parentId: selected.parentId,
		displayName: displayName(identity),
		revision: selected.revision,
		overrides: selected.overrides,
		credential: {
			mode: selected.credential.mode,
			available: resolution.effective.credential.kind === "available",
			secretVersion: selected.credential.secretVersion,
			resolution: redactedCredentialResolution(resolution.effective.credential),
		},
		effectiveModel: resolution.effective.model,
		imagePreviews: {
			participant: resolveImageSettingsForTarget(resolution.effective.image, "participant"),
			world: resolveImageSettingsForTarget(resolution.effective.image, "world"),
		},
		fields: Object.fromEntries(inferenceConfigurationFields.map((field) => {
			const annotation = internalAnnotations[field];
			return [field, {
				override: annotation.override,
				effective: annotation.effective,
				source: annotation.source,
				adjustment: annotation.adjustment,
			}];
		})) as RedactedInferenceFieldDtoMap,
		graphRevision: control.graphRevision,
		fingerprint: await inferenceResolutionFingerprint(resolution),
	};
}

function redactedCredentialResolution(
	credential: InferenceCredentialResolution,
): RedactedInferenceCredentialResolution {
	return credential.kind === "available"
		? { kind: credential.kind, source: credential.source, secretVersion: credential.secretVersion }
		: credential;
}

export type InferenceConfigurationIdentity =
	| { kind: "account_default" }
	| { kind: "world"; worldId: string; worldHandle: string }
	| { kind: "bot"; botId: string; botHandle: string; homeWorldId: string; homeWorldHandle: string }
	| { kind: "custom"; name: string };

export type InferenceConfigurationEntryIdentity = {
	[K in InferenceConfigurationKind]: {
		kind: K;
		identity: Extract<InferenceConfigurationIdentity, { kind: K }>;
	};
}[InferenceConfigurationKind];

function entryIdentity(identity: InferenceConfigurationIdentity): InferenceConfigurationEntryIdentity {
	return { kind: identity.kind, identity } as InferenceConfigurationEntryIdentity;
}

function displayName(identity: InferenceConfigurationIdentity): string {
	switch (identity.kind) {
		case "account_default": return "Account default";
		case "world": return `w/${identity.worldHandle}`;
		case "bot": return `u/${identity.botHandle}`;
		case "custom": return identity.name;
	}
}

type InferenceConfigurationSummaryBase = {
	id: string;
	parentId: string | null;
	displayName: string;
	revision: number;
	updatedAt: string;
	credentialMode: InferenceCredentialMode;
	effectiveModel: string;
	parent: ({ id: string; displayName: string; revision: number } & InferenceConfigurationEntryIdentity) | null;
};

export type InferenceConfigurationSummary = InferenceConfigurationSummaryBase & InferenceConfigurationEntryIdentity;

type ConfigurationIdentityRow = {
	kind: InferenceConfigurationKind;
	worldId: string | null;
	worldHandle: string | null;
	botId: string | null;
	botHandle: string | null;
	homeWorldId: string | null;
	homeWorldHandle: string | null;
	customName: string | null;
};

function identityFromRow(row: ConfigurationIdentityRow): InferenceConfigurationIdentity {
	switch (row.kind) {
		case "account_default": return { kind: row.kind };
		case "world":
			if (!row.worldId || !row.worldHandle) throw new InferenceGraphRepositoryError("corrupt_graph", "World inference identity is missing.");
			return { kind: row.kind, worldId: row.worldId, worldHandle: row.worldHandle };
		case "bot":
			if (!row.botId || !row.botHandle || !row.homeWorldId || !row.homeWorldHandle) {
				throw new InferenceGraphRepositoryError("corrupt_graph", "Participant inference identity is missing.");
			}
			return {
				kind: row.kind,
				botId: row.botId,
				botHandle: row.botHandle,
				homeWorldId: row.homeWorldId,
				homeWorldHandle: row.homeWorldHandle,
			};
		case "custom":
			if (!row.customName) throw new InferenceGraphRepositoryError("corrupt_graph", "Custom inference identity is missing.");
			return { kind: row.kind, name: row.customName };
	}
}

async function loadInferenceConfigurationIdentity(
	db: D1DatabaseLike,
	ownerUserId: string,
	configurationId: string,
): Promise<InferenceConfigurationIdentity> {
	const row = await db.prepare(
		`SELECT configuration.kind, configuration.world_id AS worldId, worlds.handle AS worldHandle,
			configuration.bot_id AS botId, bots.handle AS botHandle,
			bots.home_world_id AS homeWorldId, bots.home_world_handle AS homeWorldHandle,
			configuration.custom_name AS customName
		 FROM inference_configurations AS configuration
		 LEFT JOIN worlds_index AS worlds ON worlds.world_id = configuration.world_id
		 LEFT JOIN bots_index AS bots ON bots.bot_id = configuration.bot_id
		 WHERE configuration.owner_user_id = ? AND configuration.configuration_id = ? LIMIT 1`,
	).bind(ownerUserId, configurationId).first<ConfigurationIdentityRow>();
	if (!row) throw new RepositoryError("not_found", "Inference configuration not found.", 404);
	return identityFromRow(row);
}

type SummaryRow = ConfigurationIdentityRow & {
	id: string;
	parentId: string | null;
	displayName: string;
	sortName: string;
	revision: number;
	updatedAt: string;
	credentialMode: InferenceCredentialMode;
};

type BoundedAncestorRow = ConfigurationPathRow & ConfigurationIdentityRow & { displayName: string };

export type InferenceConfigurationPage = {
	items: InferenceConfigurationSummary[];
	nextCursor?: string;
};

export type InferenceConfigurationListInput = {
	cursor?: string;
	limit?: number;
	query?: string;
	kinds?: readonly InferenceConfigurationKind[];
	defaults?: BickrInferenceDefaults;
};

export async function listInferenceConfigurations(
	db: D1DatabaseLike,
	ownerUserId: string,
	input: InferenceConfigurationListInput = {},
): Promise<InferenceConfigurationPage> {
	const limit = boundedPageSize(input.limit);
	const cursor = decodeCursor(input.cursor);
	const query = input.query ? normalizedInferenceConfigurationName(input.query).key : "";
	const kinds = input.kinds?.length ? [...new Set(input.kinds)] : ["account_default", "world", "bot", "custom"];
	const kindPlaceholders = kinds.map(() => "?").join(", ");
	const rows = await db.prepare(
		`WITH summaries AS (
			SELECT configuration.configuration_id AS id, configuration.kind,
				configuration.parent_id AS parentId,
				configuration.world_id AS worldId, worlds.handle AS worldHandle,
				configuration.bot_id AS botId, bots.handle AS botHandle,
				bots.home_world_id AS homeWorldId, bots.home_world_handle AS homeWorldHandle,
				configuration.custom_name AS customName,
				CASE configuration.kind
					WHEN 'account_default' THEN 'Account default'
					WHEN 'world' THEN 'w/' || worlds.handle
					WHEN 'bot' THEN 'u/' || bots.handle
					ELSE configuration.custom_name
				END AS displayName,
				lower(CASE configuration.kind
					WHEN 'account_default' THEN 'Account default'
					WHEN 'world' THEN 'w/' || worlds.handle
					WHEN 'bot' THEN 'u/' || bots.handle
					ELSE configuration.custom_name
				END) AS sortName,
				configuration.revision, configuration.updated_at AS updatedAt,
				credentials.mode AS credentialMode
			FROM inference_configurations AS configuration
			JOIN inference_configuration_credentials AS credentials
				ON credentials.configuration_id = configuration.configuration_id
			LEFT JOIN worlds_index AS worlds ON worlds.world_id = configuration.world_id
			LEFT JOIN bots_index AS bots ON bots.bot_id = configuration.bot_id
			WHERE configuration.owner_user_id = ?
				AND configuration.kind IN (${kindPlaceholders})
				AND (? = '' OR
					(configuration.kind = 'custom' AND configuration.custom_name_key >= ? AND configuration.custom_name_key < ?)
					OR (configuration.kind != 'custom' AND (lower(CASE configuration.kind
						WHEN 'account_default' THEN 'Account default'
						WHEN 'world' THEN 'w/' || worlds.handle ELSE 'u/' || bots.handle END) LIKE ? ESCAPE '\\'
						OR lower(CASE configuration.kind WHEN 'world' THEN worlds.handle WHEN 'bot' THEN bots.handle ELSE '' END) LIKE ? ESCAPE '\\')))
		)
		SELECT * FROM summaries
		WHERE sortName > ? OR (sortName = ? AND id > ?)
		ORDER BY sortName ASC, id ASC
		LIMIT ?`,
	).bind(
		ownerUserId,
		...kinds,
		query,
		query,
		prefixUpperBound(query),
		`${escapeLike(query)}%`,
		`${escapeLike(query)}%`,
		cursor.sortName,
		cursor.sortName,
		cursor.id,
		limit + 1,
	).all<SummaryRow>();
	const pageRows = (rows.results ?? []).slice(0, limit);
	const ancestors = await loadBoundedInferenceAncestors(db, ownerUserId, pageRows.map((row) => row.id));
	return {
		items: summariesFromAncestors(pageRows, ancestors, input.defaults),
		...(rows.results && rows.results.length > limit && pageRows.length > 0
			? { nextCursor: encodeCursor(pageRows[pageRows.length - 1]!) }
			: {}),
	};
}

/**
 * Server-only, set-oriented loader for a bounded consumer batch. It returns the
 * union of the selected rows and all ancestors, including secrets for runtime
 * parity/resolution, without scanning unrelated owner configurations.
 */
export async function loadInternalInferenceConfigurationAncestors(
	db: D1DatabaseLike,
	ownerUserId: string,
	configurationIds: readonly string[],
): Promise<InferenceConfigurationNode[]> {
	if (configurationIds.length === 0) return [];
	if (configurationIds.length > maximumPageSize) {
		throw new InferenceGraphRepositoryError("corrupt_graph", "Internal inference configuration batch exceeds its query bound.");
	}
	const result = await db.prepare(
		`WITH RECURSIVE selected(id) AS (SELECT value FROM json_each(?)), ancestors(id) AS (
			SELECT id FROM selected
			UNION
			SELECT configuration.parent_id
			FROM inference_configurations AS configuration
			JOIN ancestors ON ancestors.id = configuration.configuration_id
			WHERE configuration.owner_user_id = ? AND configuration.parent_id IS NOT NULL
		)
		SELECT ${pathColumns}, credentials.secret_value AS secretValue, 0 AS depth
		FROM ancestors
		JOIN inference_configurations AS configuration
			ON configuration.configuration_id = ancestors.id AND configuration.owner_user_id = ?
		JOIN inference_configuration_credentials AS credentials
			ON credentials.configuration_id = configuration.configuration_id
			AND credentials.owner_user_id = configuration.owner_user_id
		ORDER BY configuration.configuration_id ASC LIMIT ?`,
	).bind(JSON.stringify(configurationIds), ownerUserId, ownerUserId, inferenceConfigurationCorruptionSentinel)
		.all<ConfigurationPathRow>();
	const rows = result.results ?? [];
	if (rows.length >= inferenceConfigurationCorruptionSentinel) {
		throw new InferenceGraphRepositoryError("corrupt_graph", "Internal inference configuration ancestors exceed the corruption sentinel.");
	}
	return rows.map((row) => configurationNodeFromRow(row, true));
}

function pathFromSnapshot(
	selected: InferenceConfigurationNode,
	byId: ReadonlyMap<string, InferenceConfigurationNode>,
): InferenceConfigurationPath {
	const result: InferenceConfigurationNode[] = [];
	const seen = new Set<string>();
	let current: InferenceConfigurationNode | undefined = selected;
	while (current) {
		if (seen.has(current.id)) throw new InferenceGraphRepositoryError("corrupt_graph", "Inference configuration owner snapshot contains a cycle.");
		seen.add(current.id);
		result.push(current);
		if (result.length >= inferenceConfigurationCorruptionSentinel) {
			throw new InferenceGraphRepositoryError("corrupt_graph", "Inference configuration owner snapshot path exceeds the corruption sentinel.");
		}
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	const root = result.at(-1);
	if (!root || root.kind !== "account_default") {
		throw new InferenceGraphRepositoryError("corrupt_graph", "Inference configuration owner snapshot path has no Account default.");
	}
	return [result[0]!, ...result.slice(1)];
}

export function inferenceConfigurationPathFromSnapshot(
	selected: InferenceConfigurationNode,
	snapshot: readonly InferenceConfigurationNode[],
): InferenceConfigurationPath {
	return pathFromSnapshot(selected, new Map(snapshot.map((node) => [node.id, node])));
}

type BoundedInferenceAncestors = {
	byId: ReadonlyMap<string, InferenceConfigurationNode>;
	displayNames: ReadonlyMap<string, string>;
	identities: ReadonlyMap<string, InferenceConfigurationIdentity>;
};

/**
 * Loads only the union of the requested page rows and their ancestors. The
 * VALUES seed is bounded by the public page limit, UNION deduplicates shared
 * ancestors, and the 10,001-row sentinel detects a corrupt over-quota graph.
 */
async function loadBoundedInferenceAncestors(
	db: D1DatabaseLike,
	ownerUserId: string,
	configurationIds: readonly string[],
): Promise<BoundedInferenceAncestors> {
	if (configurationIds.length === 0) return { byId: new Map(), displayNames: new Map(), identities: new Map() };
	if (configurationIds.length > maximumPageSize) {
		throw new InferenceGraphRepositoryError("corrupt_graph", "Inference configuration page exceeds its query bound.");
	}
	const result = await db.prepare(
		`WITH RECURSIVE selected(id) AS (SELECT value FROM json_each(?)), ancestors(id) AS (
			SELECT id FROM selected
			UNION
			SELECT configuration.parent_id
			FROM inference_configurations AS configuration
			JOIN ancestors ON ancestors.id = configuration.configuration_id
			WHERE configuration.owner_user_id = ? AND configuration.parent_id IS NOT NULL
		)
		SELECT ${pathColumns}, 0 AS depth,
			configuration.world_id AS worldId, worlds.handle AS worldHandle,
			configuration.bot_id AS botId, bots.handle AS botHandle,
			bots.home_world_id AS homeWorldId, bots.home_world_handle AS homeWorldHandle,
			configuration.custom_name AS customName,
			CASE configuration.kind
				WHEN 'account_default' THEN 'Account default'
				WHEN 'world' THEN 'w/' || worlds.handle
				WHEN 'bot' THEN 'u/' || bots.handle
				ELSE configuration.custom_name
			END AS displayName
		FROM ancestors
		JOIN inference_configurations AS configuration
			ON configuration.configuration_id = ancestors.id AND configuration.owner_user_id = ?
		JOIN inference_configuration_credentials AS credentials
			ON credentials.configuration_id = configuration.configuration_id
			AND credentials.owner_user_id = configuration.owner_user_id
		LEFT JOIN worlds_index AS worlds ON worlds.world_id = configuration.world_id
		LEFT JOIN bots_index AS bots ON bots.bot_id = configuration.bot_id
		ORDER BY configuration.configuration_id ASC
		LIMIT ?`,
	).bind(JSON.stringify(configurationIds), ownerUserId, ownerUserId, inferenceConfigurationCorruptionSentinel).all<BoundedAncestorRow>();
	const rows = result.results ?? [];
	if (rows.length >= inferenceConfigurationCorruptionSentinel) {
		throw new InferenceGraphRepositoryError("corrupt_graph", "Inference configuration page ancestors exceed the corruption sentinel.");
	}
	const nodes = rows.map((row) => configurationNodeFromRow(row, false));
	return {
		byId: new Map(nodes.map((node) => [node.id, node])),
		identities: new Map(rows.map((row) => [row.id, identityFromRow(row)])),
		displayNames: new Map(rows.map((row) => {
			if (!row.displayName) {
				throw new InferenceGraphRepositoryError("corrupt_graph", "Inference configuration display metadata is missing.");
			}
			return [row.id, row.displayName];
		})),
	};
}

function boundedPageSize(limit: number | undefined): number {
	if (limit === undefined) return defaultPageSize;
	if (!Number.isInteger(limit) || limit < 1) throw new RepositoryError("bad_request", "Page limit must be a positive integer.", 400);
	return Math.min(limit, maximumPageSize);
}

type PageCursor = { sortName: string; id: string };

function encodeCursor(row: Pick<SummaryRow, "sortName" | "id">): string {
	return btoa(JSON.stringify({ sortName: row.sortName, id: row.id } satisfies PageCursor));
}

function decodeCursor(cursor: string | undefined): PageCursor {
	if (!cursor) return { sortName: "", id: "" };
	try {
		const value = JSON.parse(atob(cursor)) as unknown;
		if (isRecord(value) && typeof value.sortName === "string" && typeof value.id === "string") {
			return { sortName: value.sortName, id: value.id };
		}
	} catch {
		// Parsing failures all map to one typed public input error.
	}
	throw new RepositoryError("bad_request", "Invalid inference configuration cursor.", 400);
}

function prefixUpperBound(value: string): string {
	return `${value}\uffff`;
}

function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export type ParentCandidatePage = InferenceConfigurationPage;

export async function listInferenceTranslationCandidates(
	db: D1DatabaseLike,
	ownerUserId: string,
	input: Omit<InferenceConfigurationListInput, "kinds"> = {},
): Promise<InferenceConfigurationPage> {
	return listInferenceConfigurations(db, ownerUserId, {
		...input,
		kinds: ["account_default", "custom"],
	});
}

export async function listInferenceParentCandidates(
	db: D1DatabaseLike,
	ownerUserId: string,
	configurationId: string,
	input: Omit<InferenceConfigurationListInput, "kinds"> = {},
): Promise<ParentCandidatePage> {
	const selected = await loadInferenceConfigurationPath(db, ownerUserId, configurationId);
	if (selected[0].kind === "account_default") return { items: [] };
	const limit = boundedPageSize(input.limit);
	const cursor = decodeCursor(input.cursor);
	const query = input.query ? normalizedInferenceConfigurationName(input.query).key : "";
	const rows = await db.prepare(
		`WITH RECURSIVE descendants(id) AS (
			SELECT configuration_id FROM inference_configurations
			WHERE configuration_id = ? AND owner_user_id = ?
			UNION
			SELECT child.configuration_id
			FROM inference_configurations AS child
			JOIN descendants ON child.parent_id = descendants.id
			WHERE child.owner_user_id = ?
		), summaries AS (
			SELECT configuration.configuration_id AS id, configuration.kind,
				configuration.parent_id AS parentId,
				configuration.world_id AS worldId, worlds.handle AS worldHandle,
				configuration.bot_id AS botId, bots.handle AS botHandle,
				bots.home_world_id AS homeWorldId, bots.home_world_handle AS homeWorldHandle,
				configuration.custom_name AS customName,
				CASE configuration.kind
					WHEN 'account_default' THEN 'Account default'
					WHEN 'world' THEN 'w/' || worlds.handle
					WHEN 'bot' THEN 'u/' || bots.handle
					ELSE configuration.custom_name
				END AS displayName,
				lower(CASE configuration.kind
					WHEN 'account_default' THEN 'Account default'
					WHEN 'world' THEN 'w/' || worlds.handle
					WHEN 'bot' THEN 'u/' || bots.handle
					ELSE configuration.custom_name
				END) AS sortName,
				configuration.revision, configuration.updated_at AS updatedAt,
				credentials.mode AS credentialMode
			FROM inference_configurations AS configuration
			JOIN inference_configuration_credentials AS credentials
				ON credentials.configuration_id = configuration.configuration_id
			LEFT JOIN worlds_index AS worlds ON worlds.world_id = configuration.world_id
			LEFT JOIN bots_index AS bots ON bots.bot_id = configuration.bot_id
			WHERE configuration.owner_user_id = ?
				AND NOT EXISTS (SELECT 1 FROM descendants WHERE descendants.id = configuration.configuration_id)
				AND (? = '' OR
					(configuration.kind = 'custom' AND configuration.custom_name_key >= ? AND configuration.custom_name_key < ?)
					OR (configuration.kind != 'custom' AND (lower(CASE configuration.kind
						WHEN 'account_default' THEN 'Account default'
						WHEN 'world' THEN 'w/' || worlds.handle ELSE 'u/' || bots.handle END) LIKE ? ESCAPE '\\'
						OR lower(CASE configuration.kind WHEN 'world' THEN worlds.handle WHEN 'bot' THEN bots.handle ELSE '' END) LIKE ? ESCAPE '\\')))
		)
		SELECT * FROM summaries
		WHERE sortName > ? OR (sortName = ? AND id > ?)
		ORDER BY sortName ASC, id ASC LIMIT ?`,
	).bind(
		configurationId, ownerUserId, ownerUserId, ownerUserId,
		query, query, prefixUpperBound(query), `${escapeLike(query)}%`, `${escapeLike(query)}%`,
		cursor.sortName, cursor.sortName, cursor.id, limit + 1,
	).all<SummaryRow>();
	const pageRows = (rows.results ?? []).slice(0, limit);
	const ancestors = await loadBoundedInferenceAncestors(db, ownerUserId, pageRows.map((row) => row.id));
	return {
		items: summariesFromAncestors(pageRows, ancestors, input.defaults),
		...(rows.results && rows.results.length > limit && pageRows.length > 0
			? { nextCursor: encodeCursor(pageRows[pageRows.length - 1]!) }
			: {}),
	};
}

function summariesFromAncestors(
	rows: readonly SummaryRow[],
	ancestors: BoundedInferenceAncestors,
	defaults?: BickrInferenceDefaults,
): InferenceConfigurationSummary[] {
	const { byId, displayNames, identities } = ancestors;
	return rows.map((row) => {
		const node = byId.get(row.id);
		if (!node) throw new InferenceGraphRepositoryError("corrupt_graph", "List entry is missing from the owner graph snapshot.");
		const parentNode = node.parentId ? byId.get(node.parentId) : undefined;
		const {
			kind: _kind, sortName: _sortName, worldId: _worldId, worldHandle: _worldHandle,
			botId: _botId, botHandle: _botHandle, homeWorldId: _homeWorldId,
			homeWorldHandle: _homeWorldHandle, customName: _customName, ...summary
		} = row;
		return {
			...summary,
			...entryIdentity(identities.get(row.id) ?? corruptIdentity(row.id)),
			effectiveModel: resolveInferenceConfiguration(
				pathFromSnapshot(node, byId),
				{ ...(defaults ? { defaults } : {}) },
			).effective.model,
			parent: parentNode ? {
				id: parentNode.id,
				displayName: displayNames.get(parentNode.id) ?? corruptParentDisplayName(parentNode.id),
				revision: parentNode.revision,
				...entryIdentity(identities.get(parentNode.id) ?? corruptIdentity(parentNode.id)),
			} : null,
		};
	});
}

export async function listImmediateInferenceChildren(
	db: D1DatabaseLike,
	ownerUserId: string,
	parentId: string,
	input: Omit<InferenceConfigurationListInput, "kinds" | "query"> = {},
): Promise<InferenceConfigurationPage> {
	await loadInferenceConfigurationPath(db, ownerUserId, parentId);
	const limit = boundedPageSize(input.limit);
	const cursor = decodeIdCursor(input.cursor);
	const rows = await db.prepare(
		`SELECT configuration.configuration_id AS id, configuration.kind,
			configuration.parent_id AS parentId,
			configuration.world_id AS worldId, worlds.handle AS worldHandle,
			configuration.bot_id AS botId, bots.handle AS botHandle,
			bots.home_world_id AS homeWorldId, bots.home_world_handle AS homeWorldHandle,
			configuration.custom_name AS customName,
			CASE configuration.kind WHEN 'world' THEN 'w/' || worlds.handle WHEN 'bot' THEN 'u/' || bots.handle ELSE configuration.custom_name END AS displayName,
			configuration.revision, configuration.updated_at AS updatedAt,
			credentials.mode AS credentialMode
		FROM inference_configurations AS configuration
		JOIN inference_configuration_credentials AS credentials ON credentials.configuration_id = configuration.configuration_id
		LEFT JOIN worlds_index AS worlds ON worlds.world_id = configuration.world_id
		LEFT JOIN bots_index AS bots ON bots.bot_id = configuration.bot_id
		WHERE configuration.owner_user_id = ? AND configuration.parent_id = ? AND configuration.configuration_id > ?
		ORDER BY configuration.configuration_id ASC LIMIT ?`,
	).bind(ownerUserId, parentId, cursor, limit + 1).all<Omit<SummaryRow, "sortName">>();
	const page = (rows.results ?? []).slice(0, limit);
	const ancestors = await loadBoundedInferenceAncestors(db, ownerUserId, page.map((row) => row.id));
	const { byId, displayNames, identities } = ancestors;
	return {
		items: page.map((row) => {
			const node = byId.get(row.id);
			if (!node) throw new InferenceGraphRepositoryError("corrupt_graph", "Child entry is missing from the owner graph snapshot.");
			const parent = node.parentId ? byId.get(node.parentId) : undefined;
			const {
				kind: _kind, worldId: _worldId, worldHandle: _worldHandle, botId: _botId,
				botHandle: _botHandle, homeWorldId: _homeWorldId,
				homeWorldHandle: _homeWorldHandle, customName: _customName, ...summary
			} = row;
			return {
				...summary,
				...entryIdentity(identities.get(row.id) ?? corruptIdentity(row.id)),
				effectiveModel: resolveInferenceConfiguration(
					pathFromSnapshot(node, byId),
					{ ...(input.defaults ? { defaults: input.defaults } : {}) },
				).effective.model,
				parent: parent ? {
					id: parent.id,
					displayName: displayNames.get(parent.id) ?? corruptParentDisplayName(parent.id),
					revision: parent.revision,
					...entryIdentity(identities.get(parent.id) ?? corruptIdentity(parent.id)),
				} : null,
			};
		}),
		...(rows.results && rows.results.length > limit && page.length > 0 ? { nextCursor: btoa(page[page.length - 1]!.id) } : {}),
	};
}

function corruptParentDisplayName(configurationId: string): never {
	throw new InferenceGraphRepositoryError(
		"corrupt_graph",
		`Inference configuration parent ${configurationId} is missing display metadata.`,
	);
}

function corruptIdentity(configurationId: string): never {
	throw new InferenceGraphRepositoryError(
		"corrupt_graph",
		`Inference configuration ${configurationId} is missing identity metadata.`,
	);
}

function decodeIdCursor(cursor: string | undefined): string {
	if (!cursor) return "";
	try {
		const value = atob(cursor);
		if (value) return value;
	} catch {
		// Fall through to the typed public error.
	}
	throw new RepositoryError("bad_request", "Invalid inference configuration cursor.", 400);
}

export type InferenceImpactChangeCounts = {
	effectiveModel: number;
	effectiveBaseUrl: number;
	credentialAvailability: number;
	credentialSource: number;
	providerAccess: number;
};

export type InferenceImpactWarning =
	| { kind: "effective_model_changes"; configurations: number }
	| { kind: "effective_base_url_changes"; configurations: number }
	| { kind: "credential_availability_changes"; configurations: number }
	| { kind: "credential_source_changes"; configurations: number }
	| { kind: "provider_access_changes"; configurations: number };

type InferenceDependentImpact = {
	configurationId: string;
	immediateDependentCount: number;
	transitiveDependentCount: number;
	affectedConfigurationCount: number;
	changes: InferenceImpactChangeCounts;
	warnings: InferenceImpactWarning[];
};

export type InferenceParentImpact = InferenceDependentImpact & {
	kind: "reparent";
	candidateParentId: string;
};

export type InferenceDeleteImpact = InferenceDependentImpact & {
	kind: "delete";
	parentId: string;
	/** Compatibility alias for clients shipped with the first Phase-3 draft. */
	immediateChildren: number;
	resetsTranslationSelection: boolean;
};

export async function inferenceConfigurationParentImpact(
	db: D1DatabaseLike,
	ownerUserId: string,
	configurationId: string,
	candidateParentId: string,
	defaults?: BickrInferenceDefaults,
): Promise<InferenceParentImpact> {
	await loadInferenceConfigurationPath(db, ownerUserId, configurationId);
	const snapshot = await loadBoundedOwnerInferenceSnapshot(db, ownerUserId);
	const byId = new Map(snapshot.map((node) => [node.id, node]));
	const selected = byId.get(configurationId);
	if (!selected) throw new InferenceGraphRepositoryError("corrupt_graph", "Inference impact selection is missing from the owner snapshot.");
	if (selected.kind === "account_default") {
		throw new InferenceGraphRepositoryError("account_default_required", "Account default cannot have a parent.");
	}
	const candidate = byId.get(candidateParentId);
	if (!candidate) {
		const foreignOwner = await db.prepare(
			`SELECT owner_user_id AS ownerUserId FROM inference_configurations WHERE configuration_id = ? LIMIT 1`,
		).bind(candidateParentId).first<{ ownerUserId: string }>();
		if (foreignOwner && foreignOwner.ownerUserId !== ownerUserId) {
			throw new InferenceGraphRepositoryError("cross_owner", "Inference configuration belongs to another owner.");
		}
		throw new InferenceGraphRepositoryError("invalid_parent", "Inference configuration parent not found.", 400);
	}
	if (candidate.id === selected.id) {
		throw new InferenceGraphRepositoryError("self_parent", "A configuration cannot parent itself.");
	}
	const dependents = inferenceConfigurationDependents(snapshot, selected.id);
	if (dependents.some((dependent) => dependent.id === candidate.id)) {
		throw new InferenceGraphRepositoryError("descendant_parent", "A configuration cannot be parented to its descendant.");
	}
	const after = new Map(byId);
	after.set(selected.id, inferenceNodeWithParent(selected, candidate.id));
	const affectedIds = [selected.id, ...dependents.map((dependent) => dependent.id)];
	const changes = compareInferenceResolutions(affectedIds, byId, after, defaults);
	return {
		kind: "reparent",
		configurationId,
		candidateParentId,
		immediateDependentCount: dependents.filter((dependent) => dependent.depth === 1).length,
		transitiveDependentCount: dependents.length,
		affectedConfigurationCount: affectedIds.length,
		changes,
		warnings: inferenceImpactWarnings(changes),
	};
}

export async function inferenceConfigurationDeleteImpact(
	db: D1DatabaseLike,
	ownerUserId: string,
	configurationId: string,
	defaults?: BickrInferenceDefaults,
): Promise<InferenceDeleteImpact> {
	await loadInferenceConfigurationPath(db, ownerUserId, configurationId);
	const snapshot = await loadBoundedOwnerInferenceSnapshot(db, ownerUserId);
	const byId = new Map(snapshot.map((node) => [node.id, node]));
	const selected = byId.get(configurationId);
	if (!selected) throw new InferenceGraphRepositoryError("corrupt_graph", "Inference impact selection is missing from the owner snapshot.");
	if (selected.kind !== "custom" || !selected.parentId) {
		throw new InferenceGraphRepositoryError("fixed_entry_requires_lifecycle", "Only custom configurations can be deleted independently.");
	}
	const dependents = inferenceConfigurationDependents(snapshot, selected.id);
	const after = new Map(byId);
	after.delete(selected.id);
	for (const dependent of dependents) {
		if (dependent.depth === 1) {
			after.set(dependent.id, inferenceNodeWithParent(dependent.node, selected.parentId));
		}
	}
	const affectedIds = dependents.map((dependent) => dependent.id);
	const changes = compareInferenceResolutions(affectedIds, byId, after, defaults);
	const row = await db.prepare(
		`SELECT EXISTS(SELECT 1 FROM inference_translation_selections
			WHERE owner_user_id = ? AND configuration_id = ?) AS resetsTranslationSelection`,
	).bind(ownerUserId, configurationId).first<{ resetsTranslationSelection: number }>();
	const immediate = dependents.filter((dependent) => dependent.depth === 1).length;
	return {
		kind: "delete",
		configurationId,
		parentId: selected.parentId,
		immediateChildren: immediate,
		immediateDependentCount: immediate,
		transitiveDependentCount: dependents.length,
		affectedConfigurationCount: affectedIds.length,
		changes,
		warnings: inferenceImpactWarnings(changes),
		resetsTranslationSelection: Boolean(row?.resetsTranslationSelection),
	};
}

async function loadBoundedOwnerInferenceSnapshot(
	db: D1DatabaseLike,
	ownerUserId: string,
): Promise<InferenceConfigurationNode[]> {
	const result = await db.prepare(
		`SELECT ${pathColumns}, 0 AS depth
		 FROM inference_configurations AS configuration
		 JOIN inference_configuration_credentials AS credentials
			ON credentials.configuration_id = configuration.configuration_id
			AND credentials.owner_user_id = configuration.owner_user_id
		 WHERE configuration.owner_user_id = ?
		 ORDER BY configuration.configuration_id ASC LIMIT ?`,
	).bind(ownerUserId, inferenceConfigurationCorruptionSentinel).all<ConfigurationPathRow>();
	const rows = result.results ?? [];
	if (rows.length >= inferenceConfigurationCorruptionSentinel) {
		throw new InferenceGraphRepositoryError("corrupt_graph", "Inference impact snapshot exceeds the owner quota.");
	}
	return rows.map((row) => configurationNodeFromRow(row, false));
}

type InferenceDependentNode = { id: string; depth: number; node: InferenceConfigurationNode };

function inferenceConfigurationDependents(
	snapshot: readonly InferenceConfigurationNode[],
	configurationId: string,
): InferenceDependentNode[] {
	const children = new Map<string, InferenceConfigurationNode[]>();
	for (const node of snapshot) {
		if (!node.parentId) continue;
		const siblings = children.get(node.parentId) ?? [];
		siblings.push(node);
		children.set(node.parentId, siblings);
	}
	const result: InferenceDependentNode[] = [];
	const pending = (children.get(configurationId) ?? []).map((node) => ({ node, depth: 1 }));
	for (let index = 0; index < pending.length; index += 1) {
		const current = pending[index]!;
		result.push({ id: current.node.id, ...current });
		if (result.length >= inferenceConfigurationCorruptionSentinel) {
			throw new InferenceGraphRepositoryError("corrupt_graph", "Inference impact dependents exceed the owner quota.");
		}
		for (const child of children.get(current.node.id) ?? []) {
			pending.push({ node: child, depth: current.depth + 1 });
		}
	}
	return result;
}

function inferenceNodeWithParent(node: InferenceConfigurationNode, parentId: string): InferenceConfigurationNode {
	return { ...node, parentId } as InferenceConfigurationNode;
}

function compareInferenceResolutions(
	affectedIds: readonly string[],
	before: ReadonlyMap<string, InferenceConfigurationNode>,
	after: ReadonlyMap<string, InferenceConfigurationNode>,
	defaults?: BickrInferenceDefaults,
): InferenceImpactChangeCounts {
	const changes: InferenceImpactChangeCounts = {
		effectiveModel: 0,
		effectiveBaseUrl: 0,
		credentialAvailability: 0,
		credentialSource: 0,
		providerAccess: 0,
	};
	for (const id of affectedIds) {
		const beforeNode = before.get(id);
		const afterNode = after.get(id);
		if (!beforeNode || !afterNode) throw new InferenceGraphRepositoryError("corrupt_graph", "Inference impact snapshot is incomplete.");
		const beforeResolution = resolveInferenceConfiguration(pathFromSnapshot(beforeNode, before), { ...(defaults ? { defaults } : {}) });
		const afterResolution = resolveInferenceConfiguration(pathFromSnapshot(afterNode, after), { ...(defaults ? { defaults } : {}) });
		if (beforeResolution.effective.model !== afterResolution.effective.model) changes.effectiveModel += 1;
		if (beforeResolution.effective.baseUrl !== afterResolution.effective.baseUrl) changes.effectiveBaseUrl += 1;
		if ((beforeResolution.effective.credential.kind === "available") !==
			(afterResolution.effective.credential.kind === "available")) changes.credentialAvailability += 1;
		if (inferenceSourceKey(beforeResolution.effective.credential.source) !==
			inferenceSourceKey(afterResolution.effective.credential.source)) changes.credentialSource += 1;
		if (Boolean(beforeResolution.providerAuthorizationAdjustment) !==
			Boolean(afterResolution.providerAuthorizationAdjustment)) changes.providerAccess += 1;
	}
	return changes;
}

function inferenceSourceKey(source: InferenceSource): string {
	switch (source.kind) {
		case "bickr_default": return source.kind;
		case "account_default": return `${source.kind}:${source.configurationId}`;
		case "configuration": return `${source.kind}:${source.configurationKind}:${source.configurationId}`;
	}
}

function inferenceImpactWarnings(changes: InferenceImpactChangeCounts): InferenceImpactWarning[] {
	const warnings: InferenceImpactWarning[] = [];
	if (changes.effectiveModel) warnings.push({ kind: "effective_model_changes", configurations: changes.effectiveModel });
	if (changes.effectiveBaseUrl) warnings.push({ kind: "effective_base_url_changes", configurations: changes.effectiveBaseUrl });
	if (changes.credentialAvailability) warnings.push({ kind: "credential_availability_changes", configurations: changes.credentialAvailability });
	if (changes.credentialSource) warnings.push({ kind: "credential_source_changes", configurations: changes.credentialSource });
	if (changes.providerAccess) warnings.push({ kind: "provider_access_changes", configurations: changes.providerAccess });
	return warnings;
}

export type CredentialUpdate =
	| { mode: "inherit" }
	| { mode: "account_default" }
	| { mode: "none" }
	| { mode: "value"; secret: string };

export type CreateCustomInferenceConfigurationInput = {
	name: string;
	parentId: string;
	overrides?: InferenceConfigurationOverrides;
	credential?: CredentialUpdate;
};

export type UpdateInferenceConfigurationInput = {
	configurationId: string;
	expectedRevision: number;
	overrides?: InferenceConfigurationOverridePatch;
	credential?: CredentialUpdate;
};

export type ReparentInferenceConfigurationInput = {
	configurationId: string;
	parentId: string;
	expectedRevision: number;
};

export type RenameInferenceConfigurationInput = {
	configurationId: string;
	name: string;
	expectedRevision: number;
};

export type DeleteInferenceConfigurationInput = {
	configurationId: string;
	expectedRevision: number;
	defaults?: BickrInferenceDefaults;
};

export type TranslationSelection = {
	ownerUserId: string;
	configurationId: string;
	revision: number;
	updatedAt: string;
};

export type UpdateTranslationSelectionInput = {
	configurationId: string;
	expectedRevision: number;
};

type InferenceConfigurationMutationCapability = Readonly<{
	createCustom(db: D1DatabaseLike, ownerUserId: string, input: CreateCustomInferenceConfigurationInput, now?: string): Promise<InferenceConfigurationNode>;
	renameCustom(db: D1DatabaseLike, ownerUserId: string, input: RenameInferenceConfigurationInput, now?: string): Promise<InferenceConfigurationNode>;
	update(db: D1DatabaseLike, ownerUserId: string, input: UpdateInferenceConfigurationInput, now?: string): Promise<InferenceConfigurationNode>;
	reparent(db: D1DatabaseLike, ownerUserId: string, input: ReparentInferenceConfigurationInput, now?: string): Promise<InferenceConfigurationNode>;
	deleteCustom(db: D1DatabaseLike, ownerUserId: string, input: DeleteInferenceConfigurationInput, now?: string): Promise<InferenceDeleteImpact>;
	updateTranslationSelection(db: D1DatabaseLike, ownerUserId: string, input: UpdateTranslationSelectionInput, now?: string): Promise<TranslationSelection>;
	ensureCompatibilityTranslation(db: D1DatabaseLike, ownerUserId: string, overrides: InferenceConfigurationOverrides, now?: string): Promise<InferenceConfigurationNode>;
}>;

/** The sole ordinary graph-write surface; imports are statically allowlisted. */
export const inferenceConfigurationMutations: InferenceConfigurationMutationCapability = Object.freeze({
	createCustom,
	renameCustom,
	update: updateConfiguration,
	reparent: reparentConfiguration,
	deleteCustom,
	updateTranslationSelection,
	ensureCompatibilityTranslation,
});

async function createCustom(
	db: D1DatabaseLike,
	ownerUserId: string,
	input: CreateCustomInferenceConfigurationInput,
	now = new Date().toISOString(),
): Promise<InferenceConfigurationNode> {
	await assertOwnerQuota(db, ownerUserId);
	await loadInferenceConfigurationPath(db, ownerUserId, input.parentId);
	const normalizedName = normalizedInferenceConfigurationName(input.name);
	const configurationId = makeId("cfg");
	try {
		const insert = db.prepare(
			`INSERT INTO inference_configurations (
				configuration_id, owner_user_id, kind, parent_id, custom_name,
				custom_name_key, overrides_json, revision, created_at, updated_at
			) VALUES (?, ?, 'custom', ?, ?, ?, ?, 1, ?, ?)`,
		).bind(
			configurationId,
			ownerUserId,
			input.parentId,
			normalizedName.name,
			normalizedName.key,
			JSON.stringify(input.overrides ?? {}),
			now,
			now,
		);
		await db.batch([
			insert,
			...(input.credential ? [credentialStatement(db, configurationId, ownerUserId, input.credential, now)] : []),
		]);
	} catch (error) {
		throw mapUniqueConflict(error, "duplicate_name");
	}
	return (await loadInferenceConfigurationPath(db, ownerUserId, configurationId))[0];
}

async function renameCustom(
	db: D1DatabaseLike,
	ownerUserId: string,
	input: RenameInferenceConfigurationInput,
	now = new Date().toISOString(),
): Promise<InferenceConfigurationNode> {
	const current = (await loadInferenceConfigurationPath(db, ownerUserId, input.configurationId))[0];
	if (current.kind !== "custom") {
		throw new InferenceGraphRepositoryError("fixed_entry_requires_lifecycle", "Only custom configurations can be renamed.");
	}
	const name = normalizedInferenceConfigurationName(input.name);
	try {
		const result = await db.prepare(
			`UPDATE inference_configurations SET custom_name = ?, custom_name_key = ?, revision = revision + 1, updated_at = ?
			 WHERE configuration_id = ? AND owner_user_id = ? AND kind = 'custom' AND revision = ?`,
		).bind(name.name, name.key, now, input.configurationId, ownerUserId, input.expectedRevision).run();
		assertOneMutation(result.meta?.changes, current.revision, input.expectedRevision);
	} catch (error) {
		throw mapUniqueConflict(error, "duplicate_name");
	}
	return (await loadInferenceConfigurationPath(db, ownerUserId, input.configurationId))[0];
}

async function updateConfiguration(
	db: D1DatabaseLike,
	ownerUserId: string,
	input: UpdateInferenceConfigurationInput,
	now = new Date().toISOString(),
): Promise<InferenceConfigurationNode> {
	const current = (await loadInferenceConfigurationPath(db, ownerUserId, input.configurationId))[0];
	const overrides = input.overrides ? applyInferenceOverridePatch(current.overrides, input.overrides) : current.overrides;
	const statements = [db.prepare(
		`UPDATE inference_configurations SET overrides_json = ?, revision = revision + 1, updated_at = ?
		 WHERE configuration_id = ? AND owner_user_id = ? AND revision = ?`,
	).bind(JSON.stringify(overrides), now, input.configurationId, ownerUserId, input.expectedRevision)];
	if (input.credential) {
		if (current.kind === "account_default" && input.credential.mode === "account_default") {
			throw new RepositoryError("bad_request", "Account default cannot use Account-default credential mode.", 400);
		}
		statements.push(credentialStatement(db, input.configurationId, ownerUserId, input.credential, now));
	}
	const results = await db.batch(statements);
	assertOneMutation(results[0]?.meta?.changes, current.revision, input.expectedRevision);
	return (await loadInferenceConfigurationPath(db, ownerUserId, input.configurationId))[0];
}

async function reparentConfiguration(
	db: D1DatabaseLike,
	ownerUserId: string,
	input: ReparentInferenceConfigurationInput,
	now = new Date().toISOString(),
): Promise<InferenceConfigurationNode> {
	const current = (await loadInferenceConfigurationPath(db, ownerUserId, input.configurationId))[0];
	if (current.kind === "account_default") {
		throw new InferenceGraphRepositoryError("account_default_required", "Account default cannot have a parent.");
	}
	if (input.parentId === input.configurationId) {
		throw new InferenceGraphRepositoryError("self_parent", "A configuration cannot parent itself.");
	}
	const parentPath = await loadInferenceConfigurationPath(db, ownerUserId, input.parentId);
	if (parentPath.some((entry) => entry.id === input.configurationId)) {
		throw new InferenceGraphRepositoryError("descendant_parent", "A configuration cannot be parented to its descendant.");
	}
	const result = await db.prepare(
		`UPDATE inference_configurations SET parent_id = ?, revision = revision + 1, updated_at = ?
		 WHERE configuration_id = ? AND owner_user_id = ? AND revision = ? AND kind != 'account_default'`,
	).bind(input.parentId, now, input.configurationId, ownerUserId, input.expectedRevision).run();
	assertOneMutation(result.meta?.changes, current.revision, input.expectedRevision);
	return (await loadInferenceConfigurationPath(db, ownerUserId, input.configurationId))[0];
}

async function deleteCustom(
	db: D1DatabaseLike,
	ownerUserId: string,
	input: DeleteInferenceConfigurationInput,
	now = new Date().toISOString(),
): Promise<InferenceDeleteImpact> {
	const impact = await inferenceConfigurationDeleteImpact(db, ownerUserId, input.configurationId, input.defaults);
	const current = (await loadInferenceConfigurationPath(db, ownerUserId, input.configurationId))[0];
	if (current.revision !== input.expectedRevision) staleRevision();
	const accountDefault = current.parentId ? (await loadInferenceConfigurationPath(db, ownerUserId, current.parentId)).at(-1) : undefined;
	if (!accountDefault || accountDefault.kind !== "account_default") {
		throw new InferenceGraphRepositoryError("corrupt_graph", "Deleted configuration has no Account default ancestor.");
	}
	const results = await db.batch([
		db.prepare(
			`UPDATE inference_configurations SET parent_id = ?, revision = revision + 1, updated_at = ?
			 WHERE owner_user_id = ? AND parent_id = ?`,
		).bind(impact.parentId, now, ownerUserId, input.configurationId),
		db.prepare(
			`UPDATE inference_translation_selections SET configuration_id = ?, selected_kind = 'account_default', revision = revision + 1, updated_at = ?
			 WHERE owner_user_id = ? AND configuration_id = ?`,
		).bind(accountDefault.id, now, ownerUserId, input.configurationId),
		db.prepare(`DELETE FROM inference_configuration_credentials WHERE configuration_id = ? AND owner_user_id = ?`)
			.bind(input.configurationId, ownerUserId),
		db.prepare(
			`DELETE FROM inference_configurations
			 WHERE configuration_id = ? AND owner_user_id = ? AND kind = 'custom' AND revision = ?`,
		).bind(input.configurationId, ownerUserId, input.expectedRevision),
	]);
	assertOneMutation(results[3]?.meta?.changes, current.revision, input.expectedRevision);
	return impact;
}

export async function readTranslationSelection(
	db: D1DatabaseLike,
	ownerUserId: string,
): Promise<TranslationSelection> {
	const row = await db.prepare(
		`SELECT owner_user_id AS ownerUserId, configuration_id AS configurationId, revision, updated_at AS updatedAt
		 FROM inference_translation_selections WHERE owner_user_id = ? LIMIT 1`,
	).bind(ownerUserId).first<TranslationSelection>();
	if (!row) throw new RepositoryError("not_found", "Translation inference selection not found.", 404);
	return row;
}

export async function readCompatibilityProjectionTranslationSelection(
	db: D1DatabaseLike,
	ownerUserId: string,
	expectedGraphRevision: number,
): Promise<TranslationSelection> {
	const row = await db.prepare(
		`SELECT owner_user_id AS ownerUserId,
			translation_configuration_id AS configurationId,
			translation_selection_revision AS revision,
			updated_at AS updatedAt
		 FROM inference_graph_legacy_projections
		 WHERE owner_user_id = ? AND graph_revision = ? LIMIT 1`,
	).bind(ownerUserId, expectedGraphRevision).first<TranslationSelection>();
	if (!row) throw new InferenceGraphRepositoryError("corrupt_graph", "Current translation compatibility projection is missing.");
	return row;
}

async function updateTranslationSelection(
	db: D1DatabaseLike,
	ownerUserId: string,
	input: UpdateTranslationSelectionInput,
	now = new Date().toISOString(),
): Promise<TranslationSelection> {
	const candidate = (await loadInferenceConfigurationPath(db, ownerUserId, input.configurationId))[0];
	if (candidate.kind !== "account_default" && candidate.kind !== "custom") {
		throw new InferenceGraphRepositoryError("invalid_parent", "Translation selection must be Account default or custom.", 400);
	}
	const current = await readTranslationSelection(db, ownerUserId);
	const result = await db.prepare(
		`UPDATE inference_translation_selections
		 SET configuration_id = ?, selected_kind = ?, revision = revision + 1, updated_at = ?
		 WHERE owner_user_id = ? AND revision = ?`,
	).bind(candidate.id, candidate.kind, now, ownerUserId, input.expectedRevision).run();
	assertOneMutation(result.meta?.changes, current.revision, input.expectedRevision);
	return readTranslationSelection(db, ownerUserId);
}

async function ensureCompatibilityTranslation(
	db: D1DatabaseLike,
	ownerUserId: string,
	overrides: InferenceConfigurationOverrides,
	now = new Date().toISOString(),
): Promise<InferenceConfigurationNode> {
	const existing = await db.prepare(
		`SELECT compatibility_translation_configuration_id AS id
		 FROM inference_graph_users WHERE owner_user_id = ? LIMIT 1`,
	).bind(ownerUserId).first<{ id: string | null }>();
	if (!existing) throw new RepositoryError("not_found", "Inference graph owner not found.", 404);
	if (existing.id) {
		const selected = (await loadInferenceConfigurationPath(db, ownerUserId, existing.id))[0];
		if (selected.kind !== "custom") {
			throw new InferenceGraphRepositoryError("corrupt_graph", "Compatibility translation reference is not custom.");
		}
		return selected;
	}
	const configurationId = await deterministicId("cfg", `inference:translation:${ownerUserId}`);
	const deterministicEntry = await db.prepare(
		`SELECT owner_user_id AS ownerUserId, kind
		 FROM inference_configurations WHERE configuration_id = ? LIMIT 1`,
	).bind(configurationId).first<{ ownerUserId: string; kind: InferenceConfigurationKind }>();
	if (deterministicEntry) {
		if (deterministicEntry.ownerUserId !== ownerUserId || deterministicEntry.kind !== "custom") {
			throw new InferenceGraphRepositoryError("unexpected_unique_conflict", "Deterministic translation configuration identity is unavailable.");
		}
		await db.prepare(
			`UPDATE inference_graph_users SET compatibility_translation_configuration_id = ?, updated_at = ?
			 WHERE owner_user_id = ? AND compatibility_translation_configuration_id IS NULL`,
		).bind(configurationId, now, ownerUserId).run();
		return (await loadInferenceConfigurationPath(db, ownerUserId, configurationId))[0];
	}
	await assertOwnerQuota(db, ownerUserId);
	const rootId = await accountDefaultConfigurationId(ownerUserId);
	await loadInferenceConfigurationPath(db, ownerUserId, rootId);
	const candidate = await db.prepare(
		`WITH RECURSIVE names(suffix, name, name_key) AS (
			VALUES (0, 'Migrated translation settings', 'migrated translation settings')
			UNION ALL
			SELECT suffix + 1,
				CASE WHEN suffix = 0
					THEN 'Migrated translation settings (' || substr(?, -8) || ')'
					ELSE 'Migrated translation settings (' || substr(?, -8) || '-' || CAST(suffix + 1 AS TEXT) || ')' END,
				CASE WHEN suffix = 0
					THEN 'migrated translation settings (' || lower(substr(?, -8)) || ')'
					ELSE 'migrated translation settings (' || lower(substr(?, -8)) || '-' || CAST(suffix + 1 AS TEXT) || ')' END
			FROM names
			WHERE suffix < ? AND EXISTS (
				SELECT 1 FROM inference_configurations
				WHERE owner_user_id = ? AND kind = 'custom' AND custom_name_key = names.name_key
			)
		)
		SELECT name, name_key AS nameKey FROM names
		WHERE NOT EXISTS (
			SELECT 1 FROM inference_configurations
			WHERE owner_user_id = ? AND kind = 'custom' AND custom_name_key = names.name_key
		)
		ORDER BY suffix ASC LIMIT 1`,
	).bind(
		configurationId,
		configurationId,
		configurationId,
		configurationId,
		inferenceConfigurationOwnerQuota,
		ownerUserId,
		ownerUserId,
	).first<{ name: string; nameKey: string }>();
	if (!candidate) throw new InferenceGraphRepositoryError("quota_exceeded", "Inference configuration quota reached.");
	try {
		await db.batch([
			db.prepare(
				`INSERT INTO inference_configurations (
					configuration_id, owner_user_id, kind, parent_id, custom_name,
					custom_name_key, overrides_json, revision, created_at, updated_at
				) VALUES (?, ?, 'custom', ?, ?, ?, ?, 1, ?, ?)`,
			).bind(configurationId, ownerUserId, rootId, candidate.name, candidate.nameKey, JSON.stringify(overrides), now, now),
			db.prepare(
				`UPDATE inference_graph_users SET compatibility_translation_configuration_id = ?, updated_at = ?
				 WHERE owner_user_id = ? AND compatibility_translation_configuration_id IS NULL`,
			).bind(configurationId, now, ownerUserId),
		]);
	} catch (error) {
		throw mapUniqueConflict(error, "unexpected_unique_conflict");
	}
	return (await loadInferenceConfigurationPath(db, ownerUserId, configurationId))[0];
}

async function assertOwnerQuota(db: D1DatabaseLike, ownerUserId: string): Promise<void> {
	const row = await db.prepare(
		`SELECT COUNT(*) AS count FROM inference_configurations WHERE owner_user_id = ?`,
	).bind(ownerUserId).first<{ count: number }>();
	if ((row?.count ?? 0) >= inferenceConfigurationOwnerQuota) {
		throw new InferenceGraphRepositoryError("quota_exceeded", "Inference configuration quota reached.");
	}
}

function assertOneMutation(changes: number | undefined, currentRevision: number, expectedRevision: number): void {
	// D1 reports changes made by invalidation triggers in this count as well as
	// the guarded row. A zero count is the only reliable stale-write signal.
	if (currentRevision !== expectedRevision || !changes || changes < 1) staleRevision();
}

function staleRevision(): never {
	throw new InferenceGraphRepositoryError("stale_revision", "Inference configuration changed; reload and try again.");
}

function mapUniqueConflict(error: unknown, expected: InferenceGraphConflictCause): unknown {
	if (error instanceof RepositoryError) return error;
	if (isD1UniqueConstraintError(error)) {
		return new InferenceGraphRepositoryError(expected === "duplicate_name" ? expected : "unexpected_unique_conflict", "Inference configuration conflicts with an existing entry.");
	}
	return error;
}

function credentialStatement(
	db: D1DatabaseLike,
	configurationId: string,
	ownerUserId: string,
	credential: CredentialUpdate,
	now: string,
): D1PreparedStatementLike {
	if (credential.mode === "value" && credential.secret.length === 0) {
		throw new RepositoryError("bad_request", "Provider credential cannot be empty.", 400);
	}
	return db.prepare(
		`UPDATE inference_configuration_credentials
		 SET mode = ?, secret_value = ?,
			secret_version = CASE WHEN ? = 'value' THEN secret_version + 1 ELSE 0 END,
			updated_at = ?
		 WHERE configuration_id = ? AND owner_user_id = ?`,
	).bind(
		credential.mode,
		credential.mode === "value" ? credential.secret : null,
		credential.mode,
		now,
		configurationId,
		ownerUserId,
	);
}

export async function accountDefaultConfigurationId(ownerUserId: string): Promise<string> {
	return deterministicId("cfg", `inference:account:${ownerUserId}`);
}

export async function worldConfigurationId(worldId: string): Promise<string> {
	return deterministicId("cfg", `inference:world:${worldId}`);
}

export async function botConfigurationId(botId: string): Promise<string> {
	return deterministicId("cfg", `inference:bot:${botId}`);
}

export async function lifecycleUsesInferenceGraph(db: D1DatabaseLike): Promise<boolean> {
	const row = await db.prepare(`SELECT activation_mode AS mode FROM entity_lifecycle_control WHERE id = 1 LIMIT 1`)
		.first<{ mode: "legacy_compatible" | "inference_graph_required" }>();
	if (!row) throw new RepositoryError("server_error", "Lifecycle control row is missing.", 500);
	return row.mode === "inference_graph_required";
}

export type InferenceGraphReadVersion = {
	writerVersion: 0 | 1;
	cutoverVersion: 0 | 1 | 2;
	graphRevision: number;
};

/** Every compatibility consumer selects read mode from this stored version. */
export async function inferenceGraphReadVersion(
	db: D1DatabaseLike,
	ownerUserId: string,
): Promise<InferenceGraphReadVersion> {
	const row = await db.prepare(
		`SELECT writer_version AS writerVersion, cutover_version AS cutoverVersion,
			graph_revision AS graphRevision
		 FROM inference_graph_users WHERE owner_user_id = ? LIMIT 1`,
	).bind(ownerUserId).first<InferenceGraphReadVersion>();
	return row ?? { writerVersion: 0, cutoverVersion: 0, graphRevision: 0 };
}

export function insertAccountDefaultConfigurationStatement(
	db: D1DatabaseLike,
	input: { configurationId: string; ownerUserId: string; now: string; overrides?: InferenceConfigurationOverrides },
): D1PreparedStatementLike {
	return db.prepare(
		`INSERT INTO inference_configurations (
			configuration_id, owner_user_id, kind, overrides_json, revision, created_at, updated_at
		) VALUES (?, ?, 'account_default', ?, 1, ?, ?)`,
	).bind(input.configurationId, input.ownerUserId, JSON.stringify(input.overrides ?? {}), input.now, input.now);
}

export function insertTranslationSelectionStatement(
	db: D1DatabaseLike,
	input: { ownerUserId: string; configurationId: string; now: string },
): D1PreparedStatementLike {
	return db.prepare(
		`INSERT INTO inference_translation_selections (
			owner_user_id, configuration_id, selected_kind, revision, created_at, updated_at
		) VALUES (?, ?, 'account_default', 1, ?, ?)`,
	).bind(input.ownerUserId, input.configurationId, input.now, input.now);
}

/** Transfers an account bootstrap credential inside the activation D1 batch. */
export function configurationCredentialValueStatement(
	db: D1DatabaseLike,
	input: { configurationId: string; ownerUserId: string; secret: string; now: string },
): D1PreparedStatementLike {
	if (!input.secret.trim()) throw new RepositoryError("bad_request", "Provider credential cannot be empty.", 400);
	return db.prepare(
		`UPDATE inference_configuration_credentials
		 SET mode = 'value', secret_value = ?, secret_version = secret_version + 1, updated_at = ?
		 WHERE configuration_id = ? AND owner_user_id = ? AND mode = 'inherit'`,
	).bind(input.secret.trim(), input.now, input.configurationId, input.ownerUserId);
}

export function insertFixedConfigurationStatement(
	db: D1DatabaseLike,
	input:
		| { kind: "world"; configurationId: string; ownerUserId: string; parentId: string; worldId: string; now: string; overrides?: InferenceConfigurationOverrides }
		| { kind: "bot"; configurationId: string; ownerUserId: string; parentId: string; botId: string; now: string; overrides?: InferenceConfigurationOverrides },
): D1PreparedStatementLike {
	return db.prepare(
		`INSERT INTO inference_configurations (
			configuration_id, owner_user_id, kind, parent_id, world_id, bot_id,
			overrides_json, revision, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
	).bind(
		input.configurationId,
		input.ownerUserId,
		input.kind,
		input.parentId,
		input.kind === "world" ? input.worldId : null,
		input.kind === "bot" ? input.botId : null,
		JSON.stringify(input.overrides ?? {}),
		input.now,
		input.now,
	);
}

/** FK-safe lifecycle deletion sequence for a fixed world/bot entry. */
export async function fixedConfigurationDeletionStatements(
	db: D1DatabaseLike,
	input: { ownerUserId: string; configurationId: string; entityKind: "world" | "bot"; now: string },
): Promise<readonly [D1PreparedStatementLike, ...D1PreparedStatementLike[]]> {
	const path = await loadInferenceConfigurationPath(db, input.ownerUserId, input.configurationId);
	const selected = path[0];
	if (selected.kind !== input.entityKind || !selected.parentId) {
		throw new InferenceGraphRepositoryError("corrupt_graph", "Fixed inference configuration does not match its lifecycle entity.");
	}
	return [
		db.prepare(
			`UPDATE inference_configurations SET parent_id = ?, revision = revision + 1, updated_at = ?
			 WHERE owner_user_id = ? AND parent_id = ?`,
		).bind(selected.parentId, input.now, input.ownerUserId, selected.id),
		db.prepare(`DELETE FROM inference_configuration_credentials WHERE configuration_id = ? AND owner_user_id = ?`)
			.bind(selected.id, input.ownerUserId),
		db.prepare(
			`DELETE FROM inference_configurations WHERE configuration_id = ? AND owner_user_id = ? AND kind = ?`,
		).bind(selected.id, input.ownerUserId, input.entityKind),
	];
}

/** FK-safe account cleanup sequence; used only by account lifecycle deletion. */
export async function accountConfigurationDeletionStatements(
	db: D1DatabaseLike,
	ownerUserId: string,
): Promise<readonly [D1PreparedStatementLike, ...D1PreparedStatementLike[]]> {
	const rootId = await accountDefaultConfigurationId(ownerUserId);
	return [
		db.prepare(`DELETE FROM inference_translation_selections WHERE owner_user_id = ?`).bind(ownerUserId),
		db.prepare(`DELETE FROM inference_configuration_credentials WHERE owner_user_id = ? AND configuration_id != ?`).bind(ownerUserId, rootId),
		db.prepare(`DELETE FROM inference_configurations WHERE owner_user_id = ? AND configuration_id != ?`).bind(ownerUserId, rootId),
		db.prepare(`DELETE FROM inference_configuration_credentials WHERE owner_user_id = ? AND configuration_id = ?`).bind(ownerUserId, rootId),
		db.prepare(`DELETE FROM inference_configurations WHERE owner_user_id = ? AND configuration_id = ? AND kind = 'account_default'`).bind(ownerUserId, rootId),
		db.prepare(`DELETE FROM inference_graph_convergence WHERE owner_user_id = ?`).bind(ownerUserId),
		db.prepare(`DELETE FROM inference_graph_legacy_projections WHERE owner_user_id = ?`).bind(ownerUserId),
		db.prepare(`DELETE FROM inference_graph_migration_operations WHERE owner_user_id = ?`).bind(ownerUserId),
		db.prepare(`DELETE FROM inference_graph_users WHERE owner_user_id = ?`).bind(ownerUserId),
	];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
