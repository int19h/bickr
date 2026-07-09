const d1UniqueConstraintPattern = /\bUNIQUE constraint failed:/i;

export function isD1UniqueConstraintError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}

	// D1 exposes SQLite constraint failures only through the third-party error
	// message boundary. Keep that text matching centralized here.
	return d1UniqueConstraintPattern.test(error.message);
}
