import { describe, expect, it } from "vitest";
import { env as testEnv } from "cloudflare:test";
import { localizedText, type BotDocument, type LanguageTag, type LocalizedText, type UserDocument } from "../packages/shared/src/model";
import { inferenceConfigurationFields } from "../packages/shared/src/inference-configuration-owner";
import { encodeOpaqueJsonCursor } from "../packages/shared/src/opaque-json-cursor";
import {
	createMcpAuthorizationCode,
	exchangeMcpAuthorizationCode,
	registerMcpClient,
} from "../packages/shared/src/mcp-auth";
import { kvKeys, writeJson, type KVNamespaceLike } from "../packages/shared/src/storage";
import { onRequestGet as onAuthorizationServerGet } from "../apps/web/functions/.well-known/oauth-authorization-server";
import { onRequestGet as onProtectedResourceGet } from "../apps/web/functions/.well-known/oauth-protected-resource";
import { onRequestGet as onPathProtectedResourceGet } from "../apps/web/functions/.well-known/oauth-protected-resource/mcp";
import { mcpToolMetadataForTest, onRequestPost } from "../apps/web/functions/mcp";
import { onRequestPost as onRegisterPost } from "../apps/web/functions/oauth/register";
import { handleAgentRuntimeRequest } from "../workers/agent-runtime/src/routes";
import { listUserBots, listWorldBots } from "../packages/shared/src/repository";
import { clearKv, resetD1Schema } from "./helpers/d1-schema";

type TestPagesContext = Parameters<typeof onRequestPost>[0];
const en = "en" as LanguageTag;

function lt(text: string): LocalizedText {
	return localizedText(text, en);
}

function localized(value: string | LocalizedText | undefined, fallback: string): LocalizedText {
	return typeof value === "string" ? lt(value) : value ?? lt(fallback);
}

function schemaRequired(tools: Map<string, { inputSchema: Record<string, unknown> }>, toolName: string): string[] {
	const schema = tools.get(toolName)?.inputSchema;
	const required = schema ? toolArgumentSchema(schema).required : undefined;
	return Array.isArray(required) ? required.filter((item): item is string => typeof item === "string") : [];
}

function schemaProperty(
	tools: Map<string, { inputSchema: Record<string, unknown> }>,
	toolName: string,
	...path: string[]
): Record<string, unknown> {
	const inputSchema = tools.get(toolName)?.inputSchema;
	let schema = inputSchema ? toolArgumentSchema(inputSchema) : undefined;
	for (const segment of path) {
		if (!schema) {
			throw new Error(`Missing schema for ${toolName}.${path.join(".")}`);
		}
		schema = schemaProperties(schema)[segment] as Record<string, unknown> | undefined;
	}
	if (!schema) {
		throw new Error(`Missing schema for ${toolName}.${path.join(".")}`);
	}
	return schema;
}

function toolArgumentSchema(inputSchema: Record<string, unknown>): Record<string, unknown> {
	const operations = schemaProperties(inputSchema).operations;
	if (!operations || typeof operations !== "object" || Array.isArray(operations)) {
		return inputSchema;
	}
	const items = (operations as Record<string, unknown>).items;
	if (!items || typeof items !== "object" || Array.isArray(items)) {
		throw new Error("Mutation operations schema is missing items.");
	}
	return items as Record<string, unknown>;
}

function expectSchemaAccepts(schema: Record<string, unknown>, value: unknown, path = "result"): void {
	const allowedTypes = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
	const actualType = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
	if (allowedTypes.length > 0) {
		expect(allowedTypes, `${path} type`).toContain(actualType === "number" && Number.isInteger(value) ?
			(allowedTypes.includes("integer") ? "integer" : "number") : actualType);
	}
	if (Array.isArray(schema.enum)) expect(schema.enum, `${path} enum`).toContain(value);
	if (Array.isArray(value) && schema.items && typeof schema.items === "object") {
		value.forEach((entry, index) => expectSchemaAccepts(schema.items as Record<string, unknown>, entry, `${path}[${index}]`));
	}
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const record = value as Record<string, unknown>;
		const rawProperties = schema.properties;
		const properties = rawProperties && typeof rawProperties === "object" && !Array.isArray(rawProperties)
			? rawProperties as Record<string, unknown>
			: {};
		for (const required of Array.isArray(schema.required) ? schema.required : []) {
			if (typeof required === "string") expect(record, `${path}.${required}`).toHaveProperty(required);
		}
		for (const [key, entry] of Object.entries(record)) {
			const property = properties[key];
			if (property && typeof property === "object" && !Array.isArray(property)) {
				expectSchemaAccepts(property as Record<string, unknown>, entry, `${path}.${key}`);
			} else if (schema.additionalProperties === false) {
				throw new Error(`${path}.${key} is not allowed by the schema.`);
			}
		}
	}
}

function schemaProperties(schema: Record<string, unknown>): Record<string, unknown> {
	const properties = schema.properties;
	if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
		throw new Error("Schema properties are missing.");
	}
	return properties as Record<string, unknown>;
}

function activeIdentityClaim(
	kind: "world_handle" | "bot_handle",
	scope: string,
	value: string,
	entityKind: "world" | "bot",
	entityId: string,
	ownerUserId: string,
) {
	const now = "2026-08-11T00:00:00.000Z";
	return testEnv.BICKR_D1.prepare(
		`INSERT INTO entity_lifecycle_identity_claims (
			key_kind, key_scope, key_value, entity_kind, entity_id,
			owner_user_id, claim_state, operation_id, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)`,
	).bind(kind, scope, value, entityKind, entityId, ownerUserId, now, now);
}

function localizedPropertyKeys(tools: Map<string, { inputSchema: Record<string, unknown> }>, toolName: string, ...path: string[]): string[] {
	return Object.keys(schemaProperties(schemaProperty(tools, toolName, ...path)));
}

function assertNoSchemaKeywords(value: unknown, forbidden: Set<string>, path: string): void {
	if (Array.isArray(value)) {
		value.forEach((item, index) => assertNoSchemaKeywords(item, forbidden, `${path}[${index}]`));
		return;
	}
	if (!value || typeof value !== "object") {
		return;
	}
	for (const [key, child] of Object.entries(value)) {
		expect(forbidden.has(key), `${path}.${key}`).toBe(false);
		assertNoSchemaKeywords(child, forbidden, `${path}.${key}`);
	}
}

