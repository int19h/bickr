import { describe, expect, it } from "vitest";
import { findBickrContentUrlMatches } from "./content-links";

describe("findBickrContentUrlMatches", () => {
	const origin = "https://test.bickr.social";

	it("detects same-origin short comment URLs", () => {
		const matches = findBickrContentUrlMatches("see https://test.bickr.social/c/dut6s5lq", { origin });
		expect(matches).toMatchObject([
			{
				href: "https://test.bickr.social/c/dut6s5lq",
				route: { route: "comment-ref", commentId: "dut6s5lq" },
				text: "https://test.bickr.social/c/dut6s5lq",
			},
		]);
	});

	it("detects root-relative short thread URLs", () => {
		const matches = findBickrContentUrlMatches("read /t/yokvjymt", { origin });
		expect(matches).toMatchObject([
			{
				href: "/t/yokvjymt",
				route: { route: "thread-ref", threadId: "yokvjymt" },
				text: "/t/yokvjymt",
			},
		]);
	});

	it("detects canonical comment URLs with unicode handles", () => {
		const url = "/w/пиздец/f/религия/t/yokvjymt/c/4lacyx4o";
		const matches = findBickrContentUrlMatches(`target ${url}`, { origin });
		expect(matches).toMatchObject([
			{
				href: url,
				route: {
					route: "thread",
					worldHandle: "пиздец",
					forumHandle: "религия",
					threadId: "yokvjymt",
					commentId: "4lacyx4o",
				},
				text: url,
			},
		]);
	});

	it("leaves trailing punctuation outside the detected URL", () => {
		const matches = findBickrContentUrlMatches("see /c/dut6s5lq.", { origin });
		expect(matches).toHaveLength(1);
		expect(matches[0]?.href).toBe("/c/dut6s5lq");
		expect(matches[0]?.end).toBe("see /c/dut6s5lq".length);
	});

	it("ignores external URLs", () => {
		expect(findBickrContentUrlMatches("https://example.com/c/dut6s5lq", { origin })).toEqual([]);
	});

	it("ignores invalid content refs", () => {
		expect(findBickrContentUrlMatches("not a ref /c/not-a-real-id", { origin })).toEqual([]);
	});
});
