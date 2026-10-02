import { describe, expect, it, vi } from "vitest";
import { verifyPublicRelease } from "./verify-release.mjs";
import { sha256 } from "./release-support.mjs";

const commit = "a".repeat(40);
const localHtml = `<head><meta name="bickr-release" content="${commit}"></head><script src="/assets/index-hash.js"></script>`;
const checks = { build: { "assets/index-hash.js": sha256("bundle") } };

describe("custom domain release verification", () => {
	it.each(["test", "production"])("accepts transformed %s HTML and verifies the exact entry assets", async (environment) => {
		const request = vi.fn(async (url, options) => {
			if (environment === "test" && options.headers.cookie !== "bickr_test_environment=1") return new Response("Test gateway notice");
			if (url.endsWith("/api/runtime/health")) return Response.json({ ok: true });
			if (url.includes("/?release=")) return new Response(localHtml.replace("</head>", '<meta name="robots" content="noindex"></head>') + "<aside>Test notice</aside>");
			return new Response("bundle");
		});
		await expect(verifyPublicRelease({ commit, environment, origin: "https://example.com" }, checks, localHtml, request)).resolves.toBeUndefined();
		expect(request).toHaveBeenCalledTimes(3);
		if (environment === "production") expect(request.mock.calls.every(([, options]) => !options.headers.cookie)).toBe(true);
	});

	it("rejects a gateway response or an old marker", async () => {
		for (const html of ["Test gateway notice", localHtml.replace(commit, "b".repeat(40))]) {
			const request = vi.fn().mockResolvedValueOnce(Response.json({ ok: true })).mockResolvedValueOnce(new Response(html));
			await expect(verifyPublicRelease({ commit, environment: "test", origin: "https://example.com" }, checks, localHtml, request)).rejects.toThrow("release marker");
		}
	});

	it("rejects a changed asset even when the marker matches", async () => {
		const request = vi.fn().mockResolvedValueOnce(Response.json({ ok: true })).mockResolvedValueOnce(new Response(localHtml)).mockResolvedValueOnce(new Response("stale bundle"));
		await expect(verifyPublicRelease({ commit, environment: "test", origin: "https://example.com" }, checks, localHtml, request)).rejects.toThrow("asset does not match");
	});
});
