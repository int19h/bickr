import type {
	ForumSummary,
	UpdateForumInput,
} from "@bickr/shared/model";
import { effectiveThreadSettings } from "@bickr/shared/thread-policy";
import { useCallback, useContext, useEffect, useState } from "react";
import { ForumReadOnlyBadge, Reference, TranslatableText, type WorldView } from "../../components/content";
import {
	LanguageField,
	RenameHandleModal,
	localizedDraft,
	textLang,
} from "../../components/form-fields";
import { SpaLink } from "../../components/navigation";
import {
	languageDraftValue,
	languageInputValue,
} from "../../components/ui-text";
import { defaultLanguageTag } from "../../language";
import {
	Field,
	Icon,
	Modal,
	ToastContext,
	textValue,
} from "../../ui";
import { parseOptionalPositiveInteger } from "../../components/record-display";
import { optionalNumberDraftValue } from "../bots/bot-drafts";

export function EditForumModal({
	busy,
	forum,
	onClose,
	onSave,
	world,
}: {
	busy: boolean;
	forum: ForumSummary | null;
	onClose: () => void;
	onSave: (forum: ForumSummary, input: UpdateForumInput) => Promise<boolean>;
	world: WorldView;
}) {
		const [language, setLanguage] = useState(languageDraftValue(defaultLanguageTag));
		const [description, setDescription] = useState("");
	const [threadCommentLimit, setThreadCommentLimit] = useState("");
	const [readOnly, setReadOnly] = useState(false);
	const [renameOpen, setRenameOpen] = useState(false);
	const toast = useContext(ToastContext);
	const closeEditModal = useCallback(() => {
		if (renameOpen) {
			setRenameOpen(false);
			return;
		}
		onClose();
	}, [onClose, renameOpen]);

		useEffect(() => {
			if (forum) {
				setLanguage(languageDraftValue(forum.language, textLang(forum.description) ?? defaultLanguageTag));
				setDescription(textValue(forum.description));
				setThreadCommentLimit(optionalNumberDraftValue(forum.threadSettings?.commentLimit));
				setReadOnly(forum.readOnly);
				setRenameOpen(false);
			}
		}, [forum]);

	if (!forum) {
		return null;
	}
		const activeForum = forum;

		const valid = description.trim().length > 0;
		const threadCommentLimitValue = parseOptionalPositiveInteger(threadCommentLimit);
		const inheritedCommentLimit = effectiveThreadSettings(world.threadSettings, undefined).commentLimit;
		const settingsValid = threadCommentLimitValue === null ||
			(threadCommentLimitValue >= 1 && threadCommentLimitValue <= inheritedCommentLimit);
		const savedLanguage = languageInputValue(language);
		const dirty = savedLanguage !== activeForum.language ||
			description !== textValue(activeForum.description) ||
			threadCommentLimitValue !== (activeForum.threadSettings?.commentLimit ?? null) ||
			readOnly !== activeForum.readOnly;

		async function submit(): Promise<void> {
			const ok = await onSave(activeForum, {
				language: savedLanguage,
				description: localizedDraft(description, language),
				threadSettings: { commentLimit: threadCommentLimitValue },
				readOnly,
			});
		if (ok) {
			toast.push(
				<>
					Saved <Reference kind="forum" name={activeForum.handle} />
				</>,
			);
			onClose();
		}
	}

	return (
		<Modal
			foot={
				<>
					<span className="help">Use Change to rename this forum.</span>
					<div className="right">
						<button className="btn ghost" disabled={busy} onClick={closeEditModal} type="button">
							Cancel
						</button>
						<button className="btn primary" disabled={!dirty || !valid || !settingsValid || busy} onClick={() => void submit()} type="button">
							Save changes
						</button>
					</div>
				</>
			}
			onClose={closeEditModal}
			open={Boolean(forum)}
			title="Edit forum"
		>
			<Field help={`bickr.local/w/${activeForum.worldHandle}/f/${activeForum.handle}`} label="Handle">
				<div className="inline-controls">
					<div className="input-prefix input-prefix-grow">
						<span className="prefix">f/</span>
						<input className="input" disabled value={activeForum.handle} />
					</div>
					<button className="btn" disabled={busy} onClick={() => setRenameOpen(true)} type="button">
						Change
					</button>
				</div>
			</Field>
				<Field hint="required" label="Short description">
					<textarea
					autoFocus
					className="textarea"
					maxLength={500}
					onChange={(event) => setDescription(event.target.value)}
					rows={4}
						value={description}
					/>
				</Field>
				<LanguageField onChange={setLanguage} value={language} />
				<Field help="Blank inherits the world limit. The smaller world or forum limit wins." label="Thread comment limit">
					<div className="input-suffix">
						<input className="input" min={1} max={inheritedCommentLimit} onChange={(event) => setThreadCommentLimit(event.target.value)} placeholder={String(inheritedCommentLimit)} step={1} type="number" value={threadCommentLimit} />
						<span className="suffix">comments</span>
					</div>
				</Field>
				<Field help="Existing threads and comments stay readable and votes still count. Uncheck to accept new content again." label="Posting">
					<label className="checkbox-line">
						<input
							checked={readOnly}
							onChange={(event) => setReadOnly(event.target.checked)}
							type="checkbox"
						/>
						<span>Read-only: accept no new threads or replies</span>
					</label>
				</Field>
				<RenameHandleModal
				busy={busy}
				kind="forum"
				routeHelp={(handle) => `bickr.local/w/${activeForum.worldHandle}/f/${handle}`}
				onClose={() => setRenameOpen(false)}
				onSave={async (handle) => {
					const ok = await onSave(activeForum, { handle });
					if (ok) {
						toast.push(
							<>
								Renamed <Reference kind="forum" name={handle} />
							</>,
						);
						setRenameOpen(false);
						onClose();
					}
					return ok;
				}}
				open={renameOpen}
				oldHandle={activeForum.handle}
				warning={
					<>
						Existing comments and descriptions of other forums and bots that mention <b>f/{activeForum.handle}</b> will
						not be updated. Those references will continue to show <b>f/{activeForum.handle}</b> after this forum is
						renamed.
					</>
				}
			/>
		</Modal>
	);
}
export function ForumRow({
	forum,
	onDelete,
	onEdit,
}: {
	forum: ForumSummary;
	onDelete?: () => void;
	onEdit?: () => void;
}) {
	return (
		<article className="forum-row">
			<SpaLink
				className="card-hit-link"
				title={`Open f/${forum.handle}`}
				to={{ route: "forum", worldHandle: forum.worldHandle, forumHandle: forum.handle }}
			>
				<span className="sr-only">Open f/{forum.handle}</span>
			</SpaLink>
			<div className="forum-row-main">
				<div className="glyph">{(forum.handle[0] ?? "?").toUpperCase()}</div>
				<div>
					<div className="name">
						<Reference kind="forum" name={forum.handle} />
						{forum.personalBotId && <span className="bot-badge">personal</span>}
						<ForumReadOnlyBadge forum={forum} />
					</div>
					<TranslatableText as="div" className="desc" text={forum.description} />
				</div>
				<div className="stats">
					{onEdit && (
						<button className="icon-btn" onClick={onEdit} title="Edit forum" type="button">
							<Icon name="edit" size={14} />
						</button>
					)}
					{onDelete && (
						<button className="icon-btn danger" onClick={onDelete} title="Delete forum" type="button">
							<Icon name="trash" size={14} />
						</button>
					)}
					<SpaLink
						className="btn ghost compact"
						to={{ route: "forum", worldHandle: forum.worldHandle, forumHandle: forum.handle }}
					>
						Open
					</SpaLink>
				</div>
			</div>
		</article>
	);
}
