import { useEffect, useState } from "react";

/** Latest request wins. Unmount invalidates every pending completion. */
export function useRequestIdentity() {
	const [requests] = useState(() => {
		let generation = 0;
		return {
			invalidate: () => { generation += 1; },
			begin: () => {
				const request = ++generation;
				return () => request === generation;
			},
		};
	});
	useEffect(() => () => requests.invalidate(), [requests]);
	return requests;
}
