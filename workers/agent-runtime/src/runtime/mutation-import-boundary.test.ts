import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const repositoryCapabilities = [
	"accountBootstrapReservationRepositoryMutations",
	"userCoordinatorRepositoryMutations",
	"worldCoordinatorRepositoryMutations",
] as const;

// This fixed inventory is deliberately independent of the parsed capability
// objects. Removing a writer from a capability must fail even if a direct
// export or import is introduced in the same change.
const expectedRepositoryCapabilityMembers = {
	accountBootstrapReservationRepositoryMutations: [
		"normalizeProviderUserProfile",
		"prepareProviderUserBootstrap",
		"providerBootstrapClaim",
	],
	userCoordinatorRepositoryMutations: [
		"createBot",
		"deleteBot",
		"deleteBotAvatar",
		"linkProviderIdentity",
		"materializePendingBotAvatar",
		"providerUserBootstrapActivationStatements",
		"refreshLinkedCloneIndexes",
		"refreshNormalizedProviderIdentity",
		"refreshProviderIdentity",
		"relinkBotClone",
		"softDeleteUserProfile",
		"spreadUserBotTicks",
		"unlinkProviderIdentity",
		"unlinkBotClone",
		"updateBot",
		"updateBotAvatar",
		"updateUserAvatar",
		"updateUserProfile",
	],
	worldCoordinatorRepositoryMutations: [
		"addBotGroupMembers",
		"createBotGroup",
		"createForum",
		"createWorld",
		"deleteBotGroup",
		"removeBotGroupMember",
		"updateBotGroup",
	],
} as const satisfies Record<(typeof repositoryCapabilities)[number], readonly string[]>;

const expectedGovernanceMutationNames = [
	"deleteForum",
	"deleteForumForWorld",
	"deleteWorld",
	"updateForum",
	"updateWorld",
	"updateWorldAvatar",
] as const;

const retiredRepositoryMutationNames = [
	"providerIdentityUserId",
	"upsertProviderUser",
] as const;

const userCoordinatorModules = new Set([
	"workers/agent-runtime/src/routes.ts",
	"workers/agent-runtime/src/lifecycle/account.ts",
	"workers/agent-runtime/src/lifecycle/bot.ts",
]);
const worldCoordinatorModule = "workers/forum-coordinator/src/index.ts";
const accountBootstrapReservationModule = "workers/agent-runtime/src/lifecycle/account-bootstrap-reservation.ts";
const repositoryModule = "packages/shared/src/repository.ts";
const governanceModule = "packages/shared/src/governance.ts";
const inferenceConfigurationRepositoryModule = "packages/shared/src/inference-configuration-repository.ts";
const inferenceMigrationAdapterModule = "packages/shared/src/inference-configuration-migration.ts";
const inferenceMigrationAdapterSpecifier = "@bickr/shared/inference-configuration-migration";
const migrationFleetDispatchModule = "workers/agent-runtime/src/runtime/provider-default-barrier-sweep.ts";
const translationInferenceLifecycleModule = "packages/shared/src/inference-translation-role.ts";
const inferenceConfigurationMutationModules = new Set([
	"workers/agent-runtime/src/routes.ts",
	"test/entity-lifecycle.spec.ts",
	"test/inference-configuration-consumers.spec.ts",
	"test/inference-configuration-migration.spec.ts",
	"test/inference-configuration-repository.spec.ts",
	"test/inference-configuration-routes.spec.ts",
]);

