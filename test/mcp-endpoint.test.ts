import { describe, expect, it } from "vitest";
import { localizedText, type BotDocument, type LanguageTag, type LocalizedText, type UserDocument } from "../packages/shared/src/model";
import {
	createMcpAuthorizationCode,
	exchangeMcpAuthorizationCode,
	registerMcpClient,
} from "../packages/shared/src/mcp-auth";
import { kvKeys, type KVNamespaceLike } from "../packages/shared/src/storage";
import { onRequestGet as onAuthorizationServerGet } from "../apps/web/functions/.well-known/oauth-authorization-server";
import { onRequestGet as onProtectedResourceGet } from "../apps/web/functions/.well-known/oauth-protected-resource";
import { onRequestGet as onPathProtectedResourceGet } from "../apps/web/functions/.well-known/oauth-protected-resource/mcp";
import { mcpToolMetadataForTest, onRequestPost } from "../apps/web/functions/mcp";
import { onRequestPost as onRegisterPost } from "../apps/web/functions/oauth/register";

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

function schemaProperties(schema: Record<string, unknown>): Record<string, unknown> {
	const properties = schema.properties;
	if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
		throw new Error("Schema properties are missing.");
	}
	return properties as Record<string, unknown>;
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
			["list_world_bots", "bickr.read", true, false, true],
			["get_bot", "bickr.read", true, false, true],
			["create_bot", "bickr.write", false, false, false],
			["update_bot", "bickr.write", false, false, false],
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
			expect(JSON.stringify(tool.inputSchema).length, `${tool.name} schema bytes`).toBeLessThanOrEqual(5_000);
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
			const operationSchema = toolArgumentSchema(tool.inputSchema);
			expect(operationSchema, tool.name).toMatchObject({
				type: "object",
				additionalProperties: false,
			});
			expect(schemaRequired(new Map([[tool.name, tool]]), tool.name), tool.name).toContain("operationId");
			expect(schemaProperties(operationSchema), tool.name).toHaveProperty("operationId");
		}
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

	it("advertises localized prompt fields in nested settings schemas", () => {
		const byName = new Map(mcpToolMetadataForTest().map((tool) => [tool.name, tool]));
		const createBotInference = schemaProperty(byName, "create_bot", "inferenceSettings");
		const inferenceProperties = schemaProperties(createBotInference);
		const recurringPrompt = inferenceProperties.recurringPrompt as Record<string, unknown>;
		const imageGeneration = inferenceProperties.imageGeneration as Record<string, unknown>;
		const translation = inferenceProperties.translation as Record<string, unknown>;

		expect(Object.keys(schemaProperties(recurringPrompt))).toEqual(["lang", "text"]);
		expect(inferenceProperties).not.toHaveProperty("reasoningPrefill");
		expect(Object.keys(schemaProperties(schemaProperties(imageGeneration).prompt as Record<string, unknown>))).toEqual(["lang", "text"]);
		expect(Object.keys(schemaProperties(schemaProperties(translation).prompt as Record<string, unknown>))).toEqual(["lang", "text"]);
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
		}, { BICKR_D1: emptyD1() });
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
			{ operations: Array.from({ length: 51 }, (_, index) => ({ operationId: `op-${index}`, botId: "bot_a", text: "alpha" })) },
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

	it("includes specified and effective MCP settings with origins for inherited bot values", async () => {
		const kv = new MapKV();
		const source = testBot({
			id: "bot_source",
			handle: "source-bot",
			displayName: "Source Bot",
			shortBio: "Source bio",
			prompt: "Source prompt",
			inferenceSettings: {
				baseUrl: "http://localhost:11434/v1",
				model: "source/model",
				temperature: 0.2,
				imageGeneration: {
					model: "source/image",
				},
			},
		});
		const clone = testBot({
			id: "bot_clone",
			handle: "clone-bot",
			displayName: "",
			shortBio: "",
			prompt: "",
			inferenceSettings: {},
			postingSettings: {
				commentBodyCharacters: 500,
			},
		});
		await kv.put(kvKeys.bot(source.id), JSON.stringify(source));
		await kv.put(kvKeys.bot(clone.id), JSON.stringify(clone));
		const accessToken = await issueAccessToken(kv, ["bickr.read"]);
		const response = await callMcp(kv, accessToken, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "get_bot",
				arguments: { botId: clone.id },
			},
		}, { BICKR_D1: mcpSettingsD1() });
		const body = await jsonResponse(response);
		const toolResult = body.result as Record<string, unknown>;
		const structured = toolResult.structuredContent as { bot: { language: string | null; lang: string | null; mcpResolvedSettings: Record<string, Record<string, unknown>> } };

		expect(response.status).toBe(200);
		expect(structured.bot.language).toBe("en");
		expect(structured.bot.lang).toBe("en");
		expect(structured.bot.mcpResolvedSettings.cloneProfile.displayName).toMatchObject({
			effective: lt("Source Bot"),
			source: "source_bot",
		});
		expect(structured.bot.mcpResolvedSettings.inferenceSettings.model).toMatchObject({
			effective: "source/model",
			source: "source_bot",
		});
		expect(structured.bot.mcpResolvedSettings.inferenceSettings.temperature).toMatchObject({
			effective: 0.2,
			source: "source_bot",
		});
		expect(structured.bot.mcpResolvedSettings.imageGeneration.model).toMatchObject({
			effective: "source/image",
			source: "source_bot",
		});
		expect(structured.bot.mcpResolvedSettings.postingSettings.commentBodyCharacters).toMatchObject({
			specified: 500,
			effective: 500,
			source: "bot",
		});
		expect(structured.bot.mcpResolvedSettings.postingSettings.threadBodyCharacters).toMatchObject({
			effective: 6000,
			source: "world",
		});
	});

	it("uses the shared runtime resolution for profile-inherited MCP settings", async () => {
		const kv = new MapKV();
		const bot = testBot({ id: "bot_source", handle: "profile-default", inferenceSettings: {} });
		const user = testUser({
			inferenceSettings: {
				model: "deepseek/deepseek-v4-flash-0731",
				openRouterApiKey: "profile-secret",
				providerRouting: { only: ["deepseek/fp8"] },
			},
		});
		await kv.put(kvKeys.bot(bot.id), JSON.stringify(bot));
		const accessToken = await issueAccessToken(kv, ["bickr.read"], user);
		const response = await callMcp(kv, accessToken, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "get_bot", arguments: { botId: bot.id } },
		}, { BICKR_D1: mcpSettingsD1() });
		const body = await jsonResponse(response);
		const toolResult = body.result as { structuredContent: unknown };
		const structured = toolResult.structuredContent as {
			bot: { inferenceSettings: Record<string, unknown>; mcpResolvedSettings: Record<string, Record<string, unknown>> };
		};

		expect(structured.bot.inferenceSettings).not.toHaveProperty("openRouterApiKey");
		expect(JSON.stringify(structured)).not.toContain("profile-secret");
		expect(structured.bot.mcpResolvedSettings.inferenceSettings.model).toMatchObject({
			effective: "deepseek/deepseek-v4-flash-0731",
			source: "profile",
		});
		expect(structured.bot.mcpResolvedSettings.inferenceSettings.openRouterApiKeySet).toMatchObject({
			effective: true,
			source: "profile",
		});
		expect(structured.bot.mcpResolvedSettings.inferenceSettings.providerRouting).toMatchObject({
			effective: { only: ["deepseek/fp8"] },
			source: "profile",
		});
	});

	it("annotates update_bot receipts with profile-inherited effective settings", async () => {
		const kv = new MapKV();
		const bot = testBot({ id: "bot_updated_default", handle: "updated-default", inferenceSettings: {} });
		const user = testUser({
			inferenceSettings: {
				model: "deepseek/deepseek-v4-flash-0731",
				openRouterApiKey: "profile-secret",
			},
		});
		const accessToken = await issueAccessToken(kv, ["bickr.write"], user);
		const response = await callMcp(kv, accessToken, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "update_bot",
				arguments: {
					operations: [{ operationId: "clear-model", botId: bot.id, inferenceSettings: { model: null } }],
				},
			},
		}, {
			AGENT_RUNTIME: { fetch: async () => Response.json({ ok: true, data: { bot } }) },
			INTERNAL_SERVICE_SECRET: "test-internal-service-secret",
		});
		const body = await jsonResponse(response);
		const toolResult = body.result as { structuredContent: { results: Array<{ result: unknown }> } };
		const result = toolResult.structuredContent.results[0]?.result as {
			data: { bot: { mcpResolvedSettings: Record<string, Record<string, unknown>> } };
		};

		expect(result.data.bot.mcpResolvedSettings.inferenceSettings.model).toMatchObject({
			effective: "deepseek/deepseek-v4-flash-0731",
			source: "profile",
		});
		expect(JSON.stringify(result)).not.toContain("profile-secret");
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
	return onRequestPost(pagesContext(new Request("https://bickr.social/mcp", {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	}), { BICKR_KV: kv, ...env }));
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
		ownerUserId: "usr_mcp",
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
		createdAt: "2026-05-01T00:00:00.000Z",
		updatedAt: "2026-05-01T00:00:00.000Z",
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
