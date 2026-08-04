import { describe, expect, it } from "vitest";
import { serviceRequest } from "../../../../apps/web/functions/api/_proxy";

describe("JSON service proxy lifecycle headers", () => {
	it("forwards caller idempotency keys to serialized coordinator routes", () => {
		const caller = new Request("https://bickr.social/api/worlds", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"idempotency-key": "stable-world-create",
			},
			body: "{}",
		});

		const forwarded = serviceRequest(
			{ INTERNAL_SERVICE_SECRET: "test-internal-secret" },
			caller,
			"/users/usr_test/worlds",
			"usr_test",
			"{}",
		);

		expect(forwarded.headers.get("idempotency-key")).toBe("stable-world-create");
		expect(forwarded.headers.get("x-bickr-user-id")).toBe("usr_test");
	});
});
