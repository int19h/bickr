import type { RuntimeErrorCause } from './runtime-errors';

export type RuntimeDiagnostic = {
	kind: 'bookkeeping_failure';
	operation: string;
	message: string;
	cause: RuntimeErrorCause | string;
};

/** Stored event boundary: older events have no diagnostics. */
export function runtimeDiagnostics(value: unknown): RuntimeDiagnostic[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is RuntimeDiagnostic => item !== null && typeof item === 'object'
		&& item.kind === 'bookkeeping_failure' && typeof item.operation === 'string' && typeof item.message === 'string');
}