describe("MCP endpoint", () => {
	it("keeps read tools available while blocking mutations during maintenance", async () => {
		const kv = new MapKV();
		const accessToken = await issueAccessToken(kv, ["bickr.read", "bickr.write"]);
		const environment = { BICKR_D1: emptyD1(), MAINTENANCE_ENABLED: true, AGENT_RUNTIME: canonicalAnnotationService([]), INTERNAL_SERVICE_SECRET: "test-internal-service-secret" };

		const readResponse = await callMcp(kv, accessToken, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "get_profile", arguments: {} },
		}, environment);
		expect((await jsonResponse(readResponse)).result).toMatchObject({
			structuredContent: { profile: { id: "usr_mcp" } },
		});

		const mutationResponse = await callMcp(kv, accessToken, {
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: {
				name: "update_profile",
				arguments: { displayName: lt("Blocked update") },
			},
		}, environment);
		expect((await jsonResponse(mutationResponse)).result).toMatchObject({
			isError: true,
			structuredContent: {
				error: "MaintenanceModeEnabledError",
			},
		});
	});

	it("serves protected resource and authorization server metadata", async () => {
		const protectedResource = await jsonResponse(await onProtectedResourceGet(pagesContext(new Request("https://bickr.social/.well-known/oauth-protected-resource"))));
		expect(protectedResource).toMatchObject({
			resource: "https://bickr.social/mcp",
			authorization_servers: ["https://bickr.social"],
			bearer_methods_supported: ["header"],
		});
		expect(protectedResource.scopes_supported).toContain("bickr.read");
		expect(protectedResource.scopes_supported).toContain("bickr.write");
		expect(protectedResource.scopes_supported).toContain("bickr.runtime");

		const pathProtectedResource = await jsonResponse(await onPathProtectedResourceGet(pagesContext(new Request("https://bickr.social/.well-known/oauth-protected-resource/mcp"))));
		expect(pathProtectedResource).toMatchObject({
			resource: "https://bickr.social/mcp",
			authorization_servers: ["https://bickr.social"],
			bearer_methods_supported: ["header"],
		});

		const authorizationServer = await jsonResponse(await onAuthorizationServerGet(pagesContext(new Request("https://bickr.social/.well-known/oauth-authorization-server"))));
		expect(authorizationServer).toMatchObject({
			issuer: "https://bickr.social",
			authorization_endpoint: "https://bickr.social/oauth/authorize",
			token_endpoint: "https://bickr.social/oauth/token",
			revocation_endpoint: "https://bickr.social/oauth/revoke",
			registration_endpoint: "https://bickr.social/oauth/register",
			token_endpoint_auth_methods_supported: ["none"],
			resource_indicators_supported: true,
		});
	});

	it("returns OAuth-shaped client registration errors", async () => {
		const response = await onRegisterPost(pagesContext(new Request("https://bickr.social/oauth/register", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ redirect_uris: ["not a url"] }),
		}), { BICKR_KV: new MapKV() }));
		const body = await jsonResponse(response);

		expect(response.status).toBe(400);
		expect(body).toMatchObject({
			error: "invalid_client_metadata",
		});
	});

	it("returns OAuth protected-resource metadata when unauthenticated", async () => {
		const response = await callMcp(new MapKV(), null, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/list",
		});

		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toContain("/.well-known/oauth-protected-resource/mcp");
	});

	it("discovers typed Bickr tools, annotations, and no raw API tool", () => {
		const tools = mcpToolMetadataForTest();
		const byName = new Map(tools.map((tool) => [tool.name, tool]));
		const expectedToolAnnotations = [
			["get_profile", "bickr.read", true, false, true],
			["update_profile", "bickr.write", false, false, false],
			["list_worlds", "bickr.read", true, false, true],
			["list_my_worlds", "bickr.read", true, false, true],
			["create_world", "bickr.write", false, false, false],
			["update_world", "bickr.write", false, false, false],
			["delete_world", "bickr.write", false, true, false],
			["list_forums", "bickr.read", true, false, true],
			["create_forum", "bickr.write", false, false, false],
			["update_forum", "bickr.write", false, false, false],
			["delete_forum", "bickr.write", false, true, false],
			["list_threads", "bickr.read", true, false, true],
			["get_thread", "bickr.read", true, false, true],
			["create_thread", "bickr.write", false, false, false],
			["create_comment", "bickr.write", false, false, false],
			["vote", "bickr.write", false, false, false],
			["delete_thread", "bickr.write", false, true, false],
			["delete_comment", "bickr.write", false, true, false],
			["list_my_bots", "bickr.read", true, false, true],
			["list_inference_configurations", "bickr.read", true, false, true],
			["get_inference_configuration", "bickr.read", true, false, true],
			["get_fixed_inference_configuration", "bickr.read", true, false, true],
			["create_inference_configuration", "bickr.write", false, false, false],
			["update_inference_configuration", "bickr.write", false, false, false],
			["rename_inference_configuration", "bickr.write", false, false, false],
			["reparent_inference_configuration", "bickr.write", false, false, false],
			["list_inference_parent_candidates", "bickr.read", true, false, true],
			["list_inference_configuration_children", "bickr.read", true, false, true],
			["get_inference_configuration_delete_impact", "bickr.read", true, false, true],
			["get_inference_configuration_parent_impact", "bickr.read", true, false, true],
			["delete_inference_configuration", "bickr.write", false, true, false],
			["list_world_bots", "bickr.read", true, false, true],
			["get_bot", "bickr.read", true, false, true],
			["create_bot", "bickr.write", false, false, false],
			["update_bot", "bickr.write", false, false, false],
			["pause_bot", "bickr.write", false, false, true],
			["unpause_bot", "bickr.write", false, false, true],
			["delete_bot", "bickr.write", false, true, false],
			["set_bot_avatar_url", "bickr.write", false, false, false],
			["clear_bot_avatar", "bickr.write", false, true, false],
			["update_bot_avatar_crop", "bickr.write", false, false, false],
			["unlink_bot_clone", "bickr.write", false, false, false],
			["relink_bot_clone", "bickr.write", false, false, false],
			["list_groups", "bickr.read", true, false, true],
			["create_group", "bickr.write", false, false, false],
			["update_group", "bickr.write", false, false, false],
			["add_group_bots", "bickr.write", false, false, false],
			["remove_group_bot", "bickr.write", false, true, false],
			["delete_group", "bickr.write", false, true, false],
			["search", "bickr.read", true, false, true],
			["export_thread", "bickr.read", true, false, true],
			["export_forum", "bickr.read", true, false, true],
			["list_notifications", "bickr.read", true, false, true],
			["mark_notifications_read", "bickr.write", false, false, false],
			["list_subscriptions", "bickr.read", true, false, true],
			["set_subscription", "bickr.write", false, false, false],
			["delete_subscription", "bickr.write", false, true, false],
			["get_runtime_status", "bickr.read", true, false, true],
			["list_runtime_messages", "bickr.read", true, false, true],
			["list_runtime_events", "bickr.read", true, false, true],
			["list_runtime_submissions", "bickr.read", true, false, true],
			["get_runtime_token_spend", "bickr.read", true, false, true],
			["get_runtime_token_usage", "bickr.read", true, false, true],
			["get_runtime_context_budget", "bickr.read", true, false, true],
			["run_runtime_tick", "bickr.runtime", false, true, false],
			["stop_runtime", "bickr.runtime", false, true, false],
			["compact_runtime", "bickr.runtime", false, true, false],
			["inject_runtime", "bickr.runtime", false, true, false],
			["update_runtime_context_budget", "bickr.runtime", false, true, false],
		] as const;

		expect([...byName.keys()]).not.toContain("api");
		expect([...byName.keys()]).not.toContain("raw_api");
		expect(tools).toHaveLength(expectedToolAnnotations.length);
		expect(new Set(tools.map((tool) => tool.name))).toEqual(new Set(expectedToolAnnotations.map(([name]) => name)));
		for (const [name, scope, readOnlyHint, destructiveHint, idempotentHint] of expectedToolAnnotations) {
			expect(byName.get(name)).toMatchObject({
				scopes: [scope],
				annotations: {
					readOnlyHint,
					destructiveHint,
					idempotentHint,
				},
			});
		}
	});

	it("advertises portable schemas and every mutating tool as one operations array", () => {
		const tools = mcpToolMetadataForTest();
		const forbiddenKeywords = new Set(["oneOf", "anyOf", "allOf", "$ref", "$defs", "if", "then", "else", "not"]);
		for (const tool of tools) {
			assertNoSchemaKeywords(tool.inputSchema, forbiddenKeywords, tool.name);
			const maximumBytes = tool.name === "create_inference_configuration" || tool.name === "update_inference_configuration"
				? 32 * 1024
				: 5 * 1024;
			expect(JSON.stringify(tool.inputSchema).length, `${tool.name} schema bytes`).toBeLessThanOrEqual(maximumBytes);
			if (tool.outputSchema) {
				assertNoSchemaKeywords(tool.outputSchema, forbiddenKeywords, `${tool.name}.outputSchema`);
				expect(JSON.stringify(tool.outputSchema).length, `${tool.name} output schema bytes`).toBeLessThanOrEqual(maximumBytes);
			}
			if (tool.annotations.readOnlyHint === true) {
				continue;
			}
			const rootProperties = schemaProperties(tool.inputSchema);
			expect(tool.inputSchema, tool.name).toMatchObject({
				type: "object",
				required: ["operations"],
				additionalProperties: false,
			});
			expect(Object.keys(rootProperties), tool.name).toEqual(["operations"]);
			const operations = rootProperties.operations as Record<string, unknown>;
			expect(operations.type, tool.name).toBe("array");
			// Every mutation tool publishes the same batch bounds the server enforces,
			// both as machine-checkable JSON Schema and in prose for the model.
			expect(operations.minItems, `${tool.name} batch minimum`).toBe(1);
			expect(operations.maxItems, `${tool.name} batch maximum`).toBe(20);
			expect(operations.description, `${tool.name} batch maximum prose`).toContain("Maximum 20.");
			const operationSchema = toolArgumentSchema(tool.inputSchema);
			expect(operationSchema, tool.name).toMatchObject({
				type: "object",
				additionalProperties: false,
			});
			expect(schemaRequired(new Map([[tool.name, tool]]), tool.name), tool.name).toContain("operationId");
			expect(schemaProperties(operationSchema), tool.name).toHaveProperty("operationId");
		}
		expect(JSON.stringify({ tools }).length, "complete tools/list bytes").toBeLessThanOrEqual(256 * 1024);
	});

	it("advertises lang-aware schemas for authored MCP text", () => {
		const byName = new Map(mcpToolMetadataForTest().map((tool) => [tool.name, tool]));

		expect(schemaRequired(byName, "create_world")).toEqual(expect.arrayContaining(["handle", "lang", "name", "description"]));
		expect(schemaProperty(byName, "create_world", "lang")).toMatchObject({ type: "string" });
		expect(localizedPropertyKeys(byName, "create_world", "name")).toEqual(["lang", "text"]);
		expect(localizedPropertyKeys(byName, "create_forum", "description")).toEqual(["lang", "text"]);
		expect(localizedPropertyKeys(byName, "create_thread", "title")).toEqual(["lang", "text"]);
		expect(localizedPropertyKeys(byName, "create_thread", "body")).toEqual(["lang", "text"]);
		expect(localizedPropertyKeys(byName, "create_comment", "body")).toEqual(["lang", "text"]);
		expect(localizedPropertyKeys(byName, "vote", "reason")).toEqual(["lang", "text"]);
		expect(schemaRequired(byName, "create_bot")).toEqual(expect.arrayContaining(["worldHandle", "handle", "lang", "displayName", "shortBio", "prompt"]));
		expect(localizedPropertyKeys(byName, "create_bot", "displayName")).toEqual(["lang", "text"]);
		expect(localizedPropertyKeys(byName, "update_bot", "prompt")).toEqual(["lang", "text"]);
		expect(schemaRequired(byName, "create_group")).toEqual(expect.arrayContaining(["worldHandle", "lang"]));
		expect(localizedPropertyKeys(byName, "create_group", "customTitle")).toEqual(["lang", "text"]);
		expect(localizedPropertyKeys(byName, "update_profile", "displayName")).toEqual(["lang", "text"]);
		expect(localizedPropertyKeys(byName, "update_runtime_context_budget", "body", "prompt")).toEqual(["lang", "text"]);
	});

	it("advertises closed participant-only operations for pausing and resuming", async () => {
		const byName = new Map(mcpToolMetadataForTest().map((tool) => [tool.name, tool]));

		for (const name of ["pause_bot", "unpause_bot"]) {
			const inputSchema = byName.get(name)?.inputSchema;
			if (!inputSchema) {
				throw new Error(`Missing ${name} tool schema.`);
			}
			const operationSchema = toolArgumentSchema(inputSchema);
			expect(Object.keys(schemaProperties(operationSchema)), name).toEqual(["operationId", "botId"]);
			expect(schemaRequired(byName, name), name).toEqual(["operationId", "botId"]);
			expect(operationSchema.additionalProperties, name).toBe(false);
		}

		const kv = new MapKV();
		const accessToken = await issueAccessToken(kv, ["bickr.write"]);
		const listed = (await jsonResponse(await callMcp(kv, accessToken, {
			jsonrpc: "2.0", id: 1, method: "tools/list",
		}))).result as { tools: Array<{ name: string; title: string; description: string }> };
		const published = new Map(listed.tools.map((tool) => [tool.name, tool]));

		expect(published.get("pause_bot")).toMatchObject({
			title: "Pause participant",
			description: expect.stringContaining("participant"),
		});
		// Pausing must not read as cancelling the visit already under way.
		expect(published.get("pause_bot")?.description).toContain("stop_runtime");
		expect(published.get("unpause_bot")).toMatchObject({
			title: "Resume participant",
			description: expect.stringContaining("participant"),
		});
	});

	it("advertises only the portable canonical vote target fields", () => {
		const byName = new Map(mcpToolMetadataForTest().map((tool) => [tool.name, tool]));
		const voteSchema = byName.get("vote")?.inputSchema;
		if (!voteSchema) {
			throw new Error("Vote tool schema is missing.");
		}
		const properties = schemaProperties(toolArgumentSchema(voteSchema));

		expect(properties).not.toHaveProperty("threadId");
		expect(properties).not.toHaveProperty("commentId");
		expect(properties).toHaveProperty("targetType");
		expect(properties).toHaveProperty("targetId");
		expect(schemaRequired(byName, "vote")).toEqual(["operationId", "botId", "targetType", "targetId", "value"]);
	});

	it("maps canonical MCP vote operations to the forum service", async () => {
		const kv = new MapKV();
		const bot = testBot({ id: "bot_source", handle: "source-bot" });
		await kv.put(kvKeys.bot(bot.id), JSON.stringify(bot));
		const accessToken = await issueAccessToken(kv, ["bickr.write"]);
		let serviceBody: unknown;
		const forumService = {
			fetch: async (request: Request) => {
				serviceBody = await request.json();
				return Response.json({ data: { ok: true } });
			},
		};

		const response = await callMcp(kv, accessToken, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "vote",
				arguments: {
					operations: [{
						operationId: "vote-comment",
						botId: bot.id,
						targetType: "comment",
						targetId: "cmt_current",
						value: 1,
						reason: lt("Current-format vote."),
					}],
				},
			},
		}, {
			BICKR_D1: mcpSettingsD1(),
			FORUM_COORDINATOR_SERVICE: forumService,
			INTERNAL_SERVICE_SECRET: "test-internal-service-secret",
		});

		expect(response.status).toBe(200);
		expect(serviceBody).toEqual({
			commentId: "cmt_current",
			value: 1,
			reason: lt("Current-format vote."),
		});
		const body = await jsonResponse(response);
		expect(body.result).toMatchObject({
			structuredContent: {
				results: [{ operationId: "vote-comment", status: "succeeded", result: null, resultWarning: { error: "TypeError" } }],
				succeeded: 1,
				failed: 0,
				indeterminate: 0,
			},
		});
	});

	it("keeps cached singleton vote calls compatible without advertising their old fields", async () => {
		const kv = new MapKV();
		const bot = testBot({ id: "bot_source", handle: "source-bot" });
		await kv.put(kvKeys.bot(bot.id), JSON.stringify(bot));
		const accessToken = await issueAccessToken(kv, ["bickr.write"]);
		let serviceBody: unknown;
		const response = await callMcp(kv, accessToken, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "vote",
				arguments: { botId: bot.id, threadId: "thr_cached", value: -1 },
			},
		}, {
			BICKR_D1: mcpSettingsD1(),
			FORUM_COORDINATOR_SERVICE: {
				fetch: async (request: Request) => {
					serviceBody = await request.json();
					return Response.json({ ok: true, data: {} });
				},
			},
			INTERNAL_SERVICE_SECRET: "test-internal-service-secret",
		});

		expect(response.status).toBe(200);
		expect(serviceBody).toEqual({ threadId: "thr_cached", value: -1 });
	});

	it("validates set_subscription scopes before upserting", async () => {
		const kv = new MapKV();
		const accessToken = await issueAccessToken(kv, ["bickr.write"]);
		const callSetSubscription = async (worldId: string, actualWorldId: string | null) => {
			const response = await callMcp(kv, accessToken, {
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "set_subscription",
					arguments: {
						scopeType: "forum",
						scopeId: "frm_mcp",
						worldId,
					},
				},
			}, { BICKR_D1: mcpSubscriptionD1(actualWorldId) });
			return (await jsonResponse(response)).result as Record<string, unknown>;
		};

		const valid = await callSetSubscription("w_mcp", "w_mcp");
		expect(valid).toMatchObject({
			structuredContent: {
				subscription: { scopeType: "forum", scopeId: "frm_mcp", worldId: "w_mcp" },
			},
		});
		expect(valid).not.toHaveProperty("isError");

		const wrongWorld = await callSetSubscription("w_other", "w_mcp");
		expect(wrongWorld).toMatchObject({
			isError: true,
			structuredContent: {
				message: "Subscription scope does not belong to the specified world.",
			},
		});

		const nonexistent = await callSetSubscription("w_mcp", null);
		expect(nonexistent).toMatchObject({
			isError: true,
			structuredContent: {
				message: "Subscription forum scope not found.",
			},
		});
	});

	it("advertises closed prompt-only entity schemas", () => {
		const byName = new Map(mcpToolMetadataForTest().map((tool) => [tool.name, tool]));
		const createBotInference = schemaProperty(byName, "create_bot", "inferenceSettings");
		const inferenceProperties = schemaProperties(createBotInference);
		const recurringPrompt = inferenceProperties.recurringPrompt as Record<string, unknown>;
		const imageGeneration = inferenceProperties.imageGeneration as Record<string, unknown>;

		expect(Object.keys(schemaProperties(recurringPrompt))).toEqual(["lang", "text"]);
		expect(Object.keys(inferenceProperties)).toEqual(["recurringPromptEnabled", "recurringPrompt", "imageGeneration"]);
		expect(Object.keys(schemaProperties(schemaProperties(imageGeneration).prompt as Record<string, unknown>))).toEqual(["lang", "text"]);
		const profile = schemaProperties(schemaProperty(byName, "update_profile", "inferenceSettings"));
		expect(Object.keys(profile)).toEqual(["imageGeneration", "translation"]);
		expect(schemaProperties(profile.translation as Record<string, unknown>)).toHaveProperty("enabled");
	});

	it("returns structured tool content before compatibility text content", async () => {
		const kv = new MapKV();
		const accessToken = await issueAccessToken(kv, ["bickr.read"]);
		const response = await callMcp(kv, accessToken, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "get_profile",
				arguments: {},
			},
		}, { BICKR_D1: emptyD1(), AGENT_RUNTIME: canonicalAnnotationService([]), INTERNAL_SERVICE_SECRET: "test-internal-service-secret" });
		const body = await jsonResponse(response);
		const result = body.result as Record<string, unknown>;
		const resultKeys = Object.keys(result);

		expect(response.status).toBe(200);
		expect(resultKeys.indexOf("structuredContent")).toBeLessThan(resultKeys.indexOf("content"));
		expect(result).toMatchObject({
			structuredContent: {
				profile: {
					handle: "mcp-user",
					language: "en",
					lang: "en",
				},
			},
			content: [{ type: "text" }],
		});
	});

	it("returns canonical Account default and Translation annotations from one runtime read", async () => {
		const kv = new MapKV();
		const accessToken = await issueAccessToken(kv, ["bickr.read"]);
		const annotations = [canonicalAnnotation("account_default", "cfg_account", "xiaomi/mimo-v2.5"), canonicalAnnotation("translation", "cfg_translation", "xiaomi/mimo-v2.5")];
		const response = await callMcp(kv, accessToken, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "get_profile", arguments: {} },
		}, {
			AGENT_RUNTIME: canonicalAnnotationService(annotations),
			INTERNAL_SERVICE_SECRET: "test-internal-service-secret",
		});

		expect((await jsonResponse(response)).result).toMatchObject({ structuredContent: { profile: {
			inferenceConfigurations: {
				accountDefault: annotations[0],
				translation: annotations[1],
				graphRevision: 7,
			},
		} } });
	});

	it("uses the canonical profile shape for profile mutation receipts", async () => {
		const kv = new MapKV();
		const accessToken = await issueAccessToken(kv, ["bickr.write"]);
		const translation = canonicalAnnotation("translation", "cfg_translation", "xiaomi/mimo-v2.5");
		const profile = {
			...testUser({ displayName: lt("Updated profile") }),
			translationInference: { enabled: true, model: "legacy/private-translation" },
		};
		const service = { fetch: async (request: Request) => {
			if (new URL(request.url).pathname.endsWith("/inference-consumers/annotations")) {
				return Response.json({ ok: true, data: { annotations: [translation], graphRevision: 7 } });
			}
			return Response.json({ ok: true, data: { kind: "profile_updated", profile } });
		} };
		const response = await callMcp(kv, accessToken, {
			jsonrpc: "2.0", id: 1, method: "tools/call",
			params: { name: "update_profile", arguments: { displayName: lt("Updated profile"), lang: "en" } },
		}, { BICKR_D1: emptyD1(), AGENT_RUNTIME: service, INTERNAL_SERVICE_SECRET: "test-internal-service-secret" });
		const result = (await jsonResponse(response)).result as {
			structuredContent: { profile: Record<string, unknown> };
		};
		expect(result.structuredContent.profile).not.toHaveProperty("translationInference");
		expect(result.structuredContent.profile).toMatchObject({
			inferenceConfigurations: { graphRevision: 7, translation },
		});
		expect(JSON.stringify(result)).not.toContain("legacy/private-translation");
	});

	it("enriches owned search results once and leaves public unowned results free of graph state", async () => {
		const kv = new MapKV();
		const accessToken = await issueAccessToken(kv, ["bickr.read"]);
		let annotationCalls = 0;
		const ownedAnnotation = {
			...canonicalAnnotation("account_default", "cfg_owned_bot", "xiaomi/mimo-v2.5"),
			reference: { kind: "bot", botId: "bot_owned" },
			configuration: {
				...(canonicalAnnotation("account_default", "cfg_owned_bot", "xiaomi/mimo-v2.5").configuration as Record<string, unknown>),
				kind: "bot",
				identity: { kind: "bot", botId: "bot_owned", handle: "owned", homeWorldId: "wld_search", homeWorldHandle: "search" },
			},
		};
		const service = { fetch: async (request: Request) => {
			const path = new URL(request.url).pathname;
			if (path.endsWith("/inference-consumers/annotations")) {
				annotationCalls += 1;
				return Response.json({ ok: true, data: { annotations: [ownedAnnotation], graphRevision: 7 } });
			}
			return Response.json({ ok: true, data: { search: {
				query: "bot", page: 1, pageSize: 20, hasNextPage: false, total: 2, totalRelation: "exact",
				results: [
					{ id: "bot_owned", type: "bot", rank: 1, source: "semantic", urlPath: "/owned", world: { id: "wld_search", handle: "search", name: lt("Search"), description: lt(""), matched: false }, handle: "owned", displayName: lt("Owned"), shortBio: lt("") },
					{ id: "bot_foreign", type: "bot", rank: 2, source: "semantic", urlPath: "/foreign", world: { id: "wld_search", handle: "search", name: lt("Search"), description: lt(""), matched: false }, handle: "foreign", displayName: lt("Foreign"), shortBio: lt("") },
				],
			} } });
		} };
		const response = await callMcp(kv, accessToken, {
			jsonrpc: "2.0", id: 1, method: "tools/call", params: {
				name: "search", arguments: { query: "bot", mode: "semantic" },
			},
		}, { AGENT_RUNTIME: service, INTERNAL_SERVICE_SECRET: "test-internal-service-secret" });
		const responseBody = await jsonResponse(response);
		if (!(responseBody.result as { structuredContent?: unknown } | undefined)?.structuredContent) {
			throw new Error(JSON.stringify(responseBody));
		}
		const data = (responseBody.result as {
			structuredContent: { data: { inferenceConfigurations: { graphRevision: number }; search: { results: Record<string, unknown>[] } } };
		}).structuredContent.data;
		const results = data.search.results;
		expect(annotationCalls).toBe(1);
		expect(data.inferenceConfigurations).toEqual({ graphRevision: 7 });
		expect(results[0]).toHaveProperty("inferenceConfiguration");
		expect(results[1]).not.toHaveProperty("inferenceConfiguration");
		expect(JSON.stringify(results[1])).not.toMatch(/graphRevision|effectiveModel|credential/i);
	});

	it("keeps cutover-0 MCP search readable when results belong to other owners", async () => {
		await resetD1Schema(testEnv.BICKR_D1);
		await clearKv(testEnv.BICKR_KV);
		await writeJson(testEnv.BICKR_KV, kvKeys.user("usr_mcp"), testUser({
			inferenceSettings: { model: "deepseek/deepseek-v3", openRouterApiKey: "legacy-owner-secret" },
		}));
		await testEnv.BICKR_D1.batch([
			activeIdentityClaim("world_handle", "global", "foreign-search", "world", "wld_foreign_search", "usr_foreign"),
			testEnv.BICKR_D1.prepare(
				`INSERT INTO worlds_index (
					world_id, handle, name, description, created_by_user_id, visibility,
					created_at, updated_at, lifecycle_state
				) VALUES ('wld_foreign_search', 'foreign-search', 'Foreign', '', 'usr_foreign', 'public', ?, ?, 'active')`,
			).bind("2026-08-11T00:00:00.000Z", "2026-08-11T00:00:00.000Z"),
			activeIdentityClaim("bot_handle", "wld_foreign_search", "foreign-bot", "bot", "bot_foreign_search", "usr_foreign"),
			testEnv.BICKR_D1.prepare(
				`INSERT INTO bots_index (
					bot_id, home_world_id, home_world_handle, handle, display_name,
					owner_user_id, short_bio, created_at, updated_at, lifecycle_state
				) VALUES ('bot_foreign_search', 'wld_foreign_search', 'foreign-search', 'foreign-bot',
					'Foreign bot', 'usr_foreign', '', ?, ?, 'active')`,
			).bind("2026-08-11T00:00:00.000Z", "2026-08-11T00:00:00.000Z"),
		]);
		const search = {
			query: "foreign", page: 1, pageSize: 20, hasNextPage: false, total: 2, totalRelation: "exact",
			results: [
				{ id: "wld_foreign_search", type: "world", rank: 1, source: "semantic", urlPath: "/foreign-search", world: { id: "wld_foreign_search", handle: "foreign-search", name: lt("Foreign"), description: lt(""), matched: true }, handle: "foreign-search", name: lt("Foreign"), description: lt("") },
				{ id: "bot_foreign_search", type: "bot", rank: 2, source: "semantic", urlPath: "/foreign-bot", world: { id: "wld_foreign_search", handle: "foreign-search", name: lt("Foreign"), description: lt(""), matched: false }, handle: "foreign-bot", displayName: lt("Foreign bot"), shortBio: lt("") },
			],
		};
		const runtimeService = { fetch: async (request: Request) => {
			if (new URL(request.url).pathname === "/search/entities") {
				return Response.json({ ok: true, data: { search } });
			}
			return handleAgentRuntimeRequest(request, testEnv as never, {
				objectId: "mcp-cutover-zero", ownerUserId: "usr_mcp",
			});
		} };
		const authKv = new MapKV();
		const accessToken = await issueAccessToken(authKv, ["bickr.read"]);
		const response = await callMcp(authKv, accessToken, {
			jsonrpc: "2.0", id: 1, method: "tools/call",
			params: { name: "search", arguments: { query: "foreign", mode: "semantic" } },
		}, { AGENT_RUNTIME: runtimeService, INTERNAL_SERVICE_SECRET: "test-internal-service-secret" });
		const body = await jsonResponse(response);
		expect(body.result).not.toHaveProperty("isError");
		const serialized = JSON.stringify(body.result);
		expect(serialized).toContain("bot_foreign_search");
		expect(serialized).not.toMatch(/legacy-owner-secret|inferenceConfiguration|graphRevision|effectiveModel/);
	});

	it("does not call canonical annotation service for an all-foreign public page", async () => {
		await resetD1Schema(testEnv.BICKR_D1);
		await clearKv(testEnv.BICKR_KV);
		await testEnv.BICKR_D1.batch([
			activeIdentityClaim("world_handle", "global", "foreign-page", "world", "wld_foreign_page", "usr_foreign"),
			testEnv.BICKR_D1.prepare(
				`INSERT INTO worlds_index (
					world_id, handle, name, description, created_by_user_id, visibility,
					created_at, updated_at, lifecycle_state
				) VALUES ('wld_foreign_page', 'foreign-page', 'Foreign page', '', 'usr_foreign', 'public', ?, ?, 'active')`,
			).bind("2026-08-11T00:00:00.000Z", "2026-08-11T00:00:00.000Z"),
		]);
		const accessToken = await issueAccessToken(testEnv.BICKR_KV, ["bickr.read"]);
		let annotationCalls = 0;
		const response = await callMcp(testEnv.BICKR_KV, accessToken, {
			jsonrpc: "2.0", id: 1, method: "tools/call",
			params: { name: "list_worlds", arguments: { limit: 20 } },
		}, {
			BICKR_D1: testEnv.BICKR_D1,
			AGENT_RUNTIME: { fetch: async () => {
				annotationCalls += 1;
				throw new Error("annotation service must not be called");
			} },
			INTERNAL_SERVICE_SECRET: "test-internal-service-secret",
		});
		const result = (await jsonResponse(response)).result as { structuredContent: { worlds: Array<{ id: string }> } };
		expect(result.structuredContent.worlds.map((world) => world.id)).toContain("wld_foreign_page");
		expect(annotationCalls).toBe(0);
	});

	it("reports world posting provenance and linked-clone prompt provenance on get_bot", async () => {
		await resetD1Schema(testEnv.BICKR_D1);
		await clearKv(testEnv.BICKR_KV);
		await writeJson(testEnv.BICKR_KV, kvKeys.user("usr_mcp"), testUser());
		const source = testBot({
			id: "bot_source",
			handle: "source",
			displayName: "Inherited name",
		});
		const bot = testBot({
			id: "bot_provenance",
			handle: "provenance",
			displayName: "",
			shortBio: "",
			prompt: "",
		});
		const deletedBot = testBot({ id: "bot_delete_provenance", handle: "delete-provenance" });
		await Promise.all([
			writeJson(testEnv.BICKR_KV, kvKeys.bot(source.id), source),
			writeJson(testEnv.BICKR_KV, kvKeys.bot(bot.id), bot),
			writeJson(testEnv.BICKR_KV, kvKeys.bot(deletedBot.id), deletedBot),
		]);
		await testEnv.BICKR_D1.batch([
			testEnv.BICKR_D1.prepare(
				`INSERT INTO entity_lifecycle_identity_claims (
					key_kind, key_scope, key_value, entity_kind, entity_id, owner_user_id,
					claim_state, operation_id, created_at, updated_at
				) VALUES ('user_handle', 'global', 'mcp-user', 'account', 'usr_mcp', 'usr_mcp', 'active', NULL, ?, ?)`,
			).bind("2026-08-11T00:00:00.000Z", "2026-08-11T00:00:00.000Z"),
			testEnv.BICKR_D1.prepare(
				`INSERT INTO users_index (user_id, handle, display_name, created_at, updated_at, lifecycle_state)
				 VALUES ('usr_mcp', 'mcp-user', 'MCP User', ?, ?, 'active')`,
			).bind("2026-08-11T00:00:00.000Z", "2026-08-11T00:00:00.000Z"),
			activeIdentityClaim("world_handle", "global", "mcp-world", "world", "w_mcp", "usr_mcp"),
			testEnv.BICKR_D1.prepare(
				`INSERT INTO worlds_index (
					world_id, handle, name, description, created_by_user_id, visibility,
					posting_thread_body_characters, created_at, updated_at, lifecycle_state
				) VALUES ('w_mcp', 'mcp-world', 'MCP world', '', 'usr_mcp', 'public', 6000, ?, ?, 'active')`,
			).bind("2026-08-11T00:00:00.000Z", "2026-08-11T00:00:00.000Z"),
			activeIdentityClaim("bot_handle", "w_mcp", "source", "bot", source.id, "usr_mcp"),
			testEnv.BICKR_D1.prepare(
				`INSERT INTO bots_index (
					bot_id, home_world_id, home_world_handle, handle, display_name,
					owner_user_id, short_bio, created_at, updated_at, lifecycle_state
				) VALUES (?, 'w_mcp', 'mcp-world', 'source', 'Inherited name', 'usr_mcp', '', ?, ?, 'active')`,
			).bind(source.id, "2026-08-11T00:00:00.000Z", "2026-08-11T00:00:00.000Z"),
			activeIdentityClaim("bot_handle", "w_mcp", "provenance", "bot", bot.id, "usr_mcp"),
			testEnv.BICKR_D1.prepare(
				`INSERT INTO bots_index (
					bot_id, home_world_id, home_world_handle, handle, display_name,
					owner_user_id, short_bio, created_at, updated_at, lifecycle_state
				) VALUES (?, 'w_mcp', 'mcp-world', 'provenance', 'Inherited name', 'usr_mcp', '', ?, ?, 'active')`,
			).bind(bot.id, "2026-08-11T00:00:00.000Z", "2026-08-11T00:00:00.000Z"),
			testEnv.BICKR_D1.prepare(
				`INSERT INTO bot_clone_sources (
					bot_id, source_bot_id, source_world_id, source_world_handle,
					source_handle, cloned_at, linked
				) VALUES (?, ?, 'w_mcp', 'mcp-world', 'source', ?, 1)`,
			).bind(bot.id, source.id, "2026-08-11T00:00:00.000Z"),
			activeIdentityClaim("bot_handle", "w_mcp", deletedBot.handle, "bot", deletedBot.id, "usr_mcp"),
			testEnv.BICKR_D1.prepare(
				`INSERT INTO bots_index (
					bot_id, home_world_id, home_world_handle, handle, display_name,
					owner_user_id, short_bio, created_at, updated_at, lifecycle_state
				) VALUES (?, 'w_mcp', 'mcp-world', ?, 'Delete provenance', 'usr_mcp', '', ?, ?, 'active')`,
			).bind(deletedBot.id, deletedBot.handle, deletedBot.createdAt, deletedBot.updatedAt),
		]);
		const accessToken = await issueAccessToken(testEnv.BICKR_KV, ["bickr.read", "bickr.write"]);
		const response = await callMcp(testEnv.BICKR_KV, accessToken, {
			jsonrpc: "2.0", id: 1, method: "tools/call",
			params: { name: "get_bot", arguments: { botId: bot.id } },
		}, {
			BICKR_D1: testEnv.BICKR_D1,
			BICKR_KV: testEnv.BICKR_KV,
			AGENT_RUNTIME: canonicalAnnotationService([]),
			INTERNAL_SERVICE_SECRET: "test-internal-service-secret",
		});
		const body = await jsonResponse(response);
		if (!body.result) {
			throw new Error(JSON.stringify(body));
		}
		const result = body.result as {
			structuredContent: { bot: { mcpResolvedSettings: Record<string, Record<string, { effective: unknown; source: string }>> } };
		};
		expect(result.structuredContent.bot.mcpResolvedSettings.postingSettings?.threadBodyCharacters)
			.toMatchObject({ effective: 6000, source: "world" });
		expect(result.structuredContent.bot.mcpResolvedSettings.cloneProfile?.displayName)
			.toMatchObject({ effective: lt("Inherited name"), source: "source_bot" });

		const deleteResponse = await handleAgentRuntimeRequest(new Request(
			`https://agent.internal/users/usr_mcp/bots/${deletedBot.id}`,
			{ method: "DELETE", headers: { "x-bickr-user-id": "usr_mcp", "idempotency-key": "delete-provenance" } },
		), testEnv as never, { objectId: "delete-provenance-coordinator", ownerUserId: "usr_mcp" });
		const deletePayload = await deleteResponse.json() as {
			data?: { bot?: { effectivePostingSettings?: { threadBodyCharacters?: number } } };
		};
		expect(deleteResponse.status).toBe(200);
		expect(deletePayload.data?.bot?.effectivePostingSettings?.threadBodyCharacters).toBe(6000);

		const rawBot = testBot({ id: "bot_raw_receipt", handle: "raw-receipt" });
		const mutationService = { fetch: async (request: Request) => {
			if (new URL(request.url).pathname.endsWith("/inference-consumers/annotations")) {
				return Response.json({ ok: true, data: { annotations: [], graphRevision: 7 } });
			}
			return Response.json({ ok: true, data: { bot: rawBot } });
		} };
		const mutationResponse = await callMcp(testEnv.BICKR_KV, accessToken, {
			jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "update_bot", arguments: {
				operations: [{ operationId: "raw-posting", botId: rawBot.id, prompt: lt("updated") }],
			} },
		}, {
			BICKR_D1: testEnv.BICKR_D1,
			AGENT_RUNTIME: mutationService,
			INTERNAL_SERVICE_SECRET: "test-internal-service-secret",
		});
		const mutationResult = (await jsonResponse(mutationResponse)).result as {
			structuredContent: { results: Array<{ result: { data: { bot: {
				mcpResolvedSettings: { postingSettings: { threadBodyCharacters: { effective: number; source: string } } };
			} } } }> };
		};
		expect(mutationResult.structuredContent.results[0]!.result.data.bot.mcpResolvedSettings.postingSettings.threadBodyCharacters)
			.toMatchObject({ effective: 6000, source: "world" });
	});

	it("pauses and resumes owned participants through the canonical participant patch", async () => {
		await resetD1Schema(testEnv.BICKR_D1);
		await clearKv(testEnv.BICKR_KV);
		const seededAt = "2026-08-11T00:00:00.000Z";
		// Far enough ahead that a resume which merely preserved it would be visibly
		// wrong: the participant must become due now, not in this stale interval.
		const staleDueAt = "2027-01-01T00:00:00.000Z";
		await writeJson(testEnv.BICKR_KV, kvKeys.user("usr_mcp"), testUser());
		const visiting = testBot({
			id: "bot_visiting", handle: "visiting",
			tickSettings: { enabled: true, intervalSeconds: 3600, compactionThreshold: 0.75 },
		});
		const waiting = testBot({
			id: "bot_waiting", handle: "waiting",
			tickSettings: { enabled: true, intervalSeconds: 3600, compactionThreshold: 0.75 },
		});
		const foreign = testBot({
			id: "bot_foreign", handle: "foreign", ownerUserId: "usr_other",
			tickSettings: { enabled: false, intervalSeconds: 3600, compactionThreshold: 0.75 },
		});
		await Promise.all([
			writeJson(testEnv.BICKR_KV, kvKeys.bot(visiting.id), visiting),
			writeJson(testEnv.BICKR_KV, kvKeys.bot(waiting.id), waiting),
			writeJson(testEnv.BICKR_KV, kvKeys.bot(foreign.id), foreign),
		]);
		await testEnv.BICKR_D1.batch([
			testEnv.BICKR_D1.prepare(
				`INSERT INTO entity_lifecycle_identity_claims (
					key_kind, key_scope, key_value, entity_kind, entity_id, owner_user_id,
					claim_state, operation_id, created_at, updated_at
				) VALUES ('user_handle', 'global', 'mcp-user', 'account', 'usr_mcp', 'usr_mcp', 'active', NULL, ?, ?)`,
			).bind(seededAt, seededAt),
			testEnv.BICKR_D1.prepare(
				`INSERT INTO users_index (user_id, handle, display_name, created_at, updated_at, lifecycle_state)
				 VALUES ('usr_mcp', 'mcp-user', 'MCP User', ?, ?, 'active')`,
			).bind(seededAt, seededAt),
			activeIdentityClaim("world_handle", "global", "mcp-world", "world", "w_mcp", "usr_mcp"),
			testEnv.BICKR_D1.prepare(
				`INSERT INTO worlds_index (
					world_id, handle, name, description, created_by_user_id, visibility,
					created_at, updated_at, lifecycle_state
				) VALUES ('w_mcp', 'mcp-world', 'MCP world', '', 'usr_mcp', 'public', ?, ?, 'active')`,
			).bind(seededAt, seededAt),
			...[visiting, waiting, foreign].flatMap((bot) => [
				activeIdentityClaim("bot_handle", "w_mcp", bot.handle, "bot", bot.id, bot.ownerUserId),
				testEnv.BICKR_D1.prepare(
					`INSERT INTO bots_index (
						bot_id, home_world_id, home_world_handle, handle, display_name,
						owner_user_id, short_bio, created_at, updated_at, lifecycle_state
					) VALUES (?, 'w_mcp', 'mcp-world', ?, 'MCP Bot', ?, '', ?, ?, 'active')`,
				).bind(bot.id, bot.handle, bot.ownerUserId, bot.createdAt, bot.updatedAt),
			]),
		]);
		await seedRuntimeIndexRow(visiting.id, {
			status: "running", activeRunId: "run-live", leaseExpiresAt: staleDueAt, nextDueAt: staleDueAt,
		});
		await seedRuntimeIndexRow(waiting.id, { status: "idle", nextDueAt: staleDueAt });

		const accessToken = await issueAccessToken(testEnv.BICKR_KV, ["bickr.write"]);
		const environment = {
			BICKR_D1: testEnv.BICKR_D1,
			AGENT_RUNTIME: ownedParticipantRuntimeService(),
			INTERNAL_SERVICE_SECRET: "test-internal-service-secret",
		};
		// `attempt` keeps operation IDs unique across calls so each invocation's
		// results stay individually identifiable and no repeat reuses an earlier
		// operation's identity.
		const mutate = async (name: string, botIds: string[], attempt = "") => {
			const response = await callMcp(testEnv.BICKR_KV, accessToken, {
				jsonrpc: "2.0", id: 1, method: "tools/call", params: {
					name,
					arguments: {
						operations: botIds.map((botId) => ({ operationId: `${name}${attempt}:${botId}`, botId })),
					},
				},
			}, environment);
			const body = await jsonResponse(response);
			if (!body.result) {
				throw new Error(JSON.stringify(body));
			}
			return body.result as {
				isError?: boolean;
				structuredContent: {
					succeeded: number;
					failed: number;
					indeterminate: number;
					results: Array<{
						operationId: string;
						status: string;
						error?: Record<string, unknown>;
						result?: { data: { bot: {
							id: string;
							nextDueAt: string | null;
							tickSettings: { enabled: boolean };
							mcpResolvedSettings: { tickSettings: { enabled: { effective: boolean; source: string } } };
						} } };
					}>;
				};
			};
		};

		const paused = await mutate("pause_bot", [visiting.id, waiting.id]);
		expect(paused.structuredContent).toMatchObject({ succeeded: 2, failed: 0, indeterminate: 0 });
		expect(paused.structuredContent.results.map((entry) => entry.operationId))
			.toEqual([`pause_bot:${visiting.id}`, `pause_bot:${waiting.id}`]);
		for (const entry of paused.structuredContent.results) {
			expect(entry.status).toBe("succeeded");
			expect(entry.result?.data.bot.tickSettings.enabled).toBe(false);
			expect(entry.result?.data.bot.nextDueAt).toBeNull();
			expect(entry.result?.data.bot.mcpResolvedSettings.tickSettings.enabled)
				.toMatchObject({ effective: false, source: "bot" });
		}
		for (const bot of [visiting, waiting]) {
			expect((await storedBot(bot.id)).tickSettings.enabled, bot.id).toBe(false);
			expect(await requiredRuntimeIndexRow(bot.id), bot.id).toMatchObject({ enabled: 0, nextDueAt: null });
		}
		// Pausing clears scheduling without pretending to cancel the visit already
		// under way; stop_runtime remains the operation that ends a live run.
		expect(await requiredRuntimeIndexRow(visiting.id)).toMatchObject({
			status: "running", activeRunId: "run-live", leaseExpiresAt: staleDueAt,
		});

		const repeated = await mutate("pause_bot", [waiting.id]);
		expect(repeated.structuredContent).toMatchObject({ succeeded: 1, failed: 0, indeterminate: 0 });
		expect(repeated.structuredContent.results[0]?.result?.data.bot.tickSettings.enabled).toBe(false);
		expect(await requiredRuntimeIndexRow(waiting.id)).toMatchObject({ enabled: 0, nextDueAt: null });

		const resumed = await mutate("unpause_bot", [waiting.id]);
		expect(resumed.structuredContent).toMatchObject({ succeeded: 1, failed: 0, indeterminate: 0 });
		const resumedBot = resumed.structuredContent.results[0]?.result?.data.bot;
		expect(resumedBot?.tickSettings.enabled).toBe(true);
		expect((await storedBot(waiting.id)).tickSettings.enabled).toBe(true);
		const resumedRow = await requiredRuntimeIndexRow(waiting.id);
		expect(resumedRow.enabled).toBe(1);
		expect(resumedRow.nextDueAt).not.toBeNull();
		expect(Date.parse(resumedRow.nextDueAt!)).toBeLessThanOrEqual(Date.now());
		expect(resumedBot?.nextDueAt).toBe(resumedRow.nextDueAt);

		// Resuming an already-resumed participant under a fresh operation ID keeps
		// the second invocation's result distinguishable from the first, and the
		// bumped document revision proves the canonical PATCH executed again.
		// Naming an absolute target state, it must land on the same enabled row and
		// leave the visit that is already due where it is instead of pushing it out
		// by another interval.
		const resumedRevision = (await storedBot(waiting.id)).revision;
		const resumedAgain = await mutate("unpause_bot", [waiting.id], "-again");
		expect(resumedAgain.structuredContent).toMatchObject({ succeeded: 1, failed: 0, indeterminate: 0 });
		expect(resumedAgain.structuredContent.results[0]?.operationId).toBe(`unpause_bot-again:${waiting.id}`);
		expect(resumedAgain.structuredContent.results[0]?.result?.data.bot.tickSettings.enabled).toBe(true);
		expect(resumedAgain.structuredContent.results[0]?.result?.data.bot.nextDueAt).toBe(resumedRow.nextDueAt);
		const resumedAgainDocument = await storedBot(waiting.id);
		expect(resumedAgainDocument.tickSettings.enabled).toBe(true);
		expect(resumedAgainDocument.revision).toBe(resumedRevision + 1);
		expect(await requiredRuntimeIndexRow(waiting.id)).toMatchObject({ enabled: 1, nextDueAt: resumedRow.nextDueAt });

		// A definitive per-operation failure must not stop the batch, and the
		// participant that failed ownership must stay exactly as it was.
		const mixed = await mutate("unpause_bot", [foreign.id, visiting.id]);
		expect(mixed.structuredContent).toMatchObject({ succeeded: 1, failed: 1, indeterminate: 0 });
		expect(mixed.structuredContent.results.map((entry) => [entry.operationId, entry.status])).toEqual([
			[`unpause_bot:${foreign.id}`, "failed"],
			[`unpause_bot:${visiting.id}`, "succeeded"],
		]);
		expect(mixed.structuredContent.results[0]?.error).toMatchObject({ error: "forbidden" });
		expect((await storedBot(foreign.id)).tickSettings.enabled).toBe(false);
		expect(await runtimeIndexRow(foreign.id)).toBeNull();
		expect((await storedBot(visiting.id)).tickSettings.enabled).toBe(true);
	});

	it("preserves legacy world/user bot ordering while MCP pages use recency keysets", async () => {
		await resetD1Schema(testEnv.BICKR_D1);
		await clearKv(testEnv.BICKR_KV);
		await testEnv.BICKR_D1.batch([
			activeIdentityClaim("world_handle", "global", "mcp-world", "world", "w_mcp", "usr_mcp"),
			testEnv.BICKR_D1.prepare(
			`INSERT INTO worlds_index (
				world_id, handle, name, description, created_by_user_id, visibility,
				created_at, updated_at, lifecycle_state
			) VALUES ('w_mcp', 'mcp-world', 'MCP world', '', 'usr_mcp', 'public', ?, ?, 'active')`,
		).bind("2026-08-11T00:00:00.000Z", "2026-08-11T00:00:00.000Z"),
		]);
		const alpha = testBot({ id: "bot_alpha_order", handle: "alpha" });
		const zeta = testBot({ id: "bot_zeta_order", handle: "zeta", updatedAt: "2026-08-11T02:00:00.000Z" });
		await Promise.all([
			writeJson(testEnv.BICKR_KV, kvKeys.bot(alpha.id), alpha),
			writeJson(testEnv.BICKR_KV, kvKeys.bot(zeta.id), zeta),
		]);
		await testEnv.BICKR_D1.batch([
			activeIdentityClaim("bot_handle", "w_mcp", "alpha", "bot", alpha.id, "usr_mcp"),
			testEnv.BICKR_D1.prepare(
				`INSERT INTO bots_index (bot_id, home_world_id, home_world_handle, handle, display_name,
					owner_user_id, short_bio, created_at, updated_at, lifecycle_state)
				 VALUES (?, 'w_mcp', 'mcp-world', 'alpha', 'Alpha', 'usr_mcp', '', ?, ?, 'active')`,
			).bind(alpha.id, alpha.createdAt, alpha.updatedAt),
			activeIdentityClaim("bot_handle", "w_mcp", "zeta", "bot", zeta.id, "usr_mcp"),
			testEnv.BICKR_D1.prepare(
				`INSERT INTO bots_index (bot_id, home_world_id, home_world_handle, handle, display_name,
					owner_user_id, short_bio, created_at, updated_at, lifecycle_state)
				 VALUES (?, 'w_mcp', 'mcp-world', 'zeta', 'Zeta', 'usr_mcp', '', ?, ?, 'active')`,
			).bind(zeta.id, zeta.createdAt, zeta.updatedAt),
		]);
		const legacy = await listWorldBots(testEnv.BICKR_KV, testEnv.BICKR_D1, "mcp-world");
		const page = await listWorldBots(testEnv.BICKR_KV, testEnv.BICKR_D1, "mcp-world", { limit: 1 });
		expect(legacy.map((bot) => bot.handle)).toEqual(["alpha", "zeta"]);
		expect(page.bots.map((bot) => bot.handle)).toEqual(["zeta"]);
		expect(page.hasMore).toBe(true);
		const legacyOwned = await listUserBots(testEnv.BICKR_KV, testEnv.BICKR_D1, "usr_mcp");
		const ownedPage = await listUserBots(testEnv.BICKR_KV, testEnv.BICKR_D1, "usr_mcp", { limit: 1 });
		expect(legacyOwned.map((bot) => bot.handle)).toEqual(["zeta", "alpha"]);
		expect(ownedPage.bots.map((bot) => bot.handle)).toEqual(["zeta"]);
		expect(ownedPage.hasMore).toBe(true);
	});

	it("paginates Unicode participant identities through repository and MCP boundaries", async () => {
		await resetD1Schema(testEnv.BICKR_D1);
		await clearKv(testEnv.BICKR_KV);
		const updatedAt = "2026-08-11T03:00:00.000Z";
		await testEnv.BICKR_D1.batch([
			testEnv.BICKR_D1.prepare(
				`INSERT INTO entity_lifecycle_identity_claims (
					key_kind, key_scope, key_value, entity_kind, entity_id, owner_user_id,
					claim_state, operation_id, created_at, updated_at
				) VALUES ('user_handle', 'global', 'owner-漢字🪐', 'account', 'usr_mcp', 'usr_mcp', 'active', NULL, ?, ?)`,
			).bind(updatedAt, updatedAt),
			testEnv.BICKR_D1.prepare(
				`INSERT INTO users_index (user_id, handle, display_name, created_at, updated_at, lifecycle_state)
				 VALUES ('usr_mcp', 'owner-漢字🪐', 'Owner name 名🪐', ?, ?, 'active')`,
			).bind(updatedAt, updatedAt),
			activeIdentityClaim("world_handle", "global", "世界-🪐", "world", "w_unicode", "usr_mcp"),
			testEnv.BICKR_D1.prepare(
				`INSERT INTO worlds_index (
					world_id, handle, name, description, created_by_user_id, visibility,
					created_at, updated_at, lifecycle_state
				) VALUES ('w_unicode', '世界-🪐', 'World name 世界🪐', '', 'usr_mcp', 'public', ?, ?, 'active')`,
			).bind(updatedAt, updatedAt),
			activeIdentityClaim("world_handle", "global", "ascii-world", "world", "w_ascii", "usr_mcp"),
			testEnv.BICKR_D1.prepare(
				`INSERT INTO worlds_index (
					world_id, handle, name, description, created_by_user_id, visibility,
					created_at, updated_at, lifecycle_state
				) VALUES ('w_ascii', 'ascii-world', 'ASCII world', '', 'usr_mcp', 'public', ?, ?, 'active')`,
			).bind("2026-08-11T02:00:00.000Z", "2026-08-11T02:00:00.000Z"),
		]);
		const handles = ["ascii", "café", "Кириллица", "漢字", "astral-🪐"];
		const bots = handles.map((handle, index) => ({
			...testBot({ id: `bot_unicode_${index}`, handle, displayName: `Participant name ${handle}`, updatedAt }),
			homeWorldId: "w_unicode",
			homeWorldHandle: "世界-🪐",
		}));
		await Promise.all(bots.map((bot) => writeJson(testEnv.BICKR_KV, kvKeys.bot(bot.id), bot)));
		await testEnv.BICKR_D1.batch(bots.flatMap((bot) => [
			activeIdentityClaim("bot_handle", "w_unicode", bot.handle, "bot", bot.id, "usr_mcp"),
			testEnv.BICKR_D1.prepare(
				`INSERT INTO bots_index (bot_id, home_world_id, home_world_handle, handle, display_name,
					owner_user_id, short_bio, created_at, updated_at, lifecycle_state)
				 VALUES (?, 'w_unicode', '世界-🪐', ?, ?, 'usr_mcp', '', ?, ?, 'active')`,
			).bind(bot.id, bot.handle, bot.displayName.text, bot.createdAt, bot.updatedAt),
		]));

		const expected = [...handles].sort();
		const actual: string[] = [];
		const ownerHandles: string[] = [];
		let cursor: string | undefined;
		do {
			const page = await listUserBots(testEnv.BICKR_KV, testEnv.BICKR_D1, "usr_mcp", {
				limit: 1, ...(cursor ? { cursor } : {}),
			});
			actual.push(...page.bots.map((bot) => bot.handle));
			ownerHandles.push(...page.bots.map((bot) => bot.owner?.handle ?? ""));
			cursor = page.nextCursor;
			if (cursor) expect(cursor).toMatch(/^v1\./);
		} while (cursor);
		expect(actual).toEqual(expected);
		expect(ownerHandles).toEqual(Array<string>(handles.length).fill("owner-漢字🪐"));

		const accessToken = await issueAccessToken(testEnv.BICKR_KV, ["bickr.read"]);
		const mcpBots: Array<Record<string, unknown>> = [];
		let mcpCursor: string | undefined;
		do {
			const response = await callMcp(testEnv.BICKR_KV, accessToken, {
				jsonrpc: "2.0", id: 1, method: "tools/call",
				params: { name: "list_my_bots", arguments: { limit: 1, ...(mcpCursor ? { cursor: mcpCursor } : {}) } },
			}, {
				BICKR_D1: testEnv.BICKR_D1,
				AGENT_RUNTIME: canonicalAnnotationService([]),
				INTERNAL_SERVICE_SECRET: "test-internal-service-secret",
			});
			const result = (await jsonResponse(response)).result as {
				structuredContent: { bots: Array<Record<string, unknown>>; nextCursor?: string };
			};
			mcpBots.push(...result.structuredContent.bots);
			mcpCursor = result.structuredContent.nextCursor;
			if (mcpCursor) expect(mcpCursor).toMatch(/^v1\./);
		} while (mcpCursor);
		expect(mcpBots.map((bot) => bot.handle)).toEqual(expected);
		const serializedMcpBots = JSON.stringify(mcpBots);
		expect(serializedMcpBots).toContain("owner-漢字🪐");
		expect(serializedMcpBots).toContain("Owner name 名🪐");
		expect(serializedMcpBots).toContain("Participant name 漢字");
		expect(serializedMcpBots).toContain("世界-🪐");

		const mcpWorlds: Array<Record<string, unknown>> = [];
		let worldCursor: string | undefined;
		do {
			const response = await callMcp(testEnv.BICKR_KV, accessToken, {
				jsonrpc: "2.0", id: 1, method: "tools/call",
				params: { name: "list_worlds", arguments: { limit: 1, ...(worldCursor ? { cursor: worldCursor } : {}) } },
			}, {
				BICKR_D1: testEnv.BICKR_D1,
				AGENT_RUNTIME: canonicalAnnotationService([]),
				INTERNAL_SERVICE_SECRET: "test-internal-service-secret",
			});
			const result = (await jsonResponse(response)).result as {
				structuredContent: { worlds: Array<Record<string, unknown>>; nextCursor?: string };
			};
			mcpWorlds.push(...result.structuredContent.worlds);
			worldCursor = result.structuredContent.nextCursor;
			if (worldCursor) expect(worldCursor).toMatch(/^v1\./);
		} while (worldCursor);
		expect(mcpWorlds.map((world) => world.handle)).toEqual(["世界-🪐", "ascii-world"]);
		expect(JSON.stringify(mcpWorlds)).toContain("World name 世界🪐");

		const asciiLegacy = btoa(JSON.stringify({ updatedAt, handle: "ascii" }));
		expect((await listUserBots(testEnv.BICKR_KV, testEnv.BICKR_D1, "usr_mcp", {
			limit: 100, cursor: asciiLegacy,
		})).bots.map((bot) => bot.handle)).toEqual(expected.slice(1));
		const latin1Legacy = btoa(JSON.stringify({ updatedAt, handle: "café" }));
		expect((await listUserBots(testEnv.BICKR_KV, testEnv.BICKR_D1, "usr_mcp", {
			limit: 100, cursor: latin1Legacy,
		})).bots.map((bot) => bot.handle)).toEqual(expected.slice(expected.indexOf("café") + 1));

		for (const malformed of ["v1.", "v1.not-base64!", `v1.${btoa(String.fromCharCode(0xc3))}`]) {
			await expect(listUserBots(testEnv.BICKR_KV, testEnv.BICKR_D1, "usr_mcp", { cursor: malformed }))
				.rejects.toMatchObject({ code: "bad_request", status: 400 });
		}
	});

	it("executes mutation batches in order and correlates every result", async () => {
		const kv = new MapKV();
		const accessToken = await issueAccessToken(kv, ["bickr.runtime"]);
		const serviceBodies: unknown[] = [];
		const response = await callMcp(kv, accessToken, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "inject_runtime",
				arguments: {
					operations: [
						{ operationId: "first", botId: "bot_a", text: "alpha" },
						{ operationId: "second", botId: "bot_b", text: "beta" },
					],
				},
			},
		}, {
			AGENT_RUNTIME: {
				fetch: async (request: Request) => {
					serviceBodies.push(await request.json());
					return Response.json({ ok: true, data: { accepted: true } });
				},
			},
			INTERNAL_SERVICE_SECRET: "test-internal-service-secret",
		});
		const body = await jsonResponse(response);
		const result = body.result as { structuredContent: { results: Array<Record<string, unknown>>; succeeded: number; failed: number; indeterminate: number } };

		expect(serviceBodies).toEqual([{ text: "alpha" }, { text: "beta" }]);
		expect(result.structuredContent).toMatchObject({ succeeded: 2, failed: 0, indeterminate: 0 });
		expect(result.structuredContent.results).toMatchObject([
			{ operationId: "first", status: "succeeded", result: { ok: true, data: { accepted: true } } },
			{ operationId: "second", status: "succeeded", result: { ok: true, data: { accepted: true } } },
		]);
	});

	it("maps inference library section, kind, and search parameters onto the runtime service", async () => {
		const kv = new MapKV();
		const accessToken = await issueAccessToken(kv, ["bickr.read"]);
		const requestedPaths: string[] = [];
		const utf8Cursor = encodeOpaqueJsonCursor({
			order: "identity", sortName: "🧿🪐", id: "cfg_unicode",
		});
		const cursorBody = utf8Cursor.slice("v1.".length);
		const encodedCursor = encodeURIComponent(utf8Cursor);
		expect(cursorBody).toContain("+");
		expect(cursorBody).toContain("/");
		expect(cursorBody).toContain("=");
		expect(encodedCursor).toContain("%2B");
		expect(encodedCursor).toContain("%2F");
		expect(encodedCursor).toContain("%3D");
		const agentRuntime = {
			fetch: async (request: Request) => {
				const url = new URL(request.url);
				requestedPaths.push(url.pathname + url.search);
				return Response.json({
					ok: true,
					data: { configurations: {
						section: "bot", items: [], groups: [],
						...(url.searchParams.get("limit") === "1" && !url.searchParams.has("cursor")
							? { nextCursor: utf8Cursor }
							: {}),
					} },
				});
			},
		};
		const callRead = async (name: string, args: Record<string, unknown>) => callMcp(kv, accessToken, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name, arguments: args },
		}, { AGENT_RUNTIME: agentRuntime, INTERNAL_SERVICE_SECRET: "test-internal-service-secret" });

		expect((await callRead("list_inference_configurations", {
			section: "bot",
			query: "home-world",
			limit: 25,
		})).status).toBe(200);
		expect((await callRead("list_inference_configurations", { kind: "custom,world" })).status).toBe(200);
		const firstBoundedResponse = await callRead("list_inference_configurations", { limit: 1 });
		const firstBoundedResult = (await jsonResponse(firstBoundedResponse)).result as {
			structuredContent: { data: { configurations: { nextCursor: string } } };
		};
		expect(firstBoundedResult.structuredContent.data.configurations.nextCursor).toBe(utf8Cursor);
		expect((await callRead("list_inference_configurations", {
			cursor: firstBoundedResult.structuredContent.data.configurations.nextCursor,
			limit: 1,
		})).status).toBe(200);
		expect((await callRead("list_inference_configuration_children", {
			configurationId: "cfg_children",
			query: "child",
			limit: 10,
		})).status).toBe(200);
		expect((await callRead("list_inference_parent_candidates", {
			configurationId: "cfg_parent",
			query: "alpha",
		})).status).toBe(200);

		expect(requestedPaths).toEqual([
			"/users/usr_mcp/inference-configurations?section=bot&q=home-world&limit=25",
			"/users/usr_mcp/inference-configurations?kind=custom%2Cworld",
			"/users/usr_mcp/inference-configurations?limit=1",
			`/users/usr_mcp/inference-configurations?cursor=${encodedCursor}&limit=1`,
			"/users/usr_mcp/inference-configurations/cfg_children/children?q=child&limit=10",
			"/users/usr_mcp/inference-configurations/cfg_parent/parent-candidates?q=alpha",
		]);
	});

	it("continues a mutation batch after a definitive service failure", async () => {
		const kv = new MapKV();
		const accessToken = await issueAccessToken(kv, ["bickr.runtime"]);
		let callCount = 0;
		const response = await callMcp(kv, accessToken, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "inject_runtime",
				arguments: {
					operations: [
						{ operationId: "first", botId: "bot_a", text: "alpha" },
						{ operationId: "second", botId: "bot_b", text: "beta" },
						{ operationId: "third", botId: "bot_c", text: "gamma" },
					],
				},
			},
		}, {
			AGENT_RUNTIME: {
				fetch: async () => {
					callCount += 1;
					if (callCount === 2) {
						return Response.json({ ok: false, error: "rejected", message: "second operation failed" }, { status: 409 });
					}
					return Response.json({ ok: true, data: { accepted: true } });
				},
			},
			INTERNAL_SERVICE_SECRET: "test-internal-service-secret",
		});
		const body = await jsonResponse(response);
		const result = body.result as { structuredContent: { results: Array<Record<string, unknown>>; succeeded: number; failed: number; indeterminate: number } };

		expect(callCount).toBe(3);
		expect(result.structuredContent).toMatchObject({ succeeded: 2, failed: 1, indeterminate: 0 });
		expect(result.structuredContent.results).toMatchObject([
			{ operationId: "first", status: "succeeded" },
			{ operationId: "second", status: "failed", error: { message: "second operation failed" } },
			{ operationId: "third", status: "succeeded" },
		]);
	});

	it("reports thrown mutation outcomes as indeterminate and continues in order", async () => {
		const kv = new MapKV();
		const accessToken = await issueAccessToken(kv, ["bickr.runtime"]);
		let callCount = 0;
		const response = await callMcp(kv, accessToken, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "inject_runtime",
				arguments: {
					operations: [
						{ operationId: "first", botId: "bot_a", text: "alpha" },
						{ operationId: "second", botId: "bot_b", text: "beta" },
						{ operationId: "third", botId: "bot_c", text: "gamma" },
					],
				},
			},
		}, {
			AGENT_RUNTIME: {
				fetch: async () => {
					callCount += 1;
					if (callCount === 2) {
						throw new Error("response was not observed");
					}
					return Response.json({ ok: true, data: { accepted: true } });
				},
			},
			INTERNAL_SERVICE_SECRET: "test-internal-service-secret",
		});
		const body = await jsonResponse(response);
		const result = body.result as { structuredContent: { results: Array<Record<string, unknown>>; succeeded: number; failed: number; indeterminate: number } };

		expect(callCount).toBe(3);
		expect(result.structuredContent).toMatchObject({ succeeded: 2, failed: 0, indeterminate: 1 });
		expect(result.structuredContent.results).toMatchObject([
			{ operationId: "first", status: "succeeded" },
			{ operationId: "second", status: "indeterminate", error: { message: "response was not observed" } },
			{ operationId: "third", status: "succeeded" },
		]);
	});

	it("sets isError when every mutation receives a definitive failure", async () => {
		const kv = new MapKV();
		const accessToken = await issueAccessToken(kv, ["bickr.runtime"]);
		const response = await callMcp(kv, accessToken, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "inject_runtime",
				arguments: { operations: [{ operationId: "rejected", botId: "bot_a", text: "alpha" }] },
			},
		}, {
			AGENT_RUNTIME: { fetch: async () => Response.json({ ok: false, error: "rejected", message: "not accepted" }, { status: 409 }) },
			INTERNAL_SERVICE_SECRET: "test-internal-service-secret",
		});
		const body = await jsonResponse(response);

		expect(body.result).toMatchObject({
			isError: true,
			structuredContent: {
				results: [{ operationId: "rejected", status: "failed" }],
				succeeded: 0,
				failed: 1,
				indeterminate: 0,
			},
		});
	});

	it("echoes operation IDs exactly", async () => {
		const kv = new MapKV();
		const accessToken = await issueAccessToken(kv, ["bickr.runtime"]);
		const response = await callMcp(kv, accessToken, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "inject_runtime",
				arguments: {
					operations: [
						{ operationId: " op ", botId: "bot_a", text: "alpha" },
						{ operationId: "op", botId: "bot_b", text: "beta" },
					],
				},
			},
		}, {
			AGENT_RUNTIME: { fetch: async () => Response.json({ ok: true, data: { accepted: true } }) },
			INTERNAL_SERVICE_SECRET: "test-internal-service-secret",
		});
		const body = await jsonResponse(response);
		const result = body.result as { structuredContent: { results: Array<{ operationId: string }> } };

		expect(result.structuredContent.results.map(({ operationId }) => operationId)).toEqual([" op ", "op"]);
	});

	it("rejects structurally invalid mutation batches before dispatching any operation", async () => {
		const invalidArguments: Array<Record<string, unknown>> = [
			{ extra: true, operations: [{ operationId: "one", botId: "bot_a", text: "alpha" }] },
			{ operations: [] },
			{ operations: Array.from({ length: 21 }, (_, index) => ({ operationId: `op-${index}`, botId: "bot_a", text: "alpha" })) },
			{ operations: [{ operationId: "same", botId: "bot_a", text: "alpha" }, { operationId: "same", botId: "bot_b", text: "beta" }] },
			{ operations: ["not-an-object"] },
			{ operations: [{ operationId: "missing-text", botId: "bot_a" }] },
			{ operations: [{ operationId: "extra-key", botId: "bot_a", text: "alpha", unexpected: true }] },
			{ operations: [{ operationId: "   ", botId: "bot_a", text: "alpha" }] },
		];

		for (const argumentsValue of invalidArguments) {
			const kv = new MapKV();
			const accessToken = await issueAccessToken(kv, ["bickr.runtime"]);
			let callCount = 0;
			const response = await callMcp(kv, accessToken, {
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "inject_runtime", arguments: argumentsValue },
			}, {
				AGENT_RUNTIME: {
					fetch: async () => {
						callCount += 1;
						return Response.json({ ok: true });
					},
				},
				INTERNAL_SERVICE_SECRET: "test-internal-service-secret",
			});
			const body = await jsonResponse(response);

			expect(callCount).toBe(0);
			expect(body.result).toMatchObject({ isError: true });
		}
	});

	// inject_runtime predates the pause tools, so exercising the boundary here
	// proves the ceiling belongs to the shared mutation envelope rather than to
	// any one tool's own validation.
	it("admits the largest mutation batch and rejects one operation more before dispatch", async () => {
		const submit = async (operationCount: number) => {
			const kv = new MapKV();
			const accessToken = await issueAccessToken(kv, ["bickr.runtime"]);
			let callCount = 0;
			const response = await callMcp(kv, accessToken, {
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "inject_runtime",
					arguments: {
						operations: Array.from({ length: operationCount }, (_unused, index) => ({
							operationId: `op-${index}`,
							botId: `bot_${index}`,
							text: "alpha",
						})),
					},
				},
			}, {
				AGENT_RUNTIME: {
					fetch: async () => {
						callCount += 1;
						return Response.json({ ok: true, data: { accepted: true } });
					},
				},
				INTERNAL_SERVICE_SECRET: "test-internal-service-secret",
			});
			return { callCount, result: (await jsonResponse(response)).result as Record<string, unknown> };
		};

		const admitted = await submit(20);
		expect(admitted.callCount).toBe(20);
		expect(admitted.result).not.toHaveProperty("isError");
		expect(admitted.result).toMatchObject({
			structuredContent: { succeeded: 20, failed: 0, indeterminate: 0 },
		});

		const rejected = await submit(21);
		expect(rejected.callCount).toBe(0);
		expect(rejected.result).toMatchObject({
			isError: true,
			structuredContent: { message: expect.stringContaining("At most 20 operations") },
		});
	});

	it("requires a complete profile before dispatching a bulk mutation", async () => {
		const kv = new MapKV();
		const accessToken = await issueAccessToken(kv, ["bickr.runtime"]);
		await kv.put(kvKeys.user("usr_mcp"), JSON.stringify({ ...testUser(), profileCompletedAt: null }));
		let callCount = 0;
		const response = await callMcp(kv, accessToken, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "inject_runtime",
				arguments: { operations: [{ operationId: "one", botId: "bot_a", text: "alpha" }] },
			},
		}, {
			AGENT_RUNTIME: { fetch: async () => { callCount += 1; return Response.json({ ok: true }); } },
			INTERNAL_SERVICE_SECRET: "test-internal-service-secret",
		});
		const body = await jsonResponse(response);

		expect(callCount).toBe(0);
		expect(body.result).toMatchObject({
			isError: true,
			structuredContent: { message: expect.stringContaining("Complete your Bickr profile") },
		});
	});

	it("rejects legacy vote fields inside bulk operations before dispatch", async () => {
		const kv = new MapKV();
		const bot = testBot({ id: "bot_source", handle: "source-bot" });
		await kv.put(kvKeys.bot(bot.id), JSON.stringify(bot));
		const accessToken = await issueAccessToken(kv, ["bickr.write"]);
		let callCount = 0;
		const response = await callMcp(kv, accessToken, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "vote",
				arguments: { operations: [{ operationId: "legacy", botId: bot.id, threadId: "thr_old", value: 1 }] },
			},
		}, {
			BICKR_D1: mcpSettingsD1(),
			FORUM_COORDINATOR_SERVICE: { fetch: async () => { callCount += 1; return Response.json({ ok: true }); } },
			INTERNAL_SERVICE_SECRET: "test-internal-service-secret",
		});
		const body = await jsonResponse(response);

		expect(callCount).toBe(0);
		expect(body.result).toMatchObject({ isError: true, structuredContent: { message: expect.stringContaining("threadId") } });
	});

	it("rejects JSON-RPC batch request bodies for the advertised MCP protocol", async () => {
		const kv = new MapKV();
		const accessToken = await issueAccessToken(kv, ["bickr.read"]);
		const response = await callMcp(kv, accessToken, [{ jsonrpc: "2.0", id: 1, method: "ping" }]);
		const body = await jsonResponse(response);

		expect(body).toEqual({
			jsonrpc: "2.0",
			id: null,
			error: { code: -32600, message: "Invalid Request." },
		});
	});

	it("binds exhaustive reusable-inference schemas to the 27-field registry", () => {
		const byName = new Map(mcpToolMetadataForTest().map((tool) => [tool.name, tool]));
		for (const toolName of ["create_inference_configuration", "update_inference_configuration"] as const) {
			const overrides = schemaProperties(schemaProperty(byName, toolName, "overrides"));
			expect(Object.keys(overrides)).toHaveLength(27);
			expect(Object.keys(overrides)).toEqual(expect.arrayContaining([
				"compactionReasoning", "promptCacheMode", "imageRepetitionPenalty",
			]));
			expect((schemaProperties(overrides.temperature as Record<string, unknown>).value as Record<string, unknown>))
				.toMatchObject({ type: "number", minimum: 0, maximum: 2 });
		}
		const createModelKinds = schemaProperties(schemaProperties(schemaProperty(byName, "create_inference_configuration", "overrides")).model as Record<string, unknown>).kind as Record<string, unknown>;
		const patchModelKinds = schemaProperties(schemaProperties(schemaProperty(byName, "update_inference_configuration", "overrides")).model as Record<string, unknown>).kind as Record<string, unknown>;
		expect(createModelKinds.enum).toEqual(["value"]);
		expect(patchModelKinds.enum).toEqual(["inherit", "value"]);
		const credential = schemaProperty(byName, "create_inference_configuration", "credential");
		expect(credential).toMatchObject({ additionalProperties: false, required: ["mode"] });
		expect(schemaProperties(credential).mode).toMatchObject({ enum: ["inherit", "account_default", "none", "value"] });
		expect(byName.get("get_fixed_inference_configuration")?.outputSchema).toBeDefined();
	});

	it("publishes explicit inference output contracts that accept representative results", () => {
		const byName = new Map(mcpToolMetadataForTest().map((tool) => [tool.name, tool]));
		const inferenceTools = [
			"get_profile", "update_profile", "list_inference_configurations", "get_inference_configuration",
			"get_fixed_inference_configuration", "create_inference_configuration", "update_inference_configuration",
			"rename_inference_configuration", "reparent_inference_configuration", "list_inference_parent_candidates",
			"list_inference_configuration_children", "get_inference_configuration_delete_impact",
			"get_inference_configuration_parent_impact", "delete_inference_configuration",
		];
		for (const name of inferenceTools) expect(byName.get(name)?.outputSchema, `${name} outputSchema`).toBeDefined();
		const annotation = canonicalAnnotation("account_default", "cfg_account", "xiaomi/mimo-v2.5");
		expectSchemaAccepts(byName.get("get_profile")!.outputSchema!, {
			profile: { id: "usr_mcp", handle: "mcp-user", inferenceConfigurations: { graphRevision: 7, accountDefault: annotation } },
		});
		expectSchemaAccepts(byName.get("get_fixed_inference_configuration")!.outputSchema!, {
			annotation, graphRevision: 7,
		});
		expectSchemaAccepts(byName.get("list_inference_configurations")!.outputSchema!, {
			ok: true, data: { configurations: { items: [(annotation.configuration as Record<string, unknown>)] } },
		});
		expectSchemaAccepts(byName.get("get_inference_configuration")!.outputSchema!, {
			ok: true,
			data: { configuration: {
				id: "cfg_custom", kind: "custom", identity: { kind: "custom", name: "Portable" },
				revision: 3, graphRevision: 7,
				fields: Object.fromEntries(inferenceConfigurationFields.map((field) => [field, {
					override: { kind: "inherit" }, effective: null, source: { kind: "bickr_default" }, adjustment: null,
				}])),
				path: [{ id: "cfg_custom", displayName: "Portable", revision: 3, kind: "custom", identity: { kind: "custom", name: "Portable" } }],
			} },
		});
		expectSchemaAccepts(byName.get("get_inference_configuration_delete_impact")!.outputSchema!, {
			ok: true,
			data: { impact: {
				kind: "delete", configurationId: "cfg_custom", parentId: "cfg_account", immediateChildren: 1,
				immediateDependentCount: 1, transitiveDependentCount: 2, affectedConfigurationCount: 3,
				changes: { effectiveModel: 1, effectiveBaseUrl: 0, credentialAvailability: 0, credentialSource: 0, providerAccess: 0 },
				warnings: [{ kind: "effective_model_changes", configurations: 1 }],
			} },
		});
		expectSchemaAccepts(byName.get("update_inference_configuration")!.outputSchema!, {
			results: [{ operationId: "update", status: "succeeded", result: { ok: true } }],
			succeeded: 1, failed: 0, indeterminate: 0,
		});
	});

	it("rejects reusable provider fields on singleton and bulk entity mutations", async () => {
		const kv = new MapKV();
		const accessToken = await issueAccessToken(kv, ["bickr.write"]);
		let calls = 0;
		const environment = {
			BICKR_D1: emptyD1(),
			AGENT_RUNTIME: { fetch: async () => { calls += 1; return Response.json({ ok: true, data: {} }); } },
			INTERNAL_SERVICE_SECRET: "test-internal-service-secret",
		};
		for (const [name, args] of [
			["update_profile", { inferenceSettings: { model: "forbidden/model" } }],
			["update_bot", { botId: "bot_one", inferenceSettings: { providerRouting: {} } }],
			["update_world", { operations: [{ operationId: "world", worldHandle: "mcp-world", imageGeneration: { model: "forbidden/image" } }] }],
		] as const) {
			const response = await callMcp(kv, accessToken, {
				jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args },
			}, environment);
			expect((await jsonResponse(response)).result).toMatchObject({ isError: true });
		}
		expect(calls).toBe(0);
	});

	it("looks up fixed canonical configurations without a library scan", async () => {
		const kv = new MapKV();
		const accessToken = await issueAccessToken(kv, ["bickr.read"]);
		const annotation = canonicalAnnotation("account_default", "cfg_account", "xiaomi/mimo-v2.5");
		const response = await callMcp(kv, accessToken, {
			jsonrpc: "2.0", id: 1, method: "tools/call",
			params: { name: "get_fixed_inference_configuration", arguments: { kind: "account_default" } },
		}, { AGENT_RUNTIME: canonicalAnnotationService([annotation]), INTERNAL_SERVICE_SECRET: "test-internal-service-secret" });
		expect((await jsonResponse(response)).result).toMatchObject({
			structuredContent: { annotation: { kind: "canonical", configuration: { effectiveModel: "xiaomi/mimo-v2.5" } } },
		});
	});

	it("returns typed not_found for an empty fixed canonical lookup", async () => {
		const kv = new MapKV();
		const accessToken = await issueAccessToken(kv, ["bickr.read"]);
		const response = await callMcp(kv, accessToken, {
			jsonrpc: "2.0", id: 1, method: "tools/call",
			params: { name: "get_fixed_inference_configuration", arguments: { kind: "translation" } },
		}, { AGENT_RUNTIME: canonicalAnnotationService([]), INTERNAL_SERVICE_SECRET: "test-internal-service-secret" });
		expect((await jsonResponse(response)).result).toMatchObject({
			isError: true,
			structuredContent: { error: "not_found" },
		});
	});

	it("sends real inference configuration mutation bodies and preserves impact reads", async () => {
		const kv = new MapKV();
		const accessToken = await issueAccessToken(kv, ["bickr.read", "bickr.write"]);
		const observed: Array<{ method: string; path: string; body: unknown }> = [];
		const service = { fetch: async (request: Request) => {
			observed.push({ method: request.method, path: new URL(request.url).pathname + new URL(request.url).search, body: request.method === "GET" ? null : await request.json() });
			return Response.json({ ok: true, data: { configuration: { id: "cfg_custom" }, impact: { kind: "delete" } } });
		} };
		const environment = { BICKR_D1: emptyD1(), AGENT_RUNTIME: service, INTERNAL_SERVICE_SECRET: "test-internal-service-secret" };
		const mutation = async (name: string, args: Record<string, unknown>) => callMcp(kv, accessToken, {
			jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { operations: [{ operationId: name, ...args }] } },
		}, environment);
		await mutation("create_inference_configuration", { name: "Portable", parentId: "cfg_account", overrides: { model: { kind: "value", value: "xiaomi/mimo-v2.5" } }, credential: { mode: "none" } });
		await mutation("update_inference_configuration", { configurationId: "cfg_custom", expectedRevision: 1, overrides: { model: { kind: "inherit" } } });
		await mutation("rename_inference_configuration", { configurationId: "cfg_custom", name: "Renamed", expectedRevision: 2 });
		await mutation("reparent_inference_configuration", { configurationId: "cfg_custom", parentId: "cfg_account", expectedRevision: 3 });
		await mutation("delete_inference_configuration", { configurationId: "cfg_custom", expectedRevision: 4 });
		await callMcp(kv, accessToken, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_inference_configuration_parent_impact", arguments: { configurationId: "cfg_custom", parentId: "cfg_account" } } }, environment);
		expect(observed).toMatchObject([
			{ method: "POST", path: "/users/usr_mcp/inference-configurations", body: {
				name: "Portable", parentId: "cfg_account",
				overrides: { model: { kind: "value", value: "xiaomi/mimo-v2.5" } },
				credential: { mode: "none" },
			} },
			{ method: "PATCH", path: "/users/usr_mcp/inference-configurations/cfg_custom", body: {
				expectedRevision: 1, overrides: { model: { kind: "inherit" } },
			} },
			{ method: "POST", path: "/users/usr_mcp/inference-configurations/cfg_custom/rename", body: { name: "Renamed", expectedRevision: 2 } },
			{ method: "POST", path: "/users/usr_mcp/inference-configurations/cfg_custom/reparent", body: { parentId: "cfg_account", expectedRevision: 3 } },
			{ method: "DELETE", path: "/users/usr_mcp/inference-configurations/cfg_custom", body: { expectedRevision: 4 } },
			{ method: "GET", path: "/users/usr_mcp/inference-configurations/cfg_custom/impact?parentId=cfg_account", body: null },
		]);
	});

	it("keeps committed bot mutations successful when canonical enrichment fails", async () => {
		const kv = new MapKV();
		const accessToken = await issueAccessToken(kv, ["bickr.write"]);
		const bot = testBot({ id: "bot_committed", handle: "committed" });
		const service = { fetch: async (request: Request) => {
			if (new URL(request.url).pathname.endsWith("/inference-consumers/annotations")) throw new Error("injected enrichment failure");
			return Response.json({ ok: true, data: { bot } });
		} };
		const response = await callMcp(kv, accessToken, {
			jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "update_bot", arguments: {
				operations: [{ operationId: "committed", botId: bot.id, prompt: lt("updated") }],
			} },
		}, { BICKR_D1: emptyD1(), AGENT_RUNTIME: service, INTERNAL_SERVICE_SECRET: "test-internal-service-secret" });
		expect((await jsonResponse(response)).result).toMatchObject({ structuredContent: {
			results: [{ operationId: "committed", status: "succeeded", resultWarning: { kind: "canonical_inference_enrichment_failed" } }],
			succeeded: 1,
		} });
	});

	it("bounds and prompt-sanitizes every affected participant in bot mutation receipts", async () => {
		const kv = new MapKV();
		const accessToken = await issueAccessToken(kv, ["bickr.write"]);
		const primary = testBot({ id: "bot_receipt_primary", handle: "receipt-primary" });
		const reusableSettings = {
			model: "private/model", baseUrl: "https://private.invalid", providerRouting: { only: ["private"] },
			reasoningEffort: "high" as const, temperature: 0.7, topP: 0.8,
			translation: { enabled: true, model: "private/translation", reasoningEffort: "medium" as const, temperature: 0.4 },
			imageGeneration: { model: "private/image", prompt: lt("portrait") },
		};
		const firstAffected = {
			...testBot({ id: "bot_affected_000", handle: "affected-000", inferenceSettings: reusableSettings }),
			localOverrides: {
				language: en, includeLanguageInSystemPrompt: false,
				displayName: lt(""), shortBio: lt(""), prompt: lt(""),
				inferenceSettings: reusableSettings, hasAvatar: false,
			},
		};
		const affectedBots = [firstAffected, ...Array.from({ length: 100 }, (_unused, index) => testBot({
			id: `bot_affected_${String(index + 1).padStart(3, "0")}`,
			handle: `affected-${String(index + 1).padStart(3, "0")}`,
		}))];
		const service = { fetch: async (request: Request) => {
			if (new URL(request.url).pathname.endsWith("/inference-consumers/annotations")) {
				return Response.json({ ok: true, data: { annotations: [], graphRevision: 7 } });
			}
			return Response.json({ ok: true, data: { bot: primary, affectedBots } });
		} };
		const response = await callMcp(kv, accessToken, {
			jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "update_bot", arguments: {
				operations: [{ operationId: "sanitize-receipt", botId: primary.id, prompt: lt("updated") }],
			} },
		}, { BICKR_D1: emptyD1(), AGENT_RUNTIME: service, INTERNAL_SERVICE_SECRET: "test-internal-service-secret" });
		const result = (await jsonResponse(response)).result as {
			structuredContent: {
				results: Array<{ result: { data: {
					affectedBots: Array<{ inferenceSettings: Record<string, unknown>; localOverrides?: { inferenceSettings: Record<string, unknown> } }>;
					affectedBotsPresentation: { maximumEntities: number; truncated: boolean };
				} } }>;
			};
		};
		const data = result.structuredContent.results[0]!.result.data;
		expect(data.affectedBots).toHaveLength(99);
		expect(data.affectedBotsPresentation).toEqual({ maximumEntities: 99, truncated: true });
		expect(data.affectedBots[0]!.inferenceSettings).toEqual({ imageGeneration: { prompt: lt("portrait") } });
		expect(data.affectedBots[0]!.localOverrides?.inferenceSettings).toEqual({ imageGeneration: { prompt: lt("portrait") } });
		for (const settings of [data.affectedBots[0]!.inferenceSettings, data.affectedBots[0]!.localOverrides!.inferenceSettings]) {
			for (const key of ["model", "baseUrl", "providerRouting", "reasoningEffort", "temperature", "topP", "translation"]) {
				expect(settings).not.toHaveProperty(key);
			}
		}
	});

	it("keeps a committed singleton profile mutation successful when canonical enrichment fails", async () => {
		const kv = new MapKV();
		const accessToken = await issueAccessToken(kv, ["bickr.write"]);
		const profile = testUser({
			displayName: lt("Updated profile"),
			inferenceSettings: { model: "private/singleton-model", openRouterApiKey: "singleton-secret" },
		});
		const service = { fetch: async (request: Request) => {
			if (new URL(request.url).pathname.endsWith("/inference-consumers/annotations")) {
				throw new Error("injected singleton enrichment failure");
			}
			return Response.json({ ok: true, data: {
				kind: "profile_updated", profile,
				affectedBots: Array.from({ length: 101 }, (_unused, index) => testBot({
					id: `bot_singleton_leak_${index}`, handle: `singleton-leak-${index}`,
					inferenceSettings: { model: "private/affected-model" },
				})),
			} });
		} };
		const response = await callMcp(kv, accessToken, {
			jsonrpc: "2.0", id: 1, method: "tools/call", params: {
				name: "update_profile", arguments: { displayName: lt("Updated profile"), lang: "en" },
			},
		}, { BICKR_D1: emptyD1(), AGENT_RUNTIME: service, INTERNAL_SERVICE_SECRET: "test-internal-service-secret" });
		const result = (await jsonResponse(response)).result;
		expect(result).toMatchObject({ structuredContent: {
			result: null,
			presentationWarning: { kind: "canonical_inference_enrichment_failed" },
		} });
		expect(JSON.stringify(result)).not.toMatch(/singleton-secret|private\/singleton-model|private\/affected-model|affectedBots/);
	});

	it("omits empty world image-generation settings from mutation presentation", async () => {
		const kv = new MapKV();
		const accessToken = await issueAccessToken(kv, ["bickr.write"]);
		const world = {
			id: "wld_empty_image", handle: "empty-image", language: en,
			name: lt("Empty image"), description: lt(""), prompt: lt(""),
			recurringPromptEnabled: false, recurringPrompt: lt(""), initialBotNotification: lt(""),
			imageGeneration: { model: "private/provider-model" },
			createdByUserId: "usr_mcp", createdAt: "2026-08-11T00:00:00.000Z", updatedAt: "2026-08-11T00:00:00.000Z",
		};
		const service = { fetch: async (request: Request) => {
			if (new URL(request.url).pathname.endsWith("/inference-consumers/annotations")) {
				return Response.json({ ok: true, data: { annotations: [], graphRevision: 7 } });
			}
			return Response.json({ ok: true, data: { world } });
		} };
		const response = await callMcp(kv, accessToken, {
			jsonrpc: "2.0", id: 1, method: "tools/call",
			params: { name: "update_world", arguments: { worldHandle: world.handle } },
		}, { BICKR_D1: emptyD1(), AGENT_RUNTIME: service, INTERNAL_SERVICE_SECRET: "test-internal-service-secret" });
		const responseBody = await jsonResponse(response);
		if (!responseBody.result) throw new Error(JSON.stringify(responseBody));
		const result = responseBody.result as { structuredContent: { data: { world: Record<string, unknown> } } };
		expect(result.structuredContent.data.world).not.toHaveProperty("imageGeneration");
		expect(JSON.stringify(result.structuredContent.data.world)).not.toContain("private/provider-model");
	});

	it("rejects write tools before execution when the token has read scope only", async () => {
		const kv = new MapKV();
		const accessToken = await issueAccessToken(kv, ["bickr.read"]);
		const response = await callMcp(kv, accessToken, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "create_world",
				arguments: {
					handle: "new-world",
					name: "New World",
					description: "A new world",
				},
			},
		});

		expect(response.status).toBe(403);
		expect(response.headers.get("www-authenticate")).toContain("insufficient_scope");
		expect(response.headers.get("www-authenticate")).toContain("bickr.write");
	});
});

