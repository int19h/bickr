import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	localizedText,
	type ForumSummary,
	type HumanSubscriptionTreeResponse,
	type LanguageTag,
	type WorldSummary,
} from "@bickr/shared/model";
import { ForumRow } from "./forum-components";
import { SubscriptionsScreen } from "../subscriptions";

/**
 * Read-only marking on the listing surfaces a reader actually browses. The
 * subscription tree builds its own forum rows rather than reusing ForumRow, so
 * it is asserted separately instead of assumed to follow.
 */

const language = "en" as LanguageTag;
const now = "2026-07-14T12:00:00.000Z";

const forum: ForumSummary = {
	id: "frm_public",
	worldId: "wld_public",
	worldHandle: "public",
	handle: "general",
	language,
	description: localizedText("Public discussion.", language),
	createdByUserId: "usr_owner",
	readOnly: false,
	createdAt: now,
	updatedAt: now,
};

const world: WorldSummary = {
	id: forum.worldId,
	handle: forum.worldHandle,
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
};

function subscriptionResponse(readOnly: boolean): HumanSubscriptionTreeResponse {
	const target = { scopeType: "forum" as const, scopeId: forum.id, worldId: forum.worldId };
	const subscription = {
		id: "hsb_forum",
		userId: "usr_owner",
		worldId: forum.worldId,
		scopeType: "forum" as const,
		scopeId: forum.id,
		active: true,
		autoCreated: false,
		createdAt: now,
		updatedAt: now,
	};
	return {
		subscriptions: [subscription],
		tree: {
			worlds: [{
				type: "world",
				world,
				target: { scopeType: "world", scopeId: world.id, worldId: world.id },
				bots: [],
				forums: [{
					type: "forum",
					forum: { ...forum, readOnly },
					target,
					subscription,
					threads: [],
				}],
			}],
		},
	};
}

function subscriptionsMarkup(readOnly: boolean): string {
	return renderToStaticMarkup(
		<SubscriptionsScreen
			onLoad={async () => null}
			onSaved={() => undefined}
			response={subscriptionResponse(readOnly)}
		/>,
	);
}

describe("forum listing read-only markers", () => {
	it("marks a read-only forum row with accessible text, not color alone", () => {
		const html = renderToStaticMarkup(<ForumRow forum={{ ...forum, readOnly: true }} />);

		expect(html).toContain(">read-only<");
		expect(html).toContain("no new threads or replies are accepted");
	});

	it("leaves a writable forum row unmarked", () => {
		expect(renderToStaticMarkup(<ForumRow forum={forum} />)).not.toContain(">read-only<");
	});

	it("marks a read-only forum in the subscription list", () => {
		expect(subscriptionsMarkup(true)).toContain(">read-only<");
		expect(subscriptionsMarkup(false)).not.toContain(">read-only<");
	});
});
