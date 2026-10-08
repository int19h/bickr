import { createHash } from 'node:crypto';
import { parseInstructionLanguagePreference } from '../packages/shared/src/instruction-language.ts';

export const migrationKind = 'auto-instructions-to-english-v1';
export const maximumBots = 10_000;
const profileFields = ['id', 'ownerUserId', 'homeWorldId', 'handle', 'language', 'displayName', 'shortBio', 'prompt', 'cloneSourceBotId'];
export function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function profileDigest(bot) { return digest(Object.fromEntries(profileFields.map(key => [key, bot[key] ?? null]))); }
export function preference(bot) {
	return bot.instructionLanguage === undefined ? { kind: 'auto' } : parseInstructionLanguagePreference(bot.instructionLanguage);
}
export function snapshotBot(bot, row) {
	if (!bot || bot.deletedAt || bot.id !== row.id || bot.ownerUserId !== row.ownerUserId || !Number.isSafeInteger(bot.revision) || bot.revision < 1) {
		throw new Error(`Invalid stored participant ${row.id}.`);
	}
	return { id: bot.id, ownerUserId: bot.ownerUserId, revision: bot.revision, preference: preference(bot), profileDigest: profileDigest(bot), storedDigest: digest(bot) };
}
export function validatePlan(plan, target, commit) {
	if (plan.kind !== migrationKind || plan.environment !== target.environment || plan.accountId !== target.accountId ||
		plan.namespaceId !== target.namespaceId || plan.databaseId !== target.databaseId || plan.service !== target.service ||
		plan.commit !== commit || !/^[a-f0-9]{40}$/.test(commit) || !Array.isArray(plan.bots) || plan.bots.length > maximumBots) {
		throw new Error('The migration plan does not match the selected deployment.');
	}
	const ids = new Set();
	for (const bot of plan.bots) {
		if (typeof bot.id !== 'string' || !bot.id || typeof bot.ownerUserId !== 'string' || !bot.ownerUserId || ids.has(bot.id) ||
			!Number.isSafeInteger(bot.revision) || bot.revision < 1 || !/^[a-f0-9]{64}$/.test(bot.profileDigest)) throw new Error('Invalid migration participant.');
		parseInstructionLanguagePreference(bot.preference);
		ids.add(bot.id);
	}
}
export function createJournal(plan) { return { kind: migrationKind, planDigest: digest(plan), applied: [] }; }
export async function applyPlan(plan, journal, update, persist) {
	const candidates = plan.bots.filter(bot => bot.preference.kind === 'auto');
	const candidatesById = new Map(candidates.map(bot => [bot.id, bot]));
	if (journal.kind !== migrationKind || journal.planDigest !== digest(plan) || !Array.isArray(journal.applied) ||
		new Set(journal.applied.map(bot => bot.id)).size !== journal.applied.length ||
		journal.applied.some(bot => bot.revision !== candidatesById.get(bot.id)?.revision + 1)) throw new Error('The journal does not match the plan.');
	const completed = new Set(journal.applied.map(bot => bot.id));
	for (const bot of candidates) {
		if (completed.has(bot.id)) continue;
		// Never replace this revision with a newly read revision after a conflict.
		const result = await update(bot);
		if (result.id !== bot.id || result.revision !== bot.revision + 1 || result.instructionLanguage?.kind !== 'fixed' || result.instructionLanguage.locale !== 'en') {
			throw new Error(`Unexpected migration response for ${bot.id}.`);
		}
		journal.applied.push({ id: bot.id, revision: result.revision });
		await persist(journal);
	}
	return journal;
}
export function verifySnapshot(plan, documents) {
	for (const snapshot of plan.bots) {
		const current = documents.get(snapshot.id);
		if (!current || current.deletedAt || profileDigest(current) !== snapshot.profileDigest) throw new Error(`Participant profile changed: ${snapshot.id}.`);
		const expected = snapshot.preference.kind === 'auto' ? { kind: 'fixed', locale: 'en' } : snapshot.preference;
		if (digest(preference(current)) !== digest(expected)) throw new Error(`Participant instructions differ: ${snapshot.id}.`);
	}
	return { participants: plan.bots.length, migrated: plan.bots.filter(bot => bot.preference.kind === 'auto').length };
}
