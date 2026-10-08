import { describe, expect, it } from 'vitest';
import { applyPlan, createJournal, digest, migrationKind, snapshotBot, validatePlan, verifySnapshot } from './instruction-language-migration.mjs';
const target = { environment: 'test', accountId: 'account', namespaceId: 'namespace', databaseId: 'database', service: 'service' };
const commit = 'a'.repeat(40);
function fixture() {
	const documents = new Map([
		['omitted', { id: 'omitted', ownerUserId: 'owner', revision: 3, prompt: { text: 'Keep this text' }, language: 'ja' }],
		['auto', { id: 'auto', ownerUserId: 'owner2', revision: 5, instructionLanguage: { kind: 'auto' }, language: 'ru' }],
		['fixed', { id: 'fixed', ownerUserId: 'owner', revision: 7, instructionLanguage: { kind: 'fixed', locale: 'ga' } }],
		['source', { id: 'source', ownerUserId: 'owner', revision: 8, instructionLanguage: { kind: 'source' }, cloneSourceBotId: 'fixed' }],
	]);
	const plan = { kind: migrationKind, ...target, commit, bots: [...documents.values()].map(bot => snapshotBot(bot, { id: bot.id, ownerUserId: bot.ownerUserId })) };
	const calls = [];
	const update = async planned => {
		calls.push(planned.id);
		const stored = documents.get(planned.id);
		if (stored.revision !== planned.revision) throw new Error('HTTP 412');
		const updated = { ...stored, revision: stored.revision + 1, instructionLanguage: { kind: 'fixed', locale: 'en' } };
		documents.set(planned.id, updated);
		return updated;
	};
	return { documents, plan, calls, update };
}
describe('one-time Auto instructions migration', () => {
	it('migrates omitted and explicit Auto across owners and preserves fixed and source preferences', async () => {
		const { plan, documents, calls, update } = fixture();
		validatePlan(plan, target, commit);
		const journal = await applyPlan(plan, createJournal(plan), update, async () => {});
		expect(calls).toEqual(['omitted', 'auto']);
		expect(verifySnapshot(plan, documents)).toEqual({ participants: 4, migrated: 2 });
		await applyPlan(plan, journal, update, async () => {});
		expect(calls).toEqual(['omitted', 'auto']);
	});
	it('stops on a revision conflict and resumes only the remaining captured revisions', async () => {
		const { plan, documents, calls, update } = fixture();
		const journal = createJournal(plan);
		documents.get('auto').revision++;
		await expect(applyPlan(plan, journal, update, async () => {})).rejects.toThrow('HTTP 412');
		expect(journal.applied).toEqual([{ id: 'omitted', revision: 4 }]);
		await expect(applyPlan(plan, journal, update, async () => {})).rejects.toThrow('HTTP 412');
		expect(calls).toEqual(['omitted', 'auto', 'auto']);
	});
	it('stops after an uncertain write without accepting a changed revision on retry', async () => {
		const { plan, calls, update } = fixture();
		const journal = createJournal(plan);
		await expect(applyPlan(plan, journal, async bot => { await update(bot); throw new Error('Connection lost'); }, async () => {})).rejects.toThrow('Connection lost');
		await expect(applyPlan(plan, journal, update, async () => {})).rejects.toThrow('HTTP 412');
		expect(calls).toEqual(['omitted', 'omitted']);
	});
	it('rejects an unexpected response before recording completion', async () => {
		const { plan } = fixture();
		const journal = createJournal(plan);
		await expect(applyPlan(plan, journal, async bot => ({ id: bot.id, revision: bot.revision + 1, instructionLanguage: { kind: 'auto' } }), async () => {})).rejects.toThrow('Unexpected');
		expect(journal.applied).toEqual([]);
	});
	it('rejects cross-environment plans, wrong commits, and duplicate IDs', () => {
		const { plan } = fixture();
		for (const field of ['environment', 'namespaceId', 'databaseId', 'service', 'accountId']) expect(() => validatePlan(plan, { ...target, [field]: 'other' }, commit)).toThrow();
		expect(() => validatePlan(plan, target, 'b'.repeat(40))).toThrow();
		expect(() => validatePlan({ ...plan, bots: [...plan.bots, plan.bots[0]] }, target, commit)).toThrow();
	});
	it('rejects journals for other plans or unexpected completed entries', async () => {
		const { plan, calls, update } = fixture();
		for (const journal of [{ ...createJournal(plan), planDigest: 'wrong' }, { ...createJournal(plan), applied: [{ id: 'fixed', revision: 8 }] }]) {
			await expect(applyPlan(plan, journal, update, async () => {})).rejects.toThrow('journal');
		}
		expect(calls).toEqual([]);
	});
	it('detects authored profile changes and changes to preserved preferences', async () => {
		const { plan, documents, update } = fixture();
		await applyPlan(plan, createJournal(plan), update, async () => {});
		documents.get('omitted').prompt.text = 'Changed';
		expect(() => verifySnapshot(plan, documents)).toThrow('profile changed');
		documents.get('omitted').prompt.text = 'Keep this text';
		documents.get('fixed').instructionLanguage = { kind: 'fixed', locale: 'en' };
		expect(() => verifySnapshot(plan, documents)).toThrow('instructions differ');
	});
	it('rejects missing, deleted, mismatched, and malformed census records', () => {
		for (const bot of [null, { id: 'bot', ownerUserId: 'owner', revision: 1, deletedAt: 'now' }, { id: 'bot', ownerUserId: 'other', revision: 1 }, { id: 'bot', ownerUserId: 'owner', revision: 0 }, { id: 'bot', ownerUserId: 'owner', revision: 1, instructionLanguage: { kind: 'fixed', locale: 'xx' } }]) {
			expect(() => snapshotBot(bot, { id: 'bot', ownerUserId: 'owner' })).toThrow();
		}
		expect(digest(createJournal(fixture().plan))).toMatch(/^[a-f0-9]{64}$/);
	});
});
