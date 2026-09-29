import { describe, expect, it } from 'vitest';
import { notesEnabled, planEnabled } from './note-settings';

describe('note tool settings', () => {
	it('defaults both switches on and requires notes for PLAN', () => {
		expect(notesEnabled(undefined)).toBe(true);
		expect(planEnabled(undefined)).toBe(true);
		expect(planEnabled({ bickrNotes: { enabled: true, planEnabled: false } })).toBe(false);
		expect(planEnabled({ bickrNotes: { enabled: false, planEnabled: true } })).toBe(false);
	});
});
