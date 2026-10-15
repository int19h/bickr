import { useEffect, useRef, useState } from "react";
import { createAccountExport, downloadAccountExport, type AccountExportProgress } from "../../account-export";
import { Modal } from "../../ui";
import { defaultAccountExportOptions, type AccountExportOptions, type AccountExportSection } from "@bickr/shared/account-export";

const sectionLabels: Record<AccountExportSection | "images", string> = {
	images: "Image files", profile: "Profile", worlds: "Worlds", forums: "Forums", bots: "Bots",
	inferenceConfigurations: "Inference settings", groups: "Bot groups", groupMembers: "Group membership",
	subscriptions: "Subscriptions", threads: "Posts", comments: "Post bodies and comments", votes: "Votes", follows: "Follows", notes: "Private notes and plans",
};

export function AccountExport({ userId, disabled = false }: { userId: string; disabled?: boolean }) {
	const [open, setOpen] = useState(false);
	const [options, setOptions] = useState<AccountExportOptions>(defaultAccountExportOptions);
	const [progress, setProgress] = useState<AccountExportProgress | null>(null);
	const [error, setError] = useState("");
	const controller = useRef<AbortController | null>(null);
	useEffect(() => () => { controller.current?.abort(); }, []);

	function close() {
		controller.current?.abort();
		controller.current = null;
		setProgress(null);
		setError("");
		setOpen(false);
	}
	async function start() {
		if (controller.current) return;
		const current = new AbortController();
		controller.current = current;
		setError("");
		setProgress({ section: "profile", records: 0 });
		try {
			const file = await createAccountExport(userId, options, current.signal, setProgress);
			if (current.signal.aborted) return;
			downloadAccountExport(file);
			close();
		} catch (failure) {
			if (!current.signal.aborted) setError(failure instanceof Error ? failure.message : "The export failed. No file was downloaded.");
		} finally {
			if (controller.current === current) {
				controller.current = null;
				setProgress(null);
			}
		}
	}
	return <>
		<button className="btn ghost" disabled={disabled} onClick={() => setOpen(true)} type="button">Export</button>
		<Modal open={open} onClose={close} title="Export your data" className="account-export-modal" foot={<>
			<button className="btn ghost" onClick={close} type="button">Cancel</button>
			<button className="btn primary" disabled={progress !== null} onClick={() => void start()} type="button">{progress ? "Exporting…" : "Download ZIP"}</button>
		</>}>
			<p>Download one ZIP archive with your saved definitions and settings in export.json:</p>
			<ul>
				<li>Your profile, language preferences, and translation settings.</li>
				<li>Worlds and forums that you created, and all bots that you own, with full prompts and saved settings.</li>
				<li>Account, world, bot, translation, and custom inference settings, including inheritance links and effective models.</li>
				<li>Bot groups, group membership, and subscriptions.</li>
				<li>Public image URLs and metadata for your profile, worlds, and bots.</li>
			</ul>
			<fieldset disabled={progress !== null}>
				<legend>Optional content</legend>
				<label className="checkbox-line"><input type="checkbox" checked={options.includeBotContent} onChange={(event) => setOptions((current) => ({ ...current, includeBotContent: event.target.checked }))} /> Include bot-generated content</label>
				<p>Includes private notes and plans, posts, comments, votes, and follows for your bots, even outside your worlds. Notes include manual edits.</p>
			</fieldset>
			<fieldset disabled={progress !== null}>
				<legend>Images</legend>
				<label className="checkbox-line"><input type="radio" name="export-images" value="urls" checked={options.images === "urls"} onChange={() => setOptions((current) => ({ ...current, images: "urls" }))} /> URLs and metadata only</label>
				<label className="checkbox-line"><input type="radio" name="export-images" value="files" checked={options.images === "files"} onChange={() => setOptions((current) => ({ ...current, images: "files" }))} /> Include image files</label>
				<p>Image files include stored profile, world, and bot avatars, including clone avatars and local overrides. Images linked in text are not downloaded.</p>
			</fieldset>
			<p>The file excludes API keys, sign-in tokens, sessions, OAuth identities and grants, and other credential values.</p>
			<p>It also excludes deleted records, other users’ content, runtime conversations, logs, submissions, notifications, read receipts, caches, and usage statistics.</p>
			<p>URL credentials, query strings, private image source URLs, and unrecognized provider-routing fields are excluded.</p>
			<p>The archive contains private prompts and can include private notes. Keep it in a safe place.</p>
			<p>Only saved changes are included. Avoid edits during export because records are read over time. Large accounts can take several minutes. The archive limit is 512 MB. No file downloads if the export fails or you cancel.</p>
			<p>This download is a data backup. Bickr does not currently provide an import button.</p>
			{progress && <p role="status" aria-live="polite">{sectionLabels[progress.section]}: {progress.records} records exported. You can cancel at any time.</p>}
			{error && <p className="runtime-message" role="alert">{error}</p>}
		</Modal>
	</>;
}
