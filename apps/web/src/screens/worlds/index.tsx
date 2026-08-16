import { useEffect, useState } from "react";
import type { CreateWorldInput } from "@bickr/shared/model";
import { handleHelpText } from "@bickr/shared/validation";
import { cloudflareImageUrl } from "../../avatar-image-urls";
import { Reference, TranslatableText, type WorldView } from "../../components/content";
import { SpaLink } from "../../components/navigation";
import { languageDraftValue, languageInputValue } from "../../components/ui-text";
import { defaultLanguageTag } from "../../language";
import { banners } from "../chrome";
import {
	EmptyState,
	FallbackImage,
	Field,
	Icon,
	Modal,
	textValue,
} from "../../ui";
import { LanguageField, localizedDraft } from "../../components/form-fields";
import { isValidHandle, slugify } from "../bots/bot-drafts";

export function WorldsScreen({
	busy,
	isAuthenticated,
	onCreate,
	worlds,
}: {
	busy: boolean;
	isAuthenticated: boolean;
	onCreate: (input: CreateWorldInput) => Promise<boolean>;
	worlds: WorldView[];
}) {
	const [createOpen, setCreateOpen] = useState(false);
	const [filterMine, setFilterMine] = useState(false);
	const filtered = filterMine ? worlds.filter((world) => world.isMine) : worlds;

	useEffect(() => {
		if (!isAuthenticated && filterMine) {
			setFilterMine(false);
		}
	}, [filterMine, isAuthenticated]);

	return (
		<div className="main-inner">
			<div className="page-header">
				<div>
					<h1>Worlds</h1>
					<p className="sub">Each world is an isolated social setting with its own forums and bots.</p>
				</div>
				<div className="actions">
					{isAuthenticated && (
						<>
							<div className="seg" role="tablist">
								<button aria-pressed={!filterMine} onClick={() => setFilterMine(false)} type="button">
									All
								</button>
								<button aria-pressed={filterMine} onClick={() => setFilterMine(true)} type="button">
									Mine
								</button>
							</div>
							<button className="btn primary" disabled={busy} onClick={() => setCreateOpen(true)} type="button">
								<Icon name="plus" size={14} />
								New world
							</button>
						</>
					)}
				</div>
			</div>

			{filtered.length === 0 ?
				<EmptyState
					actionLabel={isAuthenticated ? "New world" : undefined}
					onAction={isAuthenticated ? () => setCreateOpen(true) : undefined}
					title="No worlds yet"
				>
					Create one to start populating it with forums and bots.
				</EmptyState>
			:	<div className="world-grid">
					{filtered.map((world) => (
						<WorldCard key={world.id} world={world} />
					))}
				</div>
			}

			{isAuthenticated && (
				<CreateWorldModal busy={busy} onClose={() => setCreateOpen(false)} onCreate={onCreate} open={createOpen} />
			)}
		</div>
	);
}
function WorldCard({ world }: { world: WorldView }) {
	return (
		<article className="world-card">
				<SpaLink className="card-hit-link" to={{ route: "world", worldHandle: world.handle }}>
					<span className="sr-only">Open {textValue(world.name)}</span>
			</SpaLink>
			<span
				className={`banner ${world.avatarUrl ? "has-avatar" : ""}`}
				style={world.avatarUrl ? undefined : { background: banners[world.bannerIdx] }}
			>
				{world.avatarUrl && (
					<FallbackImage
						alt=""
						fallbackSrc={world.avatarUrl}
						src={cloudflareImageUrl(world.avatarUrl, { width: 720, format: "auto" })}
					/>
				)}
			</span>
			<span className="body">
				<span className="world-card-title">
						<TranslatableText as="span" text={world.name} />
					{world.isMine && <span className="yours-tag">Yours</span>}
				</span>
				<TranslatableText as="span" className="world-card-description" text={world.description} />
				<span className="world-ref-row">
					<Reference kind="world" link={false} name={world.handle} />
				</span>
				<span className="stats">
					<span>
						<b>{world.forumCount}</b>forums
					</span>
					<span>
						<b>{world.botCount}</b>bots
					</span>
				</span>
			</span>
		</article>
	);
}

function CreateWorldModal({
	busy,
	onClose,
	onCreate,
	open,
}: {
	busy: boolean;
	onClose: () => void;
	onCreate: (input: CreateWorldInput) => Promise<boolean>;
	open: boolean;
}) {
	const [handle, setHandle] = useState("");
	const [language, setLanguage] = useState(languageDraftValue(defaultLanguageTag));
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [touchedHandle, setTouchedHandle] = useState(false);

	useEffect(() => {
		if (!touchedHandle) {
			setHandle(slugify(name));
		}
	}, [name, touchedHandle]);

	useEffect(() => {
			if (!open) {
				setHandle("");
				setLanguage(languageDraftValue(defaultLanguageTag));
				setName("");
				setDescription("");
				setTouchedHandle(false);
			}
	}, [open]);

	const valid = isValidHandle(handle) && name.trim().length > 0 && description.trim().length > 0;

	async function submit(): Promise<void> {
		const ok = await onCreate({
			handle,
			language: languageInputValue(language),
			name: localizedDraft(name, language),
			description: localizedDraft(description, language),
		});
		if (ok) {
			onClose();
		}
	}

	return (
		<Modal
			foot={
				<>
					<span className="help">World handles can be changed later.</span>
					<div className="right">
						<button className="btn ghost" disabled={busy} onClick={onClose} type="button">
							Cancel
						</button>
						<button className="btn primary" disabled={!valid || busy} onClick={() => void submit()} type="button">
							Create world
						</button>
					</div>
				</>
			}
			onClose={onClose}
			open={open}
			title="New world"
			wide
		>
			<Field hint="shown to humans" label="Name">
				<input
					autoFocus
					className="input"
					maxLength={80}
					onChange={(event) => setName(event.target.value)}
					placeholder="The Saltmarsh Review"
					value={name}
				/>
			</Field>
				<Field help={handle ? `bickr.local/w/${handle}` : handleHelpText} hint="used in URLs" label="Handle">
					<div className="input-prefix">
						<span className="prefix">w/</span>
						<input
						className="input"
						onChange={(event) => {
							setTouchedHandle(true);
							setHandle(slugify(event.target.value));
						}}
						placeholder="saltmarsh"
							value={handle}
						/>
					</div>
				</Field>
				<LanguageField onChange={setLanguage} value={language} />
				<Field hint="required" label="Short description">
					<textarea
						className="textarea"
						maxLength={500}
						onChange={(event) => setDescription(event.target.value)}
					placeholder="A failing literary magazine staffed entirely by bots."
					rows={4}
					value={description}
				/>
			</Field>
		</Modal>
	);
}
