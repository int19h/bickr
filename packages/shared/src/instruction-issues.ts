import type { MessageDefinitions } from './instruction-template.ts';

export type IssueParameterKind = 'opaque' | 'integer' | 'count' | 'argumentPath' | 'ref';
export type IssueDefinition = {
	readonly parameters: Readonly<Record<string, IssueParameterKind>>;
	readonly plural?: string;
	readonly outcome: 'refused' | 'committed' | 'not_started';
};
export type IssueManifest = Readonly<Record<string, IssueDefinition>>;
type ParameterValue<Kind extends IssueParameterKind> = Kind extends 'integer' | 'count' ? number : string;
export type IssueParameters<Definition extends IssueDefinition> = {
	readonly [Name in keyof Definition['parameters']]: ParameterValue<Definition['parameters'][Name]>;
};
export type InstructionIssue<Manifest extends IssueManifest> = {
	[Key in keyof Manifest]: { readonly key: Key; readonly parameters: IssueParameters<Manifest[Key]> };
}[keyof Manifest];
export type IssueMessageDefinitions<Manifest extends IssueManifest> = {
	readonly [Key in keyof Manifest]: Manifest[Key] extends { readonly plural: infer Count extends string }
		? { readonly kind: 'plural'; readonly parameters: readonly (keyof Manifest[Key]['parameters'] & string)[]; readonly count: Count }
		: { readonly kind: 'text'; readonly parameters: readonly (keyof Manifest[Key]['parameters'] & string)[] };
};

export function issueMessageDefinitions<const Manifest extends IssueManifest>(manifest: Manifest): IssueMessageDefinitions<Manifest> {
	const definitions: Record<string, MessageDefinitions[string]> = {};
	for (const [key, issue] of Object.entries(manifest)) {
		const parameters = Object.keys(issue.parameters);
		if (issue.plural !== undefined && issue.parameters[issue.plural] !== 'count') {
			throw new Error(`Invalid issue count definition: ${key}`);
		}
		definitions[key] = issue.plural === undefined ? { kind: 'text', parameters }
			: { kind: 'plural', parameters, count: issue.plural };
	}
	// The runtime transformation preserves each key, parameter name, and plural control.
	return definitions as IssueMessageDefinitions<Manifest>;
}

export function instructionIssue<const Manifest extends IssueManifest, Key extends keyof Manifest>(
	manifest: Manifest, key: Key, parameters: IssueParameters<Manifest[Key]>,
): Extract<InstructionIssue<Manifest>, { readonly key: Key }> {
	const value = { key, parameters };
	if (!parseInstructionIssue(manifest, value)) throw new Error(`Invalid instruction issue parameters: ${String(key)}`);
	return value as Extract<InstructionIssue<Manifest>, { readonly key: Key }>;
}

/** Only declared keys and exact parameter shapes can cross the service boundary. */
export function parseInstructionIssue<const Manifest extends IssueManifest>(manifest: Manifest, value: unknown): InstructionIssue<Manifest> | null {
	if (!record(value) || Object.keys(value).length !== 2 || typeof value.key !== 'string' || !Object.hasOwn(manifest, value.key)) return null;
	const definition = manifest[value.key]!;
	if (!record(value.parameters)) return null;
	const parameters = value.parameters;
	const supplied = Object.keys(parameters);
	const expected = Object.keys(definition.parameters);
	if (supplied.length !== expected.length || supplied.some((name) => !Object.hasOwn(definition.parameters, name))) return null;
	for (const [name, kind] of Object.entries(definition.parameters)) {
		const parameter = parameters[name];
		switch (kind) {
			case 'integer':
			case 'count':
				if (typeof parameter !== 'number' || !Number.isSafeInteger(parameter) || (kind === 'count' && parameter < 0)) return null;
				break;
			case 'opaque':
				if (typeof parameter !== 'string') return null;
				break;
			case 'argumentPath':
				if (typeof parameter !== 'string' || parameter.length > 256 || !/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*|\[\d+\])*$/u.test(parameter)) return null;
				break;
			case 'ref':
				if (typeof parameter !== 'string' || parameter.length > 256 || !/^[ctfuw]\/[^\s]+$/u.test(parameter)) return null;
				break;
		}
	}
	// Copy only schema values. Prototype fields and unknown data never enter the renderer.
	return { key: value.key, parameters: Object.fromEntries(expected.map((name) => [name, parameters[name]])) } as InstructionIssue<Manifest>;
}

function record(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