describe("serialized entity mutation import boundary", () => {
	it("allows coordinator mutation capabilities only at the narrow serialized writer modules", () => {
		const repositorySource = readFileSync(resolve(process.cwd(), repositoryModule), "utf8");
		const governanceSource = readFileSync(resolve(process.cwd(), governanceModule), "utf8");
		for (const capability of repositoryCapabilities) {
			expect(capabilityMembers(repositorySource, capability).sort()).toEqual(
				[...expectedRepositoryCapabilityMembers[capability]].sort(),
			);
		}
		expect(capabilityMembers(governanceSource, "coordinatorGovernanceMutations").sort())
			.toEqual([...expectedGovernanceMutationNames].sort());
		const repositoryMutationNames = new Set<string>([
			...repositoryCapabilities.flatMap((capability) => expectedRepositoryCapabilityMembers[capability]),
			...retiredRepositoryMutationNames,
		]);
		const governanceMutationNames = new Set<string>(expectedGovernanceMutationNames);
		const modules = sourceModuleFiles(resolve(process.cwd())).map((filename) => ({
			filename,
			source: readFileSync(filename, "utf8"),
		}));
		const violations = modules.flatMap(({ filename, source }) =>
			mutationBoundaryViolations(
				filename,
				source,
				repositoryMutationNames,
				governanceMutationNames,
			)).concat(mutationEscapeViolations(
			modules,
			repositoryMutationNames,
			governanceMutationNames,
		));
		expect(violations).toEqual([]);
	});

	it("keeps inference graph mutations inside the user coordinator queue", () => {
		const repositorySource = readFileSync(resolve(process.cwd(), inferenceConfigurationRepositoryModule), "utf8");
		expect(capabilityMembers(repositorySource, "inferenceConfigurationMutations").sort()).toEqual([
			"createCustom",
			"deleteCustom",
			"ensureCompatibilityTranslation",
			"renameCustom",
			"reparent",
			"update",
			"updateLegacyTranslationPointer",
		].sort());
		const violations = sourceModuleFiles(resolve(process.cwd())).flatMap((filename) => {
			const relativeFilename = relativePath(filename);
			if (relativeFilename === inferenceConfigurationRepositoryModule) return [];
			const source = readFileSync(filename, "utf8");
			const importsCapability = /import\s*\{[^}]*\binferenceConfigurationMutations\b[^}]*\}\s*from\s*['"]@bickr\/shared\/inference-configuration-repository['"]/.test(source);
			return importsCapability && !inferenceConfigurationMutationModules.has(relativeFilename)
				? [`${relativeFilename}: imports or launders inferenceConfigurationMutations outside UserBotsCoordinator routes`]
				: [];
		});
		expect(violations).toEqual([]);

		const translationLifecycleSource = readFileSync(resolve(process.cwd(), translationInferenceLifecycleModule), "utf8");
		expect(capabilityMembers(translationLifecycleSource, "translationInferenceLifecycle").sort()).toEqual([
			"completeMigration",
			"disable",
			"enable",
			"migrateLegacy",
		].sort());
		const translationLifecycleImporters = new Set([
			"packages/shared/src/inference-translation-role-migration.ts",
			"test/entity-lifecycle.spec.ts",
			"test/inference-configuration-consumers.spec.ts",
			"test/inference-configuration-migration.spec.ts",
			"test/inference-configuration-repository.spec.ts",
			"test/inference-configuration-routes.spec.ts",
			"test/translation-runtime.spec.ts",
			"workers/agent-runtime/src/routes.ts",
		]);
		const lifecycleViolations = sourceModuleFiles(resolve(process.cwd())).flatMap((filename) => {
			const relativeFilename = relativePath(filename);
			if (relativeFilename === translationInferenceLifecycleModule) return [];
			const source = readFileSync(filename, "utf8");
			const importsCapability = /import\s*\{[^}]*\btranslationInferenceLifecycle\b[^}]*\}\s*from\s*['"]@bickr\/shared\/inference-translation-role['"]/.test(source);
			return importsCapability && !translationLifecycleImporters.has(relativeFilename)
				? [`${relativeFilename}: imports translationInferenceLifecycle outside UserBotsCoordinator routes or migration tests`]
				: [];
		});
		expect(lifecycleViolations).toEqual([]);
	});

	it("keeps legacy compatibility and migration adapters at their versioned coordinator boundaries", () => {
		const legacyAdapterModules = new Set([
			"packages/shared/src/inference-configuration-migration.ts",
			"workers/agent-runtime/src/lifecycle/account.ts",
			"workers/agent-runtime/src/lifecycle/bot.ts",
			"workers/agent-runtime/src/lifecycle/world.ts",
			"workers/agent-runtime/src/routes.ts",
		]);
		const migrationAdapterModules = new Set([
			"test/inference-configuration-migration.spec.ts",
			"workers/agent-runtime/src/routes.ts",
		]);
		// The scheduled fleet driver is not a second migration entry point: it
		// claims fleet-queue rows and then dispatches each owner's sweep into the
		// UserBotsCoordinator route that owns the configuration writes. It is
		// therefore allowed exactly these two names as static named imports and
		// nothing else — no other member, and no whole-module shape (default,
		// namespace, re-export, dynamic import, require, import-equals) that would
		// carry the migration writers in without naming them.
		const migrationFleetDispatchImports = new Set([
			"claimInferenceProviderDefaultBarrierSweepFleetOwners",
			"InferenceProviderDefaultBarrierSweepFleetClaim",
		]);
		const graphSqlWriterModules = new Set([
			"packages/shared/src/inference-configuration-migration.ts",
			"packages/shared/src/inference-configuration-repository.ts",
			translationInferenceLifecycleModule,
		]);
		const violations = sourceModuleFiles(resolve(process.cwd())).flatMap((filename) => {
			const relativeFilename = relativePath(filename);
			const source = readFileSync(filename, "utf8");
			const result: string[] = [];
			if (/from\s*['"]@bickr\/shared\/inference-configuration-legacy['"]/.test(source) &&
				!legacyAdapterModules.has(relativeFilename)) {
				result.push(`${relativeFilename}: imports the legacy inference adapter outside lifecycle/migration/UserBotsCoordinator`);
			}
			if (relativeFilename === migrationFleetDispatchModule) {
				result.push(...inferenceMigrationImportViolations(filename, source, migrationFleetDispatchImports));
			} else if (relativeFilename !== inferenceMigrationAdapterModule && !migrationAdapterModules.has(relativeFilename)) {
				result.push(...inferenceMigrationImportViolations(filename, source, null));
			}
			if (!relativeFilename.includes(".test.") && !relativeFilename.startsWith("test/") &&
				/(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+inference_configurations\b/i.test(source) &&
				!graphSqlWriterModules.has(relativeFilename)) {
				result.push(`${relativeFilename}: writes inference_configurations outside the repository or lifecycle/migration adapter`);
			}
			return result;
		});
		expect(violations).toEqual([]);
	});

	it("rejects every migration adapter shape the fleet claim allowance does not name", () => {
		const fleetModule = resolve(process.cwd(), migrationFleetDispatchModule);
		const allowance = new Set([
			"claimInferenceProviderDefaultBarrierSweepFleetOwners",
			"InferenceProviderDefaultBarrierSweepFleetClaim",
		]);
		const compliant = [
			"import {",
			"	claimInferenceProviderDefaultBarrierSweepFleetOwners,",
			"	type InferenceProviderDefaultBarrierSweepFleetClaim,",
			'} from "@bickr/shared/inference-configuration-migration";',
		].join("\n");
		const violationsFor = (source: string): string[] =>
			inferenceMigrationImportViolations(fleetModule, source, allowance);
		const escapes = (shape: string): string =>
			`${migrationFleetDispatchModule}: reaches the migration adapter through ${shape} instead of the named fleet claim`;

		expect(violationsFor(compliant)).toEqual([]);
		expect(violationsFor("")).toEqual([
			`${migrationFleetDispatchModule}: no longer imports the allowed fleet claim members ` +
				"InferenceProviderDefaultBarrierSweepFleetClaim, claimInferenceProviderDefaultBarrierSweepFleetOwners",
		]);

		expect(violationsFor(`${compliant}\nexport { migrateOwnerProviderDefaultBarrier } from "@bickr/shared/inference-configuration-migration";`))
			.toContain(escapes("a re-export"));
		expect(violationsFor(`${compliant}\nexport { claimInferenceProviderDefaultBarrierSweepFleetOwners } from "@bickr/shared/inference-configuration-migration";`))
			.toContain(escapes("a re-export"));
		expect(violationsFor(`${compliant}\nexport * from "@bickr/shared/inference-configuration-migration";`))
			.toContain(escapes("a namespace re-export"));
		expect(violationsFor(`${compliant}\nexport * as migration from "@bickr/shared/inference-configuration-migration";`))
			.toContain(escapes("a namespace re-export"));
		expect(violationsFor(`${compliant}\nconst load = () => import("@bickr/shared/inference-configuration-migration");`))
			.toContain(escapes("a dynamic import"));
		expect(violationsFor(`${compliant}\nconst migration = require("@bickr/shared/inference-configuration-migration");`))
			.toContain(escapes("a require"));
		expect(violationsFor(`${compliant}\nimport migration = require("@bickr/shared/inference-configuration-migration");`))
			.toContain(escapes("an import-equals"));
		expect(violationsFor('import migration from "@bickr/shared/inference-configuration-migration";'))
			.toContain(escapes("a default import"));
		expect(violationsFor('import * as migration from "@bickr/shared/inference-configuration-migration";'))
			.toContain(escapes("a namespace import"));
		expect(violationsFor(`${compliant}\nimport "@bickr/shared/inference-configuration-migration";`))
			.toContain(escapes("a bare side-effect import"));
		expect(violationsFor(`${compliant}\nconst load = () => import(chooseMigrationModule());`))
			.toContain(escapes("a computed dynamic import"));
		expect(violationsFor(`${compliant}\nconst migration = require(chooseMigrationModule());`))
			.toContain(escapes("a computed require"));

		// A relative specifier reaches the same file, and an alias cannot dress a
		// migration writer up as the allowed claim: the exported name is reported.
		const beyondClaim =
			`${migrationFleetDispatchModule}: imports migration adapter members migrateOwnerProviderDefaultBarrier beyond the fleet claim`;
		expect(violationsFor(
			'import { migrateOwnerProviderDefaultBarrier } from "../../../../packages/shared/src/inference-configuration-migration";',
		)).toContain(beyondClaim);
		expect(violationsFor(`${compliant}\nimport { migrateOwnerProviderDefaultBarrier as ` +
			'claimInferenceProviderDefaultBarrierSweepFleetOwners } from "@bickr/shared/inference-configuration-migration";',
		)).toContain(beyondClaim);

		// Outside the allowance any shape at all is the side door, including the
		// ones that name nothing.
		const outsider = resolve(process.cwd(), "workers/agent-runtime/src/runtime/virtual-migration-consumer.ts");
		const outsiderViolation =
			"workers/agent-runtime/src/runtime/virtual-migration-consumer.ts: imports the inference migration adapter outside UserBotsCoordinator or its focused test";
		for (const source of [
			compliant,
			'export * from "@bickr/shared/inference-configuration-migration";',
			'const load = () => import("@bickr/shared/inference-configuration-migration");',
			'const migration = require("@bickr/shared/inference-configuration-migration");',
			'import migration = require("@bickr/shared/inference-configuration-migration");',
		]) {
			expect(inferenceMigrationImportViolations(outsider, source, null)).toEqual([outsiderViolation]);
		}
		expect(inferenceMigrationImportViolations(outsider, "const load = () => import(chooseModule());", null)).toEqual([]);
	});

	it("keeps fixed-entry configuration addressing on the authenticated server side", () => {
		// Browser code names the entity a settings screen already displays and
		// lets the owner-authenticated lookup resolve it. Deriving the address in
		// the browser would place an authorization decision on the client and
		// bypass the entity-ownership check the lookup performs.
		const derivationNames = [
			"accountDefaultConfigurationId",
			"worldConfigurationId",
			"botConfigurationId",
			"deterministicId",
		];
		const browserRoot = resolve(process.cwd(), "apps/web/src");
		const violations = sourceModuleFiles(browserRoot).flatMap((filename) => {
			const relativeFilename = relativePath(filename);
			if (relativeFilename.includes(".test.")) return [];
			const source = readFileSync(filename, "utf8");
			const result: string[] = [];
			for (const name of derivationNames) {
				if (source.includes(name)) {
					result.push(`${relativeFilename}: derives a fixed inference configuration address in browser code (${name})`);
				}
			}
			if (/from\s*['"]@bickr\/shared\/inference-configuration-repository['"]/.test(source)) {
				result.push(`${relativeFilename}: imports the secret-capable inference repository from browser code`);
			}
			return result;
		});
		expect(violations).toEqual([]);
	});

	it("detects relative, dynamic, import-equals, default-export, re-export, and exported-const side doors", () => {
		const repositoryNames = new Set<string>(["deleteBot", "createWorld"]);
		const governanceNames = new Set<string>(["deleteWorld"]);
		const sibling = resolve(process.cwd(), "packages/shared/src/social.ts");
		const page = resolve(process.cwd(), "apps/web/functions/bypass.ts");
		expect(mutationBoundaryViolations(
			sibling,
			'export { deleteBot } from "./repository";',
			repositoryNames,
			governanceNames,
		)).toContain(`${relativePath(sibling)}: re-exports repository mutation deleteBot`);
		expect(mutationBoundaryViolations(
			page,
			'const load = () => import("../../../packages/shared/src/governance");',
			repositoryNames,
			governanceNames,
		)).toContain(`${relativePath(page)}: dynamically imports governance and can bypass mutation capabilities`);
		expect(mutationBoundaryViolations(
			page,
			'import repository = require("../../../packages/shared/src/repository");',
			repositoryNames,
			governanceNames,
		)).toContain(`${relativePath(page)}: import-equals repository and can bypass mutation capabilities`);
		expect(mutationBoundaryViolations(
			page,
			"const moduleName = chooseModule(); const load = () => import(moduleName);",
			repositoryNames,
			governanceNames,
		)).toContain(`${relativePath(page)}: uses a computed dynamic import that can bypass mutation capabilities`);
		expect(mutationBoundaryViolations(
			resolve(process.cwd(), repositoryModule),
			"export const createWorld = async () => undefined;",
			repositoryNames,
			governanceNames,
		)).toContain(`${repositoryModule}: unrestricted repository mutation export createWorld`);
		expect(mutationBoundaryViolations(
			resolve(process.cwd(), repositoryModule),
			"const writers = { createWorld }; export default writers;",
			repositoryNames,
			governanceNames,
		)).toContain(`${repositoryModule}: default-exports repository and can bypass mutation capabilities`);
	});

	it("detects capability and destructured-writer laundering across aliases, defaults, and two hops", () => {
		const writer = resolve(process.cwd(), "workers/agent-runtime/src/lifecycle/virtual-writer.ts");
		const barrel = resolve(process.cwd(), "workers/agent-runtime/src/lifecycle/virtual-barrel.mts");
		const consumer = resolve(process.cwd(), "apps/web/functions/virtual-consumer.tsx");
		const repositoryNames = new Set<string>(["createBot"]);
		const violations = mutationEscapeViolations([
			{
				filename: writer,
				source: `
					import { userCoordinatorRepositoryMutations } from "@bickr/shared/repository";
					const capabilityAlias = userCoordinatorRepositoryMutations;
					const { createBot: destructuredWriter } = capabilityAlias;
					export { capabilityAlias as default, destructuredWriter as escapedWriter };
				`,
			},
			{
				filename: barrel,
				source: `
					export { default as escapedCapability, escapedWriter as default }
						from "./virtual-writer";
				`,
			},
			{
				filename: consumer,
				source: `
					import escapedWriter, { escapedCapability } from
						"../../../workers/agent-runtime/src/lifecycle/virtual-barrel.mts";
					void escapedWriter;
					void escapedCapability;
				`,
			},
		], repositoryNames, new Set());

		expect(violations).toEqual(expect.arrayContaining([
			expect.stringContaining("virtual-writer.ts: exports repository mutation authority as default"),
			expect.stringContaining("virtual-writer.ts: exports repository mutation authority as escapedWriter"),
			expect.stringContaining("virtual-barrel.mts: imports repository mutation authority from an intermediate module"),
			expect.stringContaining("virtual-barrel.mts: exports repository mutation authority as escapedCapability"),
			expect.stringContaining("virtual-consumer.tsx: imports repository mutation authority from an intermediate module"),
		]));
	});

	it("scans JavaScript module extensions for direct writer-module side doors", () => {
		const script = resolve(process.cwd(), "scripts/virtual-writer-bypass.mjs");
		expect(mutationBoundaryViolations(
			script,
			'import { createBot } from "../packages/shared/src/repository.ts";',
			new Set(["createBot"]),
			new Set(),
		)).toContain(`${relativePath(script)}: directly imports repository mutation createBot`);
	});

	it("detects CommonJS require aliases and module.exports laundering", () => {
		const writer = resolve(process.cwd(), "scripts/virtual-writer.cjs");
		const consumer = resolve(process.cwd(), "scripts/virtual-consumer.mjs");
		const violations = mutationEscapeViolations([
			{
				filename: writer,
				source: `
					const repository = require("@bickr/shared/repository");
					const capabilityAlias = repository.userCoordinatorRepositoryMutations;
					module.exports = { escapedCapability: capabilityAlias };
				`,
			},
			{
				filename: consumer,
				source: 'const escaped = require("./virtual-writer.cjs"); void escaped;',
			},
		], new Set(["createBot"]), new Set());

		expect(violations).toEqual(expect.arrayContaining([
			expect.stringContaining("virtual-writer.cjs: exports repository mutation authority as default"),
			expect.stringContaining("virtual-consumer.mjs: imports repository mutation authority from an intermediate module"),
		]));
	});
});

function capabilityMembers(source: string, name: string): string[] {
	const sourceFile = ts.createSourceFile("capability.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	for (const statement of sourceFile.statements) {
		if (!ts.isVariableStatement(statement)) continue;
		for (const declaration of statement.declarationList.declarations) {
			if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name || !declaration.initializer) continue;
			const initializer = declaration.initializer;
			if (!ts.isCallExpression(initializer) || initializer.arguments.length !== 1) continue;
			const expression = initializer.expression;
			if (!ts.isPropertyAccessExpression(expression) || expression.expression.getText() !== "Object" || expression.name.text !== "freeze") continue;
			const object = initializer.arguments[0];
			if (!object || !ts.isObjectLiteralExpression(object)) continue;
			return object.properties
				.map((property) => propertyName(property))
				.filter((member): member is string => member !== null);
		}
	}
	expect.fail(`Missing mutation capability ${name}`);
}