async function callMcp(kv: KVNamespaceLike, accessToken: string | null, body: unknown, env: Record<string, unknown> = {}): Promise<Response> {
	const headers = new Headers({ "content-type": "application/json" });
	if (accessToken) {
		headers.set("authorization", `Bearer ${accessToken}`);
	}
	const {
		AGENT_RUNTIME: upstreamAgentRuntime,
		MAINTENANCE_ENABLED: maintenanceEnabled = false,
		...restEnv
	} = env;
	const agentRuntime = upstreamAgentRuntime as { fetch(request: Request): Promise<Response> } | undefined;
	return onRequestPost(pagesContext(new Request("https://bickr.social/mcp", {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	}), {
		BICKR_KV: kv,
		...restEnv,
		BICKR_D1: maintenanceAwareD1(restEnv.BICKR_D1 ?? emptyD1(), maintenanceEnabled === true),
		AGENT_RUNTIME: {
			fetch: async (request: Request) => {
				if (!agentRuntime) {
					return Response.json({ ok: false, error: "not_found", message: "Agent runtime mock is not configured." }, { status: 404 });
				}
				return agentRuntime.fetch(request);
			},
		},
	}));
}

function maintenanceAwareD1(database: unknown, enabled: boolean): unknown {
	const db = database as {
		batch(statements: unknown[]): Promise<unknown[]>;
		prepare(sql: string): unknown;
	};
	return {
		batch: (statements: unknown[]) => db.batch(statements),
		prepare: (sql: string) => {
			if (!sql.includes("FROM maintenance_control")) {
				return db.prepare(sql);
			}
			const statement = {
				bind() {
					return statement;
				},
				first: async () => ({
					enabled: enabled ? 1 : 0,
					message: "Scheduled maintenance.",
					activatedAt: enabled ? "2026-08-02T00:00:00.000Z" : null,
					updatedAt: "2026-08-02T00:00:00.000Z",
				}),
				all: async () => ({ success: true, results: [] }),
				run: async () => ({ success: true, meta: { changes: 0 } }),
			};
			return statement;
		},
	};
}

