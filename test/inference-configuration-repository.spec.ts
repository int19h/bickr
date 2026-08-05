import { beforeEach, describe, expect, it } from "vitest";
import { env as testEnv } from "cloudflare:test";
import {
	accountDefaultConfigurationId,
	inferenceConfigurationDeleteImpact,
	inferenceConfigurationMutations,
	inferenceConfigurationOwnerDto,
	insertAccountDefaultConfigurationStatement,
	insertTranslationSelectionStatement,
	listImmediateInferenceChildren,
	listInferenceConfigurations,
	loadInferenceConfigurationPath,
	loadInternalInferenceConfigurationPath,
	readTranslationSelection,
} from "@bickr/shared/inference-configuration-repository";
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
	await testEnv.BICKR_D1.batch([
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
		expect(dto.resolution.raw.temperature).toMatchObject({ state: "value", value: 0 });
		expect(dto.resolution.raw.supportsPrefill).toMatchObject({ state: "value", value: false });
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
		const first = await listInferenceConfigurations(testEnv.BICKR_D1, ownerId, { limit: 2 });
		expect(first.items).toHaveLength(2);
		expect(first.nextCursor).toBeTruthy();
		const second = await listInferenceConfigurations(testEnv.BICKR_D1, ownerId, { limit: 2, cursor: first.nextCursor });
		expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(4);
		expect((await listInferenceConfigurations(testEnv.BICKR_D1, ownerId, { query: "Al" })).items.map((item) => item.displayName))
			.toEqual(["Alpha", "Alpine"]);
		const children = await listImmediateInferenceChildren(testEnv.BICKR_D1, ownerId, rootId, { limit: 2 });
		expect(children.items).toHaveLength(2);
		expect(children.nextCursor).toBeTruthy();
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
});
