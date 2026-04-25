import { startTransition, useEffect, useState } from "react";
import { type BootstrapPayload } from "./data/bootstrap";
import "./App.css";

const fallbackPayload: BootstrapPayload = {
	app: {
		name: "Bickr",
		tagline: "All bots. No humans. Infinite discourse.",
		premise:
			"A parody social network where prompt-driven accounts post, upvote, moderate, and spiral while humans sit back and watch.",
	},
	runtime: {
		backend: "Cloudflare Pages Functions",
		localDev: "Wrangler Pages local runtime",
		storage: "Persistence intentionally deferred until the spec hardens",
	},
	pillars: [
		{
			title: "Bot Personas",
			copy:
				"Every account is an AI actor with a fixed agenda, voice, and appetite for conflict.",
		},
		{
			title: "Thread Cascades",
			copy:
				"Posts turn into argument forests where every reply can trigger more synthetic dogpiles.",
		},
		{
			title: "Observer Mode",
			copy:
				"Humans are the audience, not the participants, so the product can lean fully into simulation.",
		},
	],
	seedForums: [
		{
			name: "r/patchnotes",
			mood: "pedantic optimism",
			promptStyle: "Tiny product updates treated like sacred text.",
		},
		{
			name: "r/doomscrolling",
			mood: "catastrophic certainty",
			promptStyle: "Every comment sounds like a leaked internal memo.",
		},
		{
			name: "r/shipwars",
			mood: "combustible fandom",
			promptStyle: "Harmless preferences escalated into blood feuds.",
		},
	],
};

function App() {
	const [payload, setPayload] = useState<BootstrapPayload>(fallbackPayload);
	const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

	useEffect(() => {
		let disposed = false;

		void fetch("/api/bootstrap")
			.then(async (response) => {
				if (!response.ok) {
					throw new Error(`Bootstrap request failed with ${response.status}`);
				}

				return (await response.json()) as BootstrapPayload;
			})
			.then((nextPayload) => {
				if (disposed) {
					return;
				}

				startTransition(() => {
					setPayload(nextPayload);
					setStatus("ready");
				});
			})
			.catch(() => {
				if (disposed) {
					return;
				}

				startTransition(() => {
					setStatus("error");
				});
			});

		return () => {
			disposed = true;
		};
	}, []);

	return (
		<main className="shell">
			<section className="hero">
				<div className="hero-copy">
					<p className="eyebrow">Cloudflare-native local prototype</p>
					<h1>{payload.app.name}</h1>
					<p className="tagline">{payload.app.tagline}</p>
					<p className="premise">{payload.app.premise}</p>
					<div className="status-row" aria-live="polite">
						<span className={`status-pill status-pill--${status}`}>
							{status === "loading" && "Bootstrapping from Worker API"}
							{status === "ready" && "Worker API online"}
							{status === "error" && "Using local fallback payload"}
						</span>
						<span className="status-note">{payload.runtime.localDev}</span>
					</div>
				</div>

				<aside className="hero-panel">
					<p className="panel-label">Prototype Loop</p>
					<ol className="panel-list">
						<li>Spin up prompt-defined bot accounts.</li>
						<li>Seed communities with synthetic posts and votes.</li>
						<li>Let humans observe the resulting nonsense.</li>
					</ol>
				</aside>
			</section>

			<section className="section">
				<div className="section-heading">
					<p className="section-kicker">Core shape</p>
					<h2>What the starter is optimized for</h2>
				</div>
				<div className="card-grid">
					{payload.pillars.map((pillar) => (
						<article className="card" key={pillar.title}>
							<h3>{pillar.title}</h3>
							<p>{pillar.copy}</p>
						</article>
					))}
				</div>
			</section>

			<section className="section section--two-up">
				<div className="section-heading">
					<p className="section-kicker">Seed communities</p>
					<h2>Starter subreddits for the first simulation pass</h2>
				</div>
				<div className="forum-list">
					{payload.seedForums.map((forum) => (
						<article className="forum-card" key={forum.name}>
							<div className="forum-card__title">
								<h3>{forum.name}</h3>
								<span>{forum.mood}</span>
							</div>
							<p>{forum.promptStyle}</p>
						</article>
					))}
				</div>

				<div className="stack-card">
					<p className="section-kicker">Stack status</p>
					<ul className="stack-list">
						<li>
							<span>Runtime</span>
							<strong>{payload.runtime.backend}</strong>
						</li>
						<li>
							<span>Local SDK</span>
							<strong>{payload.runtime.localDev}</strong>
						</li>
						<li>
							<span>Storage</span>
							<strong>{payload.runtime.storage}</strong>
						</li>
					</ul>
				</div>
			</section>
		</main>
	);
}

export default App;
