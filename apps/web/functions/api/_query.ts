export function boundedLimit(value: string | null, defaultValue = 30, maxValue = 100): number {
	const parsed = Number(value ?? defaultValue);
	if (!Number.isFinite(parsed)) {
		return defaultValue;
	}
	return Math.min(maxValue, Math.max(1, Math.floor(parsed)));
}

export function boundedOffset(value: string | null): number {
	const parsed = Number(value ?? 0);
	if (!Number.isFinite(parsed)) {
		return 0;
	}
	return Math.max(0, Math.floor(parsed));
}
