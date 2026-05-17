export function boundedLimit(value: string | null, defaultValue = 30, maxValue = 100): number {
	const parsed = Number(value ?? defaultValue);
	if (!Number.isFinite(parsed)) {
		return defaultValue;
	}
	return Math.min(maxValue, Math.max(1, Math.floor(parsed)));
}
