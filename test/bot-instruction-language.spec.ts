import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { localizedText } from '@bickr/shared/model';
import { botById } from '@bickr/shared/repository';
import { parseLanguageTag } from '@bickr/shared/validation';
import { clearKv, resetD1Schema } from './helpers/d1-schema';
import { createBot, createWorld, deleteBot, unlinkBotClone, updateBot, upsertProviderUser } from './helpers/coordinator-mutations';

const language = parseLanguageTag('en');
beforeEach(async () => { await resetD1Schema(env.BICKR_D1); await clearKv(env.BICKR_KV); });

async function fixture() {
	const owner = await upsertProviderUser(env.BICKR_KV, env.BICKR_D1, { provider: 'github', subject: 'instruction-language', login: 'instruction-language' });
	const world = await createWorld(env.BICKR_KV, env.BICKR_D1, {
		handle: 'instruction-language', language, name: localizedText('Instructions', language), description: localizedText('Language fixture', language),
	}, owner.id);
	const source = await createBot(env.BICKR_KV, env.BICKR_D1, world.handle, {
		handle: 'source', language, displayName: localizedText('Source', language), shortBio: localizedText('Biography', language), prompt: localizedText('Authored persona', language),
		instructionLanguage: { kind: 'fixed', locale: 'ja' },
	}, owner.id);
	const clone = await createBot(env.BICKR_KV, env.BICKR_D1, world.handle, {
		handle: 'clone', language, displayName: localizedText('', language), shortBio: localizedText('', language), prompt: localizedText('', language), cloneSourceBotId: source.id,
	}, owner.id);
	return { owner, source, clone };
}

describe('stored participant instruction preferences', () => {
	it('deletes an inheriting clone with its resolved language in the response', async () => {
		const { owner, clone } = await fixture();
		await updateBot(env.BICKR_KV, env.BICKR_D1, clone.id, owner.id, { instructionLanguage: { kind: 'source' } });
		expect(await deleteBot(env.BICKR_KV, env.BICKR_D1, clone.id, owner.id)).toMatchObject({
			id: clone.id, instructionLocale: 'ja', instructionLanguage: { kind: 'source' }, prompt: { text: 'Authored persona' },
		});
		await expect(botById(env.BICKR_KV, env.BICKR_D1, clone.id)).rejects.toMatchObject({ code: 'not_found' });
	});

	it('keeps new clones on English and follows the current source only after an explicit selection', async () => {
		const { owner, source, clone } = await fixture();
		expect(await botById(env.BICKR_KV, env.BICKR_D1, source.id)).toMatchObject({ instructionLocale: 'ja', language: 'en' });
		expect(await botById(env.BICKR_KV, env.BICKR_D1, clone.id)).toMatchObject({ instructionLanguage: { kind: 'fixed', locale: 'en' }, instructionLocale: 'en' });
		await updateBot(env.BICKR_KV, env.BICKR_D1, clone.id, owner.id, { instructionLanguage: { kind: 'source' } });
		expect(await botById(env.BICKR_KV, env.BICKR_D1, clone.id)).toMatchObject({ instructionLocale: 'ja', cloneSource: { sourceBot: { instructionLocale: 'ja' } } });
		await updateBot(env.BICKR_KV, env.BICKR_D1, source.id, owner.id, { instructionLanguage: { kind: 'fixed', locale: 'ko' } });
		expect(await botById(env.BICKR_KV, env.BICKR_D1, clone.id)).toMatchObject({ instructionLocale: 'ko', language: 'en', prompt: { text: 'Authored persona' } });
	});

	it('keeps English fixed across primary-language changes but preserves an explicit Auto preference', async () => {
		const { owner, clone } = await fixture();
		await updateBot(env.BICKR_KV, env.BICKR_D1, clone.id, owner.id, { language: parseLanguageTag('ja') });
		expect(await botById(env.BICKR_KV, env.BICKR_D1, clone.id)).toMatchObject({ language: 'ja', instructionLanguage: { kind: 'fixed', locale: 'en' }, instructionLocale: 'en' });
		await updateBot(env.BICKR_KV, env.BICKR_D1, clone.id, owner.id, { instructionLanguage: { kind: 'auto' } });
		expect(await botById(env.BICKR_KV, env.BICKR_D1, clone.id)).toMatchObject({ instructionLanguage: { kind: 'auto' }, instructionLocale: 'ja' });
		await updateBot(env.BICKR_KV, env.BICKR_D1, clone.id, owner.id, { language: parseLanguageTag('ko') });
		expect(await botById(env.BICKR_KV, env.BICKR_D1, clone.id)).toMatchObject({ language: 'ko', instructionLanguage: { kind: 'auto' }, instructionLocale: 'ko' });
	});

	it('freezes inherited instructions when a clone detaches', async () => {
		const { owner, source, clone } = await fixture();
		await updateBot(env.BICKR_KV, env.BICKR_D1, clone.id, owner.id, { instructionLanguage: { kind: 'source' } });
		await unlinkBotClone(env.BICKR_KV, env.BICKR_D1, clone.id, owner.id);
		expect(await botById(env.BICKR_KV, env.BICKR_D1, clone.id)).toMatchObject({ instructionLanguage: { kind: 'fixed', locale: 'ja' }, instructionLocale: 'ja', cloneSource: { linked: false } });
		await updateBot(env.BICKR_KV, env.BICKR_D1, source.id, owner.id, { instructionLanguage: { kind: 'fixed', locale: 'fr' } });
		expect(await botById(env.BICKR_KV, env.BICKR_D1, clone.id)).toMatchObject({ instructionLocale: 'ja', prompt: { text: 'Authored persona' } });
	});

	it('rejects source inheritance on a standalone participant before writing data', async () => {
		const { owner, source } = await fixture();
		await expect(updateBot(env.BICKR_KV, env.BICKR_D1, source.id, owner.id, { instructionLanguage: { kind: 'source' } })).rejects.toMatchObject({ code: 'bad_request' });
		expect(await botById(env.BICKR_KV, env.BICKR_D1, source.id)).toMatchObject({ instructionLanguage: { kind: 'fixed', locale: 'ja' }, instructionLocale: 'ja' });
	});
});
