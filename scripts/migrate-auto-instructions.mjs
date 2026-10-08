import { readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { getPlatformProxy, unstable_readConfig } from 'wrangler';
import { accountId, repoRoot, assertCommit } from './release-support.mjs';
import { applyPlan, createJournal, digest, maximumBots, migrationKind, snapshotBot, validatePlan, verifySnapshot } from './instruction-language-migration.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
	environment: { type: 'string' }, commit: { type: 'string' }, plan: { type: 'string' }, journal: { type: 'string' },
	'bot-id': { type: 'string', multiple: true },
} });
const action = positionals[0];
if (positionals.length !== 1 || !['plan', 'apply', 'verify'].includes(action) || !['test', 'production'].includes(values.environment) || !values.plan) {
	throw new Error('Use plan, apply, or verify with --environment test|production --commit SHA --plan FILE. Apply also requires --journal FILE.');
}
assertCommit(values.commit);
if (action !== 'plan' && values['bot-id']) throw new Error('--bot-id is valid only when creating a plan.');
const config = unstable_readConfig({ config: join(repoRoot, 'workers/agent-runtime', values.environment === 'test' ? 'wrangler.jsonc' : 'wrangler.deploy.jsonc'), env: values.environment === 'test' ? 'test' : '' });
const kv = config.kv_namespaces.find(binding => binding.binding === 'BICKR_KV');
const db = config.d1_databases.find(binding => binding.binding === 'BICKR_D1');
const target = { environment: values.environment, accountId, namespaceId: kv.id, databaseId: db.database_id, service: config.name };
const proxyDirectory = mkdtempSync('/build/bickr/scratch/instruction-migration-');
const proxyConfig = join(proxyDirectory, 'wrangler.json');
// Remote bindings require the operator's Cloudflare account credentials. No public Worker URL is enabled.
writeFileSync(proxyConfig, JSON.stringify({ name: 'bickr-instruction-migration', account_id: accountId, compatibility_date: config.compatibility_date,
	kv_namespaces: [{ binding: 'KV', id: kv.id, remote: true }],
	d1_databases: [{ binding: 'DB', database_name: db.database_name, database_id: db.database_id, remote: true }],
	services: [{ binding: 'RUNTIME', service: config.name, remote: true }],
}), { mode: 0o600, flag: 'wx' });
let proxy;
try { proxy = await getPlatformProxy({ configPath: proxyConfig, persist: false });
	const planPath = resolve(values.plan);
	if (action === 'plan') {
		const bots = [];
		const requested = values['bot-id'] ? new Set(values['bot-id']) : null;
		let cursor = '';
		for (let page = 0; page <= maximumBots / 25; page++) {
			const rows = (await proxy.env.DB.prepare("SELECT bot_id AS id, owner_user_id AS ownerUserId, lifecycle_state AS lifecycle FROM bots_index WHERE bot_id > ? AND deleted_at IS NULL AND lifecycle_state IN ('active','pending') ORDER BY bot_id LIMIT 25").bind(cursor).all()).results;
			if (!rows.length) break;
			cursor = rows.at(-1).id;
			const selected = requested ? rows.filter(row => requested.has(row.id)) : rows;
			if (selected.some(row => row.lifecycle !== 'active')) throw new Error('A participant is pending creation. Wait for completion before capturing the plan.');
			const docs = await readDocuments(selected.map(row => row.id));
			bots.push(...selected.map(row => snapshotBot(docs.get(row.id), row)));
			if (page === maximumBots / 25 || bots.length > maximumBots) throw new Error('The census exceeded the participant limit.');
		}
		if (requested && bots.length !== requested.size) throw new Error('The census did not find every requested participant.');
		const plan = { kind: migrationKind, ...target, commit: values.commit, capturedAt: new Date().toISOString(), bots };
		validatePlan(plan, target, values.commit);
		writeFileSync(planPath, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
		console.log(JSON.stringify({ action, ...target, participants: bots.length, candidates: bots.filter(bot => bot.preference.kind === 'auto').length, planDigest: digest(plan) }));
	} else {
		const plan = JSON.parse(readFileSync(planPath, 'utf8'));
		validatePlan(plan, target, values.commit);
		if (action === 'apply') {
			if (!values.journal) throw new Error('Apply requires --journal FILE.');
			const journalPath = resolve(values.journal);
			const lockPath = journalPath + '.lock';
			const lock = openSync(lockPath, 'wx', 0o600);
			try {
				let journal;
				try { journal = JSON.parse(readFileSync(journalPath, 'utf8')); }
				catch (error) { if (error.code !== 'ENOENT') throw error; journal = createJournal(plan); }
				const save = async value => {
					writeFileSync(journalPath + '.new', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
					renameSync(journalPath + '.new', journalPath);
				};
				await save(journal);
				await applyPlan(plan, journal, async bot => {
					// The account-authenticated remote service proxy invokes the existing loopback-trusted route.
					// The owner coordinator serializes the revision comparison and write.
					const response = await proxy.env.RUNTIME.fetch(`http://localhost/users/${encodeURIComponent(bot.ownerUserId)}/bots/${encodeURIComponent(bot.id)}`, {
						method: 'PATCH', headers: { 'content-type': 'application/json', 'x-bickr-user-id': bot.ownerUserId, 'if-match': String(bot.revision) },
						body: JSON.stringify({ instructionLanguage: { kind: 'fixed', locale: 'en' } }),
					});
					if (!response.ok) throw new Error(`Migration stopped for ${bot.id}: HTTP ${response.status}. Keep the original plan and revision.`);
					const payload = await response.json();
					if (payload.ok !== true) throw new Error(`Migration failed for ${bot.id}.`);
					return { ...payload.data.bot, revision: payload.data.revision };
				}, save, async id => (await readDocuments([id])).get(id));
				console.log(JSON.stringify({ action, environment: values.environment, migrated: journal.applied.length, reconciled: journal.applied.filter(bot => bot.reconciled).map(bot => bot.id), planDigest: digest(plan) }));
			} finally { closeSync(lock); unlinkSync(lockPath); }
		} else {
			const documents = new Map();
			for (let offset = 0; offset < plan.bots.length; offset += 25) {
				for (const [id, bot] of await readDocuments(plan.bots.slice(offset, offset + 25).map(bot => bot.id))) documents.set(id, bot);
			}
			console.log(JSON.stringify({ action, environment: values.environment, ...verifySnapshot(plan, documents), planDigest: digest(plan) }));
		}
	}
} finally { try { await proxy?.dispose(); } finally { rmSync(proxyDirectory, { recursive: true, force: true }); } }
async function readDocuments(ids) {
	if (!ids.length) return new Map();
	const values = await proxy.env.KV.get(ids.map(id => `v1:bot:${id}`), { type: 'json', cacheTtl: 30 });
	return new Map(ids.map(id => [id, values.get(`v1:bot:${id}`)]));
}
