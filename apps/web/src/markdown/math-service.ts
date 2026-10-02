import { isMathResponse, validMathSource, type MathRequest, type MathResult } from "./math-protocol";
type Job = { request: MathRequest; complete: (result: MathResult) => void };
export class MathService {
	private queue: Job[] = [];
	private active: Job | undefined;
	private worker: Worker | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private nextId = 0;
	private readonly factory: () => Worker;
	constructor(factory: () => Worker) { this.factory = factory; }
	render(source: string, display: boolean, complete: Job["complete"]): () => void {
		if (!validMathSource(source) || this.queue.length >= 64) { complete({ kind: "rejected" }); return () => {}; }
		const job: Job = { request: { kind: "render", id: ++this.nextId, source, display }, complete };
		this.queue.push(job); this.advance();
		return () => {
			this.queue = this.queue.filter((entry) => entry !== job);
			if (this.active === job) { this.stopWorker(); this.active = undefined; this.advance(); }
		};
	}
	dispose(): void { this.stopWorker(); this.active = undefined; this.queue = []; }
	private stopWorker(): void { clearTimeout(this.timer); this.worker?.terminate(); this.worker = undefined; }
	private finish(result: MathResult): void {
		const job = this.active; this.active = undefined; clearTimeout(this.timer);
		job?.complete(result); this.advance();
	}
	private advance(): void {
		if (this.active || !this.queue.length) return;
		this.active = this.queue.shift()!;
		try {
			if (!this.worker) {
				const worker = this.factory(); this.worker = worker;
				worker.onmessage = (event: MessageEvent<unknown>) => {
					if (worker !== this.worker || !isMathResponse(event.data) || event.data.id !== this.active?.request.id) return;
					this.finish(event.data.result);
				};
				worker.onerror = () => { if (worker === this.worker) { this.stopWorker(); this.finish({ kind: "rejected" }); } };
			}
			// Termination bounds parsing, layout, and worker startup on slow or
			// adversarial input, while the app and later jobs remain responsive.
			this.timer = setTimeout(() => { this.stopWorker(); this.finish({ kind: "rejected" }); }, 5000);
			this.worker.postMessage(this.active.request);
		} catch { this.stopWorker(); this.finish({ kind: "rejected" }); }
	}
}
export const mathService = new MathService(() => new Worker(new URL("./math-worker.ts", import.meta.url), { type: "module" }));
if (typeof window !== "undefined") window.addEventListener("pagehide", (event) => { if (!event.persisted) mathService.dispose(); });