function pagesContext(request: Request, env: Record<string, unknown> = {}): TestPagesContext {
	return {
		env,
		request,
		params: {},
		data: {},
		waitUntil: () => undefined,
		passThroughOnException: () => undefined,
		next: () => Promise.resolve(new Response(null)),
		functionPath: new URL(request.url).pathname,
	} as unknown as TestPagesContext;
}

async function jsonResponse(response: Response): Promise<Record<string, unknown>> {
	return await response.json() as Record<string, unknown>;
}

async function issueAccessToken(kv: KVNamespaceLike, scopes: string[], user = testUser()): Promise<string> {
	await kv.put(kvKeys.user("usr_mcp"), JSON.stringify(user));
	const now = new Date();
	const client = await registerMcpClient(kv, {
		clientName: "MCP Inspector",
		redirectUris: ["http://localhost:5173/callback"],
	}, now);
	const codeVerifier = "correct-horse-battery-staple-correct-horse-battery-staple";
	const issued = await createMcpAuthorizationCode(kv, {
		clientId: client.id,
		redirectUri: "http://localhost:5173/callback",
		resource: "https://bickr.social/mcp",
		userId: "usr_mcp",
		scopes,
		codeChallenge: await pkceS256(codeVerifier),
		codeChallengeMethod: "S256",
	}, now);
	const tokens = await exchangeMcpAuthorizationCode(kv, {
		code: issued.code,
		clientId: client.id,
		redirectUri: "http://localhost:5173/callback",
		codeVerifier,
		resource: "https://bickr.social/mcp",
	}, now);
	return tokens.accessToken;
}