/**
 * Every way a module reaches the inference migration adapter, split by shape.
 * `namedImports` holds the exported names static named imports bind, taking the
 * exported name over any local alias so that renaming a migration writer to look
 * like the fleet claim still reports the writer. Nothing else names what it
 * carries: a default or namespace import, a re-export, a dynamic import, a
 * require, and an import-equals all take the whole module, so they can never
 * satisfy a name-scoped allowance and are reported as escapes instead. A
 * specifier this scan cannot read at all is reported separately, because only a
 * module under a name-scoped allowance is required to keep its specifiers
 * literal.
 */
function inferenceMigrationReferences(filename: string, source: string): {
	namedImports: string[];
	escapes: string[];
	computed: string[];
} {
	const sourceFile = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, scriptKind(filename));
	const namedImports: string[] = [];
	const escapes: string[] = [];
	const computed: string[] = [];
	const targetsAdapter = (specifier: string): boolean => isInferenceMigrationSpecifier(filename, specifier);
	for (const statement of sourceFile.statements) {
		if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier) &&
			targetsAdapter(statement.moduleSpecifier.text)) {
			const clause = statement.importClause;
			if (!clause) {
				escapes.push("a bare side-effect import");
			} else {
				if (clause.name) escapes.push("a default import");
				const bindings = clause.namedBindings;
				if (bindings && ts.isNamespaceImport(bindings)) {
					escapes.push("a namespace import");
				} else if (bindings && ts.isNamedImports(bindings)) {
					for (const element of bindings.elements) namedImports.push((element.propertyName ?? element.name).text);
				}
			}
		}
		if (ts.isExportDeclaration(statement) && statement.moduleSpecifier &&
			ts.isStringLiteralLike(statement.moduleSpecifier) && targetsAdapter(statement.moduleSpecifier.text)) {
			escapes.push(statement.exportClause && ts.isNamedExports(statement.exportClause)
				? "a re-export"
				: "a namespace re-export");
		}
		if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)) {
			const expression = statement.moduleReference.expression;
			if (!expression || !ts.isStringLiteralLike(expression)) {
				computed.push("a computed import-equals");
			} else if (targetsAdapter(expression.text)) {
				escapes.push("an import-equals");
			}
		}
	}
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node)) {
			const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
			const commonJsRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
			if (dynamicImport || commonJsRequire) {
				const argument = node.arguments.length === 1 ? node.arguments[0] : undefined;
				if (!argument || !ts.isStringLiteralLike(argument)) {
					computed.push(dynamicImport ? "a computed dynamic import" : "a computed require");
				} else if (targetsAdapter(argument.text)) {
					escapes.push(dynamicImport ? "a dynamic import" : "a require");
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return {
		namedImports: [...new Set(namedImports)],
		escapes: [...new Set(escapes)],
		computed: [...new Set(computed)],
	};
}

/**
 * With no allowance the adapter must not be reached at all. With one, the module
 * must hold exactly the allowed names as static named imports: extra members,
 * missing members, whole-module shapes, and specifiers this scan cannot read all
 * fail, so a side door cannot be opened without changing the allowance itself.
 */
function inferenceMigrationImportViolations(
	filename: string,
	source: string,
	allowance: ReadonlySet<string> | null,
): string[] {
	const path = relativePath(filename);
	const { namedImports, escapes, computed } = inferenceMigrationReferences(filename, source);
	if (!allowance) {
		return namedImports.length > 0 || escapes.length > 0
			? [`${path}: imports the inference migration adapter outside UserBotsCoordinator or its focused test`]
			: [];
	}
	const violations: string[] = [];
	for (const shape of [...escapes, ...computed]) {
		violations.push(`${path}: reaches the migration adapter through ${shape} instead of the named fleet claim`);
	}
	const beyond = namedImports.filter((name) => !allowance.has(name));
	if (beyond.length > 0) {
		violations.push(`${path}: imports migration adapter members ${beyond.sort().join(", ")} beyond the fleet claim`);
	}
	const missing = [...allowance].filter((name) => !namedImports.includes(name));
	if (missing.length > 0) {
		violations.push(`${path}: no longer imports the allowed fleet claim members ${missing.sort().join(", ")}`);
	}
	return [...new Set(violations)];
}

function isInferenceMigrationSpecifier(filename: string, specifier: string): boolean {
	if (specifier === inferenceMigrationAdapterSpecifier) return true;
	if (!specifier.startsWith(".")) return false;
	const resolved = resolve(dirname(filename), specifier).replace(/\.(?:[cm]?[jt]s)$/u, "");
	return resolved === resolve(process.cwd(), inferenceMigrationAdapterModule).replace(/\.ts$/u, "");
}

type MutationModuleKind = "repository" | "governance";

function mutationBoundaryViolations(
	filename: string,
	source: string,
	repositoryMutationNames: ReadonlySet<string>,
	governanceMutationNames: ReadonlySet<string>,
): string[] {
	const path = relativePath(filename);
	const sourceFile = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, scriptKind(filename));
	const violations: string[] = [];
	for (const statement of sourceFile.statements) {
		if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
			const kind = mutationModuleKind(filename, statement.moduleSpecifier.text);
			if (kind && statement.importClause) {
				const bindings = statement.importClause.namedBindings;
				if (statement.importClause.name || bindings && ts.isNamespaceImport(bindings)) {
					violations.push(`${path}: namespace-imports ${kind} and can bypass mutation capabilities`);
				} else if (bindings && ts.isNamedImports(bindings)) {
					for (const element of bindings.elements) {
						checkImportedName(
							violations,
							path,
							kind,
							(element.propertyName ?? element.name).text,
							repositoryMutationNames,
							governanceMutationNames,
						);
					}
				}
			}
		}
		if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)) {
			const expression = statement.moduleReference.expression;
			if (!expression || !ts.isStringLiteralLike(expression)) {
				violations.push(`${path}: uses a computed import-equals that can bypass mutation capabilities`);
			} else {
				const kind = mutationModuleKind(filename, expression.text);
				if (kind) violations.push(`${path}: import-equals ${kind} and can bypass mutation capabilities`);
			}
		}
		if (ts.isExportDeclaration(statement)) {
			const kind = statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)
				? mutationModuleKind(filename, statement.moduleSpecifier.text)
				: path === repositoryModule ? "repository" : path === governanceModule ? "governance" : null;
			if (kind) inspectExportDeclaration(
				violations,
				path,
				kind,
				statement,
				repositoryMutationNames,
				governanceMutationNames,
			);
		}
		if (path === repositoryModule || path === governanceModule) {
			const kind = path === repositoryModule ? "repository" : "governance";
			if (isDefaultOrAssignmentExport(statement)) {
				violations.push(`${path}: default-exports ${kind} and can bypass mutation capabilities`);
			}
			const names = kind === "repository" ? repositoryMutationNames : governanceMutationNames;
			for (const name of exportedDeclarationNames(statement)) {
				if (names.has(name)) violations.push(`${path}: unrestricted ${kind} mutation export ${name}`);
			}
		}
	}
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
			const argument = node.arguments.length === 1 ? node.arguments[0] : undefined;
			if (!argument || !ts.isStringLiteralLike(argument)) {
				violations.push(`${path}: uses a computed dynamic import that can bypass mutation capabilities`);
			} else {
				const kind = mutationModuleKind(filename, argument.text);
				if (kind) violations.push(`${path}: dynamically imports ${kind} and can bypass mutation capabilities`);
			}
		}
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
			const argument = node.arguments.length === 1 ? node.arguments[0] : undefined;
			if (!argument || !ts.isStringLiteralLike(argument)) {
				violations.push(`${path}: uses a computed require that can bypass mutation capabilities`);
			} else {
				const kind = mutationModuleKind(filename, argument.text);
				if (kind) violations.push(`${path}: requires ${kind} and can bypass mutation capabilities`);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return [...new Set(violations)];
}

