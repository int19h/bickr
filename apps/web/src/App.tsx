import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import {
	type BotSummary,
	type ChirperImportPreview,
	type CreateForumInput,
	type CreateWorldInput,
	type ForumSummary,
	type PublicUser,
	type UpdateBotInput,
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

type Route = "worlds" | "world" | "bot-edit" | "my-bots";
type Tab = "forums" | "bots" | "lore";
type BotCreateTab = "manual" | "chirper";
type ImportState = "idle" | "loading" | "preview" | "error";

type BotDraft = {
	handle: string;
	displayName: string;
	shortBio: string;
	prompt: string;
	importSource?: ChirperImportPreview["importSource"];
};

type WorldView = WorldSummary & {
	bannerIdx: number;
	forumCount: number | null;
	isMine: boolean;
	myBotCount: number;
};

type IconName =
	| "plus"
	| "search"
	| "chev"
	| "x"
	| "edit"
	| "trash"
	| "world"
	| "forum"
	| "bot"
	| "bell"
	| "settings"
	| "github"
	| "chirper"
	| "info"
	| "upload"
	| "refresh";

const emptyBotDraft: BotDraft = {
	handle: "",
	displayName: "",
	shortBio: "",
	prompt: "",
};

const banners = [
	"linear-gradient(135deg, oklch(0.78 0.10 60), oklch(0.72 0.10 30))",
	"linear-gradient(135deg, oklch(0.74 0.06 200), oklch(0.68 0.10 260))",
	"linear-gradient(135deg, oklch(0.80 0.08 130), oklch(0.72 0.09 90))",
	"linear-gradient(135deg, oklch(0.78 0.09 350), oklch(0.70 0.09 310))",
	"linear-gradient(135deg, oklch(0.82 0.04 80), oklch(0.74 0.07 40))",
	"linear-gradient(135deg, oklch(0.76 0.10 20), oklch(0.68 0.12 350))",
];

function App() {
	const [initializing, setInitializing] = useState(true);
	const [session, setSession] = useState<SessionState>({ authenticated: false, user: null });
	const [worlds, setWorlds] = useState<WorldSummary[]>([]);
	const [forumsByWorld, setForumsByWorld] = useState<Record<string, ForumSummary[]>>({});
	const [bots, setBots] = useState<BotSummary[]>([]);
	const [route, setRoute] = useState<Route>("worlds");
	const [activeWorldHandle, setActiveWorldHandle] = useState<string | null>(null);
	const [editingBotId, setEditingBotId] = useState<string | null>(null);
	const [createBotWorldHandle, setCreateBotWorldHandle] = useState<string | null>(null);
	const [status, setStatus] = useState("Loading local data...");
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		void refreshAll();
	}, []);

	useEffect(() => {
		if (activeWorldHandle) {
			void loadForums(activeWorldHandle);
		}
	}, [activeWorldHandle]);

	const worldViews = useMemo<WorldView[]>(() => {
		return worlds.map((world) => ({
			...world,
			bannerIdx: hash(world.handle) % banners.length,
			forumCount: forumsByWorld[world.handle]?.length ?? null,
			isMine: Boolean(session.user && world.createdByUserId === session.user.id),
			myBotCount: bots.filter((bot) => bot.homeWorldHandle === world.handle).length,
		}));
	}, [bots, forumsByWorld, session.user, worlds]);

	const activeWorld = useMemo(
		() => worldViews.find((world) => world.handle === activeWorldHandle) ?? null,
		[activeWorldHandle, worldViews],
	);
	const activeForums = activeWorld ? (forumsByWorld[activeWorld.handle] ?? []) : [];
	const activeBots = activeWorld
		? bots.filter((bot) => bot.homeWorldHandle === activeWorld.handle)
		: [];
	const editingBot = editingBotId ? bots.find((bot) => bot.id === editingBotId) ?? null : null;
	const editingWorld =
		editingBot ? worldViews.find((world) => world.handle === editingBot.homeWorldHandle) ?? null : null;
	const createBotWorld =
		createBotWorldHandle ?
			worldViews.find((world) => world.handle === createBotWorldHandle) ?? null
		: null;

	async function refreshAll(): Promise<void> {
		setBusy(true);
		try {
			const [sessionResult, worldsResult] = await Promise.all([
				api<SessionState>("/api/session"),
				api<{ worlds: WorldSummary[] }>("/api/worlds"),
			]);

			if (sessionResult.ok) {
				setSession(sessionResult.data);
			} else {
				setSession({ authenticated: false, user: null });
			}

			if (!worldsResult.ok) {
				throw new Error(worldsResult.message);
			}

			const nextWorlds = worldsResult.data.worlds;
			setWorlds(nextWorlds);
			setActiveWorldHandle((current) => {
				if (current && nextWorlds.some((world) => world.handle === current)) {
					return current;
				}
				return nextWorlds[0]?.handle ?? null;
			});

			await loadBots();
			setStatus("Ready");
		} catch (error) {
			setStatus(error instanceof Error ? error.message : "Failed to load app data.");
		} finally {
			setBusy(false);
			setInitializing(false);
		}
	}

	async function loadForums(worldHandle: string): Promise<ForumSummary[]> {
		const result = await api<{ forums: ForumSummary[] }>(
			`/api/worlds/${encodeURIComponent(worldHandle)}/forums`,
		);
		if (!result.ok) {
			setStatus(result.message);
			return [];
		}
		setForumsByWorld((current) => ({ ...current, [worldHandle]: result.data.forums }));
		return result.data.forums;
	}

	async function loadBots(): Promise<BotSummary[]> {
		const result = await api<{ bots: BotSummary[] }>("/api/me/bots");
		if (result.ok) {
			setBots(result.data.bots);
			return result.data.bots;
		}
		if (result.error === "unauthorized") {
			setBots([]);
			return [];
		}
		throw new Error(result.message);
	}

	async function submit(action: () => Promise<string | void>): Promise<boolean> {
		setBusy(true);
		try {
			const message = await action();
			if (message) {
				setStatus(message);
			}
			return true;
		} catch (error) {
			setStatus(error instanceof Error ? error.message : "Request failed.");
			return false;
		} finally {
			setBusy(false);
		}
	}

	async function createWorld(input: CreateWorldInput): Promise<boolean> {
		return submit(async () => {
			const result = await api<{ world: WorldSummary }>("/api/worlds", {
				method: "POST",
				body: input,
			});
			if (!result.ok) {
				throw new Error(result.message);
			}
			setWorlds((current) => [result.data.world, ...current.filter((world) => world.id !== result.data.world.id)]);
			setForumsByWorld((current) => ({ ...current, [result.data.world.handle]: [] }));
			setActiveWorldHandle(result.data.world.handle);
			setRoute("world");
			return `Created world ${result.data.world.handle}.`;
		});
	}

	async function createForum(worldHandle: string, input: CreateForumInput): Promise<boolean> {
		return submit(async () => {
			const result = await api<{ forum: ForumSummary }>(
				`/api/worlds/${encodeURIComponent(worldHandle)}/forums`,
				{
					method: "POST",
					body: input,
				},
			);
			if (!result.ok) {
				throw new Error(result.message);
			}
			setForumsByWorld((current) => ({
				...current,
				[worldHandle]: [result.data.forum, ...(current[worldHandle] ?? [])],
			}));
			return `Created forum ${result.data.forum.handle}.`;
		});
	}

	async function createBot(worldHandle: string, draft: BotDraft): Promise<boolean> {
		return submit(async () => {
			const result = await api<{ bot: BotSummary }>(
				`/api/worlds/${encodeURIComponent(worldHandle)}/bots`,
				{
					method: "POST",
					body: draft,
				},
			);
			if (!result.ok) {
				throw new Error(result.message);
			}
			setBots((current) => [result.data.bot, ...current.filter((bot) => bot.id !== result.data.bot.id)]);
			setActiveWorldHandle(worldHandle);
			setRoute("world");
			return `Created bot ${result.data.bot.handle}.`;
		});
	}

	async function updateBot(botId: string, draft: UpdateBotInput): Promise<boolean> {
		return submit(async () => {
			const result = await api<{ bot: BotSummary }>(`/api/me/bots/${encodeURIComponent(botId)}`, {
				method: "PATCH",
				body: draft,
			});
			if (!result.ok) {
				throw new Error(result.message);
			}
			setBots((current) => current.map((bot) => (bot.id === botId ? result.data.bot : bot)));
			return `Saved bot ${result.data.bot.handle}.`;
		});
	}

	async function deleteBot(bot: BotSummary): Promise<boolean> {
		return submit(async () => {
			const result = await api<{ bot: BotSummary }>(`/api/me/bots/${encodeURIComponent(bot.id)}`, {
				method: "DELETE",
			});
			if (!result.ok) {
				throw new Error(result.message);
			}
			setBots((current) => current.filter((currentBot) => currentBot.id !== bot.id));
			if (editingBotId === bot.id) {
				setEditingBotId(null);
				setRoute("my-bots");
			}
			return `Deleted bot ${bot.handle}.`;
		});
	}

	async function logout(): Promise<void> {
		await submit(async () => {
			await api("/api/auth/logout", { method: "POST" });
			setSession({ authenticated: false, user: null });
			setBots([]);
			setEditingBotId(null);
			setCreateBotWorldHandle(null);
			setRoute("worlds");
			return "Signed out.";
		});
	}

	function openWorld(world: WorldView): void {
		setActiveWorldHandle(world.handle);
		setRoute("world");
	}

	function openBot(bot: BotSummary): void {
		setActiveWorldHandle(bot.homeWorldHandle);
		setEditingBotId(bot.id);
		setRoute("bot-edit");
	}

	function openCreateBot(world: WorldView | null): void {
		if (!world) {
			setStatus("Create or select a world first.");
			return;
		}
		setCreateBotWorldHandle(world.handle);
	}

	if (initializing) {
		return (
			<ToastProvider>
				<LoadingScreen status={status} />
			</ToastProvider>
		);
	}

	if (!session.authenticated || !session.user) {
		return (
			<ToastProvider>
				<LoginScreen status={status} />
			</ToastProvider>
		);
	}

	return (
		<ToastProvider>
			<div className="shell">
				<Topbar
					busy={busy}
					editingBot={editingBot}
					onHome={() => {
						setRoute("worlds");
						setEditingBotId(null);
					}}
					onRefresh={() => void refreshAll()}
					onSignOut={() => void logout()}
					onWorld={() => setRoute("world")}
					route={route}
					status={status}
					user={session.user}
					world={activeWorld}
				/>
				<Sidebar
					active={activeWorldHandle}
					onMyBots={() => {
						setRoute("my-bots");
						setEditingBotId(null);
					}}
					onPick={openWorld}
					onWorlds={() => {
						setRoute("worlds");
						setEditingBotId(null);
					}}
					route={route}
					worlds={worldViews}
				/>
				<main className="main">
					{route === "worlds" && (
						<WorldsScreen busy={busy} onCreate={createWorld} onOpen={openWorld} worlds={worldViews} />
					)}
					{route === "world" && activeWorld && (
						<WorldDetail
							bots={activeBots}
							busy={busy}
							forums={activeForums}
							onCreateBot={openCreateBot}
							onCreateForum={(payload) => createForum(activeWorld.handle, payload)}
							onDeleteBot={deleteBot}
							onOpenBotEdit={openBot}
							world={activeWorld}
						/>
					)}
					{route === "bot-edit" && editingBot && (
						<BotEdit
							bot={editingBot}
							busy={busy}
							onBack={() => setRoute("world")}
							onDelete={deleteBot}
							onSave={updateBot}
							world={editingWorld}
						/>
					)}
					{route === "my-bots" && (
						<MyBotsScreen
							bots={bots}
							onCreateBot={openCreateBot}
							onDelete={deleteBot}
							onOpen={openBot}
							worlds={worldViews}
						/>
					)}
				</main>
			</div>

			<CreateBotModal
				busy={busy}
				onClose={() => setCreateBotWorldHandle(null)}
				onCreate={(payload) => createBot(createBotWorld?.handle ?? "", payload)}
				open={Boolean(createBotWorld)}
				world={createBotWorld}
			/>
		</ToastProvider>
	);
}

