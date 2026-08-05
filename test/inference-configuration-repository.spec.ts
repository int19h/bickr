import { beforeEach, describe, expect, it } from "vitest";
import { env as testEnv } from "cloudflare:test";
import {
	accountConfigurationDeletionStatements,
	listInferenceLibrarySection,
	parseInferenceConfigurationKinds,
	parseInferenceLibrarySection,
	insertFixedConfigurationStatement,
	inferenceConfigurationDeleteImpact,
	inferenceConfigurationParentImpact,
	inferenceConfigurationMutations,
	inferenceConfigurationOwnerDto,
	insertAccountDefaultConfigurationStatement,
	insertTranslationSelectionStatement,
	listImmediateInferenceChildren,
	listInferenceConfigurations,
	listInferenceParentCandidates,
	listInferenceTranslationCandidates,
	loadInferenceConfigurationPath,
	loadInternalInferenceConfigurationPath,
	readTranslationSelection,
} from "@bickr/shared/inference-configuration-repository";
import {
	accountDefaultConfigurationId,
} from "@bickr/shared/inference-configuration-owner";
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
			[...await accountConfigurationDeletionStatements(testEnv.BICKR_D1, ownerId, now)],
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

	it("reparents every non-root entry before deleting a multi-level account graph", async () => {
		const rootId = await accountDefaultConfigurationId(ownerId);
		const worldId = "wld_cleanup";
		await seedWorld(worldId, "cleanup-world");
		await seedBotRow("bot_cleanup_source", worldId, "cleanup-world", "cleanup-source");
		await seedBotRow("bot_cleanup_clone", worldId, "cleanup-world", "cleanup-clone");
		const parent = await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, {
			name: "Cleanup parent",
			parentId: rootId,
			credential: { mode: "value", secret: "cleanup-parent-secret" },
		}, now);
		const child = await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, {
			name: "Cleanup child",
			parentId: parent.id,
			credential: { mode: "value", secret: "cleanup-child-secret" },
		}, now);
		await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, {
			name: "Cleanup grandchild",
			parentId: child.id,
		}, now);
		// A linked-clone-shaped bot edge: the clone's fixed entry is parented to
		// its source's fixed entry, so the batch must survive deleting both.
		await (testEnv.BICKR_D1 as unknown as D1DatabaseLike).batch([
			insertFixedConfigurationStatement(testEnv.BICKR_D1, {
				kind: "bot", configurationId: "cfg_cleanup_source", ownerUserId: ownerId,
				parentId: parent.id, botId: "bot_cleanup_source", now,
			}),
			insertFixedConfigurationStatement(testEnv.BICKR_D1, {
				kind: "bot", configurationId: "cfg_cleanup_clone", ownerUserId: ownerId,
				parentId: "cfg_cleanup_source", botId: "bot_cleanup_clone", now,
			}),
			insertFixedConfigurationStatement(testEnv.BICKR_D1, {
				kind: "world", configurationId: "cfg_cleanup_world", ownerUserId: ownerId,
				parentId: child.id, worldId, now,
			}),
		]);
		expect((await testEnv.BICKR_D1.prepare(
			`SELECT COUNT(*) AS count FROM inference_configurations WHERE owner_user_id = ?`,
		).bind(ownerId).first<{ count: number }>())?.count).toBe(7);

		await (testEnv.BICKR_D1 as unknown as D1DatabaseLike).batch(
			[...await accountConfigurationDeletionStatements(testEnv.BICKR_D1, ownerId, now)],
		);

		expect((await testEnv.BICKR_D1.prepare(
			`SELECT COUNT(*) AS count FROM inference_configurations WHERE owner_user_id = ?`,
		).bind(ownerId).first<{ count: number }>())?.count).toBe(0);
		expect((await testEnv.BICKR_D1.prepare(
			`SELECT COUNT(*) AS count FROM inference_configuration_credentials WHERE owner_user_id = ?`,
		).bind(ownerId).first<{ count: number }>())?.count).toBe(0);
		expect(await testEnv.BICKR_D1.prepare(
			`SELECT owner_user_id FROM inference_translation_selections WHERE owner_user_id = ?`,
		).bind(ownerId).first()).toBeNull();
		// The lifecycle retries its finalization batch, so cleanup must converge.
		await (testEnv.BICKR_D1 as unknown as D1DatabaseLike).batch(
			[...await accountConfigurationDeletionStatements(testEnv.BICKR_D1, ownerId, now)],
		);
		expect((await testEnv.BICKR_D1.prepare(
			`SELECT COUNT(*) AS count FROM inference_configurations WHERE owner_user_id = ?`,
		).bind(ownerId).first<{ count: number }>())?.count).toBe(0);
	});

	it("paginates library sections independently and groups participant pages by home world", async () => {
		const rootId = await accountDefaultConfigurationId(ownerId);
		await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, { name: "Zeta custom", parentId: rootId }, now);
		await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, { name: "Alpha custom", parentId: rootId }, now);
		for (const [index, handle] of ["scale-world-a", "scale-world-b", "scale-world-c"].entries()) {
			await seedWorld(`wld_scale_${index}`, handle);
			await insertFixedConfigurationStatement(testEnv.BICKR_D1, {
				kind: "world", configurationId: `cfg_scale_world_${index}`, ownerUserId: ownerId,
				parentId: rootId, worldId: `wld_scale_${index}`, now,
			}).run();
		}
		await seedScaleBots(110, rootId);

		const account = await listInferenceLibrarySection(testEnv.BICKR_D1, ownerId, { section: "account" });
		expect(account.items.map((item) => item.displayName)).toEqual(["Account default"]);
		expect(account.groups).toEqual([]);
		const custom = await listInferenceLibrarySection(testEnv.BICKR_D1, ownerId, { section: "custom" });
		expect(custom.items.map((item) => item.displayName)).toEqual(["Alpha custom", "Zeta custom"]);
		const worlds = await listInferenceLibrarySection(testEnv.BICKR_D1, ownerId, { section: "world" });
		expect(worlds.items.map((item) => item.displayName))
			.toEqual(["w/scale-world-a", "w/scale-world-b", "w/scale-world-c"]);

		const firstBots = await listInferenceLibrarySection(testEnv.BICKR_D1, ownerId, { section: "bot", limit: 100 });
		expect(firstBots.items).toHaveLength(100);
		expect(firstBots.nextCursor).toBeTruthy();
		expect(firstBots.items.map((item) => item.kind === "bot" ? item.identity.homeWorldHandle : null))
			.toEqual([
				...Array<string>(37).fill("scale-world-a"),
				...Array<string>(37).fill("scale-world-b"),
				...Array<string>(26).fill("scale-world-c"),
			]);
		const worldAHandles = firstBots.items.slice(0, 37)
			.map((item) => item.kind === "bot" ? item.identity.botHandle : "");
		expect(worldAHandles).toEqual([...worldAHandles].sort());
		expect(firstBots.groups).toEqual([
			{ homeWorldId: "wld_scale_0", homeWorldHandle: "scale-world-a", displayName: "w/scale-world-a", botConfigurationCount: 37 },
			{ homeWorldId: "wld_scale_1", homeWorldHandle: "scale-world-b", displayName: "w/scale-world-b", botConfigurationCount: 37 },
			{ homeWorldId: "wld_scale_2", homeWorldHandle: "scale-world-c", displayName: "w/scale-world-c", botConfigurationCount: 36 },
		]);

		const secondBots = await listInferenceLibrarySection(testEnv.BICKR_D1, ownerId, {
			section: "bot",
			limit: 100,
			cursor: firstBots.nextCursor,
		});
		expect(secondBots.items).toHaveLength(10);
		expect(secondBots.nextCursor).toBeUndefined();
		expect(secondBots.groups).toEqual([
			{ homeWorldId: "wld_scale_2", homeWorldHandle: "scale-world-c", displayName: "w/scale-world-c", botConfigurationCount: 36 },
		]);
		expect(new Set([...firstBots.items, ...secondBots.items].map((item) => item.id)).size).toBe(110);
	}, 30_000);

	it("annotates every summary with immediate-child count and redacted credential availability", async () => {
		const rootId = await accountDefaultConfigurationId(ownerId);
		const parent = await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, {
			name: "Summary parent",
			parentId: rootId,
			credential: { mode: "value", secret: "summary-secret" },
			overrides: { baseUrl: { kind: "value", value: "https://summary.example/v1" } },
		}, now);
		await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, { name: "Summary child", parentId: parent.id }, now);
		const suppressed = await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, {
			name: "Summary suppressed",
			parentId: rootId,
			credential: { mode: "none" },
			overrides: { baseUrl: { kind: "value", value: "https://suppressed.example/v1" } },
		}, now);

		const page = await listInferenceConfigurations(testEnv.BICKR_D1, ownerId, {});
		expect(JSON.stringify(page)).not.toContain("summary-secret");
		const byId = new Map(page.items.map((item) => [item.id, item]));
		expect(byId.get(rootId)).toMatchObject({ immediateChildCount: 2 });
		expect(byId.get(parent.id)).toMatchObject({
			immediateChildCount: 1,
			credentialMode: "value",
			credentialAvailability: { kind: "available", source: { kind: "configuration", configurationId: parent.id } },
		});
		expect(byId.get(suppressed.id)).toMatchObject({
			immediateChildCount: 0,
			credentialAvailability: { kind: "explicit_none" },
		});
		expect(byId.get(rootId)).toMatchObject({
			credentialAvailability: { kind: "unavailable", source: { kind: "bickr_default" }, reason: "no_credential" },
		});
		expect(byId.get(parent.id)?.credentialAvailability).not.toHaveProperty("secretVersion");
	});

	it("searches custom name, world handle, participant handle, and participant home-world handle", async () => {
		const rootId = await accountDefaultConfigurationId(ownerId);
		await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, { name: "Searchable custom", parentId: rootId }, now);
		await seedWorld("wld_search", "searchable-world");
		await seedWorld("wld_search_home", "hosting-world");
		// The participant lives in a different world than the one with a
		// configuration, so each search term has exactly one legitimate match.
		await seedBotRow("bot_search", "wld_search_home", "hosting-world", "findable-bot");
		await (testEnv.BICKR_D1 as unknown as D1DatabaseLike).batch([
			insertFixedConfigurationStatement(testEnv.BICKR_D1, {
				kind: "world", configurationId: "cfg_search_world", ownerUserId: ownerId,
				parentId: rootId, worldId: "wld_search", now,
			}),
			insertFixedConfigurationStatement(testEnv.BICKR_D1, {
				kind: "bot", configurationId: "cfg_search_bot", ownerUserId: ownerId,
				parentId: rootId, botId: "bot_search", now,
			}),
		]);

		const byCustomName = await listInferenceConfigurations(testEnv.BICKR_D1, ownerId, { query: "Searchable c" });
		expect(byCustomName.items.map((item) => item.displayName)).toEqual(["Searchable custom"]);
		const byWorldHandle = await listInferenceConfigurations(testEnv.BICKR_D1, ownerId, { query: "searchable-w" });
		expect(byWorldHandle.items.map((item) => item.id)).toEqual(["cfg_search_world"]);
		const byBotHandle = await listInferenceConfigurations(testEnv.BICKR_D1, ownerId, { query: "findable" });
		expect(byBotHandle.items.map((item) => item.id)).toEqual(["cfg_search_bot"]);
		// The home-world handle is the only term that reaches this participant,
		// whose own handle and displayed identity do not match it.
		const byHomeWorldHandle = await listInferenceConfigurations(testEnv.BICKR_D1, ownerId, { query: "hosting-w" });
		expect(byHomeWorldHandle.items.map((item) => item.id)).toEqual(["cfg_search_bot"]);
		const botsByHomeWorld = await listInferenceLibrarySection(testEnv.BICKR_D1, ownerId, {
			section: "bot",
			query: "hosting-world",
		});
		expect(botsByHomeWorld.items.map((item) => item.id)).toEqual(["cfg_search_bot"]);
		expect(botsByHomeWorld.groups.map((group) => group.botConfigurationCount)).toEqual([1]);
	});

	it("returns the unfiltered immediate-child total alongside a filtered child page", async () => {
		const rootId = await accountDefaultConfigurationId(ownerId);
		for (const name of ["Child alpha", "Child beta", "Other child"]) {
			await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, { name, parentId: rootId }, now);
		}
		const filtered = await listImmediateInferenceChildren(testEnv.BICKR_D1, ownerId, rootId, { query: "Child " });
		expect(filtered.items.map((item) => item.displayName).sort()).toEqual(["Child alpha", "Child beta"]);
		expect(filtered.totalImmediateChildren).toBe(3);
		const firstPage = await listImmediateInferenceChildren(testEnv.BICKR_D1, ownerId, rootId, { limit: 2 });
		expect(firstPage.items).toHaveLength(2);
		expect(firstPage.totalImmediateChildren).toBe(3);
		const secondPage = await listImmediateInferenceChildren(testEnv.BICKR_D1, ownerId, rootId, {
			limit: 2,
			cursor: firstPage.nextCursor,
		});
		expect(secondPage.items).toHaveLength(1);
		expect(secondPage.totalImmediateChildren).toBe(3);
	});

	it("rejects unknown sections, unknown kinds, and cursors from another sort order", async () => {
		expect(() => parseInferenceLibrarySection("participants")).toThrow(expect.objectContaining({ status: 400 }));
		expect(parseInferenceLibrarySection("bot")).toBe("bot");
		expect(() => parseInferenceConfigurationKinds("bot,participant")).toThrow(expect.objectContaining({ status: 400 }));
		expect(() => parseInferenceConfigurationKinds("")).toThrow(expect.objectContaining({ status: 400 }));
		expect(parseInferenceConfigurationKinds("bot, custom")).toEqual(["bot", "custom"]);

		const rootId = await accountDefaultConfigurationId(ownerId);
		for (const name of ["Cursor alpha", "Cursor beta"]) {
			await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, { name, parentId: rootId }, now);
		}
		const identityPage = await listInferenceConfigurations(testEnv.BICKR_D1, ownerId, { limit: 1 });
		expect(identityPage.nextCursor).toBeTruthy();
		await expect(listInferenceLibrarySection(testEnv.BICKR_D1, ownerId, {
			section: "bot",
			cursor: identityPage.nextCursor,
		})).rejects.toMatchObject({ status: 400 });
		await expect(listImmediateInferenceChildren(testEnv.BICKR_D1, ownerId, rootId, {
			cursor: identityPage.nextCursor,
		})).rejects.toMatchObject({ status: 400 });
		await expect(listInferenceConfigurations(testEnv.BICKR_D1, ownerId, { cursor: "not-a-cursor" }))
			.rejects.toMatchObject({ status: 400 });
	});

	it("refuses the Account-default base URL state on Account default in the writer and in D1", async () => {
		const rootId = await accountDefaultConfigurationId(ownerId);
		const root = (await loadInferenceConfigurationPath(testEnv.BICKR_D1, ownerId, rootId))[0];
		// The writer is a public mutation boundary, so misuse is a typed 400 and
		// matches the sibling Account-default credential rejection.
		await expect(inferenceConfigurationMutations.update(testEnv.BICKR_D1, ownerId, {
			configurationId: rootId,
			expectedRevision: root.revision,
			overrides: { baseUrl: { kind: "account_default" } },
		}, now)).rejects.toMatchObject({ code: "bad_request", status: 400 });
		await expect(inferenceConfigurationMutations.update(testEnv.BICKR_D1, ownerId, {
			configurationId: rootId,
			expectedRevision: root.revision,
			credential: { mode: "account_default" },
		}, now)).rejects.toMatchObject({ code: "bad_request", status: 400 });
		expect((await loadInferenceConfigurationPath(testEnv.BICKR_D1, ownerId, rootId))[0].revision).toBe(root.revision);
		// Stored corruption keeps its own untyped data error rather than a 400.
		expect(() => insertAccountDefaultConfigurationStatement(testEnv.BICKR_D1, {
			configurationId: rootId,
			ownerUserId: ownerId,
			now,
			overrides: { baseUrl: { kind: "account_default" } },
		})).toThrow(expect.objectContaining({ kind: "invalid_overrides" }));
		await expect(testEnv.BICKR_D1.prepare(
			`UPDATE inference_configurations SET overrides_json = ? WHERE configuration_id = ?`,
		).bind(JSON.stringify({ baseUrl: { kind: "account_default" } }), rootId).run()).rejects.toThrow();
		// A non-root entry may hold it, and the resolver resumes at Account default.
		const child = await inferenceConfigurationMutations.createCustom(testEnv.BICKR_D1, ownerId, {
			name: "Account default base",
			parentId: rootId,
			overrides: { baseUrl: { kind: "account_default" } },
		}, now);
		expect((await loadInferenceConfigurationPath(testEnv.BICKR_D1, ownerId, child.id))[0].overrides)
			.toMatchObject({ baseUrl: { kind: "account_default" } });
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

async function seedWorld(worldId: string, handle: string): Promise<void> {
	await testEnv.BICKR_D1.batch([
		testEnv.BICKR_D1.prepare(
			`INSERT INTO entity_lifecycle_identity_claims (
				key_kind, key_scope, key_value, entity_kind, entity_id, owner_user_id,
				claim_state, operation_id, created_at, updated_at
			) VALUES ('world_handle', 'global', ?, 'world', ?, ?, 'active', NULL, ?, ?)`,
		).bind(handle, worldId, ownerId, now, now),
		testEnv.BICKR_D1.prepare(
			`INSERT INTO worlds_index (
				world_id, handle, name, description, created_by_user_id, visibility,
				created_at, updated_at, lifecycle_state
			) VALUES (?, ?, ?, '', ?, 'public', ?, ?, 'active')`,
		).bind(worldId, handle, handle, ownerId, now, now),
	]);
}

async function seedBotRow(botId: string, worldId: string, worldHandle: string, handle: string): Promise<void> {
	await testEnv.BICKR_D1.batch([
		testEnv.BICKR_D1.prepare(
			`INSERT INTO entity_lifecycle_identity_claims (
				key_kind, key_scope, key_value, entity_kind, entity_id, owner_user_id,
				claim_state, operation_id, created_at, updated_at
			) VALUES ('bot_handle', ?, ?, 'bot', ?, ?, 'active', NULL, ?, ?)`,
		).bind(worldId, handle, botId, ownerId, now, now),
		testEnv.BICKR_D1.prepare(
			`INSERT INTO bots_index (
				bot_id, home_world_id, home_world_handle, handle, display_name,
				owner_user_id, short_bio, created_at, updated_at, lifecycle_state
			) VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, 'active')`,
		).bind(botId, worldId, worldHandle, handle, handle, ownerId, now, now),
	]);
}

/** Bulk fixture: participants spread round-robin across three seeded worlds. */
async function seedScaleBots(count: number, rootId: string): Promise<void> {
	const numbers = `WITH digits(value) AS (VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)),
		numbers(value) AS (
			SELECT ones.value + 10 * tens.value + 100 * hundreds.value
			FROM digits AS ones CROSS JOIN digits AS tens CROSS JOIN digits AS hundreds
		)`;
	await testEnv.BICKR_D1.prepare(
		`${numbers}
		INSERT INTO entity_lifecycle_identity_claims (
			key_kind, key_scope, key_value, entity_kind, entity_id, owner_user_id,
			claim_state, operation_id, created_at, updated_at
		)
		SELECT 'bot_handle', 'wld_scale_' || (value % 3), 'scale-bot-' || printf('%03d', value),
			'bot', 'bot_scale_' || printf('%03d', value), ?, 'active', NULL, ?, ?
		FROM numbers WHERE value < ? ORDER BY value`,
	).bind(ownerId, now, now, count).run();
	await testEnv.BICKR_D1.prepare(
		`${numbers}
		INSERT INTO bots_index (
			bot_id, home_world_id, home_world_handle, handle, display_name,
			owner_user_id, short_bio, created_at, updated_at, lifecycle_state
		)
		SELECT 'bot_scale_' || printf('%03d', value),
			'wld_scale_' || (value % 3),
			'scale-world-' || char(97 + value % 3),
			'scale-bot-' || printf('%03d', value),
			'scale-bot-' || printf('%03d', value),
			?, '', ?, ?, 'active'
		FROM numbers WHERE value < ? ORDER BY value`,
	).bind(ownerId, now, now, count).run();
	await testEnv.BICKR_D1.prepare(
		`${numbers}
		INSERT INTO inference_configurations (
			configuration_id, owner_user_id, kind, parent_id, bot_id,
			overrides_json, revision, created_at, updated_at
		)
		SELECT 'cfg_scale_bot_' || printf('%03d', value), ?, 'bot', ?,
			'bot_scale_' || printf('%03d', value), '{}', 1, ?, ?
		FROM numbers WHERE value < ? ORDER BY value`,
	).bind(ownerId, rootId, now, now, count).run();
}