function canonicalAnnotation(kind: "account_default" | "translation", id: string, effectiveModel: string): Record<string, unknown> {
	return {
		kind: "canonical",
		reference: { kind },
		configuration: {
			id,
			kind,
			identity: { kind },
			parentId: null,
			displayName: kind === "translation" ? "Translation" : "Account default",
			revision: 2,
			updatedAt: "2026-08-11T00:00:00.000Z",
			credentialMode: "none",
			credentialAvailability: { kind: "explicit_none", source: { kind: "account_default", configurationId: id, depth: 0 } },
			immediateChildCount: 0,
			effectiveModel,
			parent: null,
		},
	};
}

function canonicalAnnotationService(annotations: unknown[]): { fetch(request: Request): Promise<Response> } {
	return {
		fetch: async (request: Request) => {
			expect(new URL(request.url).pathname).toBe("/users/usr_mcp/inference-consumers/annotations");
			return Response.json({ ok: true, data: { annotations, graphRevision: 7 } });
		},
	};
}

class MapKV implements KVNamespaceLike {
	private readonly data = new Map<string, string>();

	async get(key: string, options?: { type: "json" }): Promise<unknown> {
		const value = this.data.get(key);
		if (value === undefined) {
			return null;
		}
		return options?.type === "json" ? JSON.parse(value) as unknown : value;
	}

