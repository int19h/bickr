import { sha256Hex } from '@bickr/shared/ids';
import { isOpenRouterProviderBaseUrl } from '@bickr/shared/inference-settings';
import { modelUsesMetaPromptCache } from '@bickr/shared/openrouter-model-capabilities';

type AffinitySettings = { baseUrl?: string; model: string };
type InstructionMessage = { role: string; content?: unknown };
export type ProviderRequestPurpose = 'loop' | 'compaction' | 'token-probe' | 'translation' | 'avatar-description' | 'world-avatar-description' | 'avatar-image' | 'current-avatar-description';
export type ProviderChatAffinity = {
	session_id?: string;
	prompt_cache_key?: string;
	prompt_cache_retention?: '24h';
};

/** Compute once from original instructions, so repair messages cannot change routing. */
export async function providerRequestSessionId(
	purpose: ProviderRequestPurpose,
	messages: readonly InstructionMessage[],
	explicitId?: string,
): Promise<string> {
	if (explicitId && explicitId.length <= 256) return explicitId;
	const instructions = messages.filter(message => message.role === 'system' || message.role === 'developer')
		.map(message => ({ role: message.role, content: message.content }));
	return `bickr:${purpose}:${await sha256Hex(JSON.stringify(explicitId ? [purpose, explicitId] : [purpose, instructions]))}`;
}

function directMetaChatEndpoint(baseUrl: string | undefined): boolean {
	if (!baseUrl) return false;
	try {
		const url = new URL(baseUrl);
		return url.protocol === 'https:' && url.hostname === 'api.meta.ai' && !url.port &&
			!url.username && !url.password && !url.search && !url.hash &&
			['/v1', '/v1/chat/completions'].includes(url.pathname.replace(/\/+$/, ''));
	} catch {
		return false;
	}
}

/** Compose provider fields at the request builder, never by rewriting transport JSON. */
export function providerChatAffinity(settings: AffinitySettings, sessionId: string | undefined): ProviderChatAffinity {
	if (!sessionId) return {};
	const openRouter = (settings.baseUrl !== undefined && isOpenRouterProviderBaseUrl(settings.baseUrl));
	const meta = openRouter ? modelUsesMetaPromptCache(settings.model) : directMetaChatEndpoint(settings.baseUrl);
	return {
		...(openRouter ? { session_id: sessionId } : {}),
		...(meta ? { prompt_cache_key: sessionId, prompt_cache_retention: '24h' as const } : {}),
	};
}

/** OpenRouter's image endpoint groups sessions through a header, not a body field. */
export function providerImageAffinityHeaders(settings: AffinitySettings, sessionId: string): Record<string, string> {
	return (settings.baseUrl !== undefined && isOpenRouterProviderBaseUrl(settings.baseUrl)) ? { 'x-session-id': sessionId } : {};
}
