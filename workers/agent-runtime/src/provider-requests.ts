export type { ProviderSettings } from '@bickr/shared/inference-settings';

export function providerMessageTextContent(value: unknown): string | undefined {
	if (typeof value === 'string') {
		return value.trim() || undefined;
	}
	if (!Array.isArray(value)) {
		return undefined;
	}
	const text = value
		.map((item) => {
			const record = item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>) : {};
			return typeof record.text === 'string' ? record.text : '';
		})
		.join('\n')
		.trim();
	return text || undefined;
}