	async put(key: string, value: string): Promise<void> {
		this.data.set(key, value);
	}

	async delete(key: string): Promise<void> {
		this.data.delete(key);
	}
}

function emptyD1(): unknown {
	const statement = {
		bind() {
			return statement;
		},
		first: async () => null,
		all: async () => ({ success: true, results: [] }),
		run: async () => ({ success: true, meta: { changes: 0 } }),
	};
	return {
		batch: async () => [],
		prepare: () => statement,
	};
}

function mcpSettingsD1(): unknown {
	const statement = {
		values: [] as unknown[],
		bind(...values: unknown[]) {
			this.values = values;
			return this;
		},
		async first<T>() {
			const sql = String((this as { sql?: string }).sql ?? "");
			const firstValue = this.values[0];
			if (sql.includes("FROM bots_index")) {
				return (firstValue === "bot_source" || firstValue === "bot_clone" ? { deletedAt: null } : null) as T | null;
			}
			if (sql.includes("FROM bot_clone_sources")) {
				return (firstValue === "bot_clone" ?
					{
						sourceBotId: "bot_source",
						sourceWorldId: "w_mcp",
						sourceWorldHandle: "mcp-world",
						sourceHandle: "source-bot",
						clonedAt: "2026-05-02T00:00:00.000Z",
						linked: 1,
						unlinkedAt: null,
						relinkedAt: null,
					}
				:	null) as T | null;
			}
			if (sql.includes("FROM worlds_index")) {
				return {
					id: "w_mcp",
					handle: "mcp-world",
					postingThreadBodyCharacters: 6000,
					postingCommentBodyCharacters: null,
				} as T;
			}
			return null;
		},
		async all<T>() {
			return { success: true, results: [] as T[] };
		},
		async run() {
			return { success: true, meta: { changes: 0 } };
		},
	};
	return {
		batch: async () => [],
		prepare: (sql: string) => ({ ...statement, sql, values: [] }),
	};
}

