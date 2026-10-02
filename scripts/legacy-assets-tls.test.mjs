import { describe, expect, it, vi } from "vitest";
import { applyTLS, tlsPlan } from "./legacy-assets-tls.mjs";

const config = { accountId: "account", bucket: "bucket", domain: "assets.example.com", expectedMinTLS: "1.0", minTLS: "1.2" };
const domain = (minTLS) => Response.json({ success: true, result: { domain: config.domain, minTLS, enabled: true } });

describe("legacy asset TLS update", () => {
	it("changes only the selected domain's minimum TLS version", async () => {
		const request = vi.fn().mockResolvedValueOnce(domain("1.0"))
			.mockResolvedValueOnce(Response.json({ success: true })).mockResolvedValueOnce(domain("1.2"));
		expect((await applyTLS(config, "secret", request)).kind).toBe("updated");
		expect(request.mock.calls[1][0]).toBe(tlsPlan(config).url);
		expect(request.mock.calls[1][1].method).toBe("PUT");
		expect(JSON.parse(request.mock.calls[1][1].body)).toEqual({ minTLS: "1.2" });
	});

	it.each(["1.2", "1.3"])("does not lower an existing %s policy", async (minimum) => {
		const request = vi.fn().mockResolvedValue(domain(minimum));
		expect((await applyTLS(config, "secret", request)).kind).toBe("already-secure");
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("stops if the reviewed state changed", async () => {
		const request = vi.fn().mockResolvedValue(domain("1.1"));
		await expect(applyTLS(config, "secret", request)).rejects.toThrow("state changed");
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("never retries a failed write", async () => {
		const request = vi.fn().mockResolvedValueOnce(domain("1.0")).mockRejectedValueOnce(new Error("connection closed"));
		await expect(applyTLS(config, "secret", request)).rejects.toThrow("connection closed");
		expect(request).toHaveBeenCalledTimes(2);
	});
});