function inspectExportDeclaration(
	violations: string[],
	path: string,
	kind: MutationModuleKind,
	statement: ts.ExportDeclaration,
	repositoryMutationNames: ReadonlySet<string>,
	governanceMutationNames: ReadonlySet<string>,
): void {
	if (!statement.exportClause || ts.isNamespaceExport(statement.exportClause)) {
		violations.push(`${path}: namespace-re-exports ${kind} and can bypass mutation capabilities`);
		return;
	}
	for (const element of statement.exportClause.elements) {
		const exportedName = (element.propertyName ?? element.name).text;
		if (exportedName === "default") {
			violations.push(`${path}: default-re-exports ${kind} and can bypass mutation capabilities`);
		}
		const names = kind === "repository" ? repositoryMutationNames : governanceMutationNames;
		if (names.has(exportedName)) violations.push(`${path}: re-exports ${kind} mutation ${exportedName}`);
		checkImportedName(
			violations,
			path,
			kind,
			exportedName,
			repositoryMutationNames,
			governanceMutationNames,
			true,
		);
	}
}

function isDefaultOrAssignmentExport(statement: ts.Statement): boolean {
	if (ts.isExportAssignment(statement)) return true;
	return ts.canHaveModifiers(statement) && Boolean(
		ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword),
	);
}

