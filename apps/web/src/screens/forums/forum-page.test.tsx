import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	localizedText,
	type ForumSummary,
	type LanguageTag,
	type ThreadSummary,
} from "@bickr/shared/model";
import type { WorldView } from "../../components/content";
import { ForumPage } from "./forum-page";

const language = "en" as LanguageTag;
const now = "2026-07-14T12:00:00.000Z";

const world: WorldView = {
	id: "wld_public",
	handle: "public",
	language,
	name: localizedText("Public", language),
	description: localizedText("A public world.", language),
	prompt: localizedText("Public world prompt.", language),
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
	createdAt: now,
	updatedAt: now,
};

const thread: ThreadSummary = {
	id: "thr_public",
	rootCommentId: "cmt_public",
	worldId: world.id,
	worldHandle: world.handle,
	forumId: forum.id,
	forumHandle: forum.handle,
	authorBotId: "bot_author",
	authorHandle: "author",
	authorDisplayName: localizedText("Author", language),
	title: localizedText("Public thread", language),
	bodyPreview: localizedText("Public thread preview.", language),
	voteScore: 1,
	commentCount: 2,
	createdAt: now,
	lastActivityAt: now,
};

function renderForum(currentUserId: string | null): string {
	return renderToStaticMarkup(
		<ForumPage
			currentUserId={currentUserId}
			forum={forum}
			loading={false}
			onDeleteForum={async () => true}
			onDeleteThread={async () => true}
			onReference={() => undefined}
			onRefresh={async () => [thread]}
			onToggleSubscription={async () => undefined}
			onUpdateForum={async () => true}
			ownedBots={[]}
			subscribed={false}
			threads={[thread]}
			world={world}
		/>,
	);
}

function checkCell(html: string): string {
	const match = html.match(/<div[^>]*class="checkcell(?: placeholder)?"[^>]*>.*?<\/div>/);
	expect(match).not.toBeNull();
	return match![0];
}

describe("ForumPage thread rows", () => {
	it("keeps the checkbox grid cell as an inert placeholder for public listings", () => {
		const cell = checkCell(renderForum(null));
		expect(cell).toContain('class="checkcell placeholder"');
		expect(cell).toContain('aria-hidden="true"');
		expect(cell).not.toContain("<input");
	});

	it("renders the spotlight checkbox in the same grid cell for signed-in listings", () => {
		const cell = checkCell(renderForum("usr_viewer"));
		expect(cell).toContain('class="checkcell"');
		expect(cell).not.toContain("placeholder");
		expect(cell).toContain('aria-label="Spotlight Public thread"');
	});
});
