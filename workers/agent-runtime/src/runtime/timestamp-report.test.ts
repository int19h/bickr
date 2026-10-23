import { describe, expect, it, vi } from 'vitest';
import { BotRuntime } from './bot-runtime';
import { botText } from '../localization';
import type { ChatMessage, LoopMessageGroupEntry } from '../types';

describe('tick timestamp report', () => {
	it.each(['new_iteration', 'continuation', 'spotlight'])('starts each %s tick with a user report', async setupMode => {
		const messages: ChatMessage[] = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			profileUsernamesInActiveContext: () => new Set(),
			providerContentInActiveContext: () => ({ commentsWithText: new Set(), threadsWithText: new Set() }),
			appendNotificationSyntheticContext: async () => [],
			appendSpotlightSyntheticContext: vi.fn(),
			appendLoopMessageGroup: (entries: LoopMessageGroupEntry[]) => { messages.push(...entries.map(entry => entry.message)); },
			activeLoopMessagesForProvider: () => messages,
		});
		await runtime.buildMessages({ text: botText('en'), createdAt: '2026-01-01T00:00:00Z', inferenceSettings: {}, worldRecurringPrompt: '' },
			{ spotlightContexts: setupMode === 'spotlight' ? [{}] : [], notifications: [], injections: [], toolUseReminder: '' }, 'run',
			{ seq: 1, createdAt: '2026-01-02T05:30:59Z' }, { setupMode });
		expect(messages[0]).toEqual({ role: 'user', content: 'Current timestamp: 1d5h30m since your Bickr account was created.' });
	});
	it('uses the chosen absolute timezone in the report', async () => {
		const messages: ChatMessage[] = [];
		const runtime = Object.assign(Object.create(BotRuntime.prototype), {
			profileUsernamesInActiveContext: () => new Set(),
			providerContentInActiveContext: () => ({ commentsWithText: new Set(), threadsWithText: new Set() }),
			appendLoopMessageGroup: (entries: LoopMessageGroupEntry[]) => { messages.push(...entries.map(entry => entry.message)); },
			activeLoopMessagesForProvider: () => messages,
		});
		await runtime.buildMessages({ text: botText('en'), createdAt: '2026-01-01T00:00:00Z', timeSettings: { mode: 'absolute', timezone: 'Asia/Kolkata' }, inferenceSettings: {} },
			{ spotlightContexts: [], notifications: [], injections: [] }, 'run', { seq: 1, createdAt: '2026-10-23T08:07:59Z' }, { setupMode: 'continuation' });
		expect(messages[0]).toEqual({ role: 'user', content: 'Current timestamp: 2026-10-23T13:37+05:30.' });
	});
});
