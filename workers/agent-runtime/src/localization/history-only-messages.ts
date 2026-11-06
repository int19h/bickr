import type { MessageDefinitions } from '@bickr/shared/instruction-template';

// No current code produces these messages. A tool result stores a catalog key
// and its parameters (ResultText) and renders that key on each read. Bot
// history keeps tool results indefinitely, so a stored result from before
// search rebuilding stopped being produced can still name this key. If the
// message goes, old history cannot render. Remove a key here only after a
// future history migration rewrites the stored results that name it.
export const historyOnlyMessageDefinitions = {
	"issue.service.searchRebuilding": {
		kind: "text",
		parameters: [],
	},
} as const satisfies MessageDefinitions;
