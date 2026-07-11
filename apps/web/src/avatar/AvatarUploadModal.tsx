import { useEffect, useState } from "react";
import type { BotSummary } from "@bickr/shared/model";

import { api } from "../api";
import { Field, Modal } from "../ui";
import { runApiAction } from "../use-api";
import type { AvatarTarget } from "./target";

function throwApiError(message: string): never {
	throw new Error(message);
}

export function AvatarUploadModal<TMutationResponse, TSaved>({
	onClose,
	onSaved,
	open,
	target,
}: {
	onClose: () => void;
	onSaved: (saved: TSaved, affectedBots?: BotSummary[]) => void;
	open: boolean;
	target: AvatarTarget<TMutationResponse, TSaved>;
}) {
	const [url, setUrl] = useState("");
	const [file, setFile] = useState<File | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");

	useEffect(() => {
		if (!open) {
			setUrl("");
			setFile(null);
			setSaving(false);
			setError("");
		}
	}, [open]);

	async function submitAvatar(): Promise<void> {
		setSaving(true);
		setError("");
		try {
			const body =
				file ?
					(() => {
						const form = new FormData();
						form.set("file", file);
						return form;
					})()
				:	{ url: url.trim() };
			const result = await runApiAction(throwApiError, () => api<TMutationResponse>(target.endpoints.upload, {
				method: "PUT",
				body,
			}));
			const saved = target.readSaved(result.data);
			onSaved(saved.saved, saved.affectedBots);
			onClose();
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : "Could not save avatar.");
		} finally {
			setSaving(false);
		}
	}

	const urlFilled = Boolean(url.trim());
	const fileFilled = Boolean(file);
	const canSubmit = urlFilled !== fileFilled;
	return (
		<Modal
			foot={
				<>
					<span />
					<div className="right">
						<button className="btn ghost" disabled={saving} onClick={onClose} type="button">
							Cancel
						</button>
						<button className="btn primary" disabled={!canSubmit || saving} onClick={() => void submitAvatar()} type="button">
							{saving ? "Saving..." : "Save avatar"}
						</button>
					</div>
				</>
			}
			onClose={onClose}
			open={open}
			title="Upload Avatar"
		>
			<Field label="Image URL">
				<input
					className="input"
					disabled={fileFilled || saving}
					onChange={(event) => setUrl(event.target.value)}
					placeholder="https://example.com/avatar.png"
					value={url}
				/>
			</Field>
			<div className="modal-or-line">
				<span>or</span>
			</div>
			<Field label="Image file">
				<input
					accept="image/jpeg,image/png,image/webp,image/svg+xml"
					className="input"
					disabled={urlFilled || saving}
					onChange={(event) => setFile(event.target.files?.[0] ?? null)}
					type="file"
				/>
			</Field>
			{error && <div className="runtime-message error">{error}</div>}
		</Modal>
	);
}
