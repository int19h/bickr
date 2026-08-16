import type { BotSummary } from "@bickr/shared/model";
import {
	addBotGroupMembersRoute,
	authCookie,
	authCookieFor,
	bulkBotsRoute,
	contextFor,
	createBotForTest,
	createBotGroupRoute,
	createBotInWorld,
	createWorldForTest,
	describe,
	expect,
	it,
	jsonRequest,
	resolveBotsRoute,
	seedWorld,
	testLanguage,
} from "./helpers/index-harness";

/**
 * One grammar names a set of participants for every CLI command that acts on
 * many of them, and the server is the only place that knows what a reference
 * expands to. These cover the grammar itself and the resolve-only route the CLI
 * reads concrete participants from.
 */

async function resolveResponse(cookie: string, body: Record<string, unknown>): Promise<Response> {
	return resolveBotsRoute(
		contextFor<typeof resolveBotsRoute>(jsonRequest("http://example.com/api/cli/resolve/bots", "POST", body, cookie)),
	);
}

async function resolvedHandles(cookie: string, body: Record<string, unknown>): Promise<string[]> {
	const response = await resolveResponse(cookie, body);
	expect(response.status, await response.clone().text()).toBe(200);
	const payload = (await response.json()) as { data: { bots: BotSummary[] } };
	return payload.data.bots.map((bot) => `w/${bot.homeWorldHandle}/u/${bot.handle}`);
}

async function createGroup(cookie: string, worldHandle: string, customTitle: string | null): Promise<string> {
	const response = await createBotGroupRoute(
		contextFor<typeof createBotGroupRoute>(
			jsonRequest(
				`http://example.com/api/worlds/${worldHandle}/groups`,
				"POST",
				{ language: testLanguage, customTitle },
				cookie,
			),
			{ worldHandle },
		),
	);
	expect(response.status, await response.clone().text()).toBe(201);
	const payload = (await response.json()) as { data: { group: { id: string } } };
	return payload.data.group.id;
}

async function addGroupMembers(cookie: string, worldHandle: string, groupId: string, botIds: string[]): Promise<void> {
	const response = await addBotGroupMembersRoute(
		contextFor<typeof addBotGroupMembersRoute>(
			jsonRequest(
				`http://example.com/api/worlds/${worldHandle}/groups/${groupId}/bots`,
				"POST",
				{ botIds },
				cookie,
			),
			{ worldHandle, groupId },
		),
	);
	expect(response.status, await response.clone().text()).toBe(200);
}

