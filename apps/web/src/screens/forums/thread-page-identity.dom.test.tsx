import { Profiler, StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
	localizedText,
	type CommentDocument,
	type ForumSummary,
	type LanguageTag,
	type ThreadDocument,
} from "@bickr/shared/model";
import type { WorldView } from "../../components/content";
import { ThreadPage } from "./thread-page";

/**
 * Rendered thread identity, checked at every commit rather than at rest.
 *
 * Spotlight targets, the focus seed, and the selection capture all describe
 * comments that exist in exactly one thread. Resetting them from an effect
 * still leaves React free to commit — and paint — the replacement thread with
 * the previous thread's checkboxes ticked and its Spotlight panel open, so
 * asserting only on the settled DOM cannot tell a correct implementation from
 * that one. Every commit is recorded instead, and the assertion is that no
 * commit ever showed one thread's comments alongside the other's state.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const language = "en" as LanguageTag;
const now = "2026-07-14T12:00:00.000Z";

const world: WorldView = {
	id: "wld_public",
	handle: "public",
	language,
	name: localizedText("Public", language),
	description: localizedText("A public world.", language),
	prompt: localizedText("Public world prompt.", language),
	recurringPromptEnabled: false,
	recurringPrompt: localizedText("", language),
	initialBotNotification: localizedText("Welcome.", language),
	createdByUserId: "usr_owner",
	createdAt: now,
	updatedAt: now,
	forumCount: 1,
	botCount: 1,
	bannerIdx: 0,
	isMine: false,
	myBotCount: 0,
};

const forum: ForumSummary = {
	id: "frm_public",
	worldId: world.id,
	worldHandle: world.handle,
	handle: "general",
	language,
	description: localizedText("Public discussion.", language),
	createdByUserId: world.createdByUserId,
	readOnly: false,
	createdAt: now,
	updatedAt: now,
};

function thread(suffix: string, body: string): ThreadDocument {
	const rootCommentId = `cmt_root_${suffix}`;
	const comment: CommentDocument = {
		id: rootCommentId,
		threadId: `thr_${suffix}`,
		worldId: world.id,
		forumId: forum.id,
		authorBotId: "bot_author",
		authorHandle: "author",
		authorDisplayName: localizedText("Author", language),
		body: localizedText(body, language),
		voteScore: 0,
		createdAt: now,
		updatedAt: now,
	};
	return {
		id: `thr_${suffix}`,
		type: "thread",
		schemaVersion: 1,
		revision: 1,
		worldId: world.id,
		worldHandle: world.handle,
		forumId: forum.id,
		forumHandle: forum.handle,
		title: localizedText(`Thread ${suffix}`, language),
		rootCommentId,
		comments: [comment],
		commentCount: 1,
		voteScore: 0,
		recentCommentCount: 0,
		lastActivityAt: now,
		createdAt: now,
		updatedAt: now,
	};
}

const threadA = thread("a", "the first thread's only comment");
const threadB = thread("b", "the replacement thread's only comment");

/** What one commit put on screen. */
type Commit = {
	readonly commentIds: readonly string[];
	readonly checkedToggles: number;
	readonly panels: number;
	readonly focusText: string;
};

let mounted: { container: HTMLElement; root: Root } | null = null;

afterEach(() => {
	if (mounted) {
		const { container, root } = mounted;
		act(() => root.unmount());
		container.remove();
		mounted = null;
	}
	window.getSelection()?.removeAllRanges();
});

function renderThread(current: ThreadDocument, commits: Commit[]): void {
	if (!mounted) {
		const container = document.createElement("div");
		document.body.append(container);
		mounted = { container, root: createRoot(container) };
	}
	const { container, root } = mounted;
	act(() => {
		root.render(
			<StrictMode>
				<Profiler id="thread" onRender={() => commits.push(readCommit(container))}>
					<ThreadPage
						activityCheckToken={0}
						currentUserId="usr_reader"
						forum={forum}
						loading={false}
						onDeleteComment={() => Promise.resolve(true)}
						onDeleteThread={() => Promise.resolve(true)}
						onReference={() => undefined}
						onRefresh={() => Promise.resolve(null)}
						onToggleSubscription={() => Promise.resolve()}
						ownedBots={[]}
						subscriptions={[]}
						targetCommentId={null}
						thread={current}
						threadId={current.id}
						world={world}
					/>
				</Profiler>
			</StrictMode>,
		);
	});
}

