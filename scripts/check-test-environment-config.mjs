#!/usr/bin/env node

import { unstable_readConfig as readConfig } from "wrangler";

const testResources = Object.freeze({
	d1Id: "626f2b02-f546-46d9-85f9-b784868a5338",
	d1Name: "bickr-test-v2",
	kvId: "a57182d3ecff4f66a8725f6900f60817",
	r2Bucket: "bickr-avatars-test-v2",
	vectorizeIndex: "bickr-bot-search-test-v2",
});

const productionResources = Object.freeze({
	d1Id: "d45193d4-15af-461d-84e7-9f8c276a30f8",
	d1Name: "bickr-test",
	kvId: "f153e4189e40485488cbbe0ca4ba91eb",
	r2Bucket: "bickr-avatars-test",
});

const testWorkers = Object.freeze({
	agentRuntime: "bickr-agent-runtime-test",
	forumCoordinator: "bickr-forum-coordinator-test",
});

const failures = [];

const webProduction = config("apps/web/wrangler.jsonc");
expectBinding(webProduction.kv_namespaces, "BICKR_KV", "id", productionResources.kvId, "web production KV");
expectBinding(webProduction.d1_databases, "BICKR_D1", "database_id", productionResources.d1Id, "web production D1");
expectBinding(webProduction.d1_databases, "BICKR_D1", "database_name", productionResources.d1Name, "web production D1 name");
expectBinding(webProduction.r2_buckets, "BICKR_R2", "bucket_name", productionResources.r2Bucket, "web production R2");
expectValue(webProduction.vars?.TEST_ENTRY_MODE, "disabled", "web production entry mode");

const webTest = config("apps/web/wrangler.jsonc", "preview");
expectTestStorage(webTest, "web test");
expectValue(webTest.vars?.BICKR_R2_PUBLIC_BASE_URL, "https://test-assets.bickr.social", "web test asset origin");
expectValue(webTest.vars?.TEST_ENTRY_MODE, "migration", "web test entry mode");
expectBinding(webTest.services, "AGENT_RUNTIME", "service", testWorkers.agentRuntime, "web test agent runtime service");
expectBinding(
	webTest.services,
	"FORUM_COORDINATOR_SERVICE",
	"service",
	testWorkers.forumCoordinator,
	"web test forum coordinator service",
);
expectDurableObject(webTest, "BOT_RUNTIME", testWorkers.agentRuntime);
expectDurableObject(webTest, "USER_BOTS", testWorkers.agentRuntime);
expectDurableObject(webTest, "WORLD_COORDINATOR", testWorkers.forumCoordinator);
expectDurableObject(webTest, "FORUM_COORDINATOR", testWorkers.forumCoordinator);

const forumTest = config("workers/forum-coordinator/wrangler.jsonc", "test");
expectValue(forumTest.name, testWorkers.forumCoordinator, "forum coordinator test Worker name");
expectTestStorage(forumTest, "forum coordinator test", false);
expectBinding(
	forumTest.vectorize,
	"BICKR_SEARCH_VECTORIZE",
	"index_name",
	testResources.vectorizeIndex,
	"forum coordinator test Vectorize",
);

const agentTest = config("workers/agent-runtime/wrangler.jsonc", "test");
expectValue(agentTest.name, testWorkers.agentRuntime, "agent runtime test Worker name");
expectTestStorage(agentTest, "agent runtime test");
expectBinding(
	agentTest.vectorize,
	"BICKR_SEARCH_VECTORIZE",
	"index_name",
	testResources.vectorizeIndex,
	"agent runtime test Vectorize",
);
expectValue(agentTest.vars?.BICKR_R2_PUBLIC_BASE_URL, "https://test-assets.bickr.social", "agent runtime test asset origin");
expectBinding(
	agentTest.services,
	"FORUM_COORDINATOR_SERVICE",
	"service",
	testWorkers.forumCoordinator,
	"agent runtime test forum coordinator service",
);

if (failures.length > 0) {
	console.error([
		"Test environment configuration is unsafe:",
		...failures.map((failure) => `  - ${failure}`),
		"The normal test deploy must remain isolated from the promoted production stores.",
	].join("\n"));
	process.exit(1);
}

console.log("Test environment configuration is isolated from production.");

function config(path, environment) {
	return readConfig(
		{ config: path, ...(environment ? { env: environment } : {}) },
		{ hideWarnings: true },
	);
}

function expectTestStorage(value, label, expectsR2 = true) {
	expectBinding(value.kv_namespaces, "BICKR_KV", "id", testResources.kvId, `${label} KV`);
	expectBinding(value.d1_databases, "BICKR_D1", "database_id", testResources.d1Id, `${label} D1`);
	expectBinding(value.d1_databases, "BICKR_D1", "database_name", testResources.d1Name, `${label} D1 name`);
	if (expectsR2) {
		expectBinding(value.r2_buckets, "BICKR_R2", "bucket_name", testResources.r2Bucket, `${label} R2`);
	}
}

function expectBinding(bindings, bindingName, property, expected, label) {
	const binding = bindings?.find((candidate) => candidate.binding === bindingName);
	expectValue(binding?.[property], expected, label);
}

function expectDurableObject(value, bindingName, expectedScriptName) {
	const binding = value.durable_objects?.bindings?.find((candidate) => candidate.name === bindingName);
	expectValue(binding?.script_name, expectedScriptName, `web test ${bindingName} Durable Object script`);
}

function expectValue(actual, expected, label) {
	if (actual !== expected) {
		failures.push(`${label} must be ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}.`);
	}
}
