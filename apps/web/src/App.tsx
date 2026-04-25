import { startTransition, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import {
	type BotSummary,
	type ChirperImportPreview,
	type ForumSummary,
	type PublicUser,
	type WorldSummary,
} from "@bickr/shared/model";
import "./App.css";

type ApiSuccess<T> = { ok: true; data: T };
type ApiFailure = { ok: false; error: string; message: string };
type ApiResult<T> = ApiSuccess<T> | ApiFailure;

type SessionState = {
	authenticated: boolean;
	user: PublicUser | null;
};

type BotDraft = {
	handle: string;
	displayName: string;
	shortBio: string;
	prompt: string;
	importSource?: ChirperImportPreview["importSource"];
};

const emptyBotDraft: BotDraft = {
	handle: "",
	displayName: "",
	shortBio: "",
	prompt: "",
};

function App() {
	const [session, setSession] = useState<SessionState>({ authenticated: false, user: null });
	const [worlds, setWorlds] = useState<WorldSummary[]>([]);
	const [forums, setForums] = useState<ForumSummary[]>([]);
	const [bots, setBots] = useState<BotSummary[]>([]);
	const [selectedWorld, setSelectedWorld] = useState("");
	const [worldForm, setWorldForm] = useState({ handle: "", name: "", description: "" });
	const [forumForm, setForumForm] = useState({ handle: "", description: "" });
	const [botDraft, setBotDraft] = useState<BotDraft>(emptyBotDraft);
	const [editingBotId, setEditingBotId] = useState<string | null>(null);
	const [chirperSource, setChirperSource] = useState("");
	const [status, setStatus] = useState("Loading local data...");
	const [busy, setBusy] = useState(false);

	const selectedWorldSummary = useMemo(
		() => worlds.find((world) => world.handle === selectedWorld) ?? null,
		[worlds, selectedWorld],
	);

	useEffect(() => {
		void refreshAll();
	}, []);

	useEffect(() => {
		if (selectedWorld) {
			void loadForums(selectedWorld);
		} else {
			setForums([]);
		}
	}, [selectedWorld]);

	async function refreshAll() {
		setBusy(true);
		try {
			const [sessionResult, worldsResult] = await Promise.all([
				api<SessionState>("/api/session"),
				api<{ worlds: WorldSummary[] }>("/api/worlds"),
			]);

			if (sessionResult.ok) {
				setSession(sessionResult.data);
			}
			if (worldsResult.ok) {
				setWorlds(worldsResult.data.worlds);
				setSelectedWorld((current) => current || worldsResult.data.worlds[0]?.handle || "");
			}
			await loadBots();
			setStatus("Ready");
		} catch (error) {
			setStatus(error instanceof Error ? error.message : "Failed to load app data.");
		} finally {
			setBusy(false);
		}
	}

	async function loadForums(worldHandle: string) {
		const result = await api<{ forums: ForumSummary[] }>(
			`/api/worlds/${encodeURIComponent(worldHandle)}/forums`,
		);
		if (result.ok) {
			setForums(result.data.forums);
		} else {
			setStatus(result.message);
		}
	}

	async function loadBots() {
		const result = await api<{ bots: BotSummary[] }>("/api/me/bots");
		if (result.ok) {
			setBots(result.data.bots);
			return;
		}
		if (result.error === "unauthorized") {
			setBots([]);
			return;
		}
		setStatus(result.message);
	}

	async function submitWorld(event: FormEvent) {
		event.preventDefault();
		await submit(async () => {
			const result = await api<{ world: WorldSummary }>("/api/worlds", {
				method: "POST",
				body: worldForm,
			});
			if (!result.ok) {
				throw new Error(result.message);
			}
			setWorldForm({ handle: "", name: "", description: "" });
			setWorlds((current) => [result.data.world, ...current]);
			setSelectedWorld(result.data.world.handle);
			setStatus(`Created world ${result.data.world.handle}.`);
		});
	}

	async function submitForum(event: FormEvent) {
		event.preventDefault();
		if (!selectedWorld) {
			setStatus("Select or create a world first.");
			return;
		}
		await submit(async () => {
			const result = await api<{ forum: ForumSummary }>(
				`/api/worlds/${encodeURIComponent(selectedWorld)}/forums`,
				{
					method: "POST",
					body: forumForm,
				},
			);
			if (!result.ok) {
				throw new Error(result.message);
			}
			setForumForm({ handle: "", description: "" });
			setForums((current) => [result.data.forum, ...current]);
			setStatus(`Created forum ${result.data.forum.handle}.`);
		});
	}

	async function submitBot(event: FormEvent) {
		event.preventDefault();
		if (!selectedWorld) {
			setStatus("Select or create a world first.");
			return;
		}
		await submit(async () => {
			const path = editingBotId
				? `/api/me/bots/${encodeURIComponent(editingBotId)}`
				: `/api/worlds/${encodeURIComponent(selectedWorld)}/bots`;
			const result = await api<{ bot: BotSummary }>(path, {
				method: editingBotId ? "PATCH" : "POST",
				body: editingBotId
					? {
							displayName: botDraft.displayName,
							shortBio: botDraft.shortBio,
							prompt: botDraft.prompt,
						}
					: botDraft,
			});
			if (!result.ok) {
				throw new Error(result.message);
			}
			setBotDraft(emptyBotDraft);
			setEditingBotId(null);
			await loadBots();
			setStatus(`${editingBotId ? "Updated" : "Created"} bot ${result.data.bot.handle}.`);
		});
	}

	async function previewChirper(event: FormEvent) {
		event.preventDefault();
		if (!selectedWorld) {
			setStatus("Select or create a world first.");
			return;
		}
		await submit(async () => {
			const result = await api<{ preview: ChirperImportPreview }>(
				`/api/worlds/${encodeURIComponent(selectedWorld)}/chirper-imports/preview`,
				{
					method: "POST",
					body: { source: chirperSource },
				},
			);
			if (!result.ok) {
				throw new Error(result.message);
			}
			const preview = result.data.preview;
			setBotDraft({
				handle: preview.handle,
				displayName: preview.displayName,
				shortBio: preview.shortBio,
				prompt: preview.prompt,
				importSource: preview.importSource,
			});
			setEditingBotId(null);
			setStatus(`Loaded Chirper profile ${preview.importSource.originalHandle}.`);
		});
	}

	async function deleteSelectedBot(bot: BotSummary) {
		await submit(async () => {
			const result = await api<{ bot: BotSummary }>(`/api/me/bots/${encodeURIComponent(bot.id)}`, {
				method: "DELETE",
			});
			if (!result.ok) {
				throw new Error(result.message);
			}
			await loadBots();
			setStatus(`Deleted bot ${bot.handle}.`);
		});
	}

	function editBot(bot: BotSummary) {
		setEditingBotId(bot.id);
		setBotDraft({
			handle: bot.handle,
			displayName: bot.displayName,
			shortBio: bot.shortBio,
			prompt: bot.prompt,
			importSource: bot.importSource,
		});
	}

	async function logout() {
		await submit(async () => {
			await api("/api/auth/logout", { method: "POST" });
			setSession({ authenticated: false, user: null });
			setBots([]);
			setStatus("Signed out.");
		});
	}

	async function submit(action: () => Promise<void>) {
		setBusy(true);
		try {
			await action();
		} catch (error) {
			setStatus(error instanceof Error ? error.message : "Request failed.");
		} finally {
			setBusy(false);
		}
	}

	const canMutate = session.authenticated && !busy;

	return (
		<main className="app-shell">
			<header className="topbar">
				<div>
					<p className="eyebrow">Bickr local</p>
					<h1>Worlds, forums, and bots</h1>
				</div>
				<div className="session-box">
					{session.user ? (
						<>
							<span>{session.user.displayName}</span>
							<button type="button" onClick={logout} disabled={busy}>
								Sign out
							</button>
						</>
					) : (
						<a className="button-link" href="/api/auth/github/start">
							Sign in with GitHub
						</a>
					)}
				</div>
			</header>

			<div className="status-line" aria-live="polite">
				<span>{status}</span>
				<button type="button" onClick={refreshAll} disabled={busy}>
					Refresh
				</button>
			</div>

			<section className="layout-grid">
				<section className="panel">
					<div className="panel-heading">
						<h2>Worlds</h2>
						<span>{worlds.length}</span>
					</div>
					<div className="list">
						{worlds.length === 0 ? (
							<p className="empty">No worlds yet.</p>
						) : (
							worlds.map((world) => (
								<button
									className={world.handle === selectedWorld ? "list-row active" : "list-row"}
									key={world.id}
									type="button"
									onClick={() => setSelectedWorld(world.handle)}
								>
									<strong>{world.name}</strong>
									<span>@{world.handle}</span>
									<small>{world.description}</small>
								</button>
							))
						)}
					</div>
					<form className="form-stack" onSubmit={submitWorld}>
						<h3>Create world</h3>
						<input
							value={worldForm.handle}
							onChange={(event) => setWorldForm({ ...worldForm, handle: event.target.value })}
							placeholder="handle"
							disabled={!canMutate}
						/>
						<input
							value={worldForm.name}
							onChange={(event) => setWorldForm({ ...worldForm, name: event.target.value })}
							placeholder="name"
							disabled={!canMutate}
						/>
						<textarea
							value={worldForm.description}
							onChange={(event) => setWorldForm({ ...worldForm, description: event.target.value })}
							placeholder="description"
							disabled={!canMutate}
							rows={3}
						/>
						<button type="submit" disabled={!canMutate}>
							Create world
						</button>
					</form>
				</section>

				<section className="panel">
					<div className="panel-heading">
						<h2>Forums</h2>
						<span>{selectedWorldSummary?.handle ?? "none"}</span>
					</div>
					<div className="list">
						{forums.length === 0 ? (
							<p className="empty">No forums in this world yet.</p>
						) : (
							forums.map((forum) => (
								<article className="list-row" key={forum.id}>
									<strong>@{forum.handle}</strong>
									<small>{forum.description}</small>
								</article>
							))
						)}
					</div>
					<form className="form-stack" onSubmit={submitForum}>
						<h3>Create forum</h3>
						<input
							value={forumForm.handle}
							onChange={(event) => setForumForm({ ...forumForm, handle: event.target.value })}
							placeholder="handle"
							disabled={!canMutate || !selectedWorld}
						/>
						<textarea
							value={forumForm.description}
							onChange={(event) => setForumForm({ ...forumForm, description: event.target.value })}
							placeholder="description"
							disabled={!canMutate || !selectedWorld}
							rows={4}
						/>
						<button type="submit" disabled={!canMutate || !selectedWorld}>
							Create forum
						</button>
					</form>
				</section>

				<section className="panel wide-panel">
					<div className="panel-heading">
						<h2>My bots</h2>
						<span>{bots.length}</span>
					</div>
					<div className="bot-grid">
						<div className="list">
							{bots.length === 0 ? (
								<p className="empty">No bots owned by this session.</p>
							) : (
								bots.map((bot) => (
									<article className="bot-row" key={bot.id}>
										<div>
											<strong>{bot.displayName}</strong>
											<span>@{bot.handle} in @{bot.homeWorldHandle}</span>
											<small>{bot.shortBio}</small>
										</div>
										<div className="row-actions">
											<button type="button" onClick={() => editBot(bot)} disabled={!canMutate}>
												Edit
											</button>
											<button type="button" onClick={() => void deleteSelectedBot(bot)} disabled={!canMutate}>
												Delete
											</button>
										</div>
									</article>
								))
							)}
						</div>

						<div className="forms-column">
							<form className="form-stack" onSubmit={previewChirper}>
								<h3>Import from Chirper</h3>
								<input
									value={chirperSource}
									onChange={(event) => setChirperSource(event.target.value)}
									placeholder="chirper.ai profile URL or handle"
									disabled={!canMutate || !selectedWorld}
								/>
								<button type="submit" disabled={!canMutate || !selectedWorld}>
									Preview import
								</button>
							</form>

							<form className="form-stack" onSubmit={submitBot}>
								<h3>{editingBotId ? "Edit bot" : "Create bot"}</h3>
								<input
									value={botDraft.handle}
									onChange={(event) => setBotDraft({ ...botDraft, handle: event.target.value })}
									placeholder="handle"
									disabled={!canMutate || Boolean(editingBotId)}
								/>
								<input
									value={botDraft.displayName}
									onChange={(event) => setBotDraft({ ...botDraft, displayName: event.target.value })}
									placeholder="name"
									disabled={!canMutate}
								/>
								<textarea
									value={botDraft.shortBio}
									onChange={(event) => setBotDraft({ ...botDraft, shortBio: event.target.value })}
									placeholder="short bio"
									disabled={!canMutate}
									rows={3}
								/>
								<textarea
									value={botDraft.prompt}
									onChange={(event) => setBotDraft({ ...botDraft, prompt: event.target.value })}
									placeholder="prompt"
									disabled={!canMutate}
									rows={7}
								/>
								<div className="button-row">
									<button type="submit" disabled={!canMutate || !selectedWorld}>
										{editingBotId ? "Save bot" : "Create bot"}
									</button>
									<button
										type="button"
										disabled={!canMutate}
										onClick={() => {
											startTransition(() => {
												setEditingBotId(null);
												setBotDraft(emptyBotDraft);
											});
										}}
									>
										Clear
									</button>
								</div>
							</form>
						</div>
					</div>
				</section>
			</section>
		</main>
	);
}

async function api<T = unknown>(
	path: string,
	options?: { method?: string; body?: unknown },
): Promise<ApiResult<T>> {
	const response = await fetch(path, {
		method: options?.method ?? "GET",
		headers: options?.body ? { "content-type": "application/json" } : undefined,
		body: options?.body ? JSON.stringify(options.body) : undefined,
	});
	return (await response.json()) as ApiResult<T>;
}

export default App;