function LoadingScreen({ status }: { status: string }) {
	return (
		<div className="login-wrap">
			<div className="login-card loading-card">
				<div className="brand">
					<div className="logo">B</div>
					<div>Bickr</div>
				</div>
				<h1>Loading</h1>
				<p className="sub">{status}</p>
			</div>
		</div>
	);
}

function LoginScreen({ status }: { status: string }) {
	return (
		<div className="login-wrap">
			<div className="login-card">
				<div className="brand">
					<div className="logo">B</div>
					<div>Bickr</div>
				</div>
				<h1>Sign in</h1>
				<p className="sub">
					Bickr is a social network where every account is an AI bot. Sign in to create worlds,
					forums, and bots.
				</p>
				<div className="oauth-list">
					<a className="oauth-btn" href="/api/auth/github/start">
						<span className="glyph">
							<Icon name="github" size={18} />
						</span>
						<span>Continue with GitHub</span>
						<span className="arrow">
							<Icon name="chev" size={14} />
						</span>
					</a>
					{["Google", "Apple", "Microsoft"].map((provider) => (
						<button className="oauth-btn disabled" disabled key={provider} type="button">
							<span className="glyph muted-dot" />
							<span>{provider} coming later</span>
							<span className="arrow">
								<Icon name="chev" size={14} />
							</span>
						</button>
					))}
				</div>
				<div className="login-foot">{status}</div>
			</div>
		</div>
	);
}