function checkImportedName(
	violations: string[],
	path: string,
	kind: MutationModuleKind,
	name: string,
	repositoryMutationNames: ReadonlySet<string>,
	governanceMutationNames: ReadonlySet<string>,
	reexport = false,
): void {
	const verb = reexport ? "re-exports" : "imports";
	if (kind === "repository") {
		if (name === "userCoordinatorRepositoryMutations" && !userCoordinatorModules.has(path)) {
			violations.push(`${path}: ${verb} the user-coordinator mutation capability`);
		}
		if (name === "accountBootstrapReservationRepositoryMutations" && path !== accountBootstrapReservationModule) {
			violations.push(`${path}: ${verb} the pre-dispatch account-bootstrap reservation capability`);
		}
		if (name === "worldCoordinatorRepositoryMutations" && path !== worldCoordinatorModule) {
			violations.push(`${path}: ${verb} the world-coordinator repository mutation capability`);
		}
		if (name === "coordinatorRepositoryMutations") {
			violations.push(`${path}: ${verb} the retired monolithic coordinator capability`);
		}
		if (repositoryMutationNames.has(name)) {
			violations.push(`${path}: directly ${verb} repository mutation ${name}`);
		}
	} else {
		if (name === "coordinatorGovernanceMutations" && path !== worldCoordinatorModule) {
			violations.push(`${path}: ${verb} the world-coordinator governance mutation capability`);
		}
		if (governanceMutationNames.has(name)) {
			violations.push(`${path}: directly ${verb} governance mutation ${name}`);
		}
	}
}

