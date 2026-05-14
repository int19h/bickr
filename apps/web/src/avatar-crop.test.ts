import { describe, expect, it } from "vitest";
import {
	avatarCropImageStyle,
	centeredAvatarCrop,
	clampAvatarCrop,
	moveAvatarCrop,
	resizeAvatarCrop,
} from "./avatar-crop";

describe("avatar crop helpers", () => {
	it("creates a centered square crop for non-square images", () => {
		expect(centeredAvatarCrop(240, 320)).toEqual({
			x: 0,
			y: 40,
			size: 240,
			imageWidth: 240,
			imageHeight: 320,
		});
	});

	it("clamps crop movement to image bounds", () => {
		expect(moveAvatarCrop({ x: 20, y: 30, size: 80, imageWidth: 180, imageHeight: 140 }, 200, -100)).toEqual({
			x: 100,
			y: 0,
			size: 80,
			imageWidth: 180,
			imageHeight: 140,
		});
	});

	it("resizes from corners while preserving the square aspect ratio", () => {
		expect(resizeAvatarCrop({ x: 40, y: 30, size: 80, imageWidth: 180, imageHeight: 160 }, "se", 30, 10)).toMatchObject({
			x: 40,
			y: 30,
			size: 100,
		});
		expect(resizeAvatarCrop({ x: 40, y: 30, size: 80, imageWidth: 180, imageHeight: 160 }, "nw", 30, 10)).toMatchObject({
			x: 60,
			y: 50,
			size: 60,
		});
	});

	it("maps the selected square onto the rendered avatar square", () => {
		expect(avatarCropImageStyle({ x: 40, y: 80, size: 160, imageWidth: 320, imageHeight: 480 })).toEqual({
			width: "200%",
			height: "300%",
			left: "-25%",
			top: "-50%",
		});
	});

	it("enforces a small minimum crop size", () => {
		expect(clampAvatarCrop({ x: 0, y: 0, size: 1, imageWidth: 200, imageHeight: 200 }).size).toBe(32);
		expect(clampAvatarCrop({ x: 0, y: 0, size: 1, imageWidth: 12, imageHeight: 10 }).size).toBe(10);
	});
});
