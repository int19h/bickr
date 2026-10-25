import { readableReasoningFormat } from '@bickr/shared/model';
import { approximateTextTokens } from '@bickr/shared/text-token-estimate';
import type { ChatMessage } from '../types';
import { sanitizeProviderMessageForRequest } from '../provider/sanitize';

export function estimateLoopMessageTokens(message: ChatMessage): number {
	// Local display fields do not consume provider context.
	return approximateTextTokens(JSON.stringify(message.reasoning_format === readableReasoningFormat ? sanitizeProviderMessageForRequest(message) : message));
}
