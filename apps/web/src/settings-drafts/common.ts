export function numericDraftValue(value: number | undefined): string {
	return value === undefined ? "" : String(value);
}
