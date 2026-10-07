export type { ProviderSettings } from '@bickr/shared/inference-settings';
import type { ProviderSettings } from '@bickr/shared/inference-settings';
import type { BotText } from './localization';

/** Internal model requests carry the same immutable text context as their participant or account snapshot. */
export type LocalizedProviderSettings = ProviderSettings & { readonly text: BotText };

export function withProviderText(settings: ProviderSettings, text: BotText): LocalizedProviderSettings {
	return { ...settings, text };
}

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
