import { describe, expect, it } from "vitest";
import {
	applyInferenceOverridePatch,
	assertInferenceOverridesAllowedForKind,
	defaultBickrInferenceDefaults,
	inferenceFieldAnnotations,
	inferenceResolutionFingerprint,
	ownerInferenceOverride,
	parseInferenceConfigurationOverridePatch,
	parseInferenceConfigurationOverrides,
	parseStoredInferenceConfigurationOverrides,
	resolveImageSettingsForTarget,
	resolveInferenceConfiguration,
	type InferenceConfigurationNode,
	type InferenceConfigurationOverrides,
} from "./inference-configuration";
import { defaultProviderModel } from "./model";

describe("canonical inference configuration resolution", () => {
	it("resolves arbitrary-depth fields independently and preserves falsy, empty, and equal explicit values", () => {
		const account = node("account", "account_default", null, {
			temperature: value(0.7),
			supportsPrefill: value(true),
			providerRouting: value({ order: ["openai"] }),
		});
		const parent = node("parent", "custom", account.id, {
			temperature: value(0),
			supportsPrefill: value(false),
			providerRouting: value({}),
		});
		const selected = node("selected", "custom", parent.id, {
			// Equality does not collapse explicit intent back to inheritance.
			temperature: value(0),
		});
		const resolution = resolveInferenceConfiguration([selected, parent, account]);

		expect(resolution.raw.temperature).toMatchObject({
			state: "value",
			value: 0,
			provenance: {
				kind: "configured",
				source: { kind: "configuration", configurationId: selected.id, depth: 0 },
			},
			override: { kind: "value", value: 0 },
		});
		expect(resolution.raw.supportsPrefill).toMatchObject({ state: "value", value: false });
		expect(resolution.raw.providerRouting).toMatchObject({ state: "value", value: {} });
		expect(resolution.effective.temperature).toBe(0);
	});

	it("keeps prefill opt-in unset, inherited On, local clamps, and explicit Off distinct", () => {
		const empty = node("empty", "account_default", null, {});
		const unset = resolveInferenceConfiguration([empty]);
		expect(unset.raw.supportsPrefill).toEqual({
			state: "absent",
			provenance: { kind: "unset" },
			override: null,
		});
		expect(unset.effective.prefillPolicy).toEqual({
			request: null,
			reasoningShape: "provider_default",
			applied: false,
			adjustment: null,
			capability: null,
		});
		expect(unset.effective.prefillIntent).toEqual({ kind: "inherit" });

		const customAccount = node("custom-account", "account_default", null, {
			baseUrl: value("https://provider.example/v1"),
			model: value("provider/model"),
			supportsPrefill: value(true),
		});
		const inheritedChild = node("child", "custom", customAccount.id, {});
		const inherited = resolveInferenceConfiguration([inheritedChild, customAccount]);
		expect(inherited.raw.supportsPrefill).toMatchObject({
			state: "value",
			value: true,
			provenance: { kind: "configured", source: { kind: "account_default", depth: 1 } },
		});
		expect(inherited.effective.prefillPolicy).toMatchObject({ request: true, applied: true, adjustment: null });
		expect(inherited.effective.prefillIntent).toEqual({ kind: "explicit", enabled: true });

		const unsupported = node("unsupported", "account_default", null, {
			reasoning: value({ kind: "reasoning_disabled" }),
			supportsPrefill: value(true),
		});
		const clamped = resolveInferenceConfiguration([unsupported], {
			defaults: {
				...defaultBickrInferenceDefaults,
				fields: {
					...defaultBickrInferenceDefaults.fields,
					model: "deepseek/deepseek-v4-flash-0731",
				},
			},
		});
		expect(clamped.effective.prefillPolicy).toMatchObject({
			request: true,
			reasoningShape: "reasoning_off",
			applied: false,
			adjustment: "prefill_unsupported",
		});

		const explicitOff = node("off", "custom", customAccount.id, { supportsPrefill: value(false) });
		expect(resolveInferenceConfiguration([explicitOff, customAccount]).effective.prefillPolicy).toEqual({
			request: false,
			reasoningShape: "reasoning_on",
			applied: false,
			adjustment: null,
			capability: null,
		});
	});

	it("keeps normal and compaction reasoning independent", () => {
		const account = node("account", "account_default", null, {
			reasoning: value({ kind: "explicit_effort", effort: "high" }),
			compactionReasoning: value({ kind: "reasoning_disabled" }),
		});
		const selected = node("selected", "custom", account.id, {
			reasoning: value({ kind: "reasoning_disabled" }),
			compactionReasoning: value({ kind: "explicit_effort", effort: "low" }),
			baseUrl: value("https://custom.example/v1"),
			model: value("custom/reasoner"),
		});
		const resolution = resolveInferenceConfiguration([selected, account]);

		expect(resolution.effective.reasoningEffort).toBe("none");
		// The permissive custom-provider policy advertises a minimal default
		// effort, which establishes reasoning support; monotonic effort support
		// then serves the stronger explicit request as configured.
		expect(resolution.effective.compactionReasoning).toMatchObject({
			kind: "selected",
			selection: { kind: "explicit_effort", effort: "low" },
			provenance: {
				configuration: { kind: "explicit_effort", effort: "low" },
			},
		});
	});

	it("keeps an unset global compaction request distinct from a high model-default decision", () => {
		expect(defaultBickrInferenceDefaults.fields).not.toHaveProperty("compactionReasoning");
		const account = node("account", "account_default", null, {});
		const defaults = {
			...defaultBickrInferenceDefaults,
			fields: {
				...defaultBickrInferenceDefaults.fields,
				model: "deepseek/deepseek-v4-flash-0731",
			},
		};
		const resolution = resolveInferenceConfiguration([account], { defaults });

		expect(resolution.raw.compactionReasoning).toEqual({
			state: "absent",
			provenance: { kind: "unset" },
			override: null,
		});
		expect(resolution.effective.compactionReasoning).toMatchObject({
			kind: "selected",
			decision: {
				kind: "model_default",
				modelDefault: { kind: "explicit_effort", effort: "high" },
			},
			selection: { kind: "model_default", effort: "high" },
			provenance: { configuration: null },
		});
		expect(inferenceFieldAnnotations(account.overrides, resolution).compactionReasoning).toMatchObject({
			provenance: { kind: "unset" },
			effective: {
				kind: "selected",
				decision: { kind: "model_default" },
				selection: { kind: "model_default", effort: "high" },
			},
		});
	});

	it("keeps an inherited compaction request source separate from the applied policy decision", () => {
		const account = node("account", "account_default", null, {
			compactionReasoning: value({ kind: "explicit_effort", effort: "low" }),
		});
		const selected = node("selected", "custom", account.id, {});
		const resolution = resolveInferenceConfiguration([selected, account], {
			defaults: {
				...defaultBickrInferenceDefaults,
				fields: {
					...defaultBickrInferenceDefaults.fields,
					model: "deepseek/deepseek-v4-flash-0731",
				},
			},
		});

		expect(resolution.raw.compactionReasoning).toMatchObject({
			state: "value",
			value: { kind: "explicit_effort", effort: "low" },
			provenance: {
				kind: "configured",
				source: { kind: "account_default", configurationId: account.id, depth: 1 },
			},
		});
		expect(resolution.effective.compactionReasoning).toMatchObject({
			kind: "selected",
			decision: { kind: "configuration" },
			selection: { kind: "explicit_effort", effort: "low" },
			provenance: { configuration: { kind: "explicit_effort", effort: "low" } },
		});
	});

	it("keeps Bickr automatic, provider omission, and explicit request intent distinct", () => {
		const account = node("account", "account_default", null, {});
		const automatic = node("automatic", "custom", account.id, {
			reasoning: value({ kind: "bickr_automatic" }),
			toolCalls: value({ kind: "bickr_automatic" }),
		});
		const automaticResolution = resolveInferenceConfiguration([automatic, account]);
		expect(automaticResolution.raw.reasoning).toMatchObject({ state: "value", value: { kind: "bickr_automatic" } });
		expect(automaticResolution.effective.ordinaryLoopToolCalls).toMatchObject({
			intent: { kind: "bickr_automatic" }, emission: "emit_tool_choice",
		});

		const providerDefault = node("provider", "custom", account.id, {
			reasoning: value({ kind: "provider_default" }),
			toolCalls: value({ kind: "provider_default" }),
		});
		const providerResolution = resolveInferenceConfiguration([providerDefault, account]);
		expect(providerResolution.effective.reasoningEffort).toBeUndefined();
		expect(providerResolution.effective.ordinaryLoopToolCalls).toMatchObject({
			intent: { kind: "provider_default" },
			reasoningShape: "provider_default",
			appliedStrategy: "at_will",
			emission: "omit_tool_choice",
			capability: null,
		});
		const inherited = resolveInferenceConfiguration([account]);
		expect(inherited.raw.toolCalls).toMatchObject({ state: "absent", provenance: { kind: "unset" } });
		expect(inherited.effective).toMatchObject({
			reasoningIntent: { kind: "inherit" },
			toolCallIntent: { kind: "inherit" },
			promptCacheIntent: { kind: "inherit" },
			ordinaryLoopToolCalls: { intent: { kind: "inherit" }, emission: "emit_tool_choice" },
		});
	});

	it("attributes every all-inherited policy outcome without manufacturing raw configuration", () => {
		const account = node("account", "account_default", null, {});
		const resolution = resolveInferenceConfiguration([account]);
		const fields = inferenceFieldAnnotations({}, resolution);

		for (const field of ["reasoning", "compactionMode", "promptCacheMode"] as const) {
			expect(fields[field]).toMatchObject({
				request: { kind: "unset" },
				provenance: { kind: "unset" },
				adjustment: { kind: "bickr_automatic", effective: fields[field].effective },
				inherited: {
					request: { kind: "unset" },
					provenance: { kind: "unset" },
					adjustment: { kind: "bickr_automatic", effective: fields[field].effective },
				},
			});
		}
		expect(fields.toolCalls.adjustment).toMatchObject({
			kind: "tool_call_policy",
			policy: { intent: { kind: "inherit" }, emission: "emit_tool_choice" },
		});
		expect(fields.supportsPrefill.adjustment).toMatchObject({
			kind: "prefill_policy",
			policy: { request: null, applied: false },
		});
		expect(fields.compactionReasoning).toMatchObject({
			request: { kind: "unset" },
			provenance: { kind: "unset" },
			adjustment: { kind: "compaction_policy" },
		});
	});

	it("falls back from an unauthorized explicit model without mutating raw intent", () => {
		const account = node("account", "account_default", null, {});
		const selected = node("selected", "custom", account.id, {
			model: value("openai/gpt-4.1"),
		});
		const resolution = resolveInferenceConfiguration([selected, account]);

		expect(resolution.raw.model).toMatchObject({
			state: "value",
			value: "openai/gpt-4.1",
			provenance: {
				kind: "configured",
				source: { kind: "configuration", configurationId: selected.id },
			},
		});
		expect(resolution.effective.model).toBe("openrouter/free");
		expect(resolution.providerAuthorizationAdjustment).toMatchObject({
			kind: "model_fell_back",
			requestedModel: "openai/gpt-4.1",
			effectiveModel: "openrouter/free",
			reason: "owner_provider_unavailable",
		});
	});

	it("does not authorize an account model through a child with no owner provider", () => {
		const child = node("child", "custom", "account", {
			model: value("owner/child-model"),
		});
		const account = node("account", "account_default", null, {
			model: value("owner/account-model"),
		});
		const resolution = resolveInferenceConfiguration([child, account]);

		expect(resolution.raw.model).toMatchObject({
			state: "value",
			value: "owner/child-model",
			provenance: {
				kind: "configured",
				source: { kind: "configuration", configurationId: "child" },
			},
		});
		expect(resolution.effective.model).toBe(defaultProviderModel);
		expect(resolution.providerAuthorizationAdjustment).toMatchObject({
			kind: "model_fell_back",
			requestedModel: "owner/child-model",
			effectiveModel: defaultProviderModel,
			reason: "owner_provider_unavailable",
		});
	});

	it("authorizes a stored model through inherited saved credentials without exposing their text", async () => {
		const account = node("account", "account_default", null, {}, {
			mode: "value",
			secretVersion: 7,
			secret: "sk-owner-secret",
		});
		const selected = node("selected", "custom", account.id, {
			model: value("openai/gpt-4.1"),
		});
		const resolution = resolveInferenceConfiguration([selected, account]);

		expect(resolution.effective.model).toBe("openai/gpt-4.1");
		expect(resolution.effective.credential).toMatchObject({
			kind: "available",
			secretVersion: 7,
			secret: "sk-owner-secret",
		});
		const fingerprint = await inferenceResolutionFingerprint(resolution);
		expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
		expect(fingerprint).not.toContain("sk-owner-secret");
	});

	it("suppresses the deployment credential for every owner-sourced base URL", async () => {
		const account = node("account", "account_default", null, {
			baseUrl: value("https://deployment.example/v1"),
			model: value("owner/model"),
		});
		const resolution = resolveInferenceConfiguration([account], {
			defaults: {
				fields: { baseUrl: "https://deployment.example/v1", model: "deployment/model", temperature: 1 },
				credential: "deployment-secret",
				credentialVersion: 9,
			},
		});
		expect(resolution.effective.credential).toEqual({
			kind: "unavailable",
			source: { kind: "bickr_default" },
			reason: "deployment_credential_suppressed_for_owner_base_url",
		});
		expect(JSON.stringify(resolution)).not.toContain("deployment-secret");
		const rotated = resolveInferenceConfiguration([account], {
			defaults: {
				fields: { baseUrl: "https://deployment.example/v1", model: "deployment/model", temperature: 1 },
				credential: "rotated-deployment-secret",
				credentialVersion: 10,
			},
		});
		expect(await inferenceResolutionFingerprint(resolution))
			.toBe(await inferenceResolutionFingerprint(rotated));
	});

	it("lets non-root entries bypass intervening credentials at Account default", () => {
		const account = node("account", "account_default", null, {}, {
			mode: "value", secretVersion: 3, secret: "account-secret",
		});
		const parent = node("parent", "custom", account.id, {}, {
			mode: "value", secretVersion: 4, secret: "parent-secret",
		});
		const selected = node("selected", "custom", parent.id, {}, {
			mode: "account_default", secretVersion: 0,
		});
		expect(resolveInferenceConfiguration([selected, parent, account]).effective.credential).toMatchObject({
			kind: "available",
			source: { kind: "account_default", configurationId: account.id },
			secret: "account-secret",
		});
		const invalidRoot = node("invalid", "account_default", null, {}, {
			mode: "account_default", secretVersion: 0,
		});
		expect(() => resolveInferenceConfiguration([invalidRoot])).toThrow("cannot use Account-default credential mode");
	});

	it("keeps explicit image absence raw and applies target defaults only for ordinary absence", () => {
		const account = node("account", "account_default", null, {});
		const inherited = resolveInferenceConfiguration([account]);
		expect(resolveImageSettingsForTarget(inherited.effective.image, "participant").aspectRatio).toBe("1:1");
		expect(resolveImageSettingsForTarget(inherited.effective.image, "world").aspectRatio).toBe("21:9");

		const selected = node("selected", "custom", account.id, {
			imageAspectRatio: { kind: "explicit_none" },
		});
		const absent = resolveInferenceConfiguration([selected, account]);
		expect(absent.raw.imageAspectRatio).toMatchObject({ state: "explicit_none" });
		expect(resolveImageSettingsForTarget(absent.effective.image, "participant")).not.toHaveProperty("aspectRatio");
		expect(resolveImageSettingsForTarget(absent.effective.image, "world")).not.toHaveProperty("aspectRatio");
	});

	it("stores target-default image intent without baking in a reusable target", () => {
		const account = node("account", "account_default", null, {});
		const selected = node("selected", "custom", account.id, {
			imageModel: { kind: "target_default" },
			imageAspectRatio: { kind: "target_default" },
			imageSize: { kind: "target_default" },
			imageTemperature: value(0.44),
			imageTopK: { kind: "explicit_none" },
		});
		const resolution = resolveInferenceConfiguration([selected, account]);
		expect(resolution.raw.imageAspectRatio).toMatchObject({ state: "target_default" });
		expect(resolveImageSettingsForTarget(resolution.effective.image, "participant")).toMatchObject({
			model: "google/gemini-3.1-flash-image", aspectRatio: "1:1", imageSize: "1K", temperature: 0.44,
		});
		expect(resolveImageSettingsForTarget(resolution.effective.image, "world")).toMatchObject({
			model: "google/gemini-3.1-flash-image", aspectRatio: "21:9", imageSize: "1K", temperature: 0.44,
		});

		const custom = node("custom", "custom", account.id, {
			imageModel: value("owner/custom-image-model"),
			imageAspectRatio: { kind: "target_default" },
			imageSize: { kind: "target_default" },
		});
		const customPreview = resolveImageSettingsForTarget(
			resolveInferenceConfiguration([custom, account]).effective.image,
			"participant",
		);
		expect(customPreview).toEqual({ model: "owner/custom-image-model" });
	});

	it("round-trips only an exact historical Bickr image default with Bickr provenance", () => {
		const historicalModel = "google/gemini-3.1-flash-image-preview";
		const stored = parseStoredInferenceConfigurationOverrides(JSON.stringify({
			imageModel: { kind: "historical_bickr_default", value: historicalModel },
		}));
		expect(stored).toEqual({
			imageModel: { kind: "historical_bickr_default", value: historicalModel },
		});
		expect(() => parseInferenceConfigurationOverrides(stored)).toThrow("Invalid override for inference field imageModel");
		expect(() => parseInferenceConfigurationOverridePatch(stored)).toThrow("Invalid override for inference field imageModel");
		for (const nearMiss of [
			"Google/gemini-3.1-flash-image-preview",
			"google/gemini-3.1-flash-image-preview:free",
			"google/gemini-3.1-flash-image-preview ",
		]) {
			expect(() => parseStoredInferenceConfigurationOverrides({
				imageModel: { kind: "historical_bickr_default", value: nearMiss },
			})).toThrow("Invalid override for inference field imageModel");
		}

		const account = node("account", "account_default", null, {});
		const selected = node("selected", "custom", account.id, stored);
		const resolution = resolveInferenceConfiguration([selected, account], {
			defaults: {
				fields: { baseUrl: "https://deployment.example/v1", model: "deployment/model", temperature: 1 },
				credential: "deployment-secret",
				credentialVersion: 1,
			},
		});
		expect(resolution.raw.imageModel).toMatchObject({
			state: "value",
			value: historicalModel,
			provenance: { kind: "configured", source: { kind: "bickr_default" } },
			override: { kind: "historical_bickr_default", value: historicalModel },
		});
		expect(resolveImageSettingsForTarget(resolution.effective.image, "participant").model).toBe(historicalModel);
		expect(ownerInferenceOverride("imageModel", stored.imageModel)).toEqual({ kind: "value", value: historicalModel });

		expect(applyInferenceOverridePatch(stored, { temperature: value(0.25) }).imageModel).toEqual(stored.imageModel);
		expect(applyInferenceOverridePatch(stored, { imageModel: value(historicalModel) }).imageModel).toEqual(stored.imageModel);
		expect(applyInferenceOverridePatch(stored, { imageModel: value("owner/new-image") }).imageModel)
			.toEqual({ kind: "value", value: "owner/new-image" });
	});

	it("validates the discriminated storage and update protocols exhaustively", () => {
		expect(parseInferenceConfigurationOverrides(JSON.stringify({
			supportsPrefill: { kind: "value", value: false },
			topK: { kind: "value", value: 0 },
			providerRouting: { kind: "value", value: {} },
			imageModel: { kind: "target_default" },
		}))).toEqual({
			supportsPrefill: { kind: "value", value: false },
			topK: { kind: "value", value: 0 },
			providerRouting: { kind: "value", value: {} },
			imageModel: { kind: "target_default" },
		});
		expect(() => parseInferenceConfigurationOverrides({ imageTemperature: { kind: "target_default" } }))
			.toThrow("Invalid override for inference field imageTemperature");
		expect(() => parseInferenceConfigurationOverrides({
			reasoning: { kind: "explicit_none" },
		})).toThrow("Invalid override for inference field reasoning");
		expect(() => parseInferenceConfigurationOverrides({ unknown: { kind: "value", value: 1 } }))
			.toThrow("Unknown inference configuration field");
		expect(applyInferenceOverridePatch({ temperature: value(0.2) }, {
			temperature: { kind: "inherit" },
			topP: value(0),
		})).toEqual({ topP: value(0) });
		expect(() => parseInferenceConfigurationOverridePatch({
			temperature: { kind: "inherit", extra: true },
		})).toThrow("Invalid override for inference field temperature");
		expect(() => parseInferenceConfigurationOverrides({ temperature: value(2.01) })).toThrow();
		expect(() => parseInferenceConfigurationOverrides({ topP: value(-0.01) })).toThrow();
		expect(() => parseInferenceConfigurationOverrides({ imageFrequencyPenalty: value(2.01) })).toThrow();
		expect(parseInferenceConfigurationOverrides({
			topK: value(1.5),
			imageTopK: value(2.5),
		})).toMatchObject({
			topK: value(1.5),
			imageTopK: value(2.5),
		});
		const legacyCompactionDefault = {
			compactionMode: { kind: "value", value: { kind: "provider_default" } },
		} as const;
		expect(parseStoredInferenceConfigurationOverrides(legacyCompactionDefault)).toEqual(legacyCompactionDefault);
		expect(() => parseInferenceConfigurationOverrides(legacyCompactionDefault))
			.toThrow("Invalid canonical compaction mode request");
		expect(() => parseInferenceConfigurationOverridePatch(legacyCompactionDefault))
			.toThrow("Invalid canonical compaction mode request");
		const legacyAccount = node("legacy-account", "account_default", null, legacyCompactionDefault);
		const legacyResolution = resolveInferenceConfiguration([legacyAccount]);
		expect(inferenceFieldAnnotations(legacyCompactionDefault, legacyResolution).compactionMode).toMatchObject({
			override: { kind: "value", value: { kind: "bickr_automatic" } },
			request: { kind: "value", value: { kind: "bickr_automatic" } },
			adjustment: { kind: "bickr_automatic" },
		});
	});

	it("rejects broken, cyclic, and non-Account-default path endings", () => {
		const account = node("account", "account_default", null, {});
		const selected = node("selected", "custom", "missing", {});
		expect(() => resolveInferenceConfiguration([selected, account])).toThrow("broken parent edge");
		const cycleStart = node("cycle-start", "custom", "cycle-parent", {});
		const cycleParent = node("cycle-parent", "custom", cycleStart.id, {});
		expect(() => resolveInferenceConfiguration([cycleStart, cycleParent, cycleStart])).toThrow("cycle");
		expect(() => resolveInferenceConfiguration([selected])).toThrow("does not end at Account default");
	});

	it("resumes the Account-default base URL at the root while keeping the real source provenance", () => {
		const deploymentDefaults = {
			fields: { baseUrl: "https://deployment.example/v1", model: "deployment/model", temperature: 1 },
			credential: "deployment-secret",
			credentialVersion: 1,
		};
		const account = node("account", "account_default", null, {});
		const source = node("source", "custom", account.id, {
			baseUrl: value("https://source.example/v1"),
			model: value("source/model"),
		}, { mode: "value", secretVersion: 1, secret: "source-secret" });
		const clone = node("clone", "custom", source.id, {
			baseUrl: { kind: "account_default" },
			model: value("clone/model"),
		}, { mode: "account_default", secretVersion: 0 });

		const resolution = resolveInferenceConfiguration([clone, source, account], { defaults: deploymentDefaults });

		// The jump skipped the source entirely and landed on the deployment
		// default, which keeps Bickr provenance rather than becoming owner-chosen.
		expect(resolution.raw.baseUrl).toMatchObject({
			state: "value",
			value: "https://deployment.example/v1",
			provenance: { kind: "configured", source: { kind: "bickr_default" } },
			override: null,
		});
		expect(resolution.effective.credential).toMatchObject({
			kind: "available",
			source: { kind: "bickr_default" },
			secret: "deployment-secret",
		});
		// A deployment-provenance provider cannot authorize an owner-chosen model.
		expect(resolution.effective.model).toBe("deployment/model");
		expect(resolution.providerAuthorizationAdjustment).toMatchObject({
			kind: "model_fell_back",
			requestedModel: "clone/model",
			reason: "owner_provider_unavailable",
		});
	});

	it("resumes at an Account-default base URL value and suppresses the deployment credential there", () => {
		const deploymentDefaults = {
			fields: { baseUrl: "https://deployment.example/v1", model: "deployment/model", temperature: 1 },
			credential: "deployment-secret",
			credentialVersion: 1,
		};
		const account = node("account", "account_default", null, { baseUrl: value("https://account.example/v1") });
		const source = node("source", "custom", account.id, {
			baseUrl: value("https://source.example/v1"),
		}, { mode: "value", secretVersion: 1, secret: "source-secret" });
		const clone = node("clone", "custom", source.id, {
			baseUrl: { kind: "account_default" },
			model: value("clone/model"),
		}, { mode: "account_default", secretVersion: 0 });

		const resolution = resolveInferenceConfiguration([clone, source, account], { defaults: deploymentDefaults });

		expect(resolution.effective.baseUrl).toBe("https://account.example/v1");
		expect(resolution.raw.baseUrl.provenance).toMatchObject({
			kind: "configured",
			source: { kind: "account_default", configurationId: account.id },
		});
		expect(resolution.effective.credential).toMatchObject({
			kind: "unavailable",
			reason: "deployment_credential_suppressed_for_owner_base_url",
		});
		// The owner base URL authorizes the owner's own model even with no key.
		expect(resolution.effective.model).toBe("clone/model");
		expect(resolution.providerAuthorizationAdjustment).toBeNull();
	});

	it("decides provenance by source, not by base-URL string equality", () => {
		const deploymentDefaults = {
			fields: { baseUrl: "https://deployment.example/v1", model: "deployment/model", temperature: 1 },
			credential: "deployment-secret",
			credentialVersion: 1,
		};
		const account = node("account", "account_default", null, {});
		// This entry stores exactly the deployment URL as an owner value.
		const owner = node("owner", "custom", account.id, {
			baseUrl: value("https://deployment.example/v1"),
			model: value("owner/model"),
		});
		const resumed = node("resumed", "custom", owner.id, {
			baseUrl: { kind: "account_default" },
			model: value("owner/model"),
		}, { mode: "account_default", secretVersion: 0 });

		const ownerResolution = resolveInferenceConfiguration([owner, account], { defaults: deploymentDefaults });
		const resumedResolution = resolveInferenceConfiguration([resumed, owner, account], { defaults: deploymentDefaults });

		expect(ownerResolution.effective.baseUrl).toBe(resumedResolution.effective.baseUrl);
		expect(ownerResolution.effective.credential).toMatchObject({
			kind: "unavailable",
			reason: "deployment_credential_suppressed_for_owner_base_url",
		});
		expect(resumedResolution.effective.credential).toMatchObject({ kind: "available", source: { kind: "bickr_default" } });
	});

	it("accepts the Account-default state only for base URL and never on Account default", () => {
		expect(parseInferenceConfigurationOverrides(JSON.stringify({ baseUrl: { kind: "account_default" } })))
			.toEqual({ baseUrl: { kind: "account_default" } });
		expect(parseInferenceConfigurationOverridePatch({ baseUrl: { kind: "account_default" } }))
			.toEqual({ baseUrl: { kind: "account_default" } });
		expect(() => parseInferenceConfigurationOverrides(JSON.stringify({ model: { kind: "account_default" } })))
			.toThrow("Invalid override for inference field model");
		expect(() => parseInferenceConfigurationOverrides(JSON.stringify({ imageModel: { kind: "account_default" } })))
			.toThrow("Invalid override for inference field imageModel");
		expect(() => parseInferenceConfigurationOverrides(JSON.stringify({ baseUrl: { kind: "account_default", value: "x" } })))
			.toThrow("Invalid override for inference field baseUrl");

		const account = node("account", "account_default", null, { baseUrl: { kind: "account_default" } });
		const selected = node("selected", "custom", account.id, {});
		expect(() => resolveInferenceConfiguration([selected, account]))
			.toThrow("Account default cannot use the Account-default state for baseUrl");
		expect(() => assertInferenceOverridesAllowedForKind("account_default", { baseUrl: { kind: "account_default" } }))
			.toThrow("Account default cannot use the Account-default state for baseUrl");
		expect(() => assertInferenceOverridesAllowedForKind("custom", { baseUrl: { kind: "account_default" } })).not.toThrow();
	});
});

function value<T>(input: T): { kind: "value"; value: T } {
	return { kind: "value", value: input };
}

function node(
	id: string,
	kind: "account_default" | "custom",
	parentId: string | null,
	overrides: InferenceConfigurationOverrides,
	credential: InferenceConfigurationNode["credential"] = { mode: "inherit", secretVersion: 0 },
): InferenceConfigurationNode {
	const common = {
		id,
		ownerUserId: "usr_owner",
		parentId,
		overrides,
		revision: 1,
		createdAt: "2026-08-04T00:00:00.000Z",
		updatedAt: "2026-08-04T00:00:00.000Z",
		credential,
	};
	return kind === "account_default"
		? { ...common, kind }
		: { ...common, kind, name: id, nameKey: id };
}
