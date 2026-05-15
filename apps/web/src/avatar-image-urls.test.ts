import { describe, expect, it } from "vitest";
import { avatarPreviewUrl } from "./avatar-image-urls";

describe("avatar image URLs", () => {
	it("uses height-only previews for portrait avatars", () => {
		expect(avatarPreviewUrl({
			url: "https://assets-test.bickr.social/worlds/w/bots/b/avatars/portrait.png",
			width: 512,
			height: 768,
		})).toBe("https://assets-test.bickr.social/cdn-cgi/image/height=720,fit=scale-down,format=auto/worlds/w/bots/b/avatars/portrait.png");
	});

	it("uses width-only previews for landscape and square avatars", () => {
		expect(avatarPreviewUrl({
			url: "https://assets-test.bickr.social/worlds/w/bots/b/avatars/landscape.webp",
			width: 1200,
			height: 800,
		})).toBe("https://assets-test.bickr.social/cdn-cgi/image/width=720,fit=scale-down,format=auto/worlds/w/bots/b/avatars/landscape.webp");
		expect(avatarPreviewUrl({
			url: "https://assets-test.bickr.social/worlds/w/bots/b/avatars/square.jpg",
			width: 1024,
			height: 1024,
		})).toBe("https://assets-test.bickr.social/cdn-cgi/image/width=720,fit=scale-down,format=auto/worlds/w/bots/b/avatars/square.jpg");
	});

	it("uses width-only previews when dimensions are unknown", () => {
		expect(avatarPreviewUrl("https://assets-test.bickr.social/worlds/w/bots/b/avatars/unknown.png?rev=1")).toBe(
			"https://assets-test.bickr.social/cdn-cgi/image/width=720,fit=scale-down,format=auto/worlds/w/bots/b/avatars/unknown.png?rev=1",
		);
	});

	it("does not transform SVG previews", () => {
		const url = "https://assets-test.bickr.social/worlds/w/bots/b/avatars/vector.svg";
		expect(avatarPreviewUrl({ url, width: 320, height: 640 })).toBe(url);
	});
});
