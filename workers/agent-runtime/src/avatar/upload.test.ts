import { describe, expect, it } from "vitest";
import { avatarUploadBytes, avatarUploadMaxBytes } from "./upload";

const file = () => new File([new Uint8Array([0xff, 0xd8, 0xff])], "avatar.jpg", { type: "image/jpeg" });
const request = (form: FormData) => new Request("https://example.com/upload", { method: "POST", body: form });

describe("avatar multipart upload", () => {
	it("rejects a large ignored field before parsing form data", async () => {
		const form = new FormData();
		form.set("file", file());
		form.set("ignored", "x".repeat(avatarUploadMaxBytes));
		await expect(avatarUploadBytes(request(form))).rejects.toThrow("Avatar upload is too large");
	});

	it("rejects duplicate files and unexpected fields", async () => {
		for (const extra of ["file", "ignored"]) {
			const form = new FormData();
			form.append("file", file());
			form.append(extra, file());
			await expect(avatarUploadBytes(request(form))).rejects.toThrow("exactly one file field");
		}
	});

	it("accepts a single valid image", async () => {
		const form = new FormData();
		form.set("file", file());
		await expect(avatarUploadBytes(request(form))).resolves.toMatchObject({ kind: "file", contentType: "image/jpeg", originalFilename: "avatar.jpg" });
	});
});
