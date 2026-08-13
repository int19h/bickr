import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	localizedText,
	type CommentDocument,
	type ForumSummary,
	type LanguageTag,
} from "@bickr/shared/model";
import { TranslationContext, type WorldView } from "../../components/content";
import {
	commentBodyAttribute,
	selectionExcludeAttribute,
	spotlightToggleAttribute,
	spotlightUiAttribute,
	textLineAttribute,
} from "../../selection-markers";
import { CommentNode } from "./comment-tree";
import { SpotlightPanel } from "./spotlight-panel";

/**
 * Selection capture reads rendered markup, so these guard the producing side of
 * that contract. A missing marker breaks Spotlight prefill silently: nothing
 * else in the app reads these attributes, so nothing else would fail.
 */
const language = "en" as LanguageTag;
const now = "2026-07-14T12:00:00.000Z";

const comment: CommentDocument & { replies: [] } = {
	id: "cmt_reply",
	threadId: "thr_public",
	worldId: "wld_public",
	forumId: "frm_public",
	authorBotId: "bot_author",
	authorHandle: "author",
	authorDisplayName: localizedText("Author", language),
	body: localizedText("first line\n\nthird line", language),
	voteScore: 1,
	createdAt: now,
	updatedAt: now,
	replies: [],
};

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

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("selection markers in rendered thread markup", () => {
	it("attributes a comment body to its comment and marks every rendered line", () => {
		const html = renderComment();

		expect(html).toContain(`${commentBodyAttribute}="${comment.id}"`);
		expect(occurrences(html, `${textLineAttribute}="true"`)).toBe(3);
	});

	it("excludes the filler that gives an empty rendered line its height", () => {
		expect(renderComment()).toContain(`<span ${selectionExcludeAttribute}="true">\u00a0</span>`);
	});

	it("excludes the translation controls rendered alongside comment text", () => {
		const html = renderComment({ enabled: true, identity: "inf_translate", model: "test-model", prompt: "translate" });
		const controls = /<span[^>]*class="translation-controls"[^>]*>/.exec(html)?.[0] ?? "";

		expect(controls).toContain(`${selectionExcludeAttribute}="true"`);
	});

	it("marks the reply-chain Spotlight checkbox", () => {
		expect(renderComment()).toContain(`${spotlightToggleAttribute}="true"`);
	});

	it("marks the Spotlight panel so selections inside it stay neutral", () => {
		vi.stubGlobal("window", { localStorage: { getItem: () => null } });

		const html = renderToStaticMarkup(
			<SpotlightPanel
				commentIds={[comment.id]}
				forum={forum}
				onClear={() => undefined}
				ownedBots={[]}
				targetType="comments"
				threadId={comment.threadId}
				threadIds={[]}
				world={world}
			/>,
		);

		expect(html).toContain(`${spotlightUiAttribute}="true"`);
	});
});

function renderComment(translation = { enabled: false, identity: "", model: "", prompt: "" }): string {
	vi.stubGlobal("window", { location: { pathname: "/w/public/f/general/t/thr_public" } });
	return renderToStaticMarkup(
		<TranslationContext.Provider value={translation}>
			<CommentNode
				comment={comment}
				forumHandle={forum.handle}
				implied={new Set()}
				isLastSibling
				onReference={() => undefined}
				onToggle={() => undefined}
				rootCommentId="cmt_root"
				selected={{}}
				subscriptions={[]}
				targetCommentId={null}
				threadId={comment.threadId}
				worldHandle={world.handle}
			/>
		</TranslationContext.Provider>,
	);
}

function occurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}
