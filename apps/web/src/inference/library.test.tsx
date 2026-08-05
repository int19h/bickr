import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
	InferenceBotHomeWorldGroup,
	InferenceConfigurationSummary,
} from "@bickr/shared/inference-configuration-owner";
import { InferenceLibraryScreen, createErrorMessage, groupBotSummaries } from "./library";
import { librarySectionPath, parentCandidatesPath, translationCandidatesPath } from "./api";
import { ConfigurationSummaryRow } from "./summary";

const now = "2026-08-05T00:00:00.000Z";

function summary(overrides: Partial<InferenceConfigurationSummary> = {}): InferenceConfigurationSummary {
	return {
		id: "cfg_one",
		parentId: "cfg_root",
		displayName: "Shared sampling",
		revision: 2,
		updatedAt: now,
		credentialMode: "inherit",
		credentialAvailability: { kind: "available", source: { kind: "account_default", configurationId: "cfg_root", depth: 1 } },
		immediateChildCount: 2,
		effectiveModel: "anthropic/claude-opus-4",
		parent: {
			id: "cfg_root",
			displayName: "Account default",
			revision: 5,
			kind: "account_default",
			identity: { kind: "account_default" },
		},
		kind: "custom",
		identity: { kind: "custom", name: "Shared sampling" },
		...overrides,
	} as InferenceConfigurationSummary;
}

function botSummary(handle: string, worldHandle: string, worldId: string): InferenceConfigurationSummary {
	return summary({
		id: `cfg_${handle}`,
		displayName: `u/${handle}`,
		kind: "bot",
		identity: {
			kind: "bot",
			botId: `bot_${handle}`,
			botHandle: handle,
			homeWorldId: worldId,
			homeWorldHandle: worldHandle,
		},
	});
}

describe("library listing requests", () => {
	it("asks the server for each bounded section with the current search and cursor", () => {
		expect(librarySectionPath("custom")).toBe("/api/me/inference-configurations?section=custom");
		expect(librarySectionPath("bot", { query: " scout ", cursor: "abc", limit: 25 })).toBe(
			"/api/me/inference-configurations?section=bot&q=scout&cursor=abc&limit=25",
		);
		expect(parentCandidatesPath("cfg_one", { query: "acc" })).toBe(
			"/api/me/inference-configurations/cfg_one/parent-candidates?q=acc",
		);
		expect(translationCandidatesPath({ cursor: "next" })).toBe("/api/me/inference-translation/candidates?cursor=next");
	});
});

describe("participant grouping", () => {
	it("groups participants under the home worlds the server counted", () => {
		const groups: InferenceBotHomeWorldGroup[] = [
			{ homeWorldId: "wld_b", homeWorldHandle: "beta", displayName: "w/beta", botConfigurationCount: 110 },
			{ homeWorldId: "wld_a", homeWorldHandle: "alpha", displayName: "w/alpha", botConfigurationCount: 3 },
		];
		const grouped = groupBotSummaries(
			[botSummary("scout", "beta", "wld_b"), botSummary("archivist", "alpha", "wld_a")],
			groups,
		);
		expect(grouped.map((group) => group.displayName)).toEqual(["w/alpha", "w/beta"]);
		expect(grouped[0]?.items.map((item) => item.displayName)).toEqual(["u/archivist"]);
		// The per-world total is the server's, not the loaded page length.
		expect(grouped[1]?.botConfigurationCount).toBe(110);
	});

	it("never turns a world's own fixed configuration into a participant group", () => {
		const worldEntry = summary({
			id: "cfg_world",
			displayName: "w/alpha",
			kind: "world",
			identity: { kind: "world", worldId: "wld_a", worldHandle: "alpha" },
		});
		expect(groupBotSummaries([worldEntry], [])).toEqual([]);
	});

	it("still groups a participant whose home world the count query did not return", () => {
		const grouped = groupBotSummaries([botSummary("scout", "beta", "wld_b")], []);
		expect(grouped).toHaveLength(1);
		expect(grouped[0]).toMatchObject({ displayName: "w/beta", botConfigurationCount: 1 });
	});
});

describe("typed create errors", () => {
	it("explains each typed cause without reading the message text", () => {
		const failure = (cause: string) => ({
			ok: false as const,
			error: "conflict",
			message: "server prose",
			details: { inferenceGraphCause: cause as never },
		});
		expect(createErrorMessage(failure("duplicate_name"))).toContain("already have a custom configuration");
		expect(createErrorMessage(failure("quota_exceeded"))).toContain("configuration limit");
		expect(createErrorMessage(failure("invalid_parent"))).toContain("no longer available");
		expect(createErrorMessage({ ok: false, error: "server_error", message: "server prose" })).toBe("server prose");
	});
});

describe("library rendering", () => {
	it("orders custom configurations before the fixed sections", () => {
		const html = renderToStaticMarkup(<InferenceLibraryScreen onNavigate={() => undefined} />);
		expect(html).toContain("Inference library");
		expect(html).toContain("flows through every child immediately");
		expect(html.indexOf("Custom configurations")).toBeLessThan(html.indexOf("Account, world, and bot configurations"));
		expect(html.indexOf("Account default")).toBeLessThan(html.indexOf("Owned worlds"));
		expect(html.indexOf("Owned worlds")).toBeLessThan(html.indexOf("Participants by home world"));
		expect(html).toContain("New configuration");
		// The library reuses the grouping treatment only: no selection, bulk
		// actions, spend, tick, or loop-status columns come with it.
		expect(html).not.toContain("Run tick");
		expect(html).not.toContain("Spend");
	});

	it("links a summary row to its editor and its parent, with redacted availability", () => {
		const html = renderToStaticMarkup(
			<ul>
				<ConfigurationSummaryRow summary={summary()} />
			</ul>,
		);
		expect(html).toContain('href="/me/inference/cfg_one"');
		expect(html).toContain('href="/me/inference/cfg_root"');
		expect(html).toContain("anthropic/claude-opus-4");
		expect(html).toContain("key available");
		expect(html).toContain("2 children");
	});

	it("carries a return target into every configuration link", () => {
		const html = renderToStaticMarkup(
			<ul>
				<ConfigurationSummaryRow returnTo={{ route: "profile" }} summary={summary()} />
			</ul>,
		);
		expect(html).toContain('href="/me/inference/cfg_one?from=%2Fme%2Fprofile"');
	});
});
