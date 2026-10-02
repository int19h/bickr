import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RedactedInferenceConfigurationDto } from "@bickr/shared/inference-configuration-owner";
import { InferenceConfigurationEditorScreen } from "./editor";
import { inferenceEditorFields } from "./field-model";

let root: Root;
let box: HTMLDivElement;
let pending: Map<string, (data: unknown) => void>;
const changed = vi.fn();
const json = (data: unknown) => new Response(JSON.stringify({ ok: true, data }));
function dto(id: string, revision = 1): RedactedInferenceConfigurationDto {
	return { id, displayName: id, kind: "custom", identity: { kind: "custom", name: id }, revision,
		parentId: null, path: [], effectiveModel: "test", imagePreviews: { participant: { model: "image" } },
		credential: { mode: "inherit", resolution: { kind: "unavailable", reason: "no_credential" } },
		fields: Object.fromEntries(inferenceEditorFields.map((field) => [field, {
			override: { kind: "inherit" }, effective: null, request: { kind: "value", value: null }, provenance: { unset: null }, adjustment: null,
			inherited: { request: { kind: "value", value: null }, effective: null, provenance: { unset: null }, adjustment: null },
		}])),
	} as unknown as RedactedInferenceConfigurationDto;
}
async function render(id: string) { await act(async () => root.render(<InferenceConfigurationEditorScreen configurationId={id} onInferenceChanged={changed} onNavigate={() => {}} />)); }
async function respond(id: string, revision = 1) { await act(async () => pending.get(`/api/me/inference-configurations/${id}`)!({ configuration: dto(id, revision) })); }
function typeName(value: string) {
	const input = box.querySelector<HTMLInputElement>("#inference-name")!;
	Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}
beforeEach(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	pending = new Map(); changed.mockClear();
	vi.stubGlobal("fetch", (url: string) => new Promise<Response>((resolve) => pending.set(url, (data) => resolve(json(data)))));
	box = document.createElement("div"); document.body.append(box); root = createRoot(box);
});
afterEach(async () => { await act(async () => root.unmount()); box.remove(); vi.unstubAllGlobals(); });
it("ignores an old configuration load after navigation", async () => {
	await render("cfg_A"); await render("cfg_B"); await respond("cfg_B"); await respond("cfg_A");
	expect(box.querySelector("h1")?.textContent).toBe("cfg_BCustom");
});
it("keeps edits typed while a focus refresh is pending", async () => {
	await render("cfg_A"); await respond("cfg_A");
	await act(async () => window.dispatchEvent(new Event("focus")));
	await act(async () => typeName("My unsaved name"));
	await respond("cfg_A");
	expect(box.querySelector<HTMLInputElement>("#inference-name")?.value).toBe("My unsaved name");
});
it("presents a conflict if a focus refresh changes revision under new edits", async () => {
	await render("cfg_A"); await respond("cfg_A");
	await act(async () => window.dispatchEvent(new Event("focus")));
	await act(async () => typeName("My unsaved name"));
	await respond("cfg_A", 2);
	expect(box.querySelector<HTMLInputElement>("#inference-name")?.value).toBe("My unsaved name");
	expect(box.textContent).toContain("now at revision 2");
});
it("ignores a mutation completion after navigating to another configuration", async () => {
	await render("cfg_A"); await respond("cfg_A");
	await act(async () => typeName("Renamed A"));
	await act(async () => [...box.querySelectorAll("button")].find((button) => button.textContent === "Rename")!.click());
	await render("cfg_B"); await respond("cfg_B");
	await act(async () => pending.get("/api/me/inference-configurations/cfg_A/rename")!({ configuration: dto("cfg_A", 2) }));
	expect(box.querySelector("h1")?.textContent).toBe("cfg_BCustom");
	expect(changed).not.toHaveBeenCalled();
});
it("keeps a newer name typed while a rename is pending", async () => {
	await render("cfg_A"); await respond("cfg_A");
	await act(async () => typeName("Submitted name"));
	await act(async () => [...box.querySelectorAll("button")].find((button) => button.textContent === "Rename")!.click());
	await act(async () => typeName("Next name"));
	await act(async () => pending.get("/api/me/inference-configurations/cfg_A/rename")!({ configuration: dto("cfg_A", 2) }));
	expect(box.querySelector<HTMLInputElement>("#inference-name")?.value).toBe("Next name");
});
