#!/usr/bin/env node

const runtimeUrl = process.env.AGENT_RUNTIME_URL;
if (!runtimeUrl) {
	console.error("Set AGENT_RUNTIME_URL to the Agent Runtime Worker origin.");
	process.exit(1);
}

const response = await fetch(new URL("/maintenance/backfill-clone-sources", runtimeUrl), {
	method: "POST",
	headers: {
		"x-bickr-scheduler": "1",
	},
});
const text = await response.text();
if (!response.ok) {
	console.error(text);
	process.exit(1);
}
console.log(text);
