import { describe, expect, it } from "vitest";
import { detail, table } from "./output.ts";

describe("CLI output rendering", () => {
	it("renders localized text in tables without object syntax", () => {
		const rendered = table(
			[{ name: { lang: "ja", text: "将軍家" }, language: "ja" }],
			[
				{ key: "language", header: "Lang", value: (row) => row.language },
				{ key: "name", header: "Name", value: (row) => row.name },
			],
		);
		expect(rendered).toContain("将軍家");
		expect(rendered).not.toContain("[object Object]");
		expect(rendered).not.toContain("\"text\"");
	});

	it("renders localized detail rows as text", () => {
		expect(detail([["Body", { lang: "uk", text: "Рядок\nдругий" }]])).toContain("Рядок другий");
	});
});
