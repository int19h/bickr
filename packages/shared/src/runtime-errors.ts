export function ownerRuntimeErrorMessage(message: string | undefined): string | undefined {
	if (!message) {
		return undefined;
	}
	return message
		.replace(/^Inference failed before retrying; error from provider:\n/, "")
		.replace(/^Inference failed after (\d+) provider attempts \([^)]*\); last error from provider:\n/, "Inference failed after $1 provider attempts: ")
		.replace(/^Bickr Terminal request failed with status (\d+) at the configured service\. Response: /, "Inference request failed with status $1: ")
		.replace(/^Inference request failed with status (\d+)\. Response: /, "Inference request failed with status $1: ")
		.replace(/^Bickr Terminal did not respond within /, "Inference request did not respond within ")
		.replace(/^Bickr Terminal stopped responding after /, "Inference stream stopped responding after ")
		.replace(/^Bickr Terminal reported an error during this visit: /, "")
		.replace(/^Bickr website crashed with an error: /, "");
}
