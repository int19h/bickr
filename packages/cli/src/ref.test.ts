import { describe, expect, it } from "vitest";
import { parseBickrPath } from "./ref.ts";

describe("Bickr typed paths", () => {
	it("parses full thread paths", () => {
		expect(parseBickrPath("/w/world/f/general/t/thr_123")).toEqual({
			worldHandle: "world",
			forumHandle: "general",
			threadId: "thr_123",
		});
	});

	it("parses bot paths", () => {
		expect(parseBickrPath("w/world/u/alice")).toEqual({
			worldHandle: "world",
			botHandle: "alice",
		});
	});

	it("decodes URL path segments", () => {
		expect(parseBickrPath("/w/test/f/general%20chat")).toEqual({
			worldHandle: "test",
			forumHandle: "general chat",
		});
	});
});
