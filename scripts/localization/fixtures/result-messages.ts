export const messageParameters = {
	label: { kind: 'text', parameters: [] },
	ref: { kind: 'text', parameters: ['ref'] },
	count: { kind: 'plural', parameters: ['count'], count: 'count' },
	person: { kind: 'select', parameters: ['author'], select: 'author', variants: ['self', 'other'] },
	vote: { kind: 'select', parameters: ['state'], select: 'state', variants: ['up', 'down', 'cleared'] },
} as const;
