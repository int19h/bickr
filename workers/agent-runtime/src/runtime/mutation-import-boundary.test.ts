import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryMutationNames = [
	"addBotGroupMembers",
	"createBot",
	"createBotGroup",
	"createWorld",
	"deleteBot",
	"deleteBotAvatar",
	"deleteBotGroup",
	"linkProviderIdentity",
	"materializePendingBotAvatar",
	"prepareProviderUserBootstrap",
	"providerIdentityUserId",
	"providerUserBootstrapActivationStatements",
	"refreshLinkedCloneIndexes",
	"refreshProviderIdentity",
	"removeBotGroupMember",
	"relinkBotClone",
	"softDeleteUserProfile",
	"spreadUserBotTicks",
	"unlinkBotClone",
	"unlinkProviderIdentity",
	"updateBot",
	"updateBotAvatar",
	"updateBotGroup",
	"updateUserAvatar",
	"updateUserProfile",
	"upsertProviderUser",
] as const;

const governanceMutationNames = ["deleteWorld", "updateWorld", "updateWorldAvatar"] as const;

const userCoordinatorModules = new Set([
	"workers/agent-runtime/src/routes.ts",
	"workers/agent-runtime/src/lifecycle/account.ts",
	"workers/agent-runtime/src/lifecycle/bot.ts",
]);
const worldCoordinatorModule = "workers/forum-coordinator/src/index.ts";

describe("serialized entity mutation import boundary", () => {
	it("allows coordinator mutation capabilities only at the narrow serialized writer modules", () => {
		const violations: string[] = [];
		for (const filename of typescriptFiles(resolve(process.cwd()))) {
			const path = relative(process.cwd(), filename).replaceAll("\\", "/");
			const source = readFileSync(filename, "utf8");
			if (namedImport(source, "userCoordinatorRepositoryMutations", /(?:@bickr\/shared\/repository|packages\/shared\/src\/repository)/u) && !userCoordinatorModules.has(path)) {
				violations.push(`${path}: imports the user-coordinator mutation capability`);
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
