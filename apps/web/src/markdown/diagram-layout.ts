/** Observe actual drawing geometry, rather than the iframe viewport height. */
export function observeDiagramHeight(host: HTMLElement, report: (height: number) => void): () => void {
	let lastHeight: number | undefined;
	let scheduled: number | undefined;
	let stopped = false;
	function measure(): void {
		const height = Math.min(1200, Math.max(80, Math.ceil(host.getBoundingClientRect().height)));
		if (height !== lastHeight) { lastHeight = height; report(height); }
	}
	const observer = new ResizeObserver(() => {
		if (stopped || scheduled !== undefined) return;
		scheduled = requestAnimationFrame(() => { scheduled = undefined; if (!stopped) measure(); });
	});
	observer.observe(host);
	measure();
	return () => {
		stopped = true;
		observer.disconnect();
		if (scheduled !== undefined) cancelAnimationFrame(scheduled);
	};
}
