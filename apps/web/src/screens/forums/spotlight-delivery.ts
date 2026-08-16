import {
	maxSpotlightSendBots,
	spotlightDeliveryFailureMessage,
	spotlightDeliverySucceeded,
	type SpotlightSendResult,
	type SpotlightTargetType,
} from "@bickr/shared/model";
import { api } from "../../api";

/**
 * A spotlight run, sent as consecutive batches.
 *
 * The server caps how many participants one request may reach, so a large
 * selection is delivered in several requests that share one run id. Splitting
 * it here rather than in the panel keeps the panel about rendering: the panel
 * reacts to each batch's outcome and never has to know the cap.
 */

/**
 * Comfortably above the server's own worst case for a batch (a plan build plus
 * one 30-second service call), so a request that hits this really has stopped
 * making progress.
 */
export const spotlightBatchTimeoutMs = 60_000;

export type SpotlightSendTarget = {
	worldHandle: string;
	forumHandle: string;
	targetType: SpotlightTargetType;
	threadIds: string[];
	threadId?: string;
	commentIds: string[];
	focusText: string;
	autoStartTick: boolean;
};

export type SpotlightDeliveryFailure = {
	botId: string;
	message: string;
};

export type SpotlightBatchUpdate = {
	/** Participants this batch finished with; a retry must exclude them. */
	completedBotIds: string[];
	failures: SpotlightDeliveryFailure[];
};

export type SpotlightRunResult =
	| { kind: "completed" }
	| { kind: "aborted" }
	/**
	 * A batch never produced per-participant results at all. Its own participants
	 * come back as failures — the ones from earlier batches were already reported
	 * through `onBatch` — and the run stops: whatever refused that request, a
	 * rejected continuation or a dead network, will refuse the next one too.
	 */
	| { kind: "request_failed"; message: string; failures: SpotlightDeliveryFailure[] };

export function spotlightBatches(botIds: string[]): string[][] {
	const batches: string[][] = [];
	for (let index = 0; index < botIds.length; index += maxSpotlightSendBots) {
		batches.push(botIds.slice(index, index + maxSpotlightSendBots));
	}
	return batches;
}

export async function sendSpotlightInBatches(input: {
	target: SpotlightSendTarget;
	botIds: string[];
	/**
	 * Names the run, including its very first batch. The id has to exist before
	 * the first request does: if that request's response is lost after the
	 * server injected, only a retry under the same id can be recognised as the
	 * same run, and the server's dedupe has nothing else to key on.
	 */
	spotlightId: string;
	signal: AbortSignal;
	onBatch: (update: SpotlightBatchUpdate) => void;
}): Promise<SpotlightRunResult> {
	const spotlightId = input.spotlightId;
	for (const batch of spotlightBatches(input.botIds)) {
		if (input.signal.aborted) {
			return { kind: "aborted" };
		}
		const result = await api<SpotlightSendResult>(
			`/api/worlds/${encodeURIComponent(input.target.worldHandle)}/forums/${encodeURIComponent(input.target.forumHandle)}/spotlight/send`,
			{
				method: "POST",
				body: spotlightSendBody(input.target, batch, spotlightId),
				signal: input.signal,
				timeoutMs: spotlightBatchTimeoutMs,
			},
		);
		if (!result.ok) {
			if (input.signal.aborted) {
				return { kind: "aborted" };
			}
			return {
				kind: "request_failed",
				message: result.message,
				failures: batch.map((botId) => ({ botId, message: result.message })),
			};
		}
		const batchFailures = result.data.deliveries.flatMap((delivery) => {
			const message = spotlightDeliveryFailureMessage(delivery);
			return message === null ? [] : [{ botId: delivery.botId, message }];
		});
		input.onBatch({
			completedBotIds: result.data.deliveries.filter(spotlightDeliverySucceeded).map((delivery) => delivery.botId),
			failures: batchFailures,
		});
	}
	return { kind: "completed" };
}

function spotlightSendBody(target: SpotlightSendTarget, botIds: string[], spotlightId: string) {
	return {
		targetType: target.targetType,
		botIds,
		...(target.targetType === "threads" ?
			{ threadIds: target.threadIds }
		:	{ threadId: target.threadId, commentIds: target.commentIds }),
		...(target.focusText.trim() ? { focusText: target.focusText.trim() } : {}),
		autoStartTick: target.autoStartTick,
		spotlightId,
	};
}