function mcpSubscriptionD1(actualWorldId: string | null): unknown {
	let stored: Record<string, unknown> | null = null;
	return {
		batch: async () => [],
		prepare: (sql: string) => {
			const statement = {
				values: [] as unknown[],
				bind(...values: unknown[]) {
					this.values = values;
					return this;
				},
				async all<T>() {
					if (!sql.includes("actualWorldId")) {
						return { success: true, results: [] as T[] };
					}
					return {
						success: true,
						results: [{
							position: 0,
							scopeType: this.values[0],
							scopeId: this.values[1],
							claimedWorldId: this.values[2],
							actualWorldId,
						}] as T[],
					};
				},
				async run() {
					if (sql.includes("INSERT INTO human_subscriptions")) {
						stored = {
							id: this.values[0],
							userId: this.values[1],
							worldId: this.values[2],
							scopeType: this.values[3],
							scopeId: this.values[4],
							active: 1,
							autoCreated: this.values[5],
							createdAt: this.values[6],
							updatedAt: this.values[7],
						};
					}
					return { success: true, meta: { changes: 1 } };
				},
				async first<T>() {
					return stored as T | null;
				},
			};
			return statement;
		},
	};
}

// Pause and resume run the real owned-participant PATCH so the assertions cover
// the stored document and the scheduling row the route actually writes, not a
// mock's idea of them. Canonical annotations stay mocked because the inference
// graph is unrelated to this behavior.
function ownedParticipantRuntimeService(): { fetch(request: Request): Promise<Response> } {
	return {
		fetch: async (request: Request) => {
			if (new URL(request.url).pathname.endsWith("/inference-consumers/annotations")) {
				return Response.json({ ok: true, data: { annotations: [], graphRevision: 7 } });
			}
			return handleAgentRuntimeRequest(request, testEnv as never, {
				objectId: "mcp-participant-coordinator",
				ownerUserId: "usr_mcp",
			});
		},
	};
}

