import { afterEach, describe, expect, it, vi } from "vitest";
import {
	loadPublicBotEffectiveModel,
	publicBotEffectiveModelLabel,
	publicBotEffectiveModelPath,
} from "./public-bot-model";

afterEach(() => {
	vi.unstubAllGlobals();
});

function stubFetch(responder: (path: string) => Response): string[] {
	const requested: string[] = [];
	vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
		const path = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		requested.push(path);
		return Promise.resolve(responder(path));
	});
	return requested;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("public participant model", () => {
	it("addresses the participant by its public world and handle", () => {
		expect(publicBotEffectiveModelPath("patch notes", "scout/x"))
			.toBe("/api/worlds/patch%20notes/bots/scout%2Fx/effective-model");
	});

	// The whole point of the public boundary: a profile must never reach an
	// owner-scoped inference endpoint, whoever happens to be reading it.
	it("asks the public boundary once and never an owner configuration route", async () => {
		const requested = stubFetch(() => jsonResponse({
			ok: true,
			data: { model: { botId: "bot_scout", effectiveModel: "anthropic/claude-opus-4" } },
		}));

		await expect(loadPublicBotEffectiveModel("patch-notes", "scout", "bot_scout")).resolves.toEqual({
			status: "resolved",
			effectiveModel: "anthropic/claude-opus-4",
		});
		expect(requested).toEqual(["/api/worlds/patch-notes/bots/scout/effective-model"]);
		expect(requested.some((path) => path.includes("/api/me/"))).toBe(false);
	});

	it("reports an explicit unresolved state when the server cannot answer", async () => {
		stubFetch(() => jsonResponse({ ok: false, error: "server_error", message: "Unexpected API error." }, 500));
		await expect(loadPublicBotEffectiveModel("patch-notes", "scout", "bot_scout")).resolves.toEqual({ status: "unresolved" });
	});

	it("reports an explicit unresolved state for an unknown participant", async () => {
		stubFetch(() => jsonResponse({ ok: false, error: "not_found", message: "Bot not found." }, 404));
		await expect(loadPublicBotEffectiveModel("patch-notes", "ghost", "bot_ghost")).resolves.toEqual({ status: "unresolved" });
	});

	// The handles address the participant, the answer identifies it. A released
	// and reclaimed handle makes those disagree, and then the model belongs to
	// someone else.
	it("reports an explicit unresolved state when the answer is about another participant", async () => {
		stubFetch(() => jsonResponse({
			ok: true,
			data: { model: { botId: "bot_successor", effectiveModel: "anthropic/claude-opus-4" } },
		}));
		await expect(loadPublicBotEffectiveModel("patch-notes", "scout", "bot_scout"))
			.resolves.toEqual({ status: "unresolved" });
	});

	it("reports an explicit unresolved state when the request itself fails", async () => {
		vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
		await expect(loadPublicBotEffectiveModel("patch-notes", "scout", "bot_scout")).resolves.toEqual({ status: "unresolved" });
	});

	it("reports an explicit unresolved state for an answer without a model", async () => {
		stubFetch(() => jsonResponse({ ok: true, data: { model: { botId: "bot_scout", effectiveModel: "  " } } }));
		await expect(loadPublicBotEffectiveModel("patch-notes", "scout", "bot_scout")).resolves.toEqual({ status: "unresolved" });
	});

	// Loading and failure are named states rather than a guess about who set the
	// model; the old "set by its owner" fallback claimed knowledge the browser
	// never had.
	it("labels every state without inventing a source for the model", () => {
		expect(publicBotEffectiveModelLabel({ status: "loading" })).toBe("...");
		expect(publicBotEffectiveModelLabel({ status: "resolved", effectiveModel: "openai/gpt-5" })).toBe("openai/gpt-5");
		expect(publicBotEffectiveModelLabel({ status: "unresolved" })).toBe("not resolved");
	});
});
