import { InputError } from "./validation";

type JsonType = "null" | "boolean" | "number" | "integer" | "string" | "array" | "object";

/** The JSON Schema subset that Bickr publishes for MCP input. Keep this type,
 * compiler, and schema definitions together: unsupported keywords fail at
 * definition time instead of becoming promises the request parser ignores. */
export type InputSchema = {
	type?: JsonType | readonly JsonType[];
	description?: string;
	properties?: Readonly<Record<string, InputSchema>>;
	propertyNames?: InputSchema;
	minProperties?: number;
	maxProperties?: number;
	required?: readonly string[];
	additionalProperties?: boolean | InputSchema;
	items?: InputSchema;
	enum?: readonly (string | number | boolean | null)[];
	minimum?: number;
	maximum?: number;
	minLength?: number;
	maxLength?: number;
	minItems?: number;
	maxItems?: number;
};

export class InputSchemaError extends InputError {
	readonly path: string;
	readonly keyword: string;
	constructor(path: string, keyword: string, message: string) {
		super(message);
		this.name = "InputSchemaError";
		this.path = path;
		this.keyword = keyword;
	}
}

export type InputValidator = (value: unknown, label?: string) => void;
type Visit = (value: unknown, label: string) => void;
const keywords = new Set(["type", "description", "properties", "required", "additionalProperties", "items", "enum", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "propertyNames", "minProperties", "maxProperties"]);
const types = new Set<JsonType>(["null", "boolean", "number", "integer", "string", "array", "object"]);

/** Compile once at tool definition time. This uses closures, never eval or
 * generated JavaScript, so it also works inside a Cloudflare Worker. */
export function compileInputSchema(schema: InputSchema): InputValidator {
	const visit = compile(schema, 0);
	return (value, label = "Arguments") => visit(value, label);
}

function compile(schema: InputSchema, depth: number): Visit {
	if (depth > 64) throw new Error("Input schema exceeds the supported nesting depth.");
	for (const key of Object.keys(schema)) if (!keywords.has(key)) throw new Error(`Unsupported input schema keyword: ${key}`);
	const acceptedTypes = typeof schema.type === "string" ? [schema.type] : schema.type;
	if (acceptedTypes && (!acceptedTypes.length || acceptedTypes.some((type) => !types.has(type)))) throw new Error("Invalid input schema type.");
	for (const key of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"] as const) {
		const bound = schema[key];
		if (bound !== undefined && (!Number.isFinite(bound) || (key !== "minimum" && key !== "maximum" && (!Number.isInteger(bound) || bound < 0)))) {
			throw new Error(`Invalid input schema bound: ${key}`);
		}
	}
	if (schema.enum && !schema.enum.length) throw new Error("Input schema enum must not be empty.");
	const properties = new Map(Object.entries(schema.properties ?? {}).map(([key, child]) => [key, compile(child, depth + 1)]));
	const additional = typeof schema.additionalProperties === "object" ? compile(schema.additionalProperties, depth + 1) : null;
	const propertyName = schema.propertyNames ? compile(schema.propertyNames, depth + 1) : null;
	const item = schema.items ? compile(schema.items, depth + 1) : null;
	return (value, label) => {
		if (acceptedTypes && !acceptedTypes.some((type) => matchesType(value, type))) throw new InputSchemaError(label, "type", `${label} must have type ${acceptedTypes.join(" or ")}.`);
		if (schema.enum && !schema.enum.some((candidate) => candidate === value)) throw new InputSchemaError(label, "enum", `${label} must be an allowed value.`);
		if (typeof value === "number") {
			if (!Number.isFinite(value)) throw new InputSchemaError(label, "type", `${label} must be finite.`);
			if (schema.minimum !== undefined && value < schema.minimum) throw new InputSchemaError(label, "minimum", `${label} must be at least ${schema.minimum}.`);
			if (schema.maximum !== undefined && value > schema.maximum) throw new InputSchemaError(label, "maximum", `${label} must be at most ${schema.maximum}.`);
		}
		if (typeof value === "string" && (schema.minLength !== undefined || schema.maxLength !== undefined)) {
			// JSON Schema counts Unicode code points, not UTF-16 code units.
			let length = 0;
			for (const _character of value) length++;
			if (schema.minLength !== undefined && length < schema.minLength) throw new InputSchemaError(label, "minLength", `${label} is too short.`);
			if (schema.maxLength !== undefined && length > schema.maxLength) throw new InputSchemaError(label, "maxLength", `${label} is too long.`);
		}
		if (Array.isArray(value)) {
			if (schema.minItems !== undefined && value.length < schema.minItems) throw new InputSchemaError(label, "minItems", `${label} needs at least ${schema.minItems} items.`);
			if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new InputSchemaError(label, "maxItems", `${label} accepts at most ${schema.maxItems} items.`);
			if (item) value.forEach((entry, index) => item(entry, `${label}[${index}]`));
		} else if (value !== null && typeof value === "object") {
			const record = value as Record<string, unknown>;
			const entries = Object.entries(record);
			if (schema.minProperties !== undefined && entries.length < schema.minProperties) throw new InputSchemaError(label, "minProperties", `${label} needs at least ${schema.minProperties} properties.`);
			if (schema.maxProperties !== undefined && entries.length > schema.maxProperties) throw new InputSchemaError(label, "maxProperties", `${label} accepts at most ${schema.maxProperties} properties.`);
			for (const key of schema.required ?? []) {
				if (!Object.hasOwn(record, key)) throw new InputSchemaError(label, "required", `${label} is missing required argument ${key}.`);
			}
			for (const [key, entry] of entries) {
				if (propertyName) propertyName(key, `${label} property name`);
				const property = properties.get(key);
				if (property) property(entry, `${label}.${key}`);
				else if (additional) additional(entry, `${label}.${key}`);
				else if (schema.additionalProperties === false) throw new InputSchemaError(label, "additionalProperties", `${label} contains unsupported argument ${key}.`);
			}
		}
	};
}

function matchesType(value: unknown, type: JsonType): boolean {
	switch (type) {
		case "null": return value === null;
		case "array": return Array.isArray(value);
		case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
		case "integer": return typeof value === "number" && Number.isInteger(value);
		case "number": return typeof value === "number" && Number.isFinite(value);
		case "string": return typeof value === "string";
		case "boolean": return typeof value === "boolean";
	}
}
