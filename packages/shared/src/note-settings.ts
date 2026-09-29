import type { BotToolSettings } from './model';

export const planNoteId = 'PLAN';

export function notesEnabled(settings: BotToolSettings | undefined): boolean {
	return settings?.bickrNotes?.enabled !== false;
}

export function planEnabled(settings: BotToolSettings | undefined): boolean {
	return notesEnabled(settings) && settings?.bickrNotes?.planEnabled !== false;
}
