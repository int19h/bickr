import {
	accountExportContentSections, accountExportExclusions, accountExportFormatVersion, accountExportSections,
	type AccountExportOptions, type AccountExportImageReference,
	type AccountExportPage, type AccountExportSection,
} from "@bickr/shared/account-export";
import { api, apiResponseErrorMessage } from "./api";
import { Zip, ZipDeflate, ZipPassThrough } from "fflate";

type NoteExportPage = { records: object[]; nextCursor: string | null };
export type AccountExportProgress = { section: AccountExportSection | "images"; records: number };

/** Small server reads and serialized Blob parts avoid retaining a second full object graph. */
export async function createAccountExport(
	ownerUserId: string, options: AccountExportOptions, signal: AbortSignal, onProgress: (progress: AccountExportProgress) => void,
): Promise<Blob> {
	const startedAt = new Date().toISOString();
	const parts: BlobPart[] = [];
	let byteLength = 0;
	const counts: Partial<Record<AccountExportSection, number>> = {};
	const imageReferences: AccountExportImageReference[] = [];
	let zipFailure: Error | null = null;
	let zipComplete = false;
	const zip = new Zip((error, chunk, final) => {
		if (error) { zipFailure = error; return; }
		byteLength += chunk.byteLength;
		if (byteLength > 512 * 1024 * 1024) { zipFailure = new Error("This export exceeds Bickr's 512 MB archive limit. No file was downloaded."); return; }
		parts.push(new Uint8Array(chunk));
		zipComplete = final;
	});
	const json = new ZipDeflate("export.json", { level: 1 });
	zip.add(json);
	const append = (value: string) => {
		signal.throwIfAborted();
		const bytes = new TextEncoder().encode(value);
		json.push(bytes);
		if (zipFailure) throw zipFailure;
	};
	append(`{\n"application":"bickr","formatVersion":${accountExportFormatVersion},"ownerUserId":${JSON.stringify(ownerUserId)},"startedAt":${JSON.stringify(startedAt)},`);
	append(`\n"consistency":"Records are read over time, not as an atomic snapshot. Avoid edits during export.","excluded":${JSON.stringify(accountExportExclusions)},"options":${JSON.stringify(options)},\n"data":{`);
	const sections = accountExportSections.filter((section) => options.includeBotContent || !accountExportContentSections.includes(section));
	for (const section of sections) {
		let cursor: string | null = null;
		let count = 0;
		let separator = "";
		const seen = new Set<string>();
		append(`${section === accountExportSections[0] ? "" : ","}\n${JSON.stringify(section)}:[`);
		const addRecords = (records: object[]) => {
			for (const record of records) {
				append(`${separator}\n${JSON.stringify(record)}`);
				separator = ",";
				count++;
			}
			onProgress({ section, records: count });
		};
		onProgress({ section, records: 0 });
		do {
			signal.throwIfAborted();
			const query = new URLSearchParams({ ownerUserId, section });
			if (cursor) query.set("cursor", cursor);
			const response = await api<AccountExportPage>(`/api/me/export?${query}`, { signal });
			if (!response.ok) throw new Error(response.message);
			signal.throwIfAborted();
			const page = response.data;
			if (page.kind !== "account_export_page" || page.ownerUserId !== ownerUserId || page.section !== section) {
				throw new Error("The export response does not match this account. No file was downloaded.");
			}
			imageReferences.push(...page.imageReferences);
			if (section === "notes") {
				for (const record of page.records) {
					const botId = (record as { botId: string }).botId;
					let noteCursor: string | null = null;
					const seenNotes = new Set<string>();
					do {
						const noteQuery = new URLSearchParams({ ownerUserId, section, botId });
						if (noteCursor) noteQuery.set("cursor", noteCursor);
						const notes = await api<NoteExportPage>(`/api/me/export?${noteQuery}`, { signal });
						if (!notes.ok) throw new Error(notes.message);
						signal.throwIfAborted();
						addRecords(notes.data.records.map((note) => ({ botId, ...note })));
						noteCursor = nextCursor(notes.data.nextCursor, seenNotes);
					} while (noteCursor);
				}
			} else addRecords(page.records);
			cursor = nextCursor(page.nextCursor, seen);
		} while (cursor);
		counts[section] = count;
		append("\n]");
	}
	const imageManifest: (AccountExportImageReference & { archivePath: string })[] = [];
	append(`\n},"counts":${JSON.stringify(counts)}`);
	// Close the JSON entry before adding binary entries, so ZIP never buffers them behind unfinished JSON.
	// The image map is a separate JSON entry; export.json names it before this entry closes.
	append(`,"manifest":"manifest.json","dataCompletedAt":${JSON.stringify(new Date().toISOString())},"complete":true\n}\n`);
	json.push(new Uint8Array(), true);
	if (zipFailure) throw zipFailure;
	if (options.images === "files") {
		const byKey = new Map<string, string>();
		for (const reference of imageReferences) {
			signal.throwIfAborted();
			let archivePath = byKey.get(reference.key);
			if (!archivePath) {
				const query = new URLSearchParams({ ownerUserId, kind: reference.kind, entityId: reference.entityId, slot: reference.slot, expectedKey: reference.key });
				const response = await fetch(`/api/me/export/image?${query}`, { signal });
				if (!response.ok) throw new Error(await apiResponseErrorMessage(response));
				const contentType = response.headers.get("content-type");
				const extension = contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : contentType === "image/jpeg" ? "jpg" : null;
				if (!extension || !response.body) throw new Error("The export image response was invalid. No file was downloaded.");
				archivePath = `images/${String(byKey.size + 1).padStart(6, "0")}.${extension}`;
				const entry = new ZipPassThrough(archivePath);
				zip.add(entry);
				const reader = response.body.getReader();
				let imageBytes = 0;
				try {
					while (true) {
						signal.throwIfAborted();
						const chunk = await reader.read();
						if (chunk.done) break;
						imageBytes += chunk.value.byteLength;
						if (imageBytes > 10 * 1024 * 1024) throw new Error("A selected image exceeds Bickr's 10 MB image limit. No file was downloaded.");
						entry.push(chunk.value);
						if (zipFailure) throw zipFailure;
					}
					entry.push(new Uint8Array(), true);
				} finally { await reader.cancel(); }
				byKey.set(reference.key, archivePath);
			}
			imageManifest.push({ ...reference, archivePath });
			onProgress({ section: "images", records: imageManifest.length });
		}
	}
	const manifest = new ZipDeflate("manifest.json", { level: 1 });
	zip.add(manifest);
	manifest.push(new TextEncoder().encode(JSON.stringify({ application: "bickr", formatVersion: accountExportFormatVersion, ownerUserId, options, startedAt, completedAt: new Date().toISOString(), counts, references: imageReferences, files: imageManifest, complete: true })), true);
	zip.end();
	if (zipFailure) throw zipFailure;
	if (!zipComplete) throw new Error("The export archive did not finish. No file was downloaded.");
	signal.throwIfAborted();
	return new Blob(parts, { type: "application/zip" });
}
function nextCursor(value: string | null, seen: Set<string>): string | null {
	if (value === null) return null;
	if (!value || seen.has(value)) throw new Error("Export pagination did not advance. No file was downloaded.");
	seen.add(value);
	return value;
}

export function downloadAccountExport(blob: Blob): void {
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = `bickr-export-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;
	document.body.append(link);
	link.click();
	link.remove();
	// Leave enough time for browsers to start the download before releasing its bytes.
	setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