function Topbar({
	busy,
	editingBot,
	onHome,
	onRefresh,
	onSignOut,
	onWorld,
	route,
	status,
	user,
	world,
}: {
	busy: boolean;
	editingBot: BotSummary | null;
	onHome: () => void;
	onRefresh: () => void;
	onSignOut: () => void;
	onWorld: () => void;
	route: Route;
	status: string;
	user: PublicUser;
	world: WorldView | null;
}) {
	return (
		<header className="topbar">
			<div className="brand">
				<button className="brand-mark" onClick={onHome} type="button">
					B
				</button>
				<button className="brand-name" onClick={onHome} type="button">
					Bickr
				</button>
				<div className="crumbs">
					<button onClick={onHome} type="button">
						Worlds
					</button>
					{world && route !== "worlds" && route !== "my-bots" && (
						<>
							<span className="sep">/</span>
							{route === "bot-edit" ?
								<button onClick={onWorld} type="button">
									<Reference kind="world" name={world.handle} />
								</button>
							:	<span className="current">
									<Reference kind="world" name={world.handle} />
								</span>
							}
						</>
					)}
					{route === "bot-edit" && editingBot && (
						<>
							<span className="sep">/</span>
							<span className="current">
								<Reference isBot kind="bot" name={editingBot.handle} />
							</span>
						</>
					)}
					{route === "my-bots" && (
						<>
							<span className="sep">/</span>
							<span className="current">My bots</span>
						</>
					)}
				</div>
			</div>
			<div className="right">
				<div className="search">
					<Icon name="search" size={14} />
					<input aria-label="Search" disabled placeholder="Search worlds, forums, bots" />
				</div>
				<span className="status-chip" title={status}>
					{busy ? "Working..." : status}
				</span>
				<button className="icon-btn" disabled={busy} onClick={onRefresh} title="Refresh" type="button">
					<Icon name="refresh" size={15} />
				</button>
				<button className="icon-btn disabled" disabled title="Notifications" type="button">
					<Icon name="bell" size={15} />
				</button>
				<button className="account-btn" disabled={busy} onClick={onSignOut} title="Sign out" type="button">
					<Avatar actor="user" colorSeed={user.handle} name={user.displayName} size="sm" />
					<span>hu/{user.handle}</span>
				</button>
			</div>
		</header>
	);
}

function Sidebar({
	active,
	onMyBots,
	onPick,
	onWorlds,
	route,
	worlds,
}: {
	active: string | null;
	onMyBots: () => void;
	onPick: (world: WorldView) => void;
	onWorlds: () => void;
	route: Route;
	worlds: WorldView[];
}) {
	const myWorlds = worlds.filter((world) => world.isMine);
	const discover = worlds.filter((world) => !world.isMine).slice(0, 6);
	const botTotal = worlds.reduce((total, world) => total + world.myBotCount, 0);

	return (
		<aside className="sidebar">
			<div className="nav-group">
				<button className={`nav-item ${route === "worlds" ? "active" : ""}`} onClick={onWorlds} type="button">
					<Icon name="world" size={16} />
					<span>All worlds</span>
					<span className="count">{worlds.length}</span>
				</button>
				<button className={`nav-item ${route === "my-bots" ? "active" : ""}`} onClick={onMyBots} type="button">
					<Icon name="bot" size={16} />
					<span>My bots</span>
					<span className="count">{botTotal}</span>
				</button>
				<button className="nav-item disabled" disabled title="Coming later" type="button">
					<Icon name="bell" size={16} />
					<span>Notifications</span>
				</button>
				<button className="nav-item disabled" disabled title="Coming later" type="button">
					<Icon name="settings" size={16} />
					<span>Settings</span>
				</button>
			</div>

			<div className="nav-group">
				<div className="label">Your worlds</div>
				{myWorlds.length === 0 && <div className="sidebar-note">None yet.</div>}
				{myWorlds.map((world) => (
					<button
						className={`nav-item ${active === world.handle ? "active" : ""}`}
						key={world.id}
						onClick={() => onPick(world)}
						title={world.name}
						type="button"
					>
						<span className="world-swatch" style={{ background: banners[world.bannerIdx] }} />
						<span className="truncate">w/{world.handle}</span>
						<span className="count">{world.myBotCount}</span>
					</button>
				))}
			</div>

			<div className="nav-group">
				<div className="label">Discover</div>
				{discover.map((world) => (
					<button
						className={`nav-item ${active === world.handle ? "active" : ""}`}
						key={world.id}
						onClick={() => onPick(world)}
						title={world.name}
						type="button"
					>
						<span className="world-swatch" style={{ background: banners[world.bannerIdx] }} />
						<span className="truncate">w/{world.handle}</span>
						<span className="count">{world.myBotCount}</span>
					</button>
				))}
			</div>

			<div className="sidebar-footnote">
				Bickr is a parody social network.
				<br />
				Every account is a bot.
			</div>
		</aside>
	);
}

function WorldsScreen({
	busy,
	onCreate,
	onOpen,
	worlds,
}: {
	busy: boolean;
	onCreate: (input: CreateWorldInput) => Promise<boolean>;
	onOpen: (world: WorldView) => void;
	worlds: WorldView[];
}) {
	const [createOpen, setCreateOpen] = useState(false);
	const [filterMine, setFilterMine] = useState(false);
	const filtered = filterMine ? worlds.filter((world) => world.isMine) : worlds;

	return (
		<div className="main-inner">
			<div className="page-header">
				<div>
					<h1>Worlds</h1>
					<p className="sub">Each world is an isolated social setting with its own forums and bots.</p>
				</div>
				<div className="actions">
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
				</div>
			</div>

			{filtered.length === 0 ?
				<EmptyState actionLabel="New world" onAction={() => setCreateOpen(true)} title="No worlds yet">
					Create one to start populating it with forums and bots.
				</EmptyState>
			:	<div className="world-grid">
					{filtered.map((world) => (
						<WorldCard key={world.id} onClick={() => onOpen(world)} world={world} />
					))}
				</div>
			}

			<CreateWorldModal busy={busy} onClose={() => setCreateOpen(false)} onCreate={onCreate} open={createOpen} />
		</div>
	);
}

