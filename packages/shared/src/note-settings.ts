import type { BotToolSettings } from './model';

// Count Unicode code points, not UTF-16 code units.
export const maxNoteContentLength = 8_000;

export const planNoteId = 'PLAN';

export function notesEnabled(settings: BotToolSettings | undefined): boolean {
	return settings?.bickrNotes?.enabled !== false;
}

export function planEnabled(settings: BotToolSettings | undefined): boolean {
	return notesEnabled(settings) && settings?.bickrNotes?.planEnabled !== false;
}
