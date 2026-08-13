import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publicBotEffectiveModelLabel, usePublicBotEffectiveModel } from "./public-bot-model";

/**
 * The model row across a profile navigation.
 *
 * A profile screen is reused rather than remounted when a reader moves from one
 * participant to another in the same world, so the row's correctness is a
 * property of a sequence of renders, not of any single one. These tests drive a
 * real render loop and record what every render actually painted, because the
 * failure this guards against — the previous participant's model appearing
 * under the new participant's name — lasts exactly one render and would be gone
 * again by the time the effects settle.
 */

const scout = { worldHandle: "patch-notes", botHandle: "scout", botId: "bot_scout" };
const quill = { worldHandle: "patch-notes", botHandle: "quill", botId: "bot_quill" };

let painted: string[] = [];
let pending: Map<string, (body: unknown) => void>;
let container: HTMLDivElement;
let root: Root;

function ModelRow(props: { worldHandle: string; botHandle: string; botId: string }) {
	const label = publicBotEffectiveModelLabel(
		usePublicBotEffectiveModel(props.worldHandle, props.botHandle, props.botId),
	);
	painted.push(`${props.botHandle}:${label}`);
	return <span>{label}</span>;
}

beforeEach(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	painted = [];
	pending = new Map();
	// Every request stays open until the test answers it by path, so a test can
	// hold one participant's answer while another participant's render happens.
	vi.stubGlobal("fetch", (input: RequestInfo | URL) => new Promise<Response>((resolve) => {
		const path = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		pending.set(path, (body) => {
			resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
		});
	}));
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => {
		root.unmount();
	});
	container.remove();
	vi.unstubAllGlobals();
});

describe("public participant model row across navigation", () => {
	it("never paints one participant's model under another participant", async () => {
		await render(scout);
		await answer(scout, "vendor/scout-model");
		expect(container.textContent).toBe("vendor/scout-model");

		// The reader opens a different participant while its answer is still in
		// flight. The row must be loading from the first render under the new
		// props, not still reporting the participant that has left the screen.
		await render(quill);

		expect(paintedFor(quill)).toEqual(["..."]);
		expect(container.textContent).toBe("...");

		await answer(quill, "vendor/quill-model");

		expect(paintedFor(quill)).toEqual(["...", "vendor/quill-model"]);
		expect(container.textContent).toBe("vendor/quill-model");
		expect(painted).not.toContain("quill:vendor/scout-model");
	});

	it("asks the public boundary again for the participant now on screen", async () => {
		await render(scout);
		await answer(scout, "vendor/scout-model");
		await render(quill);

		expect([...pending.keys()]).toEqual([
			"/api/worlds/patch-notes/bots/scout/effective-model",
			"/api/worlds/patch-notes/bots/quill/effective-model",
		]);
	});

	// A late answer for the participant the reader has already left must not
	// overwrite the current one, and must not be adopted just because it is the
	// most recent thing to arrive.
	it("discards an answer that arrives after the reader has moved on", async () => {
		await render(scout);
		await render(quill);
		await answer(quill, "vendor/quill-model");
		await answer(scout, "vendor/scout-model");

		expect(container.textContent).toBe("vendor/quill-model");
		expect(painted).not.toContain("quill:vendor/scout-model");
	});
});

async function render(props: typeof scout): Promise<void> {
	await act(async () => {
		root.render(<ModelRow {...props} />);
	});
}

async function answer(props: typeof scout, effectiveModel: string): Promise<void> {
	const path = `/api/worlds/${props.worldHandle}/bots/${props.botHandle}/effective-model`;
	const respond = pending.get(path);
	expect(respond, `no request pending for ${path}`).toBeDefined();
	await act(async () => {
		respond?.({ ok: true, data: { model: { botId: props.botId, effectiveModel } } });
	});
}

function paintedFor(props: typeof scout): string[] {
	return painted
		.filter((entry) => entry.startsWith(`${props.botHandle}:`))
		.map((entry) => entry.slice(props.botHandle.length + 1));
}
