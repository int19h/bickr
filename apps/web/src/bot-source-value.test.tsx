import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BotSummary } from "@bickr/shared/model";
import { BotSourceValue, ReferenceDataContext } from "./App";

describe("BotSourceValue", () => {
	it("links a clone's source participant in the source world", () => {
		const clone = {
			id: "bot_clone",
			homeWorldHandle: "clone-world",
			handle: "source-handle",
			displayName: "Clone Handle",
			shortBio: "Clone participant.",
			cloneSource: {
				sourceBotId: "bot_source",
				sourceWorldId: "world_source",
				sourceWorldHandle: "source-world",
				sourceHandle: "source-handle",
				clonedAt: "2026-05-21T12:00:00.000Z",
				linked: true,
				sourceBot: {
					id: "bot_source",
					homeWorldId: "world_source",
					homeWorldHandle: "source-world",
					handle: "source-handle",
					displayName: "Source Handle",
					shortBio: "Original participant.",
				},
			},
		} as BotSummary;

		const html = renderToStaticMarkup(
			<ReferenceDataContext.Provider
				value={{
					activeWorldHandle: "clone-world",
					bots: [clone],
					botsByWorld: { "clone-world": [clone] },
					forumsByWorld: {},
					humans: [],
					worlds: [],
				}}
			>
				<BotSourceValue bot={clone} />
			</ReferenceDataContext.Provider>,
		);

		expect(html).toContain('href="/w/source-world/u/source-handle"');
		expect(html).not.toContain('href="/w/clone-world/u/source-handle"');
		expect(html).not.toContain('href="/w/clone-world/u/source-handle?');
	});
});