function mutationModuleKind(filename: string, specifier: string): MutationModuleKind | null {
	if (specifier === "@bickr/shared/repository") return "repository";
	if (specifier === "@bickr/shared/governance") return "governance";
	const resolved = specifier.startsWith(".")
		? resolve(dirname(filename), specifier)
		: resolve(process.cwd(), specifier);
	const withoutExtension = resolved.replace(/\.(?:[cm]?[jt]s)$/u, "");
	if (withoutExtension === resolve(process.cwd(), repositoryModule).replace(/\.ts$/u, "")) return "repository";
	if (withoutExtension === resolve(process.cwd(), governanceModule).replace(/\.ts$/u, "")) return "governance";
	return null;
}

function exportedDeclarationNames(statement: ts.Statement): string[] {
	if (!ts.canHaveModifiers(statement) || !ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return [];
	if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
		return statement.name ? [statement.name.text] : [];
	}
	if (ts.isVariableStatement(statement)) {
		return statement.declarationList.declarations.flatMap((declaration) =>
			ts.isIdentifier(declaration.name) ? [declaration.name.text] : []);
	}
	return [];
}

function propertyName(property: ts.ObjectLiteralElementLike): string | null {
	if (ts.isShorthandPropertyAssignment(property)) return property.name.text;
	if (ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)) {
		return ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) ? property.name.text : null;
	}
	return null;
}

function relativePath(filename: string): string {
	return relative(process.cwd(), filename).replaceAll("\\", "/");
}

type MutationAuthorityKind = MutationModuleKind;

type SourceModule = {
	filename: string;
	source: string;
};

type AuthorityImport = {
	path: string;
	sourceFilename: string;
	targetNode: string;
};

type AuthorityExport = {
	path: string;
	exportedName: string;
	targetNode: string;
};

