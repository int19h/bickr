import { describe, expect, it } from "vitest";
import {
	defaultBickrInferenceDefaults,
	inferenceConfigurationOwnerQuota,
	resolveInferenceConfiguration,
	type InferenceConfigurationCredential,
	type InferenceConfigurationNode,
	type InferenceConfigurationOverrides,
	type InferenceConfigurationPath,
} from "./inference-configuration";
import { createInferenceSnapshotResolver } from "./inference-configuration-snapshot";

const defaults = { ...defaultBickrInferenceDefaults, credential: "deployment-secret", credentialVersion: 1 };

function node(
	id: string,
	parentId: string | null,
	overrides: InferenceConfigurationOverrides = {},
	credential: InferenceConfigurationCredential = { mode: "inherit", secretVersion: 0 },
): InferenceConfigurationNode {
	return {
		id,
		ownerUserId: "owner",
		kind: parentId === null ? "account_default" : "custom",
		parentId,
		overrides,
		credential,
		revision: 1,
	} as InferenceConfigurationNode;
}

function pathFor(selected: InferenceConfigurationNode, snapshot: ReadonlyMap<string, InferenceConfigurationNode>): InferenceConfigurationPath {
	const path: InferenceConfigurationNode[] = [selected];
	while (path.at(-1)!.parentId !== null) path.push(snapshot.get(path.at(-1)!.parentId!)!);
	return path as [InferenceConfigurationNode, ...InferenceConfigurationNode[]];
}

describe("inference snapshot resolution", () => {
	it("matches path resolution across raw intent, provenance, and provider policy", () => {
		const nodes = [
			node("account", null, { temperature: { kind: "value", value: 0.7 } }),
			node("provider", "account", {
				baseUrl: { kind: "value", value: "https://provider.example/v1" },
				model: { kind: "value", value: "owner-model" },
				providerRouting: { kind: "value", value: {} },
				imageModel: { kind: "historical_bickr_default", value: "google/gemini-3.1-flash-image-preview" },
			}),
			node("restore", "provider", { baseUrl: { kind: "account_default" }, temperature: { kind: "value", value: 0 } }),
			node("key", "restore", {
				imageAspectRatio: { kind: "target_default" },
				supportsPrefill: { kind: "value", value: false },
			}, { mode: "value", secret: "owner-secret", secretVersion: 3 }),
			node("none", "key", { imageModel: { kind: "explicit_none" } }, { mode: "none", secretVersion: 0 }),
			node("reset", "none", {}, { mode: "account_default", secretVersion: 0 }),
			node("leaf", "reset"),
			node("missing-key", "account", {}, { mode: "value", secretVersion: 0 }),
		];
		const snapshot = new Map(nodes.map((entry) => [entry.id, entry]));
		const resolve = createInferenceSnapshotResolver(snapshot, { defaults });
		for (const selected of [...nodes].reverse()) {
			const expected = resolveInferenceConfiguration(pathFor(selected, snapshot), { defaults });
			expect(resolve(selected.id)).toEqual({
				raw: expected.raw,
				effective: expected.effective,
				providerAuthorizationAdjustment: expected.providerAuthorizationAdjustment,
			});
		}
		expect(resolve("provider").effective.credential).toMatchObject({
			kind: "unavailable", reason: "deployment_credential_suppressed_for_owner_base_url",
		});
		expect(resolve("restore").effective.credential).toMatchObject({ kind: "available", secret: "deployment-secret" });
	});

	it("keeps independent snapshots separate after parent changes", () => {
		const root = node("root", null);
		const a = node("a", root.id, {}, { mode: "value", secretVersion: 1, secret: "first" });
		const b = node("b", root.id, {}, { mode: "none", secretVersion: 0 });
		const selected = node("selected", a.id);
		const before = new Map([root, a, b, selected].map((entry) => [entry.id, entry]));
		const after = new Map(before);
		after.set(selected.id, { ...selected, parentId: b.id } as InferenceConfigurationNode);
		expect(createInferenceSnapshotResolver(before)(selected.id).effective.credential.kind).toBe("available");
		expect(createInferenceSnapshotResolver(after)(selected.id).effective.credential.kind).toBe("explicit_none");
	});

	it("visits each ancestor once for all nodes in a deep graph", () => {
		class CountedMap extends Map<string, InferenceConfigurationNode> {
			reads = 0;
			override get(id: string) { this.reads += 1; return super.get(id); }
		}
		for (const size of [250, 500, 1_000]) {
			const snapshot = new CountedMap();
			for (let index = 0; index < size; index += 1) snapshot.set(String(index), node(String(index), index ? String(index - 1) : null));
			const resolve = createInferenceSnapshotResolver(snapshot);
			for (let index = size - 1; index >= 0; index -= 1) resolve(String(index));
			expect(snapshot.reads).toBeLessThanOrEqual(size * 2);
		}
	});

	it("rejects cycles, missing parents, and cross-account inheritance", () => {
		const root = node("root", null);
		for (const entries of [
			[node("a", "b"), node("b", "a")],
			[node("a", "missing")],
			[root, { ...node("a", root.id), ownerUserId: "other" }],
		]) {
			const resolve = createInferenceSnapshotResolver(new Map(entries.map((entry) => [entry.id, entry])));
			expect(() => resolve("a")).toThrow();
		}
	});

	it("enforces the path limit even when ancestors are already cached", () => {
		const snapshot = new Map<string, InferenceConfigurationNode>();
		for (let index = 0; index <= inferenceConfigurationOwnerQuota; index += 1) {
			snapshot.set(String(index), node(String(index), index ? String(index - 1) : null));
		}
		const resolve = createInferenceSnapshotResolver(snapshot);
		resolve(String(inferenceConfigurationOwnerQuota - 1));
		expect(() => resolve(String(inferenceConfigurationOwnerQuota))).toThrow("exceeds the owner quota");
	});
});