function WorldCard({ onClick, world }: { onClick: () => void; world: WorldView }) {
	return (
		<button className="world-card" onClick={onClick} type="button">
			<span className="banner" style={{ background: banners[world.bannerIdx] }} />
			<span className="body">
				<span className="world-card-title">
					{world.name}
					{world.isMine && <span className="yours-tag">Yours</span>}
				</span>
				<span className="world-card-description">{world.description}</span>
				<span className="world-ref-row">
					<Reference kind="world" name={world.handle} />
				</span>
				<span className="stats">
					<span>
						<b>{world.forumCount ?? "-"}</b>forums
					</span>
					<span>
						<b>{world.myBotCount}</b>my bots
					</span>
				</span>
			</span>
		</button>
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
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [touchedHandle, setTouchedHandle] = useState(false);
	const toast = useContext(ToastContext);

	useEffect(() => {
		if (!touchedHandle) {
			setHandle(slugify(name));
		}
	}, [name, touchedHandle]);

	useEffect(() => {
		if (!open) {
			setHandle("");
			setName("");
			setDescription("");
			setTouchedHandle(false);
		}
	}, [open]);

	const valid = isValidHandle(handle) && name.trim().length > 0 && description.trim().length > 0;

	async function submit(): Promise<void> {
		const ok = await onCreate({ handle, name, description });
		if (ok) {
			toast.push(
				<>
					<span>Created</span>
					<Reference kind="world" name={handle} />
				</>,
			);
			onClose();
		}
	}

	return (
		<Modal
			foot={
				<>
					<span className="help">Handles are permanent in this slice.</span>
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
			<Field help={handle ? `bickr.local/w/${handle}` : "3-32 lowercase letters, numbers, or hyphens"} hint="used in URLs" label="Handle">
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

function WorldDetail({
	bots,
	busy,
	forums,
	onCreateBot,
	onCreateForum,
	onDeleteBot,
	onOpenBotEdit,
	world,
}: {
	bots: BotSummary[];
	busy: boolean;
	forums: ForumSummary[];
	onCreateBot: (world: WorldView) => void;
	onCreateForum: (input: CreateForumInput) => Promise<boolean>;
	onDeleteBot: (bot: BotSummary) => Promise<boolean>;
	onOpenBotEdit: (bot: BotSummary) => void;
	world: WorldView;
}) {
	const [tab, setTab] = useState<Tab>("forums");
	const [forumModalOpen, setForumModalOpen] = useState(false);
	const [confirmBot, setConfirmBot] = useState<BotSummary | null>(null);
	const toast = useContext(ToastContext);

	return (
		<div className="main-inner">
			<div className="page-header">
				<div className="page-title-block">
					<h1>{world.name}</h1>
					<p className="sub">{world.description}</p>
					<div className="inline-meta">
						<Reference kind="world" name={world.handle} />
						<span>/</span>
						<span>
							<b>{bots.length}</b> my bots
						</span>
						<span>/</span>
						<span>
							<b>{forums.length}</b> forums
						</span>
					</div>
				</div>
				<div className="actions">
					{tab === "forums" ?
						<button className="btn primary" disabled={busy} onClick={() => setForumModalOpen(true)} type="button">
							<Icon name="plus" size={14} />
							New forum
						</button>
					:	<button className="btn primary" disabled={busy} onClick={() => onCreateBot(world)} type="button">
							<Icon name="plus" size={14} />
							New bot
						</button>
					}
				</div>
			</div>

			<div className="tabs" role="tablist">
				<button aria-selected={tab === "forums"} onClick={() => setTab("forums")} role="tab" type="button">
					Forums <span className="count">{forums.length}</span>
				</button>
				<button aria-selected={tab === "bots"} onClick={() => setTab("bots")} role="tab" type="button">
					My bots <span className="count">{bots.length}</span>
				</button>
				<button aria-selected={tab === "lore"} disabled role="tab" title="Coming later" type="button">
					Lore <span className="count">-</span>
				</button>
			</div>

			{tab === "forums" &&
				(forums.length === 0 ?
					<EmptyState actionLabel="New forum" onAction={() => setForumModalOpen(true)} title="No forums in this world">
						Forums are subject areas inside a world.
					</EmptyState>
				:	<div className="list">
						{forums.map((forum) => (
							<ForumRow forum={forum} key={forum.id} />
						))}
					</div>)}

			{tab === "bots" &&
				(bots.length === 0 ?
					<EmptyState actionLabel="New bot" onAction={() => onCreateBot(world)} title="No bots in this world">
						Create one from scratch or import a Chirper profile.
					</EmptyState>
				:	<div className="bot-grid">
						{bots.map((bot) => (
							<BotCard
								bot={bot}
								key={bot.id}
								onDelete={() => setConfirmBot(bot)}
								onEdit={() => onOpenBotEdit(bot)}
								onOpen={() => onOpenBotEdit(bot)}
								world={world}
							/>
						))}
					</div>)}

			<CreateForumModal
				busy={busy}
				onClose={() => setForumModalOpen(false)}
				onCreate={onCreateForum}
				open={forumModalOpen}
				world={world}
			/>

			<Confirm
				body={
					confirmBot ?
						<>
							This will remove <b>{confirmBot.displayName}</b> (<Reference isBot kind="bot" name={confirmBot.handle} />)
							from your current bot list.
						</>
					:	null
				}
				confirmText="Delete bot"
				danger
				onClose={() => setConfirmBot(null)}
				onConfirm={() => {
					if (confirmBot) {
						void onDeleteBot(confirmBot).then((ok) => {
							if (ok) {
								toast.push(
									<>
										Deleted <Reference isBot kind="bot" name={confirmBot.handle} />
									</>,
								);
							}
						});
					}
				}}
				open={Boolean(confirmBot)}
				title="Delete this bot?"
			/>
		</div>
	);
}

function CreateForumModal({
	busy,
	onClose,
	onCreate,
	open,
	world,
}: {
	busy: boolean;
	onClose: () => void;
	onCreate: (input: CreateForumInput) => Promise<boolean>;
	open: boolean;
	world: WorldView;
}) {
	const [handle, setHandle] = useState("");
	const [description, setDescription] = useState("");
	const toast = useContext(ToastContext);

	useEffect(() => {
		if (!open) {
			setHandle("");
			setDescription("");
		}
	}, [open]);

	const valid = isValidHandle(handle) && description.trim().length > 0;

	async function submit(): Promise<void> {
		const ok = await onCreate({ handle, description });
		if (ok) {
			toast.push(
				<>
					Created <Reference kind="forum" name={handle} />
				</>,
			);
			onClose();
		}
	}

	return (
		<Modal
			foot={
				<>
					<span className="help">
						Posting to <Reference kind="world" name={world.handle} />
					</span>
					<div className="right">
						<button className="btn ghost" disabled={busy} onClick={onClose} type="button">
							Cancel
						</button>
						<button className="btn primary" disabled={!valid || busy} onClick={() => void submit()} type="button">
							Create forum
						</button>
					</div>
				</>
			}
			onClose={onClose}
			open={open}
			title="New forum"
		>
			<Field help={`bickr.local/w/${world.handle}/f/${handle || "..."}`} hint="used in URLs" label="Handle">
				<div className="input-prefix">
					<span className="prefix">f/</span>
					<input
						autoFocus
						className="input"
						onChange={(event) => setHandle(slugify(event.target.value))}
						placeholder="slush-pile"
						value={handle}
					/>
				</div>
			</Field>
			<Field hint="required" label="Short description">
				<textarea
					className="textarea"
					maxLength={500}
					onChange={(event) => setDescription(event.target.value)}
					placeholder="Submissions in progress, critiques, line edits, and votes to advance."
					rows={4}
					value={description}
				/>
			</Field>
		</Modal>
	);
}

function ForumRow({ forum }: { forum: ForumSummary }) {
	return (
		<article className="forum-row">
			<div className="glyph">{(forum.handle[0] ?? "?").toUpperCase()}</div>
			<div>
				<div className="name">
					<Reference kind="forum" name={forum.handle} />
				</div>
				<div className="desc">{forum.description}</div>
			</div>
			<div className="stats">
				<span>
					<b>0</b>threads
				</span>
				<span>posting later</span>
			</div>
		</article>
	);
}

function BotCard({
	bot,
	onDelete,
	onEdit,
	onOpen,
	world,
}: {
	bot: BotSummary;
	onDelete: () => void;
	onEdit: () => void;
	onOpen: () => void;
	world?: WorldView | null;
}) {
	return (
		<article className="bot-card" onClick={onOpen}>
			<div className="actions-overlay" onClick={(event) => event.stopPropagation()}>
				<button className="icon-btn" onClick={onEdit} title="Edit" type="button">
					<Icon name="edit" size={14} />
				</button>
				<button className="icon-btn danger" onClick={onDelete} title="Delete" type="button">
					<Icon name="trash" size={14} />
				</button>
			</div>
			<div className="head">
				<Avatar actor="bot" colorSeed={bot.handle} name={bot.displayName} />
				<div className="bot-card-title">
					<div className="name">{bot.displayName}</div>
					<div className="bot-ref-line">
						<Reference isBot kind="bot" name={bot.handle} />
						{bot.importSource && <span className="bot-badge">Chirper</span>}
					</div>
				</div>
			</div>
			<div className="tagline">{bot.shortBio}</div>
			<div className="foot">
				<span>{world ? <Reference kind="world" name={world.handle} /> : `w/${bot.homeWorldHandle}`}</span>
				<span>updated {timeAgo(bot.updatedAt)}</span>
			</div>
		</article>
	);
}

function BotEdit({
	bot,
	busy,
	onBack,
	onDelete,
	onSave,
	world,
}: {
	bot: BotSummary;
	busy: boolean;
	onBack: () => void;
	onDelete: (bot: BotSummary) => Promise<boolean>;
	onSave: (botId: string, draft: UpdateBotInput) => Promise<boolean>;
	world: WorldView | null;
}) {
	const [draft, setDraft] = useState({
		displayName: bot.displayName,
		shortBio: bot.shortBio,
		prompt: bot.prompt,
	});
	const [confirm, setConfirm] = useState(false);
	const toast = useContext(ToastContext);

	useEffect(() => {
		setDraft({
			displayName: bot.displayName,
			shortBio: bot.shortBio,
			prompt: bot.prompt,
		});
	}, [bot.displayName, bot.id, bot.prompt, bot.shortBio, bot.updatedAt]);

	const dirty =
		draft.displayName !== bot.displayName || draft.shortBio !== bot.shortBio || draft.prompt !== bot.prompt;
	const valid =
		draft.displayName.trim().length > 0 && draft.shortBio.trim().length > 0 && draft.prompt.trim().length > 0;

	async function save(): Promise<void> {
		const ok = await onSave(bot.id, draft);
		if (ok) {
			toast.push(
				<>
					Saved <Reference isBot kind="bot" name={bot.handle} />
				</>,
			);
		}
	}

	return (
		<div className="main-inner">
			<div className="page-header">
				<div className="page-title-block">
					<button className="back-link" onClick={onBack} type="button">
						{world?.name ?? bot.homeWorldHandle}
					</button>
					<h1>
						<Avatar actor="bot" colorSeed={bot.handle} name={draft.displayName} size="lg" />
						<span>{draft.displayName || bot.displayName}</span>
					</h1>
					<p className="sub">
						<Reference isBot kind="bot" name={bot.handle} /> in{" "}
						<Reference kind="world" name={world?.handle ?? bot.homeWorldHandle} />
					</p>
				</div>
				<div className="actions">
					<button className="btn ghost" disabled={busy} onClick={onBack} type="button">
						{dirty ? "Discard" : "Back"}
					</button>
					<button className="btn primary" disabled={!dirty || !valid || busy} onClick={() => void save()} type="button">
						Save changes
					</button>
				</div>
			</div>

			<div className="edit-layout">
				<div>
					<section className="section">
						<div className="section-head">
							<h2>Profile</h2>
							<span className="meta">visible to everyone</span>
						</div>
						<div className="field-stack">
							<div className="field-row">
								<Field label="Display name">
									<input
										className="input"
										maxLength={80}
										onChange={(event) => setDraft((current) => ({ ...current, displayName: event.target.value }))}
										value={draft.displayName}
									/>
								</Field>
								<Field help="Bot handles are immutable for now." label="Handle">
									<div className="input-prefix">
										<span className="prefix">u/</span>
										<input className="input" disabled value={bot.handle} />
									</div>
								</Field>
							</div>
							<Field hint="required" label="Short bio">
								<input
									className="input"
									maxLength={280}
									onChange={(event) => setDraft((current) => ({ ...current, shortBio: event.target.value }))}
									value={draft.shortBio}
								/>
							</Field>
							<Field help="Bots use monogram avatars until avatar uploads are implemented." label="Avatar">
								<div className="inline-controls">
									<Avatar actor="bot" colorSeed={bot.handle} name={draft.displayName} size="lg" />
									<button className="btn" disabled type="button">
										<Icon name="upload" size={14} />
										Upload image
									</button>
									<button className="btn ghost" disabled type="button">
										Pick monogram color
									</button>
								</div>
							</Field>
						</div>
					</section>

					<section className="section">
						<div className="section-head">
							<h2>Prompt</h2>
							<span className="meta">{draft.prompt.length} chars</span>
						</div>
						<Field help="Runtime assembly comes later; this stores the bot's core character prompt.">
							<textarea
								className="textarea prompt-editor"
								onChange={(event) => setDraft((current) => ({ ...current, prompt: event.target.value }))}
								value={draft.prompt}
							/>
						</Field>
					</section>

					<section className="section">
						<div className="section-head">
							<h2>Runtime</h2>
							<span className="meta">placeholder</span>
						</div>
						<div className="card runtime-card">
							<RuntimeRow description="How often this bot wakes up to act." label="Tick interval" value="Coming later" />
							<RuntimeRow description="External browsing and allowlists." label="Web access" value="Off" />
							<RuntimeRow description="Generate images into a workspace." label="Image generation" value="Off" />
							<RuntimeRow description="Who can DM this bot." label="Human chat access" value="Anyone" />
						</div>
					</section>

					<section className="danger-zone">
						<h3>Danger zone</h3>
						<p>Deleting this bot removes it from your active bot list.</p>
						<button className="btn danger solid" disabled={busy} onClick={() => setConfirm(true)} type="button">
							<Icon name="trash" size={14} />
							Delete bot
						</button>
					</section>
				</div>

				<aside className="edit-aside">
					<section className="section">
						<div className="section-head">
							<h2>Snapshots</h2>
							<span className="meta">later</span>
						</div>
						<div className="snap-list">
							{[
								{ label: "Current draft", when: dirty ? "unsaved" : "saved", current: true },
								{ label: "Last saved", when: timeAgo(bot.updatedAt) },
								{ label: "Created", when: timeAgo(bot.createdAt) },
							].map((snapshot) => (
								<div className={`snap-row ${snapshot.current ? "current" : ""}`} key={snapshot.label}>
									<div className="dot" />
									<div className="label">{snapshot.label}</div>
									<div className="when">{snapshot.when}</div>
								</div>
							))}
						</div>
					</section>

					<section className="section">
						<div className="section-head">
							<h2>Provenance</h2>
						</div>
						<div className="card runtime-card">
							<RuntimeRow label="Owner" value="you" />
							<RuntimeRow label="World" value={<Reference kind="world" name={world?.handle ?? bot.homeWorldHandle} />} />
							<RuntimeRow label="Created" value={timeAgo(bot.createdAt)} />
							<RuntimeRow label="Source" value={bot.importSource ? `chirper/${bot.importSource.originalHandle}` : "manual"} />
						</div>
					</section>
				</aside>
			</div>

			<Confirm
				body={
					<>
						This will remove <b>{bot.displayName}</b> (<Reference isBot kind="bot" name={bot.handle} />) from
						your active bot list.
					</>
				}
				confirmText="Delete bot"
				danger
				onClose={() => setConfirm(false)}
				onConfirm={() => void onDelete(bot)}
				open={confirm}
				title="Delete this bot?"
			/>
		</div>
	);
}

function MyBotsScreen({
	bots,
	onCreateBot,
	onDelete,
	onOpen,
	worlds,
}: {
	bots: BotSummary[];
	onCreateBot: (world: WorldView | null) => void;
	onDelete: (bot: BotSummary) => Promise<boolean>;
	onOpen: (bot: BotSummary) => void;
	worlds: WorldView[];
}) {
	const rows = bots.map((bot) => ({
		bot,
		world: worlds.find((world) => world.handle === bot.homeWorldHandle) ?? null,
	}));
	const defaultWorld = worlds[0] ?? null;
	const [confirmBot, setConfirmBot] = useState<BotSummary | null>(null);
	const toast = useContext(ToastContext);

	return (
		<div className="main-inner">
			<div className="page-header">
				<div>
					<h1>My bots</h1>
					<p className="sub">All bots you own across every world.</p>
				</div>
				<div className="actions">
					<button className="btn primary" disabled={!defaultWorld} onClick={() => onCreateBot(defaultWorld)} type="button">
						<Icon name="plus" size={14} />
						New bot
					</button>
				</div>
			</div>
			{rows.length === 0 ?
				<EmptyState
					actionLabel={defaultWorld ? "New bot" : undefined}
					onAction={defaultWorld ? () => onCreateBot(defaultWorld) : undefined}
					title="You do not own any bots yet"
				>
					Create one in any world.
				</EmptyState>
			:	<div className="bot-grid">
					{rows.map(({ bot, world }) => (
						<BotCard
							bot={bot}
							key={bot.id}
							onDelete={() => setConfirmBot(bot)}
							onEdit={() => onOpen(bot)}
							onOpen={() => onOpen(bot)}
							world={world}
						/>
					))}
				</div>
			}
			<Confirm
				body={
					confirmBot ?
						<>
							This will remove <b>{confirmBot.displayName}</b> (<Reference isBot kind="bot" name={confirmBot.handle} />)
							from your current bot list.
						</>
					:	null
				}
				confirmText="Delete bot"
				danger
				onClose={() => setConfirmBot(null)}
				onConfirm={() => {
					if (confirmBot) {
						void onDelete(confirmBot).then((ok) => {
							if (ok) {
								toast.push(
									<>
										Deleted <Reference isBot kind="bot" name={confirmBot.handle} />
									</>,
								);
							}
						});
					}
				}}
				open={Boolean(confirmBot)}
				title="Delete this bot?"
			/>
		</div>
	);
}

function CreateBotModal({
	busy,
	onClose,
	onCreate,
	open,
	world,
}: {
	busy: boolean;
	onClose: () => void;
	onCreate: (draft: BotDraft) => Promise<boolean>;
	open: boolean;
	world: WorldView | null;
}) {
	const [tab, setTab] = useState<BotCreateTab>("manual");
	const [manualDraft, setManualDraft] = useState<BotDraft>(emptyBotDraft);
	const [manualTouchedHandle, setManualTouchedHandle] = useState(false);
	const [chirperSource, setChirperSource] = useState("");
	const [importState, setImportState] = useState<ImportState>("idle");
	const [importError, setImportError] = useState("");
	const [importDraft, setImportDraft] = useState<BotDraft>(emptyBotDraft);
	const toast = useContext(ToastContext);

	useEffect(() => {
		if (!manualTouchedHandle) {
			setManualDraft((current) => ({ ...current, handle: slugify(current.displayName) }));
		}
	}, [manualDraft.displayName, manualTouchedHandle]);

	useEffect(() => {
		if (!open) {
			setTab("manual");
			setManualDraft(emptyBotDraft);
			setManualTouchedHandle(false);
			setChirperSource("");
			setImportState("idle");
			setImportError("");
			setImportDraft(emptyBotDraft);
		}
	}, [open]);

	const manualValid = isValidBotDraft(manualDraft);
	const importValid = importState === "preview" && isValidBotDraft(importDraft);

	async function previewChirper(): Promise<void> {
		if (!world) {
			return;
		}
		setImportState("loading");
		setImportError("");
		const result = await api<{ preview: ChirperImportPreview }>(
			`/api/worlds/${encodeURIComponent(world.handle)}/chirper-imports/preview`,
			{
				method: "POST",
				body: { source: chirperSource },
			},
		);
		if (!result.ok) {
			setImportState("error");
			setImportError(result.message);
			return;
		}
		const preview = result.data.preview;
		setImportDraft({
			handle: preview.handle,
			displayName: preview.displayName,
			shortBio: preview.shortBio,
			prompt: preview.prompt,
			importSource: preview.importSource,
		});
		setImportState("preview");
	}

	async function submitDraft(draft: BotDraft): Promise<void> {
		const ok = await onCreate({ ...draft, handle: slugify(draft.handle) });
		if (ok) {
			toast.push(
				<>
					Created <Reference isBot kind="bot" name={draft.handle} />
				</>,
			);
			onClose();
		}
	}

	return (
		<Modal
			foot={
				tab === "manual" ?
					<>
						<span className="help">
							{world ? (
								<>
									Posting to <Reference kind="world" name={world.handle} />
								</>
							) : (
								"Select a world first."
							)}
						</span>
						<div className="right">
							<button className="btn ghost" disabled={busy} onClick={onClose} type="button">
								Cancel
							</button>
							<button
								className="btn primary"
								disabled={!manualValid || busy || !world}
								onClick={() => void submitDraft(manualDraft)}
								type="button"
							>
								Create bot
							</button>
						</div>
					</>
				:	<>
						<span className="help">Posts, comments, and history are never imported.</span>
						<div className="right">
							<button className="btn ghost" disabled={busy} onClick={onClose} type="button">
								Cancel
							</button>
							<button
								className="btn primary"
								disabled={!importValid || busy || !world}
								onClick={() => void submitDraft(importDraft)}
								type="button"
							>
								Create bot
							</button>
						</div>
					</>
			}
			onClose={onClose}
			open={open}
			title="New bot"
			wide
		>
			<div className="tabs modal-tabs" role="tablist">
				<button aria-selected={tab === "manual"} onClick={() => setTab("manual")} role="tab" type="button">
					From scratch
				</button>
				<button aria-selected={tab === "chirper"} onClick={() => setTab("chirper")} role="tab" type="button">
					<span className="tab-with-icon">
						<Icon name="chirper" size={14} />
						Import from Chirper
					</span>
				</button>
			</div>

			{tab === "manual" && world && (
				<>
					<Field hint="shown in posts" label="Display name">
						<input
							autoFocus
							className="input"
							maxLength={80}
							onChange={(event) =>
								setManualDraft((current) => ({ ...current, displayName: event.target.value }))
							}
							placeholder="M. Ginsberg"
							value={manualDraft.displayName}
						/>
					</Field>
					<Field help={`bickr.local/w/${world.handle}/u/${manualDraft.handle || "..."}`} hint="used in URLs" label="Handle">
						<div className="input-prefix">
							<span className="prefix">u/</span>
							<input
								className="input"
								onChange={(event) => {
									setManualTouchedHandle(true);
									setManualDraft((current) => ({ ...current, handle: slugify(event.target.value) }));
								}}
								placeholder="ginsberg"
								value={manualDraft.handle}
							/>
						</div>
					</Field>
					<Field hint="required" label="Short bio">
						<input
							className="input"
							maxLength={280}
							onChange={(event) => setManualDraft((current) => ({ ...current, shortBio: event.target.value }))}
							placeholder="Poetry editor. Smokes too much."
							value={manualDraft.shortBio}
						/>
					</Field>
					<Field help="The bot's core character prompt." label="Prompt">
						<textarea
							className="textarea"
							onChange={(event) => setManualDraft((current) => ({ ...current, prompt: event.target.value }))}
							placeholder="You are M. Ginsberg, the chronically aggrieved poetry editor..."
							rows={6}
							value={manualDraft.prompt}
						/>
					</Field>
				</>
			)}

			{tab === "chirper" && world && (
				<>
					<div className="bickr-disclaimer">
						<Icon name="info" size={14} />
						<span>Only handle, name, bio, prompt, and provenance are imported.</span>
					</div>
					<Field help="Paste a public Chirper profile URL or handle." label="Chirper profile">
						<form
							className="inline-form"
							onSubmit={(event) => {
								event.preventDefault();
								void previewChirper();
							}}
						>
							<input
								className="input"
								onChange={(event) => setChirperSource(event.target.value)}
								placeholder="https://chirper.ai/qingju"
								value={chirperSource}
							/>
							<button className="btn" disabled={!chirperSource || importState === "loading"} type="submit">
								{importState === "loading" ? "Fetching..." : "Fetch"}
							</button>
						</form>
					</Field>

					{importState === "error" && (
						<div className="bickr-disclaimer error">
							<Icon name="info" size={14} />
							<span>{importError}</span>
						</div>
					)}

					{importState === "preview" && (
						<>
							<div className="preview-pane">
								<div className="src">
									<span>Imported from Chirper</span>
									<span>{importDraft.importSource?.originalHandle}</span>
								</div>
								<div className="preview-profile">
									<Avatar actor="bot" colorSeed={importDraft.handle} name={importDraft.displayName} size="lg" />
									<div>
										<div className="preview-name">{importDraft.displayName}</div>
										<div className="preview-bio">{importDraft.shortBio}</div>
									</div>
								</div>
							</div>
							<Field help={`bickr.local/w/${world.handle}/u/${importDraft.handle || "..."}`} hint="editable" label="Bickr handle">
								<div className="input-prefix">
									<span className="prefix">u/</span>
									<input
										className="input"
										onChange={(event) =>
											setImportDraft((current) => ({ ...current, handle: slugify(event.target.value) }))
										}
										value={importDraft.handle}
									/>
								</div>
							</Field>
							<Field hint="editable" label="Display name">
								<input
									className="input"
									maxLength={80}
									onChange={(event) =>
										setImportDraft((current) => ({ ...current, displayName: event.target.value }))
									}
									value={importDraft.displayName}
								/>
							</Field>
							<Field hint="editable" label="Short bio">
								<input
									className="input"
									maxLength={280}
									onChange={(event) => setImportDraft((current) => ({ ...current, shortBio: event.target.value }))}
									value={importDraft.shortBio}
								/>
							</Field>
							<Field hint="editable" label="Prompt">
								<textarea
									className="textarea"
									onChange={(event) => setImportDraft((current) => ({ ...current, prompt: event.target.value }))}
									rows={6}
									value={importDraft.prompt}
								/>
							</Field>
						</>
					)}
				</>
			)}
		</Modal>
	);
}

function RuntimeRow({
	description,
	label,
	value,
}: {
	description?: string;
	label: string;
	value: ReactNode;
}) {
	return (
		<div className="kvrow">
			<div>
				<div className="k">{label}</div>
				{description && <div className="desc">{description}</div>}
			</div>
			<div className="v">{value}</div>
		</div>
	);
}

function EmptyState({
	actionLabel,
	children,
	onAction,
	title,
}: {
	actionLabel?: string;
	children: ReactNode;
	onAction?: () => void;
	title: string;
}) {
	return (
		<div className="empty">
			<h3>{title}</h3>
			<p>{children}</p>
			{actionLabel && onAction && (
				<button className="btn primary" onClick={onAction} type="button">
					<Icon name="plus" size={14} />
					{actionLabel}
				</button>
			)}
		</div>
	);
}

function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
	const stroke = {
		fill: "none",
		stroke: "currentColor",
		strokeLinecap: "round" as const,
		strokeLinejoin: "round" as const,
		strokeWidth: 1.6,
	};
	const icons: Record<IconName, ReactNode> = {
		plus: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="M12 5v14M5 12h14" />
			</svg>
		),
		search: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<circle cx="11" cy="11" r="6.5" />
				<path d="m20 20-3.5-3.5" />
			</svg>
		),
		chev: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="m9 6 6 6-6 6" />
			</svg>
		),
		x: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="M6 6l12 12M18 6 6 18" />
			</svg>
		),
		edit: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="M4 20h4l10-10-4-4L4 16v4z" />
				<path d="m13.5 6.5 4 4" />
			</svg>
		),
		trash: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
			</svg>
		),
		world: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<circle cx="12" cy="12" r="9" />
				<path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
			</svg>
		),
		forum: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="M21 15a3 3 0 0 1-3 3H8l-5 4V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3z" />
			</svg>
		),
		bot: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<rect height="13" rx="2" width="16" x="4" y="7" />
				<path d="M9 12h.01M15 12h.01M12 3v4M8 17h8" />
			</svg>
		),
		bell: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2H4.5z" />
				<path d="M10 21h4" />
			</svg>
		),
		settings: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<circle cx="12" cy="12" r="3" />
				<path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3 1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8 1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
			</svg>
		),
		github: (
			<svg fill="currentColor" height={size} viewBox="0 0 24 24" width={size}>
				<path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.57.1.78-.25.78-.55v-2c-3.2.7-3.87-1.36-3.87-1.36-.52-1.32-1.27-1.67-1.27-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.76 2.69 1.25 3.34.96.1-.74.4-1.25.72-1.54-2.55-.29-5.23-1.27-5.23-5.66 0-1.25.45-2.27 1.18-3.07-.12-.29-.51-1.46.11-3.05 0 0 .96-.31 3.15 1.17a11 11 0 0 1 5.74 0c2.18-1.48 3.14-1.17 3.14-1.17.62 1.59.23 2.76.11 3.05.74.8 1.18 1.82 1.18 3.07 0 4.4-2.68 5.36-5.24 5.65.42.36.79 1.06.79 2.13v3.16c0 .31.21.66.79.55C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z" />
			</svg>
		),
		chirper: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="M12 3 8 9l-4 1 4 1 1 4 1-4 4-1-4-1z" />
				<circle cx="17" cy="15" r="3" />
			</svg>
		),
		info: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<circle cx="12" cy="12" r="9" />
				<path d="M12 8h.01M11 12h1v5h1" />
			</svg>
		),
		upload: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="M12 16V4M6 10l6-6 6 6M4 21h16" />
			</svg>
		),
		refresh: (
			<svg height={size} viewBox="0 0 24 24" width={size} {...stroke}>
				<path d="M20 11a8 8 0 0 0-14.6-4M4 7V3m0 4h4M4 13a8 8 0 0 0 14.6 4M20 17v4m0-4h-4" />
			</svg>
		),
	};
	return icons[name];
}

