import { renderMath } from "./math-engine";
import { isMathRequest, type MathResponse } from "./math-protocol";
self.addEventListener("message", (event: MessageEvent<unknown>) => {
	if (!isMathRequest(event.data)) return;
	const { id, source, display } = event.data;
	const response: MathResponse = { kind: "result", id, result: renderMath(source, display) };
	self.postMessage(response);
});
