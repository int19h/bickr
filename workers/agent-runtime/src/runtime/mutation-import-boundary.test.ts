import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
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

// These historical side-door names remain protected even though the current
// repository intentionally has no capability member with that name.
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

describe("serialized entity mutation import boundary", () => {
	it("allows coordinator mutation capabilities only at the narrow serialized writer modules", () => {
		const repositorySource = readFileSync(resolve(process.cwd(), "packages/shared/src/repository.ts"), "utf8");
		const governanceSource = readFileSync(resolve(process.cwd(), "packages/shared/src/governance.ts"), "utf8");
		for (const capability of repositoryCapabilities) {
			expect(capabilityMembers(repositorySource, capability).sort()).toEqual(
				[...expectedRepositoryCapabilityMembers[capability]].sort(),
			);
		}
		const governanceCapabilityMembers = capabilityMembers(governanceSource, "coordinatorGovernanceMutations");
		expect(governanceCapabilityMembers.sort()).toEqual([...expectedGovernanceMutationNames].sort());
		const repositoryMutationNames = new Set([
			...repositoryCapabilities.flatMap((capability) => expectedRepositoryCapabilityMembers[capability]),
			...retiredRepositoryMutationNames,
		]);
		const governanceMutationNames = new Set(expectedGovernanceMutationNames);
		const violations: string[] = [];
		for (const filename of typescriptFiles(resolve(process.cwd()))) {
			const path = relative(process.cwd(), filename).replaceAll("\\", "/");
			const source = readFileSync(filename, "utf8");
			if (namedImport(source, "userCoordinatorRepositoryMutations", /(?:@bickr\/shared\/repository|packages\/shared\/src\/repository)/u) && !userCoordinatorModules.has(path)) {
				violations.push(`${path}: imports the user-coordinator mutation capability`);
			}
			if (namedImport(source, "accountBootstrapReservationRepositoryMutations", /(?:@bickr\/shared\/repository|packages\/shared\/src\/repository)/u) && path !== accountBootstrapReservationModule) {
				violations.push(`${path}: imports the pre-dispatch account-bootstrap reservation capability`);
			}
			if (namedImport(source, "worldCoordinatorRepositoryMutations", /(?:@bickr\/shared\/repository|packages\/shared\/src\/repository)/u) && path !== worldCoordinatorModule) {
				violations.push(`${path}: imports the world-coordinator repository mutation capability`);
			}
			if (namedImport(source, "coordinatorGovernanceMutations", /(?:@bickr\/shared\/governance|packages\/shared\/src\/governance)/u) && path !== worldCoordinatorModule) {
				violations.push(`${path}: imports the world-coordinator governance mutation capability`);
			}
			if (namedImport(source, "coordinatorRepositoryMutations", /(?:@bickr\/shared\/repository|packages\/shared\/src\/repository)/u)) {
				violations.push(`${path}: imports the retired monolithic coordinator capability`);
			}
			if (namespaceImport(source, /(?:@bickr\/shared\/repository|packages\/shared\/src\/repository)/u)) {
				violations.push(`${path}: namespace-imports the repository and can bypass mutation capabilities`);
			}
			if (namespaceImport(source, /(?:@bickr\/shared\/governance|packages\/shared\/src\/governance)/u)) {
				violations.push(`${path}: namespace-imports governance and can bypass mutation capabilities`);
			}
			for (const name of repositoryMutationNames) {
				if (path === "packages/shared/src/repository.ts" && exportedFunction(source, name)) {
					violations.push(`${path}: unrestricted repository mutation export ${name}`);
				}
				if (namedImport(source, name, /(?:@bickr\/shared\/repository|packages\/shared\/src\/repository)/u)) {
					violations.push(`${path}: directly imports repository mutation ${name}`);
				}
			}
			for (const name of governanceMutationNames) {
				if (path === "packages/shared/src/governance.ts" && exportedFunction(source, name)) {
					violations.push(`${path}: unrestricted governance mutation export ${name}`);
				}
				if (namedImport(source, name, /(?:@bickr\/shared\/governance|packages\/shared\/src\/governance)/u)) {
					violations.push(`${path}: directly imports governance mutation ${name}`);
				}
			}
		}
		expect(violations).toEqual([]);
	});
});

function exportedFunction(source: string, name: string): boolean {
	return new RegExp(`\\bexport\\s+(?:async\\s+)?function\\s+${name}\\b`, "u").test(source);
}

function namedImport(source: string, name: string, modulePattern: RegExp): boolean {
	const imports = source.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*["']([^"']+)["']/gu);
	for (const match of imports) {
		if (!modulePattern.test(match[2] ?? "")) {
			continue;
		}
		const imported = (match[1] ?? "").split(",").map((entry) => entry.trim().split(/\s+as\s+/u)[0]);
		if (imported.includes(name)) {
			return true;
		}
	}
	return false;
}

function namespaceImport(source: string, modulePattern: RegExp): boolean {
	for (const match of source.matchAll(/import\s+\*\s+as\s+\w+\s+from\s+["']([^"']+)["']/gu)) {
		if (modulePattern.test(match[1] ?? "")) return true;
	}
	return false;
}

function capabilityMembers(source: string, name: string): string[] {
	const match = new RegExp(`export\\s+const\\s+${name}\\s*=\\s*Object\\.freeze\\(\\{([\\s\\S]*?)\\n\\}\\);`, "u").exec(source);
	expect(match, `Missing mutation capability ${name}`).not.toBeNull();
	return (match?.[1] ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
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