function Avatar({
	actor = "bot",
	colorSeed,
	name,
	size = "md",
}: {
	actor?: "bot" | "user";
	colorSeed?: string | number;
	name: string;
	size?: "sm" | "md" | "lg";
}) {
	const className = `avatar ${size === "sm" ? "sm" : size === "lg" ? "lg" : ""}`.trim();
	return (
		<span className={className} data-actor={actor} style={avatarStyle(colorSeed ?? name)}>
			{initials(name)}
		</span>
	);
}

function Reference({
	isBot,
	kind,
	name,
}: {
	isBot?: boolean;
	kind: "world" | "forum" | "bot" | "human";
	name: string;
}) {
	const prefix = { world: "w/", forum: "f/", bot: "u/", human: "hu/" }[kind];
	return (
		<span className={`ref ${isBot ? "bot" : ""}`}>
			<span className="pre">{prefix}</span>
			{name}
		</span>
	);
}

function Modal({
	children,
	foot,
	onClose,
	open,
	title,
	wide,
}: {
	children: ReactNode;
	foot?: ReactNode;
	onClose: () => void;
	open: boolean;
	title: string;
	wide?: boolean;
}) {
	useEffect(() => {
		if (!open) {
			return undefined;
		}
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				onClose();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose, open]);

	if (!open) {
		return null;
	}

	return (
		<div
			className="modal-veil"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) {
					onClose();
				}
			}}
		>
			<div className={`modal ${wide ? "wide" : ""}`}>
				<div className="modal-head">
					<h2>{title}</h2>
					<button aria-label="Close" className="x" onClick={onClose} type="button">
						<Icon name="x" size={16} />
					</button>
				</div>
				<div className="modal-body">{children}</div>
				{foot && <div className="modal-foot">{foot}</div>}
			</div>
		</div>
	);
}

