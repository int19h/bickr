import { describe, expect, it } from "vitest";
import { compileInputSchema, type InputSchema } from "./input-schema";
import { InputError } from "./validation";

const operation: InputSchema = {
	type: "object", properties: {
		kind: { type: "string", enum: ["update", "delete"] },
		count: { type: "integer", minimum: 1, maximum: 3 },
		label: { type: "string", minLength: 1, maxLength: 2 },
		enabled: { type: "boolean" },
		locale: { type: ["string", "null"] },
		nested: { type: ["object", "null"], properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },
	}, required: ["kind"], additionalProperties: false,
};
const validate = compileInputSchema(operation);

describe("published input schema validation", () => {
	it.each([
		null, [], true, "update", {}, { kind: null }, { kind: "unknown" }, { kind: "update", extra: 1 },
		{ kind: "update", count: "1" }, { kind: "update", count: 1.5 }, { kind: "update", count: 0 }, { kind: "update", count: 4 },
		{ kind: "update", enabled: "true" }, { kind: "update", enabled: null },
		{ kind: "update", label: "" }, { kind: "update", label: "abc" }, { kind: "update", locale: 4 },
		{ kind: "update", nested: {} }, { kind: "update", nested: { value: 1, extra: true } },
		{ kind: "update", nested: { value: Infinity } }, { kind: "update", nested: { value: NaN } },
	])("rejects invalid input %# before a handler can run", (value) => {
		expect(() => validate(value)).toThrow(InputError);
	});
	it("accepts optional fields, explicit nullable values, boundary numbers, and Unicode code points", () => {
		validate({ kind: "update" });
		validate({ kind: "update", count: 1, label: "😀😀", locale: null, nested: null, enabled: false });
		validate({ kind: "delete", count: 3, nested: { value: 1.5 } });
	});
	it("checks every array member and the declared array bounds", () => {
		const validateBatch = compileInputSchema({ type: "array", minItems: 1, maxItems: 2, items: operation });
		expect(() => validateBatch([])).toThrow(InputError);
		expect(() => validateBatch([{ kind: "update" }, { kind: "update" }, { kind: "update" }])).toThrow(InputError);
		expect(() => validateBatch([{ kind: "update" }, { kind: "other" }])).toThrow(InputError);
		validateBatch([{ kind: "update" }, { kind: "delete" }]);
	});
	it("uses own properties and rejects prototype-named keys on closed objects", () => {
		expect(() => validate(Object.create({ kind: "update" }))).toThrow(InputError);
		expect(() => validate(JSON.parse('{"kind":"update","__proto__":{}}'))).toThrow(InputError);
		expect(() => validate({ kind: "update", constructor: "value" })).toThrow(InputError);
	});
	it("honors open objects and additional-property schemas", () => {
		compileInputSchema({ type: "object", properties: { enabled: { type: "boolean" } }, additionalProperties: true })({ enabled: false, providerSpecific: 1 });
		const typedAdditional = compileInputSchema({ type: "object", additionalProperties: { type: "number" } });
		typedAdditional({ one: 1 });
		expect(() => typedAdditional({ one: "1" })).toThrow(InputError);
	});
	it("checks declared property names and property counts", () => {
		const validator = compileInputSchema({ type: "object", propertyNames: { enum: ["one", "two"] }, minProperties: 1, maxProperties: 1 });
		validator({ one: 1 });
		expect(() => validator({})).toThrow(InputError);
		expect(() => validator({ one: 1, two: 2 })).toThrow(InputError);
		expect(() => validator({ other: 3 })).toThrow(InputError);
	});
	it("refuses unsupported constraints instead of silently publishing an unchecked promise", () => {
		expect(() => compileInputSchema({ type: "string", pattern: "^[a-z]+$" } as InputSchema)).toThrow("Unsupported input schema keyword");
	});
});
