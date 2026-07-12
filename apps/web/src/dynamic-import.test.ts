import { describe, expect, it, vi } from "vitest";
import { retryDynamicImport } from "./dynamic-import";

describe("retryDynamicImport", () => {
	it("retries a failed dynamic import once", async () => {
		const loaded = { default: "loaded" };
		const load = vi.fn()
			.mockRejectedValueOnce(new Error("chunk unavailable"))
			.mockResolvedValueOnce(loaded);

		await expect(retryDynamicImport(load, 0)).resolves.toBe(loaded);
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("does not keep retrying after the second failure", async () => {
		const load = vi.fn().mockRejectedValue(new Error("chunk unavailable"));

		await expect(retryDynamicImport(load, 0)).rejects.toThrow("chunk unavailable");
		expect(load).toHaveBeenCalledTimes(2);
	});
});