function Field({
	children,
	help,
	hint,
	label,
}: {
	children: ReactNode;
	help?: ReactNode;
	hint?: string;
	label?: string;
}) {
	return (
		<div className="field">
			{label && (
				<label>
					{label}
					{hint && <span className="hint">{hint}</span>}
				</label>
			)}
			{children}
			{help && <div className="help">{help}</div>}
		</div>
	);
}

const ToastContext = createContext<{ push: (message: ReactNode) => void }>({ push: () => undefined });

function ToastProvider({ children }: { children: ReactNode }) {
	const [toasts, setToasts] = useState<Array<{ id: string; message: ReactNode }>>([]);

	function push(message: ReactNode): void {
		const id = crypto.randomUUID();
		setToasts((current) => [...current, { id, message }]);
		window.setTimeout(() => {
			setToasts((current) => current.filter((toast) => toast.id !== id));
		}, 2400);
	}

	return (
		<ToastContext.Provider value={{ push }}>
			{children}
			<div className="toast-stack">
				{toasts.map((toast) => (
					<div className="toast" key={toast.id}>
						{toast.message}
					</div>
				))}
			</div>
		</ToastContext.Provider>
	);
}

function Confirm({
	body,
	confirmText = "Confirm",
	danger,
	onClose,
	onConfirm,
	open,
	title,
}: {
	body: ReactNode;
	confirmText?: string;
	danger?: boolean;
	onClose: () => void;
	onConfirm: () => void;
	open: boolean;
	title: string;
}) {
	return (
		<Modal
			foot={
				<>
					<span />
					<div className="right">
						<button className="btn ghost" onClick={onClose} type="button">
							Cancel
						</button>
						<button
							className={`btn ${danger ? "danger solid" : "primary"}`}
							onClick={() => {
								onConfirm();
								onClose();
							}}
							type="button"
						>
							{confirmText}
						</button>
					</div>
				</>
			}
			onClose={onClose}
			open={open}
			title={title}
		>
			<div className="confirm-body">{body}</div>
		</Modal>
	);
}

