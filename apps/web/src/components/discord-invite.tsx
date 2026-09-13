import { useEffect, useRef, useState } from "react";
import { discordInviteUrl, type DiscordInviteState } from "@bickr/shared/discord-invite";
import { api } from "../api";
import { useUiText } from "./ui-text";

/** Mount with a user-ID key: pending responses must never cross account changes. */
export function DiscordInvite({ reportError }: { reportError: (message: string) => void }) {
	const t = useUiText().discordInvite;
	const dialog = useRef<HTMLDialogElement>(null);
	const saving = useRef(false);
	const [open, setOpen] = useState(false);
	useEffect(() => {
		const controller = new AbortController();
		void api<DiscordInviteState>("/api/me/discord-invite", { signal: controller.signal }).then(result => {
			if (!controller.signal.aborted && result.ok) setOpen(!result.data.dismissed);
		});
		return () => controller.abort();
	}, []);
	useEffect(() => {
		if (open) dialog.current?.showModal();
		else dialog.current?.close();
	}, [open]);
	async function dismiss() {
		if (saving.current) return;
		saving.current = true;
		// Close immediately so a network outage cannot trap the user in a modal.
		// Only the server acknowledgement suppresses it on subsequent visits.
		setOpen(false);
		const result = await api<DiscordInviteState>("/api/me/discord-invite", { method: "POST", timeoutMs: 15000 });
		if (!result.ok) reportError(t.saveError);
	}
	return <dialog ref={dialog} className="discord-invite modal" aria-labelledby="discord-invite-title"
		aria-describedby="discord-invite-body" onCancel={event => { event.preventDefault(); void dismiss(); }}
		onClick={event => { if (event.target === event.currentTarget) void dismiss(); }}>
		<div className="modal-head"><h2 id="discord-invite-title">{t.title}</h2>
			<button className="x" type="button" aria-label={t.dismiss} onClick={() => void dismiss()}>×</button></div>
		<div className="modal-body"><p id="discord-invite-body">{t.body}</p><p>{t.note}</p></div>
		<div className="modal-foot">
			<button type="button" className="btn" onClick={() => void dismiss()}>{t.dismiss}</button>
			<a className="btn" href={discordInviteUrl} target="_blank" rel="noopener noreferrer" onClick={() => void dismiss()}>{t.join}</a>
		</div>
	</dialog>;
}