function mutationEscapeViolations(
	modules: readonly SourceModule[],
	repositoryMutationNames: ReadonlySet<string>,
	governanceMutationNames: ReadonlySet<string>,
): string[] {
	const repositoryFilename = resolve(process.cwd(), repositoryModule);
	const governanceFilename = resolve(process.cwd(), governanceModule);
	const knownFiles = new Set(modules.map(({ filename }) => resolve(filename)));
	knownFiles.add(repositoryFilename);
	knownFiles.add(governanceFilename);
	const authorityNames = {
		repository: new Set<string>([
			...repositoryMutationNames,
			...repositoryCapabilities,
			"coordinatorRepositoryMutations",
		]),
		governance: new Set<string>([
			...governanceMutationNames,
			"coordinatorGovernanceMutations",
		]),
	} satisfies Record<MutationAuthorityKind, Set<string>>;
	const allAuthorityNames = new Set([
		...authorityNames.repository,
		...authorityNames.governance,
	]);
	const edges: Array<{ from: string; to: string }> = [];
	const imports: AuthorityImport[] = [];
	const exports: AuthorityExport[] = [];
	const dynamicImports: Array<{ path: string; sourceFilename: string; targetNode: string }> = [];
	const taints = new Map<string, Set<MutationAuthorityKind>>();

	const taint = (node: string, kind: MutationAuthorityKind): void => {
		const kinds = taints.get(node) ?? new Set<MutationAuthorityKind>();
		kinds.add(kind);
		taints.set(node, kinds);
	};
	for (const name of authorityNames.repository) taint(exportNode(repositoryFilename, name), "repository");
	for (const name of authorityNames.governance) taint(exportNode(governanceFilename, name), "governance");
	taint(moduleAuthorityNode(repositoryFilename), "repository");
	taint(moduleAuthorityNode(governanceFilename), "governance");

	for (const module of modules) {
		const filename = resolve(module.filename);
		const path = relativePath(filename);
		const sourceFile = ts.createSourceFile(
			filename,
			module.source,
			ts.ScriptTarget.Latest,
			true,
			scriptKind(filename),
		);
		const addExport = (exportedName: string, fromNodes: readonly string[]): void => {
			const targetNode = exportNode(filename, exportedName);
			for (const from of fromNodes) edges.push({ from, to: targetNode });
			edges.push({ from: targetNode, to: moduleAuthorityNode(filename) });
			exports.push({ path, exportedName, targetNode });
		};
		const sourceFilename = (specifier: string): string | null => resolveSourceModule(
			filename,
			specifier,
			knownFiles,
			repositoryFilename,
			governanceFilename,
		);
		const importedExpressionNode = (expression: ts.Expression): {
			sourceFilename: string;
			sourceNode: string;
		} | null => {
			const unwrapped = ts.isAwaitExpression(expression) ? expression.expression : expression;
			const propertyName = ts.isPropertyAccessExpression(unwrapped)
				? unwrapped.name.text
				: ts.isElementAccessExpression(unwrapped) && unwrapped.argumentExpression &&
					ts.isStringLiteralLike(unwrapped.argumentExpression)
					? unwrapped.argumentExpression.text
					: null;
			const call = ts.isCallExpression(unwrapped)
				? unwrapped
				: propertyName && (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) &&
					ts.isCallExpression(unwrapped.expression)
					? unwrapped.expression
					: null;
			if (!call || !(
				call.expression.kind === ts.SyntaxKind.ImportKeyword ||
				ts.isIdentifier(call.expression) && call.expression.text === "require"
			)) return null;
			const argument = call.arguments.length === 1 ? call.arguments[0] : undefined;
			if (!argument || !ts.isStringLiteralLike(argument)) return null;
			const importedFrom = sourceFilename(argument.text);
			return importedFrom ? {
				sourceFilename: importedFrom,
				sourceNode: propertyName
					? exportNode(importedFrom, propertyName)
					: moduleAuthorityNode(importedFrom),
			} : null;
		};

		for (const statement of sourceFile.statements) {
			if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier) && statement.importClause) {
				const importedFrom = sourceFilename(statement.moduleSpecifier.text);
				if (importedFrom) {
					if (statement.importClause.name) {
						const targetNode = localNode(filename, statement.importClause.name.text);
						edges.push({ from: exportNode(importedFrom, "default"), to: targetNode });
						imports.push({ path, sourceFilename: importedFrom, targetNode });
					}
					const bindings = statement.importClause.namedBindings;
					if (bindings && ts.isNamespaceImport(bindings)) {
						const targetNode = localNode(filename, bindings.name.text);
						edges.push({ from: moduleAuthorityNode(importedFrom), to: targetNode });
						imports.push({ path, sourceFilename: importedFrom, targetNode });
					} else if (bindings && ts.isNamedImports(bindings)) {
						for (const element of bindings.elements) {
							const targetNode = localNode(filename, element.name.text);
							edges.push({
								from: exportNode(importedFrom, (element.propertyName ?? element.name).text),
								to: targetNode,
							});
							imports.push({ path, sourceFilename: importedFrom, targetNode });
						}
					}
				}
			}

			if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)) {
				const expression = statement.moduleReference.expression;
				if (expression && ts.isStringLiteralLike(expression)) {
					const importedFrom = sourceFilename(expression.text);
					if (importedFrom) {
						const targetNode = localNode(filename, statement.name.text);
						edges.push({ from: moduleAuthorityNode(importedFrom), to: targetNode });
						imports.push({ path, sourceFilename: importedFrom, targetNode });
					}
				}
			}

			if (ts.isVariableStatement(statement)) {
				const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
				for (const declaration of statement.declarationList.declarations) {
					const targets = bindingIdentifiers(declaration.name).map((name) => localNode(filename, name));
					if (declaration.initializer) {
						const sources = referencedLocalNodes(filename, declaration.initializer);
						const imported = importedExpressionNode(declaration.initializer);
						if (imported) {
							sources.push(imported.sourceNode);
							imports.push({ path, sourceFilename: imported.sourceFilename, targetNode: targets[0] ?? imported.sourceNode });
						}
						for (const target of targets) {
							for (const from of sources) edges.push({ from, to: target });
						}
					}
					if (exported) {
						for (const name of bindingIdentifiers(declaration.name)) {
							addExport(name, [localNode(filename, name)]);
						}
					}
				}
			}

			if (ts.isExportDeclaration(statement)) {
				const exportedFrom = statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)
					? sourceFilename(statement.moduleSpecifier.text)
					: null;
				if (!statement.exportClause) {
					if (exportedFrom) {
						for (const name of allAuthorityNames) {
							addExport(name, [exportNode(exportedFrom, name)]);
						}
						edges.push({ from: moduleAuthorityNode(exportedFrom), to: moduleAuthorityNode(filename) });
						exports.push({ path, exportedName: "*", targetNode: moduleAuthorityNode(filename) });
						imports.push({ path, sourceFilename: exportedFrom, targetNode: moduleAuthorityNode(filename) });
					}
				} else if (ts.isNamespaceExport(statement.exportClause)) {
					if (exportedFrom) {
						const targetNode = exportNode(filename, statement.exportClause.name.text);
						addExport(statement.exportClause.name.text, [moduleAuthorityNode(exportedFrom)]);
						imports.push({ path, sourceFilename: exportedFrom, targetNode });
					}
				} else {
					for (const element of statement.exportClause.elements) {
						const exportedName = element.name.text;
						const from = exportedFrom
							? exportNode(exportedFrom, (element.propertyName ?? element.name).text)
							: localNode(filename, (element.propertyName ?? element.name).text);
						addExport(exportedName, [from]);
						if (exportedFrom) {
							imports.push({ path, sourceFilename: exportedFrom, targetNode: exportNode(filename, exportedName) });
						}
					}
				}
			}

			if (ts.isExportAssignment(statement)) {
				addExport("default", referencedLocalNodes(filename, statement.expression));
			}

			if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) &&
				statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
				const assignment = statement.expression;
				const sources = referencedLocalNodes(filename, assignment.right);
				const imported = importedExpressionNode(assignment.right);
				if (imported) sources.push(imported.sourceNode);
				if (ts.isIdentifier(assignment.left)) {
					const targetNode = localNode(filename, assignment.left.text);
					for (const from of sources) edges.push({ from, to: targetNode });
				}
				const commonJsName = commonJsExportName(assignment.left);
				if (commonJsName) addExport(commonJsName, sources);
			}
		}

		const visitDynamicImports = (node: ts.Node): void => {
			if (ts.isCallExpression(node) && (
				node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				ts.isIdentifier(node.expression) && node.expression.text === "require"
			)) {
				const argument = node.arguments.length === 1 ? node.arguments[0] : undefined;
				if (argument && ts.isStringLiteralLike(argument)) {
					const importedFrom = sourceFilename(argument.text);
					if (importedFrom) {
						dynamicImports.push({
							path,
							sourceFilename: importedFrom,
							targetNode: moduleAuthorityNode(importedFrom),
						});
					}
				}
			}
			ts.forEachChild(node, visitDynamicImports);
		};
		visitDynamicImports(sourceFile);
	}

	let changed = true;
	while (changed) {
		changed = false;
		for (const edge of edges) {
			const fromKinds = taints.get(edge.from);
			if (!fromKinds) continue;
			const targetKinds = taints.get(edge.to) ?? new Set<MutationAuthorityKind>();
			for (const kind of fromKinds) {
				if (!targetKinds.has(kind)) {
					targetKinds.add(kind);
					changed = true;
				}
			}
			taints.set(edge.to, targetKinds);
		}
	}

	const violations: string[] = [];
	for (const exported of exports) {
		if (exported.path === repositoryModule || exported.path === governanceModule) continue;
		for (const kind of taints.get(exported.targetNode) ?? []) {
			violations.push(`${exported.path}: exports ${kind} mutation authority as ${exported.exportedName}`);
		}
	}
	for (const imported of imports) {
		if (imported.sourceFilename === repositoryFilename || imported.sourceFilename === governanceFilename) continue;
		for (const kind of taints.get(imported.targetNode) ?? []) {
			violations.push(`${imported.path}: imports ${kind} mutation authority from an intermediate module`);
		}
	}
	for (const imported of dynamicImports) {
		if (imported.sourceFilename === repositoryFilename || imported.sourceFilename === governanceFilename) continue;
		for (const kind of taints.get(imported.targetNode) ?? []) {
			violations.push(`${imported.path}: dynamically imports ${kind} mutation authority from an intermediate module`);
		}
	}
	return [...new Set(violations)];
}

