import { useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import { RichText, type OpenReference } from "../../components/content";
import { Confirm, FilterBox } from "../../ui";

type NoteLink = { kind: "participant" | "forum"; entityId: string; handle: string; deleted: boolean };
type Note = { id: string; content: string; createdAt: string; updatedAt: string; links: NoteLink[] };

export function BotNotesPanel({ botId, enabled, onReference, open, worldHandle }: {
	botId: string;
	enabled: boolean;
	onReference: OpenReference;
	open: boolean;
	worldHandle: string;
}) {
	const [ids, setIds] = useState<string[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [loading, setLoading] = useState(false);
	const [loadNonce, setLoadNonce] = useState(0);
	const [error, setError] = useState("");
	const [filter, setFilter] = useState("");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [note, setNote] = useState<Note | null>(null);
	const [noteLoading, setNoteLoading] = useState(false);
	const [noteError, setNoteError] = useState("");
	const [deleteConfirm, setDeleteConfirm] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const basePath = `/api/me/bots/${encodeURIComponent(botId)}/notes`;

	useEffect(() => {
		setIds([]);
		setLoaded(false);
		setSelectedId(null);
		setNote(null);
		setFilter("");
	}, [botId]);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setLoading(true);
		setError("");
		void api<{ ids: string[] }>(basePath).then((result) => {
			if (cancelled) return;
			if (result.ok) {
				setIds(result.data.ids);
				setSelectedId((current) => current && result.data.ids.includes(current) ? current : null);
				setLoaded(true);
			} else {
				setError(result.message);
			}
			setLoading(false);
		});
		return () => { cancelled = true; };
	}, [basePath, loadNonce, open]);

	useEffect(() => {
		if (!open || !selectedId) return;
		let cancelled = false;
		setNote(null);
		setNoteLoading(true);
		setNoteError("");
		void api<{ note: Note }>(`${basePath}/read`, { method: "POST", body: { id: selectedId } }).then((result) => {
			if (cancelled) return;
			if (result.ok) setNote(result.data.note);
			else setNoteError(result.message);
			setNoteLoading(false);
		});
		return () => { cancelled = true; };
	}, [basePath, open, selectedId]);

	const filteredIds = useMemo(() => ids.filter((id) => id.toLocaleLowerCase().includes(filter.toLocaleLowerCase())), [filter, ids]);
	const deleteSelected = async () => {
		if (!selectedId) return;
		setDeleting(true);
		const result = await api<{ deleted: string }>(`${basePath}/delete`, { method: "POST", body: { id: selectedId } });
		setDeleting(false);
		setDeleteConfirm(false);
		if (!result.ok) {
			setNoteError(result.message);
			return;
		}
		setIds((current) => current.filter((id) => id !== selectedId));
		setSelectedId(null);
		setNote(null);
	};

	return (
		<section className="profile-tab-panel" role="tabpanel">
			{!enabled && <p className="help">Note tools are disabled for this participant. Existing notes remain here.</p>}
			{loading && <p className="muted">Loading notes…</p>}
			{error && <p role="alert">{error} <button onClick={() => setLoadNonce((value) => value + 1)} type="button">Retry</button></p>}
			{loaded && (
				<>
					<div className="bot-notes-summary"><p className="muted">{ids.length} {ids.length === 1 ? "note" : "notes"}. Only you and this participant can see them.</p><button onClick={() => setLoadNonce((value) => value + 1)} type="button">Refresh</button></div>
					{ids.length === 0 ? <p>No notes yet. This participant can create notes during a visit.</p> : (
						<div className="bot-notes-layout">
							<div className="bot-notes-list">
								<FilterBox label="Search note IDs" onChange={setFilter} placeholder="Search note IDs" value={filter} />
								{filteredIds.length === 0 ? <p>No matching note IDs.</p> : filteredIds.map((id) => (
									<button aria-current={selectedId === id ? "true" : undefined} className={selectedId === id ? "selected" : ""} key={id} onClick={() => setSelectedId(id)} type="button">{id}</button>
								))}
							</div>
							<div className="bot-notes-detail">
								{!selectedId && <p>Select a note to read it.</p>}
								{selectedId && noteLoading && <p className="muted">Loading note…</p>}
								{selectedId && noteError && <p role="alert">{noteError}</p>}
								{note && (
									<>
										<div className="bot-notes-detail-head"><h3>{note.id}</h3><button className="btn danger" onClick={() => setDeleteConfirm(true)} type="button">Delete note</button></div>
										<div className="bot-notes-content"><RichText onReference={onReference} text={note.content} worldHandle={worldHandle} /></div>
										{note.links.length > 0 && <p className="muted">Linked to {note.links.map((link) => `${link.kind === "forum" ? "f" : "u"}/${link.handle}${link.deleted ? " (deleted)" : ""}`).join(", ")}</p>}
										<p className="muted">Updated {new Date(note.updatedAt).toLocaleString()}</p>
									</>
								)}
							</div>
						</div>
					)}
				</>
			)}
			<Confirm body={`Delete note ${selectedId ?? ""}? This cannot be undone.`} confirmText="Delete note" danger onClose={() => setDeleteConfirm(false)} onConfirm={() => void deleteSelected()} open={deleteConfirm && !deleting} title="Delete this note?" />
		</section>
	);
}