describe("CLI bot target grammar", () => {
	it("expands a group by its id and by its exact title, case-insensitively", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const alpha = await createBotForTest(cookie, "target-alpha");
		const beta = await createBotForTest(cookie, "target-beta");
		await createBotForTest(cookie, "target-gamma");
		const groupId = await createGroup(cookie, "patch-notes", "Night Crew");
		await addGroupMembers(cookie, "patch-notes", groupId, [alpha.id, beta.id]);

		expect(await resolvedHandles(cookie, { targets: [`w/patch-notes/g/${groupId}`] }))
			.toEqual(["w/patch-notes/u/target-alpha", "w/patch-notes/u/target-beta"]);
		expect(await resolvedHandles(cookie, { targets: ["w/patch-notes/g/night crew"] }))
			.toEqual(["w/patch-notes/u/target-alpha", "w/patch-notes/u/target-beta"]);
	});

	it("does not match the title a group derives from its members", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const alpha = await createBotForTest(cookie, "derived-alpha");
		const groupId = await createGroup(cookie, "patch-notes", null);
		await addGroupMembers(cookie, "patch-notes", groupId, [alpha.id]);

		const response = await resolveResponse(cookie, { targets: ["w/patch-notes/g/u/derived-alpha"] });
		expect(response.status).toBe(404);
	});

	it("reports a title two groups share as ambiguous, naming both ids", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const first = await createGroup(cookie, "patch-notes", "Duplicates");
		const second = await createGroup(cookie, "patch-notes", "duplicates");

		const response = await resolveResponse(cookie, { targets: ["w/patch-notes/g/Duplicates"] });
		expect(response.status).toBe(409);
		const payload = (await response.json()) as { error: string; details: { references: string[] } };
		expect(payload.error).toBe("conflict");
		expect(payload.details.references).toEqual([
			`/w/patch-notes/g/${first}`,
			`/w/patch-notes/g/${second}`,
		]);
	});

	it("keeps another owner's groups out of the grammar", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const otherCookie = await authCookieFor({ subject: "9001", login: "group-outsider", displayName: "Group Outsider" });
		await createWorldForTest(otherCookie, "outsider-world", "Outsider World");
		const otherBot = await createBotInWorld(otherCookie, "outsider-world", { handle: "outsider-bot" });
		const otherGroup = await createGroup(otherCookie, "outsider-world", "Theirs");
		await addGroupMembers(otherCookie, "outsider-world", otherGroup, [otherBot.id]);

		expect((await resolveResponse(cookie, { targets: [`w/outsider-world/g/${otherGroup}`] })).status).toBe(404);
		expect((await resolveResponse(cookie, { targets: ["w/outsider-world/g/Theirs"] })).status).toBe(404);
		// The world itself resolves; it simply holds none of this owner's bots.
		expect(await resolvedHandles(cookie, { targets: ["w/outsider-world"] })).toEqual([]);
	});

	it("reports a group reference that matches nothing as not found", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		expect((await resolveResponse(cookie, { targets: ["w/patch-notes/g/grp_missing"] })).status).toBe(404);
	});

	it("unions and dedupes the reference forms, sorted by world and handle", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		const alpha = await createBotForTest(cookie, "union-alpha");
		await createBotForTest(cookie, "union-beta");
		const groupId = await createGroup(cookie, "patch-notes", "Union");
		await addGroupMembers(cookie, "patch-notes", groupId, [alpha.id]);

		expect(await resolvedHandles(cookie, {
			targets: [`w/patch-notes/g/${groupId}`, "u/union-beta", alpha.id, "w/patch-notes/u/union-alpha"],
		})).toEqual(["w/patch-notes/u/union-alpha", "w/patch-notes/u/union-beta"]);
	});

	it("selects the whole fleet with all, and narrows it by world", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		await createWorldForTest(cookie, "side-world", "Side World");
		await createBotForTest(cookie, "fleet-home");
		await createBotInWorld(cookie, "side-world", { handle: "fleet-side" });

		expect(await resolvedHandles(cookie, { all: true }))
			.toEqual(["w/patch-notes/u/fleet-home", "w/side-world/u/fleet-side"]);
		expect(await resolvedHandles(cookie, { all: true, targets: ["w/side-world"] }))
			.toEqual(["w/side-world/u/fleet-side"]);
	});

	it("refuses to narrow the whole fleet by anything but a world", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		await createBotForTest(cookie, "narrow-alpha");
		expect((await resolveResponse(cookie, { all: true, targets: ["u/narrow-alpha"] })).status).toBe(400);
	});

	it("requires a selection and bounds how many references one request may carry", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		expect((await resolveResponse(cookie, { targets: [] })).status).toBe(400);
		expect((await resolveResponse(cookie, {
			targets: Array.from({ length: 501 }, (_, index) => `u/handle-${index}`),
		})).status).toBe(400);
	});

	it("rejects a reference that is not part of the grammar", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		expect((await resolveResponse(cookie, { targets: ["nonsense"] })).status).toBe(400);
	});

	it("gives bulk updates the same grammar, including groups and the whole fleet", async () => {
		const cookie = await authCookie();
		await seedWorld(cookie);
		await createWorldForTest(cookie, "bulk-world", "Bulk World");
		const alpha = await createBotForTest(cookie, "bulk-alpha");
		await createBotInWorld(cookie, "bulk-world", { handle: "bulk-side" });
		const groupId = await createGroup(cookie, "patch-notes", "Bulk Crew");
		await addGroupMembers(cookie, "patch-notes", groupId, [alpha.id]);

		const grouped = await bulkBotsRoute(
			contextFor<typeof bulkBotsRoute>(jsonRequest("http://example.com/api/cli/bulk/bots", "POST", {
				targets: ["w/patch-notes/g/Bulk Crew"],
				update: { inferenceSettings: { model: "openai/gpt-4o-mini" } },
			}, cookie)),
		);
		expect(grouped.status, await grouped.clone().text()).toBe(200);
		const groupedPayload = (await grouped.json()) as { data: { bulk: { dryRun: boolean; bots: { ref: string }[] } } };
		expect(groupedPayload.data.bulk.dryRun).toBe(true);
		expect(groupedPayload.data.bulk.bots.map((bot) => bot.ref)).toEqual(["/w/patch-notes/u/bulk-alpha"]);

		const fleet = await bulkBotsRoute(
			contextFor<typeof bulkBotsRoute>(jsonRequest("http://example.com/api/cli/bulk/bots", "POST", {
				all: true,
				targets: [],
				update: { inferenceSettings: { model: "openai/gpt-4o-mini" } },
			}, cookie)),
		);
		expect(fleet.status, await fleet.clone().text()).toBe(200);
		const fleetPayload = (await fleet.json()) as { data: { bulk: { bots: { ref: string }[] } } };
		expect(fleetPayload.data.bulk.bots.map((bot) => bot.ref)).toEqual([
			"/w/bulk-world/u/bulk-side",
			"/w/patch-notes/u/bulk-alpha",
		]);
	});

	it("refuses to resolve targets for a caller with no session", async () => {
		const response = await resolveResponse("", { targets: ["u/anything"] });
		expect(response.status).toBe(401);
	});
});
