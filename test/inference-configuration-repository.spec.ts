import { beforeEach, describe, expect, it } from "vitest";
import { env as testEnv } from "cloudflare:test";
import {
	accountDefaultConfigurationId,
	accountConfigurationDeletionStatements,
	inferenceConfigurationDeleteImpact,
	inferenceConfigurationParentImpact,
	inferenceConfigurationMutations,
	inferenceConfigurationOwnerDto,
	insertAccountDefaultConfigurationStatement,
	insertFixedConfigurationStatement,
	insertTranslationSelectionStatement,
	listImmediateInferenceChildren,
	listInferenceConfigurations,
	listInferenceParentCandidates,
	listInferenceTranslationCandidates,
	loadInferenceConfigurationPath,
	loadInternalInferenceConfigurationPath,
	readTranslationSelection,
} from "@bickr/shared/inference-configuration-repository";
import type { D1DatabaseLike } from "@bickr/shared/storage";
import { resetD1Schema } from "./helpers/d1-schema";

const ownerId = "usr_graph_owner";
const now = "2026-08-04T00:00:00.000Z";

beforeEach(async () => {
	await resetD1Schema(testEnv.BICKR_D1);
	await testEnv.BICKR_D1.batch([
		testEnv.BICKR_D1.prepare(
			`INSERT INTO entity_lifecycle_identity_claims (
				key_kind, key_scope, key_value, entity_kind, entity_id, owner_user_id,
				claim_state, operation_id, created_at, updated_at
			) VALUES ('user_handle', 'global', 'graph-owner', 'account', ?, ?, 'active', NULL, ?, ?)`,
		).bind(ownerId, ownerId, now, now),
		testEnv.BICKR_D1.prepare(
			`INSERT INTO users_index (
			user_id, handle, display_name, created_at, updated_at, lifecycle_state
		) VALUES (?, 'graph-owner', 'Graph Owner', ?, ?, 'active')`,
		).bind(ownerId, now, now),
	]);
	const rootId = await accountDefaultConfigurationId(ownerId);
	await (testEnv.BICKR_D1 as unknown as D1DatabaseLike).batch([
		insertAccountDefaultConfigurationStatement(testEnv.BICKR_D1, {
			configurationId: rootId,
			ownerUserId: ownerId,
			now,
		}),
		insertTranslationSelectionStatement(testEnv.BICKR_D1, {
			configurationId: rootId,
			ownerUserId: ownerId,
			now,
		}),
	]);
});

