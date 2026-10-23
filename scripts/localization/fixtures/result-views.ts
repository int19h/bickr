import type { InstructionText } from '@bickr/shared/instruction-template';
import type { FreeText, InlineValue } from '../../../workers/agent-runtime/src/localization/result-template.ts';

export type ItemView = { readonly ref: InlineValue<'commentRef'>; readonly body: FreeText };
export type FixtureView = {
	readonly ref: InlineValue<'threadRef'>;
	readonly body: FreeText;
	readonly message: InstructionText;
	readonly note: InlineValue<'noteId'>;
	readonly cursor: InlineValue<'cursor'>;
	readonly author: InlineValue<'author'>;
	readonly count: InlineValue<'count'>;
	readonly score: InlineValue<'score'>;
	readonly timestamp: InlineValue<'timestamp'>;
	readonly profile: InlineValue<'profileRef'>;
	readonly forum: InlineValue<'forumRef'>;
	readonly show: boolean;
	readonly optional?: InlineValue<'commentRef'>;
	readonly number: number;
	readonly items: readonly ItemView[];
	readonly item: ItemView;
	readonly state: 'up' | 'down' | 'cleared';
	readonly event: { readonly kind: 'post'; readonly ref: InlineValue<'commentRef'> } | { readonly kind: 'empty' };
};

export type EventView = FixtureView['event'];
export type PostEventView = Extract<EventView, { readonly kind: 'post' }>;
