import { describe, expect, it } from "vitest";
import { parsePathname, routePath } from "./routes";

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
});