describe("inference configuration D1 repository", () => {
	it("loads arbitrary parent paths while keeping plaintext out of owner reads and fingerprints", async () => {
		const rootId = await accountDefaultConfigurationId(ownerId);
		const parent = await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, {
			name: "Parent",
			parentId: rootId,
			overrides: { temperature: { kind: "value", value: 0 } },
			credential: { mode: "value", secret: "server-only-secret" },
		}, now);
		const child = await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, {
			name: "Child",
			parentId: parent.id,
			overrides: { supportsPrefill: { kind: "value", value: false } },
		}, now);

		const ownerPath = await loadInferenceConfigurationPath(testEnv.BICKR_D1, ownerId, child.id);
		expect(ownerPath.map((entry) => entry.id)).toEqual([child.id, parent.id, rootId]);
		expect(JSON.stringify(ownerPath)).not.toContain("server-only-secret");
		expect((await loadInternalInferenceConfigurationPath(testEnv.BICKR_D1, ownerId, child.id))[1]?.credential)
			.toMatchObject({ mode: "value", secret: "server-only-secret", secretVersion: 1 });

		const dto = await inferenceConfigurationOwnerDto(testEnv.BICKR_D1, ownerId, child.id);
		expect(JSON.stringify(dto)).not.toContain("server-only-secret");
		expect(dto).not.toHaveProperty("resolution");
		expect(dto.fields.temperature.effective).toBe(0);
		expect(dto.fields.supportsPrefill.effective).toBe(false);
		expect(dto.fields.temperature).toMatchObject({
			override: { kind: "inherit" },
			effective: 0,
			source: { configurationId: parent.id },
		});
		expect(Object.keys(dto.fields)).toHaveLength(27);
		expect(dto.imagePreviews).toMatchObject({
			participant: { aspectRatio: "1:1" },
			world: { aspectRatio: "21:9" },
		});
	});

	it("reports typed credential provenance without reporting deployment or saved secret text", async () => {
		const rootId = await accountDefaultConfigurationId(ownerId);
		await inferenceConfigurationMutations.update(testEnv.BICKR_D1, ownerId, {
			configurationId: rootId,
			expectedRevision: 1,
			overrides: { baseUrl: { kind: "value", value: "https://owner.example/v1" } },
		}, now);
		const deploymentDefaults = {
			fields: { baseUrl: "https://deployment.example/v1", model: "deployment/model", temperature: 1 },
			credential: "deployment-secret",
			credentialVersion: 8,
		};
		const rootDto = await inferenceConfigurationOwnerDto(testEnv.BICKR_D1, ownerId, rootId, deploymentDefaults);
		expect(rootDto.credential).toMatchObject({
			mode: "inherit",
			available: false,
			resolution: {
				kind: "unavailable",
				source: { kind: "bickr_default" },
				reason: "deployment_credential_suppressed_for_owner_base_url",
			},
		});
		expect(JSON.stringify(rootDto)).not.toContain("deployment-secret");

		await inferenceConfigurationMutations.update(testEnv.BICKR_D1, ownerId, {
			configurationId: rootId,
			expectedRevision: 2,
			credential: { mode: "value", secret: "account-saved-secret" },
		}, now);
		const parent = await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, {
			name: "Credential parent", parentId: rootId,
			credential: { mode: "value", secret: "intervening-secret" },
		}, now);
		const child = await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, {
			name: "Credential child", parentId: parent.id,
			credential: { mode: "account_default" },
		}, now);
		const childDto = await inferenceConfigurationOwnerDto(testEnv.BICKR_D1, ownerId, child.id, deploymentDefaults);
		expect(childDto.credential).toMatchObject({
			mode: "account_default",
			available: true,
			resolution: {
				kind: "available",
				source: { kind: "account_default", configurationId: rootId },
				secretVersion: 1,
			},
		});
		expect(JSON.stringify(childDto)).not.toContain("account-saved-secret");
		expect(JSON.stringify(childDto)).not.toContain("intervening-secret");
	});

	it("enforces optimistic revision, normalized uniqueness, cycle rejection, and fixed-entry protections", async () => {
		const rootId = await accountDefaultConfigurationId(ownerId);
		const parent = await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, {
			name: "Reusable",
			parentId: rootId,
		}, now);
		const child = await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, {
			name: "Child",
			parentId: parent.id,
		}, now);

		await expect(inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, {
			name: "  REUSABLE  ",
			parentId: rootId,
		}, now)).rejects.toMatchObject({ causeKind: "duplicate_name", status: 409 });
		await expect(inferenceConfigurationMutations.reparent(testEnv.BICKR_D1, ownerId, {
			configurationId: parent.id,
			parentId: child.id,
			expectedRevision: parent.revision,
		}, now)).rejects.toMatchObject({ causeKind: "descendant_parent", status: 409 });
		await expect(inferenceConfigurationMutations.update(testEnv.BICKR_D1, ownerId, {
			configurationId: child.id,
			expectedRevision: child.revision + 1,
			overrides: { temperature: { kind: "value", value: 0.5 } },
		}, now)).rejects.toMatchObject({ causeKind: "stale_revision", status: 409 });
		await expect(inferenceConfigurationDeleteImpact(testEnv.BICKR_D1, ownerId, rootId))
			.rejects.toMatchObject({ causeKind: "fixed_entry_requires_lifecycle" });
		await expect(inferenceConfigurationMutations.update(testEnv.BICKR_D1, ownerId, {
			configurationId: rootId,
			expectedRevision: 1,
			credential: { mode: "account_default" },
		}, now)).rejects.toMatchObject({ code: "bad_request", status: 400 });
		await expect(testEnv.BICKR_D1.prepare(
			`UPDATE inference_configuration_credentials SET mode = 'account_default'
			 WHERE configuration_id = ? AND owner_user_id = ?`,
		).bind(rootId, ownerId).run()).rejects.toThrow();
	});

	it("returns fixed handle identities and bot home-world identity in editor, summary, and parent shapes", async () => {
		const rootId = await accountDefaultConfigurationId(ownerId);
		const worldId = "wld_graph_identity";
		const botId = "bot_graph_identity";
		await testEnv.BICKR_D1.batch([
			testEnv.BICKR_D1.prepare(
				`INSERT INTO entity_lifecycle_identity_claims (
					key_kind, key_scope, key_value, entity_kind, entity_id, owner_user_id,
					claim_state, operation_id, created_at, updated_at
				) VALUES ('world_handle', 'global', 'identity-world', 'world', ?, ?, 'active', NULL, ?, ?)`,
			).bind(worldId, ownerId, now, now),
			testEnv.BICKR_D1.prepare(
				`INSERT INTO entity_lifecycle_identity_claims (
					key_kind, key_scope, key_value, entity_kind, entity_id, owner_user_id,
					claim_state, operation_id, created_at, updated_at
				) VALUES ('bot_handle', ?, 'identity-bot', 'bot', ?, ?, 'active', NULL, ?, ?)`,
			).bind(worldId, botId, ownerId, now, now),
		]);
		await testEnv.BICKR_D1.batch([
			testEnv.BICKR_D1.prepare(
				`INSERT INTO worlds_index (
					world_id, handle, name, description, created_by_user_id, visibility,
					created_at, updated_at, lifecycle_state
				) VALUES (?, 'identity-world', 'Renamable World', '', ?, 'public', ?, ?, 'active')`,
			).bind(worldId, ownerId, now, now),
			testEnv.BICKR_D1.prepare(
				`INSERT INTO bots_index (
					bot_id, home_world_id, home_world_handle, handle, display_name,
					owner_user_id, short_bio, created_at, updated_at, lifecycle_state
				) VALUES (?, ?, 'identity-world', 'identity-bot', 'Renamable Bot', ?, '', ?, ?, 'active')`,
			).bind(botId, worldId, ownerId, now, now),
		]);
		const worldConfigurationId = "cfg_graph_identity_world";
		const botConfigurationId = "cfg_graph_identity_bot";
		await (testEnv.BICKR_D1 as unknown as D1DatabaseLike).batch([
			insertFixedConfigurationStatement(testEnv.BICKR_D1, {
				kind: "world", configurationId: worldConfigurationId, ownerUserId: ownerId,
				parentId: rootId, worldId, overrides: {}, now,
			}),
			insertFixedConfigurationStatement(testEnv.BICKR_D1, {
				kind: "bot", configurationId: botConfigurationId, ownerUserId: ownerId,
				parentId: worldConfigurationId, botId, overrides: {}, now,
			}),
		]);

		const dto = await inferenceConfigurationOwnerDto(testEnv.BICKR_D1, ownerId, botConfigurationId);
		expect(dto).toMatchObject({
			displayName: "u/identity-bot",
			identity: {
				kind: "bot", botId, botHandle: "identity-bot",
				homeWorldId: worldId, homeWorldHandle: "identity-world",
			},
		});
		const page = await listInferenceConfigurations(testEnv.BICKR_D1, ownerId, { query: "identity" });
		expect(page.items).toHaveLength(2);
		expect(page.items.find((item) => item.kind === "bot")).toMatchObject({
			displayName: "u/identity-bot",
			parent: {
				displayName: "w/identity-world",
				identity: { kind: "world", worldId, worldHandle: "identity-world" },
			},
		});
	});

	it("previews bounded reparent and delete effects without secret material", async () => {
		const rootId = await accountDefaultConfigurationId(ownerId);
		const source = await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, {
			name: "Source",
			parentId: rootId,
			overrides: {
				baseUrl: { kind: "value", value: "https://source.example/v1" },
				model: { kind: "value", value: "source/model" },
			},
			credential: { mode: "value", secret: "impact-source-secret" },
		}, now);
		const candidate = await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, {
			name: "Candidate",
			parentId: rootId,
			overrides: { model: { kind: "value", value: "candidate/model" } },
			credential: { mode: "none" },
		}, now);
		const selected = await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, {
			name: "Selected", parentId: source.id,
		}, now);
		const child = await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, {
			name: "Child", parentId: selected.id,
		}, now);
		await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, {
			name: "Grandchild", parentId: child.id,
		}, now);
		const defaults = {
			fields: { baseUrl: "https://deployment.example/v1", model: "deployment/model", temperature: 1 },
			credential: "deployment-secret",
			credentialVersion: 1,
		};
		const parentImpact = await inferenceConfigurationParentImpact(
			testEnv.BICKR_D1, ownerId, selected.id, candidate.id, defaults,
		);
		expect(parentImpact).toMatchObject({
			kind: "reparent",
			immediateDependentCount: 1,
			transitiveDependentCount: 2,
			affectedConfigurationCount: 3,
			changes: {
				effectiveModel: 3,
				effectiveBaseUrl: 3,
				credentialAvailability: 3,
				credentialSource: 3,
				providerAccess: 3,
			},
		});
		expect(JSON.stringify(parentImpact)).not.toContain("secret");

		const deleting = await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, {
			name: "Deleting",
			parentId: source.id,
			overrides: { model: { kind: "value", value: "deleting/model" } },
			credential: { mode: "none" },
		}, now);
		const deletingChild = await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, {
			name: "Deleting child", parentId: deleting.id,
		}, now);
		await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, {
			name: "Deleting grandchild", parentId: deletingChild.id,
		}, now);
		await inferenceConfigurationMutations.updateTranslationSelection(testEnv.BICKR_D1, ownerId, {
			configurationId: deleting.id, expectedRevision: 1,
		}, now);
		const deleteImpact = await inferenceConfigurationDeleteImpact(
			testEnv.BICKR_D1, ownerId, deleting.id, defaults,
		);
		expect(deleteImpact).toMatchObject({
			kind: "delete",
			immediateDependentCount: 1,
			transitiveDependentCount: 2,
			affectedConfigurationCount: 2,
			resetsTranslationSelection: true,
			changes: { effectiveModel: 2, credentialAvailability: 2, credentialSource: 2 },
		});
		expect(JSON.stringify(deleteImpact)).not.toContain("impact-source-secret");
		expect(JSON.stringify(deleteImpact)).not.toContain("deployment-secret");
	});

	it("deletes a selected custom entry in one FK-safe batch without flattening children", async () => {
		const rootId = await accountDefaultConfigurationId(ownerId);
		const parent = await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, {
			name: "Delete me",
			parentId: rootId,
			overrides: { model: { kind: "value", value: "example/deleted" } },
			credential: { mode: "value", secret: "deleted-secret" },
		}, now);
		const child = await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, {
			name: "Survivor",
			parentId: parent.id,
		}, now);
		await inferenceConfigurationMutations.updateTranslationSelection(testEnv.BICKR_D1, ownerId, {
			configurationId: parent.id,
			expectedRevision: 1,
		}, now);

		const impact = await inferenceConfigurationMutations.deleteCustom(testEnv.BICKR_D1, ownerId, {
			configurationId: parent.id,
			expectedRevision: parent.revision,
		}, now);
		expect(impact).toMatchObject({ immediateChildren: 1, resetsTranslationSelection: true });
		expect((await loadInferenceConfigurationPath(testEnv.BICKR_D1, ownerId, child.id))[0]).toMatchObject({
			parentId: rootId,
			overrides: {},
			revision: 2,
		});
		expect(await readTranslationSelection(testEnv.BICKR_D1, ownerId)).toMatchObject({
			configurationId: rootId,
			revision: 3,
		});
		expect(await testEnv.BICKR_D1.prepare(
			`SELECT configuration_id FROM inference_configuration_credentials WHERE configuration_id = ?`,
		).bind(parent.id).first()).toBeNull();
	});

	it("paginates list/search and immediate children without per-entry queries", async () => {
		const rootId = await accountDefaultConfigurationId(ownerId);
		for (const name of ["Alpha", "Alpine", "Beta", "Gamma"]) {
			await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, { name, parentId: rootId }, now);
		}
		const offPageParent = await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, {
			name: "Zulu parent",
			parentId: rootId,
		}, now);
		await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, {
			name: "Aardvark child",
			parentId: offPageParent.id,
		}, now);
		const first = await listInferenceConfigurations(testEnv.BICKR_D1, ownerId, { limit: 2 });
		expect(first.items).toHaveLength(2);
		expect(first.nextCursor).toBeTruthy();
		const second = await listInferenceConfigurations(testEnv.BICKR_D1, ownerId, { limit: 2, cursor: first.nextCursor });
		expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(4);
		expect(first.items.find((item) => item.displayName === "Aardvark child")?.parent?.displayName).toBe("Zulu parent");
		expect((await listInferenceConfigurations(testEnv.BICKR_D1, ownerId, { query: "Al" })).items.map((item) => item.displayName))
			.toEqual(["Alpha", "Alpine"]);
		const children = await listImmediateInferenceChildren(testEnv.BICKR_D1, ownerId, rootId, { limit: 2 });
		expect(children.items).toHaveLength(2);
		expect(children.nextCursor).toBeTruthy();
	});

	it("keeps parent and translation candidate queries bounded at observed graph scale", async () => {
		const rootId = await accountDefaultConfigurationId(ownerId);
		const selected = await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, {
			name: "Selected",
			parentId: rootId,
		}, now);
		for (let index = 0; index < 110; index += 1) {
			await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, {
				name: `Descendant ${index.toString().padStart(3, "0")}`,
				parentId: selected.id,
			}, now);
		}
		for (let index = 0; index < 91; index += 1) {
			await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, {
				name: `Candidate ${index.toString().padStart(3, "0")}`,
				parentId: rootId,
			}, now);
		}
		const candidates = await listInferenceParentCandidates(testEnv.BICKR_D1, ownerId, selected.id, { limit: 100 });
		expect(candidates.items).toHaveLength(92);
		expect(candidates.items.some((item) => item.id === selected.id || item.parentId === selected.id)).toBe(false);
		const translation = await listInferenceTranslationCandidates(testEnv.BICKR_D1, ownerId, { limit: 100 });
		expect(translation.items).toHaveLength(100);
		expect(translation.items.every((item) => item.kind === "account_default" || item.kind === "custom")).toBe(true);
		expect(translation.nextCursor).toBeTruthy();
	});

	it("returns typed cross-owner rejection without reading foreign paths", async () => {
		const foreignOwnerId = "usr_graph_foreign";
		await testEnv.BICKR_D1.batch([
			testEnv.BICKR_D1.prepare(
				`INSERT INTO entity_lifecycle_identity_claims (
					key_kind, key_scope, key_value, entity_kind, entity_id, owner_user_id,
					claim_state, operation_id, created_at, updated_at
				) VALUES ('user_handle', 'global', 'graph-foreign', 'account', ?, ?, 'active', NULL, ?, ?)`,
			).bind(foreignOwnerId, foreignOwnerId, now, now),
			testEnv.BICKR_D1.prepare(
				`INSERT INTO users_index (user_id, handle, display_name, created_at, updated_at, lifecycle_state)
				 VALUES (?, 'graph-foreign', 'Graph Foreign', ?, ?, 'active')`,
			).bind(foreignOwnerId, now, now),
		]);
		const foreignRootId = await accountDefaultConfigurationId(foreignOwnerId);
		await insertAccountDefaultConfigurationStatement(testEnv.BICKR_D1, {
			configurationId: foreignRootId,
			ownerUserId: foreignOwnerId,
			now,
		}).run();
		await expect(loadInferenceConfigurationPath(testEnv.BICKR_D1, ownerId, foreignRootId))
			.rejects.toMatchObject({ causeKind: "cross_owner", status: 409 });
	});

	it("removes account graph state and every credential in one FK-safe cleanup batch", async () => {
		const rootId = await accountDefaultConfigurationId(ownerId);
		const child = await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, {
			name: "Account cleanup child",
			parentId: rootId,
			credential: { mode: "value", secret: "cleanup-secret" },
		}, now);
		await (testEnv.BICKR_D1 as unknown as D1DatabaseLike).batch(
			[...await accountConfigurationDeletionStatements(testEnv.BICKR_D1, ownerId)],
		);
		expect(await testEnv.BICKR_D1.prepare(
			`SELECT configuration_id FROM inference_configurations WHERE owner_user_id = ? LIMIT 1`,
		).bind(ownerId).first()).toBeNull();
		expect(await testEnv.BICKR_D1.prepare(
			`SELECT configuration_id FROM inference_configuration_credentials WHERE configuration_id = ?`,
		).bind(child.id).first()).toBeNull();
		expect(await testEnv.BICKR_D1.prepare(
			`SELECT owner_user_id FROM inference_graph_users WHERE owner_user_id = ?`,
		).bind(ownerId).first()).toBeNull();
	});

	it("declares the quota, restrictive FKs, credential split, and bounded-retention indexes", async () => {
		const schema = await testEnv.BICKR_D1.prepare(
			`SELECT name, type, sql FROM sqlite_master
			 WHERE name LIKE 'inference_%' ORDER BY name`,
		).all<{ name: string; type: string; sql: string }>();
		const names = new Set((schema.results ?? []).map((row) => row.name));
		expect(names.has("inference_configurations_owner_quota")).toBe(true);
		expect(names.has("inference_graph_migration_cleanup")).toBe(true);
		expect(names.has("inference_graph_legacy_projection_cleanup")).toBe(true);
		expect(names.has("inference_graph_convergence_cleanup")).toBe(true);
		const configurationSql = schema.results?.find((row) => row.name === "inference_configurations")?.sql ?? "";
		expect(configurationSql).toContain("ON DELETE RESTRICT");
		expect(configurationSql).not.toContain("secret_value");
	});

	it("enforces 10,000 configurations and detects a 10,001-row corrupted path without truncating", async () => {
		const rootId = await accountDefaultConfigurationId(ownerId);
		await testEnv.BICKR_D1.prepare(
			`WITH digits(value) AS (VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)),
			numbers(value) AS (
				SELECT ones.value + 10 * tens.value + 100 * hundreds.value + 1000 * thousands.value
				FROM digits AS ones CROSS JOIN digits AS tens CROSS JOIN digits AS hundreds CROSS JOIN digits AS thousands
			)
			INSERT INTO inference_configurations (
				configuration_id, owner_user_id, kind, parent_id, custom_name,
				custom_name_key, overrides_json, revision, created_at, updated_at
			)
			SELECT 'cfg_quota_' || printf('%04d', value), ?, 'custom', ?,
				'Quota ' || printf('%04d', value), 'quota ' || printf('%04d', value),
				'{}', 1, ?, ?
			FROM numbers WHERE value < 9999 ORDER BY value`,
		).bind(ownerId, rootId, now, now).run();
		expect((await testEnv.BICKR_D1.prepare(
			`SELECT COUNT(*) AS count FROM inference_configurations WHERE owner_user_id = ?`,
		).bind(ownerId).first<{ count: number }>())?.count).toBe(10_000);
		await expect(inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, {
			name: "Over quota",
			parentId: rootId,
		}, now)).rejects.toMatchObject({ causeKind: "quota_exceeded", status: 409 });

		await testEnv.BICKR_D1.prepare(`DROP TRIGGER inference_configurations_owner_quota`).run();
		await testEnv.BICKR_D1.prepare(
			`INSERT INTO inference_configurations (
				configuration_id, owner_user_id, kind, parent_id, custom_name,
				custom_name_key, overrides_json, revision, created_at, updated_at
			) VALUES ('cfg_quota_9999', ?, 'custom', ?, 'Quota 9999', 'quota 9999', '{}', 1, ?, ?)`,
		).bind(ownerId, rootId, now, now).run();
		await testEnv.BICKR_D1.prepare(
			`UPDATE inference_configurations
			 SET parent_id = CASE
				WHEN configuration_id = 'cfg_quota_9999' THEN ?
				ELSE 'cfg_quota_' || printf('%04d', CAST(substr(configuration_id, 11) AS INTEGER) + 1)
			 END,
			 revision = revision + 1, updated_at = ?
			 WHERE owner_user_id = ? AND kind = 'custom'`,
		).bind(rootId, now, ownerId).run();
		await expect(loadInferenceConfigurationPath(testEnv.BICKR_D1, ownerId, "cfg_quota_0000"))
			.rejects.toMatchObject({ causeKind: "corrupt_graph", status: 500 });
	}, 30_000);
});
