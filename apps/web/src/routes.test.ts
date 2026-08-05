import { describe, expect, it } from "vitest";
import { inferenceReturnTargetFromPath, normalizeLoggedOutRoute, parsePathname, routePath } from "./routes";

describe("routes", () => {
	it("parses short comment routes without falling back to worlds", () => {
		const route = parsePathname("/c/dut6s5lq");
		expect(route).toEqual({ route: "comment-ref", commentId: "dut6s5lq" });
		expect(route.route).not.toBe("worlds");
		expect(routePath(route)).toBe("/c/dut6s5lq");
	});

	it("parses short thread routes without falling back to worlds", () => {
		const route = parsePathname("/t/yokvjymt");
		expect(route).toEqual({ route: "thread-ref", threadId: "yokvjymt" });
		expect(route.route).not.toBe("worlds");
		expect(routePath(route)).toBe("/t/yokvjymt");
	});

	it("parses the subscriptions route", () => {
		const route = parsePathname("/me/subscriptions");
		expect(route).toEqual({ route: "subscriptions" });
		expect(routePath(route)).toBe("/me/subscriptions");
	});

	it("parses the inference cost statistics route", () => {
		const route = parsePathname("/statistics/inference-costs");
		expect(route).toEqual({ route: "statistics-inference-costs" });
		expect(routePath(route)).toBe("/statistics/inference-costs");
	});

	it("parses the world groups tab", () => {
		const route = parsePathname("/w/patch-notes", "?tab=groups");
		expect(route).toEqual({ route: "world", worldHandle: "patch-notes", worldTab: "groups" });
		expect(routePath(route)).toBe("/w/patch-notes?tab=groups");
	});

	it("parses world edit and avatar routes", () => {
		const editRoute = parsePathname("/w/patch-notes/edit");
		expect(editRoute).toEqual({ route: "world-edit", worldHandle: "patch-notes" });
		expect(routePath(editRoute)).toBe("/w/patch-notes/edit");

		const avatarRoute = parsePathname("/w/patch-notes/avatar");
		expect(avatarRoute).toEqual({ route: "world-avatar", worldHandle: "patch-notes" });
		expect(routePath(avatarRoute)).toBe("/w/patch-notes/avatar");
	});

	it("parses the inference library and configuration routes", () => {
		const library = parsePathname("/me/inference");
		expect(library).toEqual({ route: "inference-library" });
		expect(routePath(library)).toBe("/me/inference");

		const editor = parsePathname("/me/inference/cfg_abc");
		expect(editor).toEqual({ route: "inference-configuration", configurationId: "cfg_abc" });
		expect(routePath(editor)).toBe("/me/inference/cfg_abc");
	});

	it("round-trips a safe return target and drops an unsafe one", () => {
		const withReturn = parsePathname("/me/inference/cfg_abc", "?from=%2Fw%2Fpatch-notes%2Fedit");
		expect(withReturn.returnTo).toEqual({ route: "world-edit", worldHandle: "patch-notes" });
		expect(routePath(withReturn)).toBe("/me/inference/cfg_abc?from=%2Fw%2Fpatch-notes%2Fedit");

		for (const unsafe of [
			"https://evil.example/steal",
			"//evil.example/steal",
			"/w/patch-notes",
			"/me/bots",
			"javascript:alert(1)",
			"",
		]) {
			expect(inferenceReturnTargetFromPath(unsafe)).toBeNull();
		}
		expect(parsePathname("/me/inference", "?from=https%3A%2F%2Fevil.example").returnTo).toBeUndefined();
	});

	it("accepts every owner screen that links into the library", () => {
		for (const path of [
			"/me/profile",
			"/me/profile/avatar",
			"/w/patch-notes/edit",
			"/w/patch-notes/avatar",
			"/w/patch-notes/u/release-sage/edit",
			"/w/patch-notes/u/release-sage/avatar",
		]) {
			const target = inferenceReturnTargetFromPath(path);
			expect(target).not.toBeNull();
			expect(routePath(target!)).toBe(path);
		}
	});

	it("normalizes logged-out account routes to the public worlds route", () => {
		for (const pathname of ["/me/bots", "/me/notifications", "/me/subscriptions", "/statistics/inference-costs", "/me/profile", "/me/profile/avatar", "/hu/alice", "/me/inference", "/me/inference/cfg_abc"]) {
			const normalized = normalizeLoggedOutRoute(parsePathname(pathname));
			expect(normalized.route).toEqual({ route: "worlds" });
			expect(routePath(normalized.route)).toBe("/");
			expect(normalized.status).toMatch(/Sign in/);
		}
	});

	it("normalizes logged-out owner-only routes to nearest public pages", () => {
		expect(normalizeLoggedOutRoute(parsePathname("/w/patch-notes/edit")).route).toEqual({
			route: "world",
			worldHandle: "patch-notes",
			worldTab: "forums",
		});
		expect(routePath(normalizeLoggedOutRoute(parsePathname("/w/patch-notes/avatar")).route)).toBe("/w/patch-notes");
		expect(routePath(normalizeLoggedOutRoute(parsePathname("/w/patch-notes/u/release-sage/edit")).route)).toBe("/w/patch-notes/u/release-sage");
		expect(routePath(normalizeLoggedOutRoute(parsePathname("/w/patch-notes/u/release-sage/avatar")).route)).toBe("/w/patch-notes/u/release-sage");
		expect(routePath(normalizeLoggedOutRoute(parsePathname("/w/patch-notes/u/release-sage/loop")).route)).toBe("/w/patch-notes/u/release-sage");
	});

	it("normalizes logged-out account-only tabs and semantic search", () => {
		expect(routePath(normalizeLoggedOutRoute(parsePathname("/w/patch-notes", "?tab=groups")).route)).toBe("/w/patch-notes");
		expect(routePath(normalizeLoggedOutRoute(parsePathname("/w/patch-notes", "?tab=notifications")).route)).toBe("/w/patch-notes");
		expect(routePath(normalizeLoggedOutRoute(parsePathname("/w/patch-notes/u/release-sage", "?tab=notifications")).route)).toBe("/w/patch-notes/u/release-sage");
		expect(routePath(normalizeLoggedOutRoute(parsePathname("/search", "?q=release&mode=semantic&types=bot&page=3")).route)).toBe("/search?q=release&types=bot");
	});

	it("defaults search routes to FTS and keeps substring explicit", () => {
		const defaultRoute = parsePathname("/search", "?q=release");
		expect(defaultRoute.search?.mode).toBe("fts");
		expect(routePath(defaultRoute)).toBe("/search?q=release");

		const substringRoute = parsePathname("/search", "?q=release&mode=substring");
		expect(substringRoute.search?.mode).toBe("substring");
		expect(routePath(substringRoute)).toBe("/search?q=release&mode=substring");
	});
});