function readCommit(container: HTMLElement): Commit {
	const toggles = Array.from(container.querySelectorAll<HTMLInputElement>("[data-spotlight-toggle]"));
	return {
		commentIds: Array.from(container.querySelectorAll("[data-comment-body]"), (body) =>
			body.getAttribute("data-comment-body") ?? "",
		),
		checkedToggles: toggles.filter((toggle) => toggle.checked || toggle.indeterminate).length,
		panels: container.querySelectorAll("[data-spotlight-ui]").length,
		focusText: container.querySelector<HTMLTextAreaElement>("[data-spotlight-ui] textarea")?.value ?? "",
	};
}

function selectCommentText(): void {
	const line = mounted?.container.querySelector("[data-comment-body] [data-text-line]");
	if (!line) {
		throw new Error("no rendered comment line to select");
	}
	const range = document.createRange();
	range.selectNodeContents(line);
	const selection = window.getSelection();
	if (!selection) {
		throw new Error("no document selection");
	}
	selection.removeAllRanges();
	selection.addRange(range);
	act(() => {
		document.dispatchEvent(new Event("selectionchange"));
	});
}

function clickToggle(label: string): void {
	const toggle = mounted?.container.querySelector(`[data-spotlight-toggle][aria-label="${label}"]`);
	if (!(toggle instanceof HTMLElement)) {
		throw new Error(`no Spotlight toggle labelled ${label}`);
	}
	act(() => {
		toggle.click();
	});
}

const wholeThread = "Spotlight this entire thread";
const replyChain = "Spotlight this reply chain";

/** Commits that rendered thread B's comments while any of thread A's state survived. */
function mixedCommits(commits: readonly Commit[]): Commit[] {
	return commits.filter(
		(commit) =>
			commit.commentIds.includes(threadB.rootCommentId)
			&& (commit.panels > 0 || commit.checkedToggles > 0 || commit.focusText !== ""),
	);
}

describe("ThreadPage rendered thread replacement", () => {
	it("never renders the replacement thread with the previous thread's whole-thread Spotlight state", () => {
		const commits: Commit[] = [];
		renderThread(threadA, commits);
		selectCommentText();
		clickToggle(wholeThread);
		expect(readCommit(mounted!.container)).toMatchObject({
			commentIds: [threadA.rootCommentId],
			panels: 1,
			focusText: "> the first thread's only comment",
		});

		commits.length = 0;
		renderThread(threadB, commits);

		expect(commits.length).toBeGreaterThan(0);
		expect(mixedCommits(commits)).toEqual([]);
		expect(readCommit(mounted!.container)).toEqual({
			commentIds: [threadB.rootCommentId],
			checkedToggles: 0,
			panels: 0,
			focusText: "",
		});
	});

	it("never renders the replacement thread with the previous thread's reply-chain Spotlight state", () => {
		const commits: Commit[] = [];
		renderThread(threadA, commits);
		selectCommentText();
		clickToggle(replyChain);
		expect(readCommit(mounted!.container)).toMatchObject({
			commentIds: [threadA.rootCommentId],
			panels: 1,
			focusText: "> the first thread's only comment",
		});

		commits.length = 0;
		renderThread(threadB, commits);

		expect(mixedCommits(commits)).toEqual([]);
		expect(readCommit(mounted!.container)).toEqual({
			commentIds: [threadB.rootCommentId],
			checkedToggles: 0,
			panels: 0,
			focusText: "",
		});
	});

	it("drops the previous thread's selection capture before the replacement can consume it", () => {
		const commits: Commit[] = [];
		renderThread(threadA, commits);
		// Captured against thread A and never consumed, so only the reset can
		// stop it from seeding thread B.
		selectCommentText();

		renderThread(threadB, commits);
		clickToggle(wholeThread);

		expect(readCommit(mounted!.container)).toMatchObject({ panels: 1, focusText: "" });
	});
});
