import { describe, expect, it, vi } from "vitest";
import { detail, table, printEnvelope, printJson, terminalText } from "./output.ts";

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


describe("terminal control boundary", () => {
	const attack = "ordinary\u001b[2J\u001b[HFORGED\u009b31m\u0007\r";
	it("escapes terminal commands in plain and localized detail values", () => {
		for (const value of [attack, { lang: "en", text: attack }]) {
			const rendered = detail([["Name", value]]);
			expect(rendered).not.toMatch(/[\u001b\u009b\u0007\r]/);
			expect(rendered).toContain("\\u001b[2J");
		}
	});
	it("protects custom human renderers and preserves JSON values", () => {
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		try {
			printEnvelope({ human: true, json: false, raw: false }, { ok: true, data: attack }, (value) => value);
			expect(write).toHaveBeenLastCalledWith(`${terminalText(attack)}\n`);
			printJson({ value: attack });
			expect(JSON.parse(write.mock.calls.at(-1)![0] as string)).toEqual({ value: attack });
		} finally { write.mockRestore(); }
	});
});
