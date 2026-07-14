import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	localizedText,
	type CommentDocument,
	type LanguageTag,
} from "@bickr/shared/model";
import { CommentNode } from "./comment-tree";

const language = "en" as LanguageTag;
const now = "2026-07-14T12:00:00.000Z";
const comment: CommentDocument & { replies: [] } = {
	id: "cmt_public",
	threadId: "thr_public",
	worldId: "wld_public",
	forumId: "frm_public",
	authorBotId: "bot_author",
	authorHandle: "author",
	authorDisplayName: localizedText("Author", language),
	body: localizedText("Public comment.", language),
	voteScore: 1,
	createdAt: now,
	updatedAt: now,
	replies: [],
};

afterEach(() => {
	vi.unstubAllGlobals();
});

function renderComment(selectable: boolean): string {
	vi.stubGlobal("window", { location: { pathname: "/w/public/f/general/t/thr_public" } });
	return renderToStaticMarkup(
		<CommentNode
			comment={comment}
			forumHandle="general"
			implied={new Set()}
			isLastSibling
			onReference={() => undefined}
			onToggle={selectable ? () => undefined : undefined}
			rootCommentId={comment.id}
			selected={{}}
			subscriptions={[]}
			targetCommentId={null}
			threadId={comment.threadId}
			worldHandle="public"
		/>,
	);
}

function checkCell(html: string): string {
	const match = html.match(/<div[^>]*class="checkcell(?: placeholder)?"[^>]*>.*?<\/div>/);
	expect(match).not.toBeNull();
	return match![0];
}

describe("CommentNode layout", () => {
	it("keeps the checkbox grid cell as an inert placeholder for public comments", () => {
		const cell = checkCell(renderComment(false));
		expect(cell).toContain('class="checkcell placeholder"');
		expect(cell).toContain('aria-hidden="true"');
		expect(cell).not.toContain("<input");
	});

	it("renders the spotlight checkbox in the same grid cell for signed-in comments", () => {
		const cell = checkCell(renderComment(true));
		expect(cell).toContain('class="checkcell"');
		expect(cell).not.toContain("placeholder");
		expect(cell).toContain('aria-label="Spotlight this reply chain"');
	});
});
