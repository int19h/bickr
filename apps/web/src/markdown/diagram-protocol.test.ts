import { describe, expect, it } from "vitest";
import { isDiagramRequest, isDiagramResponse, mermaidExportLimit, validDiagramSource } from "./diagram-protocol";
describe("diagram message bounds", () => {
	it("bounds source bytes rather than only UTF-16 units", () => {
		expect(validDiagramSource("x".repeat(16384))).toBe(true);
		expect(validDiagramSource("x".repeat(16385))).toBe(false);
		expect(validDiagramSource("界".repeat(6000))).toBe(false);
	});
	it("rejects configuration, malformed messages and non-finite heights", () => {
		for (const source of ['---\nconfig: {}\n---\ngraph TD; A-->B', '%%{init: {}}%%\ngraph TD; A-->B']) expect(validDiagramSource(source)).toBe(false);
		expect(isDiagramRequest({ kind: "render", token: "x", source: 123 })).toBe(false);
		expect(isDiagramResponse({ kind: "ready", token: "x", height: Infinity })).toBe(false);
		expect(isDiagramResponse({ kind: "error", token: "x" })).toBe(true);
	});
	it("guards the render layout and the export exchange", () => {
		expect(isDiagramRequest({ kind: "render", token: "x", source: "graph TD; A-->B", layout: "viewer" })).toBe(true);
		expect(isDiagramRequest({ kind: "render", token: "x", source: "graph TD; A-->B" })).toBe(false);
		expect(isDiagramRequest({ kind: "export", token: "x" })).toBe(true);
		expect(isDiagramRequest({ kind: "export", token: "x".repeat(101) })).toBe(false);
		expect(isDiagramResponse({ kind: "exported", token: "x", svg: "<svg/>" })).toBe(true);
		expect(isDiagramResponse({ kind: "exported", token: "x", svg: "" })).toBe(false);
		expect(isDiagramResponse({ kind: "exported", token: "x", svg: "x".repeat(mermaidExportLimit + 1) })).toBe(false);
		expect(isDiagramResponse({ kind: "exported", token: "x" })).toBe(false);
	});
});
