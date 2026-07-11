import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	localizedText,
	type BotPublicProfile,
	type LanguageTag,
	type WorldActivityItem,
} from "@bickr/shared/model";
import { BotActivityCard } from "./screens/bots";

const en = "en" as LanguageTag;
const now = "2026-06-01T12:00:00.000Z";

function lt(text: string) {
	return localizedText(text, en);
}

function profile(handle: string, displayName = handle): BotPublicProfile {
	return {
		id: `bot_${handle}`,
		homeWorldId: "wld_sandbox",
		homeWorldHandle: "sandbox",
		handle,
		language: en,
		displayName: lt(displayName),
		shortBio: lt(`${displayName} bio.`),
		createdAt: now,
		updatedAt: now,
	};
}

function renderActivity(activity: WorldActivityItem): string {
	return renderToStaticMarkup(
		<BotActivityCard activity={activity} highlighted={false} onReference={() => undefined} />,
	);
}

describe("BotActivityCard", () => {
	it("separates a parent comment from the reply in activity feed comments", () => {
		const html = renderActivity({
			type: "comment",
			id: "act_reply",
			threadId: "thr_intro",
			commentId: "cmt_reply",
			parentCommentId: "cmt_parent",
			worldHandle: "sandbox",
			forumHandle: "intro",
			threadTitle: lt("Introductions"),
			bodyPreview: lt("Actual reply from u/replier, with its own point."),
			parentComment: {
				commentId: "cmt_parent",
				authorHandle: "parent",
				authorDisplayName: lt("Parent Writer"),
				bodyPreview: lt("Quoted parent text that mentions u/mentioned."),
			},
			voteScore: 0,
			createdAt: now,
			actor: profile("replier", "Reply Writer"),
		});

		const parentLabel = 'activity-quote-label">Parent comment';
		const replyLabel = 'activity-quote-label">Reply';
		expect(html).toContain("activity-quote");
		expect(html).toContain(parentLabel);
		expect(html).toContain(replyLabel);
		expect(html.indexOf(parentLabel)).toBeLessThan(html.indexOf(replyLabel));
		expect(html.indexOf("Quoted parent text")).toBeLessThan(html.indexOf("Actual reply"));
		expect(html).toContain('<span class="pre">u/</span>mentioned');
	});

	it("renders thread body previews as activity quote blocks", () => {
		const html = renderActivity({
			type: "thread",
			id: "act_thread",
			threadId: "thr_intro",
			rootCommentId: "cmt_root",
			worldHandle: "sandbox",
			forumHandle: "intro",
			title: lt("Introductions"),
			bodyPreview: lt("Thread opening text with a u/mentioned reference."),
			voteScore: 3,
			commentCount: 2,
			createdAt: now,
			actor: profile("replier", "Reply Writer"),
		});

		expect(html).toContain("activity-quote");
		expect(html).toContain("Post");
		expect(html).toContain("Thread opening text");
		expect(html).toContain('<span class="pre">u/</span>mentioned');
	});
});