type RuntimeIndexRow = {
	enabled: number;
	status: string;
	activeRunId: string | null;
	leaseExpiresAt: string | null;
	nextDueAt: string | null;
};

async function seedRuntimeIndexRow(botId: string, input: {
	status: "idle" | "running" | "failed";
	activeRunId?: string | null;
	leaseExpiresAt?: string | null;
	nextDueAt: string | null;
}): Promise<void> {
	const seededAt = "2026-08-11T00:00:00.000Z";
	await testEnv.BICKR_D1.prepare(
		`INSERT INTO bot_runtime_index (
			bot_id, owner_user_id, world_id, enabled, tick_interval_seconds, context_window_tokens,
			compaction_threshold, compaction_summary_percent, compaction_max_characters,
			max_tool_calls_per_tick, max_successful_tool_calls_per_iteration,
			max_generated_tokens_per_tick, max_generated_tokens_per_iteration,
			next_due_at, status, active_run_id, lease_expires_at, last_error, created_at, updated_at
		) VALUES (?, 'usr_mcp', 'w_mcp', 1, 3600, NULL, 0.75, 10, 4000, 10, 8, 15000, 30000, ?, ?, ?, ?, NULL, ?, ?)`,
	)
		.bind(botId, input.nextDueAt, input.status, input.activeRunId ?? null, input.leaseExpiresAt ?? null, seededAt, seededAt)
		.run();
}

async function runtimeIndexRow(botId: string): Promise<RuntimeIndexRow | null> {
	return await testEnv.BICKR_D1.prepare(
		`SELECT enabled, status, active_run_id AS activeRunId,
			lease_expires_at AS leaseExpiresAt, next_due_at AS nextDueAt
		 FROM bot_runtime_index
		 WHERE bot_id = ?`,
	)
		.bind(botId)
		.first<RuntimeIndexRow>();
}

async function requiredRuntimeIndexRow(botId: string): Promise<RuntimeIndexRow> {
	const row = await runtimeIndexRow(botId);
	if (!row) {
		throw new Error(`Missing runtime index row for ${botId}.`);
	}
	return row;
}

async function storedBot(botId: string): Promise<BotDocument> {
	const bot = await testEnv.BICKR_KV.get(kvKeys.bot(botId), { type: "json" }) as BotDocument | null;
	if (!bot) {
		throw new Error(`Missing stored participant ${botId}.`);
	}
	return bot;
}

function testBot(
	overrides: Omit<Partial<BotDocument>, "displayName" | "language" | "prompt" | "shortBio"> &
		Pick<BotDocument, "id" | "handle"> &
		Partial<Record<"displayName" | "prompt" | "shortBio", string | LocalizedText>> & { language?: LanguageTag | null },
): BotDocument {
	return {
		id: overrides.id,
		type: "bot",
		schemaVersion: 1,
		revision: 1,
		homeWorldId: "w_mcp",
		homeWorldHandle: "mcp-world",
		ownerUserId: overrides.ownerUserId ?? "usr_mcp",
		handle: overrides.handle,
		language: overrides.language ?? en,
		includeLanguageInSystemPrompt: overrides.includeLanguageInSystemPrompt ?? false,
		displayName: localized(overrides.displayName, "MCP Bot"),
		shortBio: localized(overrides.shortBio, "MCP bio"),
		prompt: localized(overrides.prompt, "MCP prompt"),
		inferenceSettings: overrides.inferenceSettings ?? {},
		toolSettings: overrides.toolSettings ?? {},
		tickSettings: overrides.tickSettings ?? {
			enabled: false,
			intervalSeconds: 86_400,
			compactionThreshold: 0.75,
		},
		...(overrides.postingSettings ? { postingSettings: overrides.postingSettings } : {}),
		createdAt: overrides.createdAt ?? "2026-05-01T00:00:00.000Z",
		updatedAt: overrides.updatedAt ?? "2026-05-01T00:00:00.000Z",
	};
}

function testUser(overrides: Partial<UserDocument> = {}): UserDocument {
	return {
		id: "usr_mcp",
		type: "user",
		schemaVersion: 1,
		revision: 1,
		handle: "mcp-user",
		language: en,
		displayName: lt("MCP User"),
		profileCompletedAt: "2026-05-01T00:00:00.000Z",
		createdAt: "2026-05-01T00:00:00.000Z",
		updatedAt: "2026-05-01T00:00:00.000Z",
		...overrides,
	};
}

async function pkceS256(codeVerifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
	return base64Url(new Uint8Array(digest));
}

function base64Url(data: Uint8Array): string {
	let binary = "";
	for (const byte of data) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
