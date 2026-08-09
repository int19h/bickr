import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RedactedInferenceConfigurationDto } from "@bickr/shared/inference-configuration-owner";
import { fixedConfigurationPath } from "./api";
import { BotInferenceConfigurationAction, ConfigurationCardBody, ConfigurationLinkCard } from "./links";
import { inferenceEditorFields } from "./field-model";

function dto(): RedactedInferenceConfigurationDto {
	return {
		id: "cfg_bot",
		kind: "bot",
		identity: {
			kind: "bot",
			botId: "bot_scout",
			botHandle: "scout",
			homeWorldId: "wld_one",
			homeWorldHandle: "patch-notes",
		},
		parentId: "cfg_root",
		displayName: "u/scout",
		revision: 3,
		overrides: {},
		credential: {
			mode: "inherit",
			available: true,
			secretVersion: 0,
			resolution: { kind: "available", source: { kind: "account_default", configurationId: "cfg_root", depth: 1 }, secretVersion: 2 },
		},
		effectiveModel: "anthropic/claude-opus-4",
		imagePreviews: { participant: { model: "image/one", aspectRatio: "1:1" }, world: { model: "image/one", aspectRatio: "21:9" } },
		path: [
			{ id: "cfg_bot", displayName: "u/scout", revision: 3, kind: "bot", identity: { kind: "bot", botId: "bot_scout", botHandle: "scout", homeWorldId: "wld_one", homeWorldHandle: "patch-notes" } },
			{ id: "cfg_root", displayName: "Account default", revision: 7, kind: "account_default", identity: { kind: "account_default" } },
		],
		fields: Object.fromEntries(
			inferenceEditorFields.map((field) => [field, {
				override: { kind: "inherit" },
				effective: null,
				source: { kind: "bickr_default" },
				adjustment: null,
			}]),
		) as RedactedInferenceConfigurationDto["fields"],
		graphRevision: 12,
		fingerprint: "fp",
	} as RedactedInferenceConfigurationDto;
}

describe("fixed configuration addressing", () => {
	// The browser names the entity a settings screen already displays and lets
	// the server authorize it; it must never compute a configuration id.
	it("asks the owner-authenticated lookup for each entity kind", () => {
		expect(fixedConfigurationPath({ kind: "account_default" })).toBe(
			"/api/me/inference-configurations/fixed/account_default",
		);
		expect(fixedConfigurationPath({ kind: "world", worldId: "wld one/../x" })).toBe(
			"/api/me/inference-configurations/fixed/world/wld%20one%2F..%2Fx",
		);
		expect(fixedConfigurationPath({ kind: "bot", botId: "bot_scout" })).toBe(
			"/api/me/inference-configurations/fixed/bot/bot_scout",
		);
	});
});

describe("configuration link card", () => {
	it("shows the effective model, parent, and redacted credential status", () => {
		const html = renderToStaticMarkup(<ConfigurationCardBody configuration={dto()} />);
		expect(html).toContain('href="/me/inference/cfg_bot"');
		expect(html).toContain("u/scout");
		expect(html).toContain("anthropic/claude-opus-4");
		expect(html).toContain('href="/me/inference/cfg_root"');
		expect(html).toContain("Account default");
		expect(html).toContain("A saved key from Account default is in effect.");
		expect(html).not.toContain("secretVersion");
	});

	it("carries the return target into the linked editor", () => {
		const html = renderToStaticMarkup(
			<ConfigurationCardBody configuration={dto()} returnTo={{ route: "bot-edit", worldHandle: "patch-notes", botHandle: "scout" }} />,
		);
		expect(html).toContain('href="/me/inference/cfg_bot?from=%2Fw%2Fpatch-notes%2Fu%2Fscout%2Fedit"');
	});

	it("explains an account that has no graph yet instead of failing silently", () => {
		const html = renderToStaticMarkup(
			<ConfigurationLinkCard
				description="Linked configuration."
				state={{
					configuration: null,
					error: { ok: false, error: "conflict", message: "Inference configuration graph is not available for this account." },
					loading: false,
					reload: () => undefined,
				}}
				title="Inference configuration"
			/>,
		);
		expect(html).toContain("has not been moved onto inference configurations yet");
	});

	it("reports a typed failure from the lookup rather than an empty card", () => {
		const html = renderToStaticMarkup(
			<ConfigurationLinkCard
				description="Linked configuration."
				state={{
					configuration: null,
					error: { ok: false, error: "not_found", message: "Participant not found." },
					loading: false,
					reload: () => undefined,
				}}
				title="Inference configuration"
			/>,
		);
		expect(html).toContain("Participant not found.");
	});
});

describe("bot inference configuration action", () => {
	it("renders a named disabled action while the fixed configuration is loading", () => {
		const html = renderToStaticMarkup(
			<BotInferenceConfigurationAction
				botHandle="scout"
				state={{ configuration: null, error: null, loading: true, reload: () => undefined }}
				worldHandle="patch-notes"
			/>,
		);
		expect(html).toContain("Open inference configuration for u/scout");
		expect(html).toMatch(/<button[^>]*disabled=""/);
		expect(html).not.toContain("href=");
	});

	it("keeps the action disabled and explains an unavailable graph", () => {
		const html = renderToStaticMarkup(
			<BotInferenceConfigurationAction
				botHandle="scout"
				state={{
					configuration: null,
					error: { ok: false, error: "conflict", message: "Inference configuration graph is not available for this account." },
					loading: false,
					reload: () => undefined,
				}}
				worldHandle="patch-notes"
			/>,
		);
		expect(html).toContain("Open inference configuration for u/scout");
		expect(html).toMatch(/<button[^>]*disabled=""/);
		expect(html).toContain("has not been moved onto inference configurations yet");
	});

	it("uses the loaded configuration id and preserves bot-editor return navigation", () => {
		const html = renderToStaticMarkup(
			<BotInferenceConfigurationAction
				botHandle="scout"
				state={{ configuration: dto(), error: null, loading: false, reload: () => undefined }}
				worldHandle="patch-notes"
			/>,
		);
		expect(html).toContain(
			'href="/me/inference/cfg_bot?from=%2Fw%2Fpatch-notes%2Fu%2Fscout%2Fedit"',
		);
		expect(html).toContain("Open inference configuration for u/scout");
		expect(html).not.toContain("<button");
	});
});
