export class ExclusiveOperationQueue {
	private pending: Promise<void> = Promise.resolve();

	async run<T>(operation: () => Promise<T>): Promise<T> {
		const ready = this.pending;
		let release: () => void = () => {};
		this.pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		await ready;
		try {
			return await operation();
		} finally {
			release();
		}
	}
}