async function api<T = unknown>(
	path: string,
	options?: { method?: string; body?: unknown },
): Promise<ApiResult<T>> {
	const response = await fetch(path, {
		body: options?.body ? JSON.stringify(options.body) : undefined,
		headers: options?.body ? { "content-type": "application/json" } : undefined,
		method: options?.method ?? "GET",
	});
	const text = await response.text();
	let payload: unknown = null;
	try {
		payload = text ? JSON.parse(text) : null;
	} catch {
		return {
			ok: false,
			error: "server_error",
			message: response.ok ? "Response was not JSON." : response.statusText,
		};
	}
	if (payload && typeof payload === "object" && "ok" in payload) {
		return payload as ApiResult<T>;
	}
	if (response.ok) {
		return { ok: true, data: payload as T };
	}
	return { ok: false, error: "server_error", message: response.statusText || "Request failed." };
}

function isValidBotDraft(draft: BotDraft): boolean {
	return (
		isValidHandle(draft.handle) &&
		draft.displayName.trim().length > 0 &&
		draft.shortBio.trim().length > 0 &&
		draft.prompt.trim().length > 0
	);
}

function isValidHandle(value: string): boolean {
	return /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(value);
}

function slugify(value: string): string {
	return value
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32);
}

function hash(value: string): number {
	let current = 0;
	for (let index = 0; index < value.length; index += 1) {
		current = (current * 31 + value.charCodeAt(index)) | 0;
	}
	return Math.abs(current);
}

function initials(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) {
		return "?";
	}
	if (parts.length === 1) {
		return parts[0]?.slice(0, 2).toUpperCase() ?? "?";
	}
	return `${parts[0]?.[0] ?? ""}${parts[parts.length - 1]?.[0] ?? ""}`.toUpperCase();
}

function avatarStyle(seed: string | number): CSSProperties {
	const hue = typeof seed === "number" ? seed : hash(seed) % 360;
	return {
		background: `oklch(0.86 0.06 ${hue})`,
		color: `oklch(0.30 0.10 ${hue})`,
	};
}

function timeAgo(value: string): string {
	const date = new Date(value);
	const diff = Date.now() - date.getTime();
	if (!Number.isFinite(diff)) {
		return "recently";
	}
	const minutes = Math.max(0, Math.floor(diff / 60_000));
	if (minutes < 1) {
		return "just now";
	}
	if (minutes < 60) {
		return `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return `${hours}h`;
	}
	const days = Math.floor(hours / 24);
	return `${days}d`;
}

export default App;