function resolveSourceModule(
	filename: string,
	specifier: string,
	knownFiles: ReadonlySet<string>,
	repositoryFilename: string,
	governanceFilename: string,
): string | null {
	if (specifier === "@bickr/shared/repository") return repositoryFilename;
	if (specifier === "@bickr/shared/governance") return governanceFilename;
	if (!specifier.startsWith(".")) return null;
	const candidate = resolve(dirname(filename), specifier);
	for (const resolvedCandidate of [
		candidate,
		...[...sourceModuleExtensions].map((extension) => `${candidate}${extension}`),
		...[...sourceModuleExtensions].map((extension) => resolve(candidate, `index${extension}`)),
	]) {
		if (knownFiles.has(resolvedCandidate)) return resolvedCandidate;
	}
	return null;
}

function referencedLocalNodes(filename: string, expression: ts.Expression): string[] {
	const names = new Set<string>();
	const visit = (node: ts.Node): void => {
		if (node !== expression && ts.isFunctionLike(node)) return;
		if (ts.isPropertyAccessExpression(node)) {
			visit(node.expression);
			return;
		}
		if (ts.isElementAccessExpression(node)) {
			visit(node.expression);
			if (node.argumentExpression) visit(node.argumentExpression);
			return;
		}
		if (ts.isPropertyAssignment(node)) {
			visit(node.initializer);
			return;
		}
		if (ts.isShorthandPropertyAssignment(node)) {
			names.add(node.name.text);
			return;
		}
		if (ts.isIdentifier(node)) names.add(node.text);
		ts.forEachChild(node, visit);
	};
	visit(expression);
	return [...names].map((name) => localNode(filename, name));
}

function bindingIdentifiers(name: ts.BindingName): string[] {
	if (ts.isIdentifier(name)) return [name.text];
	return name.elements.flatMap((element) => ts.isOmittedExpression(element)
		? []
		: bindingIdentifiers(element.name));
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
	return ts.canHaveModifiers(node) && Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === kind));
}

function commonJsExportName(expression: ts.Expression): string | null {
	if (ts.isPropertyAccessExpression(expression)) {
		if (ts.isIdentifier(expression.expression) && expression.expression.text === "module" && expression.name.text === "exports") {
			return "default";
		}
		if (ts.isIdentifier(expression.expression) && expression.expression.text === "exports") {
			return expression.name.text;
		}
		if (ts.isPropertyAccessExpression(expression.expression) &&
			ts.isIdentifier(expression.expression.expression) &&
			expression.expression.expression.text === "module" &&
			expression.expression.name.text === "exports") {
			return expression.name.text;
		}
	}
	if (ts.isElementAccessExpression(expression) && expression.argumentExpression &&
		ts.isStringLiteralLike(expression.argumentExpression)) {
		if (ts.isIdentifier(expression.expression) && expression.expression.text === "exports") {
			return expression.argumentExpression.text;
		}
		if (ts.isPropertyAccessExpression(expression.expression) &&
			ts.isIdentifier(expression.expression.expression) &&
			expression.expression.expression.text === "module" &&
			expression.expression.name.text === "exports") {
			return expression.argumentExpression.text;
		}
	}
	return null;
}

function localNode(filename: string, name: string): string {
	return `${resolve(filename)}#local:${name}`;
}

function exportNode(filename: string, name: string): string {
	return `${resolve(filename)}#export:${name}`;
}

function moduleAuthorityNode(filename: string): string {
	return `${resolve(filename)}#module-authority`;
}

const sourceModuleExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

function sourceModuleFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist" || entry.name === ".wrangler") {
			continue;
		}
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...sourceModuleFiles(path));
		} else if (
			entry.isFile() &&
			sourceModuleExtensions.has(extensionOf(path)) &&
			!path.endsWith(".d.ts") &&
			!path.endsWith(".d.mts") &&
			!path.endsWith(".d.cts")
		) {
			files.push(path);
		}
	}
	return files;
}

function extensionOf(filename: string): string {
	const match = /\.[^.\/]+$/u.exec(filename);
	return match?.[0] ?? "";
}

function scriptKind(filename: string): ts.ScriptKind {
	switch (extensionOf(filename)) {
		case ".js":
		case ".cjs":
		case ".mjs": return ts.ScriptKind.JS;
		case ".jsx": return ts.ScriptKind.JSX;
		case ".tsx": return ts.ScriptKind.TSX;
		case ".json": return ts.ScriptKind.JSON;
		default: return ts.ScriptKind.TS;
	}
}
