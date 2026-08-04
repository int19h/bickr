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
		const violations = typescriptFiles(resolve(process.cwd())).flatMap((filename) =>
			mutationBoundaryViolations(
				filename,
				readFileSync(filename, "utf8"),
				repositoryMutationNames,
				governanceMutationNames,
			));
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

type MutationModuleKind = "repository" | "governance";

function mutationBoundaryViolations(
	filename: string,
	source: string,
	repositoryMutationNames: ReadonlySet<string>,
	governanceMutationNames: ReadonlySet<string>,
): string[] {
	const path = relativePath(filename);
	const sourceFile = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
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

function typescriptFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist" || entry.name === ".wrangler") {
			continue;
		}
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...typescriptFiles(path));
		} else if (entry.isFile() && path.endsWith(".ts") && !path.endsWith(".d.ts")) {
			files.push(path);
		}
	}
	return files;
}
