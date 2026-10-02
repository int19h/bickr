import { describe, it, expect, vi, afterEach } from "vitest";
import { MathService } from "./math-service";
import type { MathRequest, MathResult } from "./math-protocol";
afterEach(() => vi.useRealTimers());
function setup() {
	const workers: Array<{ postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn>; onmessage: ((event: { data: unknown }) => void) | null; onerror: (() => void) | null }> = [];
	const service = new MathService(() => { const worker = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null, onerror: null }; workers.push(worker); return worker as unknown as Worker; });
	return { service, workers, reply(index = 0, result: MathResult = { kind: "rendered", svg: "<svg/>" }) { const worker = workers[index]!; const request = worker.postMessage.mock.calls.at(-1)![0] as MathRequest; worker.onmessage?.({ data: { kind: "result", id: request.id, result } }); } };
}
describe("math worker lifecycle", () => {
	it("serializes jobs and rejects stale or malformed replies", () => {
		const { service, workers, reply } = setup(); const first = vi.fn(), second = vi.fn();
		service.render('a', false, first); service.render('b', true, second);
		expect(workers[0]!.postMessage).toHaveBeenCalledTimes(1);
		workers[0]!.onmessage?.({ data: { kind: "result", id: 999, result: { kind: "rejected" } } }); expect(first).not.toHaveBeenCalled();
		reply(); expect(first).toHaveBeenCalledOnce(); expect(workers[0]!.postMessage).toHaveBeenCalledTimes(2);
		reply(); expect(second).toHaveBeenCalledOnce(); service.dispose();
	});
	it("terminates timed-out work and advances queued work with a new worker", () => {
		vi.useFakeTimers(); const { service, workers, reply } = setup(); const first = vi.fn(), second = vi.fn();
		service.render('a', false, first); service.render('b', false, second); vi.advanceTimersByTime(5000);
		expect(first).toHaveBeenCalledWith({ kind: "rejected" }); expect(workers[0]!.terminate).toHaveBeenCalledOnce(); expect(workers).toHaveLength(2);
		reply(0); expect(second).not.toHaveBeenCalled(); reply(1); expect(second).toHaveBeenCalledOnce(); service.dispose();
	});
	it("cancels queued and active jobs and survives worker startup errors", () => {
		const { service, workers, reply } = setup(); const first = vi.fn(), second = vi.fn(), third = vi.fn();
		const cancelFirst = service.render('a', false, first); const cancelSecond = service.render('b', false, second); service.render('c', false, third);
		cancelSecond(); cancelFirst(); expect(workers).toHaveLength(2); reply(0); reply(1);
		expect(first).not.toHaveBeenCalled(); expect(second).not.toHaveBeenCalled(); expect(third).toHaveBeenCalledOnce(); service.dispose();
		const failing = new MathService(() => { throw new Error('startup'); }); failing.render('x', false, first); expect(first).toHaveBeenCalledWith({ kind: "rejected" });
	});
	it("bounds queued jobs and oversized input", () => {
		const { service } = setup(); const done = vi.fn(); for (let i = 0; i < 66; i++) service.render('x', false, done);
		expect(done).toHaveBeenCalledOnce(); service.render('x'.repeat(16385), false, done); expect(done).toHaveBeenCalledTimes(2); service.dispose();
	});
});
